/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */
import { Loggable } from '@ceeblue/web-utils';
import * as Media from './Media';

export class MediaTrack extends Loggable {
    /**
     * Track id
     */
    get id(): number {
        return this._id;
    }
    /**
     * Type of the track
     */
    type: Media.Type = 0;
    /**
     * Codec
     */
    codec: Media.Codec = Media.Codec.UNKNOWN;
    /**
     * Codec string details according to RFC 6381 (ex: mp4a.40)
     */
    codecString: string = '';
    /**
     * Current time of the track in milliseconds
     */
    currentTime: number = 0;
    /**
     * Max bandwidth in Bps
     */
    bandwidth: number = 0;
    /**
     * SampleRate for audio (ex: 48000), or Frame per Sec for Video (ex: 25)
     */
    rate: number = 0;
    /**
     * Video Resolution
     */
    resolution: Media.Resolution = { width: 0, height: 0 };
    /**
     * Audio channels count
     */
    channels: number = 0;
    /**
     * Language of the track in ISO639-2, for example for subtitle or audio tracks
     */
    language?: string;
    /**
     * Config packet
     */
    config?: Uint8Array;
    /**
     * Content Protection
     */
    contentProtection?: string;

    up?: MediaTrack; // track up by ascending MAXBPS
    down?: MediaTrack; // track down by ascending MAXBPS

    private _id: number;

    constructor(id: number) {
        super();
        this._id = id;
    }

    /**
     * Build a name for the track
     */
    toString(): string {
        let name: string = this.codec;
        if (!name) {
            name = this.id.toFixed();
        }
        if (this.type === Media.Type.VIDEO) {
            name += ' ' + this.resolution.width + 'x' + this.resolution.height;
        } else if (this.type === Media.Type.AUDIO) {
            name += ' ' + this.channels + 'ch';
        }
        name += ' ' + this.rate.toFixed() + (this.type === Media.Type.VIDEO ? 'fps' : 'hz');
        name += ' ' + ((this.bandwidth * 8) / 1000).toFixed() + 'kbps';
        return name;
    }

    /**
     * Checks whether this track can be decoded through Media Source Extensions.
     *
     * Data tracks are considered supported because they do not require media decoding. Audio and video tracks are
     * evaluated with the Media Capabilities API using their codec, bitrate, and type-specific properties.
     *
     * @returns `1` when the track is supported, `0` when it is explicitly unsupported, or `-1` when support cannot be
     * determined because the Media Capabilities API is unavailable or rejects the configuration.
     */
    async checkSupport(): Promise<number> {
        if (this.type === Media.Type.DATA) {
            // Data track always supported!
            return 1;
        }
        if (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.decodingInfo) {
            const type = Media.typeToString(this.type);
            const configuration = {
                type: 'media-source',
                [type]: {
                    contentType: `${type}/mp4; codecs="${this.codecString}"`,
                    bitrate: this.bandwidth * 8 // convert to bps
                }
            } as MediaDecodingConfiguration;
            if (configuration.audio) {
                configuration.audio.samplerate = this.rate;
            } else if (configuration.video) {
                Object.assign(configuration.video, {
                    framerate: this.rate,
                    width: this.resolution.width,
                    height: this.resolution.height
                });
            }
            try {
                const result = await navigator.mediaCapabilities.decodingInfo(configuration);
                return result.supported ? 1 : 0;
            } catch {
                this.log('Invalid MediaCapabilities configuration', configuration).warn();
            }
        }
        return -1; // unknown
    }
}
