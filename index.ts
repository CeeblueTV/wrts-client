/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// Polyfills
import 'abortcontroller-polyfill';

// Utils
import { log, LogLevel } from '@ceeblue/web-utils';
log.level = LogLevel.ERROR; // put log to ERROR as default level
export * as utils from '@ceeblue/web-utils';

// Media
export { CMAFReader } from './src/media/reader/CMAFReader';
export { Reader, ReaderError } from './src/media/reader/Reader';
export { RTSReader } from './src/media/reader/RTSReader';
export { CMAFWriter, CMAFWriterError } from './src/media/writer/CMAFWriter';
export * as AVC from './src/media/AVC';
export * as Media from './src/media/Media';
export { MediaBuffer, MediaBufferError } from './src/media/MediaBuffer';
export { MediaPlayback, MediaPlaybackError } from './src/media/MediaPlayback';
export { MediaTrack } from './src/media/MediaTrack';
export { Metadata } from './src/media/Metadata';
export { ICMCD, CMCD, CMCDMode } from './src/media/CMCD';
export { DRMEngine, DRMEngineError } from './src/media/drm/DRMEngine';

// Sources
export { Source, SourceError } from './src/sources/Source';
export { HTTPAdaptiveSource } from './src/sources/HTTPAdaptiveSource';
export { WSSource } from './src/sources/WSSource';
export { HTTPSource } from './src/sources/HTTPSource';
export { BufferState, IPlaying } from './src/sources/IPlaying';

export { Player, PlayerError } from './src/Player';

const __lib__version__ = '?'; // will be replaced on building by project version

export const VERSION: string = __lib__version__;
