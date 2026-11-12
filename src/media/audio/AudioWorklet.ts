/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// AudioWorkletGlobalScope API, missing from the TypeScript DOM library
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: unknown): void;

/**
 * Name of the audio worklet processor rendering the PCM
 */
export const AUDIO_WORKLET_NAME = 'wrts-audio-renderer';

/**
 * Messages sent by the {@link AudioRenderer} to its audio worklet processor
 */
export type AudioWorkletCommand =
    /**
     * Append PCM, `disc` signals a time discontinuity with the PCM appended before
     */
    | { type: 'pcm'; time: number; rate: number; disc: boolean; channels: Float32Array[] }
    | { type: 'play' }
    | { type: 'pause' }
    /**
     * Change the playback rate, with or without pitch correction
     */
    | { type: 'tempo'; value: number; pitch: boolean }
    /**
     * Move the playback position, `id` is returned in {@link AudioWorkletReport.seek}
     */
    | { type: 'seek'; time: number; id: number }
    /**
     * Release the PCM already played before `time`
     */
    | { type: 'trim'; time: number }
    /**
     * Release all the PCM
     */
    | { type: 'reset' }
    | { type: 'close' };

/**
 * Report sent periodically by the audio worklet processor to the {@link AudioRenderer},
 * and immediately on every state change
 */
export type AudioWorkletReport = {
    /**
     * Time of the AudioContext, in seconds, of the next frame to render
     */
    context: number;
    /**
     * Media time, in seconds, of the next frame to render
     */
    media: number;
    /**
     * Counter of the media time discontinuities (seek or hole in the timeline)
     */
    jump: number;
    /**
     * Identifier of the last seek processed
     */
    seek: number;
    /**
     * True when there is no more PCM to render
     */
    starved: boolean;
};

/**
 * Code of the audio worklet processor.
 *
 * It renders the PCM appended in the continuity of its media time, which is the reference clock of the playback:
 * - time-stretches it to follow the playback rate without changing the pitch (WSOLA algorithm), or changes its pitch
 *   like a tape when the pitch correction is disabled,
 * - resamples it to the rate of the AudioContext (windowed-sinc interpolation),
 * - remaps its channels to the output layout,
 * - and reports the media time rendered.
 *
 * Every transition (start, pause, seek, hole, starvation) is faded over a half window to stay click-free.
 *
 * /!\ This function is serialized to run in an AudioWorkletGlobalScope (see {@link audioWorkletSource}),
 * it must stay self-contained: no reference to anything declared outside of it, and only ES2015 syntax
 * without any transpilation helper.
 */
