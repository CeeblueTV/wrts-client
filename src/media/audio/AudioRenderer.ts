/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Loggable, log } from '@ceeblue/web-utils';
import { AUDIO_WORKLET_NAME, AudioWorkletCommand, AudioWorkletReport, audioWorkletSource } from './AudioWorklet';
import { PCM } from './PCMDecoder';

const CONTINUITY = 0.015; // seconds, timestamp deviation tolerated between two consecutive PCM before to see a discontinuity
const TIMESTAMP_SLEW = 0.05; // part of the timestamp deviation corrected on every PCM, to follow timestamps without jitter
const TICK = 50; // ms, period of the clock checks
const MAX_AHEAD = 30; // seconds of PCM ahead before to signal an overflow
const MAX_PAST = 60; // seconds of PCM played kept at most
const OVERFLOW_PERIOD = 1000; // ms, minimum delay between two overflow signals
const START_TIMEOUT = 400; // ms, time given to the AudioContext to start before to consider it blocked
const SUSPEND_DELAY = 5000; // ms, delay before to suspend the AudioContext when nothing is rendered anymore
const IDLE_DELAY = 20000; // ms, delay before to suspend an AudioContext started for nothing (stream without audio)
const EXTRAPOLATION = 0.2; // seconds, maximum extrapolation of the clock after the last report
const MAX_CHANNELS = 8;

type Range = { start: number; end: number };
type PCMCommand = Extract<AudioWorkletCommand, { type: 'pcm' }>;

let _context: AudioContext | undefined;
let _module: Promise<boolean> | undefined;
let _ready = false; // worklet module loaded in _context
let _unlocking = false; // unlock listeners installed
let _suspending: ReturnType<typeof setTimeout> | undefined;
const _renderers = new Set<AudioRenderer>();

/**
 * Try to start the AudioContext, what is allowed by the browser only after a user gesture on the page
 */
function resume() {
    if (_context && _context.state !== 'running' && _context.state !== 'closed') {
        _context.resume().catch(() => {});
    }
}

/**
 * Suspend the AudioContext after this delay if no renderer uses it, to release the audio output.
 * A delay of 0 cancels a suspension planned.
 */
function suspendLater(delay: number) {
    clearTimeout(_suspending);
    if (!delay) {
        return;
    }
    _suspending = setTimeout(() => {
        if (!_renderers.size && _context?.state === 'running') {
            _context.suspend().catch(() => {});
        }
    }, delay);
}

/**
 * Renders PCM with the Web Audio API and gives the media time heard, which is the reference clock of the playback.
 *
 * The PCM appended is rendered in an audio worklet (see AudioWorklet.ts) where it is time-stretched to follow
 * the {@link playbackRate}, with or without pitch correction, and resampled to the rate of the audio output.
 *
 * {@link currentTime} is the media time currently heard: the position rendered by the audio worklet, compensated by the
 * latency of the audio output. When the browser doesn't let the AudioContext start, typically because the autoplay
 * policy requires a user gesture, the media time continues to progress on the system clock without sound, and the
 * rendering takes over as soon as the AudioContext starts.
 */
export class AudioRenderer extends Loggable {
    /**
     * Event fired when PCM is appended
     * @event
     */
    onUpdate() {}

    /**
     * Event fired periodically while the renderer is opened, around 20 times per second
     * @event
     */
    onTick() {}

    /**
     * Event fired when the playback is waiting PCM
     * @event
     */
    onWaiting() {}

    /**
     * Event fired when the playback can continue after a wait of PCM
     * @event
     */
    onCanPlay() {}

    /**
     * Event fired when a {@link seek} is done
     * @event
     */
    onSeeked() {}

    /**
     * Event fired when too much PCM is waiting to be played
     * @event
     */
    onOverflow() {
        this.log('PCM overflow').warn();
    }

    /**
     * Event fired when the renderer fails
     * @event
     */
    onError(detail: string) {
        this.log(detail).error();
    }

