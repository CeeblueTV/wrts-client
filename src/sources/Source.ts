/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import * as Media from '../media/Media';
import { CMCD, CMCDMode, ICMCD } from '../media/CMCD';
import { Metadata } from '../media/Metadata';
import { CMAFReader } from '../media/reader/CMAFReader';
import { RTSReader } from '../media/reader/RTSReader';
import { Reader, ReaderError } from '../media/reader/Reader';
import { IPlaying } from './IPlaying';
import { Connect, Util, EventEmitter, ByteRate, ILog, WebSocketReliableError } from '@ceeblue/web-utils';
import { Cmcd, CmcdObjectType, CmcdStreamType, toCmcdHeaders, encodeCmcd } from '@svta/common-media-library/cmcd';
import { MediaTrack } from '../media/MediaTrack';

const TIMESTAMP_HOLE_TOLERANCE = 7; // ms of timestamp acceptable

export type SourceError =
    /**
     * Represents an unexpected source issue
     */
    | { type: 'SourceError'; name: 'Unexpected source issue'; detail: string }
    /**
     * Represents a Request issue
     */
    | { type: 'SourceError'; name: 'Request error'; detail: string }
    /**
     * Represents a Malformed payload error
     */
    | { type: 'SourceError'; name: 'Malformed payload'; detail: string }
    /**
     * Represents a Stream Resource unavailable
     */
    | { type: 'SourceError'; name: 'Resource unavailable' }
    /**
     * Represents a {@link ReaderError} error
     */
    | ReaderError
    /**
     * Represents a {@link WebSocketReliableError} error
     */
    | WebSocketReliableError;

type SourceType = new (playing: IPlaying, params: Connect.Params) => Source;
const SourceClasses = new Map<string, SourceType>();
/**
 * Abstract Source class to implement a Media Source
 */
export abstract class Source extends EventEmitter implements ICMCD {
    /**
     * Retrieves the Source class {@link registerClass | registered} for the specified protocol.
     *
     * @param protocol The name of the protocol (e.g., 'wss', 'https', 'http').
     * @returns The registered Source class implementation for the protocol, or `undefined` if not found.
     */
    static getClass(protocol: string): SourceType | undefined {
        return SourceClasses.get(protocol.toLowerCase());
    }

    /**
     * Registers a Source class for one or multiple protocols, see {@link getClass} to retrieve the registered Source class.
     *
     * @param protocols One or more protocol names (e.g., 'wss', 'https', 'http'), at least one protocol is required.
     * @returns A decorator that registers the given Source class under the specified protocols.
     *
     * @example
     * *@Source.registerClass('wss', 'ws')*
     * export class MySource extends Source {
     *    constructor(playing: IPlaying, params: Connect.Params) {
     *       super(playing, 'wss', params);
     *    }
     * }
     */
    static registerClass(...protocols: [string, ...string[]]) {
        return function <Class extends SourceType>(SourceClass: Class, context?: unknown): Class {
            for (const protocol of protocols) {
                SourceClasses.set(protocol.toLowerCase(), SourceClass);
            }
            return SourceClass;
        };
    }

    /**
     * @event
     * Fire when source is closed
     *
     * @param error error description on an improper closure
     */
    onClose(error?: SourceError) {
        if (error) {
            this.log('onClose', error).error();
        } else {
            this.log('onClose').info();
        }
    }

    /**
     * @event
     * Fire on a track change
     *
     * @param audioTrack
     * @param videoTrack
     */
    onTrackChange(audioTrack: number, videoTrack: number) {}

    /**
     * Event fired when metadata is available in the stream.
     *
     * On the first occurrence, the optional return value allows specifying which track to use when starting the stream.
     * By default, the middle-quality track is selected.
     *
     * Note that this differs from using {@link videoTrack} or {@link audioTrack}, where a specific track is fixed,
     * which disables any Adaptive Bitrate algorithm.
     *
     * @param metadata The metadata received from the stream.
     * @returns Optional tracks to use for initializing the stream.
     * @event
     *
     * @example
     * // Set the initial video track to the highest quality; MBR will adjust it later based on network conditions.
     * player.onMetadata = (metadata) => ({ video: metadata.videoTracks[0].id });
     *
     * // Alternatively, disable MBR and lock the video track to the highest available quality.
     * player.onMetadata = (metadata) => player.videoTrack = metadata.videoTracks[0].id;
     */
    onMetadata(metadata: Metadata): Media.Tracks | void {}

