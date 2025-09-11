/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Loggable, Util } from '@ceeblue/web-utils';

const LEARNING_TRY_STEP = 3000;
const MAXIMUM_TRY_DELAY = 30000;

/**
 * AdaptiveRetry is a helper class that manages retry attempts with an **adaptive retry strategy**.
 *
 * The goal is to avoid retrying too frequently after a failure, by increasing the delay before the next attempt.
 * When a retry succeeds, the timer resets and the next attempt can occur immediately.
 *
 * ## Behavior
 * - On success (`try()` returns true), the system can proceed without waiting.
 * - On failure (`raise()`), the retry delay increases progressively (by `learningTryStep`) up to a maximum (`maximumTryDelay`).
 * - The retry delay resets when calling `reset()`.
 *
 * ## Parameters
 * - `learningTryStep`: Number of milliseconds added to the delay after each failure (default: `3000`).
 * - `maximumTryDelay`: Maximum delay in milliseconds before allowing another retry (default: `30000`).
 *
 * @example
 * const retry = new AdaptiveRetry({
 *   learningTryStep: 2000,   // increase delay by 2s on each failure
 *   maximumTryDelay: 10000   // cap retry delay at 10s
 * });
 *
 * async function attemptTask() {
 *   if (!retry.try()) {
 *     console.log("Not yet time to retry...");
 *     return;
 *   }
 *   try {
 *     await doSomething(); // your async operation
 *   } catch (e) {
 *     retry.raise(); // notify AdaptiveRetry of the failure
 *     console.error("Task failed, will retry later...");
 *   }
 * }
 */
export class AdaptiveRetry extends Loggable {
    /**
     * try delay before to accept new try
     */
    get tryDelay(): number {
        return this._tryDelay;
    }
    /**
     * delay added after every fail to move away the next try
     */
    get learningTryStep(): number {
        return this._params.learningTryStep || 0;
    }
    /**
     * maximum delay to move away the next try
     */
    get maximumTryDelay(): number {
        return this._params.maximumTryDelay || 0;
    }

    private _tryDelay!: number;
    private _appreciationTime!: number;
    private _success!: boolean;

    /**
     * Create a new AdaptiveRetry instance.
     *
     * Each failure increases the retry delay by `learningTryStep` milliseconds, capped at `maximumTryDelay`.
     * On success, the retry delay can reset.
     *
     * @param params.learningTryStep `3000`, Number of milliseconds added to the retry delay after each failure.
     * @param params.maximumTryDelay `30000`, Maximum retry delay in milliseconds. Once reached, further failures will not increase the delay.
     */
    constructor(
        private _params: {
            learningTryStep?: number;
            maximumTryDelay?: number;
        } = {}
    ) {
        super();
        this._params = Object.assign(
            {
                learningTryStep: LEARNING_TRY_STEP,
                maximumTryDelay: MAXIMUM_TRY_DELAY
            },
            this._params
        );
        this.reset();
    }

    /**
     * Reset the Adaptive Retry algorithm to its initial state
     */
    reset() {
        this._tryDelay = this.learningTryStep;
        this._appreciationTime = 0;
        this._success = false;
    }

    /**
     * New try, return true on ok
     * @returns true on success
     */
    try(): boolean {
        // OK
        const now = Util.time();
        if (!this._appreciationTime) {
            // First correct appreciation
            this._appreciationTime = now;
            if (this._success) {
                // Double success, decrease !
                this.decrease();
            }
        }

        const elapsed = now - this._appreciationTime;
        if (elapsed < this._tryDelay) {
            return false;
        }
        // OK for long time!
        this._appreciationTime = 0;
        this._success = true;
        return true;
    }

    /**
     * Raise a fail: reset appreciation time and increase delay if was on a success
     */
    raise(): void {
        // reset appreciation time on any fail !
        this._appreciationTime = 0;
        // fail => increase delay before to try again!
        if (this._success) {
            this._success = false;
            this.increase();
        }
    }

    /**
     * Force to increase the delay before to try
     */
    increase() {
        const tryDelay = this._tryDelay;
        this._tryDelay = Math.min(this._tryDelay + this.learningTryStep, this.maximumTryDelay);
        if (this._tryDelay > tryDelay) {
            this.log(`Increase try delay from ${tryDelay}ms to ${this._tryDelay}ms`).info();
        }
    }

    /**
     * Force to decrease the delay before to try
     */
    decrease() {
        const tryDelay = this._tryDelay;
        this._tryDelay = Math.max(this._tryDelay - this.learningTryStep, this.learningTryStep);
        if (this._tryDelay < tryDelay) {
            this.log(`Decrease try delay from ${tryDelay}ms to ${this._tryDelay}ms`).info();
        }
    }
}
