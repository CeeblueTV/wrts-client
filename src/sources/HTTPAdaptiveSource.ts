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
import { MediaTrack } from '../media/MediaTrack';

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
    // For channel sequence-cancelable + morphable (first frame), basically for video in unreliable mode
    private _alterableController: AbortController;
    // For channel sequence-cancelable on stall, basically for audio in unreliable mode
    private _cancelableController: AbortController;
    // For reliable channel, basically for all channels in reliable mode
    private _reliableController: AbortController;
    // To know if the last sequence was live or not
    private _lastSequenceWasLive: boolean = true;
    private _maxSequenceDuration: number = 0;
    private _sequencePattern: string;
    private _cmcd?: CMCD;
    private _trackSeparator: string = '';

    constructor(playing: IPlaying, params: Connect.Params) {
        super(playing, 'https', params);
        this._sequencePattern = '';
        this._alterableController = new AbortController();
        this._cancelableController = new AbortController();
        this._reliableController = new AbortController();
        playing.signal.addEventListener(
            'abort',
            () => {
                this._alterableController.abort();
                this._cancelableController.abort();
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
        const extension = Util.getExtension(url.pathname).toLowerCase();
        if (extension !== '.json') {
            // URL is '/wrts/' + params.streamName + params.mediaExt, change it to request index.json
            if (extension) {
                url.pathname = url.pathname.slice(0, -extension.length);
            }
            if (!url.pathname.endsWith('/')) {
                url.pathname += '/';
            }
            url.pathname += 'index.json';
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
                response = await this.fetchWithRTT(url, { signal: playing.signal });
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
        const version = metadata.protocolVersion.major;
        if (version < 2) {
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
                const sequenceFirstTime = Number(mSequence.first?.time);
                const idDiff = sequenceId - sequenceFirstId;
                if (idDiff > 0 && !isNaN(sequenceFirstTime)) {
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
            { signal: playing.signal }
        );

        let videoTrack: MediaTrack | undefined;
        playing.on(
            'Stall',
            async () => {
                // STALL
                this._upController?.abort();
                if (videoTrack?.down || !this._lastSequenceWasLive) {
                    // Stop media reception immediately to relieve socket pressure
                    // before attempting to switch to a lower rendition or
                    // before to try to recover live edge if we are not on it
                    this._alterableController.abort();
                    this._cancelableController.abort();
                }
            },
            { signal: playing.signal }
        );

        // Start download
        const upRetry = new AdaptiveRetry();
        upRetry.log = this.log.bind(this, 'Adaptive Bitrate,') as ILog;

        while (!this.closed) {
            // Process MBR
            videoTrack =
                this.videoSelected == null && playing.bufferState !== BufferState.NONE
                    ? metadata.tracks.get(tracks.video ?? -1)
                    : undefined;
            if (videoTrack) {
                const bandwidthMeasure = this.recvByteRate.value();
                let up = false;
                const aborted = this._cancelableController.signal.aborted || this._alterableController.signal.aborted;
                const low = playing.bufferState === BufferState.LOW && !this._upController;
                if (
                    aborted || // we have aborted a sequence because of a stall or a low buffer
                    low // we are low in buffer without UP emulation perturbation
                ) {
                    // We have to down one level
                    if (!this._upController && !upRetry.failed) {
                        // was no emulation, and no a consecutive fail
                        // so we have to down at least of one level
                        videoTrack = videoTrack.down ?? videoTrack;
                    }
                    // Compute the best rendition to play according to the bandwidth measure
                    // Just when was not already failing before to avoid bad measure on consecutive failures
                    const audioBandwidth = metadata.tracks.get(tracks.audio ?? -1)?.bandwidth ?? 0;
                    while (videoTrack.down && videoTrack.bandwidth + audioBandwidth > bandwidthMeasure) {
                        videoTrack = videoTrack.down;
                    }
                    // Mark the failure AFTER checking upRetry.failed
                    upRetry.fail();
                } else if (this._upController && !this._upController.signal.aborted && playing.bufferState !== BufferState.LOW) {
                    // UP emulation success, we can try to go up one level
                    up = true;
                    videoTrack = videoTrack.up ?? videoTrack;
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
                upRetry.reset();
            }

            // Prepare channels
            const channels = {
                alterable: new Set<number>(), // Frame alterable
                cancelable: new Set<number>(), // Sequence cancelable
                reliable: new Set<number>() // Reliable
            };
            /// Audio
            if (tracks.audio != null && tracks.audio >= 0) {
                (this.reliable ? channels.reliable : channels.cancelable).add(tracks.audio);
            }
            /// Video
            if (tracks.video != null && tracks.video >= 0) {
                if (this.reliable) {
                    channels.reliable.add(tracks.video);
                } else if (metadata.tracks.get(tracks.video)?.down) {
                    channels.cancelable.add(tracks.video);
                } else {
                    // last rendition => we can try to drop frames
                    channels.alterable.add(tracks.video);
                }
            }
            /// Data
            /// WIP use a possible data.reliable information to make it always
            /// reliable for reliable data channel like SCTE35 for example
            const dataTracks = this.reliable ? channels.reliable : channels.cancelable;
            for (const track of tracks.data ?? []) {
                dataTracks.add(track);
            }

            // Compute Skip Sequences if we don't have reliable channels for this sequence
            if (
                !channels.reliable.size &&
                playing.bufferState === BufferState.LOW &&
                playing.buffering &&
                this.currentTime >= 0
            ) {
                // We can skip some frames while buffering because means a stall has occurred
                if (this._maxSequenceDuration) {
                    let newSequence = Infinity;
                    let fixLiveTime = 0;

                    // Check newSequence exists
                    while (metadata.liveTime > this.currentTime) {
                        newSequence = Math.min(
                            sequence + Math.floor((metadata.liveTime - this.currentTime) / this._maxSequenceDuration),
                            newSequence - 1
                        );

                        if (newSequence <= sequence) {
                            // nothing to skip
                            break;
                        }

                        // HEAD request to check if frame exists!
                        const response = await this._downloadSequence(
                            playing,
                            this._reliableController,
                            Media.getMainTrack(tracks) ?? [],
                            newSequence,
                            0
                        );
                        if (this.closed) {
                            return;
                        }
                        if (response.ok) {
                            this.log(
                                `Skip sequences ${sequence} to ${newSequence - 1} ${Util.stringify({
                                    delay: metadata.liveTime - this.currentTime,
                                    maxSequenceDuration: this._maxSequenceDuration
                                })}`
                            ).warn();
                            sequence = newSequence;
                            this._lastSequenceWasLive = isNaN(parseInt(response.headers.get('sequence-duration') || ''));
                            break;
                        }

                        fixLiveTime -= this._maxSequenceDuration;
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

            // Effective download of the sequence

            // Reset controller
            this._cancelableController = new AbortController();
            this._alterableController = new AbortController();
            this._upController = undefined;

            // Create promises
            const promises = [];
            if (channels.reliable.size) {
                if (version < 2 || !playing.tracksCombinable) {
                    for (const track of channels.reliable) {
                        promises.push(this._downloadSequence(playing, this._reliableController, track, sequence));
                    }
                } else {
                    promises.push(this._downloadSequence(playing, this._reliableController, channels.reliable, sequence));
                }
            }
            if (channels.cancelable.size) {
                if (version < 2 || !playing.tracksCombinable) {
                    for (const track of channels.cancelable) {
                        promises.push(this._downloadSequence(playing, this._cancelableController, track, sequence));
                    }
                } else {
                    promises.push(this._downloadSequence(playing, this._cancelableController, channels.cancelable, sequence));
                }
            }
            if (channels.alterable.size) {
                if (version < 2 || !playing.tracksCombinable) {
                    for (const track of channels.alterable) {
                        promises.push(this._downloadSequence(playing, this._alterableController, track, sequence));
                    }
                } else {
                    promises.push(this._downloadSequence(playing, this._alterableController, channels.alterable, sequence));
                }
            }
            if (!promises.length) {
                throw Error('Nothing to download, no track enabled?');
            }

            // Add a factice track to emulate UP rendition?
            let mbrOK = false;
            if (
                videoTrack &&
                sequence > 0 &&
                this._maxSequenceDuration &&
                this._lastSequenceWasLive && // just if we are on live edge, any delay means a possible bandwidth issue
                upRetry.try() &&
                videoTrack.up &&
                !Media.overScreenSize(videoTrack.up.resolution, playing.maximumResolution)
            ) {
                const extraByteRateRequired = videoTrack.up.bandwidth - videoTrack.bandwidth;
                this._upController = new AbortController();
                if (extraByteRateRequired > 0) {
                    const bytes = Math.ceil((extraByteRateRequired * this._maxSequenceDuration) / 1000);
                    this.log(
                        `Bandwidth emulation of ${((videoTrack.up.bandwidth * 8) / 1000).toFixed()}kbs by adding ${((extraByteRateRequired * 8) / 1000).toFixed()}kbs to current ${((videoTrack.bandwidth * 8) / 1000).toFixed()}kbs`
                    ).info();
                    this._downloadSequence(playing, this._upController, videoTrack.up.id, sequence - 1, bytes).then(
                        response => (mbrOK = response.ok)
                    );
                } else {
                    mbrOK = true;
                    this.log(
                        `Bandwidth emulation of ${((videoTrack.up.bandwidth * 8) / 1000).toFixed()}kbs requires no extra bandwidth over current ${((videoTrack.bandwidth * 8) / 1000).toFixed()}kbs`
                    ).warn();
                }
            }

            // Effective download
            this.initTracks(tracks); // announce track to receive!
            const what: Array<string | number> = [...channels.reliable];
            if (channels.cancelable.size) {
                what.push('cancelable', ...channels.cancelable);
            }
            if (channels.alterable.size) {
                what.push('alterable', ...channels.alterable);
            }
            this.log(`Download ${Util.stringify(what)} sequence ${sequence} at ${this.currentTime}`).info();
            const responses = await Promise.all(promises);
            if (this.closed) {
                return;
            }
            let success = 0;
            for (const response of responses) {
                if (response.error) {
                    // unrecoverable error
                    return this.close({
                        type: 'SourceError',
                        name: response.status === 400 ? 'Malformed payload' : 'Request error',
                        detail: response.error
                    });
                }

                if (response.ok) {
                    // 200-299
                    if (!success++) {
                        // at least one responses is ok,
                        // so we have to move to the next sequence
                        ++sequence;
                    }
                    if (response.status === 206) {
                        // partial content, cancel the MBR UP attempt
                        mbrOK = false;
                    }
                } // else is 408 => aborted by controller
            }

            // STOP MBR
            if (
                this._upController &&
                (!mbrOK || // MBR NOK, or always running
                    success < responses.length || // Error in media download
                    this._upController.signal.aborted) // Aborted possibly after success, means congestion
            ) {
                // Cancel MBR request if is always progressing
                // OR if sequence got a partial download
                // OR if sequence got a fail download (408 aborted)
                this._upController.abort();
                // learn this fail
                upRetry.fail();
                // display log
                this.log(
                    `Bandwidth emulation fails to reach ${(((videoTrack ? (videoTrack.up ?? videoTrack).bandwidth : 0) * 8) / 1000).toFixed()}kbs`
                ).warn();
            }
        } // Main sequence while loop
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
        } else if (controller === this._cancelableController) {
            controllerType = 'cancelable';
        } else if (controller === this._upController) {
            controllerType = 'emulated';
        }
        // Record the state BEFORE to start download because the operation is async
        // and variable instance like this._upController can change during the download
        const emulation = controller === this._upController;
        const alterable = controller === this._alterableController;

        if (typeof tracks == 'number') {
            tracks = [tracks];
        } else if (tracks instanceof Set) {
            // sorts
            tracks = Array.from(tracks).sort((a, b) => a - b);
        }
        if (!tracks.length) {
            return new Response(null, { status: 400, statusText: 'No track to download' });
        }

        const strTracks = tracks.join(this._trackSeparator);
        const url = new URL(
            this._sequencePattern.replace('{trackIds}', strTracks).replace('{sequenceId}', sequence.toFixed()),
            this.url
        );

        let onlyFirstSample = false;
        if (
            length == null &&
            alterable && // skip frame allowed
            !playing.buffering &&
            playing.bufferState === BufferState.LOW // we are low in last rendition before to download keyframe => last chance rendition !
        ) {
            // do the HEAD request to get first-sample-length
            const response = await this._downloadSequence(playing, controller, tracks, sequence, 0);
            if (response.ok) {
                // WIP remove old 'first-frame-length'
                length = parseInt(
                    response.headers.get('first-sample-length') || response.headers.get('first-frame-length') || ''
                );
                if (length > 0) {
                    const sequenceDuration = parseInt(response.headers.get('sequence-duration') || '');
                    if (!isNaN(sequenceDuration)) {
                        // We can opt for the first sample only if we have the sequence-duration information
                        onlyFirstSample = true;
                        this.log(
                            `Download only first video frame of ${controllerType} sequence ${sequence} track ${strTracks}`
                        ).warn();
                    }
                } else {
                    this.log('Cannot download only first video because there is no valid first-sample-length header').error();
                }
                if (!onlyFirstSample) {
                    length = undefined;
                }
            } else {
                // aborted, log already displaid and nothing downloaded
                if (this.closed) {
                    return response;
                }
                // maybe we have gotten a 404, due to immediate HEAD response and a possible origin switch
                // Try a full GET what ensures to wait future sequence if there is
                this.log(
                    `First video frame download for ${controllerType} sequence ${sequence} track ${strTracks} failed, switching to a full sequence download`
                ).error();
            }
        }

        let response;
        let reader: Reader | undefined;
        let headers;
        const bufferAmount = playing.bufferAmount;
        let lastError = '';

        while (!this.closed && !reader && !controller.signal.aborted) {
            if (headers) {
                await Util.sleep(400);
                this.log(`Fetch again ${controllerType} sequence ${sequence} track ${strTracks} from ${url}`).warn();
            } else {
                headers = new Headers();
                if (length) {
                    headers.set('range', 'bytes=0-' + (length - 1));
                }
            }

            try {
                const time = Util.time();
                if (length === 0 || emulation) {
                    // Only HEAD or GET without media (bandwidth emulation)
                    response = await this.fetch(url, {
                        method: length === 0 ? 'HEAD' : 'GET',
                        signal: controller.signal,
                        cache: 'no-store',
                        headers
                    });
                } else {
                    response = await this.fetchMedia(url, tracks, {
                        method: 'GET',
                        signal: controller.signal,
                        headers
                    });
                }

                if (length === 0) {
                    // Ony header: whatever the result ok/error we can return as now!
                    return response;
                }

                if (response.error) {
                    if (
                        response.status === 404 &&
                        // A 404 for an UP emulation on a previous segment is an unexpected error
                        !emulation &&
                        // A 404 while waiting means it's a live sequence that is not available yet
                        Util.time() - time > 1000
                    ) {
                        // WIP: distinguish these two cases using different HTTP status codes:
                        // - 410 GONE for a sequence that is no longer available (before the first)
                        // - 404 NOT FOUND for a sequence that is not available yet (after the last)
                        this.log(`Sequence ${sequence} track ${strTracks} not available yet, waiting...`).warn();
                        continue;
                    }
                    // unrecoverable error, no need to retry
                    return response;
                }

                let sequenceDuration = parseInt(response.headers.get('sequence-duration') || '');
                if (!emulation) {
                    this._lastSequenceWasLive = isNaN(sequenceDuration);
                    const maxSequenceDuration = parseInt(response.headers.get('max-sequence-duration') || '');
                    if (maxSequenceDuration > 0) {
                        this._maxSequenceDuration = maxSequenceDuration;
                    }
                }

                const body = response.body?.getReader();
                do {
                    const chunk = await body?.read();
                    if (!chunk || chunk.done) {
                        // All downloaded: SUCCESS!
                        return response;
                    }
                    if (emulation) {
                        // UP emulation !
                        continue;
                    }
                    if (!reader) {
                        reader = this.newReader();
                        reader.onMetadata = Util.EMPTY_FUNCTION;
                        reader.onInitTracks = Util.EMPTY_FUNCTION;
                        reader.onSample = (type: Media.Type, trackId: number, sample: Media.Sample) => {
                            if (alterable && sequenceDuration >= sample.duration) {
                                // We are on a alterable sequence and we have a valid sequenceDuration,
                                // so we can skip the rest of the sequence if we lost buffer
                                sequenceDuration -= sample.duration;
                                if (!onlyFirstSample && bufferAmount && !playing.bufferAmount) {
                                    // We lost buffer (bufferAmount dropped to 0) while it was previously available
                                    // Abort the rest of the sequence, acceptable because is the alterable controller,
                                    // cannot impact other tracks
                                    controller.abort();
                                }
                                if (onlyFirstSample || controller.signal.aborted) {
                                    // stretch duration for all the sequence
                                    if (sequenceDuration) {
                                        sample.duration += sequenceDuration;
                                        this.skipMedia(type, sequenceDuration);
                                    }
                                    // ensure no other call!
                                    if (reader) {
                                        reader.onSample = Util.EMPTY_FUNCTION;
                                    }
                                }
                            }
                            this.readSample(type, trackId, sample);
                        };
                    }
                    reader.read(chunk.value);
                } while (!controller.signal.aborted);
            } catch (e) {
                // Request error, already displaid as a console error log => try again!
                lastError = Util.stringify(e);
            }
        } // main while loop

        if (this.closed || emulation) {
            // - Closed or UP emulation => we don't want any log or caller behavior: not ok + no error
            return new Response(null, { headers: response?.headers, status: 408 });
        }

        // download started but failed, impossible to retry without rewind the reception
        if (controller.signal.aborted) {
            this.log(`Abort ${controllerType} sequence ${sequence} track ${strTracks}`).warn();
        } else {
            this.log(
                `Fails to download ${controllerType} sequence ${sequence} track ${strTracks} from ${url}, ${lastError || 'no error'}`
            ).error();
        }
        // 206 => OK, sequence partially downloaded, cannot try again without media duplication
        // 408 => NOK, sequence not downloaded at all, try again?
        return new Response(null, { headers: response?.headers, status: reader ? 206 : 408 });
    }

    protected setTracks(tracks: Media.Tracks) {
        // change tracks is allowed and done in play method
    }
}
