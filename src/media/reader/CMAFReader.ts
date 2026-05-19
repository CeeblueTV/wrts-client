/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { BinaryReader, BinaryWriter, log, Util } from '@ceeblue/web-utils';
import { Reader, ReaderError } from './Reader';
import * as Media from '../Media';
import * as AVC from '../AVC';
import { MediaTrack } from '../MediaTrack';
import { Metadata } from '../Metadata';

type Track = {
    id: number;
    type: Media.Type;
    timeScale: number;
    time: number;
    baseTime?: number;
    defaultDuration?: number;
    defaultFlags?: number;
    defaultSampleSize?: number;
    encryption?: {
        isProtected: boolean;
        perSampleIVSize: number;
        kid: Uint8Array;
        iv?: Uint8Array;
    };
};

export type TrackEncryption = Track['encryption'];

type Sample = Media.Sample & { size?: number };

type PendingSample = {
    track: Track;
    sample: Sample;
};

enum SampleFlags {
    NO_IDR = 0x01000000,
    IS_IDR = 0x02000000,
    NO_DISPOSABLE = 0x00400000,
    IS_DISPOSABLE = 0x00800000,
    IS_REDUNDANT = 0x00100000,
    NO_REDUNDANT = 0x00200000,
    NO_SYNC_SAMPLE = 0x00010000
}

export class CMAFReader extends Reader {
    /**
     * Event fired on a generic message (emsg box)
     * @param name
     * @param data
     * @event
     */
    onMessage(name: string, time: number, duration: number, data: Uint8Array) {
        this.log(`Uncaught message ${Util.stringify({ name, time, duration, data })}`).warn();
    }

    private _tracks: Map<number, Track>;
    private _initTracks?: Media.Tracks;
    private _track?: Track;
    private _defaultTimeScale: number;
    private _metadata?: Metadata;
    private _passthrough?: BinaryWriter;
    private _pendingSamples: Array<PendingSample>;

    constructor(passthrough: boolean = false) {
        super();
        this._pendingSamples = [];
        this._tracks = new Map<number, Track>();
        this._defaultTimeScale = 1000;
        if (passthrough) {
            this._passthrough = new BinaryWriter();
        }
    }

    /**
     * Parse initData as sinf/schi payload using the same recursive parser path as CMAFReader.
     * Returns a lightweight track object populated with encryption when tenc is found.
     */
    static parseSinfTrack(initData: Uint8Array): TrackEncryption | undefined {
        const parser = new CMAFReader(false);
        parser.onError = error => {
            log('Error while parsing sinf payload:', error).warn();
        };

        // We need to set a dummy track in the parser to be able to parse the tenc box and extract encryption info.
        const track: Track = {
            id: -1,
            type: Media.Type.DATA,
            timeScale: 1000,
            time: 0
        };
        parser._track = track;

        // Try parsing as a full packet containing sized MP4 boxes.
        parser.parse(initData);

        return track.encryption;
    }

    read(data: BufferSource) {
        if (this._passthrough) {
            this._passthrough.write(data);
        }
        super.read(data);
    }

    reset() {
        super.reset();
        this._tracks.clear();
        this._defaultTimeScale = 1000;
        this._pendingSamples.length = 0;
    }

    protected parse(packet: Uint8Array): number {
        const reader = new BinaryReader(packet);

        // Read packet!
        while (reader.available() >= 4) {
            const size = reader.read32() - 4;
            if (size < 0 || size > reader.available()) {
                reader.reset(reader.position() - 4);
                break;
            }
            const error = this._parseBox(reader.read(size));
            if (error) {
                // error unrecoverable!
                this.onError(error);
                return 0;
            }
        }

        return reader.available();
    }

