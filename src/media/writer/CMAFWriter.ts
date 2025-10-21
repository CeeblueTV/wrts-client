/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */
import { BinaryWriter, EventEmitter } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { ContentProtection, ProtectionScheme } from '../Metadata';
import { MediaTrack } from '../MediaTrack';

export type CMAFWriterError =
    /**
     * Unsupported codec error
     */
    | { type: 'CMAFWriterError'; name: 'Unsupported codec'; codec: Media.Codec }
    /**
     * Unsupported track type error
     */
    | { type: 'CMAFWriterError'; name: 'Unsupported track type'; trackType: Media.Type };

/**
 * Write a MP4 optimized for live streaming
 */
export class CMAFWriter extends EventEmitter {
    /**
     * Event fired on payload data to write
     * @param packet payload data
     * @event
     */
    onWrite(packet: Uint8Array) {}

    private _sequence: number;
    private _isVideo: boolean;

    constructor() {
        super();
        this._sequence = 0;
        this._isVideo = false;
    }

    /**
     * Initialize the track : write the moov box
     * This is the header with metadatas of the stream
     *
     * @param track
     * @returns CMAFWriterError if fails, undefined otherwise
     */
    init(track: MediaTrack, contentProtection?: ContentProtection): CMAFWriterError | undefined {
        // Check codecs
        switch (track.type) {
            case Media.Type.AUDIO:
                if (track.codec !== Media.Codec.AAC && track.codec !== Media.Codec.MP3) {
                    return { type: 'CMAFWriterError', name: 'Unsupported codec', codec: track.codec };
                }
                this._isVideo = false;
                break;
            case Media.Type.VIDEO:
                if (track.codec !== Media.Codec.H264) {
                    return { type: 'CMAFWriterError', name: 'Unsupported codec', codec: track.codec };
                }
                this._isVideo = true;
                break;
            default:
                return { type: 'CMAFWriterError', name: 'Unsupported track type', trackType: track.type };
        }

        // Write
        const writer = new BinaryWriter();
        // fftyp
        // prettier-ignore
        writer.write([           
            0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
            0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // ftypisom
            0x63, 0x6d, 0x66, 0x63, 0x69, 0x73, 0x6f, 0x6d,
            0x64, 0x61, 0x73, 0x68, 0x69, 0x73, 0x6f, 0x39
        ]); // cmfcisomdashiso9
        // moov
        const size = writer.size();
        writer.next(4); // skip size!
        // prettier-ignore
        writer.write([
            0x6d, 0x6f, 0x6f, 0x76 // moov
        ]);
        {
            // mvhd
            // prettier-ignore
            writer.write([
                0x00, 0x00, 0x00, 0x6c, 0x6d, 0x76, 0x68, 0x64, // mvhd
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xe8,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
                0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            ]);
            writer.write32(0xffffffff); // next track id, can be set to all 1s
        }

        {
            // trak
            const size = writer.size();
            writer.next(4); // skip size!
            writer.write([0x74, 0x72, 0x61, 0x6b]); // trak

            {
                // tkhd
                // prettier-ignore
                writer.write([
                    0x00, 0x00, 0x00, 0x5c, 0x74, 0x6b, 0x68, 0x64, // tkhd
                    0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00
                ]);
                writer.write32(1); // trackId
                // prettier-ignore
                writer.write([
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
                    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x40, 0x00, 0x00, 0x00
                ]);
                writer.write16(track.resolution.width || 0).write16(0); // width
                writer.write16(track.resolution.height || 0).write16(0); // height
            }

            {
                // mdia
                const size = writer.size();
                writer.next(4); // skip size!
                writer.write([0x6d, 0x64, 0x69, 0x61]); // mdia
                {
                    // mdhd
                    // prettier-ignore
                    writer.write([
                        0x00, 0x00, 0x00, 0x20, 0x6d, 0x64, 0x68, 0x64, // mdhd
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00
                    ]);
                    writer.write32(1000); // timescale, precision 1ms
                    writer.write([0x00, 0x00, 0x00, 0x00]); // duration
                    writer.write16(0x55c4); // ?todo lang (0x55C4 = undefined)
                    writer.write16(0); // predefined
                }
                {
                    // hdlr
                    // prettier-ignore
                    writer.write([
                        0x00, 0x00, 0x00, 0x21, 0x68, 0x64, 0x6c, 0x72, // hdlr
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                    ]);
                    writer.write(this._isVideo ? [0x76, 0x69, 0x64, 0x65] : [0x73, 0x6f, 0x75, 0x6e]); // 'vide' : 'soun'
                    // prettier-ignore
                    writer.write([
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x00
                    ]);
                }
                {
                    // minf + smhd + dinf + dref + url + stbl + stsd + stts + stsc + stsz + stco
                    const size = writer.size();
                    writer.next(4); // skip size!
                    writer.write([0x6d, 0x69, 0x6e, 0x66]); // minf
                    if (this._isVideo) {
                        // prettier-ignore
                        writer.write([
                            0x00, 0x00, 0x00, 0x14, 0x76, 0x6d, 0x68, 0x64, // vmhd
                            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
                            0x00, 0x00, 0x00, 0x00
                        ]);
                    } else {
                        // prettier-ignore
                        writer.write([
                            0x00, 0x00, 0x00, 0x10, 0x73, 0x6d, 0x68, 0x64, // smhd
                            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                        ]);
                    }
                    // prettier-ignore
                    writer.write([
                        0x00, 0x00, 0x00, 0x24, 0x64, 0x69, 0x6e, 0x66, // dinf
                        0x00, 0x00, 0x00, 0x1c, 0x64, 0x72, 0x65, 0x66, // dref
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
                        0x00, 0x00, 0x00, 0x0c, 0x75, 0x72, 0x6c, 0x20, // url
                        0x00, 0x00, 0x00, 0x01
                    ]);
                    {
                        // stbl
                        const size = writer.size();
                        writer.next(4); // skip size!
                        // prettier-ignore
                        writer.write([0x73, 0x74, 0x62, 0x6c]); // stbl
                        {
                            // stsd
                            const size = writer.size();
                            writer.next(4); // skip size!
                            // prettier-ignore
                            writer.write([
                                0x73, 0x74, 0x73, 0x64, 0x00, 0x00, 0x00, 0x00, // stsd
                                0x00, 0x00, 0x00, 0x01
                            ]);

                            {
                                // avc1/mp4a
                                const size = writer.size();
                                writer.next(4); // skip size!
                                if (this._isVideo) {
                                    // VIDEO
                                    // avc1/avc2 => get config packet in moov
                                    // avc3/avc4 => allow config packet dynamically in the stream itself
                                    // The sample entry name ‘avc1’ or 'avc3' may only be used when the stream to which this sample entry applies is a compliant and usable AVC stream as viewed by an AVC decoder operating under the configuration (including profile and level) given in the AVCConfigurationBox. The file format specific structures that resemble NAL units (see Annex A) may be present but must not be used to access the AVC base data; that is, the AVC data must not be contained in Aggregators (though they may be included within the bytes referenced by the additional_bytes field) nor referenced by Extractors.
                                    // The sample entry name ‘avc2’ or 'avc4' may only be used when Extractors or Aggregators (Annex A) are required to be supported, and an appropriate Toolset is required (for example, as indicated by the file-type brands). This sample entry type indicates that, in order to form the intended AVC stream, Extractors must be replaced with the data they are referencing, and Aggregators must be examined for contained NAL Units. Tier grouping may be present.
                                    // avc1 WIP => switch to avc3 when players are ready? (test video config packet inband!)
                                    // 00 00 00 00 00 00	reserved (6 bytes)
                                    // 00 01				data reference index (2 bytes)
                                    // 00 00 00 00			version + revision level
                                    // 00 00 00 00			vendor
                                    // 00 00 00 00			temporal quality
                                    // 00 00 00 00			spatial quality
                                    // prettier-ignore
                                    if (track.contentProtection) {
                                        writer.write32(0x656E6376); // encv
                                    } else {
                                        writer.write32(0x61766331); // avc1
                                    }
                                    writer.write([
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                                    ]);
                                    // 05 00 02 20			width + height
                                    writer.write16(track.resolution.width);
                                    writer.write16(track.resolution.height);
                                    // 00 00 00 00			horizontal resolution
                                    // 00 00 00 00			vertical resolution
                                    // 00 00 00 00			data size
                                    // 00 01				frame by sample, always 1
                                    // prettier-ignore
                                    writer.write([
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x01
                                    ]);
                                    // 32 x 0				32 byte pascal string - compression name
                                    // prettier-ignore
                                    writer.write([
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                                    ]);
                                    // 00 18				depth (24 bits)
                                    // FF FF				default color table
                                    writer.write([0x00, 0x18, 0xff, 0xff]);

                                    if (track.config) {
                                        // file:///C:/Users/mathieu/Downloads/standard8978%20(1).pdf => 5.2.1.1
                                        const size = writer.size();
                                        writer.next(4).write([
                                            // prettier-ignore
                                            0x61,
                                            0x76,
                                            0x63,
                                            0x43 // avcC
                                        ]);
                                        writer.write(track.config);
                                        writer.view.setUint32(size, writer.size() - size);
                                    } else {
                                        this.log(`Video track ${track.id} has no codec configuration`).warn();
                                    }
                                } else {
                                    // AUDIO
                                    // mp4a version = 0, save bandwidth (more lower than 1 or 2) and useless anyway for mp4a
                                    // 6D 70 34 61		 mp4a
                                    // 00 00 00 00 00 00 reserved
                                    // 00 01			 data reference index
                                    // 00 00			 version
                                    // 00 00			 revision level
                                    // 00 00 00 00		 vendor
                                    // prettier-ignore
                                    if (track.contentProtection) {
                                        writer.write32(0x656E6361); // enca
                                    } else {
                                        writer.write32(0x6d703461); // mp4a
                                    }
                                    writer.write([
                                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00
                                    ]);
                                    // writer.write(".mp3,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x02,0x00,0x10,0x00,0x00,0x00,0x00"));
                                    // 00 02			 channels
                                    writer.write16(track.channels);
                                    // 00 10			 bits
                                    // 00 00			 compression id
                                    // 00 00			 packet size
                                    writer.write([0x00, 0x10, 0x00, 0x00, 0x00, 0x00]);
                                    // BB 80 00 00		 rate
                                    writer.write16(Math.min(Math.max(track.rate, 0), 0xffff)).write16(0); // just a introduction indication, config packet is more precise!
                                    // 00 00 00 27		 length
                                    let size = 37 + (track.config?.byteLength ?? -2);
                                    writer.write32(size);
                                    // 65 73 64 73		 esds
                                    // 00 00 00 00		 version
                                    // http://www.etsi.org/deliver/etsi_ts/102400_102499/102428/01.01.01_60/ts_102428v010101p.pdf
                                    // 03
                                    // prettier-ignore
                                    writer.write([
                                        0x65, 0x73, 0x64, 0x73, 0x00, 0x00, 0x00, 0x00, // esds
                                        0x03
                                    ]);
                                    // 25				 length
                                    writer.write8((size -= 14));
                                    // 00 02			 ES ID
                                    // 00				 flags + stream priority
                                    // 04				 decoder config descriptor
                                    writer.write([0x00, 0x02, 0x00, 0x04]);
                                    // 11			 length
                                    writer.write8((size -= 8)); // size includes just decoder config description and audio config desctription

                                    // decoder config descriptor =>
                                    // http://xhelmboyx.tripod.com/formats/mp4-layout.txt
                                    // http://www.mp4ra.org/object.html
                                    // 40 MPEG4 audio, 69 MPEG2 audio
                                    writer.write8(track.codec === Media.Codec.AAC ? 0x40 : 0x69);

                                    // 15 Audio!
                                    // 00 00 00 buffer size = 0
                                    // 00 00 00 00 => max bitrate
                                    // 00 00 00 00 => average bitrate
                                    // prettier-ignore
                                    writer.write([
                                        0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                        0x00, 0x00, 0x00, 0x00
                                    ]);

                                    if (track.config) {
                                        // 05				Audio config descriptor
                                        // 02				length
                                        // 11 B0			audio specific config
                                        writer.write8(5);
                                        writer.write8(track.config.byteLength).write(track.config);
                                    } else {
                                        this.log(`Audio track ${track.id} has no codec configuration`).warn();
                                    }
                                    // 06				SL config descriptor
                                    // 01				length
                                    // 02				flags
                                    writer.write([0x06, 0x01, 0x02]);
                                }
                                this._writeSinf(writer, track, contentProtection);
                                writer.view.setUint32(size, writer.size() - size);
                            } // avc1/mp4a
                            writer.view.setUint32(size, writer.size() - size);
                        } // stsd
                        // stts + stsc + stsz + stco =>
                        // prettier-ignore
                        writer.write([
                            0x00, 0x00, 0x00, 0x10, 0x73, 0x74, 0x74, 0x73, // stts
                            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                            0x00, 0x00, 0x00, 0x10, 0x73, 0x74, 0x73, 0x63, // stsc
                            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                            0x00, 0x00, 0x00, 0x14, 0x73, 0x74, 0x73, 0x7a, // stsz
                            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
                            0x73, 0x74, 0x63, 0x6f, 0x00, 0x00, 0x00, 0x00, // stco
                            0x00, 0x00, 0x00, 0x00
                        ]);
                        writer.view.setUint32(size, writer.size() - size);
                    }
                    writer.view.setUint32(size, writer.size() - size);
                } // minf + smhd + dinf + dref + url + stbl + stsd + stts + stsc + stsz + stco
                writer.view.setUint32(size, writer.size() - size);
            } // mdia
            writer.view.setUint32(size, writer.size() - size);
        } // VIDEOS

        // MVEX is required by spec => https://www.w3.org/TR/mse-byte-stream-format-isobmff/
        writer.write32(8 + 32); // size of mvex
        writer.write([0x6d, 0x76, 0x65, 0x78]); // mvex
        {
            // trex
            // prettier-ignore
            writer.write([
                0x00, 0x00, 0x00, 0x20, 0x74, 0x72, 0x65, 0x78, //trex
                0x00, 0x00, 0x00, 0x00
            ]);
            writer.write32(1); // trackId
            // prettier-ignore
            writer.write([
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            ]);
        }

        // PSSH for content protection, if any
        if (contentProtection) {
            for (const [, psshBase64] of contentProtection.pssh) {
                const binPSSH = Uint8Array.from(atob(psshBase64), c => c.charCodeAt(0) || 0);
                writer.write(binPSSH);
            }
        }
        writer.view.setUint32(size, writer.size() - size);

        this.onWrite(writer.data());
    }

