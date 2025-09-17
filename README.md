<p align="center">
 <a href="#requirements">Requirements</a> •
 <a href="#usage">Usage</a> •
 <a href="#examples">Examples</a> •
 <a href="#building-locally">Building locally</a> •
 <a href="#logs">Logs</a> •
 <a href="#metrics-cmcd">Metrics (CMCD)</a> •
 <a href="#documentation">Documentation</a> •
 <a href="#contribution">Contribution</a> •
 <a href="#license">License</a>
</p>

<h1 align="center">
  <img src="./wrts_logo.png" alt="WebRTS logo" width="40" height="40">
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
https://ceebluetv.github.io/wrts-client/

To build the documentation locally, run:
```
npm run build:docs
```
This generates documentation files, which you can view by opening `./docs/index.html`.

> [!TIP]
> 
> To serve the documentation locally, run a [static http-server] in the `./docs/` directory:
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