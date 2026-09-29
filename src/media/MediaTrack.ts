/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */
import * as Media from './Media';

export class MediaTrack {
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
    /**
     * Whether smooth playback support is limited by the browser.
     */
    limitedSupport?: boolean;

    up?: MediaTrack; // track up by ascending MAXBPS
    down?: MediaTrack; // track down by ascending MAXBPS

    private _id: number;

    constructor(id: number) {
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
     * Detect limited playback support.
     */
    async detectSupportLimit(): Promise<boolean | undefined> {
        if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) {
            return (this.limitedSupport = undefined);
        }

        const type = Media.typeToString(this.type);
        const configuration = {
            type: 'media-source',
            [type]: {
                contentType: `video/mp4; codecs="${this.codecString}"`,
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
            this.limitedSupport = !result.supported || !result.smooth;
        } catch {
            // Preserve playback when Media Capabilities cannot evaluate this configuration.
            this.limitedSupport = undefined;
        }
        return this.limitedSupport;
    }
}
