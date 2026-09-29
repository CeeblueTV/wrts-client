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
 * Failures increase the delay, while successful observation windows between two accepted `try()` calls are counted
 * so callers can decide when to decrease it explicitly.
 *
 * ## Behavior
 * - `try()` returns `true` after the current retry delay has elapsed. The first accepted call opens an observation
 *   window; each subsequent accepted call increments `success` when no `fail()` occurred in the meantime.
 * - The first `fail()` after initialization or a success increases the retry delay by `learningTryStep`, up to `maximumTryDelay`.
 * - Consecutive `fail()` calls restart the waiting period without increasing the delay again.
 * - `success` is always non-negative and counts completed `try()`-to-`try()` windows without a failure. Any effective
 *   change of the retry delay resets it, so new windows must be observed before decreasing again.
 * - `decrease()` explicitly decreases the delay by `learningTryStep`, without going below the configured minimum or
 *   an optional per-call minimum.
 * - `reset()` restores the initial delay and clears the success and failure state.
 *
 * ## Parameters
 * - `minimumTryDelay`: Minimum retry delay in milliseconds (default: `3000`).
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
 *     if (retry.success > 0) {
 *       retry.decrease(); // retry sooner after a complete successful window (this resets `success`)
 *     }
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
     * Number of consecutive successful observation windows.
     *
     * A successful window starts when `try()` first returns `true` and completes when it returns `true` again without
     * an intervening `fail()`. The value is always non-negative: it is `0` before the first complete successful window,
     * while the retry is in a failure period, and after any effective change of the retry delay, which resets the count.
     */
    get success(): number {
        return Math.max(0, this._success ?? 0);
    }

    /**
     * Whether a failure occurred since the last accepted `try()` call.
     */
    get failed(): boolean {
        return (this._success ?? 0) < 0;
    }

    private _name: string;
    private _tryDelay!: number;
    private _appreciationTime!: number;
    private _success?: number;

    /**
     * Create a new AdaptiveRetry instance.
     *
     * The first failure in a failure period increases the retry delay by `learningTryStep` milliseconds, capped at
     * `maximumTryDelay`. Successful `try()`-to-`try()` observation windows update {@link success}; callers decide when
     * to decrease the delay explicitly with {@link decrease}.
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
     * Reset the retry delay and clear the success and failure state.
     */
    reset() {
        this._tryDelay = this.minimumTryDelay;
        this._appreciationTime = 0;
        this._success = undefined;
    }

    /**
     * Start or complete a successful observation window.
     *
     * The first accepted call after initialization, a failure or a change of the retry delay opens a new window and
     * leaves {@link success} at `0`. Each subsequent accepted call increments it when no {@link fail} occurred since
     * the preceding accepted call. This method does not change the retry delay.
     *
     * @returns `true` when the current retry delay has elapsed, otherwise `false`.
     */
    try(): boolean {
        // OK
        const now = Util.time();
        if (!this._appreciationTime) {
            // First correct appreciation
            this._appreciationTime = now;
        }

        const elapsed = now - this._appreciationTime;
        if (elapsed < this._tryDelay) {
            return false;
        }
        // OK for long time!
        this._appreciationTime = 0;
        if (this._success == null) {
            this._success = -1;
        }
        ++this._success;
        return true;
    }

    /**
     * Restart the waiting period without changing the retry delay or success state.
     */
    rearm() {
        this._appreciationTime = Util.time();
    }

    /**
     * Mark the current observation window as failed and clear the exposed success count.
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
        if (!forceIncrease && this._success && this._success < 0) {
            return false;
        }
        this._success = -1;
        return this.increase();
    }

    /**
     * Force an increase of the delay before trying again.
     *
     * An effective increase resets the {@link success} count, while an ongoing failure period is preserved.
     *
     * @returns true if the delay was increased, false if it was already at maximum
     */
    increase(): boolean {
        const tryDelay = Math.min(this._tryDelay + this.learningTryStep, this.maximumTryDelay);
        if (tryDelay <= this._tryDelay) {
            // nothing to change
            return false;
        }
        if ((this._success ?? 0) >= 0) {
            // reset success count if tryDelay change
            this._success = undefined;
        }
        this.log(`Increase ${this._name} try delay from ${this._tryDelay}ms to ${tryDelay}ms`).info();
        this._tryDelay = tryDelay;
        return true;
    }

    /**
     * Force a decrease of the delay before trying again.
     *
     * An effective decrease resets the {@link success} count, so new successful windows must be observed before the
     * caller can decrease again.
     *
     * @param minTryDelay Minimum delay to preserve. Defaults to the configured `minimumTryDelay`.
     * @returns true if the delay was decreased, false if it was already at the requested minimum
     */
    decrease(minTryDelay?: number): boolean {
        minTryDelay = minTryDelay ? Math.max(this.minimumTryDelay, minTryDelay) : this.minimumTryDelay;
        const tryDelay = Math.max(this._tryDelay - this.learningTryStep, minTryDelay);
        if (tryDelay >= this._tryDelay) {
            // nothing to change
            return false;
        }
        if ((this._success ?? 0) >= 0) {
            // reset success count if tryDelay change
            this._success = undefined;
        }
        this.log(`Decrease ${this._name} try delay from ${this._tryDelay}ms to ${tryDelay}ms`).info();
        this._tryDelay = tryDelay;
        return true;
    }
}