    private _parseBox(box: Uint8Array): ReaderError | undefined {
        const reader = new BinaryReader(box);
        const boxType = String.fromCharCode(...reader.read(4));

        //this.log({boxType, size:reader.available()}).info();

        switch (boxType) {
            default:
                // skip!
                return;
            case 'emsg': {
                // https://aomediacodec.github.io/id3-emsg/
                const version = reader.read8(); // version
                reader.next(3); // flags
                let name: string;
                let timeScale: number;
                let time;
                let duration;
                if (!version) {
                    reader.readString(); // scheme_id_uri
                    name = reader.readString(); // name
                    timeScale = reader.read32(); // timescale
                    time = 0;
                    for (const [, track] of this._tracks) {
                        time = Math.max(track.time, time);
                    }
                    time += (1000 / timeScale) * reader.read32(); // delta time!
                    duration = (1000 / timeScale) * reader.read32(); // event_duration
                    reader.next(4); // id
                } else {
                    timeScale = reader.read32(); // timescale
                    time = (1000 / timeScale) * reader.read64();
                    duration = (1000 / timeScale) * reader.read32(); // event_duration
                    reader.next(4); // id
                    reader.readString(); // scheme_id_uri
                    name = reader.readString(); // name
                }
                this.onMessage(name, time, duration, reader.read());
                return;
            }
            case 'moov':
                this._initTracks = {};
                break;
            case 'mvhd': {
                const version = reader.read8(); // version
                reader.next(3); // flags
                reader.next(version ? 8 : 4); // creationTime
                reader.next(version ? 8 : 4); // modificationTime
                this._defaultTimeScale = reader.read32(); // timeScale
                return;
            }
            case 'trak':
                break;
            case 'tkhd': {
                const version = reader.read8(); // version
                reader.next(3); // flags
                reader.next(version ? 8 : 4); // creationTime
                reader.next(version ? 8 : 4); // modificationTime
                const trackId = reader.read32() - 1;
                this._tracks.set(
                    trackId,
                    (this._track = {
                        id: trackId,
                        type: Media.Type.DATA,
                        timeScale: this._defaultTimeScale,
                        time: 0
                    })
                ); // trackId
                return;
            }
            case 'mdia':
                break;
            case 'mdhd': {
                if (!this._track) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Media Header Box without track before' };
                }
                const version = reader.read8(); // version
                reader.next(3); // flags
                reader.next(version ? 8 : 4); // creationTime
                reader.next(version ? 8 : 4); // modificationTime
                this._track.timeScale = reader.read32(); // timeScale
                return;
            }
            case 'minf':
                break;
            case 'vmhd': {
                if (!this._track) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: 'Video Media Header Box without track before'
                    };
                }
                this._track.type = Media.Type.VIDEO;
                return;
            }
            case 'smhd': {
                if (!this._track) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: 'Sound Media Header Box without track before'
                    };
                }
                this._track.type = Media.Type.AUDIO;
                return;
            }
            case 'stbl':
                break;
            case 'stsd':
                reader.next(8); // skip version, flags and count
                break;
            case 'mp4a':
            case 'Opus':
            case 'hev1':
            case 'hev3':
            case 'avc3':
            case 'avc1':
            case 'encv':
            case 'enca': {
                const trackId = this._track?.id;
                if (trackId == null) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: `${boxType.toUpperCase()} without track before`
                    };
                }
                const mTracks = (this._metadata ?? (this._metadata = new Metadata())).tracks;
                let mTrack = mTracks.get(trackId);
                if (!mTrack) {
                    // create mTrack and index it from 0 to match with legal metadata
                    mTracks.set(trackId, (mTrack = new MediaTrack(trackId - 1)));
                }

                // see https://developer.apple.com/library/content/documentation/QuickTime/QTFF/QTFFChap3/qtff3.html#//apple_ref/doc/uid/TP40000939-CH205-74522
                reader.next(8); // reserved (6 bytes) + data reference index (2 bytes)

                if (boxType === 'Opus') {
                    // Opus in ISOBMFF
                    mTrack.type = Media.Type.AUDIO;
                    mTrack.codec = Media.Codec.OPUS;
                    // Skip AudioSampleEntry fields (ISO BMFF):
                    // reserved(8) + channelcount(2) + samplesize(2) + pre_defined(2) + reserved(2) + samplerate(4) = 20 bytes
                    reader.next(8);
                    mTrack.channels = reader.read16();
                    reader.next(2); // sampleSize (souvent 16)
                    reader.next(4); // pre_defined + reserved
                    mTrack.rate = reader.read32() >>> 16; // 16.16 fixed (48000)
                    return this._parseCodecExtension(reader, mTrack);
                }

                const version = reader.read16();
                if (boxType === 'mp4a' || boxType === 'enca') {
                    mTrack.type = Media.Type.AUDIO;
                    if (version > 1) {
                        reader.next(22); // skip revision level, vendor, "always" values and sizeOfStructOnly
                        mTrack.rate = Math.round(reader.readDouble());
                        mTrack.channels = reader.read32();
                        reader.next(20);
                    } else {
                        // AudioSampleEntryV1 https://b.goeswhere.com/ISO_IEC_14496-12_2015.pdf
                        reader.next(6); // skip revision level and vendor
                        mTrack.channels = reader.read16(); /// channels
                        reader.next(6); // skip sample size, compression id and packet size
                        // BB 80 00 00		 rate
                        mTrack.rate = reader.read16(); /// sampleRate
                        reader.next(2);
                        if (version) {
                            // version = 1
                            reader.next(16);
                        }
                    }
                } else {
                    mTrack.type = Media.Type.VIDEO;
                    reader.next(14); // revision level + vendor + temporal quality + spatial quality
                    mTrack.resolution.width = reader.read16();
                    mTrack.resolution.height = reader.read16();
                    reader.next(50); // resolution, data size, frame count, compressor name, depth and color ID
                }
                return this._parseCodecExtension(reader, mTrack);
            }

            case 'mvex':
                break;
            case 'trex': {
                reader.next(4); // version + flags
                const track = this._tracks.get(reader.read32() - 1); // track
                if (!track) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: 'Track Extends Box without track declaration before'
                    };
                }
                reader.next(4); // default_sample_description_index
                track.defaultDuration = (1000 / track.timeScale) * reader.read32(); // default_sample_duration
                track.defaultSampleSize = reader.read32(); // default_sample_size
                track.defaultFlags = reader.read32(); // default_sample_flags
                return;
            }

            case 'moof':
                // reset values
                this._pendingSamples.length = 0;
                break;
            case 'traf':
                break;
            case 'tfhd': {
                reader.next(); // version
                const flags = reader.read24(); // flags
                const trackId = reader.read32() - 1;
                const track = (this._track = this._tracks.get(trackId)); // trackId
                if (!track) {
                    return { type: 'ReaderError', name: 'Unfound track', track: trackId };
                }
                if (flags & 0x000001) {
                    reader.next(8); // base_data_offset
                }
                if (flags & 0x000002) {
                    reader.next(4); // sample_description_index
                }
                if (flags & 0x000008) {
                    track.defaultDuration = (1000 / track.timeScale) * reader.read32(); // default_sample_duration
                }
                if (flags & 0x000010) {
                    track.defaultSampleSize = reader.read32(); // default_sample_size
                }
                if (flags & 0x000020) {
                    track.defaultFlags = reader.read32(); // default_sample_flags
                }
                return;
            }
            case 'tfdt': {
                const track = this._track;
                if (!track) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: 'Track Fragment Decode Time without track before'
                    };
                }
                const version = reader.read8();
                reader.next(3); // flags
                const time = version === 1 ? reader.read64() : reader.read32();
                track.baseTime = (1000 / track.timeScale) * time;
                return;
            }
            case 'trun': {
                const track = this._track;
                if (!track) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: 'Track Fragment Run Box without track before'
                    };
                }

                if (track.baseTime != null) {
                    track.time = track.baseTime;
                    track.baseTime = undefined; // consume!
                }

                const version = reader.read8(); // version
                const flags = reader.read24(); // flags
                let count = reader.read32();

                if (flags & 0x1) {
                    reader.next(4); // dataOffset
                }
                let sampleFlags;
                if (flags & 0x4) {
                    // firstSampleFlags
                    sampleFlags = reader.read32();
                }

                while (count--) {
                    const sample: Sample = {
                        duration: track.defaultDuration ?? 0,
                        time: track.time,
                        data: new Uint8Array(),
                        size: track.defaultSampleSize
                    };
                    // sample_duration
                    if (flags & 0x100) {
                        sample.duration = (1000 / track.timeScale) * reader.read32();
                    }
                    // sample_size
                    if (flags & 0x200) {
                        sample.size = reader.read32();
                    }
                    if (sample.size == null) {
                        // Sample without size => cannot split mdat reliably
                        return {
                            type: 'ReaderError',
                            name: 'Invalid payload',
                            detail: `Cannot determine sample size for track ${track.id}`
                        };
                    }

                    // sample_flags
                    if (flags & 0x400) {
                        sampleFlags = reader.read32();
                    } else if (sampleFlags == null) {
                        sampleFlags = track.defaultFlags;
                    }
                    sample.isKeyFrame =
                        track.type === Media.Type.VIDEO && ((sampleFlags ?? 0) & SampleFlags.NO_SYNC_SAMPLE) === 0;
                    sampleFlags = null; // to erase firstFlags

                    // sample_composition_time_offset
                    if (flags & 0x800) {
                        // sample_composition_time_offset
                        sample.compositionOffset = reader.read32();
                        if (version && sample.compositionOffset > 0x7fffffff) {
                            // is negative!
                            sample.compositionOffset -= 0x100000000;
                        }
                    }

                    this._pendingSamples.push({ track, sample });
                    // next expected time if next fragment lacks tfdt
                    track.time += sample.duration;
                }

                // set mTrack.currentTime if need on metadata (the first time)
                if (this._metadata) {
                    const mTracks = this._metadata.tracks;
                    let mTrack = mTracks.get(track.id);
                    if (!mTrack) {
                        // create mTrack and index it from 0 to match with legal metadata
                        mTracks.set(track.id, (mTrack = new MediaTrack(track.id - 1)));
                    }
                    mTrack.type = track.type;
                    mTrack.currentTime = track.time;
                    this._metadata.liveTime = Math.max(this._metadata.liveTime, mTrack.currentTime);
                }
                return;
            }
            case 'mdat': {
                if (!this._pendingSamples.length) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Data without trun before' };
                }
                // metadata BEFORE initTracks
                if (this._metadata) {
                    this.onMetadata(this._metadata);
                    this._metadata = undefined;
                }
                // InitTracks
                if (this._initTracks) {
                    for (const [id, track] of this._tracks) {
                        if (track.type === Media.Type.AUDIO) {
                            if (this._initTracks.audio == null) {
                                this._initTracks.audio = id;
                            } else {
                                this.log('Multiple Audio tracks unsupported, track ' + id + ' will be ignored').error();
                            }
                        } else if (track.type === Media.Type.VIDEO) {
                            if (this._initTracks.video == null) {
                                this._initTracks.video = id;
                            } else {
                                this.log('Multiple Video tracks unsupported, track ' + id + ' will be ignored').error();
                            }
                        }
                    }
                    this.onInitTracks(this._initTracks);
                    this._initTracks = undefined;
                }

                while (this._pendingSamples.length) {
                    const { track, sample } = this._pendingSamples.shift()!;
                    sample.data = reader.read(sample.size);
                    if (sample.size != null && sample.size > sample.data.byteLength) {
                        this.log().warn(`Expected ${sample.size} bytes but got ${sample.data.byteLength} bytes for the sample`);
                    }
                    if (this._passthrough) {
                        sample.data = this._passthrough.data();
                        this._passthrough = new BinaryWriter();
                    }
                    this.onSample(track.type, track.id, sample);
                }
                this._pendingSamples.length = 0;
                return;
            }
            // DRM boxes
            case 'schi': {
                const track = this._track;
                if (!track) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: 'Scheme Information Box without track before'
                    };
                }
                // Parse the sub boxes, we are searching for 'tenc'
                while (reader.available() > 4) {
                    const error = this._parseBox(reader.read(reader.read32() - 4));
                    if (error) {
                        return error;
                    }
                }
                return;
            }
            case 'tenc': {
                const track = this._track;
                if (!track) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Track Encryption Box without track before' };
                }
                const encryption = CMAFReader._parseTencPayload(reader.read());
                if (!encryption) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Invalid tenc payload' };
                }
                track.encryption = encryption;
                return;
            }
            case 'senc': {
                const track = this._track;
                if (!track) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Sample Encryption Box without track before' };
                } else if (!track.encryption) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Sample Encryption Box without tenc before' };
                }
                const version = reader.read8(); // version
                const flags = reader.read24(); // flags
                const count = reader.read32(); // sample_count
                if (!reader.available()) {
                    return;
                }
                // The optional override field (algorithm_id + iv_size + KID) is present when flag bit 0 is set.
                if (flags & 0x01) {
                    reader.next(20);
                }
                if (this._pendingSamples.length < count) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: `Sample Encryption Box announces ${count} samples but only ${this._pendingSamples.length} pending samples for track ${track.id}`
                    };
                }
                for (let i = 0; i < count; i++) {
                    if (version === 0 || (version === 2 && track.encryption?.isProtected)) {
                        const sample = this._pendingSamples[i].sample;
                        const useSubSample = version === 2 || (flags & 0x02) !== 0;
                        const ivSize = track.encryption?.perSampleIVSize ?? 0;
                        if (ivSize) {
                            sample.iv = reader.read(ivSize);
                        }
                        const numSubSamples = useSubSample ? reader.read16() : 0;
                        if (useSubSample) {
                            sample.subSamples = [];
                            for (let j = 0; j < numSubSamples; j++) {
                                const clearBytes = reader.read16();
                                const encryptedBytes = reader.read32();
                                sample.subSamples.push({ clearBytes, encryptedBytes });
                            }
                        }
                    } else {
                        return { type: 'ReaderError', name: 'Unsupported format', format: `Senc version ${version}` };
                    }
                }
                return;
            }
        }
        // Sub box that we want parse
        let error;
        let size;
        while (!error && reader.available() && (size = reader.read32() - 4) > 0) {
            error = this._parseBox(reader.read(size));
        }
        return error;
    }

    private _parseCodecExtension(reader: BinaryReader, mTrack: MediaTrack): ReaderError | undefined {
        // Read extension sample description box
        let size;
        while ((size = reader.read32() - 4) > 0) {
            const extension = reader.read(size);
            let i: number;
            let end: number = extension.byteLength;
            const type = String.fromCharCode(...extension.subarray(0, (i = 4)));

            // this.log(`Parsing codec extension ${type} of size ${extension.byteLength}`).info();

            switch (type) {
                case 'btrt': {
                    const config = new BinaryReader(extension.subarray(i, end));
                    config.next(4); // bufferSizeDB
                    const maxBitrate = config.read32();
                    const avgBitrate = config.read32();
                    // CMAF spec: avgBitrate is the nominal average bitrate
                    mTrack.bandwidth = avgBitrate || maxBitrate;
                    break;
                }
                case 'dOps': {
                    // OpusSpecificBox
                    mTrack.type = Media.Type.AUDIO;
                    mTrack.codec = Media.Codec.OPUS;
                    mTrack.config = extension.subarray(i, end); // keep full dOps payload (without size+type)
                    break;
                }
                case 'esds': {
                    // http://xhelmboyx.tripod.com/formats/mp4-layout.txt
                    // http://hsevi.ir/RI_Standard/File/8955
                    // section 7.2.6.5
                    // section 7.2.6.6.1
                    // AudioSpecificConfig => https://csclub.uwaterloo.ca/~pbarfuss/ISO14496-3-2009.pdf
                    mTrack.type = Media.Type.AUDIO;
                    i += 4; // Skip version!
                    if ((i < end ? extension[i++] : 0) !== 3) {
                        // ES descriptor type = 3
                        continue;
                    }
                    let value = i < end ? extension[i++] : 0;
                    if (value & 0x80 && i < end) {
                        // 3 bytes extended descriptor
                        i += 2;
                        value = extension[i++];
                    }
                    end = Math.min(end, i + value); //  extension.shrink(value);
                    i += 2; // ES ID
                    value = i < end ? extension[i++] : 0;
                    if (value & 0x80) {
                        // streamDependenceFlag
                        i += 2; // dependsOn_ES_ID
                    }
                    if (value & 0x40 && i < end) {
                        // URL_Flag
                        i += extension[i++]; // skip url
                    }
                    if (value & 0x20) {
                        // OCRstreamFlag
                        i += 2; // OCR_ES_Id
                    }
                    if (i >= end || extension[i++] !== 4) {
                        // Audio descriptor type = 4
                        continue;
                    }
                    value = i < end ? extension[i++] : 0;
                    if (value & 0x80 && i < end) {
                        // 3 bytes extended descriptor
                        i += 2;
                        value = extension[i++];
                    }
                    end = Math.min(end, i + value); // extension.shrink(value);
                    const codec = i < end ? extension[i++] : 0;

                    switch (codec) {
                        case 0x40: // AAC
                        case 0x66: // MPEG-4 ADTS main
                        case 0x67: // MPEG-4 ADTS Low Complexity;
                        case 0x68: // MPEG-4 ADTS Scalable Sampling Rate
                            mTrack.codec = Media.Codec.AAC;
                            break;
                        case 0x69: // MPEG-2 ADTS
                        case 0x6b: // MP3
                            mTrack.codec = Media.Codec.MP3;
                            break;
                        default:
                            return { type: 'ReaderError', name: 'Unsupported format', format: `Audio Codec ${codec}` };
                    }
                    i += 12; // skip decoder config descriptor (buffer size + max bitrate + average bitrate)
                    if ((i < end ? extension[i++] : 0) !== 5) {
                        // Audio specific config = 5
                        continue;
                    }

                    value = i < end ? extension[i++] : 0;
                    if (value & 0x80 && i < end) {
                        // 3 bytes extended descriptor
                        i += 2;
                        value = extension[i++];
                    }
                    end = Math.min(end, i + value); // extension.shrink(value);
                    mTrack.config = extension.subarray(i, end);
                    break;
                }
                case 'avcC': {
                    mTrack.type = Media.Type.VIDEO;
                    mTrack.codec = Media.Codec.H264;
                    mTrack.config = extension.subarray(i, end);
                    const videoConfig = AVC.readVideoConfig(mTrack.config);
                    AVC.parseSPS(videoConfig.sps, mTrack);
                    break;
                }
                case 'hvcC': {
                    mTrack.type = Media.Type.VIDEO;
                    mTrack.codec = Media.Codec.HEVC;
                    mTrack.config = extension.subarray(i, end);
                    // WIP
                    const videoConfig = AVC.readVideoConfig(mTrack.config);
                    AVC.parseSPS(videoConfig.sps, mTrack);
                    break;
                }
                case 'pasp': // PixelAspectRatioBox
                    break;
                case 'sinf': {
                    // Sample Encryption Information Box
                    const sinfReader = new BinaryReader(extension.subarray(Math.min(i, end), end));
                    while (sinfReader.available() > 4) {
                        const error = this._parseBox(sinfReader.read(sinfReader.read32() - 4));
                        if (error) {
                            return error;
                        }
                    }
                    break;
                }
                default:
                    this.log(`Ignore codec extension ${type}`).warn();
                    break;
            }
        }
        if (mTrack.codec) {
            mTrack.codecString = AVC.writeCodecString(mTrack.codec, mTrack.config);
        }
    }

    private static _parseTencPayload(payload: Uint8Array): TrackEncryption | undefined {
        const reader = new BinaryReader(payload);
        if (reader.available() < 24) {
            return undefined;
        }
        reader.next(6); // version + flags + reserved byte + byteBlock
        const encryption: TrackEncryption = {
            isProtected: reader.read8() === 1,
            perSampleIVSize: reader.read8(),
            kid: reader.read(16)
        };
        if (encryption.isProtected && encryption.perSampleIVSize === 0) {
            if (!reader.available()) {
                return undefined;
            }
            const constantIVSize = reader.read8();
            if (reader.available() < constantIVSize) {
                return undefined;
            }
            encryption.iv = reader.read(constantIVSize);
        }
        return encryption;
    }
}
