/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, EventEmitter } from '@ceeblue/web-utils';
import { Metadata } from '../Metadata';
import * as Media from '../Media';

/**
 * Audio/video capabilities derived from a {@link Metadata} object, ready to be assigned
 * to a {@link MediaKeySystemConfiguration}.
 */
export type MetadataCapabilities = {
    audioCapabilities?: MediaKeySystemMediaCapability[];
    videoCapabilities?: MediaKeySystemMediaCapability[];
};

/**
 * Result of {@link MediaKeysConfig.normalizeLicense}: a license server URL with optional request headers.
 */
export type NormalizedMediaKeyLicense = {
    url: string;
    headers?: Record<string, string>;
};

/**
 * Result of {@link MediaKeysConfig.normalizeCertificate}: either a `url` to fetch the certificate from
 * (with optional `headers`) or the certificate bytes directly in `data`. At most one of
 * `url` / `data` is set; both being absent means the input did not provide a usable certificate.
 */
export type NormalizedMediaKeyCertificate = {
    url?: string;
    data?: Uint8Array;
    headers?: Record<string, string>;
};

/**
 * Base class regrouping the EME / MediaKeys configuration logic used by {@link MediaKeysEngine}.
 *
 * Kept separate from `MediaKeysEngine` for readability. `MediaKeysEngine` inherits from this class
 * so the configuration helpers share the engine's `this.log` channel (each engine instance keeps
 * its own log interception) without forcing callers to pass a logger explicitly.
 */
export abstract class MediaKeysConfig extends EventEmitter {
    /**
     * Base {@link MediaKeySystemConfiguration} used as a template when the caller does not
     * supply {@link Connect.MediaKeySystem.configurations}. Spread first so caller-provided
     * fields override these defaults.
     */
    static readonly DefaultConfiguration: MediaKeySystemConfiguration = {
        initDataTypes: ['cenc', 'sinf', 'skd', 'keyids'],
        distinctiveIdentifier: 'optional',
        persistentState: 'optional',
        sessionTypes: ['temporary']
    };

    /**
     * Normalize a {@link Connect.MediaKeyLicense} (which may be a bare URL string) into an
     * object with `url` and `headers`.
     */
    static normalizeLicense(licenseConfig: Connect.MediaKeyLicense): NormalizedMediaKeyLicense {
        if (typeof licenseConfig === 'string') {
            return { url: licenseConfig, headers: {} };
        }
        return licenseConfig;
    }

    /**
     * Normalize a {@link Connect.MediaKeyCertificate} into a {@link NormalizedMediaKeyCertificate}.
     * A string input is treated as a URL to fetch, a `Uint8Array` as inline certificate bytes,
     * and an object is returned as-is.
     */
    static normalizeCertificate(certificateConfig: Connect.MediaKeyCertificate): NormalizedMediaKeyCertificate {
        if (typeof certificateConfig === 'string') {
            return { url: certificateConfig, headers: {} };
        }
        if (certificateConfig instanceof Uint8Array) {
            return { data: certificateConfig };
        }
        return certificateConfig;
    }

    /**
     * Derive the set of audio/video capabilities from the content-protected tracks of a
     * {@link Metadata} object. Each unique `codecString` produces one capability entry with
     * its `contentType` (e.g. `video/mp4; codecs="avc1.640028"`). Returns empty fields when
     * `metadata` is `undefined` or no track is content-protected.
     */
    protected metadataCapabilities(metadata?: Metadata): MetadataCapabilities {
        const capabilities: MetadataCapabilities = {};
        if (!metadata) {
            return capabilities;
        }

        const videoCapabilities: Map<string, MediaKeySystemMediaCapability> = new Map();
        const audioCapabilities: Map<string, MediaKeySystemMediaCapability> = new Map();

        for (const [, track] of metadata.tracks) {
            if (!track.contentProtection) {
                continue;
            }
            if (track.type === Media.Type.VIDEO) {
                videoCapabilities.set(track.codecString, {
                    contentType: `video/mp4; codecs="${track.codecString}"`
                });
            } else if (track.type === Media.Type.AUDIO) {
                audioCapabilities.set(track.codecString, {
                    contentType: `audio/mp4; codecs="${track.codecString}"`
                });
            }
        }

        if (videoCapabilities.size) {
            capabilities.videoCapabilities = Array.from(videoCapabilities.values());
        }
        if (audioCapabilities.size) {
            capabilities.audioCapabilities = Array.from(audioCapabilities.values());
        }
        return capabilities;
    }

