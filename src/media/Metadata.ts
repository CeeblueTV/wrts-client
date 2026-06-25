/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, Util, Loggable } from '@ceeblue/web-utils';
import * as Media from './Media';
import * as AVC from './AVC';
import { MediaTrack } from './MediaTrack';

export enum ProtectionScheme {
    CENC = 0x63656e63, // (AES-CTR)
    CBC1 = 0x63626331, // (AES-CBC)
    CENS = 0x63656e73, // (AES-CTR with subsamples)
    CBCS = 0x63626373 // (AES-CBC with subsamples)
}

export type ContentProtection = {
    /**
     * Scheme
     */
    scheme: ProtectionScheme;
    /**
     * Key ID
     */
    kid: string;
    /**
     * Initialization Vector (undefined when ivMode === 'sample')
     */
    iv?: string;
    /**
     * Initialization Vector mode:
     * - 'constant' (default): one IV reused for every sample, carried in metadata
     * - 'sample': each sample carries its own IV in Media.Sample.iv
     */
    ivMode: 'constant' | 'sample';
    /**
     * Map of ID of the DRM system to PSSH box
     */
    pssh: Map<string, string>;
};

/**
 * Metadata representation
 */
export class Metadata extends Loggable {
    /**
     * The version of the protocol
     */
    protocolVersion: {
        major: number;
        minor: number;
        patch: number;
    } = { major: 0, minor: 0, patch: 0 };
    /**
     * Date of Metadata creation
     */
    date: Date = new Date();
    /**
     * Live time in milliseconds
     */
    get liveTime(): number {
        return this._liveTimeValue + (Util.time() - this._liveTimeWhen);
    }
    set liveTime(value: number) {
        this._liveTimeValue = value;
        this._liveTimeWhen = Util.time();
    }
    /**
     * Tracks sorted by descending BPS
     */
    tracks: Map<number, MediaTrack> = new Map<number, MediaTrack>();
    /**
     * Audio tracks sorted by descending BPS
     */
    audioTracks: Array<MediaTrack> = [];
    /**
     * Video tracks sorted by descending BPS
     */
    videoTracks: Array<MediaTrack> = [];
    /**
     * Data track
     */
    dataTracks: Array<MediaTrack> = [];
    /**
     * Map of List of ContentProtection
     */
    contentProtection: Map<string, ContentProtection> = new Map<string, ContentProtection>();

    private _liveTimeValue: number = 0;
    private _liveTimeWhen: number = Util.time();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(obj?: any) {
        super();
        if (obj == null) {
            return;
        }
        if (typeof obj.version === 'string') {
            const parts = obj.version.split('.');
            this.protocolVersion.major = parseInt(parts[0]) || 0;
            this.protocolVersion.minor = parseInt(parts[1]) || 0;
            this.protocolVersion.patch = parseInt(parts[2]) || 0;
        } else if (typeof obj.version === 'number') {
            this.protocolVersion.major = obj.version;
        }

        this._liveTimeValue = Number(obj.currentTime) || Number(obj.liveTime) || this._liveTimeValue;
        if (String(this._liveTimeValue).indexOf('.') >= 0) {
            // Force in milliseconds!
            this._liveTimeValue *= 1000;
        }

        const tracks = Array.isArray(obj.tracks) ? obj.tracks : [];
        for (const track of tracks) {
            const size = this.tracks.size;
            const mTrack = new MediaTrack(track.id ?? size);
            mTrack.codecString = track.codec || track.codecDescription;
            if (!mTrack.codecString) {
                this.log(`Skipping track ${mTrack.id} because codec information is missing`).warn();
                continue;
            }
            if (this.tracks.set(mTrack.id, mTrack).size <= size) {
                // Duplicated track
                continue;
            }
            AVC.readCodecString(mTrack.codecString, mTrack);
            if (!mTrack.codec) {
                // no found, force cast codecStirng to Media.Codec (in an upper case form)
                mTrack.codec = mTrack.codecString.toUpperCase() as Media.Codec;
            }

            mTrack.bandwidth = Number(track.bandwidth) || mTrack.bandwidth;
            mTrack.currentTime = Number(track.currentTime) || mTrack.currentTime;
            mTrack.contentProtection = track.contentProtection;

            const type = (track.type || '').toLowerCase();

            mTrack.language = (track.lang || track.language || '').toLowerCase();

            if (type === 'data') {
                mTrack.type = Media.Type.DATA;
                this.dataTracks.push(mTrack);
            } else {
                // Media
                mTrack.config = Uint8Array.from(atob(track.config as string), c => c.charCodeAt(0) || 0);
                if (type === 'audio') {
                    mTrack.type = Media.Type.AUDIO;
                    mTrack.rate = Number(track.sampleRate) || mTrack.rate;
                    mTrack.channels = Number(track.channels) || mTrack.channels;
                    this.audioTracks.push(mTrack);
                } else if (type === 'video') {
                    mTrack.type = Media.Type.VIDEO;
                    mTrack.resolution = track.resolution ?? mTrack.resolution;
                    mTrack.rate = Number(track.frameRate) || mTrack.rate;
                    this.videoTracks.push(mTrack);
                }
            }
        }
        if (Array.isArray(obj.contentProtection)) {
            for (const contentProtection of obj.contentProtection) {
                const kid = contentProtection.kid;
                if (!kid) {
                    continue;
                }
                if (kid.length !== 32) {
                    this.log('Invalid KID length').warn();
                    continue;
                }
                const ivMode = contentProtection.ivMode === 'sample' ? 'sample' : 'constant';
                const keySettings: ContentProtection = {
                    scheme: ProtectionScheme.CBCS,
                    kid,
                    iv: ivMode === 'sample' ? undefined : contentProtection.iv || '',
                    ivMode,
                    pssh: new Map<string, string>()
                };
                if (contentProtection.scheme) {
                    switch (contentProtection.scheme.toLowerCase()) {
                        case 'cenc':
                            keySettings.scheme = ProtectionScheme.CENC;
                            break;
                        case 'cbc1':
                            keySettings.scheme = ProtectionScheme.CBC1;
                            break;
                        case 'cens':
                            keySettings.scheme = ProtectionScheme.CENS;
                            break;
                    }
                }
                if (contentProtection.pssh) {
                    for (const drmId in contentProtection.pssh) {
                        const pssh = contentProtection.pssh[drmId];
                        keySettings.pssh.set(drmId, pssh);
                    }
                }
                this.contentProtection.set(kid, keySettings);
            }
        }
    }

