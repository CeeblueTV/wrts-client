/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Util, BinaryReader } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { Metadata } from '../Metadata';
import { Reader } from './Reader';

enum CustomType {
    SUBSAMPLE_ENCRYPTED = 1
}

/**
 * RTSReader to unserialize RTS container
 *
 * Format:
 * MEDIA PACKET -- (7bit packetSize)[7bit trackId+1 << 2 | type](7bit firstTime)[7bit duration << 2 | hasCompositionOffset<<1 | isKeyFrame](7bit compositionOffset) [frame] --
 * DATA  PACKET -- (7bit packetSize)[7bit trackId+1 << 2 | type][7bit time] [frame] --
 * INIT TRACKS  -- (7bit packetSize)[7bit 0 << 2 | 3]  (7bit audioTrackId+1)(7bit videoTrackId+1)--
 * METADATA -- (7bit packetSize)[7bit 0 << 2 | 0] [meta] --
 *
 * packetSize => optional packet size
 * trackId => track id
 * type = [0, 1, 2, 3] = [Data, Audio, Video, Reserved]
 * firstTime => timestamp only the first time per track after a INIT TRACKS signal
 * time => data time
 * compositionOffset => composition offset
 * frame => binary frame payload
 * meta => JSON metadata payload
 */
export class RTSReader extends Reader {
    private _nextTimes: Map<number, number>; // <trackId,time>
    constructor(
        private _params: {
            withSize?: boolean;
        } = {}
    ) {
        super();
        this._params = Object.assign({ withSize: false }, this._params);
        this._nextTimes = new Map<number, number>();
    }

    protected parse(packet: Uint8Array): number {
        const reader = new BinaryReader(packet);
        while (reader.available()) {
            let size = reader.available();
            if (this._params.withSize) {
                const available = size;
                size = reader.read7Bit();
                if (reader.available() < size) {
                    return available;
                }
            } // else Is a frame protocol like WebSocket!

            const frame = new BinaryReader(reader.read(size));

            // Read header
            let type = frame.read7Bit();
            let trackId = type >> 2;
            type &= 3;
            if (!trackId--) {
                // Command messages
                switch (type) {
                    case 3: {
                        // INIT TRACKS
                        this._nextTimes.clear();
                        this.onInitTracks({
                            audio: frame.read7Bit() - 1,
                            video: frame.read7Bit() - 1
                        });
                        break;
                    }
                    case 0: {
                        // METADATA
                        this.onMetadata(new Metadata(JSON.parse(Util.stringify(frame.read()))));
                        break;
                    }
                    default:
                        this.onError({ type: 'ReaderError', name: 'Unknown format', format: type });
                        return 0; // unrecoverable!
                }
            } else {
                // Media Packet
                if (type) {
                    // MEDIA PACKET
                    const time = this._nextTimes.get(trackId) ?? frame.read7Bit();

                    const value = frame.read7Bit();
                    const duration = value >> 2;
                    let compositionOffset = 0;
                    if (value & 2) {
                        // can be negative, so sign extend the 16 bits value
                        compositionOffset = ((frame.read7Bit() & 0xffff) << 16) >> 16;
                    }
                    const isKeyFrame = value & 1 ? true : false;

                    const sample: Media.Sample = { time, duration, isKeyFrame, compositionOffset, data: new Uint8Array() };
                    this._readCustom(frame, sample);
                    sample.data = frame.read();
                    this._nextTimes.set(trackId, time + duration);
                    this.onSample(type, trackId, sample);
                } else {
                    // DATA PACKET
                    const time = frame.read7Bit() + (this._nextTimes.get(trackId) ?? 0);
                    const duration = frame.read7Bit();
                    this._readCustom(frame);
                    this._nextTimes.set(trackId, time);
                    this.onSample(Media.Type.DATA, trackId, {
                        time,
                        duration,
                        data: frame.read()
                    });
                }
            }
        }
        return 0;
    }

    private _readCustom(reader: BinaryReader, sample?: Media.Sample) {
        let size;
        while ((size = reader.read7Bit())) {
            if (reader.available() < size) {
                this.log('Not enough data for custom type, skipping', { size, available: reader.available() }).warn();
                return;
            }
            const typeReader = new BinaryReader(reader.read(size));
            const type = typeReader.read7Bit();
            switch (type) {
                case CustomType.SUBSAMPLE_ENCRYPTED: {
                    if (sample) {
                        sample.subSamples = new Array<{ clearBytes: number; encryptedBytes: number }>(); // Encrypted list
                        const subSampleCount = typeReader.read7Bit();
                        for (let i = 0; i < subSampleCount; i++) {
                            sample.subSamples.push({
                                clearBytes: typeReader.read7Bit(),
                                encryptedBytes: typeReader.read7Bit()
                            });
                        }
                    }
                    break;
                }
            }
        }
    }
}
