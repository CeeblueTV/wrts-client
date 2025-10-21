/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ILog, Connect, Util, EventEmitter, ByteRate } from '@ceeblue/web-utils';
import { Source, SourceError } from './sources/Source';
import { ICMCD, CMCD, CMCDMode } from './media/CMCD';
import { BufferState, IPlaying } from './sources/IPlaying';
import * as Media from './media/Media';
import { Metadata } from './media/Metadata';
import { MediaPlayback, MediaPlaybackError } from './media/MediaPlayback';
import { HTTPAdaptiveSource } from './sources/HTTPAdaptiveSource';
import { DRMEngine, DRMEngineError } from './media/drm/DRMEngine';

const PAST_BUFFER = 20; // seconds
const BUFFER_LIMIT_LOW = 150; // ms
const BUFFER_LIMIT_HIGH = 550; // ms
const TIMEOUT = 14000; // at least superior to max gop duration (10s)

const root = typeof window !== 'undefined' ? window : global;

let _maximumResolution: Media.Resolution | undefined;
root.addEventListener('resize', () => (_maximumResolution = Media.screenResolution()));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ManagedMediaSource = (root as any).ManagedMediaSource;

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
     * Represents a {@link DRMEngineError} error
     */
    | DRMEngineError;

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
     * @param trackId
     * @param time
     * @param data
     * @event
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onData(trackId: number, time: number, data: any) {}

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
    onTrackChange(audioTrack: number, videoTrack: number) {
        this.log(Util.stringify({ audioTrack, videoTrack })).info();
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
        this.log(`Buffer change from ${oldState} to ${this.bufferState} (bufferAmount=${this.bufferAmount}ms)`).info();

        if (ManagedMediaSource) {
            // iPhone/iOS/Safari doesn't implement a smooth dynamic playbackRate change: during live it creates sound noise
            // So for now simply disable it for iPhone
            return;
        }
        const playbackRate = this._video.playbackRate;
        if (this.bufferState === BufferState.HIGH) {
            this._video.playbackRate = 1.08;
        } else if (this.bufferState === BufferState.LOW) {
            this._video.playbackRate = 0.92;
        } else {
            // OK or NONE
            this._video.playbackRate = 1;
        }
        if (playbackRate !== this._video.playbackRate) {
            this.log(`Adapt playback rate to ${this._video.playbackRate}`).info();
        }
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
     * Event fired when MediaKeys are ready if contentProtection is found in the metadata
     *
     * DRM support can be disabled by setting no contentProtection in the player parameters
     *
     * @param drmEngine The DRM engine instance
     * @event
     */
    onMediaKeysReady(drmEngine: DRMEngine) {}

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
        this._bufferLimitLow = value;
        // to fix bufferLimitHigh and update _bufferLimitMiddle
        this.bufferLimitHigh = Math.max(value, this._bufferLimitHigh);
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
     */
    set bufferLimitHigh(value: number) {
        this._bufferLimitHigh = value;
        this._bufferLimitLow = Math.min(value, this._bufferLimitLow);
        this._bufferLimitMiddle = Math.max(0, this._bufferLimitLow + Math.round((value - this._bufferLimitLow) / 2));
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
        return Math.ceil(this._playbackSpeed.exact()) / 100;
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
     * @override{@inheritDoc IPlaying.waitingInit}
     */
    get waitingInit(): boolean {
        return this._waitingInit;
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
        this._paused = value;
        if (this._paused) {
            this._video.pause();
        } else {
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
     * Source is CMAF and passthrough it to MSE, it's a debugging mode
     * activable when you set {@link Connect.Params.mediaExt} to 'cmaf'
     */
    get passthroughCMAF(): boolean | undefined {
        return this._source?.passthroughCMAF;
    }

    private _mediaSource?: MediaSource;
    private _source?: Source;
    private _video: HTMLVideoElement;
    private _playback?: MediaPlayback;
    private _metadata: Metadata;
    private _timeout?: { id: NodeJS.Timeout; value: number };
    private _bufferLimitLow: number;
    private _bufferLimitHigh: number;
    private _bufferLimitMiddle: number;
    private _bufferState: BufferState;
    private _controller: AbortController;
    private _buffering: boolean;
    private _maximumResolution?: Media.Resolution;
    private _paused: boolean;
    private _drmEngine?: DRMEngine;
    private _waitingInit: boolean = false;
    private _playbackSpeed: ByteRate;
    private _playbackPrevTime?: number;
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
        this._playbackSpeed = new ByteRate();
        this._bufferLimitMiddle = 0;
        this._bufferLimitLow = BUFFER_LIMIT_LOW;
        this.bufferLimitHigh = this._bufferLimitHigh = BUFFER_LIMIT_HIGH; // update _bufferLimitMiddle, see bufferLimitHigh setter
        // Set buffer as OK at the beginning when not playing to ignore congestion network algo
        this._bufferState = BufferState.NONE;
        this._controller = new AbortController();
    }

    /**
     * Moves the playback head as close as possible to the live point,
     * while respecting the configured {@link bufferLimitLow} and {@link bufferLimitHigh} buffer thresholds.
     * @param reason add a log reason to display to explain this goLive call
     */
    goLive(reason?: string) {
        // Go to the middle buffer position to avoid MBR change, and in a valid range superior or equals to startTime
        const prevCurrentTime = this._video.currentTime;
        const currentTime = (this._video.currentTime = Math.max(this.startTime, this.endTime - this._bufferLimitMiddle / 1000));
        reason = reason ? ' ' + reason.trim() : '';
        this.log(
            `goLive${reason} from ${prevCurrentTime.toFixed(3)}s to ${currentTime.toFixed(3)}s (${currentTime >= prevCurrentTime ? '+' : ''}${(currentTime - prevCurrentTime).toFixed(3)}s)`
        ).info();
    }

    /**
     * Starts playing the stream
     *
     * @param params Connection parameters {@link Connect.Params}
     * @param idleTimeout  idle timeout, default value is around 14s. It sets the timeout error in the absence of
     * connection activity or data fetching, you can tune it to implement your reliable and consistent fallback mechanism.
     * @example
     * player.start({
     *    endPoint: <endPoint>
     * });
     */
    start(params: Connect.Params, idleTimeout?: number) {
        this.stop();

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
            if (this._mediaSource) {
                this._mediaSource.onsourceopen = null; // just one time
            }

            // Connection timeout
            clearTimeout(this._timeout.id);
            this._timeout.id = setTimeout(
                () => this.stop({ type: 'PlayerError', name: 'Connection timeout' }),
                this._timeout.value
            );

            // Add a preload param to optimize starting-time
            params.query = new URLSearchParams(params.query);
            params.query.set('preload', this._bufferLimitMiddle.toFixed());

            const protocol = params.endPoint.substring(0, params.endPoint.indexOf('://'));
            this._source = new (this.SourceClass || Source.getClass(protocol) || HTTPAdaptiveSource)(this, params);
            this._source.log = this.log.bind(this, this._source?.name + ':') as ILog;
            this._source.onTrackChange = this._onTrackChange.bind(this);
            this._source.onMetadata = (metadata: Metadata) => {
                this._metadata = metadata;
                const tracks = this.onMetadata(metadata);

                // Start DRM MediaKeys if needed
                if (!this._drmEngine && metadata.contentProtection.size > 0) {
                    if (!params.contentProtection) {
                        this.log('Ignoring contentProtection because no DRMEngine parameters provided').info();
                    } else {
                        this.log('ContentProtection found, starting the DRMEngine...').info();
                        this._waitingInit = true; // waiting DRMEngine to be ready (MediaKeys to be attached)
                        this._drmEngine = new DRMEngine(this._video);
                        this._drmEngine.onError = error => {
                            this.stop(error);
                        };
                        this._drmEngine.log = this.log.bind(this, 'DRMEngine:') as ILog;
                        this._drmEngine
                            .start(metadata, params)
                            .then(() => {
                                if (this._drmEngine) {
                                    this._waitingInit = false; // DRMEngine is ready
                                    this.onMediaKeysReady(this._drmEngine);
                                }
                            })
                            .catch(error => {
                                this.stop(error);
                            });
                    }
                }

                return tracks;
            };
            this._source.onFinalizeRequest = (url: URL, headers: Headers) => {
                this.onFinalizeRequest(url, headers);
            };
            this._source.onSample = (trackId: number, sample: Media.Sample) => {
                if (!this._playback) {
                    this.stop({
                        type: 'PlayerError',
                        name: 'Playback error',
                        detail: 'Append sample before to have initialized media playback'
                    });
                    return;
                }
                if (trackId === this._source?.videoTrack) {
                    this._playback.appendVideo(this._metadata, trackId, sample);
                } else {
                    this._playback.appendAudio(this._metadata, trackId, sample);
                }
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._source.onData = (trackId: number, time: number, data: any) => this.onData(trackId, time, data);
            this._source.onClose = (error?: SourceError) => this.stop(error);

            this.onStart();
        };

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

        // Video events
        const onWaiting = () => {
            if (!this._timeout) {
                // stopped!
                return;
            }
            // fix possible hole on waiting
            this._playback?.flush(true);
            // onWaiting happens on each video.currentTime assignation, on other words on each seeking operation like goLive()
            // So check  buffer to be sure we are really waiting some data
            if (this.bufferAmount > this._bufferLimitLow) {
                return;
            }
            // STALL !
            /// start data timeout
            clearTimeout(this._timeout.id);
            this._timeout.id = setTimeout(() => this.stop({ type: 'PlayerError', name: 'Data timeout' }), this._timeout.value);
            // wait data
            this.log('buffering...').info();
            this._buffering = true;
            this._setBufferState(BufferState.LOW); // Force buffer to LOW
            this._video.pause();
            this.onStall();
            // W3C specification says that the player has been stopped to wait data
            // In such case few browsers "Pause" player when waiting data and so
            // require an explicit play => see _onProgress
        };
        const onCanPlay = () => {
            // stop timer "waiting data" when canPlay to support intentional pause,
            // /!\ Don't use onCanPlayThrough not called at all on Safari/iOS
            clearTimeout(this._timeout?.id);
            // try to play again after a waiting data!
            this._tryToPlay();
        };
        const onPlaying = () => {
            // stop timer "waiting data" when onPlaying
            clearTimeout(this._timeout?.id);
        };
        const onSeeking = () => {
            this._playbackPrevTime = undefined;
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
        const onTimeUpdate = this._onTimeUpdate.bind(this);

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
                    this._source.onData = Util.EMPTY_FUNCTION;
                    this._source.onMetadata = Util.EMPTY_FUNCTION;
                    this._source.onFinalizeRequest = Util.EMPTY_FUNCTION;
                    this._source.onSample = Util.EMPTY_FUNCTION;
                    this._source.onTrackChange = Util.EMPTY_FUNCTION;
                }

                // close media playback
                this._playback?.close();
            } catch (_) {}
            // detach video
            URL.revokeObjectURL(this._video.src);
            this._video.src = '';
        }

        if (this._drmEngine) {
            this._drmEngine.onError = Util.EMPTY_FUNCTION;
            this._drmEngine = undefined;
        }

        // Reset values
        this._buffering = false;
        this._paused = false;
        this._source = undefined;
        this._mediaSource = undefined;
        this._playback = undefined;
        this._metadata = new Metadata();
        this._playbackSpeed.clear();
        this._playbackPrevTime = undefined;
        // Set buffer as NONE at the beginning when not playing to ignore congestion network algo
        this._bufferState = BufferState.NONE;

        this.onStop(error);
    }

    private _setBufferState(state: BufferState) {
        const oldState = this._bufferState;
        if (oldState !== state) {
            this._bufferState = state;
            this.onBufferState(oldState);
        }
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
            // Now try with ManagedMediaSource =>
            this._video.disableRemotePlayback = true;
            this.log('new ManagedMediaSource').info();
            return new ManagedMediaSource();
        }
    }

    private _onTrackChange(audioTrack: number, videoTrack: number) {
        if (!this._playback) {
            return;
        }
        this._playback.audioEnabled = audioTrack >= 0;
        this._playback.videoEnabled = videoTrack >= 0;
        this.onTrackChange(audioTrack, videoTrack);
    }

    private async _tryToPlay() {
        try {
            if (!this._paused && !this._buffering && this._video.paused) {
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

    private _onPlaybackProgress() {
        if (!this._playback) {
            return;
        }
        // Fill hole if we are on the related playback position
        if (this._video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
            // fix hole!
            this._playback.flush(true);
        }

        if (this._buffering) {
            if (this.bufferAmount < this.bufferLimitMiddle) {
                // On start or after a stall => buffering until bufferLimitMiddle
                return;
            }
            this._buffering = false;
            // Already reset to OK, what is important on starting to not stay on NONE indefinitely
            // Not considerate the HIGH state, because can change after the goLive
            this._setBufferState(BufferState.OK);
            // Compute buffer amount manually without using this.bufferAmount to detect a big jump after
            // a timeline remove, indeed we cannot see this jump with this.bufferAmount since startTime becomes superior to currentTime
            if (this.currentTime && !this.reliable && (this.endTime - this.currentTime) * 1000 > this.bufferLimitHigh) {
                // Take advantage of this hole to repair direct!
                this.goLive('restoring');
            }
        }

        // fix currentPosition if inferior to startTime!
        if (this.currentTime < this.startTime) {
            this.goLive(this.currentTime ? 'repairing' : 'starting');
        }

        this._onTimeUpdate();
    }

    private _onTimeUpdate() {
        if (!this._playback || !this._source) {
            // 'timeupdate' event can happen BEFORE source ready, wait a real information coming from source
            // Fix a false high value for playbackSpeed
            return;
        }
        const currentTime = this.currentTime;
        if (this._playbackPrevTime != null) {
            this._playbackSpeed.addBytes((currentTime - this._playbackPrevTime) * 100);
        }
        this._playbackPrevTime = currentTime;

        if (this._bufferState === BufferState.NONE && this._buffering) {
            // Wait end of the first buffering before to update buffer state!
            return;
        }

        // Remove obsolete buffer if need
        if (currentTime > this._playback.startTime + PAST_BUFFER) {
            this._playback.startTime = currentTime - PAST_BUFFER;
        }

        // Playing progress => check buffering!
        const bufferAmount = this.bufferAmount;
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
            this._setBufferState(BufferState.LOW);
        }
    }
}
