/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ILog, Connect, Util, EventEmitter, ByteRate, PlayerStats } from '@ceeblue/web-utils';
import { Source, SourceError } from './sources/Source';
import { ICMCD, CMCD, CMCDMode } from './media/CMCD';
import { BufferState, IPlaying, PlaybackConstraint } from './sources/IPlaying';
import * as Media from './media/Media';
import { Metadata } from './media/Metadata';
import { MediaPlayback, MediaPlaybackError } from './media/MediaPlayback';
import { HTTPAdaptiveSource } from './sources/HTTPAdaptiveSource';
import { MediaKeysEngine, MediaKeysEngineError } from './media/keys/MediaKeysEngine';
import { AdaptiveRetry } from './utils/AdaptiveRetry';
import { BufferMeasure } from './utils/BufferMeasure';

const PAST_BUFFER = 20; // seconds
const BUFFER_LIMIT_LOW = 200; // ms
const BUFFER_LIMIT_HIGH = 1000; // ms
const BUFFER_SEEK_MARGIN = 70; // ms
const TIMEOUT = 14000; // at least superior to max gop duration (10s)
const BUFFER_CHANGE_STEP = 50; // ms

const root = typeof window !== 'undefined' ? window : global;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ManagedMediaSource = (root as any).ManagedMediaSource;
const BUFFER_AUTO_MIN_WINDOW = ManagedMediaSource ? 400 : 200; // ms
const BUFFER_AUTO_MEASURE_MARGIN = 40; // ms
const BUFFER_AUTO_TRY_DELAY = 5000; // ms

const PLAYBACK_RATE_MAX = 110; // Default playback rate when the buffer is high: 10% faster
const PLAYBACK_RATE_MIN = 90; // Default playback rate when the buffer is low: 10% slower
const PLAYBACK_CONSTRAINT_THRESHOLD = 0.05; // 5%

let _maximumResolution: Media.Resolution | undefined;
root.addEventListener('resize', () => (_maximumResolution = Media.screenResolution()));

export type PlayerError =
    /**
     * Represents a Start timeout issue
     */
    | { type: 'PlayerError'; name: 'Start timeout' }
    /**
     * Represents a Connection timeout issue
     */
    | { type: 'PlayerError'; name: 'Connection timeout' }
    /**
     * Represents a Data timeout error
     */
    | { type: 'PlayerError'; name: 'Data timeout' }
    /**
     * Represents a Playback timeout error
     */
    | { type: 'PlayerError'; name: 'Playback timeout' }
    /**
     * Represents a unsupported feature requiring to update the browser
     */
    | { type: 'PlayerError'; name: 'Update the browser'; component: string }
    /**
     * Represents a media playback error
     */
    | { type: 'PlayerError'; name: 'Playback error'; detail: string }
    /**
     * Represents a video play error
     */
    | { type: 'PlayerError'; name: 'Video play error'; detail: string }
    /**
     * Represents a video unsupported error
     */
    | { type: 'PlayerError'; name: 'Video unsupported error'; detail: string }
    /**
     * Represents a {@link SourceError} error
     */
    | SourceError
    /**
     * Represents a {@link MediaPlaybackError} error
     */
    | MediaPlaybackError
    /**
     * Represents a {@link MediaKeysEngineError} error
     */
    | MediaKeysEngineError;

/**
 * Use Player to start playing a WebRTS stream.
 *
 * You can implement and use a custom {@link Source} by passing it as the second argument in the constructor.
 * If not provided, {@link Player.start} will attempt to determine the protocol from {@link Connect.Params.endPoint}
 * to instantiate the corresponding {@link Source.registerClass} or fall back to the default {@link HTTPAdaptiveSource}.
 *
 * You can initialize tracks selection by playing with {@link onMetadata}
 *
 * @example
 * const player = new Player(videoElement);
 * // const player = new Player(videoElement, MySource);
 * player.onStart = () => {
 *    console.log('start playing');
 * }
 * player.onStop = _ => {
 *    console.log('stop playing');
 * }
 *
 * // optional : set initial video track to the best track (by default take the middle rendition)
 * player.onMetadata = (metadata) => ({ video: metadata.videoTracks[0].id });
 * // optional : fix video track to the best track and disable MBR
 * player.onMetadata = (metadata) => player.videoTrack = metadata.videoTracks[0].id;
 *
 * // start playback
 * player.start({
 *    endPoint: <endPoint>
 * });
 * ...
 * // stop playback
 * player.stop();
 *
 */
export class Player extends EventEmitter implements IPlaying, ICMCD {
    /**
     * Event fired when streaming starts
     * @event
     */
    onStart() {
        this.log('onStart').info();
    }

    /**
     * Event fired when streaming stops
     * @param error error description when playback stopped improperly
     * @event
     */
    onStop(error?: PlayerError) {
        if (error) {
            this.log('onStop', error).error();
        } else {
            this.log('onStop').info();
        }
    }

    /**
     * Event fired when data is received in the stream
     * @event
     */
    onData(track: number, time: number, duration: number, data: Uint8Array) {
        this.log(`Data reception ${Util.stringify({ track, time, duration, data })}`).info();
    }

    /**
     * Event fired when an audio {@link Media.Sample} is received from the source
     * @event
     */
    onAudio(track: number, sample: Media.Sample) {}

    /**
     * Event fired when a video {@link Media.Sample} is received from the source
     * @event
     */
    onVideo(track: number, sample: Media.Sample) {}

    /**
     * {@inheritDoc Source.onMetadata}
     * @event {@link Source.onMetadata}
     */
    onMetadata(metadata: Metadata): Media.Tracks | void {
        this.log(Util.stringify(metadata)).info();
    }

    /**
     * {@inheritDoc Source.onTrackChange}
     * @event {@link Source.onTrackChange}
     */
    onTrackChange(audioTrack: number, videoTrack: number, dataTrack: Set<number>) {
        this.log(Util.stringify({ audioTrack, videoTrack, dataTrack })).info();
    }

    /**
     * {@inheritDoc Source.onFinalizeRequest}
     * @event {@link Source.onFinalizeRequest}
     */
    onFinalizeRequest(url: URL, headers: Headers) {}

    /**
     * @override
     * {@inheritDoc IPlaying.onBufferState}
     * @event
     */
    onBufferState(oldState: BufferState) {
        this.log(`Buffer change from ${oldState} to ${this.bufferState} (bufferAmount=${this.bufferAmount}ms)`)[
            this.bufferState === BufferState.LOW ? 'warn' : 'info'
        ]();
    }