    /**
     * Write the sinf box for content protection
     * @param contentProtection Content protection data if any, if undefined, no sinf box is written
     */
    private _writeSinf(writer: BinaryWriter, track: MediaTrack, contentProtection?: ContentProtection) {
        if (!track.contentProtection || !contentProtection) {
            return;
        }
        const scheme = contentProtection.scheme;
        const size = writer.size();
        writer.next(4); // skip size!
        // prettier-ignore
        writer.write([0x73, 0x69, 0x6e, 0x66]); // sinf
        // prettier-ignore
        writer.write([
            0x00, 0x00, 0x00, 0x0c, 0x66, 0x72, 0x6d, 0x61, // frma
        ]);
        writer.write32(this._isVideo ? 0x61766331 : 0x6d703461); // avc1 or mp4a
        // prettier-ignore
        writer.write([
            0x00, 0x00, 0x00, 0x14, 0x73, 0x63, 0x68, 0x6d, // schm 
            0x00, 0x00, 0x00, 0x00
        ]);
        writer.write32(scheme);
        writer.write([0x00, 0x01, 0x00, 0x00]);
        {
            // schi
            const size = writer.size();
            writer.next(4); // skip size!
            // prettier-ignore
            writer.write([0x73, 0x63, 0x68, 0x69]); // schi
            {
                // tenc
                const size = writer.size();
                writer.next(4); // skip size!
                // prettier-ignore
                writer.write([0x74, 0x65, 0x6e, 0x63]); // tenc
                const isVideoCBCS = scheme === ProtectionScheme.CBCS && this._isVideo;
                writer.write8(isVideoCBCS ? 1 : 0); // version
                writer.write32(0); // flags + reserved
                if (isVideoCBCS) {
                    // CBCS : default crypt block=1 and default skip block=9
                    writer.write8((1 << 4) | 9);
                } else {
                    writer.write8(0);
                }
                writer.write8(1); // isProtected
                writer.write8(scheme === ProtectionScheme.CBCS ? 0 : 16); // Per Sample IV Size, 0 if CBCS
                if (contentProtection.kid.length !== 32) {
                    this.log(`KID length is not 32 bytes, ignoring`).warn();
                    writer.write([
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                    ]);
                } else {
                    writer.writeHex(contentProtection.kid);
                }
                if (scheme === ProtectionScheme.CBCS) {
                    writer.write8(16); // iv size
                    if (contentProtection.iv.length !== 32) {
                        this.log(`IV length is not 32 bytes, ignoring`).warn();
                        writer.write([
                            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                        ]);
                    } else {
                        writer.writeHex(contentProtection.iv);
                    }
                }
                writer.view.setUint32(size, writer.size() - size);
            }
            writer.view.setUint32(size, writer.size() - size);
        }
        writer.view.setUint32(size, writer.size() - size);
    }

