<p align="center">
 <a href="#requirements">Requirements</a> •
 <a href="#usage">Usage</a> •
 <a href="#playback-rate-adaptation">Playback rate adaptation</a> •
 <a href="#audio-rendering">Audio rendering</a> •
 <a href="#drm">DRM</a> •
 <a href="#examples">Examples</a> •
 <a href="#building-locally">Building locally</a> •
 <a href="#logs">Logs</a> •
 <a href="#metrics-cmcd">Metrics (CMCD)</a> •
 <a href="#documentation">Documentation</a> •
 <a href="#contribution">Contribution</a> •
 <a href="#license">License</a>
</p>
<div align="center">
   <img src="./wrts_logo.svg" width="100"/>
</div>
<h1 align="center">
  Ceeblue WebRTS Client
</h1>
<h4 align="center"><a href="./WEBRTS.md">Web Real-Time Streaming</a> (WebRTS) is a transport-agnostic framework designed to enable live streaming over the web with minimal latency.</h4>
<p align="center">
  <a href="https://npmjs.org/package/@ceeblue/wrts-client"><img src="https://img.shields.io/npm/v/@ceeblue/wrts-client.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@ceeblue/wrts-client"><img src="https://img.shields.io/npm/dm/@ceeblue/wrts-client.svg" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-yellow.svg" alt="License: AGPL v3"></a>
</p>

## Requirements

#### 1. Node Package Manager (npm)
Download and install npm from https://nodejs.org/en/download

#### 2. Create a Ceeblue Account
To create a Stream, you will need a Ceeblue account on [Ceeblue Cloud API] or [Ceeblue Dashboard]. A trial account is sufficient. If you do not have one yet, you can request one on the [Ceeblue website].

#### 3. Create a Stream
To use this library you'll first need to create a stream either through [Ceeblue Cloud API] or on [Ceeblue Dashboard]. Use the [Quick Start Guide] for fast results.\
Once created, obtain its `WRTS <endpoint>` from the API in the `uri` field, for example `https://<hostname>/wrts/out+12423351-d0a2-4f0f-98a0-015b73f934f2/index.json`. 

> [!NOTE]
> From [Ceeblue Dashboard] you can create an output `WRTS endpoint` by clicking on the Viewer's eye 👁 button.

## Usage

Add the library as a dependency to your npm project using:
```
npm install @ceeblue/wrts-client
```
Then [import] the library into your project with:
 ```javascript
import * as WebRTS from '@ceeblue/wrts-client';
```

