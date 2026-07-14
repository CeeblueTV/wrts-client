/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Loggable, ILog } from '@ceeblue/web-utils';
import { BufferState } from './sources/IPlaying';
import type { Player } from './Player';
import { AdaptiveRetry } from './media/AdaptiveRetry';
import * as Media from './media/Media';

const TICK_MS = 1000; // outer loop period, slow relative to the per-timeupdate inner loops
const STEP_MS = 100; // minimum shrink decrement applied to bufferLimitHigh
const SHRINK_RATIO = 0.1; // shrink by 10% of the current value per step (min STEP_MS) — fast when far, fine when near
const KEEP_UP = 0.9; // playbackSpeed must reach 90% of playbackRate to count as "keeping up" (shrink gate)
const WALL_MARGIN = 1.3; // bump the target up by this factor when a probe-down over-shoots (AIMD increase)
const GROW_STEP = 1.15; // gentler grow when the band is too tight to run smoothly (playback not keeping up)
const STRUGGLE_TICKS = 3; // "not keeping up" ticks (decoder slowing on rate toggles) before a grow
const COMFORT_AFTER = 8; // consecutive ticks of all-clear before a shrink is considered (relax slow)
const MAX_HIGH_MS = 5000; // hard ceiling for bufferLimitHigh

/**
 * Optional, opt-in controller that tunes {@link Player.bufferLimitHigh} at runtime (which slides
 * {@link Player.bufferLimitMiddle}, the real playback target) to converge on the lowest stable latency
 * a given device/network allows.
 *
 * AIMD: it shrinks the target while everything is calm (probing for lower latency), and grows it back up on a
 * failure, remembering that level as a floor it won't shrink below again. It grows on three signals:
 * a decoder freeze ({@link Player.onFreeze}) or a LOW/stall/MBR-down right after a shrink (both ×{@link
 * WALL_MARGIN}); and — the subtle one — when playback stops *keeping up* with the acceleration (the decoder
 * slows on each rate toggle, so a too-tight band sawtooths with a poor experience even though nothing counts
 * as a stall), grown more gently (×{@link GROW_STEP}) until the oscillation is slow enough to run smooth.
 * Decoders that keep up (e.g. Chrome) never hit that path and just shrink to low latency. Turned on by
 * setting {@link Player.bufferLimitHigh} to `undefined` (which also enables {@link Player.stallRecovery});
 * {@link Player.bufferLimitLow} is left untouched — it is the MBR down-trigger.
 *
 * Disabled until {@link enable} is called; every change is logged.
 */
export class DynamicBuffer extends Loggable {
    private _enabled = false;
    private _timer?: ReturnType<typeof setInterval>;
    private _controller?: AbortController; // owns the event subscriptions for the enabled lifetime
    private _baseHigh: number; // rollback target, captured at enable() from the current config
    private _comfort = 0;
    private _struggle = 0; // count of "not keeping up" ticks (band too tight to run smoothly); grows the target
    private _prevBandwidth = 0;
    private _floorHigh = 0; // learned minimum bufferLimitHigh from an over-shoot; SHRINK never goes below it
    private _shrunk = false; // did we shrink since the last failure? gates whether a failure means "too low"
    private readonly _shrinkRetry = new AdaptiveRetry({ learningTryStep: 10000, maximumTryDelay: 60000 });

