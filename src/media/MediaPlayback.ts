/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { ByteRate, ILog, Loggable, Util } from '@ceeblue/web-utils';
import { MediaBuffer, MediaBufferError } from './MediaBuffer';
import * as Media from './Media';
import { Metadata } from './Metadata';
import { AudioPlayback, AudioPlaybackError } from './audio/AudioPlayback';
import { hasAudioEngine } from './audio/AudioDecoders';
import { AudioEngine } from './audio/PCMDecoder';

const TIME_UPDATE_PERIOD = 100; // ms, period of onTimeUpdate when audio conducts the playback
const SYNC_DEADBAND = 0.025; // seconds, video drift tolerated without correction
const SYNC_HORIZON = 1; // seconds, time to resorb a video drift with its playback rate
const SYNC_MIN_CORRECTION = 0.02; // minimum playback rate correction, to resorb even a small drift
const SYNC_MAX_CORRECTION = 0.25; // maximum playback rate correction
const SYNC_SEEK = 0.35; // seconds, video drift beyond which a seek is more efficient than a playback rate correction
const SYNC_SEEK_PERIOD = 1000; // ms, minimum delay between two seeks of synchronization
const SYNC_SEEK_LEAD_MAX = 1; // seconds, maximum seek duration compensated
const SYNC_DRIFT_SMOOTHING = 0.3; // weight of a new drift measure, to filter the precision of the video time
const SYNC_DRIFT_JUMP = 0.1; // seconds, drift change which is a real jump rather than a measure imprecision
const VIDEO_SPEED_WINDOW = 2000; // ms, window to measure if the video follows its playback rate
const VIDEO_SPEED_MARGIN = 0.1; // seconds of video required ahead to measure its speed
const VIDEO_PLAY_RETRY = 1000; // ms, delay before to retry to play the video when the browser has refused

export type MediaPlaybackError =
    /**
     * Represents a Media Buffer creation issue
     */
    | { type: 'MediaPlaybackError'; name: 'Media buffer init error'; mimeType: string; detail: string }
    /**
     * Represents an error when attempting to create a new track
     */
    | { type: 'MediaPlaybackError'; name: 'Cannot create a new track'; trackType: Media.Type }
    /**
     * Represents an error when attempting to remove a track
     */
    | { type: 'MediaPlaybackError'; name: 'Cannot remove a track'; trackType: Media.Type }
    /**
     * Represents a Media Buffer issue
     */
    | MediaBufferError
    /**
     * Represents an audio decoding or rendering issue
     */
    | AudioPlaybackError;

/**
 * Renders the audio and video samples, and conducts their playback.
 *
 * Video is always given to the video element through Media Source Extensions. Audio is by default decoded and rendered
 * outside of the video element (see {@link AudioPlayback}), and becomes the conductor of the playback: its media time
 * is the clock, the video element only follows it. The video playback rate is continuously adjusted to stay on the
 * audio time, with a seek when the drift is too large. This way a playback rate change never disturbs the sound, and
 * the browser has no audio to resynchronize in the video element.
 *
 * When audio cannot be rendered outside of the video element (protected audio, CMAF passthrough, browser without any
 * {@link AudioEngine} usable) it is given to the video element too, which conducts the playback itself as usual.
 *
 * In both cases MediaPlayback exposes the playback like a media element does: {@link currentTime},
 * {@link playbackRate}, {@link play}, {@link pause} and the related events.
 */
export class MediaPlayback extends Loggable {
    /**
     * Fired on renderer close
     * @param error error description on an improper closure
     * @event
     */
    onClose(error?: MediaPlaybackError) {
        if (error) {
            this.log('onClose', error).error();
        } else {
            this.log('onClose').info();
        }
    }

    /**
     * Fired when the playback buffer exceeds its capacity,
     * a play or set a startTime to remove the beginning can resolve the situation
     * @event
     */
    onBufferOverflow() {
        this.log('buffer overflow').warn();
    }

    /**
     * Fired when the renderer makes progress in time.
     * @event
     */
    onProgress() {}

    /**
     * Event fire when audio data are appended to the renderer, basically here to debug MSE ingestion.
     * Not fired when audio is rendered outside of the video element.
     * @event
     */
    onAudioAppended(data: Uint8Array) {}

    /**
     * Event fire when video data are appended to the renderer, basically here to debug MSE ingestion
     * @event
     */
    onVideoAppended(data: Uint8Array) {}

    /**
     * Fired when the playback stops because it lacks media data
     * @event
     */
    onWaiting() {}