    /**
     * True if the browser is able to render audio with an audio worklet,
     * what requires a secure context: a page served in HTTPS, or from localhost
     */
    static get supported(): boolean {
        return (
            typeof AudioContext !== 'undefined' &&
            typeof AudioWorkletNode !== 'undefined' &&
            // Out of a secure context browsers expose AudioWorkletNode, but not the audio worklet to run it
            typeof AudioWorklet !== 'undefined' &&
            'audioWorklet' in AudioContext.prototype &&
            typeof Blob !== 'undefined' &&
            typeof URL !== 'undefined' &&
            typeof URL.createObjectURL === 'function'
        );
    }

    /**
     * Create and try to start the AudioContext shared by the renderers.
     *
     * Browsers allow to start an AudioContext only after a user gesture, call it in the handler of the user gesture
     * which starts the playback. Otherwise the AudioContext starts on the next user gesture on the page.
     * @returns the AudioContext, undefined if not {@link supported}
     */
    static unlock(): AudioContext | undefined {
        if (!AudioRenderer.supported) {
            return;
        }
        if (!_context || _context.state === 'closed') {
            try {
                _context = new AudioContext({ latencyHint: 'interactive' });
            } catch (e) {
                log('AudioContext creation failed', e).warn();
                return;
            }
            _module = undefined;
            _ready = false;
            _context.addEventListener('statechange', () => {
                for (const renderer of _renderers) {
                    renderer._onContextState();
                }
            });
        }
        try {
            // On iOS, Web Audio is muted by the ring/silent switch unless the audio session is a playback session,
            // like the one of a media element
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const session = (navigator as any).audioSession;
            if (session && session.type !== 'playback') {
                session.type = 'playback';
            }
        } catch (_) {}
        if (!_unlocking && typeof document !== 'undefined') {
            _unlocking = true;
            // Start the AudioContext on the first user gesture if it was not allowed before
            const unlock = () => {
                if (_renderers.size) {
                    resume();
                }
            };
            for (const type of ['pointerup', 'mousedown', 'touchend', 'keydown', 'click']) {
                document.addEventListener(type, unlock, { capture: true, passive: true });
            }
            // An AudioContext interrupted in background (phone call, tab discarded) has to be restarted
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    unlock();
                }
            });
        }
        resume();
        suspendLater(_renderers.size ? 0 : IDLE_DELAY);
        return _context;
    }

    /**
     * Load the audio worklet in the AudioContext
     * @returns true if the rendering is ready, false if it is impossible
     */
    static prepare(): Promise<boolean> {
        const context = AudioRenderer.unlock();
        if (!context) {
            return Promise.resolve(false);
        }
        if (!_module) {
            let url = '';
            let loading: Promise<void>;
            try {
                url = URL.createObjectURL(new Blob([audioWorkletSource()], { type: 'application/javascript' }));
                loading = context.audioWorklet.addModule(url);
            } catch (e) {
                loading = Promise.reject(e);
            }
            const module = (_module = loading.then(
                () => true,
                e => {
                    log('Audio worklet loading failed', e).warn();
                    return false;
                }
            ));
            module.then(ready => {
                URL.revokeObjectURL(url);
                if (module !== _module) {
                    return; // AudioContext replaced
                }
                _ready = ready;
                for (const renderer of _renderers) {
                    renderer._onContextState();
                }
            });
        }
        return _module;
    }

    /**
     * Start time of the PCM available, in seconds
     */
    get startTime(): number {
        return this._ranges.length ? this._ranges[0].start : 0;
    }

    /**
     * Release the PCM before this time
     */
    set startTime(value: number) {
        this._trim(value);
    }

    /**
     * End time of the PCM available, in seconds
     */
    get endTime(): number {
        return this._ranges.length ? this._ranges[this._ranges.length - 1].end : 0;
    }

    /**
     * Media time currently heard, in seconds
     */
    get currentTime(): number {
        const time = this._rendering ? this._renderedTime() : this._virtualTime();
        // The time never goes back between two discontinuities, whatever the precision of the clocks
        return (this._time = Math.max(time, this._time));
    }

    /**
     * True during a {@link seek}
     */
    get seeking(): boolean {
        return this._seeking;
    }

    /**
     * True when the playback is paused
     */
    get paused(): boolean {
        return this._paused;
    }

    /**
     * True when the playback is waiting PCM
     */
    get starved(): boolean {
        return this._starved;
    }

    /**
     * True when the media time is progressing
     */
    get running(): boolean {
        return !this._paused && !this._starved && !this._closed;
    }

    /**
     * True when audio is rendered by the audio output,
     * otherwise the playback is silent: the browser has not allowed the AudioContext to start yet
     */
    get rendering(): boolean {
        return this._rendering;
    }

    /**
     * Playback rate
     */
    get playbackRate(): number {
        return this._rate;
    }

    set playbackRate(value: number) {
        value = Math.min(Math.max(Number(value) || 1, 0.1), 8);
        if (value === this._rate) {
            return;
        }
        if (!this._rendering) {
            this._virtualTime(); // progress until now with the previous rate
        }
        this._rate = value;
        this._post({ type: 'tempo', value, pitch: this._preservesPitch });
    }

    /**
     * True if the pitch is preserved when {@link playbackRate} is different of 1, the default.
     * Otherwise the pitch follows the playback rate like on a tape.
     */
    get preservesPitch(): boolean {
        return this._preservesPitch;
    }

    set preservesPitch(value: boolean) {
        if (value === this._preservesPitch) {
            return;
        }
        this._preservesPitch = value;
        this._post({ type: 'tempo', value: this._rate, pitch: value });
    }

    /**
     * Volume in the range [0, 1]
     */
    get volume(): number {
        return this._volume;
    }

    set volume(value: number) {
        this._volume = Math.min(Math.max(Number(value) || 0, 0), 1);
        this._updateGain();
    }

    /**
     * True if the sound is muted
     */
    get muted(): boolean {
        return this._muted;
    }

    set muted(value: boolean) {
        this._muted = value;
        this._updateGain();
    }

    private _closed: boolean = false;
    private _paused: boolean = true;
    private _starved: boolean = true;
    private _seeking: boolean = false;
    private _rate: number = 1;
    private _preservesPitch: boolean = true;
    private _volume: number = 1;
    private _muted: boolean = false;
    private _ranges: Range[] = []; // timeline of the PCM, a new range starts on every discontinuity
    private _nextTime?: number; // time expected for the next PCM
    private _time: number = 0; // last current time given
    private _overflowed: number = 0;
    private _timer: ReturnType<typeof setInterval>;
    // Rendering by the audio worklet
    private _node?: AudioWorkletNode;
    private _gain?: GainNode;
    private _rendering: boolean = false;
    private _clock: { context: number; media: number }[] = []; // last reports of the audio worklet
    private _jump: number = 0;
    private _seek: number = 0;
    private _position: number = 0; // media time when the clock has no report
    // Virtual playback while the AudioContext is not running
    private _pending: PCMCommand[] = []; // PCM to play, given to the audio worklet when it takes over
    private _anchor = { media: 0, at: 0 }; // media time at a time of the system clock

    constructor() {
        super();
        _renderers.add(this);
        suspendLater(0);
        this._timer = setInterval(() => this._tick(), TICK);
        AudioRenderer.prepare().then(ready => {
            if (!ready && !this._closed) {
                this.onError('Audio worklet unavailable');
            }
        });
    }

    /**
     * Append PCM to play in the continuity of the PCM already appended.
     * A time which is not in the continuity creates a discontinuity in the media time.
     */
    append(pcm: PCM) {
        const frames = pcm.channels.length ? pcm.channels[0].length : 0;
        if (this._closed || !frames || !(pcm.sampleRate > 0)) {
            return;
        }
        // Stamp it in the continuity of the previous PCM: timestamps are rounded, when samples are contiguous
        let time = pcm.time;
        let disc = true;
        if (this._nextTime != null) {
            const deviation = time - this._nextTime;
            if (Math.abs(deviation) <= CONTINUITY) {
                disc = false;
                time = this._nextTime + deviation * TIMESTAMP_SLEW;
            }
        }
        const end = (this._nextTime = time + frames / pcm.sampleRate);
        const last = this._ranges[this._ranges.length - 1];
        if (last && !disc) {
            last.end = end;
        } else {
            this._ranges.push({ start: time, end });
        }

        const command: PCMCommand = {
            type: 'pcm',
            time,
            rate: pcm.sampleRate,
            disc,
            channels: pcm.channels.slice(0, MAX_CHANNELS)
        };
        if (this._rendering) {
            this._send(command);
        } else {
            this._pending.push(command);
            this._attach();
            this._updateVirtual();
        }

        // Bound the PCM stored
        const currentTime = this.currentTime;
        if (currentTime - this.startTime > MAX_PAST) {
            this._trim(currentTime - MAX_PAST);
        }
        if (end - currentTime > MAX_AHEAD) {
            const now = performance.now();
            if (now - this._overflowed >= OVERFLOW_PERIOD) {
                this._overflowed = now;
                this.onOverflow();
                if (this._closed) {
                    return;
                }
            }
        }
        this.onUpdate();
    }

    /**
     * Start or resume the playback.
     *
     * The promise returned is rejected with a NotAllowedError when audio is audible but the browser refuses to start
     * the AudioContext, typically because the autoplay policy requires a user gesture first. In this case the
     * playback has started without sound.
     */
    async play(): Promise<void> {
        if (this._closed) {
            return;
        }
        if (this._paused) {
            this._paused = false;
            this._anchor.at = performance.now();
            this._post({ type: 'play' });
            this._updateVirtual();
        }
        const context = AudioRenderer.unlock();
        if (!context) {
            throw new DOMException('Web Audio unavailable', 'NotSupportedError');
        }
        const started = () => context.state === 'running';
        if (started() || !this._audible()) {
            return; // audio is rendered, or silent until the AudioContext is allowed to start
        }
        // Give some time to the AudioContext to start
        await new Promise<void>(resolve => {
            const done = () => {
                clearTimeout(timeout);
                context.removeEventListener('statechange', done);
                resolve();
            };
            const timeout = setTimeout(done, START_TIMEOUT);
            context.addEventListener('statechange', done);
        });
        if (!started() && !this._paused && !this._closed && this._audible()) {
            throw new DOMException(
                'AudioContext was not allowed to start, a user gesture is required to play audio',
                'NotAllowedError'
            );
        }
    }

    /**
     * Pause the playback
     */
    pause() {
        if (this._paused) {
            return;
        }
        if (!this._rendering) {
            this._virtualTime(); // progress until now
        }
        this._paused = true;
        this._post({ type: 'pause' });
    }

    /**
     * Move the playback to this media time in seconds
     */
    seek(time: number) {
        if (this._closed) {
            return;
        }
        this._time = this._position = time;
        this._anchor = { media: time, at: performance.now() };
        this._clock.length = 0;
        if (this._rendering) {
            this._seeking = true;
            // the reports of the audio worklet are ignored until it has processed this seek
            this._post({ type: 'seek', time, id: ++this._seek });
            return;
        }
        this._updateVirtual();
        Promise.resolve().then(() => {
            if (!this._closed && !this._seeking) {
                this.onSeeked();
            }
        });
    }

    /**
     * Stop the rendering and release the resources
     */
    close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        clearInterval(this._timer);
        _renderers.delete(this);
        this._rendering = false;
        this._pending.length = 0;
        this._ranges.length = 0;
        if (this._node) {
            this._node.port.onmessage = null;
            try {
                this._node.port.postMessage({ type: 'close' });
                this._node.disconnect();
                this._gain?.disconnect();
            } catch (_) {}
            this._node = this._gain = undefined;
        }
        if (!_renderers.size) {
            // Release the audio output if nothing is played again in the next seconds
            suspendLater(SUSPEND_DELAY);
        }
    }

    private _audible(): boolean {
        return !this._muted && this._volume > 0;
    }

    private _updateGain() {
        if (this._gain && _context) {
            // short ramp to avoid a click
            this._gain.gain.setTargetAtTime(this._muted ? 0 : this._volume, _context.currentTime, 0.015);
        }
        if (this._audible() && !this._closed) {
            resume(); // maybe allowed now, when the change comes from a user gesture
        }
    }

    private _post(command: AudioWorkletCommand) {
        if (this._rendering) {
            this._send(command);
        }
    }

    private _send(command: AudioWorkletCommand) {
        try {
            if (command.type === 'pcm') {
                this._node?.port.postMessage(
                    command,
                    command.channels.map(channel => channel.buffer as ArrayBuffer)
                );
            } else {
                this._node?.port.postMessage(command);
            }
        } catch (e) {
            this.log('Audio worklet command failed', e).warn();
        }
    }

    private _setStarved(starved: boolean) {
        if (starved === this._starved) {
            return;
        }
        this._starved = starved;
        if (!starved) {
            this.onCanPlay();
        } else if (!this._paused) {
            this.onWaiting();
        }
    }

    private _trim(time: number) {
        const ranges = this._ranges;
        while (ranges.length > 1 && ranges[0].end <= time) {
            ranges.shift();
        }
        if (ranges.length && ranges[0].start < time) {
            ranges[0].start = Math.min(time, ranges[0].end);
        }
        this._post({ type: 'trim', time });
    }

    private _tick() {
        if (this._closed) {
            return;
        }
        if (this._rendering) {
            // the reports of the audio worklet are the ticks
            if (_context?.state !== 'running') {
                this._onContextState();
            }
            return;
        }
        this._attach();
        if (this._rendering) {
            return;
        }
        // Release the PCM that will never be heard
        const time = this._updateVirtual();
        const pending = this._pending;
        let count = 0;
        while (count < pending.length && pending[count].time + pending[count].channels[0].length / pending[count].rate <= time) {
            ++count;
        }
        if (count) {
            pending.splice(0, count);
        }
        this.onTick();
    }

    /// RENDERING ///

    _onContextState() {
        if (this._closed) {
            return;
        }
        if (_context?.state === 'running') {
            this._attach();
        } else if (this._rendering) {
            this._detach();
        }
    }

    /**
     * Give the playback to the audio worklet, if the AudioContext is running
     */
    private _attach() {
        const context = _context;
        if (this._rendering || this._closed || !context || context.state !== 'running' || !_ready) {
            return;
        }
        if (!this._node) {
            if (!this._pending.length) {
                return; // wait the first PCM to know the audio format
            }
            try {
                const channels = Math.max(1, Math.min(this._pending[0].channels.length, MAX_CHANNELS));
                this._node = new AudioWorkletNode(context, AUDIO_WORKLET_NAME, {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [channels]
                });
                this._node.onprocessorerror = () => this.onError('Audio worklet processing error');
                this._gain = context.createGain();
                this._gain.gain.value = this._muted ? 0 : this._volume;
                this._node.connect(this._gain).connect(context.destination);
                if (channels > 2 && context.destination.maxChannelCount >= channels) {
                    context.destination.channelCount = channels; // surround output
                }
            } catch (e) {
                this._node = this._gain = undefined;
                this.onError('Audio worklet creation failed, ' + (e instanceof Error ? e.message : String(e)));
                return;
            }
        }
        this._node.port.onmessage = (event: MessageEvent) => this._onReport(event.data);
        // Continue the virtual playback from its current time
        const time = this._virtualTime();
        this._rendering = true;
        this._clock.length = 0;
        this._position = time;
        this._send({ type: 'reset' });
        for (const command of this._pending) {
            this._send(command);
        }
        this._pending.length = 0;
        this._send({ type: 'tempo', value: this._rate, pitch: this._preservesPitch });
        this._send({ type: 'seek', time, id: ++this._seek });
        if (!this._paused) {
            this._send({ type: 'play' });
        }
        this.log(`Audio rendering started at ${context.sampleRate}Hz`).info();
    }

    /**
     * Take back the playback from the audio worklet, the AudioContext is not running anymore
     */
    private _detach() {
        this.log(`Audio rendering suspended, AudioContext is ${_context?.state}`).warn();
        const time = this._renderedTime();
        this._rendering = false;
        this._seeking = false;
        this._clock.length = 0;
        // The PCM given to the audio worklet is lost, the next PCM starts a new timeline
        this._anchor = { media: time, at: performance.now() };
        this._updateVirtual();
    }

    private _onReport(report: AudioWorkletReport) {
        if (!this._rendering || report.seek !== this._seek) {
            return; // report obsolete
        }
        if (report.jump !== this._jump) {
            // discontinuity of the media time
            this._jump = report.jump;
            this._clock.length = 0;
            this._time = report.media;
        }
        this._position = report.media;
        this._clock.push({ context: report.context, media: report.media });
        if (this._clock.length > 64) {
            this._clock.shift();
        }
        if (this._seeking) {
            this._seeking = false;
            this._setStarved(report.starved);
            this.onSeeked();
        } else {
            this._setStarved(report.starved);
        }
        if (!this._closed) {
            this.onTick();
        }
    }

    /**
     * Time of the AudioContext currently heard: its current time minus the latency of the audio output
     */
    private _heardTime(context: AudioContext): number {
        let time = context.currentTime - (context.outputLatency || context.baseLatency || 0);
        try {
            // More precise when available, context.currentTime progresses only by block of frames
            const timestamp = context.getOutputTimestamp();
            if (timestamp.contextTime && timestamp.performanceTime) {
                const precise = timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1000;
                // Few browsers give here the time rendered rather than the time heard: keep the most late
                if (precise < context.currentTime + 0.01 && precise > time - 0.1) {
                    time = Math.min(precise, time + 0.01);
                }
            }
        } catch (_) {}
        return time;
    }

    /**
     * Media time heard, interpolated from the reports of the audio worklet
     */
    private _renderedTime(): number {
        const clock = this._clock;
        if (!clock.length || !_context) {
            return this._position;
        }
        const time = this._heardTime(_context);
        let i = clock.length - 1;
        while (i > 0 && clock[i].context > time) {
            --i;
        }
        const from = clock[i];
        if (time <= from.context) {
            return from.media; // not heard yet
        }
        if (i === clock.length - 1) {
            // after the last report
            return this.running ? from.media + Math.min(time - from.context, EXTRAPOLATION) * this._rate : from.media;
        }
        const to = clock[i + 1];
        return from.media + ((to.media - from.media) * (time - from.context)) / (to.context - from.context);
    }

    /// VIRTUAL PLAYBACK ///

    /**
     * Progress the virtual playback until now on the system clock, and returns its media time.
     * It reads the timeline like the audio worklet does: range after range, without waiting in the holes.
     */
    private _virtualTime(): number {
        const now = performance.now();
        const anchor = this._anchor;
        let time = anchor.media;
        const ranges = this._ranges;
        let elapsed = this._paused ? 0 : ((now - anchor.at) / 1000) * this._rate;
        for (let i = 0; i < ranges.length; ++i) {
            const range = ranges[i];
            if (range.end <= time && i < ranges.length - 1) {
                continue; // already played
            }
            if (time < range.start) {
                time = range.start; // jump over the hole
            }
            const room = Math.max(0, range.end - time);
            if (elapsed < room || i === ranges.length - 1) {
                time += Math.min(elapsed, room);
                break;
            }
            time = range.end;
            elapsed -= room;
        }
        anchor.media = time;
        anchor.at = now;
        return time;
    }

    /**
     * Update the state of the virtual playback, returns its media time
     */
    private _updateVirtual(): number {
        const time = this._virtualTime();
        if (!this._rendering) {
            // Margin to not flap when PCM comes frame by frame
            this._setStarved(this.endTime - time < (this._starved ? 0.06 : 0.001));
        }
        return time;
    }
}