    /**
     * @event
     * Fire on new audio or video {@link Media.Sample}
     *
     * @param trackId
     * @param sample
     *
     */
    onSample(trackId: number, sample: Media.Sample) {}

    /**
     * @event
     * Fire when data is received in the stream.
     *
     * @param trackId
     * @param time
     * @param data
     * @event
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onData(trackId: number, time: number, data: any) {}

    /**
     * @event
     * Fired when the URL and headers can be finalized before sending the request to the server.
     *
     * @param url     the request URL to finalize or modify if needed
     * @param headers the request headers to adjust if needed
     */
    onFinalizeRequest(url: URL, headers: Headers) {}

    get name(): string {
        return this._name;
    }

    /**
     * True when source is closed
     */
    get closed(): boolean {
        return this._closed;
    }
    /**
     * Stream name, for example `as+bc3f535f-37f3-458b-8171-b4c5e77a6137`
     */
    get streamName(): string {
        return this._streamName;
    }

    get url(): string {
        return this._url.toString();
    }

    get metadata(): Metadata | undefined {
        return this._metadata;
    }

    get audioTime(): number {
        return this._audioTime;
    }

    get videoTime(): number {
        return this._videoTime;
    }

    get dataTime(): number {
        return this._dataTime;
    }

    get currentTime(): number {
        return Math.max(this._audioTime, this._videoTime, this._dataTime);
    }

    /**
     * Index of the effective video track, can be undefined on start and -1 means track disabled
     */
    get videoTrack(): number | undefined {
        return this._tracks.video;
    }

    /**
     * Index of the manual video selection, undefined indicates automatic mode and -1 disable manually the track
     */
    get videoSelected(): number | undefined {
        return this._selectedTracks.video;
    }

    /**
     * Selects a video track based on the provided index, or enables automatic selection if set to `undefined`.
     *
     * @remarks Manually setting a track disables any Adaptive Bitrate algorithm.
     */
    set videoTrack(idx: number | undefined) {
        this._selectTracks({ video: idx, audio: this._selectedTracks.audio });
    }

    /**
     * Index of the effective audio track, can be undefined on start and -1 means track disabled
     */
    get audioTrack(): number | undefined {
        return this._tracks.audio;
    }

    /**
     * Index of the manual audio selection, undefined indicates automatic mode and -1 disable manually the track
     */
    get audioSelected(): number | undefined {
        return this._selectedTracks.audio;
    }

    /**
     * Select a audio track to the index provided, or indicates automatic with undefined
     */
    set audioTrack(idx: number | undefined) {
        this._selectTracks({ audio: idx, video: this._selectedTracks.video });
    }

    /**
     * Returns true if manual track selection is supported by the source implementation
     */
    get trackSelectable(): boolean {
        return this._setTracks !== Source.prototype._setTracks;
    }

    get recvByteRate(): ByteRate {
        return this._recvByteRate;
    }

    get reliable(): boolean {
        return this._reliable;
    }
    set reliable(value: boolean) {
        this._setReliable(value);
    }

    get mediaExt(): string {
        return this._mediaExt;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcd}
     */
    get cmcd(): CMCD {
        return CMCD.NONE;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcd}
     */
    set cmcd(value: CMCD | undefined) {
        throw new Error(this.name + " doesn't support CMCD");
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdMode}
     */
    get cmcdMode(): CMCDMode {
        return this._cmcdMode ?? CMCDMode.HEADER;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdMode}
     */
    set cmcdMode(value: CMCDMode | undefined) {
        this._cmcdMode = value;
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdSid}
     */
    get cmcdSid(): string {
        return this._cmcdSid ?? '';
    }

