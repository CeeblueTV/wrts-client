/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { FixMap } from '@ceeblue/web-utils';

export const MAX_GOP_DURATION = 10000; // ms

export enum Type {
    DATA = 0,
    AUDIO = 1,
    VIDEO = 2
}

export enum Codec {
    UNKNOWN = '',
    H264 = 'H264',
    HEVC = 'HEVC',
    MP3 = 'MP3',
    AAC = 'AAC'
}

export type Sample = {
    time: number;
    duration: number;
    data: Uint8Array;
    compositionOffset?: number;
    isKeyFrame?: boolean;
    subSamples?: Array<{ clearBytes: number; encryptedBytes: number }>; // DRM field for SENC box
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
};

export type Resolution = {
    width: number;
    height: number;
};

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

export class Samples {
    [Symbol.iterator](): IterableIterator<[number, Sample[]]> {
        return this._samples[Symbol.iterator]();
    }
    get tracks(): Array<number> {
        return [...this._tracks.keys()]; // WIP replace by FixMap::keys()
    }
    get startTime(): number {
        return this._startTime;
    }
    get endTime(): number {
        return this._endTime;
    }
    get duration(): number {
        return this.endTime - this.startTime;
    }

    private _samples: FixMap<number, Array<Sample>>;
    private _startTime: number;
    private _endTime: number;
    private _tracks: Set<number>;
    constructor() {
        this._samples = new FixMap<number, Array<Sample>>(() => []);
        this._tracks = new Set<number>();
        this._startTime = 0;
        this._endTime = 0;
    }

    push(trackId: number, sample: Sample): Samples {
        this._startTime = this._samples.size ? Math.min(this._startTime, sample.time) : sample.time;
        this._endTime = Math.max(this._endTime, sample.time + sample.duration);
        this._samples.get(trackId).push(sample);
        this._tracks.add(trackId);
        return this;
    }
}
