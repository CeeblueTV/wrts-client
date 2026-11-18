/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

import { EventEmitter } from '@ceeblue/web-utils';

// The IMA SDK is loaded at runtime from Google and never bundled, its `google.ima` namespace stays untyped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IMA = any;

export type AdsEngineError =
    /**
     * The IMA SDK cannot be loaded, usually blocked by an ad blocker or the network
     */
    | { type: 'AdsEngineError'; name: 'SDK unavailable'; detail: string }
    /**
     * No ad started, or the playing ad made no progress, within the timeout
     */
    | { type: 'AdsEngineError'; name: 'Ad timeout' }
    /**
     * Error reported by the IMA SDK with its error code, an ad tag without ad to serve is one of them
     */
    | { type: 'AdsEngineError'; name: 'Ad error'; code?: number; detail: string };

/**
 * AdsEngine plays a pre-roll ad, video or audio, with the [Google IMA HTML5 SDK](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side)
 * before the stream starts.
 *
 * It is independent of {@link Player}: play the ad first, then start the player from {@link onEnd}. The ad must end
 * before {@link Player.start}, which takes over the video element.
 *
 * An ad never prevents the content: {@link onEnd} fires exactly once per {@link start}, with an error when no ad
 * could be played.
 *
 * The SDK script is loaded from Google when the engine is built. Build the engine early, and call {@link start} from
 * a user gesture (a click) to allow an ad with sound.
 *
 * @example
 * const ads = new AdsEngine(videoElement, adContainerElement);
 * ads.onEnd = error => player.start({ endPoint });
 * playButton.onclick = () => ads.start({ adTagUrl: 'https://pubads.g.doubleclick.net/gampad/ads?...' });
 */
export class AdsEngine extends EventEmitter {
    /**
     * URL of the IMA SDK
     */
    static SDK_URL: string = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';
    /**
     * Default delay in milliseconds to get an ad started, or to get progress from the playing ad
     */
    static TIMEOUT: number = 8000;

    /**
     * Loads the IMA SDK once for the page and returns its `google.ima` namespace,
     * useful to change `google.ima.settings` (locale, VPAID mode...) before the first {@link start}.
     */
    static load(): Promise<IMA> {
        if (!AdsEngine._sdk) {
            AdsEngine._sdk = new Promise((resolve, reject) => {
                const ima = () => (window as IMA).google?.ima;
                if (ima()) {
                    return resolve(ima());
                }
                const script = document.createElement('script');
                script.src = AdsEngine.SDK_URL;
                script.async = true;
                script.onload = () => (ima() ? resolve(ima()) : reject(Error('google.ima is missing')));
                script.onerror = () => {
                    script.remove();
                    AdsEngine._sdk = undefined; // allows a retry
                    reject(Error('Cannot load ' + AdsEngine.SDK_URL));
                };
                document.head.appendChild(script);
            });
        }
        return AdsEngine._sdk;
    }
    private static _sdk?: Promise<IMA>;

    /**
     * Event fired when the ad break is over, successfully or not: start the content.
     * Fired exactly once per {@link start}, and not fired by {@link stop}.
     * @param error why no ad was played, or why the ad was interrupted
     * @event
     */
    onEnd(error?: AdsEngineError) {
        if (error) {
            this.log('onEnd', error).warn();
        } else {
            this.log('onEnd').info();
        }
    }

    /**
     * Event fired when an ad starts playing
     * @param duration duration of the ad in seconds
     * @param audio true for an audio ad, which has no display: the SDK shows no skip button for it, see {@link skippable}
     * @event
     */
    onAdStart(duration: number, audio: boolean) {
        this.log(`${audio ? 'Audio' : 'Video'} ad starts (${duration}s)`).info();
    }

    /**
     * Event fired while the ad plays
     * @param time current time of the ad in seconds
     * @param duration duration of the ad in seconds
     * @event
     */
    onAdProgress(time: number, duration: number) {}

    /**
     * Event fired when the ad is paused, by {@link paused} or by a click on the ad
     * @event
     */
    onAdPause() {
        this.log('Ad paused').info();
    }

    /**
     * Event fired when the ad resumes
     * @event
     */
    onAdResume() {
        this.log('Ad resumed').info();
    }

    /**
     * Returns true between {@link start} and {@link onEnd} or {@link stop}
     */
    get running(): boolean {
        return this._controller ? true : false;
    }

    /**
     * Returns true when the ad is paused
     */
    get paused(): boolean {
        return this._paused;
    }

