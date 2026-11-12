/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import * as Media from '../Media';
import { MediaTrack } from '../MediaTrack';
import { AudioEngine, PCMDecoder, audioParameters } from './PCMDecoder';

const MAX_CONSECUTIVE_ERRORS = 10;

/**
 * Functions exported by the WebAssembly module, see wasm/decoder.c
 */
type Exports = {
    memory: WebAssembly.Memory;
    _initialize(): void;
    decoder_malloc(size: number): number;
    decoder_free(pointer: number): void;
    decoder_open(codec: number, rate: number, channels: number, config: number, configSize: number): number;
    decoder_close(decoder: number): void;
    decoder_input(decoder: number, size: number): number;
    decoder_decode(decoder: number, size: number): number;
    decoder_output(decoder: number, channel: number): number;
    decoder_channels(decoder: number): number;
    decoder_rate(decoder: number): number;
    decoder_reset(decoder: number): void;
};

// Codec identifiers of wasm/decoder.c
const CODECS = new Map<Media.Codec, number>([
    [Media.Codec.AAC, 0],
    [Media.Codec.MP3, 1]
]);

let _loading: Promise<Exports> | undefined;

/**
 * Instantiate the WebAssembly module, which is a standalone WASI reactor without any JavaScript glue
 */
async function instantiate(): Promise<Exports> {
    // The binary is in its own chunk, loaded only for the browsers which need it
    const { DECODER_WASM } = await import('./DecoderWasmBinary');
    const binary = atob(DECODER_WASM);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
        bytes[i] = binary.charCodeAt(i);
    }
    const module = await WebAssembly.compile(bytes);
    const wasm: { exports?: Exports } = {};
    const view = () => new DataView((wasm.exports as Exports).memory.buffer);
    // The module imports only a few system calls, never used by the decoding
    const system: Record<string, (...args: number[]) => number> = {
        fd_write: (fd, iovs, count, written) => {
            // discard what is printed
            let size = 0;
            for (let i = 0; i < count; ++i) {
                size += view().getUint32(iovs + i * 8 + 4, true);
            }
            view().setUint32(written, size, true);
            return 0;
        },
        fd_read: (fd, iovs, count, read) => {
            view().setUint32(read, 0, true);
            return 0;
        },
        environ_sizes_get: (count, size) => {
            view().setUint32(count, 0, true);
            view().setUint32(size, 0, true);
            return 0;
        },
        clock_time_get: (id, precision, time) => {
            view().setBigUint64(time, BigInt(Math.round(performance.now() * 1000000)), true);
            return 0;
        }
    };
    const imports: Record<string, Record<string, unknown>> = {};
    for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
        if (kind === 'function') {
            (imports[name] = imports[name] || {})[field] = system[field] || (() => 0);
        }
    }
    const instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
    const exports = (wasm.exports = instance.exports as unknown as Exports);
    exports._initialize();
    return exports;
}

/**
 * Audio decoder using a WebAssembly build of libavcodec (see the wasm folder of the repository).
 *
 * It decodes AAC (LC, HE, HEv2) and MP3 without any help of the browser, it is the fallback when
 * {@link WebCodecsDecoder} is not available. The decoding is synchronous, it takes a few dozen microseconds per frame.
 */
export class WasmDecoder extends PCMDecoder {
    /**
     * True if the browser is able to run the WebAssembly decoder
     */
    static get available(): boolean {
        return typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
    }

    /**
     * Returns true if the WebAssembly decoder is able to decode the track, the module is loaded if need
     */
    static async supports(track: MediaTrack): Promise<boolean> {
        if (!WasmDecoder.available || !CODECS.has(track.codec)) {
            return false;
        }
        try {
            await WasmDecoder.load();
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Load the WebAssembly module, shared by all the decoders
     */
    static load(): Promise<Exports> {
        if (!_loading) {
            _loading = instantiate();
            // retry on the next call
            _loading.catch(() => (_loading = undefined));
        }
        return _loading;
    }

    /**
     * Create a decoder, it fails if the WebAssembly module cannot be loaded
     */
    static async create(): Promise<WasmDecoder> {
        return new WasmDecoder(await WasmDecoder.load());
    }

    get engine(): AudioEngine {
        return AudioEngine.WASM;
    }

    private _decoder: number = 0;
    private _errors: number = 0;

    private constructor(private _wasm: Exports) {
        super();
    }

    configure(track: MediaTrack) {
        this.close();
        const wasm = this._wasm;
        const parameters = audioParameters(track);
        const codec = CODECS.get(parameters.codec);
        if (codec == null) {
            throw Error(`Codec ${track.codec} unsupported`);
        }
        const config = parameters.config;
        let pointer = 0;
        if (config) {
            pointer = wasm.decoder_malloc(config.byteLength);
            if (!pointer) {
                throw Error('Out of memory');
            }
            new Uint8Array(wasm.memory.buffer).set(config, pointer);
        }
        this._decoder = wasm.decoder_open(codec, parameters.sampleRate, parameters.channels, pointer, config?.byteLength ?? 0);
        wasm.decoder_free(pointer);
        if (!this._decoder) {
            throw Error(`Cannot open the ${track.codec} decoder`);
        }
        this._errors = 0;
    }

    decode(sample: Media.Sample) {
        const wasm = this._wasm;
        const decoder = this._decoder;
        if (!decoder) {
            return;
        }
        const size = sample.data.byteLength;
        const input = wasm.decoder_input(decoder, size);
        if (!input) {
            this._fail('Out of memory');
            return;
        }
        // Take the memory buffer just before use, it changes when the memory grows
        new Uint8Array(wasm.memory.buffer).set(sample.data, input);
        const frames = wasm.decoder_decode(decoder, size);
        if (frames < 0) {
            // A corrupted frame is skipped, the decoder recovers on the next frames
            if (++this._errors > MAX_CONSECUTIVE_ERRORS) {
                this._fail(`Decoding error ${frames}`);
            } else {
                this.log(`Audio frame at ${sample.time}ms undecodable (error ${frames})`).warn();
            }
            return;
        }
        this._errors = 0;
        if (!frames) {
            return; // the decoder waits more data
        }
        const channels = new Array<Float32Array>();
        const count = wasm.decoder_channels(decoder);
        for (let c = 0; c < count; ++c) {
            // copy out of the WebAssembly memory
            channels.push(new Float32Array(wasm.memory.buffer, wasm.decoder_output(decoder, c), frames).slice());
        }
        this.onPCM({ time: sample.time / 1000, sampleRate: wasm.decoder_rate(decoder), channels });
    }

    close() {
        if (this._decoder) {
            this._wasm.decoder_close(this._decoder);
            this._decoder = 0;
        }
    }

    private _fail(detail: string) {
        this.close();
        this.onError(detail);
    }
}
