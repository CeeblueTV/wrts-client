/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// End-to-end tests of the audio pipeline in a real browser (headless Chromium driven by Playwright):
// decoding engines, synchronization of the video on the audio clock, playback rate changes, stalls, holes, autoplay...
// Run it with tests/e2e/run.sh, see tests/README.md

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const ROOT = new URL('../../', import.meta.url).pathname;
const ROOTS = { '/dist/': join(ROOT, 'dist/'), '/media/': process.env.MEDIA || join(ROOT, 'tests/e2e/media/') };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.mp4': 'video/mp4', '.map': 'application/json' };
const requests = [];
const server = createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push(url);
    try {
        let file;
        if (url === '/page.html' || url === '/page.js') {
            file = new URL('.' + url, import.meta.url).pathname;
        }
        if (url === '/vue.js') {
            file = process.env.VUE;
        }
        for (const [prefix, root] of Object.entries(ROOTS)) {
            if (url.startsWith(prefix)) {
                file = join(root, normalize(url.slice(prefix.length)));
            }
        }
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end();
    }
}).listen(0);
const origin = 'http://localhost:' + server.address().port;
// Same server through its network address: in HTTP out of localhost, the page is not in a secure context
const address = Object.values(networkInterfaces())
    .flat()
    .find(network => network.family === 'IPv4' && !network.internal)?.address;