export function audioWorkletMain(name: string) {
    const WINDOW = 0.02; // seconds, overlap-add window
    const SEARCH = 0.01; // seconds, WSOLA search range on both sides of the nominal position
    const RESUME = 0.06; // seconds of PCM required to resume after a starvation
    const REPORT = 0.04; // seconds, report period
    const TAPS = 24; // resampler kernel size
    const HALF = TAPS / 2;
    const PHASES = 64; // resampler kernel phases
    const MAX_PCM = 120; // seconds, safety limit of PCM stored
    const UNITY = 0.0005; // rate deviation tolerated to consider a rate as 1

    type Chunk = { time: number; rate: number; frames: number; disc: boolean; channels: Float32Array[] };

    /**
     * FIFO of frames at the stream rate, read by the resampler
     */
    class Fifo {
        data: Float32Array[] = [];
        length = 0;
        capacity = 0;

        init(channels: number, capacity: number) {
            if (this.data.length !== channels || this.capacity < capacity) {
                this.capacity = Math.max(capacity, this.capacity);
                this.data = [];
                for (let c = 0; c < channels; ++c) {
                    this.data.push(new Float32Array(this.capacity));
                }
            }
            this.length = 0;
        }

        /**
         * Forget the `count` first frames
         */
        shift(count: number) {
            if (count <= 0) {
                return;
            }
            for (let c = 0; c < this.data.length; ++c) {
                this.data[c].copyWithin(0, count, this.length);
            }
            this.length -= count;
        }
    }

    /**
     * Time stretcher, it copies the input to the output at the tempo requested without changing the pitch.
     *
     * WSOLA algorithm: the output is an overlap-add of input blocks windowed by a Hann window, with a hop of half
     * a window. Each block is taken around its nominal position in the input, where it is the most similar to the
     * natural continuation of the previous block, what keeps the waveform continuous. At tempo 1 the blocks are
     * contiguous and the overlap-add rebuilds exactly the input.
     */
    class Stretcher {
        rate = 0;
        channels = 0;
        size = 0; // window size in frames
        hop = 0; // half window
        search = 0; // search range in frames
        step = 1; // decimation factor of the similarity search
        window = new Float32Array(0);
        input: Float32Array[] = [];
        capacity = 0;
        length = 0; // frames in input
        time = 0; // media time of the first input frame
        natural = 0; // input position of the natural continuation of the last block
        nominal = 0; // input position where the tempo leads
        tail: Float32Array[] = []; // second half of the last block, to overlap with the next block
        fresh = true; // no tail to overlap
        mono = new Float32Array(0); // decimated mono mix for the similarity search

        init(rate: number, channels: number) {
            if (rate !== this.rate || channels !== this.channels) {
                this.rate = rate;
                this.channels = channels;
                this.hop = Math.max(8, Math.round((rate * WINDOW) / 2));
                this.size = this.hop * 2;
                this.search = Math.max(1, Math.round(rate * SEARCH));
                this.step = Math.max(1, Math.floor(rate / 12000));
                this.window = new Float32Array(this.size);
                for (let i = 0; i < this.size; ++i) {
                    this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.size);
                }
                // room for the search area plus the largest chunks
                this.capacity = 4 * (this.size + 2 * this.search) + 8192;
                this.input = [];
                this.tail = [];
                for (let c = 0; c < channels; ++c) {
                    this.input.push(new Float32Array(this.capacity));
                    this.tail.push(new Float32Array(this.hop));
                }
                this.mono = new Float32Array(Math.ceil((2 * this.search + 2 * this.size) / this.step) + 2);
            }
            this.reset();
        }

        reset() {
            this.length = 0;
            this.natural = 0;
            this.nominal = 0;
            this.fresh = true;
            for (let c = 0; c < this.tail.length; ++c) {
                this.tail[c].fill(0);
            }
        }

        /**
         * Media time of the next frame to output
         */
        position(): number {
            return this.time + this.natural / this.rate;
        }

        /**
         * Frames of input not played yet
         */
        available(): number {
            return this.length - this.natural;
        }

        /**
         * Copy `count` frames of the chunk in input, returns the number of frames copied
         */
        push(chunk: Chunk, offset: number, count: number): number {
            // release the input already played
            const played = Math.min(this.natural, Math.floor(this.nominal) - this.search);
            if (played > 0 && this.length + count > this.capacity) {
                for (let c = 0; c < this.channels; ++c) {
                    this.input[c].copyWithin(0, played, this.length);
                }
                this.length -= played;
                this.natural -= played;
                this.nominal -= played;
                this.time += played / this.rate;
            }
            count = Math.min(count, this.capacity - this.length);
            if (count <= 0) {
                return 0;
            }
            if (!offset || !this.length) {
                // align the media time on the chunk
                this.time = chunk.time + (offset - this.length) / this.rate;
            }
            for (let c = 0; c < this.channels; ++c) {
                this.input[c].set(chunk.channels[c].subarray(offset, offset + count), this.length);
            }
            this.length += count;
            return count;
        }

        /**
         * Find in [from, to] the input position the most similar to the natural continuation
         */
        find(from: number, to: number): number {
            const natural = this.natural;
            if (natural >= from && natural <= to) {
                return natural; // the natural continuation is in the range, nothing can be more similar
            }
            const step = this.step;
            const hop = this.hop;
            const begin = Math.min(from, natural);
            const end = Math.max(to, natural) + hop;
            // decimated mono mix of the area
            const mono = this.mono;
            const left = this.input[0];
            const right = this.channels > 1 ? this.input[1] : left;
            const count = Math.floor((end - begin) / step);
            for (let i = 0, p = begin; i < count; ++i) {
                let sum = 0;
                for (let k = 0; k < step; ++k, ++p) {
                    sum += left[p] + right[p];
                }
                mono[i] = sum;
            }
            const size = Math.floor(hop / step);
            const target = Math.floor((natural - begin) / step);
            const first = Math.floor((from - begin) / step);
            const last = Math.min(Math.floor((to - begin) / step), count - size);
            // normalized cross-correlation, with a running energy
            let energy = 1e-9;
            for (let i = 0; i < size; ++i) {
                energy += mono[first + i] * mono[first + i];
            }
            let best = first;
            let bestScore = -Infinity;
            for (let j = first; j <= last; ++j) {
                let correlation = 0;
                for (let i = 0; i < size; ++i) {
                    correlation += mono[j + i] * mono[target + i];
                }
                const score = correlation / Math.sqrt(energy);
                if (score > bestScore) {
                    bestScore = score;
                    best = j;
                }
                energy += mono[j + size] * mono[j + size] - mono[j] * mono[j];
                if (energy < 1e-9) {
                    energy = 1e-9;
                }
            }
            let result = begin + best * step;
            if (step > 1) {
                // refine at full resolution around the decimated result
                const low = Math.max(from, result - step + 1);
                const high = Math.min(to, result + step - 1);
                bestScore = -Infinity;
                for (let j = low; j <= high; ++j) {
                    let correlation = 0;
                    let power = 1e-9;
                    for (let i = 0; i < hop; i += 2) {
                        const value = left[j + i] + right[j + i];
                        correlation += value * (left[natural + i] + right[natural + i]);
                        power += value * value;
                    }
                    const score = correlation / Math.sqrt(power);
                    if (score > bestScore) {
                        bestScore = score;
                        result = j;
                    }
                }
            }
            return result;
        }

        /**
         * Synthesize the next hop of output in the fifo.
         * Returns false when it lacks input, unless `end` signals that no more input will come:
         * in this case the remaining input is played until its last frame.
         */
        synthesize(tempo: number, fifo: Fifo, end: boolean): boolean {
            const hop = this.hop;
            const size = this.size;
            let block = this.natural;
            let needed = block + size;
            let from = 0;
            let to = 0;
            const unity = this.fresh || Math.abs(tempo - 1) < UNITY;
            if (!unity) {
                const center = Math.round(this.nominal);
                from = Math.max(0, center - this.search);
                to = Math.max(from, center + this.search);
                needed = Math.max(to, block) + size;
            }
            if (needed > this.length) {
                if (!end || block >= this.length) {
                    return false;
                }
                // end of the input, play its last frames without searching (zeros are overlapped after the end)
            } else if (!unity) {
                block = this.find(from, to);
            } else {
                this.nominal = block;
            }
            const window = this.window;
            const offset = fifo.length;
            const length = this.length;
            for (let c = 0; c < this.channels; ++c) {
                const input = this.input[c];
                const tail = this.tail[c];
                const output = fifo.data[c];
                for (let i = 0; i < hop; ++i) {
                    const p = block + i;
                    output[offset + i] = tail[i] + (p < length ? window[i] * input[p] : 0);
                    tail[i] = p + hop < length ? window[hop + i] * input[p + hop] : 0;
                }
            }
            fifo.length += hop;
            this.fresh = false;
            this.natural = block + hop;
            this.nominal += hop * tempo;
            return true;
        }

        /**
         * Output the tail of the last block: it fades out the output, and the next block will fade in.
         * Returns false if there is nothing to output.
         */
        drain(fifo: Fifo): boolean {
            if (this.fresh) {
                return false;
            }
            for (let c = 0; c < this.channels; ++c) {
                fifo.data[c].set(this.tail[c], fifo.length);
                this.tail[c].fill(0);
            }
            fifo.length += this.hop;
            this.fresh = true;
            return true;
        }
    }

    /**
     * Resampler kernel: sinc windowed by a Kaiser window, tabulated on PHASES + 1 fractional positions
     */
    class Kernel {
        cutoff = 0;
        table = new Float32Array((PHASES + 1) * TAPS);

        static bessel(x: number): number {
            // modified Bessel function of the first kind, order 0
            let sum = 1;
            let term = 1;
            for (let k = 1; k < 32; ++k) {
                term *= (x / (2 * k)) * (x / (2 * k));
                sum += term;
                if (term < 1e-10 * sum) {
                    break;
                }
            }
            return sum;
        }

        /**
         * Tabulate the kernel for a cutoff frequency given relatively to the Nyquist frequency of the input
         */
        update(cutoff: number) {
            if (Math.abs(cutoff - this.cutoff) < 0.005) {
                return;
            }
            this.cutoff = cutoff;
            const beta = 8;
            const norm = Kernel.bessel(beta);
            for (let p = 0; p <= PHASES; ++p) {
                let sum = 0;
                const row = p * TAPS;
                for (let j = 0; j < TAPS; ++j) {
                    const t = j - HALF + 1 - p / PHASES; // distance to the interpolated position, in input frames
                    const x = Math.PI * cutoff * t;
                    const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
                    const r = t / HALF;
                    const kaiser = Math.abs(r) >= 1 ? 0 : Kernel.bessel(beta * Math.sqrt(1 - r * r)) / norm;
                    sum += this.table[row + j] = cutoff * sinc * kaiser;
                }
                for (let j = 0; j < TAPS; ++j) {
                    this.table[row + j] /= sum; // unity gain
                }
            }
        }
    }

    class Processor extends AudioWorkletProcessor {
        chunks: Chunk[] = [];
        stored = 0; // seconds of PCM stored
        cursor = 0; // index of the chunk to read
        offset = 0; // frame to read in the chunk
        running = false; // a run of continuous PCM is being read
        ended = false; // the run is fully read, a discontinuity follows it
        playing = false;
        closed = false;
        tempo = 1;
        pitch = true;
        starved = false;
        position = 0; // media time when there is no run to read
        jump = 0;
        jumping = false; // a run has ended, the next run starts after a discontinuity
        seek = 0;
        dirty = true; // state changed, to report immediately
        reported = 0;
        stretcher = new Stretcher();
        fifo = new Fifo();
        read = 0; // fractional read position of the resampler in the fifo
        kernel = new Kernel();
        coefficients = new Float32Array(TAPS);
        values = new Float32Array(8);
        mix: number[][] = [];
        mixInputs = 0;
        mixOutputs = 0;

        constructor(options?: unknown) {
            super(options);
            this.port.onmessage = (event: MessageEvent) => this.command(event.data);
        }

        command(command: AudioWorkletCommand) {
            switch (command.type) {
                case 'pcm': {
                    const frames = command.channels.length ? command.channels[0].length : 0;
                    if (!frames || !(command.rate > 0)) {
                        break;
                    }
                    this.chunks.push({
                        time: command.time,
                        rate: command.rate,
                        frames,
                        disc: command.disc,
                        channels: command.channels
                    });
                    this.stored += frames / command.rate;
                    // safety limit, the oldest PCM is released even if it was not played
                    while (this.stored > MAX_PCM && this.chunks.length > 1) {
                        this.release();
                    }
                    break;
                }
                case 'play':
                    this.playing = true;
                    this.dirty = true;
                    break;
                case 'pause':
                    if (this.playing) {
                        this.playing = false;
                        this.stretcher.drain(this.fifo); // fade out
                        this.dirty = true;
                    }
                    break;
                case 'tempo':
                    this.tempo = Math.min(Math.max(command.value, 0.1), 8);
                    this.pitch = command.pitch;
                    this.dirty = true;
                    break;
                case 'seek': {
                    if (this.running) {
                        this.stretcher.drain(this.fifo); // fade out
                    }
                    const chunks = this.chunks;
                    let cursor = 0;
                    while (
                        cursor < chunks.length &&
                        chunks[cursor].time + chunks[cursor].frames / chunks[cursor].rate <= command.time
                    ) {
                        ++cursor;
                    }
                    this.cursor = cursor;
                    this.offset = 0;
                    this.position = command.time;
                    if (cursor < chunks.length) {
                        const chunk = chunks[cursor];
                        if (chunk.time < command.time) {
                            this.offset = Math.min(Math.floor((command.time - chunk.time) * chunk.rate), chunk.frames - 1);
                        } else {
                            this.position = chunk.time;
                        }
                    }
                    this.running = this.ended = this.starved = this.jumping = false;
                    this.seek = command.id;
                    ++this.jump;
                    this.dirty = true;
                    break;
                }
                case 'trim':
                    while (this.cursor > 0 && this.chunks[0].time + this.chunks[0].frames / this.chunks[0].rate <= command.time) {
                        this.release();
                    }
                    break;
                case 'reset':
                    this.chunks.length = 0;
                    this.stored = 0;
                    this.cursor = this.offset = 0;
                    this.running = this.ended = this.starved = this.jumping = false;
                    this.stretcher.reset();
                    this.fifo.length = 0;
                    this.read = 0;
                    ++this.jump;
                    this.dirty = true;
                    break;
                case 'close':
                    this.closed = true;
                    this.chunks.length = 0;
                    break;
                default:
            }
        }

        /**
         * Release the oldest chunk
         */
        release() {
            const chunk = this.chunks.shift();
            if (!chunk) {
                return;
            }
            this.stored -= chunk.frames / chunk.rate;
            if (this.cursor > 0) {
                --this.cursor;
            } else if (this.offset) {
                // was reading it, continue with the next chunk like after a discontinuity
                this.offset = 0;
                this.ended = this.running;
            }
        }

        /**
         * Media time of the next frame to render
         */
        mediaTime(): number {
            if (!this.running) {
                return this.position;
            }
            const stretcher = this.stretcher;
            const pending = Math.max(0, this.fifo.length - Math.ceil(this.read) - HALF);
            return (this.position = stretcher.position() - Math.min(pending, stretcher.hop) / stretcher.rate);
        }

        /**
         * Start to read a new run of continuous PCM from the chunk
         */
        start(chunk: Chunk) {
            const channels = Math.min(chunk.channels.length, this.values.length);
            const stretcher = this.stretcher;
            if (stretcher.rate !== chunk.rate || stretcher.channels !== channels) {
                // the frames remaining in the fifo are in the previous format
                stretcher.init(chunk.rate, channels);
                this.fifo.init(channels, 4 * stretcher.size + 4 * TAPS);
                this.read = 0;
            } else {
                stretcher.reset();
            }
            this.running = true;
            this.ended = false;
            if (this.jumping) {
                // Signal the discontinuity with the media time of the new run, to jump in one step
                this.jumping = false;
                ++this.jump;
                this.dirty = true;
            }
        }

        /**
         * Fill the input of the stretcher with the PCM of the run
         */
        fill() {
            const chunks = this.chunks;
            const stretcher = this.stretcher;
            while (this.cursor < chunks.length) {
                const chunk = chunks[this.cursor];
                if (!this.running) {
                    this.start(chunk);
                } else if (
                    !this.offset &&
                    (chunk.disc ||
                        chunk.rate !== stretcher.rate ||
                        Math.min(chunk.channels.length, this.values.length) !== stretcher.channels)
                ) {
                    this.ended = true;
                    return;
                }
                const count = stretcher.push(chunk, this.offset, chunk.frames - this.offset);
                if (!count) {
                    return; // input full
                }
                this.offset += count;
                if (this.offset >= chunk.frames) {
                    ++this.cursor;
                    this.offset = 0;
                }
            }
        }

        /**
         * Feed the fifo with at least one hop, returns false if there is nothing more to render for now
         */
        feed(): boolean {
            if (!this.playing) {
                return false;
            }
            const stretcher = this.stretcher;
            const fifo = this.fifo;
            for (;;) {
                this.fill();
                if (!this.running) {
                    break; // no PCM
                }
                // release the frames already read by the resampler, the kernel needs HALF frames of history
                const consumed = Math.floor(this.read) - HALF;
                if (consumed > 0) {
                    fifo.shift(consumed);
                    this.read -= consumed;
                }
                if (this.starved && !this.ended) {
                    // wait enough PCM to not starve again immediately
                    let available = stretcher.available() / stretcher.rate;
                    for (let i = this.cursor; i < this.chunks.length && available < RESUME; ++i) {
                        available += (this.chunks[i].frames - (i === this.cursor ? this.offset : 0)) / this.chunks[i].rate;
                    }
                    if (available < RESUME) {
                        return false;
                    }
                }
                if (stretcher.synthesize(this.pitch ? this.tempo : 1, fifo, this.ended)) {
                    if (this.starved) {
                        this.starved = false;
                        this.dirty = true;
                    }
                    return true;
                }
                if (!this.ended) {
                    break; // lacks PCM
                }
                // End of the run: fade out, then continue with the next run after the discontinuity
                this.position = stretcher.position();
                const drained = stretcher.drain(fifo);
                this.running = this.ended = false;
                this.jumping = true;
                if (drained) {
                    return true;
                }
            }
            if (!this.starved) {
                this.starved = true;
                this.dirty = true;
                if (this.running) {
                    return stretcher.drain(fifo); // fade out
                }
            }
            return false;
        }

        /**
         * Build the mixing matrix from the channels of the stream to the channels of the output
         */
        route(inputs: number, outputs: number) {
            this.mixInputs = inputs;
            this.mixOutputs = outputs;
            const mix: number[][] = (this.mix = []);
            for (let c = 0; c < outputs; ++c) {
                mix.push([]);
            }
            const M3DB = Math.SQRT1_2;
            if (inputs === outputs) {
                for (let c = 0; c < outputs; ++c) {
                    mix[c].push(c, 1);
                }
            } else if (inputs === 1) {
                // mono on left and right (or on the single output)
                for (let c = 0; c < Math.min(outputs, 2); ++c) {
                    mix[c].push(0, 1);
                }
            } else if (outputs === 1) {
                // left and right (and center) to mono
                mix[0].push(0, 0.5, 1, 0.5);
                if (inputs === 3 || inputs >= 5) {
                    mix[0].push(2, M3DB);
                }
            } else if (inputs > outputs && outputs === 2) {
                // down-mix to stereo, see https://www.w3.org/TR/webaudio/#channel-up-mixing-and-down-mixing
                mix[0].push(0, 1);
                mix[1].push(1, 1);
                if (inputs === 3) {
                    // L R C
                    mix[0].push(2, M3DB);
                    mix[1].push(2, M3DB);
                } else if (inputs === 4) {
                    // L R SL SR
                    mix[0].push(2, 0.5);
                    mix[1].push(3, 0.5);
                    mix[0][1] = mix[1][1] = 0.5;
                } else {
                    // L R C LFE SL SR
                    mix[0].push(2, M3DB, 4, M3DB);
                    mix[1].push(2, M3DB, 5, M3DB);
                }
            } else {
                // same order, the channels in surplus are ignored
                for (let c = 0; c < Math.min(inputs, outputs); ++c) {
                    mix[c].push(c, 1);
                }
            }
        }

        /**
         * Render the output, returns the number of frames rendered
         */
        render(output: Float32Array[], count: number): number {
            const fifo = this.fifo;
            const values = this.values;
            const coefficients = this.coefficients;
            let rendered = 0;
            while (rendered < count) {
                const index = Math.floor(this.read);
                if (index + HALF >= fifo.length) {
                    if (!this.feed()) {
                        break;
                    }
                    continue;
                }
                const stretcher = this.stretcher;
                const channels = fifo.data.length;
                if (channels !== this.mixInputs || output.length !== this.mixOutputs) {
                    this.route(channels, output.length);
                }
                // frames of input by frame of output
                const step = (stretcher.rate / sampleRate) * (this.pitch ? 1 : this.tempo);
                const fraction = this.read - index;
                if (Math.abs(step - 1) < 1e-9 && fraction < 1e-9) {
                    // same rate, simple copy
                    for (let c = 0; c < channels; ++c) {
                        values[c] = fifo.data[c][index];
                    }
                    this.read = index + 1;
                } else {
                    // interpolate with the kernel tabulated at the two nearest phases
                    this.kernel.update(step > 1 ? 0.95 / step : 0.95);
                    const table = this.kernel.table;
                    const phase = fraction * PHASES;
                    const row = Math.floor(phase);
                    const weight = phase - row;
                    const base = row * TAPS;
                    for (let j = 0; j < TAPS; ++j) {
                        coefficients[j] = table[base + j] * (1 - weight) + table[base + TAPS + j] * weight;
                    }
                    const first = index - HALF + 1;
                    const from = first < 0 ? -first : 0;
                    for (let c = 0; c < channels; ++c) {
                        const data = fifo.data[c];
                        let sum = 0;
                        for (let j = from; j < TAPS; ++j) {
                            sum += coefficients[j] * data[first + j];
                        }
                        values[c] = sum;
                    }
                    this.read += step;
                }
                // mix to the output channels
                const mix = this.mix;
                for (let c = 0; c < mix.length; ++c) {
                    const sources = mix[c];
                    let sum = 0;
                    for (let i = 0; i < sources.length; i += 2) {
                        sum += values[sources[i]] * sources[i + 1];
                    }
                    output[c][rendered] = sum;
                }
                ++rendered;
            }
            return rendered;
        }

        process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
            if (this.closed) {
                return false;
            }
            const output = outputs[0];
            const count = output && output.length ? output[0].length : 0;
            if (count) {
                this.render(output, count);
            }
            const context = currentTime + count / sampleRate;
            if (this.dirty || context - this.reported >= REPORT) {
                this.dirty = false;
                this.reported = context;
                const report: AudioWorkletReport = {
                    context,
                    media: this.mediaTime(),
                    jump: this.jump,
                    seek: this.seek,
                    starved: this.starved
                };
                this.port.postMessage(report);
            }
            return true;
        }
    }

    registerProcessor(name, Processor);
}

/**
 * Source code of the audio worklet module
 */
export function audioWorkletSource(): string {
    return `(${audioWorkletMain.toString()})(${JSON.stringify(AUDIO_WORKLET_NAME)});`;
}
