/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

export class BufferMeasure {
    get low(): number {
        return this._low;
    }
    get lowTime(): number {
        return this._lowTime;
    }
    get high(): number {
        return this._high;
    }
    get highTime(): number {
        return this._highTime;
    }
    get time(): number {
        return this._time;
    }

    get lowHighDuration(): number {
        if (!this._lowTime || !this._highTime) {
            return 0;
        }
        return Math.abs(this._highTime - this._lowTime);
    }

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

    set(bufferAmount: number) {
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
