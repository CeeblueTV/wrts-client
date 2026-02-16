/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, Util } from '@ceeblue/web-utils';
import * as Media from '../media/Media';
import { Source } from './Source';
import { IPlaying } from './IPlaying';
import { Metadata } from '../media/Metadata';

/**
 * HTTP Direct Streaming
 */
export class HTTPSource extends Source {
    private _rtt: number;

    constructor(playing: IPlaying, params: Connect.Params) {
        super(playing, 'https', params, Connect.Type.DIRECT_STREAMING);
        this._rtt = 0;
    }

    protected _setReliability(reliable: boolean) {
        if (!reliable) {
            throw Error("WS doesn't support partial reliability");
        }
    }

    protected _setTracks(tracks: Media.Tracks) {
        throw Error("HTTP doesn't support a dynamic track selection");
    }

    protected async _play(url: URL, tracks: Media.Tracks, playing: IPlaying): Promise<void> {
        const reader = this._newReader();

        // download best AAC track
        url.searchParams.set('audio', tracks.audio != null ? tracks.audio.toString() : 'aac,|bestbps');
        // download best H264 track
        url.searchParams.set('video', tracks.video != null ? tracks.video.toString() : 'h264,|bestbps');

        while (!this.closed) {
            let chunk;
            try {
                if (this._rtt) {
                    this.log(`Fetch again ${url.toString()}`).info();
                }
                const response = await this.fetchWithRTT(url, playing);
                if (response.error) {
                    return this.close({ type: 'SourceError', name: 'Request error', detail: response.error });
                }
                this._rtt = response.rtt;
                if (response.body) {
                    const body = response.body.getReader();
                    while (!this.closed && !(chunk = await body.read()).done) {
                        reader.read(chunk.value);
                    }
                }
            } catch (e) {
                // Request error, already displaid as a console error log => try again!
                await Util.sleep(500);
            }
        }
    }

    protected readMetadata(metadata: Metadata) {
        // fix currentTime with a ping estimation of the request
        metadata.liveTime += this._rtt / 2;
        super.readMetadata(metadata);
    }
}