const insecureOrigin = address && `http://${address}:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const only = process.argv[2];
const results = [];
const check = (name, ok, detail) => {
    results.push([name, ok]);
    console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
};

async function scenario(name, { blocked = false, insecure = false, verbose = false } = {}, body) {
    if (only && !name.includes(only)) {
        return;
    }
    console.log('\n== ' + name);
    const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  PAGE ERROR', e.message));
    page.on('console', m => {
        if (m.type() === 'error') {
            console.log('  CONSOLE', m.text());
        }
    });
    await page.goto((insecure ? insecureOrigin : origin) + '/page.html' + (blocked ? '?blocked=' + blocked : ''));
    await page.waitForFunction(() => window.e2eReady);
    const api = {
        page,
        start: options => page.evaluate(o => window.e2e.start(o), options),
        state: () => page.evaluate(() => window.e2e.state()),
        eval: (fn, arg) => page.evaluate(fn, arg),
        logs: () => page.evaluate(() => window.e2e.logs),
        // sample the state every `period` ms during `duration` ms
        async watch(duration, period = 250) {
            const samples = [];
            for (const end = Date.now() + duration; Date.now() < end; ) {
                await sleep(period);
                samples.push(await api.state());
            }
            return samples;
        }
    };
    try {
        await body(api);
    } catch (e) {
        check(name + ' (exception)', false, e.message);
    }
    if (verbose || process.env.LOGS) {
        console.log((await api.logs()).map(l => '    ' + l).join('\n'));
    }
    await browser.close();
}
const stats = (samples, key) => {
    const v = samples.map(s => s[key]);
    return { min: Math.min(...v), max: Math.max(...v), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) };
};
// effective playback speed: media time elapsed by second of the page clock
const progress = samples =>
    +(((samples[samples.length - 1].time - samples[0].time) * 1000) / (samples[samples.length - 1].now - samples[0].now)).toFixed(
        3
    );

// Common checks of a healthy playback
async function healthy(t, label, engine, { audible = true, freq = 440, settle = 4000, duration = 6000 } = {}) {
    await sleep(settle);
    const samples = await t.watch(duration);
    const last = samples[samples.length - 1];
    check(`${label}: no error`, last.stopError === undefined && last.running, last.stopError);
    check(`${label}: engine`, last.engine === engine, last.engine);
    const drift = stats(samples, 'drift');
    const rates = [...new Set(samples.map(s => s.rate))];
    check(
        `${label}: media time progresses at the playback rate`,
        progress(samples) > Math.min(...rates) - 0.02 && progress(samples) < Math.max(...rates) + 0.02,
        { speed: progress(samples), rates }
    );
    if (last.frames) {
        check(`${label}: video follows audio`, Math.abs(drift.min) < 60 && Math.abs(drift.max) < 60, drift);
    }
    if (audible) {
        check(`${label}: sound heard`, last.rms > 0.02 && Math.abs(last.freq - freq) < 3, {
            rms: +last.rms.toFixed(4),
            freq: +last.freq.toFixed(1)
        });
    }
    return samples;
}

await scenario('webcodecs AAC 48k + H264', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4' });
    const samples = await healthy(t, 'webcodecs', 'webcodecs');
    const last = samples[samples.length - 1];
    check('webcodecs: no stall, few video seeks', last.stalls === 0 && last.events.seeking <= 3 && last.events.waiting <= 3, {
        stalls: last.stalls,
        ...last.events
    });
    check('webcodecs: decoder file not loaded', !requests.some(r => r.includes('decoder')));
    check('webcodecs: buffer in low latency', last.buffer < 1500, { buffer: last.buffer, state: last.state });
});

await scenario('wasm AAC 48k + H264', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4', engines: ['wasm', 'mse'] });
    const samples = await healthy(t, 'wasm', 'wasm');
    const last = samples[samples.length - 1];
    check('wasm: no stall, few video seeks', last.stalls === 0 && last.events.seeking <= 3, {
        stalls: last.stalls,
        ...last.events
    });
    check(
        'wasm: decoder file loaded on demand',
        requests.some(r => r.endsWith('/dist/wrts-client.decoder.js'))
    );
});

await scenario('mse legacy AAC 48k + H264', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4', engines: ['mse'] });
    await healthy(t, 'mse', 'mse', { audible: false });
});

// A protected audio track can only be decrypted by a media element: never decoded by WebCodecs or WebAssembly
await scenario('protected audio track', {}, async t => {
    const before = requests.length;
    await t.start({ file: 'media/av-aac48.mp4', protectAudio: true });
    await healthy(t, 'protected', 'mse', { audible: false });
    const logs = await t.logs();
    check(
        'protected: audio is given to the video element, no decoder is created',
        !logs.some(l => /decoded with|Audio rendering started/.test(l)) &&
            !requests.slice(before).some(r => r.includes('decoder')),
        logs.filter(l => /decoded with|Audio rendering|AudioBuffer/.test(l))
    );
});

await scenario('webcodecs AAC 44.1k + B-frames (resampling)', {}, async t => {
    await t.start({ file: 'media/av-aac44-bframes.mp4' });
    await healthy(t, 'aac44', 'webcodecs');
});

await scenario('wasm MP3 44.1k', {}, async t => {
    await t.start({ file: 'media/av-mp3.mp4', engines: ['wasm', 'mse'] });
    await healthy(t, 'wasm-mp3', 'wasm');
});
await scenario('webcodecs MP3 44.1k', {}, async t => {
    await t.start({ file: 'media/av-mp3.mp4' });
    await healthy(t, 'webcodecs-mp3', 'webcodecs');
});

await scenario('audio only', {}, async t => {
    await t.start({ file: 'media/a-aac48.mp4' });
    await healthy(t, 'audio-only', 'webcodecs');
});

await scenario('video only', {}, async t => {
    await t.start({ file: 'media/v-only.mp4' });
    await sleep(4000);
    const samples = await t.watch(4000);
    const last = samples[samples.length - 1];
    check(
        'video-only: plays with the video element as clock',
        last.stopError === undefined && last.engine === undefined && Math.abs(progress(samples) - 1) < 0.1 && last.drift === 0,
        { progress: progress(samples), drift: last.drift }
    );
});

for (const engines of [undefined, ['wasm', 'mse']]) {
    const label = engines ? 'wasm' : 'webcodecs';
    await scenario(`playback rate changes (${label})`, {}, async t => {
        await t.start({ file: 'media/av-aac48.mp4', engines, adjust: false, high: 3000 });
        await sleep(5000);
        const before = await t.state();
        for (const rate of [1.1, 1, 0.9, 1, 1.1, 0.9, 1.1, 1]) {
            await t.eval(r => {
                window.e2e.player.playbackRate = r;
            }, rate);
            await sleep(700);
            const samples = await t.watch(2000);
            const last = samples[samples.length - 1];
            const drift = stats(samples, 'drift');
            check(
                `rate ${rate}: speed, sync and pitch`,
                Math.abs(progress(samples) - rate) < 0.02 &&
                    Math.abs(drift.min) < 60 &&
                    Math.abs(drift.max) < 60 &&
                    Math.abs(last.freq - 440) < 3 &&
                    last.rms > 0.02,
                { speed: progress(samples), drift, freq: +last.freq.toFixed(1), videoRate: last.videoRate }
            );
        }
        const after = await t.state();
        check(
            'rate changes: no video seek, no video waiting, no stall',
            after.events.seeking === before.events.seeking &&
                after.events.waiting === before.events.waiting &&
                after.stalls === 0 &&
                after.stopError === undefined,
            {
                seeking: after.events.seeking - before.events.seeking,
                waiting: after.events.waiting - before.events.waiting,
                ratechange: after.events.ratechange - before.events.ratechange,
                dropped: after.dropped - before.dropped
            }
        );
    });
}

await scenario('playback rate without pitch correction', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4', adjust: false, preservesPitch: false, high: 3000 });
    await sleep(5000);
    await t.eval(() => {
        window.e2e.player.playbackRate = 1.1;
    });
    await sleep(1000);
    const samples = await t.watch(2500);
    const last = samples[samples.length - 1];
    check(
        'varispeed: speed and pitch follow the rate',
        Math.abs(progress(samples) - 1.1) < 0.02 && Math.abs(last.freq - 484) < 4,
        { speed: progress(samples), freq: +last.freq.toFixed(1), drift: stats(samples, 'drift') }
    );
});

await scenario('automatic rate adaptation and network freeze', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4' });
    await sleep(6000);
    await t.eval(() => window.e2e.hold(2500));
    const during = await t.watch(3000);
    const stalled = during.some(s => s.buffering);
    const after = await t.watch(9000);
    const last = after[after.length - 1];
    const tail = after.slice(-12);
    check('freeze: stall then recovery', stalled && last.stalls >= 1 && last.stopError === undefined && !last.buffering, {
        stalls: last.stalls,
        buffering: last.buffering
    });
    check(
        'freeze: back in sync and audible',
        Math.abs(stats(tail, 'drift').min) < 60 &&
            Math.abs(stats(tail, 'drift').max) < 60 &&
            last.rms > 0.02 &&
            Math.abs(last.freq - 440) < 3,
        { drift: stats(tail, 'drift'), freq: +last.freq.toFixed(1), buffer: last.buffer, rate: last.rate, state: last.state }
    );
    console.log(
        '    rates seen:',
        [...new Set(during.concat(after).map(s => s.rate))].join(', '),
        ' buffer:',
        stats(after, 'buffer')
    );
});

await scenario('pause, resume and goLive', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4' });
    await sleep(5000);
    await t.eval(() => {
        window.e2e.player.paused = true;
    });
    await sleep(600);
    const a = await t.state();
    await sleep(1500);
    const b = await t.state();
    check(
        'pause: audio clock and video stopped, silence',
        Math.abs(b.time - a.time) < 0.01 && Math.abs(b.videoTime - a.videoTime) < 0.01 && b.videoPaused && b.rms < 0.001,
        { dt: b.time - a.time, dv: b.videoTime - a.videoTime, rms: b.rms, videoPaused: b.videoPaused }
    );
    await t.eval(() => {
        window.e2e.player.paused = false;
    });
    await sleep(3000);
    const samples = await t.watch(3000);
    const last = samples[samples.length - 1];
    check(
        'resume: plays in sync',
        last.stopError === undefined &&
            Math.abs(progress(samples) - last.rate) < 0.03 &&
            Math.abs(stats(samples, 'drift').min) < 60 &&
            Math.abs(stats(samples, 'drift').max) < 60 &&
            last.rms > 0.02,
        { speed: progress(samples), rate: last.rate, drift: stats(samples, 'drift'), buffer: last.buffer }
    );
    await t.eval(() => window.e2e.player.goLive('test'));
    await sleep(2500);
    const live = await t.watch(2000);
    check(
        'goLive: plays in sync near live',
        Math.abs(stats(live, 'drift').min) < 60 &&
            Math.abs(stats(live, 'drift').max) < 60 &&
            live[live.length - 1].buffer < 1500 &&
            live[live.length - 1].stopError === undefined,
        { drift: stats(live, 'drift'), buffer: live[live.length - 1].buffer }
    );
});

await scenario('long pause', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4', reliable: true, adjust: false });
    await sleep(4000);
    await t.eval(() => {
        window.e2e.player.paused = true;
    });
    await sleep(16000);
    const paused = await t.state();
    check(
        'long pause: the audio received waits compressed, PCM is bounded',
        paused.buffer > 15000 && paused.decodedAhead > 9 && paused.decodedAhead < 12.5 && paused.stopError === undefined,
        { buffer: paused.buffer, decodedAhead: paused.decodedAhead }
    );
    await t.eval(() => {
        window.e2e.player.paused = false;
    });
    await sleep(2000);
    const samples = await t.watch(13000);
    const last = samples[samples.length - 1];
    const drift = stats(samples, 'drift');
    check(
        'long pause: resumes where paused and plays through the audio decoded later',
        last.stopError === undefined &&
            last.stalls === 0 &&
            Math.abs(progress(samples) - 1) < 0.02 &&
            Math.abs(drift.min) < 60 &&
            Math.abs(drift.max) < 60 &&
            samples.every(s => s.rms > 0.02) &&
            Math.abs(last.time - paused.time - 15) < 0.5,
        {
            speed: progress(samples),
            drift,
            played: last.time - paused.time,
            buffer: last.buffer,
            decodedAhead: last.decodedAhead,
            silent: samples.filter(s => s.rms <= 0.02).length
        }
    );
    await t.eval(() => window.e2e.player.goLive('test'));
    await sleep(2500);
    const live = await t.watch(2500);
    const end = live[live.length - 1];
    check(
        'long pause: goLive jumps over the audio not decoded',
        end.stopError === undefined &&
            end.buffer < 8000 &&
            end.rms > 0.02 &&
            Math.abs(stats(live, 'drift').min) < 60 &&
            Math.abs(stats(live, 'drift').max) < 60 &&
            Math.abs(progress(live) - end.rate) < 0.03,
        { buffer: end.buffer, drift: stats(live, 'drift'), speed: progress(live), rate: end.rate }
    );
});

await scenario('seek from the video element', {}, async t => {
    // reliable: the player doesn't go back to live by itself after the seek
    await t.start({ file: 'media/av-aac48.mp4', adjust: false, reliable: true });
    await sleep(7000);
    const a = await t.state();
    await t.eval(() => {
        const v = document.getElementById('video');
        v.currentTime = v.currentTime - 3;
    });
    await sleep(1500);
    const samples = await t.watch(2000);
    const last = samples[samples.length - 1];
    check(
        'external seek: audio follows the video element',
        Math.abs(last.time - (a.time - 3 + (last.now - a.now) / 1000)) < 0.3 &&
            Math.abs(stats(samples, 'drift').max) < 60 &&
            Math.abs(stats(samples, 'drift').min) < 60 &&
            last.stopError === undefined &&
            last.rms > 0.02,
        {
            before: a.time,
            after: last.time,
            expected: a.time - 3 + (last.now - a.now) / 1000,
            drift: stats(samples, 'drift'),
            buffer: last.buffer
        }
    );
});

await scenario('volume and mute follow the video element', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4' });
    await sleep(5000);
    const a = await t.state();
    await t.eval(() => {
        document.getElementById('video').muted = true;
    });
    await sleep(1200);
    const b = await t.state();
    await t.eval(() => {
        const v = document.getElementById('video');
        v.muted = false;
        v.volume = 0.5;
    });
    await sleep(1200);
    const c = await t.state();
    check('volume: muted then half volume', a.rms > 0.02 && b.rms < 0.001 && Math.abs(c.rms / a.rms - 0.5) < 0.05, {
        full: a.rms,
        muted: b.rms,
        half: c.rms
    });
});

await scenario('autoplay blocked, muted', { blocked: 'all' }, async t => {
    await t.start({ file: 'media/av-aac48.mp4', muted: true });
    await sleep(4000);
    const samples = await t.watch(3000);
    const last = samples[samples.length - 1];
    check(
        'blocked+muted: plays silently on the system clock',
        last.context === 'suspended' &&
            last.stopError === undefined &&
            Math.abs(progress(samples) - last.rate) < 0.03 &&
            Math.abs(stats(samples, 'drift').max) < 80 &&
            Math.abs(stats(samples, 'drift').min) < 80,
        { context: last.context, speed: progress(samples), drift: stats(samples, 'drift'), error: last.stopError }
    );
    // user gesture: unmute
    await t.page.mouse.click(100, 100);
    await t.eval(() => {
        document.getElementById('video').muted = false;
    });
    await sleep(2000);
    const after = await t.watch(3000);
    const end = after[after.length - 1];
    check(
        'user gesture: audio starts and takes the clock without a jump',
        end.context === 'running' &&
            end.rms > 0.02 &&
            Math.abs(end.freq - 440) < 3 &&
            Math.abs(progress(after) - end.rate) < 0.03 &&
            Math.abs(stats(after, 'drift').max) < 60 &&
            end.time > last.time + 4 &&
            end.time < last.time + 6.5,
        {
            context: end.context,
            rms: end.rms,
            freq: end.freq,
            speed: progress(after),
            drift: stats(after, 'drift'),
            elapsed: end.time - last.time
        }
    );
});

await scenario('autoplay blocked, unmuted', { blocked: 'all' }, async t => {
    await t.start({ file: 'media/av-aac48.mp4', muted: false });
    await sleep(5000);
    const s = await t.state();
    check('blocked+unmuted: stops with a Video play error', s.stopError?.name === 'Video play error', s.stopError);
});

await scenario('autoplay blocked for audio only, unmuted', { blocked: 'audio' }, async t => {
    await t.start({ file: 'media/av-aac48.mp4', muted: false });
    await sleep(5000);
    const s = await t.state();
    check(
        'audio blocked+unmuted: stops with a Video play error',
        s.stopError?.name === 'Video play error' && /AudioContext/.test(s.stopError.detail),
        s.stopError
    );
});

for (const engines of [undefined, ['wasm', 'mse']]) {
    await scenario(`audio hole (${engines ? 'wasm' : 'webcodecs'})`, {}, async t => {
        // enough buffer to not starve during the hole: the hole is then crossed while playing
        await t.start({ file: 'media/av-aac48.mp4', engines, adjust: false, high: 4000, reliable: true });
        await sleep(7000);
        const before = await t.state();
        await t.eval(() => window.e2e.dropAudio(600));
        const during = await t.watch(5000, 100);
        const after = await t.watch(3000);
        const last = after[after.length - 1];
        const jump = Math.max(
            ...during.map((s, i) => (i ? s.time - during[i - 1].time - (s.now - during[i - 1].now) / 1000 : 0))
        );
        check(
            'audio hole: the clock jumps over the hole without stall',
            jump > 0.5 && jump < 0.75 && last.skipped >= 500 && last.stalls === 0 && last.stopError === undefined,
            { jump: +jump.toFixed(3), skipped: last.skipped, stalls: last.stalls }
        );
        check(
            'audio hole: the video resynchronizes',
            Math.abs(stats(after, 'drift').min) < 60 &&
                Math.abs(stats(after, 'drift').max) < 60 &&
                last.rms > 0.02 &&
                Math.abs(progress(after) - 1) < 0.02,
            {
                drift: stats(after, 'drift'),
                speed: progress(after),
                seeks: last.events.seeking - before.events.seeking,
                buffer: last.buffer,
                constraint: last.constraint
            }
        );
    });
}

await scenario('audio hole with a short buffer', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4' });
    await sleep(5000);
    await t.eval(() => window.e2e.dropAudio(600));
    await sleep(3000);
    const after = await t.watch(3000);
    const last = after[after.length - 1];
    check(
        'audio hole, short buffer: recovers in sync',
        last.stopError === undefined &&
            !last.buffering &&
            Math.abs(stats(after, 'drift').min) < 60 &&
            Math.abs(stats(after, 'drift').max) < 60 &&
            last.rms > 0.02,
        { drift: stats(after, 'drift'), stalls: last.stalls, buffer: last.buffer }
    );
});

await scenario('no false playback constraint', {}, async t => {
    await t.start({ file: 'media/av-aac48.mp4' });
    await sleep(3000);
    const samples = await t.watch(10000);
    check(
        'constraint: none during a normal playback',
        samples.every(s => !s.constraint),
        samples.find(s => s.constraint)?.constraint
    );
});

if (insecureOrigin) {
    await scenario('insecure context', { insecure: true }, async t => {
        const before = requests.length;
        await t.start({ file: 'media/av-aac48.mp4' });
        const secure = await t.eval(() => window.isSecureContext);
        const samples = await healthy(t, 'insecure', 'mse', { audible: false });
        const logs = await t.logs();
        check(
            'insecure: audio falls back on the video element, without error nor decoder download',
            !secure &&
                samples[samples.length - 1].context === undefined &&
                logs.some(l => /^warn .*secure context/.test(l)) &&
                !logs.some(l => /^error|worklet loading failed/i.test(l)) &&
                !requests.slice(before).some(r => r.includes('decoder')),
            { secure, logs: logs.filter(l => /^(warn|error)/.test(l) && !/liveTime|skips/.test(l)) }
        );
    });
}

// Frameworks like Vue wrap the objects of their state in proxies: examples/player.html keeps its player this way,
// everything the player creates is then seen through proxies by its own code
if (process.env.VUE) {
    for (const engines of [undefined, ['wasm', 'mse']]) {
        const label = 'reactive ' + (engines ? 'wasm' : 'webcodecs');
        await scenario(`player in a Vue reactive proxy (${engines ? 'wasm' : 'webcodecs'})`, {}, async t => {
            await t.start({ file: 'media/av-aac48.mp4', engines, reactive: true });
            await healthy(t, label, engines ? 'wasm' : 'webcodecs');
            await t.eval(() => {
                window.e2e.player.playbackRate = 1.1;
            });
            await sleep(1500);
            const state = await t.state();
            const logs = await t.logs();
            check(
                `${label}: no failure`,
                state.stopError === undefined && state.rms > 0.02 && !logs.some(l => /failed|error/i.test(l)),
                {
                    logs: logs.filter(l => /failed|error/i.test(l)).map(l => l.slice(0, 160))
                }
            );
            await t.eval(() => window.e2e.stop());
            await sleep(7000);
            const context = await t.eval(() => window.e2e.contextState());
            check(`${label}: the audio output is released after the stop`, context === 'suspended', context);
        });
    }
}

await scenario('restart', {}, async t => {
    for (let i = 0; i < 3; ++i) {
        await t.start({ file: 'media/av-aac48.mp4', engines: i === 1 ? ['wasm', 'mse'] : undefined });
        await sleep(3500);
        const samples = await t.watch(1500);
        const last = samples[samples.length - 1];
        check(
            `restart ${i}: plays`,
            last.stopError === undefined && last.rms > 0.02 && Math.abs(stats(samples, 'drift').max) < 60,
            { engine: last.engine, drift: stats(samples, 'drift'), rms: last.rms }
        );
        await t.eval(() => window.e2e.stop());
        await sleep(1200);
        const stopped = await t.state();
        check(`restart ${i}: stopped silently`, stopped.stopError === null && stopped.rms < 0.001, {
            stopError: stopped.stopError,
            rms: stopped.rms
        });
    }
});

server.close();
const failed = results.filter(r => !r[1]);
console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
        (failed.length ? '\nFAILED:\n' + failed.map(f => ' - ' + f[0]).join('\n') : '')
);
process.exit(failed.length ? 1 : 0);
