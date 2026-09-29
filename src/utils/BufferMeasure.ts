/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

/**
 * Collects buffer measurements and exposes the observed range.
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
     * Time of the latest accepted measurement, or `0` before the first measurement.
     */
    get time(): number {
        return this._time;
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
    private _time: number = 0;

    /**
     * Adds a buffer measurement.
     * @param bufferAmount Current buffered media duration in milliseconds.
     */
    set(bufferAmount: number) {
        // Save the current time and update low/high values
        this._time = Date.now();
        if (!this._lowTime || bufferAmount <= this._low) {
            this._low = bufferAmount;
            this._lowTime = this._time;
        }
        if (!this._highTime || bufferAmount >= this._high) {
            this._high = bufferAmount;
            this._highTime = this._time;
        }
    }
}
