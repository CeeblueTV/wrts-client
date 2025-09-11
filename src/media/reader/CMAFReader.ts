/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { BinaryReader, BinaryWriter, Util } from '@ceeblue/web-utils';
import { Reader, ReaderError } from './Reader';
import * as Media from '../Media';
import * as AVC from '../AVC';
import { MediaTrack } from '../MediaTrack';
import { Metadata } from '../Metadata';

type Track = {
    id: number;
    type: Media.Type;
    timeScale: number;
    sample: Media.Sample;
};

export class CMAFReader extends Reader {
    /**
     * Event fired on new CMAF message
     * @param name
     * @param data
     * @event
     */
    onMessage(name: string, data: Uint8Array) {
        this.log(`Uncatched message ${name}`).warn();
    }

    private _tracks: Map<number, Track>;
    private _track?: Track;
    private _defaultTimeScale: number;
    private _metadata?: Metadata;
    private _passthrough: BinaryWriter;

    constructor(passthrough: boolean = true) {
        super();
        this._tracks = new Map<number, Track>();
        this._defaultTimeScale = 1000;
        this._passthrough = new BinaryWriter();
    }

    read(data: BufferSource | string) {
        if (this._passthrough) {
            this._passthrough.write(data);
        }
        super.read(data);
    }

    reset() {
        super.reset();
        this._tracks.clear();
        this._defaultTimeScale = 1000;
    }

