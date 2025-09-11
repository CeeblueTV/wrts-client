[Requirements](#requirements) | [Usage](#usage) | [Examples](#examples) | [Building locally](#building-locally) | [Documentation](#documentation) | [Logs](#logs) | [Metrics (CMCD)](#metrics-cmcd) | [Contribution](#contribution) | [License](#license)


# Ceeblue WebRTS Client
[![npm]](https://npmjs.org/package/@ceeblue/wrts-client)

The Ceeblue WebRTS Client is a generic client library implementing a suite of techniques for [Web Real-Time Streaming](./WEBRTS.md).


## Requirements

### 1- Node Package Manager (npm):
Download and install npm from https://nodejs.org/en/download

### 2- Create a Ceeblue Stream:
To create a Stream you need a [Ceeblue account] (a trial account is sufficient). Then connect to your [Ceeblue Dashboard] and [create a stream] to get its `WRTS's <endpoint>`, for example `https://<hostname>/wrts/out+12423351-d0a2-4f0f-98a0-015b73f934f2/index.json`

> [!NOTE]
>
> To obtain a WRTS endpoint from the [Ceeblue Dashboard] click on the Viewer's eye 👁 button to create an output endpoint.

### 3- Install http-server:
> [!NOTE]
>
> Only useful to explore the WebRTS client examples or the documentation locally when you do not have a host.

Simple, zero-configuration command-line [static http-server](https://www.npmjs.com/package/http-server). Start the server with the following command: `http-server . -p 8081`


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
> If your project uses [TypeScript], it is recommended to set `"target": "ES6"` in your configuration to align with our usage of ES6 features and ensures that your build will succeed (for those requiring a backwards-compatible [UMD] version, a [local build](#building-locally) is advised).
> Then defining the compiler option `"moduleResolution": "Node"` in **tsconfig.json** helps with import errors by ensuring that TypeScript uses the correct strategy for resolving imports based on the targeted Node.js version.
>   ```json
>   {
>      "compilerOptions": {
>         "target": "ES6",
>         "moduleResolution": "Node"
>      }
>   }
>   ```

### Play a stream:

To play the stream use the [Player](./src/Player.ts) class with the `WRTS's <endpoint>` you saved while setting up the stream in the [Ceeblue Dashboard] (see [create a stream](#requirements)). A complete example is available with [player.html](./examples/player.html) in [Examples](#examples).

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
> By default player classe uses a [HTTPAdaptiveSource](./src/sources/HTTPAdaptiveSource.ts) which is our [WebRTS](#webrts) implementation. The library now acts as a source factory, so you can create custom [Source implementation](./src/sources/Source.ts) and select it in the constructor:
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

To understand how to use the library through examples, we provide the following illustrations of its implementation:

- [/examples/player.html](./examples/player.html) → Play a stream

> [!TIP]
> 
> If you have installed the [static http-server](#requirements) and executed `http-server . -p 8081` in the project directory, you can navigate to the examples:
>```html
>http://localhost:8081/examples/player.html
>```


## Building locally

1. [Clone] this repository
2. Enter the `wrts-client` folder and run `npm install` to install packages dependencies.
3. Execute `npm run build`. The output will be the following files placed in the **/dist/** folder:
   - **wrts-client.d.ts:** Typescript definitions file
   - **NPM binaries**
      - **wrts-client.js:** NPM JavaScript library
      - **wrts-client.min.js:** Minified version of the NPM library, optimized for size
   - **Browser binaries**
      - **wrts-client.bundle.js:** Browser JavaScript library
      - **wrts-client.bundle.min.js:** Minified version of the browser library, optimized for size
```
git clone https://github.com/CeeblueTV/wrts-client.git
cd wrts-client
npm install
npm run build
```

> [!NOTE]
>
>  Each JavaScript file is accompanied by a `.map` source map file.

> [!TIP]
>
> - By default, the project format is ES module. However, you can build the project for the supported module systems—cjs or iife—using the following commands:
>   ```
>   npm run build:cjs
>   npm run build:iife
>   ```
>  
> - The default target is ES6. If you want to manually test other targets (although they are not officially supported), you can always experiment it with:
>   ```
>   npm run build -- --target esnext
>   npm run build:cjs -- --target esnext
>   ```
>
> - To automatically rebuild the bundles whenever changes are made, run the watch command. This command continuously monitors your project files and rebuilds the bundles as needed:
>   ```
>   npm run watch
>   ```
>   If you prefer to watch and build for a specific target, use one of these commands:
>   ```
>   npm run watch:cjs
>   npm run watch:iife
>   ```


## Documentation

This monorepo also contains built-in documentation about the APIs in the library, which can be built using the following npm command:
```
npm run build:docs
```
You can access the documentation by opening the index.html file in the docs folder with your browser (`./docs/index.html`), or if you have installed and started the [static http-server](#requirements) by navigating to:
```
http://localhost:8081/docs/
```

> [!NOTE]
>
>  An online, continuously maintained version of the latest released documentation is available at https://ceebluetv.github.io/wrts-client/

## Logs

WebRTS uses the [Log Engine] of [web-utils project].

There are four log levels:
- `LogLevel.ERROR` — unrecoverable error
- `LogLevel.WARN` — error which doesn't interrupt the current operation
- `LogLevel.INFO` — informational messages at a frequency acceptable in production
- `LogLevel.DEBUG` — high-frequency messages intended for debugging

By default, only `LogLevel.ERROR` is enabled. To change the level, you can do the following:

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
> Beyond basic filtering, the [Log Engine] of the [web-utils project] also provides advanced features—such as subscription, interception, redirection, and log redefinition.


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


## Contribution

All contributions are welcome. Please see [our contribution guide](/CONTRIBUTING.md) for details.


## License

By contributing code to this project, you agree to license your contribution under the [GNU Affero General Public License](/LICENSE).


[web-utils project]: https://github.com/CeeblueTV/web-utils
[Log Engine]: https://ceebluetv.github.io/web-utils/interfaces/ILog.html
[Clone]: https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository
[dashboard]: https://dashboard.ceeblue.tv
[UMD]: https://github.com/umdjs/umd
[TypeScript]: https://www.typescriptlang.org/
[import]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules
[create a stream]: https://docs.ceeblue.net/reference/create-a-new-stream
[Ceeblue account]: https://ceeblue.net/free-trial/
[Ceeblue Dashboard]: https://dashboard.ceeblue.tv
[npm]: https://img.shields.io/npm/v/%40ceeblue%2Fwebrts-client
[CMCD (Common Media Client Data)]: https://github.com/cta-wave/common-media-client-data