    /**
     * @override
     * {@inheritDoc ICMCD.cmcdSid}
     */
    set cmcdSid(value: string | undefined) {
        this._cmcdSid = value;
    }

    /**
     * Get the number of audio frame per second currently decoding
     */
    get audioPerSecond(): number {
        return this._audioPerSecond.exact();
    }

    /**
     * Get the number of video sample per second currently decoding
     */
    get videoPerSecond(): number {
        return this._videoPerSecond.exact();
    }

    private _reliable: boolean;
    private _name: string;
    private _url: URL;
    private _streamName: string;
    private _metadata?: Metadata;
    private _closed: boolean;
    private _tracks: Media.Tracks; // effective tracks
    private _selectedTracks: Media.Tracks; // tracks selected by the user
    private _requestedTracks: Media.Tracks; // tracks requested
    private _firstSamples?: Media.Samples;
    private _audioTime: number;
    private _videoTime: number;
    private _dataTime: number;
    private _playing: IPlaying;
    private _mediaExt: string;
    private _recvByteRate: ByteRate;
    private _running: boolean;
    private _cmcdMode?: CMCDMode;
    private _cmcdSid?: string;
    private _lastStalls: number; // last stalls count sent to CMCD
    private _trackRequest?: NodeJS.Timeout;
    private _fixLiveTime: number;
    private _audioPerSecond: ByteRate;
    private _videoPerSecond: ByteRate;

    /**
     * Create a new Source, to be passed to a Player
     */
    constructor(playing: IPlaying, protocol: string, params: Connect.Params, type: Connect.Type = Connect.Type.WRTS) {
        super();
        // (params.query = new URLSearchParams(params.query)).set('audio', 'none');
        this._url = Connect.buildURL(type, params, protocol);
        this._mediaExt = params.mediaExt || ''; // aftet buildURL call to get mediaExt possible correction
        this._streamName = params.streamName || '';
        this._running = false;
        this._lastStalls = 0;
        this._audioPerSecond = new ByteRate(Media.MAX_GOP_DURATION); // Average over GOP
        this._videoPerSecond = new ByteRate(Media.MAX_GOP_DURATION); // Average over GOP
        if (type === Connect.Type.WRTS) {
            // WRTS
            this._name = (this._url.protocol.toLowerCase().slice(0, -1) + '-' + this._mediaExt).toLowerCase();
        } else {
            // OTHER
            this._name = type;
        }
        this._recvByteRate = new ByteRate(Media.MAX_GOP_DURATION); // Average over GOP
        this._closed = false;
        this._audioTime = -1;
        this._videoTime = -1;
        this._dataTime = -1;
        this._tracks = {};
        this._reliable = false; // false by default!
        this._selectedTracks = {};
        this._requestedTracks = {};
        this._firstSamples = new Media.Samples();
        this._playing = playing;
        this._fixLiveTime = 0;
        playing.on('Stall', () => ++this._lastStalls, playing);

        Promise.resolve().then(() => this._run());
    }

    close(error?: SourceError) {
        if (this._closed) {
            // already closed
            return;
        }
        this._closed = true;
        clearTimeout(this._trackRequest);
        if (error && error.type === 'SourceError' && error.name === 'Request error') {
            // morph a possible request error to a stream
            const detail = error.detail.toLowerCase();
            if (detail.startsWith('stream open failed') || detail.startsWith('404')) {
                error = { type: 'SourceError', name: 'Resource unavailable' };
            }
        }
        this._selectedTracks = {};
        this._tracks = {};
        this._firstSamples = undefined;
        this._lastStalls = 0;
        this.onClose(error);
    }

    /**
     * Prepares a request, exposing the user-interception {@link onFinalizeRequest} to modify it if needed.
     * @param url URL to adjust if need
     * @param headers HTTP headers to tweak as desired
     * @returns the finalized URL
     */
    protected finalizeRequest(url: URL, headers: Headers): URL {
        // Clone the URL so the original stays intact from any modifications
        url = new URL(url);
        // Call the user event
        this.onFinalizeRequest(url, headers);
        return url;
    }

