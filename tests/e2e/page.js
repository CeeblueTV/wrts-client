/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// Test page of the end-to-end tests: plays a fragmented MP4 file like a live stream with the Player,
// and exposes its state to the test runner (see run.mjs)

import * as lib from '/dist/wrts-client.bundle.js';
const { Player, Source, utils, AudioRenderer } = lib;
const { Connect, Util, log, LogLevel } = utils;

const logs = [];
log.level = LogLevel.INFO;
const text = a => {
    if (typeof a === 'string') {
        return a;
    }
    try {
        return JSON.stringify(a, (k, v) =>
            v instanceof Uint8Array ? `[${v.byteLength} bytes]` : k === 'up' || k === 'down' ? undefined : v
        );
    } catch {
        return String(a);
    }
};
log.on = (level, args) => {
    if (level !== 'debug') {
        logs.push(level + ' ' + args.map(text).join(' '));
    }
};

// Tap the sound sent to the audio output, to measure what is really heard
let analyser;
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (destination, ...args) {
    if (destination instanceof AudioDestinationNode && this instanceof GainNode) {
        analyser = this.context.createAnalyser();
        analyser.fftSize = 32768;
        analyser.smoothingTimeConstant = 0;
        // the analyser stays pulled by the output, to hear silence when the renderer is disconnected
        connect.call(this, analyser);
        connect.call(analyser, destination);
        return destination;
    }
    return connect.call(this, destination, ...args);
};
function heard() {
    if (!analyser) {
        return { rms: 0, freq: 0 };
    }
    const time = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(time);
    let sum = 0;
    for (const v of time) {
        sum += v * v;
    }
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(spectrum);
    let best = 1;
    for (let i = 2; i < spectrum.length - 1; ++i) {
        if (spectrum[i] > spectrum[best]) {
            best = i;
        }
    }
    // parabolic interpolation of the peak
    const a = spectrum[best - 1],
        b = spectrum[best],
        c = spectrum[best + 1];
    const peak = best + (0.5 * (a - c)) / (a - 2 * b + c);
    return { rms: Math.sqrt(sum / time.length), freq: (peak * analyser.context.sampleRate) / analyser.fftSize };
}

// Simulate the autoplay policy of browsers (not enforced in headless mode): the AudioContext stays suspended
// until a user gesture on the page
const blocked = new URLSearchParams(location.search).get('blocked'); // 'all', or 'audio' to block only the AudioContext
let gesture = !blocked;
if (!gesture) {
    const contexts = [];
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
        constructor(options) {
            super(options);
            contexts.push(this);
            this.suspend();
        }
        resume() {
            return gesture ? super.resume() : new Promise(() => {});
        }
    };
    for (const type of ['pointerup', 'mousedown', 'keydown', 'click']) {
        window.addEventListener(
            type,
            () => {
                gesture = true;
            },
            { capture: true }
        );
    }
    // like the browser, refuse to play an audible media element before a user gesture
    const play = HTMLMediaElement.prototype.play;
    if (blocked === 'all') {
        HTMLMediaElement.prototype.play = function () {
            return gesture || this.muted
                ? play.call(this)
                : Promise.reject(
                      new DOMException(
                          'play() failed because the user did not interact with the document first',
                          'NotAllowedError'
                      )
                  );
        };
    }
}

/**
 * Test source: plays a fragmented MP4 file like a live stream, each fragment is delivered when its media time is reached
 */