    /**
     * Fired when the playback can start or continue
     * @event
     */
    onCanPlay() {}

    /**
     * Fired when the playback is started, or restarted after a pause or a lack of media data
     * @event
     */
    onPlaying() {}

    /**
     * Fired when a seek starts
     * @event
     */
    onSeeking() {}

    /**
     * Fired when a seek is done
     * @event
     */
    onSeeked() {}

    /**
     * Fired when the playback is paused
     * @event
     */
    onPause() {}

    /**
     * Fired periodically while the playback progresses
     * @event
     */
    onTimeUpdate() {}

    /**
     * Renderer is closed
     */
    get closed(): boolean {
        return this._audio == null && this._audioBuffer == null && this._videoBuffer == null;
    }

    get startTime(): number {
        // Start time is the first common sync time between the tracks
        // Considerate also case where a track is disabled
        const audio = this._audio || this._audioBuffer;
        if (audio) {
            if (this._videoBuffer) {
                return Math.max(audio.startTime, this._videoBuffer.startTime);
            }
            return audio.startTime;
        }
        return this._videoBuffer?.startTime || 0;
    }
    set startTime(value: number) {
        if (this._videoBuffer) {
            this._videoBuffer.startTime = value;
        }
        const audio = this._audio || this._audioBuffer;
        if (audio) {
            audio.startTime = value;
        }
    }

    get endTime(): number {
        // Start time is the last common sync time between the tracks
        // Considerate also case where a track is disabled
        const audio = this._audio || this._audioBuffer;
        if (audio) {
            if (this._videoBuffer) {
                if (this._videoBuffer.endTime > audio.endTime) {
                    return Math.max(this._videoBuffer.startTime, audio.endTime);
                }
                return Math.max(audio.startTime, this._videoBuffer.endTime);
            }
            return audio.endTime;
        }
        return this._videoBuffer?.endTime || 0;
    }

    get audioEnabled(): boolean {
        return this._audio || this._audioBuffer ? true : false;
    }

    /**
     * Enable or disable audio, prefer {@link setTracks} to select the right {@link AudioEngine} from the metadata
     */
    set audioEnabled(value: boolean) {
        if (this.audioEnabled === value) {
            return;
        }
        if (value) {
            // enable audio
            if (this._audioInVideo ?? !hasAudioEngine()) {
                this._audioBuffer = this._newBuffer('audio/mp4');
            } else {
                this._newAudio();
            }
        } else if (this._audio) {
            // The video element conducts the playback again
            const audio = this._audio;
            this._audio = undefined;
            const rate = audio.renderer.playbackRate;
            audio.abort();
            this._video.playbackRate = rate;
            if (!this._paused && this._video.paused) {
                this._video.play().catch(Util.EMPTY_FUNCTION);
            }
        } else {
            // disable impossible
            this.close({ type: 'MediaPlaybackError', name: 'Cannot remove a track', trackType: Media.Type.AUDIO });
        }
    }

    get videoEnabled(): boolean {
        return this._videoBuffer ? true : false;
    }

    set videoEnabled(value: boolean) {
        if (this.videoEnabled === value) {
            return;
        }
        if (value) {
            // enable video
            this._videoBuffer = this._newBuffer('video/mp4');
        } else {
            // disable impossible
            this.close({ type: 'MediaPlaybackError', name: 'Cannot remove a track', trackType: Media.Type.VIDEO });
        }
    }

    /**
     * Engine currently playing the audio, undefined when audio is disabled or not decoded yet
     */
    get audioEngine(): AudioEngine | undefined {
        if (this._audioBuffer) {
            return AudioEngine.MSE;
        }
        return this._audio?.engine;
    }

    /**
     * True when audio conducts the playback, false when it is the video element
     */
    get audioConducting(): boolean {
        return this._audio ? true : false;
    }

    /**
     * Ratio of slowdown of the video relative to the playback rate asked to the video element, when audio conducts
     * the playback: `0` means the video follows, `1` means the video doesn't progress whereas it has media to play.
     * It reveals a device unable to decode the video in time, the audio conductor being never slowed down by video.
     * Returns `undefined` when the video element conducts the playback itself.
     */
    get videoSlowdown(): number | undefined {
        if (!this._audio || !this._videoBuffer) {
            return;
        }
        const expected = this._videoExpected.value();
        return expected > 0 ? Math.min(Math.max(0, 1 - this._videoProgress.value() / expected), 1) : 0;
    }