    static async connect(params: Connect.Params, controller: AbortController): Promise<Metadata> {
        const response = await Util.fetchWithRTT(Connect.buildURL(Connect.Type.WRTS, params, 'http') + '.json', controller);
        const metadata = new Metadata(Object.assign(await response.json()));
        // fix currentTime with a ping estimation of the request
        metadata.liveTime += response.rtt / 2;
        return metadata;
    }

    fix() {
        // get all the tracks available and sort it by Max BPS
        const tracks = this.videoTracks.concat(this.audioTracks).concat(this.dataTracks);
        for (const [, track] of this.tracks) {
            tracks.push(track);
        }
        tracks.sort((track1: MediaTrack, track2: MediaTrack) => track2.bandwidth - track1.bandwidth);

        // Fill related collection and make each track unique
        this.dataTracks.length = this.audioTracks.length = this.videoTracks.length = 0;
        this.tracks.clear();
        for (const track of tracks) {
            const size = this.tracks.size;
            this.tracks.set(track.id, track);
            if (size === this.tracks.size) {
                continue;
            }
            let medias;
            if (track.type === Media.Type.AUDIO) {
                medias = this.audioTracks;
            } else if (track.type === Media.Type.VIDEO) {
                medias = this.videoTracks;
            } else {
                medias = this.dataTracks;
            }
            track.down = undefined;
            track.up = medias[medias.length - 1];
            if (track.up) {
                track.up.down = track;
            }
            medias.push(track);
        }
    }

    /**
     * Filter metadata to subset with only audio track with a codec supported
     * @param codecs audio codecs supported
     * @returns the metadata modified
     */
    filterAudios(codecs?: Array<Media.Codec>): this {
        return this._filter(this.audioTracks, new Set(codecs));
    }

    /**
     * Filter metadata to subset with only video track with a codec supported
     * @param codecs video codecs supported
     * @returns the metadata modified
     */
    filterVideos(codecs?: Array<Media.Codec>): this {
        return this._filter(this.videoTracks, new Set(codecs));
    }

    /**
     * Filter metadata to subset with only data track with a codec supported
     * @param codecs data codecs supported
     * @returns the metadata modified
     */
    filterDatas(codecs?: Array<Media.Codec>): this {
        return this._filter(this.dataTracks, new Set(codecs));
    }

    private _filter(medias: Array<MediaTrack>, codecs?: Set<Media.Codec>): this {
        if (codecs) {
            for (let i = 0; i < medias.length; ++i) {
                const media = medias[i];
                if (!codecs.has(media.codec)) {
                    this.tracks.delete(media.id);
                    medias.splice(i--, 1);
                }
            }
            // Fix UP/DOWN
            for (const track of medias) {
                while (track.up && !this.tracks.has(track.up.id)) {
                    track.up = track.up.up;
                }
                while (track.down && !this.tracks.has(track.down.id)) {
                    track.down = track.down.down;
                }
            }
        }
        return this;
    }
}
