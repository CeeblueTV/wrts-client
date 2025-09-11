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
     * Event fire on new audio {@link Media.Sample}
     * @param trackId
     * @param sample
     */
    onAudio(trackId: number, sample?: Media.Sample) {
        this.log(`Audio sample uncatched on track ${trackId}`).warn();
    }

    /**
     * Event fire on new video {@link Media.Sample}
     * @param trackId
     * @param sample
     */
    onVideo(trackId: number, sample?: Media.Sample) {
        this.log(`Video sample uncatched on track ${trackId}`).warn();
    }

    /**
     * Event fired on new data
     * @param trackId
     * @param time
     * @param data
     * @event
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onData(trackId: number, time: number, data: any) {
        this.log(`Data sample uncatched on track ${trackId}`).warn();
    }

    private _data?: Uint8Array;
    constructor() {
        super();
    }

    reset() {
        this._data = undefined;
    }

    read(data: BufferSource | string) {
        // try-catch to anticipate Reader implementation issue
        try {
            if (typeof data == 'string') {
                // JSON metadata or time
                this._parseString(data);
                return;
            }
            let packet = 'buffer' in data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
            // Binary!
            if (this._data) {
                const newData = new Uint8Array(this._data.byteLength + packet.byteLength);
                newData.set(this._data); // old data
                newData.set(packet, this._data.byteLength); // new data
                packet = newData;
            }
            const remaining = Math.min(this._parse(packet), packet.byteLength);
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
    protected _parse(packet: Uint8Array): number {
        throw Error(this.constructor.name + ' must implement _parse');
    }

    protected _parseString(data: string) {
        const obj = JSON.parse(data);
        if (obj.trackId != null) {
            this.onData(obj.trackId, obj.time, obj.data ?? data);
        } else {
            this.onMetadata(new Metadata(obj));
        }
    }
}
