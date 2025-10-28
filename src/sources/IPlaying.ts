/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { EventEmitter } from '@ceeblue/web-utils';
import * as Media from '../media/Media';

/**
 * Represents the playback buffer state
 */
export enum BufferState {
    /**
     * `NONE` indicates the buffer has no state for this moment,
     *  means playing is stopped or loading
     */
    NONE = 'NONE',

    /**
     * `LOW` indicates the buffer is critically low,
     * triggering stream recovery mechanisms.
     */
    LOW = 'LOW',

    /**
     * `OK` indicates the buffer is within acceptable limits
     * for smooth playback.
     */
    OK = 'OK',

    /**
     * `HIGH` indicates the buffer is too large relative to
     * the configured latency, triggering live‐sync adjustments.
     */
    HIGH = 'HIGH'
}

/**
 * Interface for real-time playback information
 */
export interface IPlaying extends EventEmitter {
    /**
     * Event fire when buffer state change
     * @event
     */
    onBufferState(oldState: BufferState): void;

    /**
     * Event fire on playback stall
     * @event
     */
    onStall(): void;

    /**
     * Event fire on audio skipping
     * @event
     */
    onAudioSkipping(holeMs: number): void;

    /**
     * Event fire on video skipping
     * @event
     */
    onVideoSkipping(holeMs: number): void;

    /**
     * Gets an AbortSignal useful for subscribing to playback stop events.
     */
    get signal(): AbortSignal;

    /**
     * Gets whether playback is reliable
     * By default is `false` while playback is in an unreliable mode with frame skipping enabled,
     * otherwise can returns `true` when configured to not tolerate any frame loss
     */
    get reliable(): boolean;

    /**
     * Gets the current playback buffer duration in milliseconds
     */
    get bufferAmount(): number;

    /**
     * Gets the low-buffer threshold for {@link BufferState.LOW} in milliseconds
     */
    get bufferLimitLow(): number;

    /**
     * Gets the target (middle) buffer size in milliseconds.
     * Latency control mechanisms will try to drive the buffer toward this value.
     */
    get bufferLimitMiddle(): number;

    /**
     * Gets the high-buffer threshold for {@link BufferState.HIGH} in milliseconds
     */
    get bufferLimitHigh(): number;

    /**
     * Returns true When player is buffering data on start or after a stall.
     * Become false when reach {@link bufferLimitMiddle} (in this case {@link bufferState} == {@link BufferState.OK})
     */
    get buffering(): boolean;

    /**
     * Gets the current {@link BufferState}
     */
    get bufferState(): BufferState;

    /**
     * Gets the current receive byte rate
     */
    get recvByteRate(): number;

    /**
     * Get the number of video frame per second currently decoding
     */
    get videoPerSecond(): number;

    /**
     * Get the number of audio sample per second currently decoding
     */
    get audioPerSecond(): number;

    /**
     * Gets the current playback rate.
     * A value of 1.0 represents real-time playback.
     */
    get playbackRate(): number;

    /**
     * Gets the effective playback speed.
     * A value of 1.0 represents real-time playback.
     */
    get playbackSpeed(): number;

    /**
     * Get maximum resolution that the MBR algo can reach, undefined means no limit.
     * Defaults to the value of {@link Media.screenResolution}
     */
    get maximumResolution(): Media.Resolution | undefined;

    /**
     * Source is CMAF and passthrough it to MSE, it's a debugging mode
     * activable when you set {@link Connect.Params.mediaExt} to 'cmaf'
     */
    get passthroughCMAF(): boolean | undefined;
}
