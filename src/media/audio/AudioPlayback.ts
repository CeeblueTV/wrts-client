/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ILog, Loggable, Util } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { MediaTrack } from '../MediaTrack';
import { Metadata } from '../Metadata';
import { createAudioDecoder } from './AudioDecoders';
import { AudioRenderer } from './AudioRenderer';
import { AudioEngine, PCMDecoder } from './PCMDecoder';

const MAX_DECODER_FAILURES = 3;
const DECODER_RECOVERY = 100; // number of PCM decoded to forget the previous decoder failures
const DECODE_AHEAD = 10; // seconds of audio decoded ahead of the playback, the next samples wait compressed
const MAX_QUEUE_SIZE = 12 * 1024 * 1024; // bytes of compressed samples waiting, the audio quota of Media Source Extensions
const OVERFLOW_PERIOD = 1000; // ms, minimum delay between two overflow signals
const MAX_DECODING = 100; // samples being decoded at most, to not decode a burst of samples in one go
const DECODING_TIMEOUT = 1000; // ms without output to consider that the decoder has nothing more to output

export type AudioPlaybackError =
    /**
     * Represents an audio decoding issue
     */
    | { type: 'AudioPlaybackError'; name: 'Audio decoder error'; detail: string }
    /**
     * Represents an audio rendering issue
     */
    | { type: 'AudioPlaybackError'; name: 'Audio renderer error'; detail: string }
    /**
     * Represents a track without metadata error
     */
    | { type: 'MediaBufferError'; name: 'Track without metadata'; track: number }
    /**
     * Represents an exceeding buffer size issue
     */
    | { type: 'MediaBufferError'; name: 'Exceeds buffer size' };

/**
 * Plays the audio samples outside of the video element: decodes them with a {@link PCMDecoder}
 * and renders the PCM with an {@link AudioRenderer}, whose media time is the clock of the playback.
 *
 * It is the audio counterpart of {@link MediaBuffer}, which gives the samples to a media element.
 */
export class AudioPlayback extends Loggable {
    /**
     * Event fire on {@link AudioPlaybackError}
     * @event
     */
    onError(error: AudioPlaybackError) {
        this.log(error).error();
    }

    /**
     * Fired when more audio is available to play
     * @event
     */
    onUpdate() {}

    /**
     * Fired periodically while the audio playback is opened, see {@link AudioRenderer.onTick}
     * @event
     */
    onTick() {}

    /**
     * Renderer of the decoded audio
     */
    get renderer(): AudioRenderer {
        return this._renderer;
    }

    /**
     * Engine currently decoding the audio, undefined before the first sample
     */
    get engine(): AudioEngine | undefined {
        return this._decoder?.engine;
    }

    get startTime(): number {
        return this._renderer.startTime;
    }
    set startTime(value: number) {
        this._renderer.startTime = value;
    }

    get endTime(): number {
        // Includes the samples waiting to be decoded, when enough audio is already decoded
        return this._holding ? Math.max(this._renderer.endTime, this._queueEnd) : this._renderer.endTime;
    }

    private _renderer: AudioRenderer;
    private _decoder?: PCMDecoder;
    private _track?: MediaTrack;
    private _trackId?: number;
    private _queue: Array<MediaTrack | Media.Sample> = [];
    private _pumping: boolean = false;
    private _closed: boolean = false;
    private _failures: number = 0;
    private _failed: Set<AudioEngine> = new Set(); // engines unable to decode the stream
    private _decoded: number = 0; // PCM decoded since the decoder is opened
    private _decoderId: number = 0; // identifier of the decoder opened
    private _queueSize: number = 0; // bytes of samples in the queue
    private _queueEnd: number = 0; // end time in seconds of the last sample queued
    private _decoding: number = 0; // samples given to the decoder and not decoded yet
    private _decodedTime: number = 0; // time of the last PCM decoded
    private _holding: boolean = false; // samples are waiting in the queue because enough audio is decoded
    private _overflowed: number = 0;

    constructor() {
        super();
        this._renderer = new AudioRenderer();
        this._renderer.log = this.log.bind(this) as ILog;
        this._renderer.onUpdate = () => this.onUpdate();
        this._renderer.onTick = () => this._onTick();
        this._renderer.onOverflow = () => this.onError({ type: 'MediaBufferError', name: 'Exceeds buffer size' });
        this._renderer.onError = detail => this.onError({ type: 'AudioPlaybackError', name: 'Audio renderer error', detail });
    }

    append(metadata: Metadata, trackId: number, sample: Media.Sample) {
        if (this._closed) {
            return;
        }
        if (trackId !== this._trackId) {
            const track = metadata.tracks.get(trackId);
            if (!track) {
                this.onError({ type: 'MediaBufferError', name: 'Track without metadata', track: trackId });
                return;
            }
            if (track.contentProtection) {
                // Only a media element can decrypt it, never give protected samples to a decoder: it would play noise
                this.onError({
                    type: 'AudioPlaybackError',
                    name: 'Audio decoder error',
                    detail: `Audio track ${trackId} is protected, it can only be played by the video element`
                });
                return;
            }
            this._trackId = trackId;
            // The decoder is reconfigured once the samples of the previous track are decoded
            this._queue.push(track);
        }
        this._queue.push(sample);
        this._queueSize += sample.data.byteLength;
        this._queueEnd = (sample.time + sample.duration) / 1000;
        this._pump();
        if (this._holding) {
            // Not decoded now, but the audio available has progressed
            if (this._queueSize > MAX_QUEUE_SIZE) {
                const now = Util.time();
                if (now - this._overflowed >= OVERFLOW_PERIOD) {
                    this._overflowed = now;
                    this.onError({ type: 'MediaBufferError', name: 'Exceeds buffer size' });
                }
            }
            if (!this._closed) {
                this.onUpdate();
            }
        }
        return this;
    }

