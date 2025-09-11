/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Util, BinaryReader } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { Metadata } from '../Metadata';
import { Reader } from './Reader';

/**
 * RTSReader to unserialize RTS container
 *
 * Format:
 * MEDIA PACKET -- (uint8 headerSize)[7bit trackId+1 << 2 | type](7bit firstTime)[7bit duration << 2 | hasCompositionOffset<<1 | isKeyFrame](7bit compositionOffset)(7bit size) [frame] --
 * DATA  PACKET -- (uint8 headerSize)[7bit trackId+1 << 2 | type][7bit time](7bit size) [frame] --
 * INIT TRACKS  -- (uint8 headerSize)[7bit 0 << 2 | 3] (7bit videoTrackId+1) (7bit audioTrackId+1)--
 * METADATA -- (uint8 headerSize)[7bit 0 << 2 | 0] (7bit size) [meta] --
 *
 * size => optional content size!
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
    private _header?: Uint8Array;
    constructor(
        private _params: {
            withSize?: boolean;
        } = {}
    ) {
        super();
        this._params = Object.assign({ withSize: false }, this._params);
        this._nextTimes = new Map<number, number>();
    }

    protected _parse(packet: Uint8Array): number {
        const reader = new BinaryReader(packet);
        while (reader.available()) {
            if (!this._header) {
                if (!this._params.withSize) {
                    // Is a frame protocol like WebSocket!
                    this._header = reader.read();
                    return 0; // wait next frame now!
                }
                const size = reader.read8();
                if (reader.available() < size) {
                    return reader.available() + 1; // + 1 for the size!
                }
                this._header = reader.read(size);
            }

            // header here is full!
            const header = new BinaryReader(this._header);

            // Read header
            let type = header.read7Bit();
            let trackId = type >> 2;
            type &= 3;
            if (!trackId--) {
                switch (type) {
                    case 3: {
                        // INIT TRACKS
                        this._nextTimes.clear();
                        this.onVideo(header.read7Bit() - 1);
                        this.onAudio(header.read7Bit() - 1);
                        break;
                    }
                    case 0: {
                        // METADATA
                        const data = this._readPayload(header, reader);
                        if (!data) {
                            return reader.available();
                        }
                        this.onMetadata(new Metadata(JSON.parse(Util.stringify(data))));
                        break;
                    }
                    default:
                        this.onError({ type: 'ReaderError', name: 'Unknown format', format: type });
                        return 0; // unrecoverable!
                }
            } else if (!type) {
                // DATA String
                const time = header.read7Bit();
                const data = this._readPayload(header, reader);
                if (!data) {
                    return reader.available();
                }
                this.onData(trackId, time, JSON.parse(Util.stringify(data)));
            } else {
                // MEDIA PACKET
                const time = this._nextTimes.get(trackId) ?? header.read7Bit();

                const value = header.read7Bit();
                const duration = value >> 2;
                const compositionOffset = value & 2 ? header.read7Bit() : 0;
                const isKeyFrame = value & 1 ? true : false;

                const data = this._readPayload(header, reader);
                if (!data) {
                    return reader.available();
                }

                this._nextTimes.set(trackId, time + duration);
                if (type === Media.Type.AUDIO) {
                    this.onAudio(trackId, { time, duration, isKeyFrame, compositionOffset, data });
                } else {
                    this.onVideo(trackId, { time, duration, isKeyFrame, compositionOffset, data });
                }
            }

            this._header = undefined;
        }
        return 0;
    }

    private _readPayload(header: BinaryReader, reader: BinaryReader): Uint8Array | undefined {
        if (!this._params.withSize) {
            return reader.read();
        }
        const size = header.read7Bit();
        if (reader.available() >= size) {
            return reader.read(size);
        }
    }
}
