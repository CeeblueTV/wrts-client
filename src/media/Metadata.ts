/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, Util } from '@ceeblue/web-utils';
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
     * Initialization Vector
     */
    iv: string;
    /**
     * Map of ID of the DRM system to PSSH box
     */
    pssh: Map<string, string>;
};

function filter(tracks: Map<number, MediaTrack>, medias: Array<MediaTrack>, codecs: Set<Media.Codec>) {
    for (let i = 0; i < medias.length; ++i) {
        const media = medias[i];
        if (!codecs.has(media.codec)) {
            tracks.delete(media.id);
            medias.splice(i--, 1);
        }
    }
}

/**
 * Metadata representation
 */
export class Metadata {
    /**
     * Date of Metadata creatiob
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
        if (obj == null) {
            return;
        }
        this._liveTimeValue = Number(obj.currentTime) || Number(obj.liveTime) || this._liveTimeValue;
        if (String(this._liveTimeValue).indexOf('.') >= 0) {
            // Force in milliseconds!
            this._liveTimeValue *= 1000;
        }
        let trackId = 0;

        const tracks = Array.isArray(obj.tracks) ? obj.tracks : [];
        for (const track of tracks) {
            const mTrack = new MediaTrack(track.id ?? trackId++);
            switch ((track.type || '').toLowerCase()) {
                case 'audio':
                    mTrack.type = Media.Type.AUDIO;
                    mTrack.rate = Number(track.sampleRate) || mTrack.rate;
                    mTrack.channels = Number(track.channels) || mTrack.channels;
                    break;
                case 'video':
                    mTrack.type = Media.Type.VIDEO;
                    mTrack.resolution = track.resolution ?? mTrack.resolution;
                    mTrack.rate = Number(track.frameRate) || mTrack.rate;
                    break;
            }
            mTrack.codecString = track.codec || track.codecDescription;
            AVC.readCodecString(mTrack.codecString, mTrack);

            mTrack.bandwidth = Number(track.bandwidth) || mTrack.bandwidth;
            mTrack.config = Uint8Array.from(atob(track.config as string), c => c.charCodeAt(0) || 0);
            mTrack.contentProtection = track.contentProtection;
            mTrack.currentTime = Number(track.currentTime) || mTrack.currentTime;

            this.tracks.set(mTrack.id, mTrack);
        }
        if (Array.isArray(obj.contentProtection)) {
            for (const contentProtection of obj.contentProtection) {
                const kid = contentProtection.kid;
                if (!kid) {
                    continue;
                }
                const keySettings = {
                    scheme: ProtectionScheme.CBCS,
                    kid,
                    iv: contentProtection.iv || '',
                    pssh: new Map<string, string>()
                };
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
        this.audioTracks.length = this.videoTracks.length = 0;
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
     * Return a new metadata subset with only track with a codec supported
     * @param codecs codecs supported
     * @returns the subset of metadata
     */
    subset(codecs?: Set<Media.Codec>): Metadata {
        const metadata: Metadata = { ...this };
        if (codecs) {
            filter(metadata.tracks, metadata.audioTracks, codecs);
            filter(metadata.tracks, metadata.videoTracks, codecs);
            // Fix UP/DOWN
            for (const [, track] of metadata.tracks) {
                while (track.up && !metadata.tracks.has(track.up.id)) {
                    track.up = track.up.up;
                }
                while (track.down && !metadata.tracks.has(track.down.id)) {
                    track.down = track.down.down;
                }
            }
        }
        return metadata;
    }
}
