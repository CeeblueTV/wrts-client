/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// Offline tests of the audio worklet processor (time-stretching, resampling, media clock, seek, holes...).
// It runs the processor in Node with a fake AudioWorkletGlobalScope, from its serialized source like a browser does:
//
//   node --experimental-strip-types tests/audio/worklet.test.mjs
//
// Requires Node 22.6 or later, see tests/README.md

async function load(path, rate) {
    const reports = [];
    let Processor;
    globalThis.sampleRate = rate;
    globalThis.currentTime = 0;
    globalThis.AudioWorkletProcessor = class {
        constructor() {
            this.port = { onmessage: null, postMessage: r => reports.push(r) };
        }
    };
    globalThis.registerProcessor = (name, p) => {
        Processor = p;
    };
    const mod = await import(path);
    // run through the serialized source, exactly like the browser does
    new Function(mod.audioWorkletSource())();
    const processor = new Processor();
    let frame = 0;
    return {
        reports,
        processor,
        send(command) {
            processor.port.onmessage({ data: command });
        },
        // render `count` frames on `channels` outputs
        render(count, channels = 2) {
            const out = Array.from({ length: channels }, () => new Float32Array(count));
            for (let o = 0; o < count; o += 128) {
                const quantum = Array.from({ length: channels }, () => new Float32Array(128));
                globalThis.currentTime = frame / rate;
                processor.process([], [quantum]);
                frame += 128;
                for (let c = 0; c < channels; ++c) {
                    out[c].set(quantum[c].subarray(0, Math.min(128, count - o)), o);
                }
            }
            return out;
        },
        last() {
            return reports[reports.length - 1];
        }
    };
}
function sine(freq, rate, frames, phase = 0, amp = 0.5) {
    const a = new Float32Array(frames);
    for (let i = 0; i < frames; ++i) {
        a[i] = amp * Math.sin((2 * Math.PI * freq * (phase + i)) / rate);
    }
    return a;
}
// push `seconds` of a continuous sine in chunks of `chunk` frames, starting at media time `time`
function feed(h, { freq = 440, rate, seconds, time = 0, chunk = 1024, channels = 2, disc = false, phase = 0 }) {
    const total = Math.round(seconds * rate);
    for (let o = 0; o < total; o += chunk) {
        const n = Math.min(chunk, total - o);
        const data = sine(freq, rate, n, phase + o);
        h.send({
            type: 'pcm',
            time: time + o / rate,
            rate,
            disc: disc && !o,
            channels: Array.from({ length: channels }, () => data.slice())
        });
    }
}
// frequency estimate by counting positive zero crossings (with linear interpolation of the first and last crossing)
function frequency(x, rate, from = 0, to = x.length) {
    let first = -1,
        last = -1,
        n = 0;
    for (let i = from + 1; i < to; ++i) {
        if (x[i - 1] < 0 && x[i] >= 0) {
            const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
            if (first < 0) {
                first = t;
            } else {
                n++;
            }
            last = t;
        }
    }
    return n ? (n * rate) / (last - first) : 0;
}
function rms(x, from = 0, to = x.length) {
    let s = 0;
    for (let i = from; i < to; ++i) {
        s += x[i] * x[i];
    }
    return Math.sqrt(s / (to - from));
}
// largest sample-to-sample step, a click detector for a sine
function maxStep(x, from = 0, to = x.length) {
    let m = 0;
    for (let i = from + 1; i < to; ++i) {
        m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    }
    return m;
}
// SNR in dB of x against the best fitting sine of frequency f
function sineSNR(x, f, rate, from, to) {
    let sc = 0,
        ss = 0,
        cc = 0,
        xs = 0,
        xc = 0;
    for (let i = from; i < to; ++i) {
        const s = Math.sin((2 * Math.PI * f * i) / rate),
            c = Math.cos((2 * Math.PI * f * i) / rate);
        ss += s * s;
        cc += c * c;
        sc += s * c;
        xs += x[i] * s;
        xc += x[i] * c;
    }
    const det = ss * cc - sc * sc,
        a = (xs * cc - xc * sc) / det,
        b = (xc * ss - xs * sc) / det;
    let noise = 0,
        signal = 0;
    for (let i = from; i < to; ++i) {
        const y = a * Math.sin((2 * Math.PI * f * i) / rate) + b * Math.cos((2 * Math.PI * f * i) / rate);
        signal += y * y;
        noise += (x[i] - y) * (x[i] - y);
    }
    return { snr: 10 * Math.log10(signal / (noise + 1e-30)), amp: Math.hypot(a, b) };
}