    /**
     * @override
     * {@inheritDoc IPlaying.onStall}
     * @event
     */
    onStall() {
        this.log('Playback stall').warn();
    }

    /**
     * @override
     * {@inheritDoc IPlaying.onAudioSkipping}
     * @event
     */
    onAudioSkipping(holeMs: number) {
        this.log(`Audio skips ${holeMs} ms`).warn();
    }

    /**
     * @override
     * {@inheritDoc IPlaying.onVideoSkipping}
     * @event
     */
    onVideoSkipping(holeMs: number) {
        this.log(`Video skips ${holeMs} ms`).warn();
    }

    /**
     * Event fire when audio data are appended to media source, basically here to debug MSE ingestion
     * @event
     */
    onAudioAppended(data: Uint8Array) {}

    /**
     * Event fire when video data are appended to media source, basically here to debug MSE ingestion
     * @event
     */
    onVideoAppended(data: Uint8Array) {}

    /**
     * Event fired when the buffer amount changes by at least `BUFFER_CHANGE_STEP` milliseconds.
     *
     * The default implementation calls {@link adjustPlaybackRate}.
     * Override this event without calling {@link adjustPlaybackRate} to disable that automatic playback-rate adjustment.
     *
     * @event
     */
    onBufferChange(): void {
        this.adjustPlaybackRate();
    }

    /**
     * Event fired when MediaKeys state changes if contentProtection is found in the metadata
     *
     * MediaKeys support can be disabled by setting no contentProtection in the player parameters
     *
     * @param mediaKeysEngine The MediaKeys engine instance when ready, undefined when released
     * @event
     */
    onMediaKeys(mediaKeysEngine?: MediaKeysEngine) {}

    /**
     * Returns true when player is running (between a {@link Player.start} and a {@link Player.stop})
     */
    get running(): boolean {
        return this._timeout ? true : false;
    }

    /**
     * Returns true when player has started (after {@link Player.onStart} event)
     */
    get started(): boolean {
        return this._source ? true : false;
    }

    /**
     * Index of the audio track, can be undefined if player is not playing
     */
    get audioTrack(): number | undefined {
        return this._source?.audioTrack;
    }

    /**
     * Sets the current audio track to the index provided, must be set after {@link Player.onStart starting}.
     * It disables MBR, set it to `undefined` to reactivate MBR.
     */
    set audioTrack(idx: number | undefined) {
        if (!this._source) {
            throw Error('Cannot assign audio track on stopped player');
        }
        this._source.audioTrack = idx;
    }

    /**
     * Index of the video track, can be undefined if player is not playing
     */
    get videoTrack(): number | undefined {
        return this._source?.videoTrack;
    }

    /**
     * Sets the current video track to the index provided, must be set after {@link Player.onStart starting}.
     * It disables MBR, set it to `undefined` to reactivate MBR.
     */
    set videoTrack(idx: number | undefined) {
        if (!this._source) {
            throw Error('Cannot assign video track on stopped player');
        }
        this._source.videoTrack = idx;
    }

    /**
     * Select a or multiple data track to the index provided, must be set after {@link Player.onStart starting}.
     * When set to `undefined` it selects all data tracks available.
     */
    set dataTrack(idx: number | Array<number> | Set<number> | undefined) {
        if (!this._source) {
            throw Error('Cannot assign data track on stopped player');
        }
        this._source.dataTrack = idx;
    }

    /**
     * Index of the data track being received, can be undefined if the player is not playing
     */
    get dataTrack(): Set<number> | undefined {
        return this._source?.dataTrack;
    }

    /**
     * Returns true if manual track selection is supported by the source implementation,
     * can also returns undefined if player is not running
     */
    get trackSelectable(): boolean | undefined {
        return this._source && this._source.trackSelectable;
    }

    /**
     * Returns stream metadata
     */
    get metadata(): Metadata {
        return this._metadata;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.bufferAmount}
     */
    get bufferAmount(): number {
        // Compute currentTime, video.currentTime can be 0 when not started, in this case use this.startTime rather
        const currentTime = Math.max(this.currentTime, this.startTime);
        return Math.max(0, Math.round((this.endTime - currentTime) * 1000));
    }

    /**
     * @override
     * {@inheritDoc IPlaying.bufferLimitLow}
     */
    get bufferLimitLow(): number {
        return this._bufferLimitLow;
    }

    /**
     * Set the low‐buffer threshold for {@link BufferState.LOW} in milliseconds
     */
    set bufferLimitLow(value: number) {
        value = Math.round(value);
        const window = this._bufferLimitHigh - this._bufferLimitLow;
        this._bufferLimitLow = value;
        // to fix bufferLimitHigh and update _bufferLimitMiddle
        this._setBufferLimitHigh(
            Math.max(value, this._bufferLimitHighAuto ? this._bufferLimitLow + window : this._bufferLimitHigh)
        );
    }

    /**
     * @override
     * {@inheritDoc IPlaying.bufferLimitMiddle}
     */
    get bufferLimitMiddle(): number {
        return this._bufferLimitMiddle;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.bufferLimitHigh}
     */
    get bufferLimitHigh(): number {
        return this._bufferLimitHigh;
    }

    /**
     * Set the high-buffer threshold for {@link BufferState.HIGH} in milliseconds
     *
     * If set to undefined, the buffer limit will be automatically computed based
     * on the low-buffer threshold and the network conditions.
     * It's the default behavior.
     */
    set bufferLimitHigh(value: number | undefined) {
        if (value == null) {
            this._bufferLimitHighAuto = new AdaptiveRetry('Buffer', {
                minimumTryDelay: BUFFER_AUTO_TRY_DELAY,
                learningTryStep: BUFFER_AUTO_TRY_DELAY
            });
            this._bufferMeasure = new BufferMeasure();
            // to fix bufferLimitHigh and update _bufferLimitMiddle
            this._setBufferLimitHigh(this._bufferLimitHigh);
        } else {
            this._bufferLimitHighAuto = undefined;
            this._setBufferLimitHigh(value);
        }
    }

    /**
     * @override
     * {@inheritDoc IPlaying.buffering}
     */
    get buffering(): boolean {
        return this._buffering;
    }

    /**
     * @override
     * {@inheritDoc BufferState}
     */
    get bufferState(): BufferState {
        return this._bufferState;
    }