    /**
     * Pauses or resumes the ad
     */
    set paused(value: boolean) {
        if (value) {
            this._manager?.pause();
        } else {
            this._manager?.resume();
        }
    }

    /**
     * Volume of the ad, from 0 to 1
     */
    get volume(): number {
        return this._manager ? this._manager.getVolume() : 0;
    }

    /**
     * Sets the volume of the ad, from 0 to 1
     */
    set volume(value: number) {
        this._manager?.setVolume(value);
    }

    /**
     * Returns true when the ad can be skipped now with {@link skip}.
     * The SDK displays its own skip button on a video ad, but none on an audio ad.
     */
    get skippable(): boolean {
        return this._manager ? this._manager.getAdSkippableState() : false;
    }

    private _ima?: IMA;
    private _displayContainer?: IMA;
    private _loader?: IMA;
    private _manager?: IMA;
    private _controller?: AbortController;
    private _resizeObserver?: ResizeObserver;
    private _timer?: NodeJS.Timeout;
    private _timeout: number = AdsEngine.TIMEOUT;
    private _paused: boolean = false;

    /**
     * Constructs a new AdsEngine and starts loading the IMA SDK
     *
     * @param _video the element which will play the content, a `<video>` with the `playsinline` attribute, or an `<audio>`
     * @param _container the element where the ad is displayed, over the video. For audio ads only it can be hidden
     * (`display: none`) but must stay in the document.
     */
    constructor(
        private _video: HTMLMediaElement,
        private _container: HTMLElement
    ) {
        super();
        AdsEngine.load().then(
            ima => (this._ima = ima),
            () => {} // reported by start()
        );
    }

    /**
     * Requests and plays the pre-roll ad, {@link onEnd} fires when the content can start.
     *
     * Call it from a user gesture (a click) to allow an ad with sound, mobile browsers require it.
     *
     * @param params.adTagUrl URL of the ad tag, a VAST response with a pre-roll
     * @param params.timeout delay in milliseconds to get an ad started, or to get progress from the playing ad,
     * see {@link AdsEngine.TIMEOUT} for its default value
     * @param params.autoplay set it to true when the call does not come from a user gesture, to request only ads
     * allowed to autoplay. By default it is detected from `navigator.userActivation`.
     */
    start(params: { adTagUrl: string; timeout?: number; autoplay?: boolean }) {
        this.stop();
        const controller = (this._controller = new AbortController());
        this._timeout = Number(params.timeout) || AdsEngine.TIMEOUT;
        this._watch();
        if (this._ima) {
            // synchronous, to stay in the user gesture
            return this._request(params);
        }
        AdsEngine.load().then(
            ima => {
                this._ima = ima;
                if (controller === this._controller) {
                    this._request(params);
                }
            },
            error => {
                if (controller === this._controller) {
                    this._end({ type: 'AdsEngineError', name: 'SDK unavailable', detail: error.message });
                }
            }
        );
    }

    /**
     * Stops the ad break without firing {@link onEnd}
     */
    stop() {
        if (!this._controller) {
            return;
        }
        this._controller.abort();
        this._controller = undefined;
        clearTimeout(this._timer);
        this._resizeObserver?.disconnect();
        this._resizeObserver = undefined;
        this._paused = false;
        const manager = this._manager;
        this._manager = undefined;
        try {
            // Nothing from the SDK must touch the video element anymore, the content takes it over
            manager?.destroy();
            // Allows a next request on the same loader
            this._loader?.contentComplete();
        } catch (_) {}
    }

    /**
     * Skips the ad when {@link skippable} is true.
     * It has no effect when the SDK displays its own skip button, which is the case for a video ad.
     */
    skip() {
        this._manager?.skip();
    }

    private _end(error?: AdsEngineError) {
        if (!this._controller) {
            return;
        }
        this.stop();
        this.onEnd(error);
    }

    /**
     * Arms the timeout after `adTime` seconds of ad to play, or disarms it when this time is unknown (negative)
     */
    private _watch(adTime: number = 0) {
        clearTimeout(this._timer);
        if (adTime >= 0) {
            this._timer = setTimeout(
                () => this._end({ type: 'AdsEngineError', name: 'Ad timeout' }),
                adTime * 1000 + this._timeout
            );
        }
    }

    private _size(): { width: number; height: number } {
        // The container has no size when it is hidden for audio ads
        return {
            width: this._container.clientWidth || this._video.clientWidth || 640,
            height: this._container.clientHeight || this._video.clientHeight || 360
        };
    }

