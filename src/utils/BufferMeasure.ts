/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

/**
 * Collects buffer measurements and exposes the observed range after removing
 * the drift caused by the requested playback rate.
 *
 * Buffer amounts and durations are expressed in milliseconds. Measurement times
 * are Unix timestamps in milliseconds.
 */
export class BufferMeasure {
    /**
     * Lowest buffer amount observed, or `0` before the first measurement.
     */
    get low(): number {
        return this._low;
    }
    /**
     * Time at which {@link low} was observed, or `0` before the first measurement.
     */
    get lowTime(): number {
        return this._lowTime;
    }
    /**
     * Highest buffer amount observed, or `0` before the first measurement.
     */
    get high(): number {
        return this._high;
    }
    /**
     * Time at which {@link high} was observed, or `0` before the first measurement.
     */
    get highTime(): number {
        return this._highTime;
    }

    /**
     * Reference time used to compensate the next measurement, or `0` when no previous interval should be compensated.
     */
    get lastTime(): number {
        return this._lastTime;
    }
    /**
     * Changes the reference time used by the next measurement.
     * Set it to `0` to exclude a discontinuous interval, such as a seek or starting phase, without clearing the
     * collected extrema or the accumulated playback-rate drift.
     */
    set lastTime(value: number) {
        this._lastTime = value;
    }

    /**
     * Absolute duration between the lowest and highest observations.
     * Returns `0` until both observations are available.
     */
    get lowHighDuration(): number {
        if (!this._lowTime || !this._highTime) {
            return 0;
        }
        return Math.abs(this._highTime - this._lowTime);
    }

    /**
     * Difference between the highest and lowest buffer amounts.
     * Returns `0` until both observations are available.
     */
    get lowHighRange(): number {
        if (!this._lowTime || !this._highTime) {
            return 0;
        }
        return this._high - this._low;
    }

    private _low: number = 0;
    private _lowTime: number = 0;
    private _high: number = 0;
    private _highTime: number = 0;
    private _lastTime: number = 0;
    private _rateDrift: number = 0;

    /**
     * Adds a buffer measurement corrected for the drift caused by the requested playback rate.
     *
     * @param bufferAmount Current buffered media duration in milliseconds.
     * @param playbackRate Playback rate applied since the previous measurement.
     */
    set(bufferAmount: number, playbackRate: number = 1) {
        // Save the current time and update low/high values
        const time = Date.now();
        if (this._lastTime) {
            this._rateDrift += (playbackRate - 1) * (time - this._lastTime);
        }
        this._lastTime = time;
        bufferAmount = Math.round(bufferAmount + this._rateDrift);
        if (!this._lowTime || bufferAmount <= this._low) {
            this._low = bufferAmount;
            this._lowTime = time;
        }
        if (!this._highTime || bufferAmount >= this._high) {
            this._high = bufferAmount;
            this._highTime = time;
        }
    }
}
