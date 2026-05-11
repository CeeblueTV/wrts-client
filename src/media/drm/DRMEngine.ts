/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { Connect, Util } from '@ceeblue/web-utils';
import { Metadata } from '../Metadata';
import { CMAFReader } from '../reader/CMAFReader';
import { DRMConfig } from './DRMConfig';

type SessionHandlers = {
    session: MediaKeySession;
    message: (evt: MediaKeyMessageEvent) => void;
    keystatuseschange: EventListener;
};

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

/**
 * DRMEngine handles DRM operations for an `HTMLVideoElement`. It supports Widevine, PlayReady
 * and FairPlay, multiple robustness configurations per key system, and multiple key systems
 * negotiated in order until one is supported by the browser.
 *
 * For convenience, DRMEngine is integrated in {@link Player}, but it can also be used standalone
 * — useful when you want to drive capabilities explicitly without relying on stream metadata:
 *
 * @example
 * const drmEngine = new DRMEngine(videoElement);
 * drmEngine.onMediaKeys = () => console.log('DRM ready on', drmEngine.keySystem);
 * drmEngine.onError = error => console.error('DRM error', error);
 *
 * drmEngine.start({
 *     contentProtection: {
 *         'com.widevine.alpha': {
 *             license: 'https://widevine.example/getLicense',
 *             configurations: Connect.createMediaKeySystemConfigurations({
 *                 audioContentTypes: ['audio/mp4; codecs="mp4a.40.2"'],
 *                 videoContentTypes: ['video/mp4; codecs="avc1.640028"']
 *             })
 *         }
 *     }
 * });
 *
 * // later
 * await drmEngine.stop();
 */
export class DRMEngine extends DRMConfig {
    static MEDIA_KEYS_TIMEOUT: number = 8000;
    static STOP_TIMEOUT: number = 5000;
    /**
     * Event fired on {@link MediaBufferError}
     * @event
     */
    onError(error: DRMEngineError) {
        this.log(error).error();
    }
    onKeyStatusChanged(keyId: string, status: MediaKeyStatus) {
        const tracks = this._keyIdToTracks.get(keyId) || [];
        this.log(`Key status for ${keyId}: ${status} (tracks: ${tracks.join(', ')})`).info();
    }
    onMediaKeys() {
        this.log('MediaKeys are ready and attached to video element').info();
    }

    /**
     * Get the current key system
     * @returns The current key system
     */
    get keySystem(): string | undefined {
        return this._keySystem;
    }

    get started(): boolean {
        return this._isStarted;
    }

    private _video: HTMLVideoElement;
    private _settings: Map<string, Connect.MediaKeySystem> = new Map();

    // Current Key System
    private _keySystem?: string;
    // Current License server URL and parameters
    private _keySystemConfig?: Connect.MediaKeySystem;

    private _initDataMap: Map<string, SessionHandlers> = new Map();
    private _keyIdToTracks: Map<string, Array<number>> = new Map();
    private _fairplayAssetIds: WeakMap<MediaKeySession, string> = new WeakMap();
    private _certificate?: Uint8Array;
    private _isStarted: boolean = false;
    private _stopping: boolean = false;
    private _encryptedHandler: (event: MediaEncryptedEvent) => void;
    private _metadata?: Metadata;
    private _mediaKeysPromise?: Promise<unknown>;

    constructor(video: HTMLVideoElement) {
        super();
        this._video = video;
        this._encryptedHandler = this._handleEncryptedEvent.bind(this);
        if (video.mediaKeys) {
            throw new Error('MediaKeys already created in the video element');
        }
    }