// Module exporting audioWorkletSource(): the TypeScript source by default, or the one extracted from a build
const path = process.argv[2] || new URL('../../src/media/audio/AudioWorklet.ts', import.meta.url).href;
const results = [];
const Q = 24064; // ~0.5s at 48kHz, a multiple of the 128 frames quantum
const check = (name, ok, detail) => {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(detail));
};
const fresh = async rate => {
    const h = await load(path + '?' + Math.random(), rate);
    return h;
};

// 1. unity, same rate: bit-exact reconstruction after the fade in
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 2 });
    h.send({ type: 'play' });
    const out = h.render(48000)[0];
    const ref = sine(440, 48000, 48000);
    let err = 0;
    for (let i = 2000; i < 40000; ++i) {
        err = Math.max(err, Math.abs(out[i] - ref[i]));
    }
    check('unity copy is exact', err < 1e-6, {
        err,
        freq: frequency(out, 48000, 2000, 40000).toFixed(2),
        media: h.last().media.toFixed(4)
    });
    check('unity clock', Math.abs(h.last().media - h.last().context) < 0.001, {
        media: h.last().media,
        context: h.last().context
    });
}
// 2. tempo with pitch correction
for (const tempo of [1.1, 0.9, 1.5, 0.5, 2]) {
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 8 });
    h.send({ type: 'tempo', value: tempo, pitch: true });
    h.send({ type: 'play' });
    const out = h.render(96000)[0];
    const f = frequency(out, 48000, 4800, 91200);
    const speed = h.last().media / h.last().context;
    const r = rms(out, 4800, 91200);
    check(
        `wsola tempo ${tempo}`,
        Math.abs(f - 440) < 1.5 &&
            Math.abs(speed - tempo) < 0.02 &&
            Math.abs(r - 0.3536) < 0.02 &&
            maxStep(out, 4800, 91200) < 0.045,
        {
            freq: f.toFixed(2),
            speed: speed.toFixed(4),
            rms: r.toFixed(4),
            maxStep: maxStep(out, 4800, 91200).toFixed(4),
            expectedStep: ((0.5 * 2 * Math.PI * 440) / 48000).toFixed(4)
        }
    );
}
// 3. resampling
for (const [from, to] of [
    [44100, 48000],
    [48000, 44100],
    [22050, 48000],
    [96000, 48000],
    [8000, 48000]
]) {
    for (const freq of [440, 3000]) {
        if (freq > from / 2.5) {
            continue;
        }
        const h = await fresh(to);
        feed(h, { rate: from, seconds: 3, freq });
        h.send({ type: 'play' });
        const out = h.render(to * 2)[0];
        const { snr, amp } = sineSNR(out, freq, to, Math.round(to * 0.5), Math.round(to * 1.5));
        check(
            `resample ${from}->${to} @${freq}Hz`,
            snr > 60 && Math.abs(amp - 0.5) < 0.005 && Math.abs(h.last().media - h.last().context) < 0.002,
            { snr: snr.toFixed(1), amp: amp.toFixed(4), media: h.last().media.toFixed(4), context: h.last().context.toFixed(4) }
        );
    }
}
// 4. tempo without pitch correction (varispeed)
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 4 });
    h.send({ type: 'tempo', value: 1.1, pitch: false });
    h.send({ type: 'play' });
    const out = h.render(96000)[0];
    const f = frequency(out, 48000, 4800, 91200);
    const { snr } = sineSNR(out, 484, 48000, 9600, 86400);
    check('varispeed 1.1', Math.abs(f - 484) < 0.5 && Math.abs(h.last().media / h.last().context - 1.1) < 0.01 && snr > 60, {
        freq: f.toFixed(2),
        speed: (h.last().media / h.last().context).toFixed(4),
        snr: snr.toFixed(1)
    });
}
// 5. tempo changes on the fly stay click-free
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 10 });
    h.send({ type: 'play' });
    const parts = [];
    for (const tempo of [1, 1.1, 1, 0.9, 1, 1.1, 0.9, 1]) {
        h.send({ type: 'tempo', value: tempo, pitch: true });
        parts.push(h.render(Q)[0]);
    }
    const out = new Float32Array(parts.length * Q);
    parts.forEach((p, i) => out.set(p, i * Q));
    check('tempo switches click-free', maxStep(out, 2000) < 0.045 && Math.abs(frequency(out, 48000, 2000) - 440) < 1.5, {
        maxStep: maxStep(out, 2000).toFixed(4),
        freq: frequency(out, 48000, 2000).toFixed(2),
        rms: rms(out, 2000).toFixed(4)
    });
    // back at tempo 1 the copy is exact again (up to a constant delay)
    const tail = parts[parts.length - 1];
    check('tempo 1 after switches is a pure sine', sineSNR(tail, 440, 48000, 4800, Q).snr > 80, {
        snr: sineSNR(tail, 440, 48000, 4800, Q).snr.toFixed(1)
    });
}
// 6. pause / resume: fades, clock stops, nothing lost
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 3 });
    h.send({ type: 'play' });
    const a = h.render(Q)[0];
    h.send({ type: 'pause' });
    const b = h.render(Q)[0];
    const pausedAt = h.last().media;
    const c0 = h.render(Q)[0];
    const still = h.last().media;
    h.send({ type: 'play' });
    const c = h.render(Q)[0];
    const all = new Float32Array(Q * 4);
    all.set(a);
    all.set(b, Q);
    all.set(c0, 2 * Q);
    all.set(c, 3 * Q);
    check(
        'pause/resume',
        rms(b, 2400) === 0 &&
            rms(c0) === 0 &&
            pausedAt === still &&
            Math.abs(pausedAt - 0.5) < 0.03 &&
            maxStep(all, 2000) < 0.045 &&
            Math.abs(h.last().media - (pausedAt + 0.5)) < 0.03,
        {
            pausedAt: pausedAt.toFixed(4),
            still: still.toFixed(4),
            after: h.last().media.toFixed(4),
            maxStep: maxStep(all, 2000).toFixed(4),
            silentRms: rms(b, 2400)
        }
    );
}
// 7. starvation and recovery
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 0.5 });
    h.send({ type: 'play' });
    const a = h.render(2 * Q)[0];
    const starved = h.last().starved,
        at = h.last().media;
    feed(h, { rate: 48000, seconds: 1, time: 0.5, phase: 24000 });
    const b = h.render(Q)[0];
    const all = new Float32Array(3 * Q);
    all.set(a);
    all.set(b, 2 * Q);
    check(
        'starvation',
        starved &&
            Math.abs(at - 0.5) < 0.035 &&
            !h.last().starved &&
            Math.abs(h.last().media - (at + 0.5)) < 0.035 &&
            maxStep(all, 2000) < 0.045 &&
            h.last().jump === 0,
        {
            starved,
            at: at.toFixed(4),
            resumed: !h.last().starved,
            media: h.last().media.toFixed(4),
            maxStep: maxStep(all, 2000).toFixed(4),
            jump: h.last().jump
        }
    );
}
// 8. seek forward, backward and trim
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 6, time: 100 });
    h.send({ type: 'seek', time: 100, id: 1 });
    h.send({ type: 'play' });
    const a = h.render(Q)[0];
    const t1 = h.last().media;
    h.send({ type: 'seek', time: 104, id: 2 });
    const b = h.render(Q)[0];
    const t2 = h.last().media,
        id2 = h.last().seek;
    h.send({ type: 'seek', time: 101, id: 3 });
    const c = h.render(Q)[0];
    const t3 = h.last().media;
    h.send({ type: 'trim', time: 101.2 });
    const kept = h.processor.chunks[0].time;
    const all = new Float32Array(3 * Q);
    all.set(a);
    all.set(b, Q);
    all.set(c, 2 * Q);
    check(
        'seek',
        Math.abs(t1 - 100.5) < 0.03 &&
            Math.abs(t2 - 104.5) < 0.03 &&
            id2 === 2 &&
            Math.abs(t3 - 101.5) < 0.03 &&
            maxStep(all, 2000) < 0.045 &&
            kept > 101.1 &&
            kept <= 101.2,
        {
            t1: t1.toFixed(3),
            t2: t2.toFixed(3),
            t3: t3.toFixed(3),
            maxStep: maxStep(all, 2000).toFixed(4),
            firstChunkAfterTrim: kept.toFixed(3),
            jump: h.last().jump
        }
    );
}
// 9. hole in the timeline: the clock jumps, the audio stays click-free
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 1, time: 10 });
    feed(h, { rate: 48000, seconds: 1, time: 13, disc: true, freq: 660 });
    h.send({ type: 'seek', time: 10, id: 1 });
    h.send({ type: 'play' });
    const out = h.render(72000)[0];
    const jumps = h.reports.filter((r, i) => i && r.jump !== h.reports[i - 1].jump).length;
    // the report can be 40ms old: compare its media time with its own context time (1s played before the hole)
    check(
        'hole',
        Math.abs(h.last().media - (13 + h.last().context - 1)) < 0.035 &&
            jumps === 1 &&
            maxStep(out, 2000) < 0.07 &&
            Math.abs(frequency(out, 48000, 52000, 70000) - 660) < 2 &&
            !h.last().starved,
        {
            media: h.last().media.toFixed(3),
            maxStep: maxStep(out, 2000).toFixed(4),
            freqAfter: frequency(out, 48000, 52000, 70000).toFixed(1),
            jumps
        }
    );
}
// 10. format change mid-stream (rate and channels), continuous time
{
    const h = await fresh(48000);
    feed(h, { rate: 48000, seconds: 1, time: 0, channels: 2 });
    feed(h, { rate: 44100, seconds: 1, time: 1, channels: 1, phase: 44100 });
    feed(h, { rate: 48000, seconds: 1, time: 2, channels: 6, phase: 96000 });
    h.send({ type: 'play' });
    const out = h.render(120000);
    check(
        'format change',
        Math.abs(h.last().media - h.last().context) < 0.05 &&
            maxStep(out[0], 2000) < 0.08 &&
            Math.abs(frequency(out[0], 48000, 2000, 118000) - 440) < 2 &&
            rms(out[1], 60000, 90000) > 0.3,
        {
            media: h.last().media.toFixed(3),
            maxStep: maxStep(out[0], 2000).toFixed(4),
            freq: frequency(out[0], 48000, 2000, 118000).toFixed(2),
            rmsRightMono: rms(out[1], 60000, 90000).toFixed(3),
            rms51: rms(out[0], 100000, 118000).toFixed(3)
        }
    );
}
// 11. performance
{
    const h = await fresh(48000);
    feed(h, { rate: 44100, seconds: 70 });
    h.send({ type: 'tempo', value: 1.1, pitch: true });
    h.send({ type: 'play' });
    const t0 = performance.now();
    h.render(48000 * 60);
    const ms = performance.now() - t0;
    check('performance (60s, 44.1k->48k, tempo 1.1)', ms < 3000, { ms: ms.toFixed(0), cpuPercent: (ms / 600).toFixed(2) });
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