> [!TIP]
> 
> If your project uses TypeScript, it is recommended to set `"target": "ES6"` in your configuration to align with our usage of ES6 features and ensures that your build will succeed.\
> Set `"moduleResolution": "Node"` in **tsconfig.json** to ensure TypeScript resolves imports correctly for Node.js.
>   ```json
>   {
>      "compilerOptions": {
>         "target": "ES6",
>         "moduleResolution": "Node"
>      }
>   }
>   ```
> If you require a backwards-compatible [UMD] version, we recommend [building it locally](#building-locally).


### Play a stream

To play the stream use the [Player](./src/Player.ts) class with the `WRTS <endpoint>` you saved while [creating the stream](#3-create-a-stream). A complete example is available in [player.html](./examples/player.html) under [Examples](#examples).

```javascript
import { Player}  from '@ceeblue/wrts-client';

const player = new Player(videoElement);
player.onStart = _ => {
   console.log('start playing');
}
player.onStop = _ => {
   console.log('stop playing');
}
player.start({
   endPoint: `https://<hostname>/wrts/out+12423351-d0a2-4f0f-98a0-015b73f934f2/index.json`
});
```
> [!TIP]
> 
> By default the player (class) uses [HTTPAdaptiveSource](./src/sources/HTTPAdaptiveSource.ts) which is our HTTP [WebRTS](#webrts) implementation. The library now acts as a source factory, you can create a custom [Source implementation](./src/sources/Source.ts) and select it in the constructor:
>
>```javascript
>import { Player, Source}  from '@ceeblue/wrts-client';
>class MySource extends Source {
>   ...
>}
>const player = new Player(videoElement, MySource);
>player.start({
>   endPoint: <endPoint>
>});
>```


## Playback rate adaptation

To stay close to the live edge and protect against stalls when the network worsens, the default `Player` adjusts its `playbackRate` from the buffer state: 1.1x when the buffer is `HIGH`, 0.9x when it is `LOW`, and back to 1x when it is `OK`. The rates are the same on every browser, there is no browser-specific workaround in `onBufferChange` or `adjustPlaybackRate`.

The sound is time-stretched by the player itself to follow the playback rate without changing its pitch (see [Audio rendering](#audio-rendering)), so a rate change is inaudible and never disturbs the video. Set `player.preservesPitch = false` to let the pitch follow the playback rate instead, like on a tape.

> [!NOTE]
>
> When audio is played by the `<video>` element (protected audio track, page out of a secure context, or `AudioEngine.MSE` selected, see [Audio rendering](#audio-rendering)), the rate change is applied by the audio pipeline of the browser, and the pitch is controlled by the `preservesPitch` property of the `<video>` element. On Safari, where a rate change with pitch correction can briefly freeze the playback ([WebKit bug 163433](https://bugs.webkit.org/show_bug.cgi?id=163433)), the player disables the pitch correction of the `<video>` element when it uses `ManagedMediaSource`: the pitch then follows the playback rate. Disable the playback rate adaptation as described below to keep the pitch unchanged.

To disable the automatic playback rate adaptation, override `onBufferChange` without calling `adjustPlaybackRate`:

```javascript
player.onBufferChange = () => {
   // Keep the current playback rate.
};
```

To use different rates, override `onBufferChange` and pass custom percentages to `player.adjustPlaybackRate(minRate, maxRate)` (default 90 / 110). A `minRate` of 100 or more disables the slowdown, a `maxRate` of 100 or less disables the acceleration:

```javascript
player.onBufferChange = () => {
   // 0.95x when the buffer is low, 1.05x when it is high
   player.adjustPlaybackRate(95, 105);
};
```

## Audio rendering

Video is played by the `<video>` element through Media Source Extensions, but by default **audio is not given to the `<video>` element anymore**. The player decodes it itself and renders it with the [Web Audio API]:

1. **Decoding** uses [WebCodecs] when the browser implements its `AudioDecoder`, otherwise a WebAssembly build of the AAC and MP3 decoders of [FFmpeg] shipped with the library (see [wasm/README.md](./wasm/README.md)). The WebAssembly decoder is in its own file, `wrts-client.decoder.js`, loaded only by the browsers which need it.
2. **Rendering** is done in an audio worklet which time-stretches the sound to follow the playback rate, resamples it to the audio output rate, and reports the media time really heard.
3. **Synchronization**: audio is the conductor of the playback. Its media time is the clock of the player (`player.currentTime`), and the `<video>` element only follows it: its playback rate is continuously adjusted to stay on the audio time, with a seek when the drift is too large (start, hole in the stream, tab back to foreground).

This removes the interactions between the audio and video pipelines of the browsers on a playback rate change, which were the cause of audio glitches or video freezes on some platforms (Safari on macOS and iOS in particular).

The engine in use is given by `player.audioEngine`, and the engines usable can be restricted or reordered with `Player.audioEngines` before starting a player:

```javascript
import { Player, AudioEngine } from '@ceeblue/wrts-client';

// Default order: WebCodecs, then WebAssembly, then Media Source Extensions as last resort
Player.audioEngines = [AudioEngine.WEBCODECS, AudioEngine.WASM, AudioEngine.MSE];