    /**
     * Gets the playback start time in seconds
     */
    get startTime(): number {
        return this._playback ? this._playback.startTime : 0;
    }

    /**
     * Gets the playback end time in seconds
     */
    get endTime(): number {
        return this._playback ? this._playback.endTime : 0;
    }

    /**
     * Gets the current playback time in seconds
     */
    get currentTime(): number {
        return this._video.currentTime;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.playbackRate}
     */
    get playbackRate(): number {
        return this._video.playbackRate;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.playbackSpeed}
     */
    get playbackSpeed(): number {
        return this._computePlaybackSpeed();
    }

    /**
     * @override
     * {@inheritDoc IPlaying.playbackConstraint}
     */
    get playbackConstraint(): PlaybackConstraint | undefined {
        if (!this._source || this._paused || this._starting) {
            return;
        }

        // Only measure slowdown when buffered media exceeds the accurate range,
        // because slow playback may otherwise be caused by insufficient input.
        const playbackSpeed = this.playbackSpeed;
        const playbackRate = this.playbackRate;
        const slowdownRatio =
            this.bufferAmount > this._bufferLimitHigh && playbackRate > 0 && !this._playbackSpeed.increasing
                ? Math.min(Math.max(0, 1 - playbackSpeed / playbackRate), 1)
                : 0;

        // Clamp the ratio because the input and renderer measurements use independent time windows.
        const videoFPS = this._source.videoPerSecond;
        const droppedRatio = videoFPS ? Math.min(Math.max(this._droppedFramePerSecond.exact() / videoFPS, 0), 1) : 0;

        if (droppedRatio > PLAYBACK_CONSTRAINT_THRESHOLD || slowdownRatio > PLAYBACK_CONSTRAINT_THRESHOLD) {
            return { droppedRatio, slowdownRatio };
        }
    }

    /**
     * Gets an estimation of playback latency in milliseconds,
     * Computed as the difference between the estimated live time and the current playback time.
     */
    get latency(): number | undefined {
        // let's negative possible value to detect possible error
        if (this._source && this.currentTime) {
            return Math.ceil(this.metadata.liveTime - this.currentTime * 1000);
        }
    }

    /**
     * @override
     * {@inheritDoc IPlaying.recvByteRate}
     */
    get recvByteRate(): number {
        return this._source?.recvByteRate.value() || 0;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.audioByteRate}
     */
    get audioByteRate(): number {
        return this._source?.audioByteRate || 0;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.videoByteRate}
     */
    get videoByteRate(): number {
        return this._source?.videoByteRate || 0;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.dataByteRate}
     */
    get dataByteRate(): number {
        return this._source?.dataByteRate || 0;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.reliable}
     */
    get reliable(): boolean {
        // whe stopped we can return reliable=false (we can seek/lost when playing is not running)
        return this._source?.reliable ?? false;
    }

    /**
     * Sets whether playback should be treated as reliable.
     * When `false`, playback operates in an unreliable mode with frame skipping enabled;
     * when `true`, frame skipping is not tolerated and reliable mode is enforced.
     */
    set reliable(value: boolean) {
        if (!this._source) {
            throw Error('Cannot change reliability on stopped player');
        }
        this._source.reliable = value;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.maximumResolution}
     */
    get maximumResolution(): Media.Resolution | undefined {
        return this._maximumResolution ?? _maximumResolution;
    }

    /**
     * Set maximum resolution that the MBR algo can reach, undefined means no limit.
     * Defaults to the value of {@link Media.screenResolution}
     */
    set maximumResolution(value: Media.Resolution | undefined) {
        this._maximumResolution = value;
    }

    /**
     * Returns true if player is paused
     */
    get paused(): boolean {
        return this._paused;
    }

    /**
     * Enable or disable player's pause
     */
    set paused(value: boolean) {
        if (!this.running) {
            throw Error('Start the player before to pause playback');
        }
        const wasPaused = this._paused;
        this._paused = value;
        if (this._paused) {
            if (!this._buffering) {
                // An intentional pause must not be reported as a playback timeout.
                clearTimeout(this._timeout?.id);
                // Like at the beginning, reinit starting phase to anticipate the playback resume
                this._starting = 0; // force restarting!
                this._waitStarting();
            }
            this._video.pause();
        } else {
            if (wasPaused) {
                // Restart buffer learning after an intentional pause.
                this._bufferMeasure = new BufferMeasure();
                this._bufferLimitHighAuto?.rearm();
            }
            this._tryToPlay();
        }
    }

    /**
     * @override
     * {@inheritDoc IPlaying.signal}
     */
    get signal(): AbortSignal {
        return this._controller.signal;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.audioPerSecond}
     */
    get audioPerSecond(): number {
        return this._source?.audioPerSecond || 0;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.videoPerSecond}
     */
    get videoPerSecond(): number {
        return this._source?.videoPerSecond || 0;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.droppedFramePerSecond}
     */
    get droppedFramePerSecond(): number {
        return this._droppedFramePerSecond.exact();
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcd}
     */
    get cmcd(): CMCD {
        return this._source ? this._source.cmcd : CMCD.NONE;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcd}
     */
    set cmcd(value: CMCD | undefined) {
        if (!this._source) {
            throw Error('Cannot change cmcd on stopped player');
        }
        this._source.cmcd = value;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdMode}
     */
    get cmcdMode(): CMCDMode {
        return this._source ? this._source.cmcdMode : CMCDMode.HEADER;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdMode}
     */
    set cmcdMode(value: CMCDMode | undefined) {
        if (!this._source) {
            throw Error('Cannot change cmcdMode on stopped player');
        }
        this._source.cmcdMode = value;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdSid}
     */
    get cmcdSid(): string {
        return this._source ? this._source.cmcdSid : '';
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdSid}
     */
    set cmcdSid(value: string | undefined) {
        if (!this._source) {
            throw Error('Cannot change cmcdSid on stopped player');
        }
        this._source.cmcdSid = value;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.passthroughCMAF}
     */
    get passthroughCMAF(): boolean | undefined {
        return this._passthroughCMAF;
    }

    /**
     * @override
     * {@inheritDoc IPlaying.tracksCombinable}
     */
    get tracksCombinable(): boolean | undefined {
        return this._source?.tracksCombinable;
    }

    /**
     * Set whether tracks can be combined in the same request,
     * by default tracks are combinable to optimize the number of requests
     */
    set tracksCombinable(value: boolean) {
        if (!this._source) {
            throw Error('Cannot change tracksCombinable on stopped player');
        }
        this._source.tracksCombinable = value;
    }