    /**
     * Current playback time in seconds, set it to seek
     */
    get currentTime(): number {
        return this._audio ? this._audio.renderer.currentTime : this._video.currentTime;
    }

    set currentTime(value: number) {
        const audio = this._audio;
        if (!audio) {
            this._video.currentTime = value;
            return;
        }
        // Seek the conductor, then the video follows
        audio.seek(value);
        this.onSeeking();
        if (this._videoBuffer && this._video.readyState >= HTMLMediaElement.HAVE_METADATA) {
            // Take the lead of the seek duration when the conductor doesn't wait
            this._seekVideo(value + (this._running() ? this._seekLead : 0), false);
        }
    }

    /**
     * Playback rate
     */
    get playbackRate(): number {
        return this._audio ? this._audio.renderer.playbackRate : this._video.playbackRate;
    }

    set playbackRate(value: number) {
        if (this._audio) {
            this._audio.renderer.playbackRate = value;
            this._sync();
        } else {
            this._video.playbackRate = value;
        }
    }

    /**
     * True if the pitch of the audio is preserved when {@link playbackRate} is different of 1, the default.
     * Works only when audio conducts the playback, otherwise see HTMLMediaElement.preservesPitch.
     */
    get preservesPitch(): boolean {
        return this._preservesPitch;
    }

    set preservesPitch(value: boolean) {
        this._preservesPitch = value;
        if (this._audio) {
            this._audio.renderer.preservesPitch = value;
        }
    }

    /**
     * True when the playback is paused
     */
    get paused(): boolean {
        return this._audio ? this._paused : this._video.paused;
    }

    /**
     * True during a seek
     */
    get seeking(): boolean {
        if (!this._audio) {
            return this._video.seeking;
        }
        // A seek to synchronize the video is not a seek of the playback
        return this._audio.renderer.seeking || (this._video.seeking && this._videoSeek === false);
    }

    /**
     * Ready state of the playback, with the values of HTMLMediaElement.readyState
     */
    get readyState(): number {
        if (!this._audio) {
            return this._video.readyState;
        }
        const audio = this._audio.renderer.starved ? HTMLMediaElement.HAVE_METADATA : HTMLMediaElement.HAVE_ENOUGH_DATA;
        return this._videoBuffer ? Math.min(audio, this._video.readyState) : audio;
    }

    /**
     * True when the media buffered by the video element has a hole
     */
    get fragmented(): boolean {
        try {
            return this._video.buffered.length > 1;
        } catch (_) {
            return false;
        }
    }

    private _audioBuffer?: MediaBuffer; // audio played by the video element
    private _audio?: AudioPlayback; // audio played outside the video element, and conductor of the playback
    private _audioInVideo?: boolean;
    private _videoBuffer?: MediaBuffer;
    private _mediaSource?: MediaSource;
    private _video: HTMLVideoElement;
    private _passthroughCMAF: boolean;
    private _endPrevTime?: number;
    private _events: Map<string, () => void>;
    private _preservesPitch: boolean = true;
    // Playback conducted by audio
    private _paused: boolean = true;
    private _timeUpdated: number = 0;
    private _videoSeek?: boolean; // video seek in progress: true to synchronize, false for a seek of the playback
    private _videoPlaying?: Promise<void>;
    private _videoPlayFailed: number = 0; // time of the last video play refused
    private _syncSeeked: number = 0;
    private _seekLead: number = 0; // seconds, duration of a video seek to compensate
    private _correcting: boolean = false;
    private _drift?: number; // seconds, smoothed drift of the video from its conductor
    private _videoProgress: ByteRate = new ByteRate(VIDEO_SPEED_WINDOW); // ms of video played by second
    private _videoExpected: ByteRate = new ByteRate(VIDEO_SPEED_WINDOW); // ms of video expected by second
    private _videoMeasure?: { time: number; at: number }; // previous video time measure

    constructor(video: HTMLVideoElement, mediaSource: MediaSource, passthroughCMAF: boolean = false) {
        super();
        this._video = video;
        this._passthroughCMAF = passthroughCMAF;
        this._mediaSource = mediaSource;
        this._paused = video.paused;
        this._events = new Map<string, () => void>([
            ['waiting', () => this._onVideoWaiting()],
            ['canplay', () => this._onVideoCanPlay()],
            ['playing', () => this._onVideoPlaying()],
            ['seeking', () => this._onVideoSeeking()],
            ['seeked', () => this._onVideoSeeked()],
            ['pause', () => this._onVideoPause()],
            ['timeupdate', () => this._onVideoTimeUpdate()],
            ['volumechange', () => this._onVideoVolumeChange()]
        ]);
        for (const [type, listener] of this._events) {
            video.addEventListener(type, listener);
        }
    }

