# WebAssembly audio decoder

`decoder.wasm` is the software audio decoder of the library, used when the browser has no [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) `AudioDecoder` (see [Audio rendering](../README.md#audio-rendering)).

It is a build of the **AAC** (LC, HE-AAC, HE-AACv2) and **MP3** decoders of [FFmpeg](https://ffmpeg.org) (libavcodec), with the minimal C API of [decoder.c](./decoder.c): one compressed frame in, planar 32-bit float PCM out. It is a standalone WebAssembly module without JavaScript glue, loaded by [WasmDecoder](../src/media/audio/WasmDecoder.ts).

The binary is committed in the repository, so building the library doesn't require any WebAssembly toolchain: `npm run build` embeds it in `dist/wrts-client.decoder.js`, a file loaded on demand by the library.

## Build

Requires [docker](https://www.docker.com), the FFmpeg sources and the Emscripten SDK image are downloaded by the script:

```
wasm/build.sh
```

The versions are pinned in [build.sh](./build.sh) (`FFMPEG_VERSION`, `EMSDK_IMAGE`). FFmpeg is configured with everything disabled but the two decoders, optimized for size, and its transforms are limited to single precision float. To support another codec, enable its decoder in the `configure` command of [build.sh](./build.sh) and map it in [decoder.c](./decoder.c) and [WasmDecoder](../src/media/audio/WasmDecoder.ts).

## License

FFmpeg is built without its GPL and non-free parts, the decoder is released under the [LGPL version 2.1 or later](https://ffmpeg.org/legal.html). Its source code is the FFmpeg release named in [build.sh](./build.sh), available on https://ffmpeg.org/releases/, with the one-line patch applied by the script.
