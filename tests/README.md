# Tests

Tests of the audio pipeline (see [Audio rendering](../README.md#audio-rendering)). They are not run by the continuous integration, run them when you change the audio decoding, the audio rendering or the synchronization of the playback.

## Audio worklet

```
npm run test:audio
```

[audio/worklet.test.mjs](./audio/worklet.test.mjs) runs the audio worklet processor offline in Node (22.6 or later), from its serialized source like a browser does, on synthetic signals. It checks the time-stretching (pitch, speed, continuity of the waveform), the resampling (signal-to-noise ratio), the media clock, and the transitions: pause, starvation, seek, hole in the timeline, format change.

## End-to-end

```
npm run build
tests/e2e/media.sh
npm run test:e2e
```

[e2e/run.mjs](./e2e/run.mjs) plays streams with the `Player` in a headless Chromium driven by [Playwright](https://playwright.dev), and measures the playback from outside: speed of the media time, drift of the video from the audio clock, events of the `<video>` element, level and frequency of the sound really sent to the audio output.

- [e2e/media.sh](./e2e/media.sh) generates the streams with [ffmpeg](https://ffmpeg.org): fragmented MP4 files with a test pattern in H.264 and a 440Hz tone in AAC or MP3.
- [e2e/page.js](./e2e/page.js) plays a file like a live stream with a test `Source`, which delivers every fragment when its media time is reached, and can simulate a network freeze or a hole in audio. It also simulates the autoplay policy of browsers, not enforced in headless mode.
- [e2e/run.sh](./e2e/run.sh) runs the scenarios in the Playwright docker image, which ships a Chromium able to decode H.264 and AAC. Pass a text to run only the scenarios containing it, and set `LOGS=1` to display the logs of the player:

```
LOGS=1 tests/e2e/run.sh "playback rate"
```

The scenarios cover the three audio engines (WebCodecs, WebAssembly, Media Source Extensions), AAC and MP3, audio-only and video-only streams, playback rate changes with and without pitch correction, network freeze, pause and long pause, seek, hole in audio, volume, autoplay blocked, and restart.

These tests validate the logic in Chromium only: the behaviors specific to a browser, Safari in particular, have to be checked on the real browser with [examples/player.html](../examples/player.html). Its `audioEngines` query parameter selects the audio engines, for example `?audioEngines=wasm,mse` to test the WebAssembly decoder or `?audioEngines=mse` to compare with audio played by the `<video>` element.