    /**
     * Enable the tracks to play, and select how audio is rendered from the metadata of the stream:
     * outside of the video element, unless the audio tracks are protected or not supported by an other
     * {@link AudioEngine} than {@link AudioEngine.MSE}.
     * @param metadata metadata of the stream
     * @param audio true to enable audio
     * @param video true to enable video
     */
    setTracks(metadata: Metadata, audio: boolean, video: boolean) {
        if (!this.audioEnabled) {
            let audioInVideo = this._passthroughCMAF || !hasAudioEngine();
            for (const track of metadata.audioTracks) {
                if (track.contentProtection || track.audioEngine === AudioEngine.MSE) {
                    audioInVideo = true;
                }
            }
            this._audioInVideo = audioInVideo;
        }
        this.audioEnabled = audio;
        this.videoEnabled = video;
    }

    appendAudio(metadata: Metadata, trackId: number, sample: Media.Sample) {
        this.log('AUDIO', trackId, sample).debug();
        const audio = this._audio || this._audioBuffer;
        if (audio) {
            audio.append(metadata, trackId, sample);
        } else {
            this.close({ type: 'MediaPlaybackError', name: 'Cannot create a new track', trackType: Media.Type.AUDIO });
        }
    }

    appendVideo(metadata: Metadata, trackId: number, sample: Media.Sample) {
        this.log('VIDEO', trackId, sample).debug();
        if (this._videoBuffer) {
            this._videoBuffer.append(metadata, trackId, sample);
        } else {
            this.close({ type: 'MediaPlaybackError', name: 'Cannot create a new track', trackType: Media.Type.VIDEO });
        }
    }

    flush(fixAudioHole = false) {
        this._audioBuffer?.flush(fixAudioHole);
        this._videoBuffer?.flush();
    }

    /**
     * Start or resume the playback.
     * The promise returned is rejected when the browser refuses to play, like HTMLMediaElement.play().
     */
    async play(): Promise<void> {
        const audio = this._audio;
        if (!audio) {
            return this._video.play();
        }
        this._paused = false;
        this._videoPlaying = undefined;
        this._videoPlayFailed = 0;
        try {
            const playing = audio.renderer.play();
            this._sync(); // start the video
            await Promise.all([playing, this._videoPlaying]);
        } catch (e) {
            if (!this._paused && audio === this._audio) {
                this._paused = true;
                audio.renderer.pause();
                this._sync();
            }
            throw e;
        }
        if (!this._paused && audio === this._audio) {
            this.onPlaying();
        }
    }

    /**
     * Pause the playback
     */
    pause() {
        if (!this._audio) {
            this._video.pause();
            return;
        }
        if (this._paused) {
            return;
        }
        this._paused = true;
        this._audio.renderer.pause();
        this._sync();
        this.onPause();
    }

    close(error?: MediaPlaybackError) {
        const mediaSource = this._mediaSource;
        if (!mediaSource) {
            // alreayd closed
            return;
        }
        this._mediaSource = undefined;

        for (const [type, listener] of this._events) {
            this._video.removeEventListener(type, listener);
        }
        if (this._audio) {
            this._audio.abort();
            this._audio = undefined;
        }
        if (this._audioBuffer) {
            this._audioBuffer.abort();
            this._audioBuffer = undefined;
        }
        if (this._videoBuffer) {
            this._videoBuffer.abort();
            this._videoBuffer = undefined;
        }
        try {
            // can fail with something like 'The MediaSource's readyState is not 'open'.'
            mediaSource.endOfStream();
        } catch (_) {}
        this._endPrevTime = undefined;
        this.onClose(error);
    }

    private _newBuffer(mimeType: string): MediaBuffer | undefined {
        if (!this._mediaSource) {
            // closed
            return;
        }
        // Create buffer
        let buffer: MediaBuffer;
        try {
            // try catch because can throw exception without assigned a video.error reason!
            buffer = new MediaBuffer(this._mediaSource, mimeType, this._passthroughCMAF);
        } catch (e) {
            this.close({
                type: 'MediaPlaybackError',
                name: 'Media buffer init error',
                detail: Util.stringify(e),
                mimeType
            });
            return;
        }
        buffer.onDataAppended = buffer.isVideo ? data => this.onVideoAppended(data) : data => this.onAudioAppended(data);
        buffer.log = this.log.bind(this, buffer.isVideo ? 'VideoBuffer:' : 'AudioBuffer:') as ILog;
        buffer.onError = (error: MediaBufferError) => {
            if (error.name === 'Exceeds buffer size') {
                this.onBufferOverflow();
            } else {
                this.close(error);
            }
        };
        buffer.onUpdate = this._onBufferUpdate.bind(this);
        return buffer;
    }