class FileSource extends Source {
    static hold = 0; // ms, simulate a network freeze: nothing delivered during this time, then a burst
    static dropAudio = 0; // ms of audio to lose, to create a hole in the audio timeline
    constructor(playing, params) {
        super(playing, 'http', params, Connect.Type.DIRECT_STREAMING);
    }
    setReliability() {}
    readAudio(trackId, sample) {
        if (FileSource.dropAudio > 0) {
            FileSource.dropAudio -= sample.duration;
            return;
        }
        super.readAudio(trackId, sample);
    }
    setTracks() {}
    async readMetadata(metadata) {
        // The metadata built by CMAFReader from the file index its tracks one below the samples, realign them
        const tracks = [...metadata.tracks.values()];
        metadata.tracks.clear();
        for (const track of tracks) {
            track._id += 1;
            metadata.tracks.set(track.id, track);
        }
        await super.readMetadata(metadata);
        if (this.closed) {
            return;
        }
        this.initTracks({ audio: metadata.audioTracks[0]?.id, video: metadata.videoTracks[0]?.id });
    }
    async play() {
        const data = new Uint8Array(await (await fetch(FileSource.file)).arrayBuffer());
        const view = new DataView(data.buffer);
        const reader = this.newReader();
        let lastTime = 0;
        reader.on('sample', (type, trackId, sample) => {
            if (type) {
                lastTime = Math.max(lastTime, sample.time + sample.duration);
            }
        });
        // split the top-level boxes: the init segment, then moof+mdat fragments
        let position = 0,
            begin = 0,
            firstTime,
            start;
        while (position + 8 <= data.length && !this.closed) {
            const size = view.getUint32(position),
                type = String.fromCharCode(...data.subarray(position + 4, position + 8));
            position += size;
            if (type !== 'mdat' && type !== 'moov') {
                continue;
            }
            reader.read(data.subarray(begin, position));
            begin = position;
            if (type === 'moov') {
                await Util.sleep(50);
                continue;
            }
            if (firstTime == null) {
                firstTime = lastTime;
                start = performance.now();
            }
            // wait the media time of the fragment
            for (;;) {
                if (FileSource.hold > 0) {
                    const hold = FileSource.hold;
                    FileSource.hold = 0;
                    await Util.sleep(hold);
                }
                const wait = lastTime - firstTime - (performance.now() - start);
                if (wait <= 0 || this.closed) {
                    break;
                }
                await Util.sleep(Math.min(wait, 20));
            }
        }
    }
}

const video = document.getElementById('video');
const events = { seeking: 0, waiting: 0, ratechange: 0, pause: 0, playing: 0, stalled: 0 };
for (const name of Object.keys(events)) {
    video.addEventListener(name, () => ++events[name]);
}
let player,
    stopError,
    stalls = 0,
    started = false;

window.e2e = {
    lib,
    logs,
    events,
    heard,
    start({ file, engines, muted = false, adjust = true, preservesPitch = true, low, high, reliable = false }) {
        Player.audioEngines = engines;
        FileSource.file = file;
        video.muted = muted;
        stopError = undefined;
        stalls = 0;
        started = false;
        player = new Player(video, FileSource);
        player.preservesPitch = preservesPitch;
        if (low != null) {
            player.bufferLimitLow = low;
        }
        if (high != null) {
            player.bufferLimitHigh = high;
        }
        if (!adjust) {
            player.onBufferChange = () => {};
        }
        player.onStart = () => {
            started = true;
            if (reliable) {
                player.reliable = true;
            }
        };
        player.onStop = error => {
            stopError = error ?? null;
        };
        player.onStall = () => {
            ++stalls;
        };
        player.start({ endPoint: location.origin + '/' + file, streamName: 'test', mediaExt: 'mp4' });
        window.e2e.player = player;
    },
    stop() {
        player?.stop();
    },
    hold(ms) {
        FileSource.hold = ms;
    },
    dropAudio(ms) {
        FileSource.dropAudio = ms;
    },
    state() {
        return {
            now: performance.now(),
            started,
            running: player.running,
            stopError,
            time: player.currentTime,
            videoTime: video.currentTime,
            drift: Math.round((video.currentTime - player.currentTime) * 1000),
            rate: player.playbackRate,
            videoRate: video.playbackRate,
            speed: +player.playbackSpeed.toFixed(3),
            buffer: player.bufferAmount,
            state: player.bufferState,
            buffering: player.buffering,
            paused: player.paused,
            engine: player.audioEngine,
            stalls,
            constraint: player.playbackConstraint,
            skipped: player.computeStats().skippedAudio,
            videoPaused: video.paused,
            readyState: video.readyState,
            dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
            frames: video.getVideoPlaybackQuality().totalVideoFrames,
            decodedAhead: player._playback?._audio
                ? +(player._playback._audio.renderer.endTime - player.currentTime).toFixed(2)
                : undefined,
            context: AudioRenderer.unlock()?.state,
            ...heard(),
            events: { ...events }
        };
    }
};
window.e2eReady = true;