// Play audio inside the <video> element, like the previous versions
Player.audioEngines = [AudioEngine.MSE];
```

Audio stays in the `<video>` element (`AudioEngine.MSE`) for a protected audio track, which only a media element can decrypt, and when neither WebCodecs nor WebAssembly can decode the track.

Things to know when audio is rendered outside of the `<video>` element:

- **Volume and mute**: the player follows the `volume` and `muted` properties of the `<video>` element, keep using them. The native controls of the `<video>` element can hide their volume button because the element has no audio track, prefer your own controls.
- **Autoplay**: browsers allow sound to start only after a user gesture. Call `player.start()` from the handler of a user gesture, or start with a muted `<video>` element: the stream then plays silently, and the sound starts on the first user gesture which unmutes it. Like before, starting an unmuted playback without user gesture stops the player with a `Video play error`.
- **Remote playback and capture**: AirPlay, Chromecast or `captureStream()` on the `<video>` element get the video without its sound, remote playback is therefore disabled on the element.
- **Secure context**: browsers expose WebCodecs and audio worklets only to a page served in HTTPS, or from `localhost`. On a page served in HTTP audio is played by the `<video>` element.
- **Deployment**: when the library is not bundled, keep `wrts-client.decoder.js` beside the library file. A Content Security Policy must allow `blob:` in `script-src` for the audio worklet, and `'wasm-unsafe-eval'` for the WebAssembly decoder.

[Web Audio API]: https://developer.mozilla.org/docs/Web/API/Web_Audio_API
[WebCodecs]: https://developer.mozilla.org/docs/Web/API/WebCodecs_API
[FFmpeg]: https://ffmpeg.org

## DRM

WebRTS plays DRM-protected streams via [EME (Encrypted Media Extensions)](https://www.w3.org/TR/encrypted-media/). The supported key systems are:

- **Widevine** (`com.widevine.alpha`) — Chrome, Firefox, Edge, Opera, Android.
- **PlayReady** (`com.microsoft.playready`) — Edge, Xbox, Windows Store apps, many smart TVs (Samsung Tizen, LG webOS).
- **FairPlay** (`com.apple.fps.1_0`) — Safari (macOS, iOS, iPadOS).

Pass a `contentProtection` map to `player.start()` keyed by key system. The minimal form is a license URL string; FairPlay also needs a certificate URL:

```javascript
player.start({
   endPoint: 'https://<hostname>/wrts/out+12423351-d0a2-4f0f-98a0-015b73f934f2/index.json',
   contentProtection: {
      'com.widevine.alpha': 'https://widevine.example.com/license',
      'com.microsoft.playready': 'https://playready.example.com/license',
      'com.apple.fps.1_0': {
         license: 'https://fairplay.example.com/license',
         certificate: 'https://fairplay.example.com/certificate'
      }
   }
});
```

At runtime the player negotiates the most-preferred key system supported by the current browser.

> [!TIP]
> The [MediaKeysEngine](./src/media/keys/MediaKeysEngine.ts) can also be used standalone (outside of `Player`), for example to drive EME from another player.

### PlayReady on Edge — known limitations

For browser playback, prefer **Widevine** where it is available. PlayReady is fully supported but the Edge / Chromium implementation has constraints that every browser player has to work around:

- **Avoid increasing `<video>.playbackRate` during playback.** The default `Player` raises the rate above 1.0 to catch up to live, which produces audio artifacts and visible video lag with PlayReady. Override the default by handling `onBufferChange` and clamping the rate to ≤ 1.0. Below is an example only slowing playback down when the buffer runs low:

```javascript
player.onBufferChange = () => {
   // Disable playback rate increase to avoid audio artifacts and video lag with PlayReady on Edge
   // Keep the ability to decrease playback rate to reduce the risk of stalls when network conditions worsen
   player.adjustPlaybackRate(90, 100);
};
```

- **Larger playback buffers work better.** PlayReady's decoder path needs more headroom; configuring buffer thresholds to roughly `min=400ms / max=2000ms` (instead of the WebRTS low-latency defaults) avoids stutter under bandwidth jitter.


## Examples

To help you get started, we provide the following examples:

- [/examples/player.html](./examples/player.html) - Play a stream

> [!TIP]
> 
> To serve the examples locally, run a [static http-server] in the project directory:
>```
>npx http-server . -p 8081
>```
> You can then access the examples at http://localhost:8081/examples/player.html. Use `localhost` or HTTPS: from another host in HTTP the page is not in a secure context, and [audio is played by the `<video>` element](#audio-rendering).


## Building locally

1. [Clone] this repository
2. Enter the `wrts-client` folder and run `npm install` to install packages dependencies.
3. Execute `npm run build`. The output will be the following files placed in the **/dist/** folder:
   - **wrts-client.d.ts** - Typescript definitions file
   - **wrts-client.js** - NPM JavaScript library
   - **wrts-client.bundle.js** - Bundled browser JavaScript library
   - **wrts-client.decoder.js** - WebAssembly audio decoder, loaded on demand by the two libraries above
```
git clone https://github.com/CeeblueTV/wrts-client.git
cd wrts-client
npm install
npm run build
```

> [!NOTE]
>
> Each JavaScript file is accompanied by a minified  `min.js` version and a `.map` source map file

> [!TIP]
>
> By default, the project format is ES module.\
> However, you can build the project for the supported module systems (CommonJS or IIFE) using the following commands:
>   ```
>   npm run build:cjs
>   npm run build:iife
>   ```
>  
> The default target is ES6.\
> If you want to manually test other targets (even though they are not officially supported), you can experiment with:
>   ```
>   npm run build -- --target esnext
>   npm run build:cjs -- --target esnext
>   ```
>
> Run the watch command to automatically rebuild the bundles whenever changes are made:
>   ```
>   npm run watch
>   ```
>
> If you prefer to watch and build for a specific target, use one of the following  commands:
>   ```
>   npm run watch:cjs
>   npm run watch:iife
>   ```


## Logs

WebRTS uses the [Log Engine] of [web-utils project].

There are four log levels:
- `LogLevel.ERROR` - Unrecoverable error
- `LogLevel.WARN`- Error which doesn't interrupt the current operation
- `LogLevel.INFO`- Informational messages at a frequency acceptable in production
- `LogLevel.DEBUG`- High-frequency messages intended for debugging

By default, only `LogLevel.ERROR` is enabled. To change the level, use the following approach:

```javascript
import { utils }  from '@ceeblue/wrts-client';
const { log, LogLevel } = utils;
log.level = LogLevel.INFO; // displays errors, warns and infos
```

To disable all logging, use this approach:
```javascript
import { utils }  from '@ceeblue/wrts-client';
const { log, } = utils;
log.level = false; // suppresses all log output, the opposite `true` value displays all the logs
```

> [!IMPORTANT]
>
> Beyond basic filtering, the [Log Engine] of the [web-utils project] also provides advanced features such as subscription, interception, redirection, and log redefinition.


## Metrics (CMCD)

WebRTS integrates support for [CMCD (Common Media Client Data)] to provide real-time client-side metrics to the server. These metrics help monitor and enhance the viewer's experience by reporting playback quality, buffer status, bitrate adaptation, and other key data points. By leveraging CMCD, WebRTS enables more efficient server-side decision-making for network management, content delivery optimization, and improved end-user quality of service.

By default CMCD is disabled, but you can enable it by setting the `cmcd` property in the [Player](./src/Player.ts) object. The following properties are available for customization:

```javascript
   // Set the level of CMCD data to be sent:
   // 'full' sends all available keys, 'short' sends only the necessary keys, 'none' disables CMCD
   player.cmcd = CMCD.NONE;

   // Define the CMCD delivery method:
   // 'header' sends the CMCD data in HTTP headers, 'query' sends it via the query string
   player.cmcdMode = CMCDMode.HEADER;

   // Specify a unique session ID for tracking the client session
   player.cmcdSid = 'client-session-id';