    protected readMetadata(metadata: Metadata) {
        if (this.closed) {
            return;
        }
        // fix metadata
        (this._metadata = metadata).fix();

        // Call onMetadata (user can possibly change metadata at this level)
        const initTracks = this.onMetadata(metadata);
        // Check if onMetadata has closed the source!
        if (this.closed) {
            return;
        }

        // tracks inits?
        let init = false;
        if (this._requestedTracks.audio == null) {
            init = true;
            this._requestedTracks.audio = initTracks?.audio ?? this._autoFirstTrack(metadata.audioTracks);
            if (this._requestedTracks.audio < 0) {
                this._updateTrack('audio', -1);
            }
        }
        if (this._requestedTracks.video == null) {
            init = true;
            this._requestedTracks.video = initTracks?.video ?? this._autoFirstTrack(metadata.videoTracks);
            if (this._requestedTracks.video < 0) {
                this._updateTrack('video', -1);
            }
        }
        if (init) {
            this.log(`Init tracks ${Util.stringify(this._requestedTracks)}`).info();
        }

        // Check tracks available after onMetadata to allow an user change into onMetadata
        if (!metadata.tracks.size) {
            this.log(`No tracks available for ${this._url.toString()}`).error();
        }
    }

    /**
     * Ingest audio sample for trackId, if sample is undefined it only changes the tracks
     * @param trackId
     * @param sample
     */
    protected readAudio(trackId: number, sample?: Media.Sample) {
        // this.log("AUDIO", trackId, sample ? Util.stringify(sample, {noBin:true}) : "").info();
        if (sample) {
            this._audioPerSecond.addBytes(1);
            if (trackId < 0) {
                sample = undefined;
                this.log(`Disabled audio track ${trackId} cannot receive sample`).error();
            } else {
                // Fix timestamp
                this._audioTime = this.fixTimestamp(Media.Type.AUDIO, trackId, this._audioTime, sample);
            }
        }
        this._onSample(this._updateTrack('audio', trackId), sample);
    }

    /**
     * Ingest video sample for trackId, if sample is undefined it only changes the tracks
     * If sample.duration is negative, it will extend the sample until the currentTime to repair synchronization
     * @param trackId
     * @param sample
     */
    protected readVideo(trackId: number, sample?: Media.Sample) {
        // this.log("VIDEO", trackId, sample ? Util.stringify(sample, { noBin: true }) : "").info();
        if (sample) {
            if (trackId < 0) {
                sample = undefined;
                this.log(`Disabled video track ${trackId} cannot receive sample`).error();
            } else {
                this._videoPerSecond.addBytes(1);

                // Assign extendable duration and fix sample.duration
                let extendableDuration;
                if (sample.duration < 0) {
                    sample.duration = extendableDuration = -sample.duration;
                }

                // Fix timestamp
                this._videoTime = this.fixTimestamp(Media.Type.VIDEO, trackId, this._videoTime, sample);

                // Extends time to fix sync if need
                const delay = this.currentTime - this._videoTime;
                if (extendableDuration && delay > 0) {
                    sample.duration += delay;
                    this._videoTime = this.currentTime;
                    this.log(
                        `Extends video duration from ${sample.duration - delay} to ${sample.duration}ms track ${trackId}`
                    ).warn();
                    this._playing.onVideoSkipping(delay);
                }

                if (sample.isKeyFrame) {
                    // compute an average on each GOP
                    this._recvByteRate.clip();
                    this._videoPerSecond.clip();
                    this._audioPerSecond.clip();
                }
            }
        }

        this._onSample(this._updateTrack('video', trackId), sample);
    }

