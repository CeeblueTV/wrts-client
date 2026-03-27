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
import { RTSReaderOld } from '../media/reader/RTSReaderOld';
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
     * @param dataTrack
     */
    onTrackChange(audioTrack: number, videoTrack: number, dataTrack: Set<number>) {}

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
     * Fire any new audio sample {@link Media.Sample}
     *
     * @param trackId
     * @param sample
     *
     */
    onAudio(trackId: number, sample: Media.Sample) {}

    /**
     * @event
     * Fire any new video sample {@link Media.Sample}
     *
     * @param trackId
     * @param sample
     *
     */
    onVideo(trackId: number, sample: Media.Sample) {}

    /**
     * @event
     * Fire any new data sample {@link Media.Sample}
     *
     * @param trackId
     * @param sample
     *
     */
    onData(trackId: number, sample: Media.Sample) {}

    /**
     * Event fired on a generic message
     * @param name
     * @param data
     * @event
     */
    onMessage(name: string, time: number, duration: number, data: Uint8Array) {}

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
        this._selectTracks({
            audio: this._selectedTracks.audio,
            video: idx,
            data: this._selectedTracks.data
        });
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
        this._selectTracks({
            audio: idx,
            video: this._selectedTracks.video,
            data: this._selectedTracks.data
        });
    }

    /**
     * Index of the data track being received, can be undefined on start
     */
    get dataTrack(): Set<number> | undefined {
        return this._tracks.data;
    }

    /**
     * Index of the manual data selection, undefined indicates all tracks
     */
    get dataSelected(): Set<number> | undefined {
        return this._selectedTracks.data;
    }

    /**
     * Select a or multiple data track to the index provided.
     * When set to `undefined` it selects all data tracks available.
     */
    set dataTrack(idx: number | Array<number> | Set<number> | undefined) {
        if (typeof idx === 'number') {
            idx = [idx];
        }
        this._selectTracks({
            audio: this._selectedTracks.audio,
            video: this._selectedTracks.video,
            data: idx ? new Set(idx) : undefined
        });
    }

    /**
     * Returns true if manual track selection is supported by the source implementation
     */
    get trackSelectable(): boolean {
        return this.setTracks !== Source.prototype.setTracks;
    }

    get recvByteRate(): ByteRate {
        return this._recvByteRate;
    }

    get reliable(): boolean {
        return this._reliable;
    }
    set reliable(value: boolean) {
        this.setReliable(value);
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
        if (value != null) {
            throw new Error(this.name + " doesn't support CMCD");
        }
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
    private _ignoredTracks: Set<number> = new Set();

    /**
     * Create a new Source, to be passed to a Player
     */
    constructor(playing: IPlaying, protocol: string, params: Connect.Params, type: Connect.Type = Connect.Type.WRTS) {
        super();
        // (params.query = new URLSearchParams(params.query)).set('audio', 'none');
        // (params.query = new URLSearchParams(params.query)).set('video', 'none');
        // (params.query = new URLSearchParams(params.query)).set('data', 'none');
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
        if (error && error.type === 'SourceError' && 'detail' in error) {
            // WIP MF fix = >morph a possible request error to a stream unavailable
            // Could be fixed in server side, but it impacts a  lot of code.
            const detail = error.detail.toLowerCase();
            if (detail.startsWith('stream open failed') || detail.startsWith('404')) {
                error = { type: 'SourceError', name: 'Resource unavailable' };
            }
        }
        this._selectedTracks = {};
        this._tracks = {};
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

    /**
     * Init tracks to play
     *
     * Should be called in first to announce track to receive
     * If tracks.audio or tracks.video is null, it means no video or audio track
     * If tracks.data is null, it means no specific data track so all can be received
     * Otherwise reception must be limited to the tracks.data indexes
     *
     * @param tracks
     */
    /**
     * Initializes the tracks to be received.
     *
     * This method must be called first to declare which tracks should be negotiated and received.
     *
     * Audio / Video:
     *  - undefined or -1 → Track disabled
     *  - >= 0      → Receive the specified track index.
     *
     * Data:
     *  - undefined → Receive all data tracks.
     *  - Set<number> → Receive only the specified data track indexes.
     *
     * @param tracks Track selection configuration.
     */
    protected initTracks(tracks: Media.Tracks) {
        if (this.closed) {
            return;
        }
        if (!this.metadata) {
            this.log(`${this.constructor.name} hasn't fill metadata before to call initTracks`);
        }
        // reset ignoredTrack on each initTracks
        this._ignoredTracks = new Set();
        // convert null to -1
        if (tracks.audio == null) {
            tracks.audio = -1;
        }
        if (tracks.video == null) {
            tracks.video = -1;
        }
        if (tracks.data == null) {
            tracks.data = new Set();
            // get all metadata data tracks!
            for (const dataTrack of this.metadata?.dataTracks ?? []) {
                tracks.data.add(dataTrack.id);
            }
        }
        // see if there is a change
        if (
            this._tracks.audio === tracks.audio &&
            this._tracks.video === tracks.video &&
            Util.equal(tracks.data, this._tracks.data)
        ) {
            return;
        }
        // set the change
        this._tracks = { ...tracks };
        // displays tracks disabled
        if (tracks.audio < 0) {
            this.log(`Track audio disabled`).info();
        }
        if (tracks.video < 0) {
            this.log(`Track video disabled`).info();
        }
        // inform user
        this.onTrackChange(tracks.audio, tracks.video, tracks.data);
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
        }
        if (this._requestedTracks.video == null) {
            init = true;
            this._requestedTracks.video = initTracks?.video ?? this._autoFirstTrack(metadata.videoTracks);
        }
        if (this._requestedTracks.data == null) {
            init = true;
            if (initTracks?.data == null) {
                this._requestedTracks.data = new Set();
                for (const dataTrack of metadata.dataTracks) {
                    this._requestedTracks.data.add(dataTrack.id);
                }
            } else {
                this._requestedTracks.data = new Set(initTracks.data);
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
    protected readAudio(trackId: number, sample: Media.Sample) {
        if (this._closed) {
            return;
        }
        // this.log("AUDIO", trackId, Util.stringify(sample, {noBin:true})).info();
        if (trackId !== this.audioTrack) {
            const count = this._ignoredTracks.size;
            if (this._ignoredTracks.add(trackId).size > count) {
                this.log('Audio track ' + trackId + ' unannounced before').error();
            }
            return;
        }
        this._audioPerSecond.addBytes(1);
        // Fix timestamp
        this._audioTime = this.fixTimestamp(Media.Type.AUDIO, trackId, this._audioTime, sample);
        this.onAudio(trackId, sample);
    }

    /**
     * Ingest video sample for trackId, if sample is undefined it only changes the tracks
     * If sample.duration is negative, it will extend the sample until the currentTime to repair synchronization
     * @param trackId
     * @param sample
     */
    protected readVideo(trackId: number, sample: Media.Sample) {
        if (this._closed) {
            return;
        }
        // this.log("VIDEO", trackId, Util.stringify(sample, { noBin: true })).info();
        if (trackId !== this.videoTrack) {
            const count = this._ignoredTracks.size;
            if (this._ignoredTracks.add(trackId).size > count) {
                this.log('Video track ' + trackId + ' unannounced before').error();
            }
            return;
        }
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
            this.log(`Extends video duration from ${sample.duration - delay} to ${sample.duration}ms track ${trackId}`).warn();
            this._playing.onVideoSkipping(delay);
        }

        if (sample.isKeyFrame) {
            // compute an average on each GOP
            this._recvByteRate.clip();
            this._videoPerSecond.clip();
            this._audioPerSecond.clip();
        }

        this.onVideo(trackId, sample);
    }

    /**
     * Ingest timed data sample for trackId
     * @param trackId
     * @param time
     * @param data
     */
    protected readData(trackId: number, sample: Media.Sample) {
        if (this._closed) {
            return;
        }
        // this.log("DATA", trackId, Util.stringify(sample)).info();
        if (this.dataTrack == null || !this.dataTrack.has(trackId)) {
            const count = this._ignoredTracks.size;
            if (this._ignoredTracks.add(trackId).size > count) {
                this.log('Video track ' + trackId + ' unannounced before').error();
            }
            return;
        }
        // No bufferize on start in firstSamples for data, delivers the data immediately
        this._dataTime = this.fixTimestamp(Media.Type.DATA, trackId, this._dataTime, sample);
        this.onData(trackId, sample);
    }

    /**
     * Ingest generic message
     * @param name
     * @param sample
     */
    protected readMessage(name: string, time: number, duration: number, data: Uint8Array) {
        if (!this._closed) {
            this.onMessage(name, time, duration, data);
        }
    }

    /**
     * Utility dispatcher that forwards a media sample to the appropriate
     * reader (readAudio, readVideo, or readData) based on its type.
     *
     * This is a convenience method — callers may invoke readAudio,
     * readVideo, or readData directly if the media type is already known.
     *
     * @param type    Media type (AUDIO, VIDEO, DATA)
     * @param trackId Track identifier
     * @param sample  Media sample to process
     */
    protected readSample(type: Media.Type, trackId: number, sample: Media.Sample) {
        switch (type) {
            case Media.Type.AUDIO:
                this.readAudio(trackId, sample);
                break;
            case Media.Type.VIDEO:
                this.readVideo(trackId, sample);
                break;
            case Media.Type.DATA:
                this.readData(trackId, sample);
                break;
            default:
                this.log('Media type ' + type + ' unknown').error();
        }
    }

    protected fixTimestamp(type: Media.Type, trackId: number, currentTime: number, sample: Media.Sample): number {
        // Fix current time to be continuous and always increasing
        const delta = currentTime >= 0 ? sample.time - currentTime : 0;
        if (delta) {
            if (type === Media.Type.DATA ? delta < 0 : type !== Media.Type.AUDIO || delta < TIMESTAMP_HOLE_TOLERANCE) {
                // Data: Fix only data when overlaps
                // Audio: Don't fill a audio hole to skip it on playing, but fix if crossed or minor hole
                // Video: Never skip a frame to keep decoding reliable!
                // Keep minimum duration superior to 0 otherwise decoding can ignore this frame on iPad/iPhone and break decoding (artefact)
                const newDuration = Math.max(1, sample.duration + delta);
                if (Math.abs(delta) > TIMESTAMP_HOLE_TOLERANCE) {
                    // to limit log frequency for small correction (can happen sometime on timescale mistake)
                    let log = `Timestamp fix ${sample.time / 1000}s to ${currentTime / 1000}s on ${Media.typeToString(type)} track ${trackId}`;
                    log += ` (duration: ${Math.abs(sample.duration)} => ${newDuration}ms)`;
                    this.log(log)[delta < 0 ? 'warn' : 'info']();
                }
                sample.time = currentTime;
                sample.duration = newDuration; // increase/decrease duration to keep the same next time as the input
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

        currentTime = sample.time + sample.duration;
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

    /**
     * Create a Reader usable to feed the Source and matching mediaExt
     * Can throw an exception if no demuxer is found for the related media extension
     * @param params
     * @returns
     */
    protected newReader(params = { isStream: true }): Reader {
        // default behavior is to select the correct reader related with the file extension in the url
        let reader: Reader;
        switch (this._mediaExt) {
            case 'rts': {
                // WIP remove old version when there is no more old nodes
                const protocolVersion = this.metadata?.protocolVersion;
                if (protocolVersion && protocolVersion.major <= 1) {
                    reader = new RTSReaderOld({ withSize: params.isStream });
                } else {
                    reader = new RTSReader({ withSize: params.isStream });
                }
                break;
            }
            case 'mp4':
                reader = new CMAFReader(this._playing.passthroughCMAF);
                break;
            default:
                throw Error('No demuxer found for ' + this._url.pathname);
        }
        reader.onSample = (type: Media.Type, trackId: number, sample: Media.Sample) => {
            this.readSample(type, trackId, sample);
        };
        reader.onMessage = (name: string, time: number, duration: number, data: Uint8Array) => {
            this.readMessage(name, time, duration, data);
        };
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

    /**
     * Returns -1 if no track, otherwise returns the id of the middle rendition compatible with the device screen
     * @param tracks
     * @returns
     */
    private _autoFirstTrack(tracks: Array<MediaTrack>): number {
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
    private _selectTracks(tracks: Media.Tracks) {
        if (this._closed) {
            return;
        }
        if (
            this._selectedTracks.audio === tracks.audio &&
            this._selectedTracks.video === tracks.video &&
            Util.equal(this._selectedTracks.data, tracks.data)
        ) {
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
        if (tracks.data) {
            this._requestedTracks.data = tracks.data;
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
                await this.setTracks({ ...this._selectedTracks });
            } catch (e: unknown) {
                this.close({ type: 'SourceError', name: 'Unexpected source issue', detail: Util.stringify(e) });
            }
        }, 0);
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
            await this.play(this._url, this._requestedTracks, this._playing);
        } catch (e: unknown) {
            this.close({ type: 'SourceError', name: 'Unexpected source issue', detail: Util.stringify(e) });
        }
    }

    protected async setReliable(reliable: boolean) {
        if (reliable === this._reliable) {
            return;
        }
        try {
            if (this._running) {
                await this.setReliability(reliable);
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
    protected async fetchMedia(
        url: URL,
        trackIds: Array<number>,
        options: RequestInit = {}
    ): Promise<Response & { error?: string }> {
        const withCMCD = this.cmcd !== CMCD.NONE;
        if (withCMCD) {
            // Add CMCD headers
            let bandwidth = 0;
            let hasVideo = false;
            let hasAudio = false;
            let hasSubtitle = false;
            for (const trackId of trackIds) {
                const mTrack = this.metadata?.tracks.get(trackId);
                if (!mTrack) {
                    continue;
                }
                bandwidth += mTrack.bandwidth;
                switch (mTrack.type) {
                    case Media.Type.AUDIO:
                        hasAudio = true;
                        break;
                    case Media.Type.VIDEO:
                        hasVideo = true;
                        break;
                    case Media.Type.DATA:
                        if (mTrack.codecString.toLowerCase() === 'subtitle') {
                            hasSubtitle = true;
                        }
                        break;
                }
            }
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
                if (hasAudio) {
                    if (hasVideo) {
                        cmcd.ot = CmcdObjectType.MUXED;
                    } else {
                        cmcd.ot = CmcdObjectType.AUDIO;
                    }
                } else if (hasVideo) {
                    cmcd.ot = CmcdObjectType.VIDEO;
                } else if (hasSubtitle) {
                    cmcd.ot = CmcdObjectType.CAPTION;
                }
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
    protected abstract play(url: URL, tracks: Media.Tracks, playing: IPlaying): void;
    protected abstract setReliability(reliable: boolean): void;
    protected abstract setTracks(tracks: Media.Tracks): void;
}
