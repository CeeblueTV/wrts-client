/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, ILog, Util } from '@ceeblue/web-utils';
import * as Media from '../media/Media';
import { Source } from './Source';
import { Metadata } from '../media/Metadata';
import { AdaptiveRetry } from '../media/AdaptiveRetry';
import { BufferState, IPlaying } from './IPlaying';
import { CMCD } from '../media/CMCD';
import { Reader } from '../media/reader/Reader';

/**
 * HTTP Adaptive Streaming
 */
@Source.registerClass('https', 'http')
export class HTTPAdaptiveSource extends Source {
    private _upController?: AbortController;
    private _audioController: AbortController;
    private _videoController: AbortController;
    private _sequencePattern: string;
    private _maxSequenceDuration?: number;
    private _cmcd?: CMCD;

    /**
     * @override
     * {@inheritDoc Source.cmcd}
     */
    get cmcd(): CMCD {
        return this._cmcd ?? CMCD.NONE;
    }

    /**
     * @override
     * {@inheritDoc Source.cmcd}
     */
    set cmcd(value: CMCD | undefined) {
        this._cmcd = value;
    }

    constructor(playing: IPlaying, params: Connect.Params) {
        super(playing, 'https', params);
        this._sequencePattern = '';
        this._audioController = new AbortController();
        this._videoController = new AbortController();
        playing.signal.addEventListener(
            'abort',
            () => {
                this._audioController.abort();
                this._videoController.abort();
                this._upController?.abort();
            },
            { once: true }
        );
    }
    protected _setReliability(reliable: boolean) {
        return;
    }