    private _mediaSource?: MediaSource;
    private _source?: Source;
    private _video: HTMLVideoElement;
    private _playback?: MediaPlayback;
    private _metadata: Metadata;
    private _timeout?: { id: NodeJS.Timeout; value: number };
    private _bufferLimitLow: number;
    private _bufferLimitHigh: number;
    private _bufferLimitHighAuto?: AdaptiveRetry;
    private _bufferMeasure: BufferMeasure = new BufferMeasure();
    private _bufferLimitMiddle: number;
    private _bufferState: BufferState;
    private _controller: AbortController;
    private _buffering: boolean;
    private _maximumResolution?: Media.Resolution;
    private _paused: boolean;
    private _starting: number = Number.MIN_VALUE;
    private _mediaKeysEngine?: MediaKeysEngine;
    private _mediaKeysStopping?: Promise<unknown>;
    private _playbackSpeed: ByteRate;
    private _playbackPrevTime?: number;
    private _passthroughCMAF?: boolean;
    private _previousBufferAmount: number;
    private _stallCount: number = 0;
    private _droppedVideoFrames: number = 0;
    private _droppedFramePerSecond: ByteRate = new ByteRate(Media.MAX_GOP_DURATION); // Average over GOP

    /**
     * Constructs a new Player instance to render on the {@link HTMLVideoElement} passed in first argument,
     * with an optionally {@link Source} to custom how getting the stream.
     *
     * This doesn't start the playback, you must call {@link Player.start} method
     *
     * @param video HTMLVideoElement object to render the video
     * @param SourceClass Optional Source logic to use, by default it uses {@link HTTPAdaptiveSource}
     * unless {@link Connect.Params.endPoint} begin with ws:// see {@link Player.start}
     * @example
     * // Default build
     * const player = new Player(video);
     *
     * // Build with custom source implementation
     * const player = new Player(MySource);
     */
    constructor(
        video: HTMLVideoElement,
        private SourceClass?: { new (playing: IPlaying, params: Connect.Params): Source }
    ) {
        super();
        this._video = video;
        this._paused = false;
        this._buffering = false;
        this._metadata = new Metadata();
        // Average over 500ms to cover multiple timeupdate samples while keeping playbackSpeed responsive.
        this._playbackSpeed = new ByteRate(500);
        this._bufferLimitMiddle = 0;
        this._bufferLimitLow = BUFFER_LIMIT_LOW;
        this._bufferLimitHigh = BUFFER_LIMIT_HIGH;
        this.bufferLimitHigh = undefined; // init automatic mode
        // Set buffer as OK at the beginning when not playing to ignore congestion network algo
        this._bufferState = BufferState.NONE;
        this._controller = new AbortController();
        this._previousBufferAmount = 0;
    }

    /**
     * Moves the playback head as close as possible to the live point,
     * while respecting the configured {@link bufferLimitLow} and {@link bufferLimitHigh} buffer thresholds.
     * @param reason add a log reason to display to explain this goLive call
     */
    goLive(reason?: string) {
        if (!this.running) {
            throw Error('Cannot goLive on stopped player');
        }
        // Go to the middle buffer position to avoid MBR change, and in a valid range superior or equals to startTime
        const prevCurrentTime = this._video.currentTime;
        const currentTime = (this._video.currentTime = Math.max(
            this.startTime,
            this.endTime - Math.max(this._bufferLimitLow, this._bufferLimitMiddle - BUFFER_SEEK_MARGIN) / 1000
        ));
        if (prevCurrentTime !== currentTime) {
            // After the seek, give the value
            this._playbackPrevTime = currentTime;
        }
        reason = reason ? ' ' + reason.trim() : '';
        this.log(
            `goLive${reason} from ${prevCurrentTime.toFixed(3)}s to ${currentTime.toFixed(3)}s (${currentTime >= prevCurrentTime ? '+' : ''}${(currentTime - prevCurrentTime).toFixed(3)}s)`
        ).info();
    }