    constructor(
        private _player: Player,
        // Writes the tuned high threshold and slides low/middle, without toggling auto-mode.
        private _writeHigh: (highMs: number) => void
    ) {
        super();
        // Common "DynamicBuffer:" prefix on every log (including the shrink retry) so they are easy to filter.
        this.log = this.log.bind(this, 'DynamicBuffer:') as ILog;
        this._shrinkRetry.log = this.log.bind(this, 'shrink retry,') as ILog;
        this._baseHigh = _player.bufferLimitHigh;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    enable() {
        if (this._enabled) {
            return;
        }
        this._enabled = true;
        this._baseHigh = this._player.bufferLimitHigh;
        this._prevBandwidth = this._videoBandwidth();
        this._comfort = 0;
        this._struggle = 0;
        this._floorHigh = 0; // forget the learned floor on a fresh session
        this._shrunk = false;
        this._shrinkRetry.reset();
        this._player.stallRecovery = true; // let the Player detect silent freezes and cap the playback rate
        this._controller = new AbortController();
        const signal = this._controller.signal;
        // A freeze reported by the Player → grow the target above it.
        this._player.on('Freeze', () => this._onFreeze(), { signal });
        // Failures that mean "we shrank too low": an MBR down-switch, an outright stall, or a LOW dip.
        this._player.on('TrackChange', () => this._onTrackChange(), { signal });
        this._player.on('Stall', () => this._onFailure('stall'), { signal });
        this._player.on('BufferState', () => this._onBufferState(), { signal });
        this._timer = setInterval(() => this._tick(), TICK_MS);
        this.log(`enabled (baseline bufferLimitHigh=${this._baseHigh}ms)`).info();
    }

    disable() {
        if (!this._enabled) {
            return;
        }
        this._enabled = false;
        clearInterval(this._timer);
        this._timer = undefined;
        this._controller?.abort();
        this._controller = undefined;
        this._player.stallRecovery = false;
        // Leave bufferLimitHigh where it is: disabling always follows a concrete value the caller is applying.
        this.log('disabled').info();
    }

    /**
     * Re-baseline to the current bufferLimitHigh and clear state. Call when the configured limits change
     * under it (e.g. the user edits them or picks a network profile) so it doesn't fight or undo that.
     */
    reset() {
        if (!this._enabled) {
            return;
        }
        this._baseHigh = this._player.bufferLimitHigh;
        this._prevBandwidth = this._videoBandwidth();
        this._comfort = 0;
        this._struggle = 0;
        this._floorHigh = 0; // the learned floor is relative to the old config; forget it
        this._shrunk = false;
        this._shrinkRetry.reset();
        this.log(`reset (baseline bufferLimitHigh=${this._baseHigh}ms)`).info();
    }

    private _tick() {
        const p = this._player;
        if (!p.running) {
            return;
        }
        const accelerating = p.playbackRate > 1.001;
        const keepingUp = !accelerating || p.playbackSpeed >= p.playbackRate * KEEP_UP;
        if (!keepingUp) {
            // Playback isn't sustaining the acceleration: the decoder slows on each rate toggle, so the band is
            // too tight and sawtooths (bad UX even with no counted stall). Grow the target a little — this
            // converges to a width where the oscillation is slow enough to stay smooth. No-op on decoders that
            // keep up (e.g. Chrome), which instead shrink for lower latency.
            this._comfort = 0;
            if (++this._struggle >= STRUGGLE_TICKS) {
                this._struggle = 0;
                this._growHigh(GROW_STEP, 'acceleration not keeping up');
            }
        } else if (this._atTopRendition() && p.bufferState !== BufferState.LOW) {
            // SHRINK (slow): at the top rendition, buffer healthy, playhead keeping up => reclaim latency.
            if (++this._comfort >= COMFORT_AFTER) {
                this._struggle = 0; // sustained calm clears the struggle count
                if (this._shrinkRetry.try()) {
                    this._shrink();
                }
            }
        } else {
            this._comfort = 0;
        }
    }

    private _onFreeze() {
        this._growHigh(WALL_MARGIN, 'freeze');
    }

    // Grow bufferLimitHigh by `factor` (capped at MAX_HIGH_MS) and lock that as a floor SHRINK won't drop below.
    private _growHigh(factor: number, reason: string) {
        const p = this._player;
        this._shrunk = false; // a grow raises the target; there is no shrink to undo
        this._struggle = 0;
        const targetHigh = Math.min(Math.round(p.bufferLimitHigh * factor), MAX_HIGH_MS);
        if (targetHigh <= p.bufferLimitHigh) {
            return; // already at the ceiling
        }
        this._writeHigh(targetHigh);
        this._floorHigh = Math.max(this._floorHigh, p.bufferLimitHigh);
        this.log(`${reason} → GROW bufferLimitHigh=${p.bufferLimitHigh}ms (middle=${p.bufferLimitMiddle}ms)`).warn();
    }

    private _shrink() {
        const p = this._player;
        // Never shrink below the learned instability floor, nor collapse the [low,high] band.
        const floor = Math.min(Math.max(Math.round(p.bufferLimitLow * 1.5), this._floorHigh), MAX_HIGH_MS);
        // Proportional step: fast descent when the target is far too high, fine steps near the wall.
        const step = Math.max(STEP_MS, Math.round(p.bufferLimitHigh * SHRINK_RATIO));
        const next = Math.max(p.bufferLimitHigh - step, floor);
        if (next === p.bufferLimitHigh) {
            return; // already at the floor
        }
        this._shrunk = true; // a later failure now means "we probed too low"
        this._writeHigh(next);
        this.log(
            `SHRINK bufferLimitHigh=${next}ms (middle=${p.bufferLimitMiddle}ms, floor=${floor}ms), sustained all-clear`
        ).info();
    }

    private _onBufferState() {
        if (this._player.bufferState !== BufferState.LOW) {
            return;
        }
        // A dip to LOW cancels the comfort window (the 1s tick can sample right through sub-second dips).
        this._comfort = 0;
        // If it dips LOW right after we shrank, we probed too low: learn the wall here and bump back up.
        if (this._shrunk) {
            this._onFailure('LOW');
        }
    }

    private _onTrackChange() {
        const bandwidth = this._videoBandwidth();
        const down = bandwidth > 0 && this._prevBandwidth > 0 && bandwidth < this._prevBandwidth;
        this._prevBandwidth = bandwidth;
        if (down) {
            this._onFailure('MBR down');
        }
    }

    private _onFailure(reason: string) {
        this._shrinkRetry.raise(); // back off before trying to shrink again
        this._comfort = 0;
        if (!this._shrunk) {
            // Not caused by our probing (jitter/congestion at a level we didn't shrink into) — don't inflate.
            return;
        }
        // AIMD: the current level was too low, so bump the target up by WALL_MARGIN (and lock it as a floor) —
        // converging on the lowest stable level instead of reverting to the (far higher) pre-shrink baseline.
        this._growHigh(WALL_MARGIN, `${reason} after a shrink`);
    }

    private _videoTrack() {
        const id = this._player.videoTrack;
        return id == null ? undefined : this._player.metadata.tracks.get(id);
    }

    private _videoBandwidth(): number {
        return this._videoTrack()?.bandwidth ?? 0;
    }

    private _atTopRendition(): boolean {
        const track = this._videoTrack();
        if (!track) {
            return false;
        }
        // Top = no higher rendition, or the higher one is bigger than the screen (MBR won't pick it).
        return !track.up || !!Media.overScreenSize(track.up.resolution, this._player.maximumResolution);
    }
}
