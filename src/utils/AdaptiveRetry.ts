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
 * The goal is to avoid retrying too frequently after a failure by adapting the delay before the next attempt.
 * A failure starts a new waiting period, while a successful observation allows the delay to decrease progressively.
 *
 * ## Behavior
 * - `try()` returns `true` after the current retry delay has elapsed without a new failure.
 * - The first `fail()` after initialization or a success increases the retry delay by `learningTryStep`, up to `maximumTryDelay`.
 * - Consecutive `fail()` calls restart the waiting period without increasing the delay again.
 * - After a successful attempt, starting the next observation decreases the delay by `learningTryStep`.
 * - The retry delay resets when calling `reset()`.
 *
 * ## Parameters
 * - `learningTryStep`: Number of milliseconds added to the delay after each failure (default: `3000`).
 * - `maximumTryDelay`: Maximum delay in milliseconds before allowing another retry (default: `30000`).
 *
 * @example
 * const retry = new AdaptiveRetry("MySystem",{
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
 *     retry.fail(); // notify AdaptiveRetry of the failure
 *     console.error("Task failed, will retry later...");
 *   }
 * }
 */
export class AdaptiveRetry extends Loggable {
    get name(): string {
        return this._name;
    }
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
     * minimum delay to move away the next try
     */
    get minimumTryDelay(): number {
        return this._params.minimumTryDelay || 0;
    }
    /**
     * maximum delay to move away the next try
     */
    get maximumTryDelay(): number {
        return this._params.maximumTryDelay || 0;
    }

    /**
     * Indicates whether the last attempt failed.
     */
    get failed(): boolean {
        return this._failed ?? false;
    }

    private _name: string;
    private _tryDelay!: number;
    private _appreciationTime!: number;
    private _failed?: boolean;

    /**
     * Create a new AdaptiveRetry instance.
     *
     * The first failure in a failure period increases the retry delay by `learningTryStep` milliseconds,
     * capped at `maximumTryDelay`. After a successful attempt, the delay can progressively decrease.
     *
     * @param name A descriptive name for this AdaptiveRetry instance, used in logging.
     * @param params Optional parameters to configure the retry behavior.
     * @param params.minimumTryDelay `3000`, Minimum retry delay in milliseconds. The delay will not decrease below this value.
     * @param params.learningTryStep `3000`, Number of milliseconds added to the retry delay after each failure.
     * @param params.maximumTryDelay `30000`, Maximum retry delay in milliseconds. Once reached, further failures will not increase the delay.
     */
    constructor(
        name: string,
        private _params: {
            minimumTryDelay?: number;
            learningTryStep?: number;
            maximumTryDelay?: number;
        } = {}
    ) {
        super();
        this._name = name;
        this._params = Object.assign(
            {
                minimumTryDelay: LEARNING_TRY_STEP,
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
        this._tryDelay = this.minimumTryDelay;
        this._appreciationTime = 0;
        this._failed = undefined;
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
            if (this._failed === false) {
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
        this._failed = false;
        return true;
    }

    /**
     * Mark the current observation as failed.
     * The first failure after initialization or a success increases the delay;
     * consecutive failures only restart the waiting period.
     *
     * @param forceIncrease Increase the delay even when the current failure period is already marked as failed.
     * @returns true if the delay was increased, false for a consecutive failure or if the delay is already at maximum
     */
    fail(forceIncrease: boolean = false): boolean {
        // reset appreciation time on any fail !
        this._appreciationTime = 0;
        // First failure in this failure period => increase the delay before trying again.
        if (!forceIncrease && this._failed) {
            return false;
        }
        this._failed = true;
        return this.increase();
    }

    /**
     * Force to increase the delay before to try
     *
     * @returns true if the delay was increased, false if it was already at maximum
     */
    increase(): boolean {
        const tryDelay = this._tryDelay;
        this._tryDelay = Math.min(this._tryDelay + this.learningTryStep, this.maximumTryDelay);
        if (this._tryDelay <= tryDelay) {
            return false;
        }
        this.log(`Increase ${this._name} try delay from ${tryDelay}ms to ${this._tryDelay}ms`).info();
        return true;
    }

    /**
     * Force to decrease the delay before to try
     *
     * @returns true if the delay was decreased, false if it was already at minimum
     */
    decrease(): boolean {
        const tryDelay = this._tryDelay;
        this._tryDelay = Math.max(this._tryDelay - this.learningTryStep, this.minimumTryDelay);
        if (this._tryDelay >= tryDelay) {
            return false;
        }
        this.log(`Decrease ${this._name} try delay from ${tryDelay}ms to ${this._tryDelay}ms`).info();
        return true;
    }
}