    protected async _play(url: URL, tracks: Media.Tracks, playing: IPlaying): Promise<void> {
        if (!url.pathname.toLowerCase().endsWith('.json')) {
            // URL is '/wrts/' + params.streamName + params.mediaExt, change it to request index.json
            url.pathname = url.pathname.slice(0, -Util.getExtension(url.pathname).length) + '/index.json';
        }

        // GET METADATA!

        let response;
        let attempts = 0;

        do {
            if (this.closed) {
                return;
            }
            if (attempts++) {
                this.log(`Fetch again ${url.toString()}`).info();
            }
            try {
                response = await this.fetchWithRTT(url, playing);
                if (response.error) {
                    // unrecoverable error
                    return this.close({ type: 'SourceError', name: 'Request error', detail: response.error });
                }
            } catch (e) {
                // Request error, already displaid as a console error log => try again!
                await Util.sleep(500);
            }
        } while (!response);

        const text = await response.text();
        this.recvByteRate.addBytes(text.length);
        const manifest = JSON.parse(text); // Must be JSON!
        const metadata = new Metadata(manifest);
        // fix liveTime with a ping estimation of the request
        metadata.liveTime += response.rtt / 2;

        let sequence = manifest.sequence;
        if (!sequence) {
            return this.close({
                type: 'SourceError',
                name: 'Malformed payload',
                detail: `No sequence section in the JSON manifest ${url.toString()}`
            });
        }
        if (!sequence.pattern) {
            return this.close({
                type: 'SourceError',
                name: 'Malformed payload',
                detail: `No valid sequence.pattern field in the JSON manifest ${url.toString()}`
            });
        }
        this._sequencePattern = sequence.pattern.replace('{ext}', this.mediaExt);
        sequence = Number(sequence.currentId);
        if (isNaN(sequence)) {
            return this.close({
                type: 'SourceError',
                name: 'Malformed payload',
                detail: `No valid sequence.currentId field in the JSON manifest ${url.toString()}`
            });
        }

        // propagate Metadata
        this.readMetadata(metadata);

        playing.on(
            'BufferState',
            async () => {
                if (playing.bufferState === BufferState.LOW) {
                    // Stop up emulation if is running !
                    this._upController?.abort();
                }
            },
            playing // for AbortSignal
        );

        let stall = false;
        playing.on(
            'Stall',
            async () => {
                // STALL
                stall = true;
                if (!this.reliable) {
                    // Cancel immediately all the reception to try to skip sequences!
                    this._audioController.abort();
                    this._videoController.abort();
                    this._upController?.abort();
                }
            },
            playing // for AbortSignal
        );

        // Start download
        let again = false;
        let prevVideoTime;
        let prevVideoSequence;
        const adaptiveRetry = new AdaptiveRetry();
        adaptiveRetry.log = this.log.bind(this, 'Adaptive Bitrate,') as ILog;

        while (!this.closed) {
            const promises = [];

            let videoTrack;
            const bandwidthMeasure = this.recvByteRate.value();
            if (playing.bufferState !== BufferState.NONE) {
                videoTrack = this.videoSelected == null && metadata.tracks.get(tracks.video ?? -1);
                if (videoTrack) {
                    let up = false;
                    if (stall || this._videoController.signal.aborted) {
                        // video or audio were aborted (stall or buffer empty)!
                        // => We are facing a bandwidh limit!
                        if (!this._upController) {
                            // was no emulation, so we have to down at least of one level
                            videoTrack = videoTrack.down ?? videoTrack;
                        }
                        const audioBandwidth = metadata.tracks.get(tracks.audio ?? -1)?.bandwidth ?? 0;
                        while (videoTrack.down && videoTrack.bandwidth + audioBandwidth > bandwidthMeasure) {
                            videoTrack = videoTrack.down;
                        }
                        adaptiveRetry.raise();
                    } else if (this._upController && !this._upController.signal.aborted) {
                        // UP emulated success !
                        up = true;
                        videoTrack = videoTrack.up ?? videoTrack;
                    } else if (playing.bufferState === BufferState.LOW) {
                        // is low but without bandwidth estimation => only down !
                        videoTrack = videoTrack.down ?? videoTrack;
                        adaptiveRetry.raise();
                    }

                    // make compatible with displayable screen
                    while (Media.overScreenSize(videoTrack.resolution, playing.maximumResolution) && videoTrack.down) {
                        videoTrack = videoTrack.down;
                    }

                    if (tracks.video !== videoTrack.id) {
                        // change track
                        let log = `MBR ${up ? 'UP' : 'DOWN'} from track ${tracks.video} to ${videoTrack.id} at ${(videoTrack.bandwidth * 8) / 1000}kbps ${Util.stringify(videoTrack.resolution)}`;
                        if (!up) {
                            log += ' (constraint=' + ((bandwidthMeasure * 8) / 1000).toFixed() + 'kbps)';
                        }
                        this.log(log)[up ? 'info' : 'warn']();
                        tracks.video = videoTrack.id;
                    }
                } else {
                    // if no video track selected or no video metadata => reset
                    adaptiveRetry.reset();
                }
            }

            // Reset controller and state
            this._audioController = new AbortController();
            this._videoController = new AbortController();
            this._upController = undefined;
            stall = false;

            // Skip framing
            if (!this.reliable && playing.bufferState === BufferState.LOW && playing.buffering) {
                // We can skip some frames while buffering because means a stall has occurred
                if (this._maxSequenceDuration != null) {
                    if (this.metadata) {
                        let newSequence = Infinity;
                        let fixLiveTime = 0;

                        // Check newSequence exists
                        while (this.metadata.liveTime > this.currentTime) {
                            const track = tracks.audio != null && tracks.audio >= 0 ? tracks.audio : tracks.video;
                            if (track == null) {
                                throw Error('Nothing to download, no track enabled');
                            }
                            newSequence = Math.min(
                                sequence + Math.floor((this.metadata.liveTime - this.currentTime) / this._maxSequenceDuration),
                                newSequence - 1
                            );

                            if (newSequence <= sequence) {
                                // nothing to skip
                                break;
                            }

                            // HEAD request o check if frame exists!
                            const response = await this._downloadSequence(playing, this._audioController, track, newSequence, 0);
                            if (response.ok && newSequence > sequence) {
                                again = false;
                                this.log(
                                    `Skip sequences ${sequence} to ${newSequence - 1} ${Util.stringify({
                                        delay: this.metadata.liveTime - this.currentTime,
                                        maxSequenceDuration: this._maxSequenceDuration
                                    })}`
                                ).warn();
                                sequence = newSequence;
                                break;
                            }

                            fixLiveTime -= this._maxSequenceDuration;
                            this.log(
                                `Fails to skip sequence ${newSequence} ${Util.stringify({
                                    delay: this.metadata.liveTime - this.currentTime,
                                    maxSequenceDuration: this._maxSequenceDuration
                                })}`
                            ).warn();
                        }

                        // Fix evaluation if need
                        if (fixLiveTime) {
                            const liveTime = metadata.liveTime + fixLiveTime;
                            this.log(
                                `Fix Metadata.liveTime ${fixLiveTime}ms (${metadata.liveTime.toFixed()} => ${liveTime.toFixed()})`
                            ).warn();
                            metadata.liveTime = liveTime;
                        }
                    } else {
                        this.log('Cannot recover live because there is no liveTime metadata information').error();
                    }
                } else {
                    this.log('Cannot recover live because there is no valid max-sequence-duration header').error();
                }
            }

            // Download the same sequence in parallel!
            this.log(`Download ${Util.stringify(tracks)} sequence ${sequence}`)[again ? 'warn' : 'info']();
            again = true;

            if (tracks.audio != null && tracks.audio >= 0) {
                promises.push(this._downloadSequence(playing, this._audioController, tracks.audio, sequence));
            }

            if (tracks.video != null && tracks.video >= 0) {
                promises.push(this._downloadSequence(playing, this._videoController, tracks.video, sequence));
                // Add a factice track to emulate UP rendition?
                if (
                    videoTrack &&
                    prevVideoTime != null &&
                    adaptiveRetry.try() &&
                    videoTrack.up &&
                    !Media.overScreenSize(videoTrack.up.resolution, playing.maximumResolution)
                ) {
                    this._upController = new AbortController();
                    const extraByteRateRequired = videoTrack.up.bandwidth - videoTrack.bandwidth;
                    if (extraByteRateRequired >= 0) {
                        const bytes = Math.ceil((extraByteRateRequired * (this.videoTime - prevVideoTime)) / 1000);
                        this.log(
                            `Bandwidth emulation of ${((videoTrack.up.bandwidth * 8) / 1000).toFixed()}kbs by adding ${((extraByteRateRequired * 8) / 1000).toFixed()}kbs to current ${((videoTrack.bandwidth * 8) / 1000).toFixed()}kbs`
                        ).info();
                        promises.push(
                            this._downloadSequence(playing, this._upController, videoTrack.up.id, prevVideoSequence, bytes)
                        );
                    } else {
                        this.log(`Up quality looks requires the same bandwidth, no need to emulate it`).warn();
                    }
                }
            }
            if (!promises.length) {
                throw Error('Nothing to download, no track enabled');
            }

            prevVideoTime = this.videoTime;

            const responses = await Promise.all(promises);
            for (const response of responses) {
                if (response.error) {
                    // unrecoverable error
                    return this.close({
                        type: 'SourceError',
                        name: response.status === 400 ? 'Malformed payload' : 'Request error',
                        detail: response.error
                    });
                }
                if (again && response.ok) {
                    // at least one has gotten the sequence!
                    prevVideoSequence = sequence;
                    ++sequence;
                    again = false;
                }
            }

            if (this._upController?.signal.aborted) {
                adaptiveRetry.raise();
                this.log(
                    `Bandwidth emulation fails to reach ${(((videoTrack ? (videoTrack.up ?? videoTrack).bandwidth : 0) * 8) / 1000).toFixed()}kbs`
                ).warn();
            }
        }
    }