    /**
     * Ingest timed data sample for trackId
     * @param trackId
     * @param time
     * @param data
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected readData(trackId: number, time: number, data: any) {
        // this.log("DATA", trackId, Util.stringify({time, data}, {noBin:true})).info();
        // No bufferize on start in firstSamples for data, delivers the data immediately
        if (!this._closed) {
            const sample = { time };
            this._dataTime = this.fixTimestamp(Media.Type.DATA, trackId, this._dataTime, sample);
            this.onData(trackId, sample.time, data);
        }
    }

    protected fixTimestamp(
        type: Media.Type,
        trackId: number,
        currentTime: number,
        sample: { time: number; duration?: number }
    ): number {
        // Fix current time to be continuous and always increasing
        const delta = currentTime >= 0 ? sample.time - currentTime : 0;
        if (delta) {
            if (type === Media.Type.DATA ? delta < 0 : type !== Media.Type.AUDIO || delta < TIMESTAMP_HOLE_TOLERANCE) {
                // Data: Fix only data when overlaps
                // Audio: Don't fill a audio hole to skip it on playing, but fix if crossed or minor hole
                // Video: Never skip a frame to keep decoding reliable!
                // Keep minimum duration superior to 0 otherwise decoding can ignore this frame on iPad/iPhone and break decoding (artefact)
                const newDuration = sample.duration != null ? Math.max(1, sample.duration + delta) : 0;
                if (Math.abs(delta) > TIMESTAMP_HOLE_TOLERANCE) {
                    // to limit log frequency for small correction (can happen sometime on timescale mistake)
                    let log = `Timestamp fix ${sample.time / 1000}s to ${currentTime / 1000}s on ${type === Media.Type.AUDIO ? 'audio' : 'video'} track ${trackId}`;
                    if (sample.duration != null) {
                        log += ` (duration: ${Math.abs(sample.duration)} => ${newDuration}ms)`;
                    }
                    this.log(log)[delta < 0 ? 'warn' : 'info']();
                }
                sample.time = currentTime;
                if (newDuration) {
                    sample.duration = newDuration; // increase/decrease duration to keep the same next time as the input
                }
            }
        }

        // audio/video skipping AFTER timestamp fix (to get an ordered log information)
        if (delta > 0) {
            if (type === Media.Type.AUDIO) {
                this._playing.onAudioSkipping(delta);
            } else if (type === Media.Type.VIDEO) {
                this._playing.onVideoSkipping(delta);
            }
        }

        currentTime = sample.time + (sample.duration ?? 0);
        // Fix liveTime if need
        if (this._metadata) {
            const fixLiveTime = currentTime - this._metadata.liveTime;
            if (fixLiveTime > 0) {
                this._fixLiveTime += fixLiveTime;
                this._metadata.liveTime += fixLiveTime;
            } else if (this._fixLiveTime) {
                this.log(`Fix Metadata.liveTime +${this._fixLiveTime}ms`)[this._fixLiveTime > 5 ? 'warn' : 'info']();
                this._fixLiveTime = 0;
            }
        }
        return currentTime;
    }

    protected _onSample(trackId: number, sample?: Media.Sample) {
        if (this.closed) {
            return;
        }

        if (this._firstSamples) {
            // We are waiting first samples !
            if (sample) {
                this._firstSamples.push(trackId, sample);
            }

            if (this.audioTrack == null || this.videoTrack == null) {
                // wait explicit tracks set (can become -1 if disabled)
                return;
            }

            /// flush
            this.log(
                `Flush ${this._firstSamples.duration}ms of firstSamples tracks [${this._firstSamples.tracks}] to sync ${Util.stringify(this._tracks)} (${this._firstSamples.startTime / 1000}s to ${this._firstSamples.endTime / 1000}s)`
            ).info();

            for (const [trackId, firstSamples] of this._firstSamples) {
                if (trackId !== this.audioTrack && trackId !== this.videoTrack) {
                    this.log(`Useless first samples track ${trackId} to play tracks ${Util.stringify(this._tracks)}`).warn();
                    continue;
                }
                for (const firstSample of firstSamples) {
                    this.onSample(trackId, firstSample);
                    if (this.closed) {
                        return;
                    }
                }
            }
            this._firstSamples = undefined;
        } else if (sample) {
            this.onSample(trackId, sample);
        }
    }

    /**
     * Returns -1 if no track, otherwise returns the id of the middle rendition compatible with the device screen
     * @param tracks
     * @returns
     */
    protected _autoFirstTrack(tracks: Array<MediaTrack>): number {
        let track = tracks[Math.floor(tracks.length / 2)];
        if (!track) {
            return -1;
        }
        while (Media.overScreenSize(track.resolution, this._playing.maximumResolution) && track.down) {
            track = track.down;
        }
        return track.id;
    }

