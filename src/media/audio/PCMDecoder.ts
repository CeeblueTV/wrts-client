/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Loggable } from '@ceeblue/web-utils';
import * as Media from '../Media';
import { MediaTrack } from '../MediaTrack';

/**
 * How an audio track is decoded and rendered
 */
export enum AudioEngine {
    /**
     * Decoded with the WebCodecs API of the browser, and rendered with the Web Audio API
     */
    WEBCODECS = 'webcodecs',
    /**
     * Decoded with the WebAssembly build of libavcodec shipped with the library, and rendered with the Web Audio API
     */
    WASM = 'wasm',
    /**
     * Decoded and rendered by the video element through the Media Source Extensions,
     * the only way to play a protected audio track
     */
    MSE = 'mse'
}

/**
 * Decoded audio
 */
export type PCM = {
    /**
     * Media time of the first frame in seconds
     */
    time: number;
    /**
     * Number of frames per second
     */
    sampleRate: number;
    /**
     * Samples of each channel, in the range [-1, 1]
     */
    channels: Float32Array[];
};

/**
 * Parameters to decode an audio track
 */
export type AudioParameters = {
    codec: Media.Codec;
    /**
     * Codec string according to RFC 6381, in the form expected by WebCodecs
     */
    codecString: string;
    sampleRate: number;
    channels: number;
    /**
     * Codec configuration, AudioSpecificConfig for AAC
     */
    config?: Uint8Array;
};

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Compute the parameters to decode an audio track
 */
export function audioParameters(track: MediaTrack): AudioParameters {
    const config = track.config?.byteLength ? track.config : undefined;
    let sampleRate = track.rate;
    let channels = track.channels;
    let codecString = track.codecString.trim().toLowerCase();
    switch (track.codec) {
        case Media.Codec.AAC:
            if (config && config.byteLength >= 2 && config[0] >> 3 !== 31) {
                // complete with the AudioSpecificConfig
                const rateIndex = ((config[0] & 7) << 1) | (config[1] >> 7);
                sampleRate = sampleRate || AAC_RATES[rateIndex] || 0;
                channels = channels || (config[1] >> 3) & 0x0f;
            }
            if (!/^mp4a\.40\.\d+$/.test(codecString)) {
                codecString = 'mp4a.40.' + (config && config[0] >> 3 !== 31 ? config[0] >> 3 : 2);
            }
            break;
        case Media.Codec.MP3:
            codecString = 'mp3';
            break;
        case Media.Codec.OPUS:
            codecString = 'opus';
            break;
        default:
    }
    return { codec: track.codec, codecString, sampleRate: sampleRate || 48000, channels: channels || 2, config };
}

/**
 * Audio decoder, compressed {@link Media.Sample} in, {@link PCM} out
 */
export abstract class PCMDecoder extends Loggable {
    /**
     * Event fired when audio is decoded
     * @event
     */
    onPCM(pcm: PCM) {}

    /**
     * Event fired when the decoder fails, it must be closed
     * @event
     */
    onError(detail: string) {
        this.log(detail).error();
    }

    /**
     * Engine of the decoder
     */
    abstract get engine(): AudioEngine;

    /**
     * Configure the decoder for the track, can be called again to change the track.
     * It throws an exception if the track is not supported.
     */
    abstract configure(track: MediaTrack): void;

    /**
     * Decode a sample of the track configured
     */
    abstract decode(sample: Media.Sample): void;

    /**
     * Release the decoder
     */
    abstract close(): void;
}
