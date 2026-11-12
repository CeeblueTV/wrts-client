#!/usr/bin/env bash
# Copyright 2025 Ceeblue B.V.
# This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
# See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
#
# Generate with ffmpeg the fragmented MP4 files played by the end-to-end tests, in tests/e2e/media/:
# a test pattern in H.264 and a 440Hz tone, the frequency searched by the tests in the sound rendered.
set -euo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/media"
mkdir -p "$OUT"

VIDEO_IN="-f lavfi -i testsrc2=size=640x360:rate=25"
VIDEO_OUT="-c:v libx264 -profile:v main -preset veryfast -b:v 600k -g 25 -keyint_min 25 -sc_threshold 0 -pix_fmt yuv420p"
MP4="-movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 200000 -t 60 -f mp4"
tone() { echo "-f lavfi -i sine=frequency=440:sample_rate=$1"; }
run() { ffmpeg -hide_banner -loglevel error -y "$@"; }

run $VIDEO_IN $(tone 48000) $VIDEO_OUT -bf 0 -c:a aac -b:a 128k -ac 2 $MP4 "$OUT/av-aac48.mp4"
run $VIDEO_IN $(tone 44100) $VIDEO_OUT -bf 2 -c:a aac -b:a 96k -ac 2 $MP4 "$OUT/av-aac44-bframes.mp4"
run $VIDEO_IN $(tone 44100) $VIDEO_OUT -bf 0 -c:a libmp3lame -b:a 128k -ac 2 $MP4 "$OUT/av-mp3.mp4"
run $(tone 48000) -c:a aac -b:a 128k -ac 2 $MP4 "$OUT/a-aac48.mp4"
run $VIDEO_IN $VIDEO_OUT -bf 0 -an $MP4 "$OUT/v-only.mp4"
ls -l "$OUT"