    /**
     * Starts playing the stream
     *
     * If a MediaKeys engine is already running, it means that the previous playback has not been properly released,
     * so the player stops and reports a {@link PlayerError} error to avoid unexpected behavior.
     *
     * @param params Connection parameters {@link Connect.Params}
     * @param idleTimeout  idle timeout, default value is around 14s. It sets the timeout error in the absence of
     * connection activity, data fetching or playback progress, you can tune it to implement your reliable and consistent
     * fallback mechanism.
     * @example
     * player.start({
     *    endPoint: <endPoint>
     * });
     */
    start(params: Connect.Params, idleTimeout?: number) {
        this.stop();

        if (this._mediaKeysStopping) {
            // Previous MediaKeys engine cleanup is still in flight — defer the start
            // until it completes, otherwise the new playback would race with the
            // pending video.setMediaKeys(null).
            this._mediaKeysStopping.then(() => this.start(params, idleTimeout));
            return;
        }

        if (this._mediaKeysEngine) {
            this.onStop({
                type: 'PlayerError',
                name: 'Playback error',
                detail: 'MediaKeys engine must be released before starting a new playback'
            });
            return;
        }

        // stop player on window unload, to avoid issue with iFrame refresh!
        window.addEventListener('beforeunload', () => this.stop(), this._controller);

        idleTimeout = Number(idleTimeout) || TIMEOUT;
        this._timeout = {
            id: setTimeout(() => this.stop({ type: 'PlayerError', name: 'Start timeout' }), idleTimeout),
            value: idleTimeout
        };
        this.log('buffering...').info();
        this._buffering = true;
        this._video.pause();

        // process params
        this._passthroughCMAF = Util.trimStart(params.mediaExt?.toLowerCase() ?? '', '.') === 'cmaf';
        if (this._passthroughCMAF) {
            // Rename it to mp4, cmaf is usefull only to debug reason for bypassing a CMAF source
            params.mediaExt = 'mp4';
        }

        // Create media source
        this._mediaSource = this._newMediaSource();

        if (!this._mediaSource) {
            this.stop({ type: 'PlayerError', name: 'Update the browser', component: 'MediaSource' });
            return;
        }

        this._mediaSource.onsourceclose = () => {
            this.stop({ type: 'PlayerError', name: 'Playback error', detail: 'MediaSource closed' });
        };

        this._mediaSource.onsourceopen = () => {
            if (!this._timeout) {
                // closed!
                return;
            }
            if (!this._mediaSource) {
                return;
            }

            this._mediaSource.onsourceopen = null; // just one time

            // Connection timeout
            clearTimeout(this._timeout.id);
            this._timeout.id = setTimeout(
                () => this.stop({ type: 'PlayerError', name: 'Connection timeout' }),
                this._timeout.value
            );

            const protocol = params.endPoint.substring(0, params.endPoint.indexOf('://'));
            this._source = new (this.SourceClass || Source.getClass(protocol) || HTTPAdaptiveSource)(this, params);
            this._source.log = this.log.bind(this, this._source?.name + ':') as ILog;
            this._source.onTrackChange = (audioTrack: number, videoTrack: number, dataTrack: Set<number>) => {
                if (!this._playback) {
                    return;
                }
                this._playback.audioEnabled = audioTrack >= 0;
                this._playback.videoEnabled = videoTrack >= 0;
                this.onTrackChange(audioTrack, videoTrack, dataTrack);
            };
            this._source.onVideoChange = (videoTrack: number, videoTrackOld?: number) => {
                if (this._playback && videoTrackOld != null && this._bufferLimitHighAuto) {
                    // Reset buffer-auto metrics and rearm attempts
                    this._bufferLimitHighAuto.rearm();
                    this._bufferMeasure = new BufferMeasure();
                }
            };
            this._source.onMetadata = (metadata: Metadata) => {
                this._metadata = metadata;

                // Start the MediaKeys engine if metadata contains contentProtection and MediaKeysEngine parameters are provided
                if (metadata.contentProtection.size > 0) {
                    if (params.contentProtection) {
                        if (!this._mediaKeysEngine) {
                            this._mediaKeysEngine = new MediaKeysEngine(this._video);
                            this._mediaKeysEngine.onMediaKeys = () => {
                                this.onMediaKeys(this._mediaKeysEngine as MediaKeysEngine);
                            };
                            this._mediaKeysEngine.onError = error => {
                                this.stop(error);
                            };
                            this._mediaKeysEngine.log = this.log.bind(this, 'MediaKeysEngine:') as ILog;
                            this.log('ContentProtection found, starting the MediaKeysEngine...').info();
                            this._mediaKeysEngine.start(params, metadata);
                        }
                    } else {
                        this.log('Ignoring contentProtection because no MediaKeysEngine parameters provided').warn();
                    }
                }

                return this.onMetadata(metadata);
            };
            this._source.onFinalizeRequest = (url: URL, headers: Headers) => {
                this.onFinalizeRequest(url, headers);
            };
            this._source.onAudio = (trackId: number, sample: Media.Sample) => {
                this._playback?.appendAudio(this._metadata, trackId, sample);
                this.onAudio(trackId, sample);
            };
            this._source.onVideo = (trackId: number, sample: Media.Sample) => {
                if (sample.isKeyFrame) {
                    this._droppedFramePerSecond.clip();
                }
                this._playback?.appendVideo(this._metadata, trackId, sample);
                this.onVideo(trackId, sample);
            };
            this._source.onData = (trackId: number, sample: Media.Sample) => {
                this.onData(trackId, sample.time, sample.duration, sample.data);
            };
            this._source.onClose = (error?: SourceError) => this.stop(error);

            // Create MediaPlayback to render frame
            this._playback = new MediaPlayback(this._mediaSource, this.passthroughCMAF);
            this._playback.log = this.log.bind(this);
            this._playback.onAudioAppended = this.onAudioAppended.bind(this);
            this._playback.onVideoAppended = this.onVideoAppended.bind(this);
            this._playback.onProgress = this._onPlaybackProgress.bind(this);
            this._playback.onBufferOverflow = () => {
                // QuotaExceeding can happen just when live video is paused, we have to forward playing to let browser managed buffer exceed
                const time = this._video.currentTime;
                // Advance to 10s
                this._video.currentTime += 10;
                // Look if we success to advance the playback
                if (this._video.currentTime <= time) {
                    // exception whereas already at the end? => stop all!
                    return this.stop({ type: 'MediaBufferError', name: 'Exceeds buffer size' });
                }
                if (this._video.paused) {
                    this.log('Unpause video to release buffer space').warn();
                    this.paused = false;
                } else {
                    this.log('Forward current playing time of 10 second to release buffer space').warn();
                }
            };
            this._playback.onClose = error => this.stop(error);
            this.onStart();
        };

        // Video events
        const onWaiting = () => {
            if (!this._timeout) {
                // stopped!
                return;
            }

            // Fix possible hole on waiting, in first to repair bufferAmount if need!
            this._playback?.flush(true);

            // wait end of starting phase to avoid wrong playbackConstraint
            this._waitStarting();

            if (this._buffering || this.bufferAmount > this.bufferLimitLow) {
                // Already in buffering phase OR
                // Enough data is buffered: treat waiting as transient and watch for playback to resume.
                return;
            }

            // STALL (can also happen on paused player)
            ++this._stallCount;
            // enter in a buffering phase!
            this.log('buffering...').info();
            this._buffering = true;
            // W3C specification says that the player has been stopped to wait data
            // In such case few browsers "Pause" player when waiting data and so
            // require an explicit play => see _onProgress
            this._video.pause();
            /// start data timeout
            clearTimeout(this._timeout.id);
            this._timeout.id = setTimeout(() => this.stop({ type: 'PlayerError', name: 'Data timeout' }), this._timeout.value);
            /// wait data
            this._setBufferState(BufferState.LOW); // Force buffer to LOW
            this.onStall();
        };
        const onCanPlay = () => {
            // /!\ Don't use onCanPlayThrough, not called at all on Safari/iOS
            // try to play again after a waiting data!
            this._tryToPlay();
        };
        const onPlaying = () => {
            if (this._buffering) {
                // Keep the data timeout active while buffering.
                return;
            }
            if (this._starting) {
                // Keep a watchdog active until timeupdate confirms that playback is progressing.
                this._waitStarting(true);
            } else {
                // Playback is already progressing; no watchdog is needed.
                clearTimeout(this._timeout?.id);
            }
        };
        const onSeeking = () => {
            // recompute playback speed on seeking to avoid wrong value
            this._playbackPrevTime = undefined;
            // A seek interrupts the interval used to compensate playback-rate drift.
            this._bufferMeasure.lastTime = 0;
        };
        const onSeeked = () => {
            if (!this.reliable && this.bufferAmount > this.bufferLimitHigh) {
                // take advantage of this seek to do a goLive !
                this.goLive('seeking');
                return;
            }
            this.log(`Playback seek to ${this.currentTime}s (${(this.currentTime - this.endTime).toFixed(3)} from end)`).info();
        };
        const onPause = () => {
            this.log('Playback paused')[this._paused ? 'info' : 'warn']();
        };
        const onTimeUpdate = () => {
            // Compute playbackSpeed on timeupdate to get accurate measurement
            const playbackSpeed = this._computePlaybackSpeed();
            // Detect starting phase to avoid wrong buffer measure
            // Not compute during buffering phase to avoid a double starting-phase transition: now + buffering => starting-phase
            if (!this._paused && !this._buffering && this._starting && playbackSpeed) {
                // When playbackSpeed started OR buffer exceed high limit,
                // check if playbackSpeed is increasing to detect the end of starting phase
                if (playbackSpeed < this.playbackRate && (playbackSpeed > this._starting || this._playbackSpeed.increasing)) {
                    // playback starting
                    this._starting = playbackSpeed;
                } else {
                    // stop starting phase =>
                    // playbackRate reached OR playbackSpeed decreasing
                    this._starting = 0;
                    clearTimeout(this._timeout?.id);
                    this.log(
                        `Starting phase ended at x${playbackSpeed.toFixed(2)} speed (bufferAmount=${this.bufferAmount}ms)`
                    ).info();
                }
            }
            this._onPlayerProgress();
        };

        this._video.addEventListener('waiting', onWaiting);
        this._video.addEventListener('canplay', onCanPlay);
        this._video.addEventListener('playing', onPlaying);
        this._video.addEventListener('seeking', onSeeking);
        this._video.addEventListener('seeked', onSeeked);
        this._video.addEventListener('pause', onPause);
        this._video.addEventListener('timeupdate', onTimeUpdate);

        this._controller.signal.addEventListener(
            'abort',
            () => {
                this._video.removeEventListener('waiting', onWaiting);
                this._video.removeEventListener('canplay', onCanPlay);
                this._video.removeEventListener('playing', onPlaying);
                this._video.removeEventListener('seeking', onSeeking);
                this._video.removeEventListener('seeked', onSeeked);
                this._video.removeEventListener('pause', onPause);
                this._video.removeEventListener('timeupdate', onTimeUpdate);
            },
            { once: true }
        );

        this._video.src = window.URL.createObjectURL(this._mediaSource);
    }

