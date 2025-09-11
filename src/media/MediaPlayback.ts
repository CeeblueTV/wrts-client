/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ILog, Loggable, Util } from '@ceeblue/web-utils';
import { MediaBuffer, MediaBufferError } from './MediaBuffer';
import * as Media from './Media';
import { Metadata } from './Metadata';

export type MediaPlaybackError =
    /**
     * Represents a Media Buffer creation issue
     */
    | { type: 'MediaPlaybackError'; name: 'Media buffer init error'; mimeType: string; detail: string }
    /**
     * Represents an error when attempting to create a new track
     */
    | { type: 'MediaPlaybackError'; name: 'Cannot create a new track'; trackType: Media.Type }
    /**
     * Represents an error when attempting to remove a track
     */
    | { type: 'MediaPlaybackError'; name: 'Cannot remove a track'; trackType: Media.Type }
    /**
     * Represents a Media Buffer issue
     */
    | MediaBufferError;

export class MediaPlayback extends Loggable {
    /**
     * Fired on renderer close
     * @param error error description on an improper closure
     * @event
     */
    onClose(error?: MediaPlaybackError) {
        if (error) {
            this.log('onClose', error).error();
        } else {
            this.log('onClose').info();
        }
    }

    /**
     * Fired when the playback buffer exceeds its capacity,
     * a play or set a startTime to remove the beginning can resolve the situation
     * @event
     */
    onBufferOverflow() {
        this.log('buffer overflow').warn();
    }

    /**
     * Fired when the renderer makes progress in time.
     * @event
     */
    onProgress() {}

    /**
     * Event fire when audio data are appended to the renderer, basically here to debug MSE ingestion
     * @event
     */
    onAudioAppended(data: Uint8Array) {}

    /**
     * Event fire when video data are appended to the renderer, basically here to debug MSE ingestion
     * @event
     */
    onVideoAppended(data: Uint8Array) {}

    /**
     * Renderer is closed
     */
    get closed(): boolean {
        return this._audioBuffer == null && this._videoBuffer == null;
    }

    get startTime(): number {
        // Start time is the first common sync time between the tracks
        // Considerate also case where a track is disabled
        if (this._audioBuffer) {
            if (this._videoBuffer) {
                return Math.max(this._audioBuffer.startTime, this._videoBuffer.startTime);
            }
            return this._audioBuffer.startTime;
        }
        return this._videoBuffer?.startTime || 0;
    }
    set startTime(value: number) {
        if (this._videoBuffer) {
            this._videoBuffer.startTime = value;
        }
        if (this._audioBuffer) {
            this._audioBuffer.startTime = value;
        }
    }

    get endTime(): number {
        // Start time is the last common sync time between the tracks
        // Considerate also case where a track is disabled
        if (this._audioBuffer) {
            if (this._videoBuffer) {
                if (this._videoBuffer.endTime > this._audioBuffer.endTime) {
                    return Math.max(this._videoBuffer.startTime, this._audioBuffer.endTime);
                }
                return Math.max(this._audioBuffer.startTime, this._videoBuffer.endTime);
            }
            return this._audioBuffer.endTime;
        }
        return this._videoBuffer?.endTime || 0;
    }

    get audioEnabled(): boolean {
        return this._audioBuffer ? true : false;
    }

    set audioEnabled(value: boolean) {
        if (this.audioEnabled === value) {
            return;
        }
        if (value) {
            // enable audio
            this._audioBuffer = this._newBuffer('audio/mp4');
        } else {
            // disable impossible
            this.close({ type: 'MediaPlaybackError', name: 'Cannot remove a track', trackType: Media.Type.AUDIO });
        }
    }

    get videoEnabled(): boolean {
        return this._videoBuffer ? true : false;
    }

    set videoEnabled(value: boolean) {
        if (this.videoEnabled === value) {
            return;
        }
        if (value) {
            // enable video
            this._videoBuffer = this._newBuffer('video/mp4');
        } else {
            // disable impossible
            this.close({ type: 'MediaPlaybackError', name: 'Cannot remove a track', trackType: Media.Type.VIDEO });
        }
    }

    private _audioBuffer?: MediaBuffer;
    private _videoBuffer?: MediaBuffer;
    private _mediaSource?: MediaSource;
    private _passthroughCMAF: boolean;
    private _endPrevTime?: number;

    constructor(mediaSource: MediaSource, passthroughCMAF: boolean = false) {
        super();
        this._passthroughCMAF = passthroughCMAF;
        this._mediaSource = mediaSource;
    }

    appendAudio(metadata: Metadata, trackId: number, sample: Media.Sample) {
        this.log('AUDIO', trackId, Util.stringify(sample, { noBin: true })).debug();
        if (this._audioBuffer) {
            this._audioBuffer.append(metadata, trackId, sample);
        } else {
            this.close({ type: 'MediaPlaybackError', name: 'Cannot create a new track', trackType: Media.Type.VIDEO });
        }
    }

    appendVideo(metadata: Metadata, trackId: number, sample: Media.Sample) {
        this.log('VIDEO', trackId, Util.stringify(sample, { noBin: true })).debug();
        if (this._videoBuffer) {
            this._videoBuffer.append(metadata, trackId, sample);
        } else {
            this.close({ type: 'MediaPlaybackError', name: 'Cannot create a new track', trackType: Media.Type.VIDEO });
        }
    }

    flush(fixHole = false) {
        this._audioBuffer?.flush(fixHole);
        this._videoBuffer?.flush(fixHole);
    }

    close(error?: MediaPlaybackError) {
        const mediaSource = this._mediaSource;
        if (!mediaSource) {
            // alreayd closed
            return;
        }
        this._mediaSource = undefined;

        if (this._audioBuffer) {
            this._audioBuffer.abort();
            this._videoBuffer = undefined;
        }
        if (this._videoBuffer) {
            this._videoBuffer.abort();
            this._videoBuffer = undefined;
        }
        try {
            // can fail with something like 'The MediaSource's readyState is not 'open'.'
            mediaSource.endOfStream();
        } catch (_) {}
        this._endPrevTime = undefined;
        this.onClose(error);
    }

    private _newBuffer(mimeType: string): MediaBuffer | undefined {
        if (!this._mediaSource) {
            // closed
            return;
        }
        // Create buffer
        let buffer: MediaBuffer;
        try {
            // try catch because can throw exception without assigned a video.error reason!
            buffer = new MediaBuffer(this._mediaSource, mimeType, this._passthroughCMAF);
        } catch (e) {
            this.close({
                type: 'MediaPlaybackError',
                name: 'Media buffer init error',
                detail: Util.stringify(e),
                mimeType
            });
            return;
        }
        buffer.onDataAppended = buffer.isVideo ? data => this.onVideoAppended(data) : data => this.onAudioAppended(data);
        buffer.log = this.log.bind(this, buffer.isVideo ? 'VideoBuffer:' : 'AudioBuffer:') as ILog;
        buffer.onError = (error: MediaBufferError) => {
            if (error.name === 'Exceeds buffer size') {
                this.onBufferOverflow();
            } else {
                this.close(error);
            }
        };
        buffer.onUpdate = this._onBufferUpdate.bind(this);
        return buffer;
    }

    private _onBufferUpdate() {
        if (this._endPrevTime == null || this.endTime > this._endPrevTime) {
            this._endPrevTime = this.endTime;
            this.onProgress();
        }
    }
}