```

> [!TIP]
>  Set any of these properties to undefined will reset them to their default values, what allows you to safely translate query parameters without worrying about their presence:
>   ```javascript
>   const options = Object.fromEntries(new URLSearchParams(location.search));
>   player.cmcd = options.cmcd; // set cmcd to its default 'none' value if is undefined
>   player.cmcdMode = options.cmcdMode; // set cmcdMode to its default 'header' if is undefined
>   player.cmcdSid = options.cmcdSid; // set cmcdSid to its default '' if is undefined
>   ```


## Documentation

You can find the latest built-in API documentation here:\
https://ceebluetv.github.io/wrts-client/api/

To build the documentation locally, run:
```
npm run build:docs
```
This generates documentation files, which you can view by opening `./dist/docs/api/index.html`.

> [!TIP]
> 
> To serve the documentation locally, run a [static http-server] in the `./dist/docs/api/` directory:
>```
>npx http-server . -p 8081
>```
> You can then access the documentation at http://localhost:8081/.


## Contribution

All contributions are welcome. Please see [our contribution guide](/CONTRIBUTING.md) for details.


## License

By contributing code to this project, you agree to license your contribution under the [GNU Affero General Public License](/LICENSE).


[web-utils project]: https://github.com/CeeblueTV/web-utils
[Log Engine]: https://ceebluetv.github.io/web-utils/interfaces/ILog.html
[Clone]: https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository
[UMD]: https://github.com/umdjs/umd
[import]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules
[Ceeblue Dashboard]: https://dashboard.ceeblue.tv
[Ceeblue Cloud API]: https://docs.ceeblue.net/reference
[Ceeblue website]: https://ceeblue.net/free-trial/
[Quick Start Guide]: https://docs.ceeblue.net/reference/quick-start-guide
[static http-server]: https://www.npmjs.com/package/http-server
[CMCD (Common Media Client Data)]: https://github.com/cta-wave/common-media-client-data
