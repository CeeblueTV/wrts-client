#!/usr/bin/env bash
# Copyright 2025 Ceeblue B.V.
# This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
# See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
#
# Build wasm/decoder.wasm, the WebAssembly audio decoder (libavcodec AAC + MP3) shipped with the library.
#
# Usage: wasm/build.sh
# Requires docker (Emscripten SDK image), FFmpeg sources are downloaded in wasm/build/.
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:4.0.10}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${BUILD_DIR:-$ROOT/wasm/build}"
OUTPUT="$ROOT/wasm/decoder.wasm"

mkdir -p "$BUILD"
if [ ! -d "$BUILD/ffmpeg-$FFMPEG_VERSION" ]; then
    if [ ! -f "$BUILD/ffmpeg-$FFMPEG_VERSION.tar.xz" ]; then
        curl -fsSL -o "$BUILD/ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
    fi
    tar -xf "$BUILD/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$BUILD"
fi
cp "$ROOT/wasm/decoder.c" "$BUILD/decoder.c"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e FFMPEG_VERSION="$FFMPEG_VERSION" -v "$BUILD:/build" -w /build "$EMSDK_IMAGE" bash -euo pipefail -c '
    cd "ffmpeg-$FFMPEG_VERSION"
    # The transforms are only used in single precision float: drop their double and fixed point variants,
    # which weigh 80KB of code and 12MB of static tables
    sed -i "/ff_tx_codelet_list_double_c,/d; /ff_tx_codelet_list_int32_c,/d" libavutil/tx.c
    if [ ! -f config.h ]; then
        # Only what is needed to decode AAC (LC, HE, HEv2) and MP3 to PCM: no demuxer, no filter, no thread, no asm
        emconfigure ./configure \
            --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
            --target-os=none --arch=wasm32 --enable-cross-compile \
            --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-debug \
            --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
            --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
            --disable-asm --disable-inline-asm --disable-x86asm --disable-runtime-cpudetect --disable-stripping \
            --enable-small --enable-lto \
            --enable-decoder=aac --enable-decoder=mp3float \
            --extra-cflags="-Oz -DNDEBUG"
    fi
    emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a
    emcc -Oz -flto -DNDEBUG -I. ../decoder.c libavcodec/libavcodec.a libavutil/libavutil.a \
        -o ../decoder.wasm --no-entry \
        -s STANDALONE_WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=8MB -s STACK_SIZE=1MB \
        -s MALLOC=emmalloc -s FILESYSTEM=0 -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
        -s EXPORTED_FUNCTIONS=_decoder_malloc,_decoder_free,_decoder_open,_decoder_close,_decoder_input,_decoder_decode,_decoder_output,_decoder_channels,_decoder_rate,_decoder_reset
'

cp "$BUILD/decoder.wasm" "$OUTPUT"
ls -l "$OUTPUT"