    /**
     * Stops playback.
     * If an error is provided, it is treated as an improper stop and propagated to {@link onStop}.
     * @param error optional error describing why playback stopped improperly
     */
    stop(error?: PlayerError) {
        if (!this._timeout) {
            return;
        }
        clearTimeout(this._timeout.id);
        this._timeout = undefined;

        // abort events!
        this._controller.abort();
        this._controller = new AbortController();

        // Format error before to reset _video
        if (error?.name === 'Playback error') {
            if (this._video.error) {
                // MediaElement.error is more readable/precise
                if (this._video.error.message) {
                    error.detail = this._video.error.message;
                } else {
                    // on safari it can have no message but just a code
                    switch (this._video.error.code) {
                        case MediaError.MEDIA_ERR_DECODE:
                            error.detail = 'Media decoding error (try to update your web browser), ' + error.detail;
                            break;
                        case MediaError.MEDIA_ERR_NETWORK:
                            error.detail = 'Media networking error, ' + error.detail;
                            break;
                        case MediaError.MEDIA_ERR_ABORTED:
                            error.detail = 'Media aborted, ' + error.detail;
                            break;
                        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                            error.detail = 'Media not supported, ' + error.detail;
                            break;
                        default:
                            error.detail = 'Media error ' + this._video.error.code + ', ' + error.detail;
                    }
                }
            }
        }

        // stop MSE
        if (this._mediaSource) {
            this._mediaSource.onsourceopen = this._mediaSource.onsourceclose = null;
            try {
                if (this._source) {
                    this._source.close();
                    // remove events to prevent against an incorrect Source implementation
                    this._source.onClose = Util.EMPTY_FUNCTION;
                    this._source.onMetadata = Util.EMPTY_FUNCTION;
                    this._source.onFinalizeRequest = Util.EMPTY_FUNCTION;
                    this._source.onAudio = Util.EMPTY_FUNCTION;
                    this._source.onVideo = Util.EMPTY_FUNCTION;
                    this._source.onData = Util.EMPTY_FUNCTION;
                    this._source.onTrackChange = Util.EMPTY_FUNCTION;
                    this._source.onVideoChange = Util.EMPTY_FUNCTION;
                    this._source.onAudioChange = Util.EMPTY_FUNCTION;
                }

                // close media playback
                this._playback?.close();
            } catch (_) {}
            // detach video
            URL.revokeObjectURL(this._video.src);
            this._video.src = '';
        }

        if (this._mediaKeysEngine) {
            const mediaKeysEngine = this._mediaKeysEngine;
            mediaKeysEngine.onMediaKeys = Util.EMPTY_FUNCTION;
            mediaKeysEngine.onError = Util.EMPTY_FUNCTION;
            const stopping = mediaKeysEngine.stop();
            this._mediaKeysStopping = stopping;
            stopping.then(() => {
                // Reset mediaKeysEngine only when the MediaKeys have been released
                if (this._mediaKeysEngine === mediaKeysEngine) {
                    this._mediaKeysEngine = undefined;
                    this.onMediaKeys();
                }
                if (this._mediaKeysStopping === stopping) {
                    this._mediaKeysStopping = undefined;
                }
            });
        }

        // Reset values
        this._droppedVideoFrames = 0;
        this._droppedFramePerSecond.clear();
        this._bufferLimitHighAuto?.reset();
        this._bufferMeasure = new BufferMeasure();
        this._passthroughCMAF = undefined;
        this._buffering = false;
        this._paused = false;
        this._source = undefined;
        this._mediaSource = undefined;
        this._playback = undefined;
        this._metadata = new Metadata();
        this._playbackSpeed.clear();
        this._playbackPrevTime = undefined;
        this._stallCount = 0;
        this._starting = Number.MIN_VALUE;
        this._previousBufferAmount = 0;
        // Set buffer as NONE at the beginning when not playing to ignore congestion network algo
        this._bufferState = BufferState.NONE;

        this.onStop(error);
    }