    write(sample: Media.Sample, contentProtection?: ContentProtection) {
        // Search if there is empty track => MSE requires to get at less one media by track on each segment
        // In same time compute sizeMoof!
        const sizeTrun = 36;
        let sizeSenc = 0,
            sizeSaiz = 0,
            sizeSaio = 0;
        if (contentProtection) {
            if (this._isVideo || contentProtection.scheme !== ProtectionScheme.CBCS) {
                sizeSaiz += 18;
                sizeSaio += 20;
            }
            if (contentProtection.scheme !== ProtectionScheme.CBCS && contentProtection.iv.length === 32) {
                sizeSenc += 16;
                //sizeSaiz += 1;
            }
            sizeSenc += 16 + (sample.subSamples?.length ? 2 + sample.subSamples.length * 6 : 0);
        }
        const sizeTraf = 8 + 20 + 20 + sizeTrun + sizeSenc + sizeSaiz + sizeSaio; // traf(8) + tfhd(20) + tfdt(20) + trun + senc + saiz + saio
        const sizeMoof = 8 + 16 + sizeTraf; // moof(8) + mfhd(16) + traf

        //////////// MOOF /////////////
        const writer = new BinaryWriter();
        writer.write32(sizeMoof);
        writer.write([0x6d, 0x6f, 0x6f, 0x66]); // moof
        {
            // mfhd
            // prettier-ignore
            writer.write([
                0x00, 0x00, 0x00, 0x10, 0x6d, 0x66, 0x68, 0x64, // mfhd
                0x00, 0x00, 0x00, 0x00
            ]);
            writer.write32(++this._sequence); // starts to 1!
        }

        writer.write32(sizeTraf);
        writer.write([0x74, 0x72, 0x61, 0x66]); // traf
        {
            // tfhd
            // prettier-ignore
            writer.write([
                0x00, 0x00, 0x00, 0x14, 0x74, 0x66, 0x68, 0x64, // tfhd
                0x00, 0x02, 0x00, 0x02
            ]); // 020000 => default_base_is_moof + 0x000002 => sample‐description‐index‐present
            writer.write32(1); // trackId
            writer.write32(1); // SampleDescriptionIndex Must always be present for CMAF!
        }
        {
            // tfdt => required by https://w3c.github.io/media-source/isobmff-byte-stream-format.html
            // http://www.etsi.org/deliver/etsi_ts/126200_126299/126244/10.00.00_60/ts_126244v100000p.pdf
            // when any 'tfdt' is used, the 'elst' box if present, shall be ignored => tfdt time manage the offset!
            // prettier-ignore
            writer.write([
                0x00, 0x00, 0x00, 0x14, 0x74, 0x66, 0x64, 0x74, // tfdt
                0x01, 0x00, 0x00, 0x00
            ]); // version = 1
            writer.write64(sample.time);
        }
        {
            // trun
            writer.write32(sizeTrun);
            writer.write([0x74, 0x72, 0x75, 0x6e]); // trun
            writer.write32(0x00000f01); // flags = sample duration + sample size + sample flags + data-offset + compositionOffset
            writer.write32(1); // samples length
            writer.write32(sizeMoof + 8); // dataoffset: 8 for [size]mdat
            writer.write32(sample.duration); // duration
            writer.write32(sample.data.byteLength); // size
            // 0x01010000 => no-key => sample_depends_on YES | sample_is_difference_sample
            // 0X02000000 => key or audio => sample_depends_on NO
            writer.write32(!this._isVideo || sample.isKeyFrame ? 0x02000000 : 0x01010000);
            writer.write32(sample.compositionOffset || 0);
        }
        if (contentProtection) {
            if (this._isVideo || contentProtection.scheme !== ProtectionScheme.CBCS) {
                // saiz
                writer.write32(sizeSaiz);
                writer.write([0x73, 0x61, 0x69, 0x7a]); // saiz
                writer.write([0x00, 0x00, 0x00, 0x00]); // version + flags
                writer.write8(0); // default_sample_info_size
                writer.write32(1); // sample_count (always one for now)
                const sampleInfoSize =
                    (this._isVideo ? 6 * (sample.subSamples?.length || 0) + 2 : 0) +
                    (contentProtection.scheme === ProtectionScheme.CBCS ? 0 : 16);
                writer.write8(sampleInfoSize); // sample_info_size

                // saio
                writer.write32(sizeSaio);
                writer.write([0x73, 0x61, 0x69, 0x6f]); // saio
                writer.write([0x00, 0x00, 0x00, 0x00]); // version + flags
                writer.write32(1); // entry_count (always one for now)
                writer.write32(sizeMoof - sizeSenc + 16);
            }

            // senc
            writer.write32(sizeSenc);
            writer.write([0x73, 0x65, 0x6e, 0x63]); // senc
            const flags = sample.subSamples?.length ? 0x02 : 0x00;
            writer.write([0x00, 0x00, 0x00, flags]); // version + flags
            writer.write32(1); // sample_count
            if (contentProtection.scheme !== ProtectionScheme.CBCS && contentProtection.iv.length === 32) {
                writer.writeHex(contentProtection.iv);
            }
            if (sample.subSamples?.length) {
                writer.write16(sample.subSamples.length);
                for (const subSample of sample.subSamples) {
                    writer.write16(subSample.clearBytes);
                    writer.write32(subSample.encryptedBytes);
                }
            }
        }

        /// MDAT ///
        writer.write32(8 + sample.data.byteLength);
        writer.write([0x6d, 0x64, 0x61, 0x74]); // mdat

        // effective write
        this.onWrite(writer.data());
        this.onWrite(sample.data);
    }
}
