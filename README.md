<p align="center">
 <a href="#requirements">Requirements</a> •
 <a href="#usage">Usage</a> •
 <a href="#playback-rate-adaptation">Playback rate adaptation</a> •
 <a href="#drm">DRM</a> •
 <a href="#ads">Ads</a> •
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

To stay close to the live edge and protect against stalls when the network worsens, the default `Player` adjusts `<video>.playbackRate` from the buffer state on every supported platform, including environments exposing `ManagedMediaSource`. It switches to 1.1x when the buffer is `HIGH`, to 0.9x when it is `LOW`, and back to 1x when it is `OK`. This is a deliberate compromise: we prioritise low latency and stall protection over perfectly smooth audio.

There is no Safari-specific workaround in `onBufferChange` or `adjustPlaybackRate`. To disable automatic playback-rate adaptation, override `onBufferChange` without calling `adjustPlaybackRate`:

```javascript
player.onBufferChange = () => {
   // Keep the current playback rate.
};
```

To use different rates, override `onBufferChange` and pass custom percentages to `player.adjustPlaybackRate(minRate, maxRate)` (default 90 / 110).


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

At runtime the player tries the key systems in the order of the `contentProtection` keys and uses the first one the current browser supports.

A certificate is optional for Widevine (a service certificate). Once configured, though, it is required: if it fails to load or the CDM refuses it, that key system is not used, and its error reaches the app through `onStop` when no other key system works.

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


## Ads

The [AdsEngine](./src/ads/AdsEngine.ts) plays a video or audio **pre-roll** ad before the stream, with the [Google IMA HTML5 SDK]. It is independent of the `Player`: play the ad first, then start the player from `onEnd`.

```html
<div style="position: relative">
   <video id="video" playsinline></video>
   <div id="ads" style="position: absolute; inset: 0"></div>
</div>
```

```javascript
import { Player, AdsEngine } from '@ceeblue/wrts-client';

const player = new Player(video);
// Build it early: it loads the IMA SDK, which must be ready on the click
const ads = new AdsEngine(video, document.getElementById('ads'));
ads.onEnd = error => {
   // The ad break is over, with an error when no ad was played: start the content in both cases
   player.start({ endPoint: <endPoint> });
};
playButton.onclick = () => ads.start({ adTagUrl: 'https://pubads.g.doubleclick.net/gampad/ads?...&output=vast' });
```

- **The ad never prevents the content.** `onEnd` fires exactly once per `start()`: when the ad ends, or with an `AdsEngineError` when the SDK is blocked (ad blocker), the ad tag has no ad to serve, the ad fails, or nothing happens within the timeout (8 seconds by default, see the `timeout` parameter). `ads.stop()` aborts the ad without firing `onEnd`.
- **Start it from a click.** Browsers, mobile ones above all, only allow an ad with sound from a user gesture. Without one, mute the video before `ads.start()`; the ad server is told so and selects an ad allowed to autoplay muted.
- **Ad tag.** It must return a single VAST pre-roll. With a playlist (VMAP, ad rules) only the pre-roll is played, the player takes over the video element afterwards.
- **Audio ads.** Use an ad tag with `ad_type=audio` (or `audio_video`) and `vpmute=0`. The container can be hidden with `display: none` on an audio-only page, but must stay in the document. The SDK displays no skip button for an audio ad: display yours when `ads.skippable` is true and call `ads.skip()` (it has no effect on a video ad, where the SDK displays its own button). The `audio` argument of `onAdStart(duration, audio)` tells which kind of ad is playing.
- **iPhone.** Keep the `playsinline` attribute on the `<video>`.
- **Layout.** The container covers the video: give it `pointer-events: none` while no ad plays to keep your own controls reachable, and put it inside the element you display in fullscreen.
- **Consent.** The SDK reads the consent from the CMP of your page (IAB TCF); collecting it is up to the page.

During the ad use `ads.paused` and `ads.volume`, and the `onAdStart`, `onAdProgress`, `onAdPause` and `onAdResume` events to drive your own UI. To change the SDK settings (locale, VPAID mode...) before the first ad, use `AdsEngine.load().then(ima => ima.settings.setLocale('es'))`.

> [!NOTE]
> The IMA SDK is not part of this library: it is loaded from Google at runtime, and only when an `AdsEngine` is built. Its use is subject to Google's terms.


## Examples

To help you get started, we provide the following examples:

- [/examples/player.html](./examples/player.html) - Play a stream

> [!TIP]
> 
> To serve the examples locally, run a [static http-server] in the project directory:
>```
>npx http-server . -p 8081
>```
> You can then access the examples at http://localhost:8081/examples/player.html.


## Building locally

1. [Clone] this repository
2. Enter the `wrts-client` folder and run `npm install` to install packages dependencies.
3. Execute `npm run build`. The output will be the following files placed in the **/dist/** folder:
   - **wrts-client.d.ts** - Typescript definitions file
   - **wrts-client.js** - NPM JavaScript library
   - **wrts-client.bundle.js** - Bundled browser JavaScript library
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

By default CMCD is disabled, but you can enable it by setting the `cmcd` property in the [Player](./src/Player.ts) object. These properties belong to the running stream: set them in `onStart`, which fires on every start (setting them on a stopped player throws). The following properties are available for customization:

```javascript
player.onStart = () => {
   // Set the level of CMCD data to be sent:
   // 'full' sends all available keys, 'short' sends only the necessary keys, 'none' disables CMCD
   player.cmcd = CMCD.NONE;

   // Define the CMCD delivery method:
   // 'header' sends the CMCD data in HTTP headers, 'query' sends it via the query string
   player.cmcdMode = CMCDMode.HEADER;

   // Specify a unique session ID for tracking the client session
   player.cmcdSid = 'client-session-id';
};
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
[Google IMA HTML5 SDK]: https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side
