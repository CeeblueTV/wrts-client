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
import * as RTS from '../media/RTS';

/**
 * HTTP Direct Streaming
 */
export class HTTPSource extends Source {
    private _rtt: number;

    constructor(playing: IPlaying, params: Connect.Params) {
        super(playing, 'https', params);
        this._rtt = 0;
    }

    protected _setReliability(reliable: boolean) {
        throw Error("HTTP doesn't support a mutable reliability");
    }

    protected _setTracks(tracks: Media.Tracks) {
        throw Error("HTTP doesn't support a manual track selection");
    }

    protected async _play(url: URL, tracks: Media.Tracks, playing: IPlaying): Promise<void> {
        const reader = this._newReader();

        RTS.addSourceParams(url, tracks, this.reliable);
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
