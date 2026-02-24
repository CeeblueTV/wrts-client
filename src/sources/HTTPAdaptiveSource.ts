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

    // To emulate UP rendition before to switch
    private _upController?: AbortController;
    // For channel sequence-skippable + first sample morphable, basically for video in unreliable mode
    private _alterableController: AbortController;
    // For channel sequence-skippable on stall, basically for audio in unreliable mode
    private _skippableController: AbortController;
    // For reliable channel, basically for all channels in reliable mode
    private _reliableController: AbortController;
    private _sequencePattern: string;
    private _maxSequenceDuration?: number;
    private _cmcd?: CMCD;
    private _trackSeparator: string = '';

    constructor(playing: IPlaying, params: Connect.Params) {
        super(playing, 'https', params);
        this._sequencePattern = '';
        this._alterableController = new AbortController();
        this._skippableController = new AbortController();
        this._reliableController = new AbortController();
        playing.signal.addEventListener(
            'abort',
            () => {
                this._alterableController.abort();
                this._skippableController.abort();
                this._reliableController.abort();
                this._upController?.abort();
            },
            { once: true }
        );
    }
    protected setReliability(reliable: boolean) {
        return;
    }

    protected async play(url: URL, tracks: Media.Tracks, playing: IPlaying): Promise<void> {
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

        const mSequence = manifest.sequence;
        if (!mSequence) {
            return this.close({
                type: 'SourceError',
                name: 'Malformed payload',
                detail: `No sequence section in the JSON manifest ${url.toString()}`
            });
        }
        if (!mSequence.pattern) {
            return this.close({
                type: 'SourceError',
                name: 'Malformed payload',
                detail: `No valid sequence.pattern field in the JSON manifest ${url.toString()}`
            });
        }
        this._trackSeparator = mSequence.trackSeparator ?? '-';
        this._sequencePattern = mSequence.pattern.replace('{ext}', this.mediaExt);

        // WIP backward compatibility, remove it
        const oldNode = metadata.protocolVersion.major < 2;
        if (oldNode) {
            this._sequencePattern = this._sequencePattern.replace('{trackId}', '{trackIds}');
        }

        const sequenceId = Number(mSequence.current?.id ?? mSequence.currentId); // WIP remove old currentId
        const sequenceFirstId = Number(mSequence.first?.id ?? mSequence.firstId ?? 0); // WIP remove old firstId
        if (isNaN(sequenceId)) {
            return this.close({
                type: 'SourceError',
                name: 'Malformed payload',
                detail: `No valid sequence.current.id field in the JSON manifest ${url.toString()}`
            });
        }
        const sequenceTime = Number(mSequence.current?.time);
        let deltaSequence = 0;
        if (!isNaN(sequenceTime)) {
            const currentGopElapsed = metadata.liveTime - sequenceTime;
            const bufferTarget = playing.bufferLimitMiddle - currentGopElapsed;
            if (bufferTarget > 0) {
                const sequenceTime = Number(mSequence.current?.time);
                const sequenceFirstTime = Number(mSequence.first?.time);
                const idDiff = sequenceId - sequenceFirstId;
                if (idDiff > 0 && !isNaN(sequenceTime) && !isNaN(sequenceFirstTime)) {
                    const gopSize = Math.max(1, sequenceTime - sequenceFirstTime) / idDiff;
                    deltaSequence = Math.ceil(bufferTarget / gopSize);
                }
            }
        }
        let sequence = Math.max(sequenceId - deltaSequence, Math.min(sequenceFirstId, sequenceId));
        if (deltaSequence > 0) {
            this.log(`Preload of ${deltaSequence} sequences`).info();
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
                // Cancel immediately media reception to try to skip sequences!
                this._alterableController.abort();
                this._skippableController.abort();
                this._upController?.abort();
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
            let videoTrack;
            const bandwidthMeasure = this.recvByteRate.value();
            if (playing.bufferState !== BufferState.NONE) {
                videoTrack = this.videoSelected == null && metadata.tracks.get(tracks.video ?? -1);
                if (videoTrack) {
                    let up = false;
                    if (stall || this._alterableController.signal.aborted) {
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

            let skipSequences = 0;
            // Compute Skip Sequences
            if (!this.reliable && playing.bufferState === BufferState.LOW && playing.buffering) {
                // We can skip some frames while buffering because means a stall has occurred
                if (this._maxSequenceDuration != null) {
                    let newSequence = Infinity;
                    let fixLiveTime = 0;

                    // Check newSequence exists
                    while (metadata.liveTime > this.currentTime) {
                        const track = tracks.audio != null && tracks.audio >= 0 ? tracks.audio : tracks.video;
                        if (track == null) {
                            throw Error('Nothing to download, no track enabled');
                        }
                        newSequence = Math.min(
                            sequence + Math.floor((metadata.liveTime - this.currentTime) / this._maxSequenceDuration),
                            newSequence - 1
                        );

                        if (newSequence <= sequence) {
                            // nothing to skip
                            break;
                        }

                        // HEAD request to check if frame exists!
                        const response = await this._downloadSequence(playing, this._reliableController, track, newSequence, 0);
                        if (response.ok) {
                            again = false;
                            this.log(
                                `Skip sequences ${sequence} to ${newSequence - 1} ${Util.stringify({
                                    delay: metadata.liveTime - this.currentTime,
                                    maxSequenceDuration: this._maxSequenceDuration
                                })}`
                            ).warn();
                            if (oldNode) {
                                // WIP remove
                                sequence = newSequence;
                            } else {
                                skipSequences = newSequence - sequence;
                            }
                            break;
                        }

                        fixLiveTime -= this._maxSequenceDuration;
                        this.log(
                            `Fails to skip sequences ${sequence} to ${newSequence - 1} ${Util.stringify({
                                delay: metadata.liveTime - this.currentTime,
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
                    this.log('Cannot recover live because there is no valid max-sequence-duration header').error();
                }
            }

            do {
                // Reset controller and state
                this._skippableController = new AbortController();
                this._alterableController = new AbortController();
                this._upController = undefined;
                stall = false;

                // Fill channels
                const channels = {
                    alterable: new Set<number>(), // Frame alterable
                    skippable: new Set<number>(), // sequence skippable
                    reliable: new Set<number>() // Reliable
                };
                const promises = [];
                /// Audio
                if (tracks.audio != null && tracks.audio >= 0) {
                    (this.reliable ? channels.reliable : channels.skippable).add(tracks.audio);
                }
                /// Video
                if (tracks.video != null && tracks.video >= 0) {
                    if (this.reliable) {
                        channels.reliable.add(tracks.video);
                    } else if (metadata.tracks.get(tracks.video)?.down) {
                        channels.skippable.add(tracks.video);
                    } else {
                        // last rendition => we can try to drop frames
                        channels.alterable.add(tracks.video);
                    }
                    // Add a factice track to emulate UP rendition?
                    if (
                        videoTrack &&
                        prevVideoSequence != null &&
                        adaptiveRetry.try() &&
                        videoTrack.up &&
                        !Media.overScreenSize(videoTrack.up.resolution, playing.maximumResolution)
                    ) {
                        this._upController = new AbortController();
                        const extraByteRateRequired = videoTrack.up.bandwidth - videoTrack.bandwidth;
                        if (extraByteRateRequired >= 0) {
                            const bytes = Math.ceil((extraByteRateRequired * (this.videoTime - (prevVideoTime ?? 0))) / 1000);
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
                /// Data
                /// WIP use a possible data.reliable information to make it always
                /// reliable for reliable data channel like SCTE35 for example
                const dataTracks = this.reliable ? channels.reliable : channels.skippable;
                for (const track of tracks.data ?? []) {
                    dataTracks.add(track);
                }

                // Create promises
                if (channels.reliable.size) {
                    if (oldNode) {
                        for (const track of channels.reliable) {
                            promises.push(this._downloadSequence(playing, this._reliableController, track, sequence));
                        }
                    } else {
                        promises.push(this._downloadSequence(playing, this._reliableController, channels.reliable, sequence));
                    }
                }
                if (skipSequences) {
                    if (!promises.length) {
                        --skipSequences;
                        ++sequence;
                        again = false;
                        continue;
                    }
                } else {
                    if (channels.skippable.size) {
                        if (oldNode) {
                            for (const track of channels.skippable) {
                                promises.push(this._downloadSequence(playing, this._skippableController, track, sequence));
                            }
                        } else {
                            promises.push(
                                this._downloadSequence(playing, this._skippableController, channels.skippable, sequence)
                            );
                        }
                    }
                    if (channels.alterable.size) {
                        if (oldNode) {
                            for (const track of channels.alterable) {
                                promises.push(this._downloadSequence(playing, this._alterableController, track, sequence));
                            }
                        } else {
                            promises.push(
                                this._downloadSequence(playing, this._alterableController, channels.alterable, sequence)
                            );
                        }
                    }
                }
                if (!promises.length) {
                    throw Error('Nothing to download, no track enabled?');
                }

                // Effective download
                this.initTracks(tracks); // announce track to receive!
                this.log(
                    `Download ${Util.stringify([...channels.reliable, ...channels.skippable, ...channels.alterable])} sequence ${sequence}`
                )[again ? 'warn' : 'info']();
                again = true;
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
                        prevVideoSequence = sequence++;
                        --skipSequences;
                        again = false;
                    }
                }

                if (this._upController?.signal.aborted) {
                    adaptiveRetry.raise();
                    this.log(
                        `Bandwidth emulation fails to reach ${(((videoTrack ? (videoTrack.up ?? videoTrack).bandwidth : 0) * 8) / 1000).toFixed()}kbs`
                    ).warn();
                }
            } while (!this.closed && skipSequences > 0);
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
        tracks: Array<number> | Set<number> | number,
        sequence: number,
        length?: number
    ): Promise<Response & { error?: string; rtt?: number }> {
        let controllerType = '';
        if (controller === this._alterableController) {
            controllerType = 'alterable';
        } else if (controller === this._reliableController) {
            controllerType = 'reliable';
        } else if (controller === this._skippableController) {
            controllerType = 'skippable';
        }

        if (typeof tracks == 'number') {
            tracks = [tracks];
        } else if (tracks instanceof Set) {
            // sorts
            tracks = Array.from(tracks).sort((a, b) => a - b);
        }

        const strTracks = tracks.join(this._trackSeparator);
        const url = new URL(
            this._sequencePattern.replace('{trackIds}', strTracks).replace('{sequenceId}', sequence.toFixed()),
            this.url
        );

        let onlyKeyFrame = false;
        let videoAborted = false;
        if (length == null) {
            if (
                controller === this._alterableController && // skip frame allowed
                !playing.buffering &&
                playing.bufferState === BufferState.LOW // we are low in last rendition before to download keyframe => last chance rendition !
            ) {
                // do the HEAD request to get first-sample-length
                let response = await this._downloadSequence(playing, controller, tracks, sequence, 0);
                if (response.ok) {
                    // WIP remove old 'first-frame-length'
                    length = Number(response.headers.get('first-sample-length') || response.headers.get('first-frame-length'));
                    if (!length) {
                        response = new Response(null, { headers: response.headers, status: 400 });
                        response.error = `No valid first-sample-length header from ${url.toString()}`;
                        return response;
                    }
                    this.log(
                        `Download only first video frame of ${controllerType} sequence ${sequence} track ${strTracks}`
                    ).warn();
                    onlyKeyFrame = true;
                } else {
                    // aborted, log already displaid and nothing downloaded
                    if (this.closed) {
                        return response;
                    }
                    // maybe we have gotten a 404, due to immediate HEAD response and a possible origin switch
                    // Try a full GET what ensures to wait future sequence if there is
                    this.log(
                        `First video frame download for ${controllerType} sequence ${sequence} track ${strTracks} failed, \
                        switching to a full sequence download`
                    ).warn();
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
                this.log(`Fetch again ${controllerType} sequence ${sequence} track ${strTracks} from ${url}`).info();
            } else {
                headers = new Headers();
                if (length) {
                    headers.set('range', 'bytes=0-' + (length - 1));
                }
            }

            try {
                if (length === 0 || controller === this._upController) {
                    // Only HEAD or GET without media (bandwidth emulation)
                    response = await this.fetch(url, {
                        method: length === 0 ? 'HEAD' : 'GET',
                        signal: controller.signal,
                        headers
                    });
                } else {
                    response = await this.fetchMedia(url, tracks, {
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
                    if (controller === this._upController) {
                        // UP emulation !
                        continue;
                    }
                    if (!reader) {
                        reader = this.newReader();
                        reader.onMetadata = Util.EMPTY_FUNCTION;
                        reader.onInitTracks = Util.EMPTY_FUNCTION;
                        reader.onSample = (type: Media.Type, trackId: number, sample: Media.Sample) => {
                            if (controller !== this._alterableController || type !== Media.Type.VIDEO) {
                                this.readSample(type, trackId, sample);
                                return;
                            }
                            if (videoAborted) {
                                return;
                            }
                            // Define a 1-frame-per-GOP fallback rendition and abort the current video request if:
                            // - we reached a key frame while downloading only the first frame (last-resort rendition), or
                            // - we lost buffer (bufferAmount dropped to 0) while it was previously available.
                            const isKey = sample?.isKeyFrame;
                            if (isKey && onlyKeyFrame && bufferAmount && !playing.bufferAmount) {
                                videoAborted = true;
                                if (!length) {
                                    // if is a cancel whereas was not a firt-frame download => cancel the transfer
                                    controller.abort();
                                } // keep the connection alive !
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
                        };
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
            this.log(`Abort ${controllerType} sequence ${sequence} track ${strTracks}`).warn();
        } else {
            this.log(`Fails to download ${controllerType} sequence ${sequence} track ${strTracks} from ${url}`).warn();
        }
        // Sequence partially gotten
        return new Response(null, { headers: response?.headers, status: 206 });
    }

    protected setTracks(tracks: Media.Tracks) {
        // change tracks is allowed and done in play method
    }
}