    private _newAudio() {
        if (!this._mediaSource) {
            // closed
            return;
        }
        const video = this._video;
        const audio = (this._audio = new AudioPlayback());
        audio.log = this.log.bind(this, 'Audio:') as ILog;
        audio.onError = (error: AudioPlaybackError) => {
            if (error.name === 'Exceeds buffer size') {
                this.onBufferOverflow();
            } else {
                this.close(error);
            }
        };
        audio.onUpdate = this._onBufferUpdate.bind(this);
        // Audio conducts the playback from the current state of the video element
        const renderer = audio.renderer;
        this._paused = video.paused;
        renderer.playbackRate = video.playbackRate;
        renderer.preservesPitch = this._preservesPitch;
        renderer.volume = video.volume;
        renderer.muted = video.muted;
        if (video.currentTime) {
            audio.seek(video.currentTime);
        }
        if (!this._paused) {
            renderer.play().catch(Util.EMPTY_FUNCTION);
        }
        renderer.onWaiting = () => {
            this._sync();
            this.onWaiting();
        };
        renderer.onCanPlay = () => {
            this._sync();
            this.onCanPlay();
        };
        renderer.onSeeked = () => {
            // Without video to seek, the seek is done
            if (this._videoSeek !== false) {
                this.onSeeked();
            }
        };
        audio.onTick = () => {
            this._sync();
            const now = Util.time();
            if (now - this._timeUpdated >= TIME_UPDATE_PERIOD && renderer.running) {
                this._timeUpdated = now;
                this.onTimeUpdate();
            }
        };
        // The video element has no sound to cast anymore
        video.disableRemotePlayback = true;
    }

    private _onBufferUpdate() {
        if (this._endPrevTime == null || this.endTime > this._endPrevTime) {
            this._endPrevTime = this.endTime;
            this.onProgress();
        }
    }

    /// CONDUCTOR ///

    /**
     * True when audio conducts the playback and its media time is progressing
     */
    private _running(): boolean {
        return this._audio && !this._paused ? this._audio.renderer.running : false;
    }

    private _seekVideo(time: number, synchronizing: boolean) {
        this._videoSeek = synchronizing;
        this._correcting = false;
        // A seek is not a slowdown of the video, measure again once done
        this._drift = this._videoMeasure = undefined;
        try {
            this._video.currentTime = time;
        } catch (_) {
            this._videoSeek = undefined;
        }
    }

    /**
     * Keep the video on the media time of the audio conductor
     */
    private _sync() {
        const audio = this._audio?.renderer;
        const video = this._video;
        if (!audio || !this._videoBuffer || !this._mediaSource) {
            return;
        }
        if (!this._running()) {
            // The video waits its conductor
            if (!video.paused) {
                video.pause();
            }
            this._drift = this._videoMeasure = undefined;
            this._videoProgress.clear();
            this._videoExpected.clear();
            return;
        }
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
            return; // no video yet
        }
        if (video.paused) {
            if (Util.time() - this._videoPlayFailed < VIDEO_PLAY_RETRY) {
                return; // refused by the browser, retry later
            }
            const playing = (this._videoPlaying = video.play());
            playing.catch((e: unknown) => {
                this._videoPlayFailed = Util.time();
                if (playing !== this._videoPlaying) {
                    return;
                }
                this._videoPlaying = undefined;
                this.log('Video play failed', e).warn();
            });
        }
        if (video.seeking) {
            return;
        }
        if (this._videoSeek != null) {
            // Seek ended without event
            this._onVideoSeeked();
            return;
        }
        const target = audio.currentTime;
        const rate = audio.playbackRate;
        // Look if the video has media for the conductor time
        let end = -1;
        try {
            const buffered = video.buffered;
            for (let i = 0; i < buffered.length; ++i) {
                if (target >= buffered.start(i) - SYNC_DEADBAND && target < buffered.end(i)) {
                    end = buffered.end(i);
                    break;
                }
            }
        } catch (_) {}
        if (end < 0) {
            // Nothing to show at this time, the video continues at the conductor rate
            this._setVideoRate(rate);
            this._drift = this._videoMeasure = undefined;
            return;
        }
        const now = Util.time();
        const videoTime = video.currentTime;
        // Measure if the video follows the playback rate asked, only when it has media to play
        const measure = this._videoMeasure;
        if (measure && end - target > VIDEO_SPEED_MARGIN) {
            this._videoProgress.addBytes(Math.max(0, videoTime - measure.time) * 1000);
            this._videoExpected.addBytes((now - measure.at) * video.playbackRate);
        }
        this._videoMeasure = end - target > VIDEO_SPEED_MARGIN ? { time: videoTime, at: now } : undefined;