    /**
     * Download one sequence, retry if can't download it until get it (at least that there is a unrecoverable issue).
     * If length is set it limits body of the request to this value by processing a byte-range request,
     * If length is set to 0 it sends a normal HEAD request
     * @returns HTTP headers if was able to download at least it, null otherwise!
     */
    private async _downloadSequence(
        playing: IPlaying,
        controller: AbortController,
        trackId: number,
        sequence: number,
        length?: number
    ): Promise<Response & { error?: string; rtt?: number }> {
        let type;
        if (controller === this._audioController) {
            type = Media.Type.AUDIO;
        } else if (controller === this._videoController) {
            type = Media.Type.VIDEO;
        }

        const url = new URL(
            this._sequencePattern.replace('{trackId}', trackId.toFixed()).replace('{sequenceId}', sequence.toFixed()),
            this.url
        );

        let onlyKeyFrame = false;
        let videoAborted = false;
        if (length == null) {
            const isLastRendition = type === Media.Type.VIDEO && this.metadata && !this.metadata.tracks.get(trackId)?.down;
            if (
                isLastRendition &&
                !this.reliable && // skip frame allowed
                !playing.buffering &&
                playing.bufferState === BufferState.LOW // we are low in last rendition before to download keyframe => last chance rendition !
            ) {
                this.log(`Download only first video frame of sequence ${sequence} track ${trackId}`).warn();
                onlyKeyFrame = true;
                // do the HEAD request to get first-frame-length
                let response = await this._downloadSequence(playing, controller, trackId, sequence, 0);
                if (!response.ok) {
                    // aborted, log already displaid and nothing downloaded
                    return response;
                }
                length = Number(response.headers.get('first-frame-length'));
                if (!length) {
                    response = new Response(null, { headers: response.headers, status: 400 });
                    response.error = `No valid first-frame-length header from ${url.toString()}`;
                    return response;
                }
            }
        }

        let response;
        let reader: Reader | undefined;
        let headers;
        const bufferAmount = playing.bufferAmount;
        const videoTime = this.videoTime;

        while (!reader && !controller.signal.aborted) {
            if (headers) {
                this.log(
                    `
                    Fetch again ${type === Media.Type.AUDIO ? 'audio' : 'video'} sequence ${sequence} from ${url}
                `
                ).info();
            } else {
                headers = new Headers();
                if (length) {
                    headers.set('range', 'bytes=0-' + (length - 1));
                }
            }

            try {
                if (length === 0 || type == null) {
                    // Only HEAD or GET without media (bandwidth emulation)
                    response = await this.fetch(url, {
                        method: length === 0 ? 'HEAD' : 'GET',
                        signal: controller.signal,
                        headers
                    });
                } else {
                    response = await this.fetchMedia(url, type, {
                        method: 'GET',
                        signal: controller.signal,
                        headers
                    });
                }

                const maxSequenceDuration = Number(response.headers.get('max-sequence-duration')) || NaN;
                if (!isNaN(maxSequenceDuration)) {
                    this._maxSequenceDuration = maxSequenceDuration;
                }

                if (response.error) {
                    return response;
                }
                if (length === 0) {
                    // Ony header
                    return response;
                }
                const body = response.body?.getReader();

                do {
                    const chunk = await body?.read();
                    if (!chunk || chunk.done) {
                        // All downloaded!
                        return response;
                    }
                    if (type == null) {
                        // UP emulation !
                        continue;
                    }
                    if (!reader) {
                        reader = this._newReader();
                        reader.onMetadata = Util.EMPTY_FUNCTION;
                        if (type === Media.Type.AUDIO) {
                            reader.onVideo = Util.EMPTY_FUNCTION;
                        } else {
                            reader.onAudio = Util.EMPTY_FUNCTION;
                            if (!this.reliable) {
                                // last rendition, define a 1 frame per GOP last chance rendition
                                reader.onVideo = (trackId: number, sample?: Media.Sample) => {
                                    const isKey = sample?.isKeyFrame;
                                    if ((bufferAmount && !playing.bufferAmount) || (isKey && onlyKeyFrame)) {
                                        // If we have no more data we are in a critic situation,
                                        // whatever the frame (key or predicted) we have to abort the video
                                        videoAborted = true;
                                        if (sample) {
                                            // stretch duration for all the sequence
                                            const duration = this._maxSequenceDuration
                                                ? Math.max(1, this._maxSequenceDuration - this.videoTime + videoTime)
                                                : sample.duration;
                                            const skipped = duration - sample.duration;
                                            if (skipped > 0) {
                                                playing.onVideoSkipping(skipped);
                                            }
                                            // make duration extendable
                                            sample.duration = -duration;
                                        }
                                    }

                                    this.readVideo(trackId, sample);

                                    if (videoAborted) {
                                        if (reader) {
                                            reader.onVideo = Util.EMPTY_FUNCTION;
                                        }
                                        if (!length) {
                                            controller.abort();
                                        } // keep the connection alive !
                                    }
                                };
                            }
                        }
                    }
                    reader.read(chunk.value);
                } while (!controller.signal.aborted);
            } catch (e) {
                // Request error, already displaid as a console error log => try again!
                await Util.sleep(500);
            }
        } // main while loop

        const aborted = controller.signal.aborted;
        if (videoAborted) {
            // to signal that we don't have download all !
            controller.abort();
        }

        if (this.closed || !reader) {
            // CLOSED or Not even started to download, sequence recoverable on a next call
            return new Response(null, { headers: response?.headers, status: 408 });
        }
        // download started but failed, impossible to retry without rewind the reception
        if (aborted) {
            this.log(`${type === Media.Type.AUDIO ? 'Audio' : 'Video'} sequence ${sequence} track ${trackId} aborted`).warn();
        } else {
            this.log(
                `Fails to download ${type === Media.Type.AUDIO ? 'audio' : 'video'} sequence ${sequence} track ${trackId} from ${url}`
            ).warn();
        }
        // Sequence partially gotten
        return new Response(null, { headers: response?.headers, status: 206 });
    }

    protected _setTracks(tracks: Media.Tracks) {
        // change tracks is allowed and done in play method
    }
}
