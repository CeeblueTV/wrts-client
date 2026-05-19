/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

export const MAX_GOP_DURATION = 10000; // ms

export enum Type {
    DATA = 0,
    AUDIO = 1,
    VIDEO = 2
}

export enum Codec {
    UNKNOWN = '',
    // Video
    H264 = 'H264',
    HEVC = 'HEVC',
    VP8 = 'VP8',
    // Audio
    MP3 = 'MP3',
    AAC = 'AAC',
    OPUS = 'OPUS',
    // Data
    ID3 = 'ID3',
    JSON = 'JSON',
    SUBTITLE = 'SUBTITLE'
}

export type Sample = {
    time: number;
    duration: number;
    data: Uint8Array;
    compositionOffset?: number;
    isKeyFrame?: boolean;
    subSamples?: Array<{ clearBytes: number; encryptedBytes: number }>; // DRM field for SENC box
    iv?: Uint8Array; // DRM per-sample IV (when ContentProtection.ivMode === 'sample')
};

export type Tracks = {
    /**
     * Audio track, undefined = MBR, -1 = Remove the track
     */
    audio?: number;
    /**
     * Video track, undefined = MBR, -1 = Remove the track
     */
    video?: number;
    /**
     * Datas tracks to receive, undefined = ALL
     */
    data?: Set<number>;
};

export type Resolution = {
    width: number;
    height: number;
};

export function typeToString(type: Type) {
    switch (type) {
        case Type.AUDIO:
            return 'audio';
        case Type.VIDEO:
            return 'video';
        case Type.DATA:
            return 'data';
        default:
    }
    return 'unknown';
}

export function screenResolution(): Resolution | undefined {
    if (typeof window === 'undefined' || !window.screen) {
        return;
    }
    const ratio = window.devicePixelRatio || 1;
    let height = ratio * window.screen.height;
    let width = ratio * window.screen.width;
    if (height > width) {
        // smartphone, switch to compute max fullscreen ability (height becomes width)
        [width, height] = [height, width];
    }
    return { width, height };
}

/**
 * Look if resolution oversize the displayable screen
 * @param resolution
 * @param screen
 * @returns
 */
export function overScreenSize(resolution: Resolution, screen?: Resolution) {
    return screen && resolution.height > screen.height && resolution.width > screen.width;
}