        if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !this._isPictureInPicture()) {
            // Nobody looks at the video and browsers can suspend its rendering: it will be resynchronized once visible
            this._setVideoRate(rate);
            this._drift = undefined;
            return;
        }

        // Smooth the drift, the time of a video element can progress by step
        let drift = videoTime - target;
        if (this._drift != null && Math.abs(drift - this._drift) < SYNC_DRIFT_JUMP) {
            drift = this._drift + (drift - this._drift) * SYNC_DRIFT_SMOOTHING;
        }
        this._drift = drift;
        if (Math.abs(drift) > SYNC_SEEK) {
            // Too far, jump to the conductor time
            if (now - this._syncSeeked >= SYNC_SEEK_PERIOD) {
                this._syncSeeked = now;
                this.log(`Video resynchronization, ${(drift * 1000).toFixed()}ms from audio`).info();
                this._seekVideo(Math.max(target, Math.min(target + this._seekLead * rate, end - 0.05)), true);
            }
            return;
        }
        // Resorb the drift with the playback rate, with a hysteresis to change it rarely
        let correction = 0;
        if (Math.abs(drift) > (this._correcting ? SYNC_DEADBAND / 2 : SYNC_DEADBAND)) {
            this._correcting = true;
            correction = Math.min(Math.max(Math.abs(drift) / SYNC_HORIZON, SYNC_MIN_CORRECTION), SYNC_MAX_CORRECTION);
            if (drift > 0) {
                correction = -correction;
            }
        } else {
            this._correcting = false;
        }
        this._setVideoRate(rate * (1 + correction));
    }

    private _isPictureInPicture(): boolean {
        try {
            return document.pictureInPictureElement === this._video;
        } catch (_) {
            return false;
        }
    }

    private _setVideoRate(rate: number) {
        // By step of 1% to limit the number of changes
        rate = Math.min(Math.max(Math.round(rate * 100) / 100, 0.1), 8);
        if (Math.fround(this._video.playbackRate) !== Math.fround(rate)) {
            this._video.playbackRate = rate;
        }
    }

    /// VIDEO ELEMENT EVENTS ///

    private _onVideoWaiting() {
        if (!this._audio) {
            this.onWaiting();
        } else if (!this._video.seeking && this._running()) {
            // The video lacks data whereas its conductor progresses
            this.onWaiting();
        }
    }

    private _onVideoCanPlay() {
        this._sync();
        this.onCanPlay();
    }

    private _onVideoPlaying() {
        if (!this._audio) {
            this.onPlaying();
        } else {
            this._sync();
        }
    }

    private _onVideoSeeking() {
        const audio = this._audio;
        if (!audio) {
            this.onSeeking();
        } else if (this._videoSeek == null) {
            // Seek on the video element from outside (user interface), the conductor follows
            this._videoSeek = false;
            audio.seek(this._video.currentTime);
            this.onSeeking();
        }
    }

    private _onVideoSeeked() {
        const videoSeek = this._videoSeek;
        this._videoSeek = undefined;
        if (!this._audio) {
            this.onSeeked();
            return;
        }
        if (videoSeek) {
            // Measure the duration of the seek to compensate it the next time
            const drift = this._video.currentTime - this._audio.renderer.currentTime;
            this._seekLead = Math.min(Math.max(this._seekLead - drift * 0.7, 0), SYNC_SEEK_LEAD_MAX);
        } else {
            this.onSeeked();
        }
        this._sync();
    }

    private _onVideoPause() {
        if (!this._audio) {
            this.onPause();
        }
        // otherwise paused to wait the conductor, or by the user: in this case it will be resumed by the conductor
    }

    private _onVideoTimeUpdate() {
        if (!this._audio) {
            this.onTimeUpdate();
        }
    }

    private _onVideoVolumeChange() {
        const audio = this._audio;
        if (audio) {
            audio.renderer.volume = this._video.volume;
            audio.renderer.muted = this._video.muted;
        }
    }
}