    /**
     * Select the audio and video track to play
     *
     * @param tracks tracks to select, undefined mean "auto" selection
     */
    protected _selectTracks(tracks: Media.Tracks) {
        if (this._closed) {
            return;
        }
        if (this._selectedTracks.audio === tracks.audio && this._selectedTracks.video === tracks.video) {
            // No change
            return;
        }
        this._selectedTracks = tracks;

        if (!this._running) {
            // otherwise no need, will be initialized on this track!
            return;
        }

        // Set current requestedTracks immediately
        if (tracks.video) {
            this._requestedTracks.video = tracks.video;
        }
        if (tracks.audio) {
            this._requestedTracks.audio = tracks.audio;
        }

        // Call in async to get sync with multiple track assignation!
        if (this._trackRequest != null) {
            return;
        }

        this._trackRequest = setTimeout(async () => {
            this._trackRequest = undefined;
            if (this.closed) {
                return;
            }
            try {
                this.log(`Select tracks ${Util.stringify(this._selectedTracks)}`).info();
                await this._setTracks({ ...this._selectedTracks });
                // After a track deactivation we don't receive any more data on this track
                // so we have to disable the track now
                if (this._requestedTracks.audio && this._requestedTracks.audio < 0) {
                    this.readAudio(-1);
                }
                if (this._requestedTracks.video && this._requestedTracks.video < 0) {
                    this.readVideo(-1);
                }
            } catch (e: unknown) {
                this.close({ type: 'SourceError', name: 'Unexpected source issue', detail: Util.stringify(e) });
            }
        }, 0);
    }

    /**
     * Create a Reader usable to feed the Source and matching mediaExt
     * Can throw an exception if no demuxer is found for the related media extension
     * @param params
     * @returns
     */
    protected _newReader(params = { isStream: true }): Reader {
        // default behavior is to select the correct reader related with the file extension in the url
        let reader: Reader;
        switch (this._mediaExt) {
            case 'rts':
                reader = new RTSReader({ withSize: params.isStream });
                break;
            case 'mp4':
                reader = new CMAFReader(this._playing.passthroughCMAF);
                break;
            default:
                throw Error('No demuxer found for ' + this._url.pathname);
        }
        reader.onAudio = (trackId: number, sample: Media.Sample) => this.readAudio(trackId, sample);
        reader.onVideo = (trackId: number, sample: Media.Sample) => this.readVideo(trackId, sample);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reader.onData = (trackId: number, time: number, data: any) => this.readData(trackId, time, data);
        reader.onMetadata = (metadata: Metadata) => this.readMetadata(metadata);
        reader.onError = (error: ReaderError) => this.close(error);
        reader.log = this.log.bind(this) as ILog;
        reader.read = (data: BufferSource | string) => {
            if (!this._closed) {
                this._recvByteRate.addBytes(typeof data == 'string' ? data.length : data.byteLength);
                Object.getPrototypeOf(reader).read.call(reader, data);
            }
        };
        return reader;
    }

    private async _run() {
        if (this.closed) {
            return;
        }
        this.log(`Plays ${this._url}`).info();
        try {
            this._running = true;
            // Keep 'await' to wait an error
            // The implementation can choose indifferently one strategy:
            // - non blocking and return immediately
            // - blocking and stays processing during all the life-time
            this._requestedTracks = { ...this._selectedTracks };
            await this._play(this._url, this._requestedTracks, this._playing);
        } catch (e: unknown) {
            this.close({ type: 'SourceError', name: 'Unexpected source issue', detail: Util.stringify(e) });
        }
    }

    private _updateTrack(type: 'audio' | 'video', track: number): number {
        if (!this.closed && this._tracks[type] !== track) {
            this._tracks[type] = track;
            if (track === -1) {
                this.log(`Track ${type} ${track} disabled`).info();
            }
            if (this._tracks.audio != null && this._tracks.video != null) {
                // Ready to play!
                this.onTrackChange(this._tracks.audio, this._tracks.video);
            }
        }

        return track;
    }