    /**
     * Calculate and return current player statistics as a {@link PlayerStats} object
     */
    computeStats(): PlayerStats {
        const stats = new PlayerStats();
        stats.protocol = 'WebRTS';

        stats.bufferAmount = this.bufferAmount;
        stats.buffering = this.buffering;
        stats.currentTime = this.currentTime;
        stats.latency = this.latency;
        stats.playbackRate = this.playbackRate;
        stats.playbackSpeed = this.playbackSpeed;

        stats.dataByteRate = this.dataByteRate;

        stats.audioPerSecond = this.audioPerSecond;
        stats.audioTrackId = this.audioTrack;
        stats.audioByteRate = this.audioByteRate;
        if (stats.audioTrackId != null) {
            stats.audioTrackBandwidth = this.metadata.tracks.get(stats.audioTrackId)?.bandwidth;
        }
        stats.skippedAudio = this._source?.skippedAudio;

        stats.videoPerSecond = this.videoPerSecond;
        stats.videoTrackId = this.videoTrack;
        stats.videoByteRate = this.videoByteRate;
        if (stats.videoTrackId != null) {
            stats.videoTrackBandwidth = this.metadata.tracks.get(stats.videoTrackId)?.bandwidth;
        }
        stats.skippedVideo = this._source?.skippedVideo;

        stats.stallCount = this._stallCount;

        return stats;
    }

    /**
     * Adjust playback rate according to the buffer state to avoid buffer overrun or underrun.
     *
     * Playback rate is set to `maxRate` when the buffer is high, `minRate` when it is low, and 100% otherwise.
     * Set `maxRate` to 100 or less to disable the increase, or `minRate` to 100 or more to disable the decrease.
     *
     * Disabling the increase can be useful with hardware decoding issues, but affects the player's ability to catch up
     * to the live point after congestion. Disabling the decrease can increase the risk of stalls when network conditions
     * worsen.
     *
     * Note: Intended to be called from {@link onBufferChange}.
     *
     * @param minRate playback rate percentage applied when the buffer is low; defaults to 90 (0.9x)
     * @param maxRate playback rate percentage applied when the buffer is high; defaults to 110 (1.1x)
     */
    adjustPlaybackRate(minRate = PLAYBACK_RATE_MIN, maxRate = PLAYBACK_RATE_MAX) {
        const playbackRate = this._video.playbackRate;

        let rate = 1;
        if (this.bufferState === BufferState.HIGH) {
            if (maxRate > 100) {
                rate = maxRate / 100;
            }
        } else if (this.bufferState === BufferState.LOW) {
            if (minRate < 100) {
                rate = minRate / 100;
            }
        }

        // Some browsers expose playbackRate with float32 precision. Avoid an assignment when both values represent the
        // same float32, as it may fire a ratechange event and briefly disrupt playback.
        if (Math.fround(playbackRate) !== Math.fround(rate)) {
            this._video.playbackRate = rate;
            this.log(`Adapt playback rate to ${this._video.playbackRate} (bufferAmount=${this.bufferAmount}ms)`).info();
        }
    }

    private _setBufferLimitHigh(value: number) {
        value = Math.round(value);
        this._bufferLimitLow = Math.min(value, this._bufferLimitLow);
        if (this._bufferLimitHighAuto) {
            value = Math.max(this._bufferLimitLow + BUFFER_AUTO_MIN_WINDOW, value);
        }
        this._bufferLimitHigh = value;
        this._bufferLimitMiddle = Math.max(0, this._bufferLimitLow + Math.round((value - this._bufferLimitLow) / 2));
    }

    private _adjustBufferLimitHigh(shouldIncrease = false) {
        let highLimit = Math.round(this._bufferLimitLow + this._bufferMeasure.lowHighRange + BUFFER_AUTO_MEASURE_MARGIN);

        if (highLimit > this._bufferLimitHigh) {
            // Buffer augmentation
            // amortize to avoid too much variation
            highLimit = Math.min(highLimit, this._bufferLimitHigh * 2);
        } else {
            // Buffer diminution
            if (shouldIncrease) {
                // A buffer boundary was crossed, so the current window may need to be realigned.
                // Any increase justified by the measurements would have been applied above.
                // Wait for the observation window to complete before considering a decrease.
                return;
            }
            if (highLimit < this._bufferLimitHigh) {
                // amortize the diminution
                highLimit = Math.max(
                    // 50% amortization to target new value
                    Math.floor(this._bufferLimitHigh - (this._bufferLimitHigh - highLimit) / 2),
                    // minumum acceptable relative to low buffer
                    this._bufferLimitLow + BUFFER_AUTO_MIN_WINDOW
                );
            }
        }

        if (highLimit === this._bufferLimitHigh) {
            // no change
            return;
        }

        if (highLimit > this._bufferLimitHigh) {
            this.log(`Increase bufferLimitHigh from ${this._bufferLimitHigh} to ${highLimit}ms`).info();
            this._bufferLimitHighAuto?.fail();
        } else {
            this.log(`Decrease bufferLimitHigh from ${this._bufferLimitHigh} to ${highLimit}ms`).info();
        }
        this._setBufferLimitHigh(highLimit);
    }

    private _setBufferState(state: BufferState) {
        // check if we have a difference
        const oldState = this._bufferState;
        if (oldState === state) {
            return;
        }
        this._bufferState = state;
        this.onBufferState(oldState);
        // A state transition must always be able to re-evaluate the rate, even if bufferAmount
        // happens to settle within BUFFER_CHANGE_STEP of its last onBufferChange right after transitioning
        this.onBufferChange();
    }

    private _newMediaSource(): MediaSource | undefined {
        this._video.disableRemotePlayback = false;
        // in priority try with MediaSource =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const MS = (root as any).WebKitMediaSource || (root as any).MediaSource;
        if (MS) {
            this.log('new MediaSource').info();
            return new MS();
        }
        if (ManagedMediaSource) {
            // Now try with ManagedMediaSource - Safari =>
            // disable pitch to prevent the [WebKit bug 163433](https://bugs.webkit.org/show_bug.cgi?id=163433)
            this._video.preservesPitch = false;
            // disable remote playback what can interact with our playback control
            this._video.disableRemotePlayback = true;
            this.log('new ManagedMediaSource').info();
            return new ManagedMediaSource();
        }
    }

