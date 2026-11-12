/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { MediaTrack } from '../MediaTrack';
import { AudioEngine, PCMDecoder } from './PCMDecoder';
import { AudioRenderer } from './AudioRenderer';
import { WasmDecoder } from './WasmDecoder';
import { WebCodecsDecoder } from './WebCodecsDecoder';

let _engines = [AudioEngine.WEBCODECS, AudioEngine.WASM, AudioEngine.MSE];

/**
 * Get the audio engines usable to play audio, by order of preference.
 *
 * By default audio is decoded with WebCodecs, or with the WebAssembly decoder shipped with the library when WebCodecs
 * is unavailable, then rendered with the Web Audio API. The Media Source Extensions are the last resort, used for a
 * protected audio track or when nothing else is available.
 */
export function getAudioEngines(): AudioEngine[] {
    return _engines.slice();
}

/**
 * Set the audio engines usable to play audio, by order of preference.
 * @param engines engines ordered by preference, undefined restores the default order
 * @example
 * // Play audio like before, inside the video element
 * setAudioEngines([AudioEngine.MSE]);
 */
export function setAudioEngines(engines?: AudioEngine[]) {
    _engines = engines?.length ? engines.slice() : [AudioEngine.WEBCODECS, AudioEngine.WASM, AudioEngine.MSE];
}

/**
 * Returns true if the engine is able to decode the audio track, and to render it for a engine other than MSE
 */
async function supports(engine: AudioEngine, track: MediaTrack): Promise<boolean> {
    if (track.contentProtection) {
        return false; // only a media element can decrypt it
    }
    switch (engine) {
        case AudioEngine.WEBCODECS:
            return (await WebCodecsDecoder.supports(track)) && (await AudioRenderer.prepare());
        case AudioEngine.WASM:
            return (await WasmDecoder.supports(track)) && (await AudioRenderer.prepare());
        default:
    }
    return false;
}

/**
 * Find the preferred engine able to decode an audio track outside of the video element,
 * returns undefined if only {@link AudioEngine.MSE} can be tried
 * @param track audio track
 * @param excludes engines to ignore
 */
export async function findAudioEngine(track: MediaTrack, excludes?: Set<AudioEngine>): Promise<AudioEngine | undefined> {
    for (const engine of _engines) {
        if (engine === AudioEngine.MSE) {
            break; // MSE is preferred to the next engines
        }
        if (!excludes?.has(engine) && (await supports(engine, track))) {
            return engine;
        }
    }
}

/**
 * Returns true if audio can be rendered outside of the video element, without waiting an asynchronous detection
 */
export function hasAudioEngine(): boolean {
    if (!AudioRenderer.supported) {
        return false;
    }
    for (const engine of _engines) {
        if (
            engine === AudioEngine.WEBCODECS ? WebCodecsDecoder.available : engine === AudioEngine.WASM && WasmDecoder.available
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Create a decoder configured for the audio track, with the preferred engine able to decode it.
 * It fails if there is no engine for this track.
 * @param track audio track
 * @param excludes engines to ignore, for example because they have failed
 */
export async function createAudioDecoder(track: MediaTrack, excludes: Set<AudioEngine> = new Set()): Promise<PCMDecoder> {
    excludes = new Set(excludes);
    let reason = '';
    for (;;) {
        // The engine found on metadata reception is tried in first
        let engine = track.audioEngine;
        if (!engine || engine === AudioEngine.MSE || excludes.has(engine)) {
            engine = await findAudioEngine(track, excludes);
        }
        if (!engine) {
            throw Error(`No audio decoder for ${track.codecString}` + reason);
        }
        try {
            const decoder = engine === AudioEngine.WASM ? await WasmDecoder.create() : new WebCodecsDecoder();
            decoder.configure(track);
            return decoder;
        } catch (e) {
            reason += `, ${engine}: ${e instanceof Error ? e.message : String(e)}`;
            excludes.add(engine);
        }
    }
}
