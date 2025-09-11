/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, Util, WebSocketReliable, WebSocketReliableError } from '@ceeblue/web-utils';
import * as Media from '../media/Media';
import { Source, SourceError } from './Source';
import { IPlaying } from './IPlaying';
import { Metadata } from '../media/Metadata';
import * as RTS from '../media/RTS';
import { Reader } from '../media/reader/Reader';

/**
 * WebSocket Streaming
 */
@Source.registerClass('wss', 'ws')
export class WSSource extends Source {
    private _ws: WebSocketReliable;
    private _rtt: number;

    constructor(playing: IPlaying, params: Connect.Params) {
        super(playing, 'wss', params);

        this._rtt = 0;
        this._ws = new WebSocketReliable();
    }

    close(error?: SourceError) {
        this._ws.close();
        super.close(error);
    }

    protected _setTracks(tracks: Media.Tracks) {
        const cmd = {
            audio: tracks.audio == null ? '' : tracks.audio.toFixed(),
            video: tracks.video == null ? '' : tracks.video.toFixed()
        };
        if (!cmd.audio || this.audioSelected == null) {
            // if no audio set, or auto selection
            cmd.audio += '~';
        }
        if (!cmd.video || this.videoSelected == null) {
            // if no video set, or auto selection
            cmd.video += '~';
        }
        this._ws.send(JSON.stringify(cmd));
    }

    protected async _play(url: URL, tracks: Media.Tracks, playing: IPlaying): Promise<void> {
        const reader = this._newReader();

        RTS.addSourceParams(url, tracks, this.reliable);
        const time = Util.time();
        this._ws.onOpen = () => (this._rtt = Util.time() - time);
        this._ws.onClose = async (error?: WebSocketReliableError) => {
            if (this.closed || error?.name === 'Socket disconnection') {
                // Don't reconnect if:
                // - explicit close
                // - an explicit Socket disconnection
                this.close(error);
                return;
            }
            // Try a reconnection
            await Util.sleep(500);
            if (!this.closed) {
                this.log(`Fetch again ${url.toString()}`).info();
                this._ws.open(url);
            }
        };
        this._ws.onMessage = (data: ArrayBuffer | string) => {
            reader.read(data);
        };
        this._ws.open(this.finalizeRequest(url, new Headers()));
    }

    protected _setReliability(reliable: boolean) {
        this._ws.send(JSON.stringify({ reliable }));
    }

    protected readMetadata(metadata: Metadata) {
        // fix currentTime with a ping estimation of the request
        metadata.liveTime += this._rtt / 2;
        super.readMetadata(metadata);
    }

    protected _newReader(params = { isStream: true }): Reader {
        return super._newReader({ isStream: false });
    }
}