    protected _parse(packet: Uint8Array): number {
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

        // log({boxType, size:reader.available()}).info();

        switch (boxType) {
            default:
                // skip!
                return;
            case 'emsg': {
                // https://aomediacodec.github.io/id3-emsg/
                const version = reader.read8(); // version
                reader.next(3); // flags
                let name: string;
                if (!version) {
                    reader.readString(); // scheme_id_uri
                    name = reader.readString(); // name
                    reader.next(4); // timescale
                    reader.next(4); // presentation_time
                    reader.next(4); // event_duration
                    reader.next(4); // id
                } else {
                    reader.next(4); // timescale
                    reader.next(8); // presentation_time
                    reader.next(4); // event_duration
                    reader.next(4); // id
                    reader.readString(); // scheme_id_uri
                    name = reader.readString(); // name
                }
                this.onMessage(name, reader.read());
                return;
            }
            case 'moov':
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
                        type: 0,
                        timeScale: this._defaultTimeScale,
                        sample: {
                            time: 0,
                            duration: 0,
                            data: new Uint8Array()
                        }
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
            case 'hev1':
            case 'hev3':
            case 'avc3':
            case 'avc1': {
                const trackId = this._track?.id;
                if (trackId == null) {
                    return {
                        type: 'ReaderError',
                        name: 'Invalid payload',
                        detail: `${boxType.toUpperCase()} without track before`
                    };
                }
                const tracks = (this._metadata ?? (this._metadata = new Metadata())).tracks;
                const track = new MediaTrack(trackId);
                tracks.set(track.id, track);

                // see https://developer.apple.com/library/content/documentation/QuickTime/QTFF/QTFFChap3/qtff3.html#//apple_ref/doc/uid/TP40000939-CH205-74522
                reader.next(8); // reserved (6 bytes) + data reference index (2 bytes)
                const version = reader.read16();

                if (boxType === 'mp4a') {
                    if (version > 1) {
                        reader.next(22); // skip revision level, vendor, "always" values and sizeOfStructOnly
                        track.rate = Math.round(reader.readDouble());
                        track.channels = reader.read32();
                        reader.next(20);
                    } else {
                        // AudioSampleEntryV1 https://b.goeswhere.com/ISO_IEC_14496-12_2015.pdf
                        reader.next(6); // skip revision level and vendor
                        track.channels = reader.read16(); /// channels
                        reader.next(6); // skip sample size, compression id and packet size
                        // BB 80 00 00		 rate
                        track.rate = reader.read16(); /// sampleRate
                        reader.next(2);
                        if (version) {
                            // version = 1
                            reader.next(16);
                        }
                    }
                } else {
                    reader.next(14); // revision level + vendor + temporal quality + spatial quality
                    track.resolution.width = reader.read16();
                    track.resolution.height = reader.read16();
                    reader.next(50); // resolution, data size, frame count, compressor name, depth and color ID
                }
                return this._parseCodecExtension(reader, track);
            }

            case 'mvex':
                break;
            case 'trex': {
                reader.next(4); // version + flags
                const track = this._tracks.get(reader.read32() - 1); // track
                if (track) {
                    reader.next(4); // default_sample_description_index
                    track.sample.duration = (1000 / track.timeScale) * reader.read32(); // default_sample_duration
                }
                return;
            }

            case 'moof':
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
                    track.sample.duration = (1000 / track.timeScale) * reader.read32(); // default_sample_duration
                }
                if (flags & 0x000010) {
                    reader.next(4); // default_sample_size
                }
                if (flags & 0x000020) {
                    this._parseSampleFlags(track, reader.read32()); // default_sample_flags
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
                track.sample.time = (1000 / track.timeScale) * (version === 1 ? reader.read64() : reader.read32());
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

                const version = reader.read8(); // version
                const flags = reader.read24(); // flags
                let count = reader.read32();

                if (flags & 0x1) {
                    reader.next(4); // dataOffset
                }
                if (flags & 0x4) {
                    this._parseSampleFlags(track, reader.read32()); // firstSampleFlags
                }
                // WIP support multiple samples!
                count = 1;

                while (count--) {
                    if (flags & 0x100) {
                        track.sample.duration = (1000 / track.timeScale) * reader.read32(); // sample_duration
                    }
                    if (flags & 0x200) {
                        reader.next(4); // sample_size
                    }
                    if (flags & 0x400) {
                        this._parseSampleFlags(track, reader.read32()); // sample_flags
                    }
                    if (flags & 0x800) {
                        // sample_composition_time_offset
                        track.sample.compositionOffset = reader.read32();
                        if (version && track.sample.compositionOffset > 0x7fffffff) {
                            // is negative!
                            track.sample.compositionOffset -= 0x100000000;
                        }
                    }
                }
                return;
            }
            case 'mdat': {
                const track = this._track;
                if (!track) {
                    return { type: 'ReaderError', name: 'Invalid payload', detail: 'Data without track before' };
                }
                if (this._metadata) {
                    this._metadata.liveTime = Math.max(this._metadata.liveTime, track.sample.time + track.sample.duration);
                    this.onMetadata(this._metadata);
                    this._metadata = undefined;
                }

                const sample = track.sample;
                sample.data = track.type === Media.Type.DATA ? JSON.parse(Util.stringify(reader.read())) : reader.read();
                if (this._passthrough) {
                    sample.data = this._passthrough.data();
                }
                if (track.type === Media.Type.AUDIO) {
                    this.onAudio(track.id, sample);
                } else if (track.type === Media.Type.VIDEO) {
                    this.onVideo(track.id, sample);
                } else {
                    this.onData(track.id, sample.time, sample.data);
                }
                /// Reset sample
                track.sample = {
                    time: sample.time + sample.duration, // next time normally
                    duration: sample.duration, // constant duration
                    data: new Uint8Array()
                };
                this._passthrough = new BinaryWriter();
                return;
            }
        }
        // Sub box that we want parse
        let error;
        while (!error && reader.available() > 4) {
            error = this._parseBox(reader.read(reader.read32() - 4));
        }
        return error;
    }

    private _parseSampleFlags(track: Track, flags: number) {
        // sample_is_depended_on || sample_is_non_sync_sample => noKey!
        track.sample.isKeyFrame = track.type !== Media.Type.VIDEO || flags & 0x1000000 || flags & 0x10000 ? false : true;
    }

    private _parseCodecExtension(reader: BinaryReader, track: MediaTrack): ReaderError | undefined {
        // Read extension sample description box
        while (reader.available()) {
            const extension = reader.read(reader.read32() - 4);
            let i: number;
            let end: number = extension.byteLength;
            const type = String.fromCharCode(...extension.subarray(0, (i = 4)));
            switch (type) {
                case 'esds': {
                    // http://xhelmboyx.tripod.com/formats/mp4-layout.txt
                    // http://hsevi.ir/RI_Standard/File/8955
                    // section 7.2.6.5
                    // section 7.2.6.6.1
                    // AudioSpecificConfig => https://csclub.uwaterloo.ca/~pbarfuss/ISO14496-3-2009.pdf
                    track.type = Media.Type.AUDIO;
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
                            track.codec = Media.Codec.AAC;
                            break;
                        case 0x69: // MPEG-2 ADTS
                        case 0x6b: // MP3
                            track.codec = Media.Codec.MP3;
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
                    track.config = extension.subarray(i, end);
                    break;
                }
                case 'avcC': {
                    track.type = Media.Type.VIDEO;
                    track.codec = Media.Codec.H264;
                    track.config = extension.subarray(i, end);
                    const videoConfig = AVC.readVideoConfig(track.config);
                    AVC.parseSPS(videoConfig.sps, track);
                    break;
                }
                case 'hvcC': {
                    track.type = Media.Type.VIDEO;
                    track.codec = Media.Codec.HEVC;
                    track.config = extension.subarray(i, end);
                    // WIP
                    const videoConfig = AVC.readVideoConfig(track.config);
                    AVC.parseSPS(videoConfig.sps, track);
                    break;
                }
                case 'btrt': {
                    i += 4; // skip bufferSizeDB
                    track.bandwidth = new BinaryReader(extension.subarray(Math.min(i, end), end)).read32();
                    break;
                }
                case 'pasp': // PixelAspectRatioBox
                    break;
                default:
                    this.log(`Ignore codec extension ${type}`).warn();
                    break;
            }
        }
        if (track.codec) {
            track.codecString = AVC.writeCodecString(track.codec, track.config);
        }
    }
}
