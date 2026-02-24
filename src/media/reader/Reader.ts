/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */
import { EventEmitter, Util } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { Metadata } from '../Metadata';

export type ReaderError =
    /**
     * Invalid payload error
     */
    | { type: 'ReaderError'; name: 'Invalid payload'; detail: string }
    /**
     * Parse an unknown format
     */
    | { type: 'ReaderError'; name: 'Unknown format'; format: string | number }
    /**
     * Unsupported format error
     */
    | { type: 'ReaderError'; name: 'Unsupported format'; format: string | number }
    /**
     * Track unfound error
     */
    | { type: 'ReaderError'; name: 'Unfound track'; track: number };

export abstract class Reader extends EventEmitter {
    /**
     * Event fire on {@link ReaderError}
     * @event
     */
    onError(error: ReaderError) {
        this.log(error).error();
    }

    /**
     * Event fired when metadata is present in the stream
     * @param metadata
     * @event
     */
    onMetadata(metadata: Metadata) {}

    /**
     * Event fire on tracks initialization
     */
    onInitTracks(tracks: Media.Tracks) {
        this.log(`Init tracks ${Util.stringify(tracks)}`).info();
    }

    /**
     * Event fire on new sample {@link Media.Sample}
     * @param trackId
     * @param sample
     */
    onSample(type: Media.Type, trackId: number, sample: Media.Sample) {
        const types = ['Data', 'Audio', 'Video'];
        this.log(`${types[type]} sample uncatched on track ${trackId}`).warn();
    }

    /**
     * Event fired on a generic message
     * @param name
     * @param data
     * @event
     */
    onMessage(name: string, time: number, duration: number, data: Uint8Array) {
        this.log(`Uncaught message ${Util.stringify({ name, time, duration, data })}`).warn();
    }

    private _data?: Uint8Array;
    constructor() {
        super();
    }

    reset() {
        this._data = undefined;
    }

    read(data: BufferSource) {
        // try-catch to anticipate Reader implementation issue
        try {
            let packet = 'buffer' in data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
            // Binary!
            if (this._data) {
                const newData = new Uint8Array(this._data.byteLength + packet.byteLength);
                newData.set(this._data); // old data
                newData.set(packet, this._data.byteLength); // new data
                packet = newData;
            }
            const remaining = Math.min(this.parse(packet), packet.byteLength);
            if (remaining > 0) {
                this._data = new Uint8Array(packet.buffer, packet.byteOffset + packet.byteLength - remaining, remaining);
            } else {
                this._data = undefined;
            }
        } catch (e) {
            this.log(Util.stringify(e)).error();
        }
    }

    /**
     * Children class must implement the parsing logic, and returns how many bytes have to be kept.
     * @param packet the binary to parse
     */
    protected parse(packet: Uint8Array): number {
        throw Error(this.constructor.name + ' must implement parse');
    }
}
