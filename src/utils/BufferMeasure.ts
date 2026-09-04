/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

/**
 * Collects normalized buffer measurements and exposes the observed range.
 *
 * Buffer amounts and durations are expressed in milliseconds. Measurement times
 * are Unix timestamps in milliseconds.
 */
export class BufferMeasure {
    /**
     * Lowest normalized buffer amount observed, or `0` before the first measurement.
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
     * Highest normalized buffer amount observed, or `0` before the first measurement.
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
     * Difference between the highest and lowest normalized buffer amounts.
     * Returns `0` until both observations are available.
     */
    get lowHighRange(): number {
        if (!this._lowTime || !this._highTime) {
            return 0;
        }
        return this._high - this._low;
    }

    /**
     * Whether samples are being ignored while the initial playback-speed reaches real-time speed.
     */
    get starting() {
        return this._starting != null;
    }

    /**
     * Whether the buffer measurements are currently being ignored
     * due to the initial playback-speed being below real-time speed.
     */
    set starting(value: boolean) {
        this._starting = value ? 0 : undefined;
    }

    private _low: number = 0;
    private _lowTime: number = 0;
    private _high: number = 0;
    private _highTime: number = 0;
    private _time: number = 0;
    private _starting?: number;

    /**
     * Adds a buffer measurement normalized for the current playback speed.
     *
     * When {@link starting} is enabled, initial samples are ignored while the
     * playback-speed estimate increases below real-time speed.
     *
     * @param bufferAmount Current buffered media duration in milliseconds.
     * @param playbackSpeed Estimated playback speed, where `1` is real-time speed.
     */
    set(bufferAmount: number, playbackSpeed: number) {
        // Ignore initial values while the playback-speed reaches real-time speed
        if (this._starting != null) {
            if (playbackSpeed < 1 && playbackSpeed >= this._starting) {
                this._starting = playbackSpeed;
                return;
            }
            this._starting = undefined;
        }
        // Compute buffer amount relative to playback rate
        if (playbackSpeed > 1) {
            bufferAmount /= playbackSpeed;
        } else if (playbackSpeed < 1) {
            bufferAmount *= playbackSpeed;
        }
        bufferAmount = Math.round(bufferAmount);
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
