/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, EventEmitter, Util } from '@ceeblue/web-utils';
import { Metadata } from '../Metadata';
import * as Media from '../Media';

export type DRMEngineError =
    /**
     * Represents a MediaKeys issue
     */
    | { type: 'DRMEngineError'; name: 'MediaKeys issue'; detail: string }
    /**
     * Represents an error when creating WebKitMediaKeys
     */
    | { type: 'DRMEngineError'; name: 'Unable to create WebKitMediaKeys'; detail: string }
    /**
     * Represents an error when creating a session with WebKitMediaKeys
     */
    | { type: 'DRMEngineError'; name: 'Unable to create session with WebKitMediaKeys' };

function bufferSourceToUint8Array(source: BufferSource): Uint8Array {
    if (source instanceof ArrayBuffer) {
        return new Uint8Array(source);
    } else {
        // source is an ArrayBufferView
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
}

// Helper: Build an array of DRM configurations by iterating over all robustness combinations.
function buildDrmConfigs(
    baseConfig: MediaKeySystemConfiguration,
    keySystemConfig: Connect.KeySystem
): MediaKeySystemConfiguration[] {
    if (typeof keySystemConfig === 'string') {
        return [baseConfig];
    }
    const audioRobustnesses = keySystemConfig.audioRobustness || [''];
    const videoRobustnesses = keySystemConfig.videoRobustness || [''];
    const configs: MediaKeySystemConfiguration[] = [];

    for (const audioRobustness of audioRobustnesses) {
        for (const videoRobustness of videoRobustnesses) {
            const config: MediaKeySystemConfiguration = {
                ...baseConfig,
                // Update audio capabilities for the current audio robustness
                audioCapabilities:
                    baseConfig.audioCapabilities?.map(cap => ({
                        ...cap,
                        robustness: audioRobustness
                    })) || [],
                // Update video capabilities for the current video robustness
                videoCapabilities:
                    baseConfig.videoCapabilities?.map(cap => ({
                        ...cap,
                        robustness: videoRobustness
                    })) || []
            };
            configs.push(config);
        }
    }
    return configs;
}

/**
 * DRMEngine is a class that handles DRM operations for a video element
 * It supports multiple DRM systems: Widevine, PlayReady, and FairPlay
 * It also supports multiple robustness configurations for each DRM system
 * It also supports multiple key systems for each DRM system
 */
export class DRMEngine extends EventEmitter {
    static START_TIMEOUT: number = 8000;
    /**
     * Event fired on {@link MediaBufferError}
     * @event
     */
    onError(error: DRMEngineError) {
        this.log(error).error();
    }
    onKeyStatusChanged(keyId: string, status: MediaKeyStatus) {
        this.log(`Key status for ${keyId}: ${status}`).info();
    }

    /**
     * Get the current key system
     * @returns The current key system
     */
    get keySystem(): string | undefined {
        return this._keySystem;
    }

    private _video: HTMLVideoElement;
    private _settings: Map<string, Connect.KeySystem> = new Map();

    // Current Key System
    private _keySystem?: string;
    // Current License server URL and parameters
    private _keySystemConfig?: Connect.KeySystem;

    private _initDataMap: Map<string, MediaKeySession> = new Map();
    private _certificate?: Uint8Array;
    private _isStarted: boolean = false;

    constructor(video: HTMLVideoElement) {
        super();
        this._video = video;
        if (video.mediaKeys) {
            throw new Error('MediaKeys already created in the video element');
        }
    }

    start(metadata: Metadata, params: Connect.Params) {
        return Util.safePromise(
            DRMEngine.START_TIMEOUT,
            new Promise((resolve, reject) => {
                if (this._isStarted) {
                    this.log('DRMEngine already started').info();
                    resolve(true);
                    return;
                }
                this._isStarted = true;
                if (this._video.mediaKeys) {
                    this.log('MediaKeys already created').info();
                    resolve(true);
                    return;
                }
                if (!params.contentProtection) {
                    reject('No content protection field found in the settings');
                    return;
                }

                // Copy the content protection settings to the DRM engine
                for (const keySystem in params.contentProtection) {
                    this._settings.set(keySystem, params.contentProtection[keySystem]);
                }

                // For other DRM systems (Widevine, PlayReady), use standard EME
                const drmConfig: MediaKeySystemConfiguration = {
                    initDataTypes: ['cenc', 'sinf', 'skd', 'keyids'],
                    videoCapabilities: [],
                    audioCapabilities: [],
                    distinctiveIdentifier: 'optional',
                    persistentState: 'optional',
                    sessionTypes: ['temporary']
                };

                // Add the capabilities for the tracks
                const tmpVideoCapabilities: Map<string, MediaKeySystemMediaCapability> = new Map();
                const tmpAudioCapabilities: Map<string, MediaKeySystemMediaCapability> = new Map();
                for (const [, track] of metadata.tracks) {
                    if (!track.contentProtection) {
                        continue; // Skip tracks without content protection
                    }
                    if (track.type === Media.Type.VIDEO) {
                        tmpVideoCapabilities.set(track.codecString, {
                            contentType: `video/mp4; codecs="${track.codecString}"`
                        });
                    } else if (track.type === Media.Type.AUDIO) {
                        tmpAudioCapabilities.set(track.codecString, {
                            contentType: `audio/mp4; codecs="${track.codecString}"`
                        });
                    }
                }
                drmConfig.videoCapabilities = Array.from(tmpVideoCapabilities.values());
                drmConfig.audioCapabilities = Array.from(tmpAudioCapabilities.values());

                // Request MediaKeySystemAccess and create MediaKeys
                this._requestKeySystemAccess(drmConfig)
                    .then(keySystemAccess => keySystemAccess.createMediaKeys())
                    .then(createdMediaKeys => {
                        if (this._certificate) {
                            createdMediaKeys.setServerCertificate(this._certificate);
                        }
                        return this._video.setMediaKeys(createdMediaKeys);
                    })
                    .then(() => {
                        this.log(`MediaKeys created and attached to video element with key system ${this._keySystem}`).info();
                        this._video.addEventListener('encrypted', (e: MediaEncryptedEvent) => this._handleEncryptedEvent(e));
                        resolve(true);
                    })
                    .catch(err => {
                        this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: err });
                        reject(err);
                    });
            })
        );
    }

    /**
     * Request the key system access and create the MediaKeys
     */
    private async _requestKeySystemAccess(baseConfig: MediaKeySystemConfiguration): Promise<MediaKeySystemAccess> {
        // Build a map of key system => array of configurations.
        const drmConfigMap = new Map<string, MediaKeySystemConfiguration[]>();
        for (const [keySystem, keySystemConfig] of this._settings.entries()) {
            let configs: MediaKeySystemConfiguration[];
            if (typeof keySystemConfig === 'object') {
                configs = buildDrmConfigs(baseConfig, keySystemConfig);
            } else {
                configs = [baseConfig];
            }
            drmConfigMap.set(keySystem, configs);
        }

        // Try each key system with its array of configurations.
        for (const [keySystem, configs] of drmConfigMap.entries()) {
            try {
                this.log(`Requesting key system ${keySystem} with configs`, JSON.stringify(configs)).debug();
                const keySystemAccess = await navigator.requestMediaKeySystemAccess(keySystem, configs);
                this.log(`Key system ${keySystem} supported`).info();
                this._keySystem = keySystem;
                this._keySystemConfig = this._settings.get(keySystem);

                // Optionally, handle certificate loading if needed
                if (this._keySystemConfig && typeof this._keySystemConfig !== 'string' && this._keySystemConfig.certificate) {
                    if (typeof this._keySystemConfig.certificate === 'string') {
                        await fetch(this._keySystemConfig.certificate)
                            .then(response => response.arrayBuffer())
                            .then(certificate => {
                                this._certificate = new Uint8Array(certificate);
                                this.log(`${keySystem} certificate received, size ${this._certificate.byteLength}`).info();
                            });
                    } else {
                        this.log(`${keySystem} certificate loaded from settings`).info();
                        this._certificate = this._keySystemConfig.certificate;
                    }
                }

                return keySystemAccess;
            } catch (err) {
                this.log(`Key system ${keySystem} not supported with any provided configuration`).info();
            }
        }
        throw new Error('No supported key system found');
    }

    private _handleEncryptedEvent(event: MediaEncryptedEvent) {
        if (!this._video.mediaKeys) {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'MediaKeys not supported' });
            return;
        }

        // Compute the base64-encoded initDataType+initData which is the key of our initDataMap
        const initData = event.initData;
        if (!initData) {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'No init data provided' });
            return;
        }
        this.log(`Received encrypted event, type: ${event.initDataType}, size: ${initData.byteLength}`).info();

        // Note: here we could search for the key ID, for FairPlay we need to parse the JSON and the tenc content of the sinf box
        let initDataString = event.initDataType;
        const byteArray = new Uint8Array(initData);
        const hexInitData = Array.from(byteArray)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
        initDataString += hexInitData;
        initDataString = btoa(initDataString);
        this.log(`Init data as hex: ${hexInitData}`).debug();

        if (this._initDataMap.has(initDataString)) {
            this.log(`Session already created for initData ${initDataString.substring(0, 16)}...`).info();
            return;
        }
        const session = this._video.mediaKeys.createSession();
        if (!session) {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'Failed to create session' });
            return;
        }
        this._initDataMap.set(initDataString, session);

        session.addEventListener('message', ((e: MediaKeyMessageEvent) => this._handleMessage(e, session)) as EventListener);
        session.addEventListener('keystatuseschange', ((e: Event) => this._handleKeyStatusesChange(e, session)) as EventListener);

        session.generateRequest(event.initDataType, byteArray).catch(err => {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'generateRequest failed: ' + err });
        });
    }

    private _handleMessage(event: MediaKeyMessageEvent, session: MediaKeySession) {
        this.log(`Handle message type ${event.messageType} of size ${event.message.byteLength}`).info();
        if (!this._keySystemConfig) {
            this.log('No key system configuration set').info();
            return;
        }

        // The license server URL can be a string or an object with a licenseUrl and optional headers
        const licenseServerUrl =
            typeof this._keySystemConfig === 'string' ? this._keySystemConfig : this._keySystemConfig.licenseUrl;
        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream'
        };
        if (typeof this._keySystemConfig !== 'string' && this._keySystemConfig.headers) {
            Object.assign(headers, this._keySystemConfig.headers);
        }

        // The "message" is the payload from the CDM to send to the license server
        let requestBody: ArrayBuffer | string = event.message;
        // Handle PlayReady specific message transformation
        if (this._keySystem === 'com.microsoft.playready') {
            // Parse the PlayReady message to extract headers and body
            const { headers: playReadyHeaders, body } = DRMEngine._parsePlayReadyMessage(requestBody as ArrayBuffer);
            Object.assign(headers, playReadyHeaders);
            requestBody = body;
        }

        this.log('License request headers:', headers).debug();
        this.log('License request body:', requestBody).debug();

        // Use fetch or XHR to POST the requestBody to the license server
        this.log(`Sending license request to ${licenseServerUrl}`).info();
        fetch(licenseServerUrl, {
            method: 'POST',
            headers,
            body: requestBody
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`License request failed with status ${response.status}`);
                }
                return response.arrayBuffer();
            })
            .then(license => {
                // Provide the license back to the CDM
                this.log(`License response received, size ${license.byteLength}`).info();
                return session.update(license);
            })
            .catch(err => {
                this.log('License request failed:', err).error();
                this.onError({
                    type: 'DRMEngineError',
                    name: 'MediaKeys issue',
                    detail: err instanceof Error ? err.message : 'License request failed'
                });
            });
    }

    private _handleKeyStatusesChange(event: Event, session: MediaKeySession) {
        this.log(`Key status as changed for session ${session.sessionId}`).info();

        /**
         * The key status can be one of :
         * - 'usable' (the key can be used to decrypt media data)
         * - 'expired' (the key has expired and can no longer be used to decrypt media data)
         * - 'released' (the key has been released and can no longer be used to decrypt media data)
         * - 'output-restricted' (the key can be used to decrypt media data, but the user's ability to view the decrypted data is restricted in some way)
         * - 'output-downscaled' (the key can be used to decrypt media data, but the video resolution or quality has been reduced)
         * - 'usable-in-future' (the key can be used to decrypt media data, but only at a specific time in the future)
         * - 'status-pending' (the key status is not yet known)
         * - 'internal-error' (an error occurred while determining the key status)
         */
        for (const [keyId, status] of session.keyStatuses.entries()) {
            const keyArray = bufferSourceToUint8Array(keyId);
            const keyHex = Array.from(keyArray)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            this.onKeyStatusChanged(keyHex, status);
        }
    }

    // PlayReady specific message parsing
    private static _parsePlayReadyMessage(message: ArrayBuffer): { headers: Record<string, string>; body: ArrayBuffer } {
        // Convert the message to a string, assuming UTF-16 encoding
        const messageString = String.fromCharCode(...new Uint16Array(message));

        try {
            // Try to parse as XML first
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(messageString, 'application/xml');

            // Check if we have a valid XML document
            if (xmlDoc.querySelector('parsererror')) {
                // If XML parsing failed, treat as raw message
                return {
                    headers: {
                        'Content-Type': 'text/xml; charset=utf-8',
                        SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
                    },
                    body: message
                };
            }

            // Extract headers from XML
            const headers: Record<string, string> = {};
            const headersElement = xmlDoc.getElementsByTagName('HttpHeaders')[0];
            if (headersElement) {
                const headerNames = headersElement.getElementsByTagName('name');
                const headerValues = headersElement.getElementsByTagName('value');

                for (let i = 0; i < headerNames.length; i++) {
                    const name = headerNames[i].textContent;
                    const value = headerValues[i].textContent;
                    if (name && value) {
                        headers[name] = value;
                    }
                }
            }

            // Extract challenge from XML
            const challengeElement = xmlDoc.getElementsByTagName('Challenge')[0];
            let body: ArrayBuffer;

            if (challengeElement?.textContent) {
                // Decode the base64 challenge
                const binaryString = atob(challengeElement.textContent);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                body = bytes.buffer;
            } else {
                body = message;
            }

            return { headers, body };
        } catch (error) {
            // If any error occurs during parsing, treat as raw message
            return {
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
                },
                body: message
            };
        }
    }
}