    private async _tryToPlay() {
        if (this._paused || this._buffering) {
            return;
        }
        try {
            if (this._video.paused) {
                this._waitStarting(true);
                await this._video.play();
            }
        } catch (err) {
            if (err instanceof DOMException) {
                switch (err.name) {
                    case 'NotAllowedError':
                        // Can happen when the player needs user interaction to start playback
                        this.stop({ type: 'PlayerError', name: 'Video play error', detail: err.message });
                        return;
                    case 'NotSupportedError':
                        // Can happen when the player doesn't support a format
                        this.stop({ type: 'PlayerError', name: 'Video unsupported error', detail: err.message });
                        return;
                    default:
                }
                // nothing todo, log already displaid
            }
        }
    }

    private _computePlaybackSpeed(): number {
        if (this._video.seeking) {
            // recompute playback speed on seeking
            this._playbackPrevTime = undefined;
        } else {
            const currentTime = this._video.currentTime;
            if (this._playbackPrevTime != null && currentTime > this._playbackPrevTime) {
                this._playbackSpeed.addBytes((currentTime - this._playbackPrevTime) * 100);
            }
            this._playbackPrevTime = currentTime;
        }
        return this._playbackSpeed.value() / 100;
    }

    private _waitStarting(rearm: boolean = false) {
        if (!this._timeout) {
            return;
        }
        if (!this._starting) {
            // reset starting phase
            this._starting = Number.MIN_VALUE;
            // Don't compensate playback-rate drift across a phase where progress is uncertain.
            this._bufferMeasure.lastTime = 0;
            // clean playback speed to measure only the progress of this starting phase
            this._playbackSpeed.clear();
            // mandatory when clear to align accurate measure
            this._playbackPrevTime = undefined;
            rearm = true;
            if (!this._paused) {
                this.log('starting...').info();
            }
        }
        if (rearm && !this._paused && !this._buffering) {
            clearTimeout(this._timeout.id);
            this._timeout.id = setTimeout(
                () => this.stop({ type: 'PlayerError', name: 'Playback timeout' }),
                this._timeout.value
            );
        }
    }

    private _onPlaybackProgress() {
        if (!this._playback) {
            return;
        }
        // Fill hole if we are on the related playback position
        if (this._video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
            // fix hole!
            this._playback.flush(true);
        }

        // We are receiving data, check and control playback speed
        if (!this._starting && this.bufferAmount && !this.playbackSpeed) {
            // no playback speed => reset starting phase to avoid wrong measure
            this._waitStarting();
        }

        if (this._buffering) {
            if (this.bufferAmount < this.bufferLimitMiddle) {
                // On start or after a stall => buffering until bufferLimitMiddle
                return;
            }
            this.log(`Buffering phase ended at ${this.bufferAmount}ms`).info();
            this._buffering = false;
            // Data reception has recovered.
            clearTimeout(this._timeout?.id);
            // Replace the data/start timeout with a playback watchdog.
            this._waitStarting(true);
            // Already reset to OK, what is important on starting to not stay on NONE indefinitely
            // Not considerate the HIGH state, because can change after the goLive
            this._setBufferState(BufferState.OK);
            if (!this.running) {
                return;
            }
            // Compute buffer amount manually without using this.bufferAmount to detect a big jump after
            // a timeline remove, indeed we cannot see this jump with this.bufferAmount since startTime becomes superior to currentTime
            if (this.currentTime && !this.reliable && (this.endTime - this.currentTime) * 1000 > this.bufferLimitHigh) {
                // Take advantage of this hole to repair direct!
                this.goLive('restoring');
            }
        }

        // Keep the playback head within the valid media range, even while intentionally paused.
        if (this.currentTime < this.startTime || this.currentTime >= this.endTime) {
            this.goLive(this.currentTime ? 'repairing' : 'starting');
        }

        this._onPlayerProgress();
    }

    private _onPlayerProgress() {
        if (!this._playback || !this._source) {
            // 'timeupdate' event can happen BEFORE source ready, wait a real information coming from source
            // Fix a false high value for playbackSpeed
            return;
        }

        // Remove obsolete buffer if need
        const currentTime = this.currentTime;
        if (currentTime > this._playback.startTime + PAST_BUFFER) {
            this._playback.startTime = currentTime - PAST_BUFFER;
        }

        if (this._bufferState === BufferState.NONE && this._buffering) {
            // Wait end of the first buffering before to update buffer state!
            return;
        }

        // Measure buffer amount
        const bufferAmount = this.bufferAmount;

        if (!this._paused && !this._starting && this._bufferLimitHighAuto) {
            this._bufferMeasure.set(bufferAmount, this.playbackRate);
            if (bufferAmount <= this._bufferLimitLow || bufferAmount > this._bufferLimitHigh) {
                // React immediately when the configured window is exceeded.
                this._adjustBufferLimitHigh(true);
            } else if (this._bufferLimitHighAuto.try()) {
                // Increase dynamically the bufferLimitHigh according to the bufferMeasure
                this._adjustBufferLimitHigh();

                if (this._bufferLimitHighAuto.success) {
                    // decrease try period if all is ok
                    this._bufferLimitHighAuto.decrease(this._bufferMeasure.lowHighDuration);
                }
                this._bufferMeasure = new BufferMeasure();
            }
        }

        // Playing progress => check buffering!
        if (bufferAmount > this._bufferLimitLow) {
            // OK or HIGH

            // if need to restart play after a waiting data!
            this._tryToPlay();

            // Change buffer in last because call onBufferState user event
            if (bufferAmount > this._bufferLimitHigh) {
                this._setBufferState(BufferState.HIGH);
            } else {
                // create an amortization
                if (
                    this._bufferState === BufferState.LOW
                        ? bufferAmount > this._bufferLimitMiddle
                        : bufferAmount < this._bufferLimitMiddle
                ) {
                    this._setBufferState(BufferState.OK);
                }
            }
        } else {
            // LOW
            this._setBufferState(BufferState.LOW);
        }

        // Buffer change detection
        if (this.running && Math.abs(this._previousBufferAmount - bufferAmount) >= BUFFER_CHANGE_STEP) {
            this._previousBufferAmount = bufferAmount;

            // also compute dropped frames per second
            const quality = this._video.getVideoPlaybackQuality();
            const dropped = quality.droppedVideoFrames - this._droppedVideoFrames;
            this._droppedVideoFrames = quality.droppedVideoFrames;
            if (dropped) {
                this._droppedFramePerSecond.addBytes(dropped);
            }
            this.onBufferChange();
        }
    }
}
