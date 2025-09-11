/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ILog, Loggable, Util } from '@ceeblue/web-utils';
import { CMAFWriter, CMAFWriterError } from './writer/CMAFWriter';
import * as Media from './Media';
import { Metadata } from './Metadata';

const UPDATE_TIMEOUT = 400;
const MAX_CONSECUTIVE_BFRAME = 16;

/**
 * Determines whether an error is a QuotaExceededError.
 *
 * Browsers love throwing slightly different variations of QuotaExceededError
 * (this is especially true for old browsers/versions), so we need to check
 * different fields and values to ensure we cover every edge-case.
 *
 * @param err - The error to check
 * @return Is the error a QuotaExceededError?
 */
function isQuotaExceededError(err: unknown): boolean {
    return (
        err instanceof DOMException &&
        (err.code === 22 ||
            // Firefox
            err.code === 1014 ||
            // test name field too, because code might not be present
            // everything except Firefox
            err.name === 'QuotaExceededError' ||
            // Firefox
            err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    );
}

export type MediaBufferError =
    /**
     * Represents a SourceBuffer aborted issue
     */
    | { type: 'MediaBufferError'; name: 'SourceBuffer aborted'; mimeType: string }
    /**
     * Represents a track without metadata error
     */
    | { type: 'MediaBufferError'; name: 'Track without metadata'; track: number }
    /**
     * Represents an append buffer issue
     */
    | { type: 'MediaBufferError'; name: 'Append buffer issue'; detail: string }
    /**
     * Represents an exceeding buffer size issue
     */
    | { type: 'MediaBufferError'; name: 'Exceeds buffer size' }
    /**
     * Represents a cMAF writing issue.
     */
    | CMAFWriterError;

export class MediaBuffer extends Loggable {
    /**
     * Event fire on {@link MediaBufferError}
     * @event
     */
    onError(error: MediaBufferError) {
        this.log(error).error();
    }

    /**
     * Fired after the media buffer has been successfully updated.
     * @event
     */
    onUpdate() {}

    /**
     * Event fire on SourceBuffer appended data, basically here to debug MSE ingestion
     * @event
     */
    onDataAppended(data: Uint8Array) {}

    get isVideo(): boolean {
        return this._isVideo;
    }

    get startTime(): number {
        const startTime = this._buffer?.buffered.length ? this._buffer.buffered.start(0) : 0;
        if (startTime >= this._startTime) {
            // fix startTime set by user if the real is superior !
            this._startTime = startTime;
        }
        // use _startTime if superior to the real because some browser (possibly Safari)
        // are not able to remove some part of obsolete buffer
        return Math.min(this._startTime, this.endTime);
    }
    set startTime(value: number) {
        this._startTime = value;
        this.flush();
    }

    get endTime(): number {
        return this._buffer?.buffered.length ? this._buffer.buffered.end(this._buffer.buffered.length - 1) : 0;
    }

    private _buffer?: SourceBuffer; // make possibly undefined because can try exception one time closed!
    private _cmafWriter: CMAFWriter;
    private _packets: Array<Uint8Array | string>;
    private _trackId?: number;
    private _mimeType: string;
    private _isVideo: boolean;
    private _updateTimeout: number;
    private _startTime: number;
    private _waitBFrames: number;
    private _onUpdating: boolean;

    constructor(mediaSource: MediaSource, mimeType: string, isAlreadyCMAF: boolean = false) {
        super();
        this._onUpdating = false;
        this._mimeType = mimeType;
        this._isVideo = mimeType.toLocaleLowerCase().startsWith('video');
        this._packets = [];
        this._startTime = -1;
        this._waitBFrames = 0;
        this._updateTimeout = 0;
        // Create buffer with default AVC codec (will be change later)
        const type = mimeType + '; codecs=' + (this._isVideo ? '"avc1.42000a"' : '"mp4a.40.2"');
        const buffer = (this._buffer = mediaSource.addSourceBuffer(type));
        buffer.onupdateend = () => this.flush();
        buffer.onabort = () => {
            try {
                mediaSource.removeSourceBuffer(buffer);
            } catch (_) {}
            if (this._buffer) {
                // is not a manual call to abort()!
                this.abort();
                this.onError({ type: 'MediaBufferError', name: 'SourceBuffer aborted', mimeType: this._mimeType });
            }
        };

        this._cmafWriter = new CMAFWriter();
        this._cmafWriter.log = this.log.bind(this) as ILog;
        this._cmafWriter.onWrite = packet => {
            if (packet.length) {
                this._packets.push(packet);
                this.flush();
            }
        };
        if (isAlreadyCMAF) {
            this._cmafWriter.init = () => undefined;
            this._cmafWriter.write = sample => this._cmafWriter.onWrite(sample.data);
        }
    }

    append(metadata: Metadata, trackId: number, sample: Media.Sample) {
        if (trackId !== this._trackId) {
            // INIT
            const track = metadata.tracks.get(trackId);
            if (!track) {
                this.onError({ type: 'MediaBufferError', name: 'Track without metadata', track: trackId });
                return;
            }
            // to call changeType, before cmafWriter.init!
            const packet = this._mimeType + '; codecs="' + track.codecString + '"';
            this.log(`Update track${this._trackId == null ? ' ' : ` from ${this._trackId} to `}${trackId} ${packet}`).info();
            this._trackId = trackId;
            this._packets.push(packet);
            const error = this._cmafWriter.init(track);
            if (error) {
                this.onError(error);
                return;
            }
        }
        this._cmafWriter.write(sample);
        return this;
    }

    flush(fixHole = false) {
        if (!this._buffer) {
            return;
        }

        let update = false;

        try {
            // protected this._buffer.buffered access
            while (!this._buffer.updating) {
                // Remove possible hole unresolvable
                if (this._buffer.buffered.length > 1 && (fixHole || this._waitBFrames > MAX_CONSECUTIVE_BFRAME)) {
                    this._waitBFrames = 0;
                    const beginHole = this._buffer.buffered.end(0);
                    const endHole = this._buffer.buffered.start(1);
                    update = true;
                    // user a startTime marker because the buffer removing can not be supported by few old browsers
                    this._startTime = Math.max(this._startTime, endHole);
                    this.log(`Remove ${(endHole - beginHole).toFixed(3)}s of timeline from ${beginHole}s to ${endHole}s`)[
                        this._isVideo ? 'error' : 'warn'
                    ]();
                }

                // remove first part if need
                if (this._buffer.buffered.length > 0 && this._startTime > this._buffer.buffered.start(0)) {
                    try {
                        // Remove is an asynchronous operation
                        this._buffer.remove(0, this._startTime);
                        update = true;
                        continue;
                    } catch (_) {
                        // ignore error : can throw exception if not implemented (Safari)
                    }
                }

                try {
                    // try catch for appendBuffer + this._buffer.buffered access
                    const packet = this._packets[0];
                    if (this._buffer.updating || !packet) {
                        break;
                    }
                    if (typeof packet === 'string') {
                        if (this._buffer.changeType) {
                            this._buffer.changeType(packet);
                        }
                    } else {
                        if (this._isVideo && this._buffer.buffered.length > 1) {
                            ++this._waitBFrames;
                        } else {
                            this._waitBFrames = 0;
                        }
                        this._buffer.appendBuffer(packet);
                        this.onDataAppended(packet);
                    }
                    this._packets.shift(); // shift just on appendBuffer success
                    update = true;
                } catch (e: unknown) {
                    if (isQuotaExceededError(e)) {
                        this.onError({ type: 'MediaBufferError', name: 'Exceeds buffer size' });
                    } else {
                        this.onError({ type: 'MediaBufferError', name: 'Append buffer issue', detail: Util.stringify(e) });
                    }
                    return; // avoid an infinite loop
                }
            }
        } catch (_) {}

        if (!update) {
            return;
        }

        // Add this._packets.length check in the condition to keep calm loading state
        // In this case call onProgress every PROGRESS_TIMEOUT
        if (this._packets.length) {
            const now = Util.time();
            if (!this._updateTimeout) {
                this._updateTimeout = now + UPDATE_TIMEOUT;
            }
            if (now < this._updateTimeout) {
                return;
            }
            this.log('Force onUpdate').warn();
        }
        this._updateTimeout = 0;
        if (this._onUpdating) {
            // prevent a recursive call !
            return;
        }
        this._onUpdating = true;
        this.onUpdate();
        this._onUpdating = false;
    }

    abort() {
        const buffer = this._buffer;
        if (!buffer) {
            // already aborted!
            return;
        }
        this._buffer = undefined;
        buffer.onupdateend = null; // to prevent an infinite loop
        this.flush(); // try to flush
        try {
            buffer.abort(); // will empty this._packets (see onabort event)
        } catch (_) {}
        this._packets.length = 0;
    }
}
