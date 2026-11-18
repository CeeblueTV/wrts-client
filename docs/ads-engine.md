# Plan: IMA pre-roll ads (`AdsEngine`)

Status: implemented on branch `feat/ads-engine` (off `dev`), tested on Chrome desktop only. See
[Changes from the plan](#changes-from-the-plan) and [Tested](#tested).

## Goal

A first minimal, production-ready integration of the [Google IMA HTML5 SDK]: one video or audio **pre-roll** played before a
WebRTS live stream starts. Mid-rolls, post-rolls and server-side ad insertion are out of scope.

## Decision: the ad runs before `player.start()`

A standalone `AdsEngine` plays the pre-roll, then the application starts the `Player`. `Player` is not modified.

- `Player.start()` takes over the `<video>` element at once: it pauses it, sets `src` to the MSE blob URL and arms the start
  timeout (14s by default).
- On iPhone IMA reuses the content `<video>` for the ad by default. A `src` swap on a running player closes the MediaSource,
  and `onsourceclose` stops the player with `Playback error`.
- The stream is live: media buffered during the ad is stale. Starting after the ad joins at the live edge, at the cost of the
  normal start-up time once the ad ends.

## API

New file `src/ads/AdsEngine.ts`, exported from `index.ts`. Same shape as `MediaKeysEngine`: standalone, overridable `log`
and event methods.

```ts
const ads = new AdsEngine(video, adContainer); // injects ima3.js right away
ads.onEnd = (error?: AdsEngineError) => player.start({ endPoint }); // fired exactly once per start()
playButton.onclick = () => ads.start({ adTagUrl }); // must be called inside the user gesture
```

| Member                                         | Purpose                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `start({ adTagUrl, timeout?, autoplay? })`     | Request and play the pre-roll. `timeout` defaults to 8000 ms            |
| `stop()`                                       | Abort the ad, without firing `onEnd`                                    |
| `AdsEngine.load()`                             | Load the SDK and return `google.ima`, to change its settings            |
| `running`                                      | True between `start()` and `onEnd`                                      |
| `paused`, `volume`                             | Control the ad while it plays                                           |
| `skip()`, `skippable`                          | Needed for audio ads, where IMA renders no skip button                  |
| `onAdStart(duration, audio)`, `onAdProgress()` | For the page's own ad UI                                                |
| `onAdPause()`, `onAdResume()`                  | A click on the ad pauses it                                             |
| `onEnd(error?)`                                | Ad break over, successfully or not: start the content                   |

`AdsEngineError`, in the style of the other error unions:

- `{ type: 'AdsEngineError'; name: 'SDK unavailable'; detail }`: script blocked or failed to load
- `{ type: 'AdsEngineError'; name: 'Ad timeout' }`
- `{ type: 'AdsEngineError'; name: 'Ad error'; code: number; detail: string }`: IMA loader or manager error

The ad tag is not added to `Connect.Params`: that type belongs to `@ceeblue/web-utils`, and ads are not a connection concern.

## Requirements

1. **Fail open, exactly once.** `onEnd` fires on the first of: `CONTENT_RESUME_REQUESTED`, `ALL_ADS_COMPLETED`, an
   `AD_ERROR` from the loader or the manager, a script load failure, or our own timeout. The engine then calls
   `adsManager.destroy()`, so nothing touches the element once MSE owns it. An ad failure never prevents the content.
2. **Keep the user gesture.** `adDisplayContainer.initialize()` is called synchronously in `start()`, before any `await`.
   This is why the SDK script is injected in the constructor and not on click.
3. **Report autoplay truthfully.** `setAdWillAutoPlay` and `setAdWillPlayMuted` are set from the real state of the element
   (`video.muted`, and whether `start()` runs in a user gesture).
4. **iPhone.** Requires `playsinline` on the `<video>`. The engine sets `setDisableCustomPlaybackForIOS10Plus(true)`, so IMA
   uses its own ad player and skippable ads work.
5. **The SDK is not bundled.** `ima3.js` is injected from Google's host at runtime, once per page. No new dependency.
   `google.ima` types stay internal (minimal local declarations), so they do not leak into `wrts-client.d.ts`.
6. **Lifecycle.** One `AdsLoader` per engine. A `ResizeObserver` on the container drives `adsManager.resize`.
   `contentComplete()` is called before a new request. `stop()` during an ad is clean and repeatable.

## Video and audio

One code path; the difference is the ad tag and the page's UI.

|                | Video pre-roll              | Audio pre-roll                                      |
| -------------- | --------------------------- | --------------------------------------------------- |
| Ad tag         | `ad_type=video`, or unset   | `ad_type=audio` or `audio_video`, with `vpmute=0`   |
| Container      | Overlay on the video        | May be hidden, but must stay in the DOM             |
| Skip button    | Rendered by IMA             | Built by the page with `skippable` / `skip()`       |
| Muted autoplay | Works                       | Not usable: needs click-to-play                     |

## `examples/player.html`

- Optional "Ad tag URL" field, next to the DRM certificate field, also read from the query string.
- An ad container `<div>` inside `.player`: `fullscreen()` targets that element, so the ad stays visible in fullscreen. On
  iOS Safari only the `<video>` itself can go fullscreen, so the overlay is not shown there.
- The container has `pointer-events: none` when no ad is showing, so it does not swallow the `.player-ctrls` handlers.
- `play()` calls `ads.start()` when a tag is set, and starts the player from `onEnd`. A failed ad is logged, not shown as a
  stream error.
- A skip button for audio ads.

## Steps

1. `src/ads/AdsEngine.ts`: script loader, the engine, minimal IMA type declarations. Around 200-250 lines.
2. Export `AdsEngine` and `AdsEngineError` from `index.ts`.
3. Wire `examples/player.html`.
4. `README.md`: an "Ads" section (usage, audio, iPhone, consent) and the table-of-contents link.
5. `npm install`, then `npm run lint` and `npm run build` (not runnable yet: `node_modules` is absent).
6. Manual test with Google's sample ad tags: Chrome and Firefox desktop, Android Chrome, iPhone Safari, each with sound
   on, muted, an ad blocker, an invalid tag, and `stop()` during the ad.

## Changes from the plan

- `stop()` does not fire `onEnd`: `onEnd` only means "start the content now", so the page needs no flag to tell an abort
  from an ended ad.
- No `locale` parameter. `AdsEngine.load()` returns the `google.ima` namespace to change any SDK setting instead.
- `start()` takes an `autoplay` parameter, detected from `navigator.userActivation` by default.
- `onAdStart(duration, audio)` tells an audio ad from a video one, and `onAdPause` / `onAdResume` were added: a click on
  the ad pauses it, the page needs to offer a resume.
- After an ad has started, the timeout is the ad duration plus `timeout`, tightened to `timeout` without progress once
  the ad reports its progress (`AD_PROGRESS`). It is suspended while paused.
- A playlist without pre-roll (`getCuePoints()` without 0) ends the break at once.
- `examples/player.html` does not replay the ad when the content failed to play after it: the next click starts the
  content, inside a user gesture.
- `start()` also calls `video.load()` in the user gesture, as the IMA guide does, to let the content play with sound once
  the ad is over. Not verified on iOS.
- A non-linear (overlay) ad ends the break at once: there is no playing content to display it over.

## Tested

On Chrome desktop, with `examples/player.html?stream=...&adTag=<encoded ad tag>`:

| Case                                                        | Result                                             |
| ----------------------------------------------------------- | -------------------------------------------------- |
| COPE test tag, click on play                                | 20s video ad, then `Ad ended` and `Player.onStart` |
| Same tag with `ad_type=audio` (no audio ad booked)          | `Ad error`, code 303                               |
| Unreachable ad tag                                          | `Ad error`, code 1005                              |
| `timeout: 1`                                                | `Ad timeout`                                       |
| Pause, then `stop()` during an ad (Google sample tag)       | paused, stopped, no `onEnd`                        |
| New `start()` on the same engine after the `stop()`         | works                                              |
| Unreachable SDK URL                                         | `SDK unavailable`, at once                         |
| Google sample: non-linear ad                                | ends at once, no ad                                |
| Google sample: VMAP post-roll only                          | ends at once, no ad                                |
| Google sample: VMAP pre-roll only, and pre + mid + post     | pre-roll plays (10s), then ends                    |
| Google sample: skippable video ad                           | `skippable` true after 5s; `skip()` has no effect  |

`skip()` on a video ad is a documented no-op: it only works when the SDK renders no skip button, which is the audio case.

Ad to content handover, with a live stream and Google's 10s sample ad: the content starts playing unmuted 362 ms (TTFF)
after the ad ends, with no new click, and the ad container is inert again.

Not tested: a real audio ad and its `skip()`, a real ad blocker, Firefox, Safari, Android, iPhone, fullscreen.

## Open points

- **Self-hosting `ima3.js`.** Assumed forbidden by Google, not confirmed in the pages read. The plan loads it from Google
  regardless.
- **VMAP / ad rules.** The tag is treated as a single pre-roll. Mid-rolls in a returned playlist are dropped when the manager
  is destroyed. Mid-rolls on a live stream need their own design.
- **Consent (TCF / CMP).** The embedding page's job. The engine only passes settings through.
- **Licence.** The AGPL library would load a proprietary SDK at runtime. It is opt-in and not bundled, but needs an explicit
  yes.
- **Join latency.** The player could connect during the last seconds of the ad to shorten the gap. Not in the first version.

## References

- [Get started](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side)
- [Audio ads](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/audio)
- [Autoplay](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/autoplay)
- [Skippable ads and iPhone](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/skippable-ads)
- [Ad tag parameters (`ad_type`)](https://support.google.com/admanager/answer/10678356)

[Google IMA HTML5 SDK]: https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side