    /**
     * Move the playback to this media time in seconds
     */
    seek(time: number) {
        if (this._closed) {
            return;
        }
        if (this._holding && time > this._renderer.endTime) {
            // Seek beyond the audio decoded: useless to decode the samples before
            const queue = this._queue;
            let count = 0;
            for (const item of queue) {
                if (!(item instanceof MediaTrack)) {
                    if ((item.time + item.duration) / 1000 > time) {
                        break;
                    }
                    this._queueSize -= item.data.byteLength;
                }
                ++count;
            }
            // keep the last track change skipped, to decode the next samples with their codec configuration
            let track: MediaTrack | undefined;
            for (const item of queue.splice(0, count)) {
                if (item instanceof MediaTrack) {
                    track = item;
                }
            }
            if (track) {
                queue.unshift(track);
            }
        }
        this._renderer.seek(time);
        this._pump();
    }

    /**
     * Nothing to flush, the samples are decoded on reception
     */
    flush() {}

    abort() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._queue.length = 0;
        this._queueSize = 0;
        this._closeDecoder();
        this._renderer.close();
    }

    /**
     * Decode the queue in order, it waits only when a decoder has to be created
     */
    private async _pump() {
        if (this._pumping) {
            return;
        }
        this._pumping = true;
        try {
            while (this._queue.length && !this._closed) {
                // Decode only the audio to play soon: PCM is heavy, the next samples wait compressed
                // (case of a long pause, or of a playback far from the live)
                const renderer = this._renderer;
                const position = Math.max(renderer.currentTime, renderer.startTime);
                this._holding = renderer.endTime > 0 && renderer.endTime - position > DECODE_AHEAD;
                if (this._holding || this._decoding >= MAX_DECODING) {
                    break; // continue on the next tick, or on the next PCM decoded
                }
                const item = this._queue.shift() as MediaTrack | Media.Sample;
                if (item instanceof MediaTrack) {
                    const opening = this._configure(item);
                    if (opening) {
                        await opening;
                    }
                } else {
                    this._queueSize -= item.data.byteLength;
                    if (this._decoder) {
                        ++this._decoding;
                        this._decoder.decode(item);
                    }
                }
            }
            if (!this._queue.length) {
                this._holding = false;
            }
        } finally {
            this._pumping = false;
        }
    }

    private _onTick() {
        if (this._decoding && Util.time() - this._decodedTime > DECODING_TIMEOUT) {
            this._decoding = 0; // samples without output
        }
        if (this._queue.length) {
            this._pump(); // the playback has progressed
        }
        if (!this._closed) {
            this.onTick();
        }
    }

    private _configure(track: MediaTrack): Promise<void> | undefined {
        this._track = track;
        if (this._decoder) {
            try {
                this._decoder.configure(track);
                return;
            } catch (e) {
                this.log(`Audio track ${track.id} unsupported by ${this._decoder.engine} decoder`, e).warn();
                this._closeDecoder();
            }
        }
        return this._open(track);
    }

    private async _open(track: MediaTrack) {
        let decoder: PCMDecoder;
        try {
            decoder = await createAudioDecoder(track, this._failed);
        } catch (e) {
            this.onError({
                type: 'AudioPlaybackError',
                name: 'Audio decoder error',
                detail: e instanceof Error ? e.message : String(e)
            });
            return;
        }
        if (this._closed) {
            decoder.close();
            return;
        }
        this._decoder = decoder;
        this._decoded = 0;
        this._decoding = 0;
        decoder.log = this.log.bind(this) as ILog;
        decoder.onPCM = pcm => {
            if (++this._decoded === DECODER_RECOVERY) {
                this._failures = 0;
            }
            this._decodedTime = Util.time();
            const waiting = this._decoding >= MAX_DECODING;
            this._decoding = Math.max(0, this._decoding - 1);
            this._renderer.append(pcm);
            if (waiting) {
                this._pump();
            }
        };
        // Identify the decoder by a number rather than by its reference: this object can be seen through a proxy when an
        // application wraps the player in a reactive state (Vue for example), and a proxy differs from its target
        const id = ++this._decoderId;
        decoder.onError = detail => this._onDecoderError(id, detail);
        this.log(`Initiate track and codec to ${track.id} ${track.codecString}, decoded with ${decoder.engine}`).info();
    }

    private _onDecoderError(id: number, detail: string) {
        const decoder = this._decoder;
        if (!decoder || id !== this._decoderId || this._closed) {
            return;
        }
        const track = this._track;
        if (!this._decoded) {
            // Unable to decode anything, try with another engine
            this._failed.add(decoder.engine);
        }
        this._closeDecoder();
        if (!track || ++this._failures > MAX_DECODER_FAILURES) {
            this.onError({ type: 'AudioPlaybackError', name: 'Audio decoder error', detail });
            return;
        }
        this.log(`Audio decoder ${decoder.engine} failed, restart it (${detail})`).warn();
        this._queue.unshift(track);
        this._pump();
    }

    private _closeDecoder() {
        const decoder = this._decoder;
        if (!decoder) {
            return;
        }
        this._decoder = undefined;
        this._decoding = 0;
        decoder.onPCM = decoder.onError = () => {};
        decoder.close();
    }
}
