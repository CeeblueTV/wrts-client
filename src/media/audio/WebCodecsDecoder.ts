/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Util } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { MediaTrack } from '../MediaTrack';
import { AudioEngine, PCM, PCMDecoder, audioParameters } from './PCMDecoder';

const CALIBRATION_SAMPLES = 4; // number of first samples compared with the first output to find the decoder delay
const CALIBRATION_TOLERANCE = 5000; // microseconds
const MAX_DECODER_DELAY = 2; // samples kept by a decoder before to output

/**
 * Copy the audio data to planar 32-bit float samples, stamped with the media `time` in seconds
 */
function toPCM(data: AudioData, time: number): PCM {
    const frames = data.numberOfFrames;
    const count = data.numberOfChannels;
    const channels = new Array<Float32Array>();
    try {
        // Every implementation must support the conversion to f32-planar
        for (let c = 0; c < count; ++c) {
            const channel = new Float32Array(frames);
            data.copyTo(channel, { planeIndex: c, format: 'f32-planar' });
            channels.push(channel);
        }
    } catch (_) {
        // Convert manually from the native format
        channels.length = 0;
        const format = String(data.format);
        const planar = format.endsWith('-planar');
        const Samples = format.startsWith('f32')
            ? Float32Array
            : format.startsWith('s16')
              ? Int16Array
              : format.startsWith('s32')
                ? Int32Array
                : Uint8Array;
        const scale = Samples === Float32Array ? 1 : Samples === Int16Array ? 32768 : Samples === Int32Array ? 2147483648 : 128;
        const offset = Samples === Uint8Array ? 128 : 0;
        let samples = new Samples(0);
        for (let c = 0; c < count; ++c) {
            if (planar || !c) {
                const options = { planeIndex: planar ? c : 0 };
                samples = new Samples(data.allocationSize(options) / Samples.BYTES_PER_ELEMENT);
                data.copyTo(samples, options);
            }
            const channel = new Float32Array(frames);
            const step = planar ? 1 : count;
            for (let i = 0, p = planar ? 0 : c; i < frames; ++i, p += step) {
                channel[i] = (samples[p] - offset) / scale;
            }
            channels.push(channel);
        }
    }
    return { time, sampleRate: data.sampleRate, channels };
}

/**
 * Audio decoder using the WebCodecs API of the browser.
 *
 * The PCM is stamped with the time of the sample it comes from, and not with the timestamp given by the browser:
 * browsers can rebuild the output timestamps by counting the frames decoded from the first sample, which ignores
 * the holes of the stream and drifts from its timestamps. Samples and outputs are matched in order, one for one.
 */
export class WebCodecsDecoder extends PCMDecoder {
    /**
     * True if the browser implements the audio decoding of WebCodecs
     */
    static get available(): boolean {
        return typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined';
    }

    /**
     * Returns true if the browser is able to decode the track
     */
    static async supports(track: MediaTrack): Promise<boolean> {
        if (!WebCodecsDecoder.available) {
            return false;
        }
        try {
            const support = await AudioDecoder.isConfigSupported(WebCodecsDecoder._config(track));
            return support.supported ? true : false;
        } catch (_) {
            return false;
        }
    }

    private static _config(track: MediaTrack): AudioDecoderConfig {
        const parameters = audioParameters(track);
        const config: AudioDecoderConfig = {
            codec: parameters.codecString,
            sampleRate: parameters.sampleRate,
            numberOfChannels: parameters.channels
        };
        if (parameters.config && parameters.codec !== Media.Codec.MP3) {
            config.description = parameters.config;
        }
        return config;
    }

    get engine(): AudioEngine {
        return AudioEngine.WEBCODECS;
    }

    private _decoder?: AudioDecoder;
    private _times: number[] = []; // time in milliseconds of the samples being decoded, in order
    private _calibrated: boolean = false;

    configure(track: MediaTrack) {
        let decoder = this._decoder;
        if (!decoder || decoder.state === 'closed') {
            this._times.length = 0;
            this._calibrated = false;
            decoder = this._decoder = new AudioDecoder({
                output: data => {
                    let pcm: PCM | undefined;
                    try {
                        pcm = toPCM(data, this._outputTime(decoder as AudioDecoder, data));
                    } catch (e) {
                        this._fail(decoder, 'PCM conversion, ' + Util.stringify(e));
                    }
                    data.close();
                    if (pcm && decoder === this._decoder) {
                        this.onPCM(pcm);
                    }
                },
                error: e => this._fail(decoder, e.message || Util.stringify(e))
            });
        }
        // The decoding of the samples already submitted ends before this new configuration is applied
        decoder.configure(WebCodecsDecoder._config(track));
    }

    decode(sample: Media.Sample) {
        const decoder = this._decoder;
        if (!decoder) {
            return;
        }
        this._times.push(sample.time);
        try {
            decoder.decode(
                new EncodedAudioChunk({
                    type: 'key',
                    timestamp: Math.round(sample.time * 1000),
                    duration: Math.round(sample.duration * 1000),
                    data: sample.data
                })
            );
        } catch (e) {
            this._fail(decoder, Util.stringify(e));
        }
    }

    /**
     * Media time in seconds of an output: the time of the sample it comes from
     */
    private _outputTime(decoder: AudioDecoder, data: AudioData): number {
        const times = this._times;
        let skip = 0;
        if (!this._calibrated) {
            // A decoder can output nothing for its first samples: the first output tells which sample it comes from
            this._calibrated = true;
            let best = CALIBRATION_TOLERANCE;
            for (let i = 0; i < Math.min(times.length, CALIBRATION_SAMPLES); ++i) {
                const distance = Math.abs(times[i] * 1000 - data.timestamp);
                if (distance < best) {
                    best = distance;
                    skip = i;
                }
            }
        } else {
            // Samples left without output (undecodable) would shift all the next times
            skip = times.length - 1 - decoder.decodeQueueSize - MAX_DECODER_DELAY;
        }
        if (skip > 0) {
            times.splice(0, skip);
        }
        const time = times.shift();
        return time == null ? data.timestamp / 1000000 : time / 1000;
    }

    close() {
        const decoder = this._decoder;
        this._decoder = undefined;
        this._times.length = 0;
        try {
            decoder?.close();
        } catch (_) {}
    }

    private _fail(decoder: AudioDecoder | undefined, detail: string) {
        if (decoder !== this._decoder) {
            return; // already closed
        }
        this.close();
        this.onError(detail);
    }
}
