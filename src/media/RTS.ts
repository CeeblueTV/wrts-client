/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import * as Media from '../media/Media';

export function addSourceParams(url: URL, tracks: Media.Tracks, reliable: boolean) {
    if (tracks.audio != null) {
        url.searchParams.set('audio', tracks.audio.toString() + '~');
    }
    if (tracks.video != null) {
        url.searchParams.set('video', tracks.video.toString() + '~');
    }
    url.searchParams.set('reliable', reliable ? 'true' : 'false');
}