    /**
     * Start the DRM engine by listening to encrypted events on the video element
     * and setting up MediaKeys when needed.
     *
     * Call this when receiving the event onMetadata or before if you want to force
     * the capabilities used in the MediaKeySystemConfiguration.
     */
    start(params: Connect.Params, metadata?: Metadata): boolean {
        if (!params.contentProtection) {
            this.onError({
                type: 'DRMEngineError',
                name: 'MediaKeys issue',
                detail: 'No content protection field found in the settings'
            });
            return false;
        }
        if (this._isStarted || this._stopping || this._mediaKeysPromise) {
            this.onError({
                type: 'DRMEngineError',
                name: 'MediaKeys issue',
                detail: 'DRMEngine already started or currently stopping'
            });
            return false;
        }
        if (this._video.mediaKeys) {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'MediaKeys already set on video element' });
            return false;
        }

        this._isStarted = true;
        this._stopping = false;
        this._settings.clear();
        for (const keySystem in params.contentProtection) {
            this._settings.set(keySystem, params.contentProtection[keySystem]);
        }

        if (metadata) {
            this._metadata = metadata;
            this._keyIdToTracks.clear();
            for (const [, track] of this._metadata.tracks) {
                if (!track.contentProtection) {
                    continue;
                }
                const keyIds = this._keyIdToTracks.get(track.contentProtection) || [];
                keyIds.push(track.id);
                this._keyIdToTracks.set(track.contentProtection, keyIds);
            }
        }

        this._video.addEventListener('encrypted', this._encryptedHandler);
        return true;
    }

    /**
     * Stop the DRM engine by releasing all resources and detaching from the video element.
     *
     * @returns a promise that resolves when the DRM engine has released all
     * resources and detached from the video element, or rejects on failure
     */
    stop(error?: DRMEngineError): Promise<unknown> {
        return Util.safePromise(
            DRMEngine.STOP_TIMEOUT,
            new Promise((resolve: (result?: unknown) => void, reject: (reason?: string) => void) => {
                if (!this._isStarted && !this._video.mediaKeys) {
                    this.log('DRMEngine already stopped').info();
                    this._isStarted = false;
                    this._stopping = false;
                    resolve();
                    return;
                }
                this._stopping = true;
                this._metadata = undefined;

                // Remove sessions and event listeners
                const closePromises: Promise<unknown>[] = [];
                this._initDataMap.forEach(sessionHandlers => {
                    const { session, message, keystatuseschange } = sessionHandlers;
                    session.removeEventListener('message', message);
                    session.removeEventListener('keystatuseschange', keystatuseschange);
                    closePromises.push(
                        session.close().catch(err => {
                            this.log('Failed to close session', err).warn();
                        })
                    );
                });
                this._initDataMap.clear();
                this._video.removeEventListener('encrypted', this._encryptedHandler);

                Promise.resolve(this._mediaKeysPromise)
                    .catch(() => undefined)
                    .then(() => Promise.allSettled(closePromises))
                    .then(() => {
                        return this._video.setMediaKeys(null);
                    })
                    .then(() => {
                        this.log('MediaKeys detached from video element').info();
                        resolve();
                    })
                    .catch(err => {
                        this.log('Failed to detach MediaKeys from video element', err).warn();
                        reject(err);
                    })
                    .finally(() => {
                        this._settings.clear();
                        this._keySystem = undefined;
                        this._keySystemConfig = undefined;
                        this._keyIdToTracks.clear();
                        this._fairplayAssetIds = new WeakMap();
                        this._certificate = undefined;
                        this._isStarted = false;
                        this._stopping = false;
                        this._mediaKeysPromise = undefined;
                    });

                if (error) {
                    this.onError(error);
                }
            })
        );
    }

    /**
     * Request the key system access and create the MediaKeys
     */
    private async _requestKeySystemAccess(): Promise<MediaKeySystemAccess> {
        // Build a map of key system => array of configurations.
        const drmConfigMap = new Map<string, MediaKeySystemConfiguration[]>();
        for (const [keySystem, keySystemConfig] of this._settings.entries()) {
            const configurations = this.buildKeySystemConfigurations(keySystemConfig, this._metadata);
            drmConfigMap.set(keySystem, configurations);
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
                    const certificateConfig = DRMConfig.normalizeCertificate(this._keySystemConfig.certificate);
                    if (certificateConfig.url) {
                        await fetch(certificateConfig.url, {
                            headers: certificateConfig.headers
                        })
                            .then(response => response.arrayBuffer())
                            .then(certificate => {
                                this._certificate = new Uint8Array(certificate);
                                this.log(`${keySystem} certificate received, size ${this._certificate.byteLength}`).info();
                            });
                    } else if (certificateConfig.data) {
                        this.log(`${keySystem} certificate loaded from settings`).info();
                        this._certificate = certificateConfig.data;
                    } else {
                        this.log(`${keySystem} certificate settings ignored because neither url nor data is provided`).warn();
                    }
                }

                return keySystemAccess;
            } catch (err) {
                this.log(`Key system ${keySystem} not supported with any provided configuration`).info();
            }
        }
        throw new Error('No supported key system found');
    }

    private _setupMediaKeys(): Promise<unknown> {
        // Already set up, just return
        if (this._video.mediaKeys) {
            return Promise.resolve();
        }
        // If a setup is already in progress, return the existing promise
        if (this._mediaKeysPromise) {
            return this._mediaKeysPromise;
        }

        this._mediaKeysPromise = Util.safePromise(
            DRMEngine.MEDIA_KEYS_TIMEOUT,
            new Promise((resolve: (result?: unknown) => void, reject: (reason?: string) => void) => {
                if (this._stopping || !this._isStarted) {
                    resolve();
                    return;
                }

                this._requestKeySystemAccess()
                    .then(keySystemAccess => keySystemAccess.createMediaKeys())
                    .then(createdMediaKeys => {
                        if (this._stopping || !this._isStarted) {
                            resolve();
                            return;
                        }
                        if (this._certificate) {
                            createdMediaKeys.setServerCertificate(this._certificate as Uint8Array<ArrayBuffer>);
                        }
                        this._video
                            .setMediaKeys(createdMediaKeys)
                            .then(() => {
                                if (this._stopping || !this._isStarted) {
                                    this._video
                                        .setMediaKeys(null)
                                        .catch(() => undefined)
                                        .finally(() => resolve());
                                    return;
                                }
                                this.log('MediaKeys set on video element').info();
                                this.onMediaKeys();
                                resolve();
                            })
                            .catch(err => {
                                reject(err);
                            });
                    })
                    .catch(err => {
                        reject(err);
                    })
                    .finally(() => {
                        if (!this._stopping) {
                            this._mediaKeysPromise = undefined;
                        }
                    });
            })
        );
        return this._mediaKeysPromise;
    }

    private async _handleEncryptedEvent(event: MediaEncryptedEvent) {
        if (this._stopping || !this._isStarted) {
            this.log('Ignoring encrypted event because DRMEngine is stopping').warn();
            return;
        }
        if (!this._video.mediaKeys) {
            try {
                await this._setupMediaKeys();
            } catch (_) {
                if (!this._stopping) {
                    this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'MediaKeys not supported' });
                }
                return;
            }
        }

        if (!this._video.mediaKeys) {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'Failed to set up MediaKeys' });
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
        const sessionHandler: SessionHandlers = {
            session,
            message: (e: MediaKeyMessageEvent) => this._handleMessage(e, session),
            keystatuseschange: (e: Event) => this._handleKeyStatusesChange(e, session)
        };
        this._initDataMap.set(initDataString, sessionHandler);

        session.addEventListener('message', sessionHandler.message);
        session.addEventListener('keystatuseschange', sessionHandler.keystatuseschange);
        if (this._keySystem?.startsWith('com.apple.fps')) {
            const fairplayAssetId = this._extractAssetIdFromInitData(event.initDataType, byteArray);
            if (fairplayAssetId) {
                this._fairplayAssetIds.set(session, fairplayAssetId);
                this.log(`FairPlay assetid selected: ${fairplayAssetId}`).debug();
            }
        }

        session.generateRequest(event.initDataType, byteArray).catch(err => {
            this.onError({ type: 'DRMEngineError', name: 'MediaKeys issue', detail: 'generateRequest failed: ' + err });
        });
    }

    private _handleMessage(event: MediaKeyMessageEvent, session: MediaKeySession) {
        if (!this._isStarted) {
            this.log('Ignoring DRM message because DRMEngine is stopped').warn();
            return;
        }
        this.log(`Handle message type ${event.messageType} of size ${event.message.byteLength}`).info();
        if (!this._keySystemConfig) {
            this.log('No key system configuration set').info();
            return;
        }

        let licenseRequestConfig =
            typeof this._keySystemConfig === 'string' ? this._keySystemConfig : this._keySystemConfig.license;
        if (!licenseRequestConfig) {
            this.log('No license configuration set').info();
            return;
        }
        licenseRequestConfig = DRMConfig.normalizeLicense(licenseRequestConfig);
        const licenseServerUrl = licenseRequestConfig.url;
        let licenseRequestUrl = licenseServerUrl;
        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream'
        };
        Object.assign(headers, licenseRequestConfig.headers);

        // The "message" is the payload from the CDM to send to the license server
        let requestBody: ArrayBuffer | string = event.message;
        // Handle PlayReady specific message transformation
        if (this._keySystem === 'com.microsoft.playready') {
            // Parse the PlayReady message to extract headers and body
            const { headers: playReadyHeaders, body } = DRMEngine._parsePlayReadyMessage(requestBody as ArrayBuffer);
            Object.assign(headers, playReadyHeaders);
            requestBody = body;
        }
        if (this._keySystem?.startsWith('com.apple.fps')) {
            const fairplayAssetId = this._fairplayAssetIds.get(session);
            if (fairplayAssetId) {
                try {
                    const url = new URL(licenseServerUrl);
                    url.searchParams.set('assetid', fairplayAssetId);
                    licenseRequestUrl = url.toString();
                } catch (err) {
                    this.log('Failed to append assetid to license server URL, using original URL').warn();
                }
            } else {
                this.log('FairPlay message received but no asset ID found').warn();
            }
        }

        this.log('License request headers:', headers).debug();
        this.log('License request body:', requestBody).debug();

        // Use fetch or XHR to POST the requestBody to the license server
        this.log(`Sending license request to ${licenseRequestUrl}`).info();
        fetch(licenseRequestUrl, {
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
                if (!this._isStarted) {
                    this.log('Ignoring license response because DRMEngine is stopped').warn();
                    return;
                }
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
        // Decode UTF-16LE without spreading the full payload into function arguments.
        const messageString = new TextDecoder('utf-16le').decode(message);

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

    private _extractAssetIdFromInitData(initDataType: string, initData: Uint8Array): string | undefined {
        if (initDataType !== 'sinf') {
            return undefined;
        }
        const sinfPayloads = this._extractSinfPayloads(initData);
        for (const sinfPayload of sinfPayloads) {
            const encryption = CMAFReader.parseSinfTrack(sinfPayload);
            this.log('Parsed sinf payload, found encryption:', encryption).debug();
            if (!encryption?.kid) {
                continue;
            }
            const kidHex = Array.from(encryption.kid)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            return DRMEngine._normalizeKeyId(kidHex);
        }
        return undefined;
    }

    private _extractSinfPayloads(initData: Uint8Array): Uint8Array[] {
        const payloads: Uint8Array[] = [];
        try {
            const parsed = JSON.parse(new TextDecoder().decode(initData));
            if (!Array.isArray(parsed?.sinf)) {
                this.log('No sinf array found in initData JSON').warn();
                return [initData];
            }
            for (const entry of parsed.sinf) {
                if (typeof entry !== 'string' || entry.length === 0) {
                    continue;
                }
                try {
                    this.log('Trying to parse sinf entry as base64 :', entry).debug();
                    payloads.push(Uint8Array.from(atob(entry), c => c.charCodeAt(0) || 0));
                } catch (error) {
                    this.log('Invalid base64 entry in sinf initData JSON, error:', error).warn();
                }
            }
        } catch (error) {
            this.log('initData was not a JSON wrapper, using raw payload only, error:', error).warn();
            return [initData];
        }
        if (payloads.length === 0) {
            this.log('No valid sinf payloads found in initData JSON, using raw payload only').warn();
            return [initData];
        }
        return payloads;
    }

    /**
     * Convert various key ID formats (base64, hex with or without dashes, URN with or without braces)
     * to a normalized UUID string format (8-4-4-4-12 lowercase hex).
     * @returns the normalized key ID string, or the original string if it cannot be parsed as a known format
     */
    private static _normalizeKeyId(raw: string): string {
        let keyId = raw.trim().toLowerCase();
        // Normalize common UUID decorations (URN prefix and surrounding braces).
        keyId = keyId.replace(/^urn:uuid:/, '').replace(/[{}]/g, '');

        // Already a canonical UUID string (8-4-4-4-12).
        const uuidMatch = keyId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        if (uuidMatch) {
            return keyId;
        }

        // 32-char hex KID without dashes -> convert to UUID format.
        const hexMatch = keyId.match(/^[0-9a-f]{32}$/);
        if (hexMatch) {
            return `${keyId.slice(0, 8)}-${keyId.slice(8, 12)}-${keyId.slice(12, 16)}-${keyId.slice(16, 20)}-${keyId.slice(20)}`;
        }

        // Try base64/base64url-encoded 16-byte KID -> decode and convert to UUID format.
        const padded = keyId
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(keyId.length / 4) * 4, '=');
        try {
            const binary = atob(padded);
            if (binary.length === 16) {
                const hex = Array.from(binary)
                    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
                    .join('');
                return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            }
        } catch (_) {}

        // Unknown format: return a normalized lowercase string as-is.
        return keyId;
    }
}