    /**
     * Merge one side (audio or video) of user-provided capabilities with the capabilities
     * derived from stream metadata.
     *
     * Rules:
     * - If the caller provides no capabilities, metadata-derived capabilities are used as-is.
     * - Caller capabilities that include a `contentType` win over metadata (explicit takes precedence).
     * - Caller capabilities without a `contentType` (e.g. only `robustness`) are completed by
     *   cross-joining them with each metadata `contentType`.
     * - When such unresolved capabilities exist and no metadata is available, they are kept
     *   as-is and a warning is logged.
     */
    protected mergeConfigCapabilities(
        configCapabilities: MediaKeySystemMediaCapability[] | undefined,
        metadataCapabilities: MediaKeySystemMediaCapability[] | undefined,
        type: 'audio' | 'video'
    ): MediaKeySystemMediaCapability[] | undefined {
        if (!configCapabilities?.length) {
            return metadataCapabilities?.length ? metadataCapabilities.map(capability => ({ ...capability })) : undefined;
        }

        const explicitCapabilities = configCapabilities
            .filter(capability => !!capability.contentType)
            .map(capability => ({ ...capability }));
        const unresolvedCapabilities = configCapabilities
            .filter(capability => !capability.contentType)
            .map(capability => ({ ...capability }));

        if (explicitCapabilities.length && metadataCapabilities?.length) {
            this.log(
                `${type} capabilities define contentType explicitly, metadata content types are ignored for those entries`
            ).info();
        }

        if (!unresolvedCapabilities.length) {
            return explicitCapabilities.length ? explicitCapabilities : undefined;
        }

        if (!metadataCapabilities?.length) {
            this.log(`${type} capabilities are missing contentType and no metadata is available to complete them`).warn();
            return [...explicitCapabilities, ...unresolvedCapabilities];
        }

        const resolvedCapabilities: MediaKeySystemMediaCapability[] = [];
        for (const configCapability of unresolvedCapabilities) {
            for (const metadataCapability of metadataCapabilities) {
                resolvedCapabilities.push({
                    ...configCapability,
                    contentType: metadataCapability.contentType
                });
            }
        }
        return [...explicitCapabilities, ...resolvedCapabilities];
    }

    /**
     * Build the array of {@link MediaKeySystemConfiguration} that will be passed to
     * `navigator.requestMediaKeySystemAccess()` for a given key system.
     *
     * - When `keySystemConfig` is a bare string (license URL) or has no `configurations`,
     *   a single configuration is returned: `baseConfig` extended with audio/video capabilities
     *   derived from `metadata` if available.
     * - When `keySystemConfig.configurations` are provided, each is merged with metadata via
     *   {@link mergeConfigCapabilities}; the caller's fields override `baseConfig`.
     */
    protected buildKeySystemConfigurations(
        keySystemConfig: Connect.MediaKeySystem,
        metadata?: Metadata,
        baseConfig: MediaKeySystemConfiguration = MediaKeysConfig.DefaultConfiguration
    ): MediaKeySystemConfiguration[] {
        const metadataDerivedCapabilities = this.metadataCapabilities(metadata);
        const explicitConfig = typeof keySystemConfig === 'string' ? undefined : keySystemConfig;

        if (!explicitConfig?.configurations?.length) {
            const configuration: MediaKeySystemConfiguration = {
                ...baseConfig,
                ...(metadataDerivedCapabilities.audioCapabilities && {
                    audioCapabilities: metadataDerivedCapabilities.audioCapabilities
                }),
                ...(metadataDerivedCapabilities.videoCapabilities && {
                    videoCapabilities: metadataDerivedCapabilities.videoCapabilities
                })
            };
            if (!configuration.audioCapabilities?.length && !configuration.videoCapabilities?.length) {
                this.log('No content types found in metadata or configurations, setMediaKeys will probably fail').warn();
            }
            return [configuration];
        }

        return explicitConfig.configurations.map(configConfiguration => {
            const {
                audioCapabilities: configAudioCapabilities,
                videoCapabilities: configVideoCapabilities,
                ...configurationRest
            } = configConfiguration;

            const audioCapabilities = this.mergeConfigCapabilities(
                configAudioCapabilities,
                metadataDerivedCapabilities.audioCapabilities,
                'audio'
            );
            const videoCapabilities = this.mergeConfigCapabilities(
                configVideoCapabilities,
                metadataDerivedCapabilities.videoCapabilities,
                'video'
            );

            const configuration: MediaKeySystemConfiguration = {
                ...baseConfig,
                ...configurationRest,
                ...(audioCapabilities && { audioCapabilities }),
                ...(videoCapabilities && { videoCapabilities })
            };
            if (!configuration.audioCapabilities?.length && !configuration.videoCapabilities?.length) {
                this.log('Configuration has no resolved content types, setMediaKeys will probably fail').warn();
            }
            return configuration;
        });
    }
}