    protected async _setReliable(reliable: boolean) {
        if (reliable === this._reliable) {
            return;
        }
        try {
            if (this._running) {
                await this._setReliability(reliable);
            } // else wait running!
            this._reliable = reliable;
        } catch (e: unknown) {
            this.log(Util.stringify(e)).error();
        }
    }

    /**
     * Fetch a media object with CMCD if enabled
     *
     * @param url full URL of the media object
     */
    protected async fetchMedia(url: URL, type: Media.Type, options: RequestInit = {}): Promise<Response & { error?: string }> {
        const withCMCD = this.cmcd !== CMCD.NONE;
        if (withCMCD) {
            // Add CMCD headers
            const trackId = type === Media.Type.AUDIO ? this.audioTrack : type === Media.Type.VIDEO ? this.videoTrack : -1;
            const bandwidth = (trackId && trackId >= 0 && this.metadata?.tracks.get(trackId)?.bandwidth) || 0;
            // Basic CMCD
            const cmcd = {
                br: bandwidth,
                bl: this._playing.bufferAmount, // NOTE: CMCD says it MUST be rounded to the nearest 100ms
                bs: this._lastStalls > 0,
                mtp: this._playing.recvByteRate,
                pr: this._playing.playbackRate,
                sf: 'o', // there is no way to say it's WebRTS)
                sid: this.cmcdSid,
                su: this._playing.bufferAmount === 0
            } as Cmcd;
            // Full CMCD
            if (this.cmcd === CMCD.FULL) {
                cmcd.cid = url.pathname.split('/').pop();
                cmcd.dl = this._playing.bufferAmount * this._playing.playbackRate;
                cmcd.ot =
                    type === Media.Type.AUDIO
                        ? CmcdObjectType.AUDIO
                        : type === Media.Type.VIDEO
                          ? CmcdObjectType.VIDEO
                          : CmcdObjectType.OTHER;
                cmcd.st = CmcdStreamType.LIVE;
                cmcd.v = 1;
            }

            // Mode
            if (this.cmcdMode === CMCDMode.QUERY) {
                url.searchParams.set('cmcd', encodeCmcd(cmcd));
            } else {
                options.headers = toCmcdHeaders(cmcd);
            }
        }

        const response = await this.fetch(url, options);
        if (response.ok && withCMCD) {
            // Update last stalls count only if the request was successful
            this._lastStalls = 0;
        }
        return response;
    }

    /**
     * Fetches a resource in a compliant way by invoking {@link finalizeRequest} during preparation.
     * @param url the URL to fetch
     * @param init optional fetch configuration
     * @returns the fetched response
     */
    protected async fetch(url: URL, init?: RequestInit): Promise<Response & { error?: string }> {
        if (!init) {
            init = {};
        }
        if (!(init.headers instanceof Headers)) {
            init.headers = new Headers(init.headers);
        }
        return Util.fetch(this.finalizeRequest(url, init.headers), init);
    }

    /**
     * Fetches a resource and measures the RTT (round-trip time) in a compliant way
     * by invoking {@link finalizeRequest} during preparation.
     * @param url the URL to fetch
     * @param init optional fetch configuration
     * @returns the fetched response (including RTT metadata)
     */
    protected async fetchWithRTT(url: URL, init?: RequestInit): Promise<Response & { rtt: number; error?: string }> {
        if (!init) {
            init = {};
        }
        if (!(init.headers instanceof Headers)) {
            init.headers = new Headers(init.headers);
        }
        return Util.fetchWithRTT(this.finalizeRequest(url, init.headers), init);
    }

    /// TO OVERLOADS ///
    /**
     * Implements _play to create a playback source, in a sequential or async way.
     * @param url
     * @param tracks
     * @param playing
     */
    protected abstract _play(url: URL, tracks: Media.Tracks, playing: IPlaying): void;
    protected abstract _setReliability(reliable: boolean): void;
    protected abstract _setTracks(tracks: Media.Tracks): void;
}