    private _request(params: { adTagUrl: string; autoplay?: boolean }) {
        const ima = this._ima;
        try {
            if (!this._loader) {
                // Plays the ad in the SDK's own element on iPhone too: the content element stays untouched,
                // and skippable ads work
                ima.settings.setDisableCustomPlaybackForIOS10Plus(true);
                this._displayContainer = new ima.AdDisplayContainer(this._container, this._video);
                const loader = new ima.AdsLoader(this._displayContainer);
                loader.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (event: IMA) =>
                    this._onAdsManager(event)
                );
                loader.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, (event: IMA) => this._onAdError(event));
                this._loader = loader;
            }
            // Must run in the user gesture on mobile, as well as load() which allows the content to play with sound
            // after the ad, when the gesture is over
            this._displayContainer.initialize();
            if (!this._video.currentSrc) {
                this._video.load();
            }

            const request = new ima.AdsRequest();
            const { width, height } = this._size();
            request.adTagUrl = params.adTagUrl;
            request.linearAdSlotWidth = request.nonLinearAdSlotWidth = width;
            request.linearAdSlotHeight = request.nonLinearAdSlotHeight = height;
            // Tell the truth to the ad server, it selects the ads allowed to play this way
            request.setAdWillAutoPlay(params.autoplay ?? navigator.userActivation?.isActive === false);
            request.setAdWillPlayMuted(this._muted());
            // The controller identifies this request in the loader events
            this._loader.requestAds(request, this._controller);
        } catch (error) {
            this._end({ type: 'AdsEngineError', name: 'Ad error', detail: String(error) });
        }
    }

    private _muted(): boolean {
        return this._video.muted || !this._video.volume;
    }

    private _onAdsManager(event: IMA) {
        if (event.getUserRequestContext() !== this._controller) {
            return; // request of a previous start
        }
        const ima = this._ima;
        const Type = ima.AdEvent.Type;
        try {
            const manager = (this._manager = event.getAdsManager(this._video));
            const on = (type: string, listener: (event: IMA) => void) =>
                manager.addEventListener(type, (event: IMA) => {
                    if (manager === this._manager) {
                        listener(event);
                    }
                });
            on(ima.AdErrorEvent.Type.AD_ERROR, event => this._onAdError(event));
            // One of them ends the break: a playlist without pre-roll never requests the content to resume
            on(Type.CONTENT_RESUME_REQUESTED, () => this._end());
            on(Type.ALL_ADS_COMPLETED, () => this._end());
            on(Type.LOADED, event => {
                if (!event.getAd().isLinear()) {
                    // An overlay ad is displayed over a playing content, which is not started yet
                    this.log('Non-linear ad ignored').warn();
                    this._end();
                }
            });
            on(Type.STARTED, event => {
                this._paused = false;
                const ad = event.getAd();
                // The ad cannot last longer than its duration, a tighter timeout comes with its progress
                this._watch(ad.getDuration());
                this.onAdStart(ad.getDuration(), String(ad.getContentType()).startsWith('audio/'));
            });
            on(Type.AD_PROGRESS, event => {
                if (!this._paused) {
                    this._watch();
                }
                const { currentTime, duration } = event.getAdData();
                this.onAdProgress(currentTime, duration);
            });
            on(Type.PAUSED, () => {
                this._paused = true;
                clearTimeout(this._timer);
                this.onAdPause();
            });
            on(Type.RESUMED, () => {
                this._paused = false;
                this._watch(manager.getRemainingTime());
                this.onAdResume();
            });

            const resize = () => {
                const { width, height } = this._size();
                manager.resize(width, height, document.fullscreenElement ? ima.ViewMode.FULLSCREEN : ima.ViewMode.NORMAL);
            };
            if (typeof ResizeObserver !== 'undefined') {
                this._resizeObserver = new ResizeObserver(resize);
                this._resizeObserver.observe(this._container);
            }

            const cuePoints: Array<number> = manager.getCuePoints();
            if (cuePoints.length && !cuePoints.includes(0)) {
                // A playlist without pre-roll, its other ad breaks are not played
                return this._end();
            }

            const { width, height } = this._size();
            manager.init(width, height, ima.ViewMode.NORMAL);
            manager.setVolume(this._muted() ? 0 : this._video.volume);
            manager.start();
        } catch (error) {
            this._end({ type: 'AdsEngineError', name: 'Ad error', detail: String(error) });
        }
    }

    private _onAdError(event: IMA) {
        const context = event.getUserRequestContext();
        if (context && context !== this._controller) {
            return; // request of a previous start
        }
        const error = event.getError();
        this._end({ type: 'AdsEngineError', name: 'Ad error', code: error.getErrorCode(), detail: error.getMessage() });
    }
}
