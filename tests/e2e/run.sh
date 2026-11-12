#!/usr/bin/env bash
# Copyright 2025 Ceeblue B.V.
# This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
# See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
#
# Run the end-to-end tests in the Playwright docker image, which ships a Chromium able to decode H.264 and AAC.
#
# Usage: tests/e2e/run.sh [scenario filter]
# Build the library (npm run build) and generate the media (tests/e2e/media.sh) before.
# Set LOGS=1 to display the logs of the player.
set -euo pipefail

PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.65.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ ! -f "$ROOT/dist/wrts-client.bundle.js" ] || [ ! -f "$ROOT/tests/e2e/media/av-aac48.mp4" ]; then
    echo "Run 'npm run build' and 'tests/e2e/media.sh' first" >&2
    exit 1
fi

exec docker run --rm --ipc=host -e LOGS="${LOGS:-}" -e PLAYWRIGHT=/tmp/playwright/node_modules/playwright/index.mjs \
    -v "$ROOT:/repo:ro" -w /repo "mcr.microsoft.com/playwright:v$PLAYWRIGHT_VERSION-noble" \
    bash -c 'npm install --silent --no-audit --no-fund --prefix /tmp/playwright playwright@'"$PLAYWRIGHT_VERSION"' && node tests/e2e/run.mjs "$@"' -- "$@"
