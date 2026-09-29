# WebRTS internals

Web Real-Time Streaming (WebRTS, also shortened to WRTS in endpoint names) is a live-streaming architecture designed to keep web playback close to the live edge. It is not a single transport or container format, and it is not WebRTC. WebRTS coordinates media delivery, browser playback, buffer control, rendition selection, and optional frame skipping as one feedback loop.

The main design choice is to prioritize **freshness and continuous playback** over perfect media completeness. When partial reliability is enabled, temporarily reducing quality or discarding obsolete video is preferable to accumulating latency or waiting indefinitely for data that is no longer useful.

## 1. Architecture and terminology

The client separates media acquisition from browser playback:

```text
Origin / CDN
    │  manifest, sequences, and timed media
    ▼
Source ─────────► Reader ─────────► Player / MediaPlayback ─────────► MSE ─────────► <video>
  ▲                                      │
  └──── buffer state, stalls,             └──── currentTime, dropped frames,
        playback constraints                    buffered ranges
```

- [`Source`](./src/sources/Source.ts) implementations acquire media, select tracks, measure received throughput, and expose decoded samples.
- [`HTTPAdaptiveSource`](./src/sources/HTTPAdaptiveSource.ts) implements the default sequence-based WebRTS delivery and the multi-bitrate rendition algorithm.
- [`Player`](./src/Player.ts) appends samples through Media Source Extensions (MSE), observes the browser's effective playback, and classifies the buffer.
- [`IPlaying`](./src/sources/IPlaying.ts) is the feedback contract between the source and the player.

Important terms used throughout the implementation:

| Term | Meaning |
|---|---|
| **Live edge** | The newest media time currently known to the client. |
| **Sequence** | A numbered, independently requestable interval of media. The current sequence may still be open and growing at the origin. |
| **Rendition** | One encoded version of a track, with its own bitrate, resolution, frame rate, and codec information. |
| **MBR** | The code name for automatic multi-bitrate rendition selection. It is the WebRTS adaptive-bitrate control loop. |
| **Partial reliability** | Permission to cancel or skip obsolete media in order to preserve low latency. |
| **RTS** | A compact media container supported by WebRTS. WebRTS can also carry CMAF; RTS is not the streaming architecture itself. |

## 2. Transport and delivery model

WebRTS is transport-agnostic at the `Source` boundary. The default `HTTPAdaptiveSource` uses ordinary Fetch requests: it first loads an `index.json` manifest, then requests numbered media sequences. This model is CDN-friendly and benefits from HTTP multiplexing when the browser and deployment negotiate HTTP/2 or HTTP/3; the playback algorithm does not depend on a particular HTTP version.

The repository also contains direct HTTP and WebSocket sources. A custom source can be supplied to `Player` without changing the playback controller, although transport-specific features such as sequence skipping and MBR probing remain the responsibility of that source.

The manifest describes:

- the current and first available sequence;
- the estimated live media time;
- the available audio, video, and data tracks;
- rendition bandwidths and video resolutions;
- the URL pattern used to request sequences.

At startup, the HTTP adaptive source can begin a few sequences behind the current sequence when necessary to build the target buffer. It then continuously requests the next sequence. A response for the current live sequence may stream bytes as they are produced, so playback does not have to wait for that sequence to close.

Two response headers have different meanings and must not be confused:

- `Sequence-Duration` is the exact duration of a **completed** sequence. Its absence identifies the current, still-open live sequence.
- `Max-Sequence-Duration` is only an upper bound used to locate possible sequences near the live edge. It is not an estimate of the duration of an open sequence.

## 3. The playback control loop

WebRTS controls latency primarily through the amount of playable media ahead of the playhead:

```text
bufferAmount = max(0, endTime - max(video.currentTime, startTime))
```

The value is expressed in milliseconds and is related to, but not identical to, end-to-end latency. The latter also includes capture, encoding, publication, transport, and browser processing delays.

### 3.1 Buffer states and hysteresis

The player classifies the buffer using three thresholds:

- `bufferLimitLow`, `200ms` by default;
- `bufferLimitMiddle`, the target and midpoint of the active window;
- `bufferLimitHigh`, initially `1000ms` and automatically tuned by default.

The active states are:

| State | Condition and interpretation | Default playback-rate action |
|---|---|---|
| `NONE` | Playback is stopped or has not yet acquired a meaningful buffer state. | None |
| `LOW` | Buffer is at or below `bufferLimitLow`; a stall is becoming likely. | Slow to `0.9x` where supported |
| `OK` | Buffer is inside the acceptable operating region. | Play at `1x` |
| `HIGH` | Buffer is above `bufferLimitHigh`; latency is growing. | Accelerate to `1.1x` |

State transitions use `bufferLimitMiddle` as hysteresis. `LOW` is held until the buffer rises above the middle target, while `HIGH` is held until it falls below the target. This prevents small buffer fluctuations from repeatedly changing state and playback rate.

On startup or after a stall, playback waits until the buffer reaches `bufferLimitMiddle`. `goLive()` also seeks to approximately `endTime - bufferLimitMiddle`, rather than to the absolute end where no decoding headroom would remain.

### 3.2 Automatic buffer window

When `bufferLimitHigh` is left undefined, which is the default, the player measures the observed low-to-high buffer excursion and adapts the high threshold. The goal is to find the smallest window that still absorbs the current network and scheduling jitter:

- instability or a transition to `LOW` can enlarge the window;
- stable observation windows allow it to shrink gradually;
- increases are bounded to avoid abrupt jumps, and decreases move only halfway toward the newly measured target;
- the window never becomes smaller than `200ms`, or `400ms` with `ManagedMediaSource`.

The middle target moves with the high threshold. This makes the latency target adaptive rather than assuming that the same fixed buffer is suitable for every network, browser, and decoder.

### 3.3 Requested rate versus effective speed

`playbackRate` and `playbackSpeed` describe different things:

- `playbackRate` is the rate requested from the `HTMLVideoElement` (`1.0`, `0.9`, `1.1`, and so on).
- `playbackSpeed` is the observed progression of `video.currentTime` relative to wall-clock time. It is averaged over `500ms` to cover multiple `timeupdate` samples while remaining responsive.

A requested rate of `1.0` does not guarantee an effective speed of `1.0`: an overloaded decoder, a rendering problem, or a browser interruption can advance the media clock more slowly. Conversely, short-term measurement noise is expected because `currentTime` is sampled rather than continuously observed.

On platforms without `ManagedMediaSource`, the default rate is `0.9x` in `LOW`, `1x` in `OK`, and `1.1x` in `HIGH`. Slowing in `LOW` gives incoming data more time to rebuild the buffer; accelerating in `HIGH` consumes excess buffer and moves playback toward the live edge.

On Safari environments exposing `ManagedMediaSource`, changing `playbackRate` can itself interrupt playback because of [WebKit bug 163433](https://bugs.webkit.org/show_bug.cgi?id=163433). The player therefore applies hysteresis to the rate too: once increased in `HIGH`, the rate remains elevated through `OK` and returns directly to `1x` only at `LOW`.

## 4. MBR: multi-bitrate rendition selection

MBR is the automatic video-rendition algorithm implemented by `HTTPAdaptiveSource`. Unlike a conventional throughput-only ABR algorithm, it combines network delivery, buffer health, and local playback capability. A connection can be fast enough for a rendition while the device is still unable to decode or render it smoothly.

Renditions are linked from lower to higher declared bandwidth. By default, playback starts on the middle rendition that does not exceed `maximumResolution`. Returning a track from `onMetadata` changes only this initial choice and keeps MBR enabled. Assigning `player.videoTrack` explicitly locks the track and disables MBR; assigning `undefined` enables it again.

### 4.1 Inputs used by MBR

The decision loop uses the following signals:

- `bufferState`, especially transitions to `LOW`;
- a stall or an aborted media request;
- measured receive throughput, including audio, video, data, and container overhead;
- each rendition's declared bandwidth and the active audio bandwidth;
- `maximumResolution`;
- `MediaCapabilities.decodingInfo()`, when available, to identify unsupported or non-smooth renditions;
- `playbackConstraint`, which describes a local decoding or rendering bottleneck.

Receive throughput is smoothed on approximately a GOP-sized window. It is useful for choosing how far to move down, but it is deliberately not sufficient on its own to authorize a move up.

### 4.2 Downshift path

A downshift is considered when at least one of these conditions occurs:

1. the buffer reaches `LOW` without an active upward probe causing the disturbance;
2. a stall or low-buffer recovery aborts a cancelable request;
3. the current rendition has limited browser support;
4. `playbackConstraint` reports why the browser cannot play the current rendition smoothly.

On a new failure, MBR first moves down one rendition. It can then continue downward until the declared video bandwidth plus the active audio bandwidth fits within the measured receive throughput. Consecutive failure handling is damped so that one incident does not blindly step down once per loop iteration. The resolution cap is applied again before the new track is selected.

Downshifts are intentionally fast: when the buffer is already low, waiting for a long bandwidth estimate would increase the probability of a stall.

### 4.3 Safe upshift probing

An upshift is conservative because selecting a rendition first and discovering afterward that it is too expensive would consume the small low-latency buffer.

When playback is at the live edge, the buffer has remained stable long enough, and a compatible higher rendition exists, the source performs a **bandwidth-emulation request**. While downloading the current sequence normally, it requests a byte range from the higher rendition's previous completed sequence. The requested amount approximates:

```text
(higher video bandwidth - current video bandwidth) × Max-Sequence-Duration
```

This adds the missing load needed to emulate the candidate rendition without feeding duplicate media to the decoder. If both normal playback and the probe complete without a low-buffer transition, abort, partial media response, or request failure, the next sequence moves up by one rendition.

Failed probes increase an adaptive retry delay, from a short initial delay up to a bounded maximum. Any buffer-state instability rearms the waiting period. Once the top rendition remains stable, successful observation windows can shorten the delay again. This asymmetric policy—fast down, probed and delayed up—limits oscillation near the available-bandwidth boundary.

### 4.4 `playbackConstraint`

`playbackConstraint` separates **delivery capacity** from **playback capacity**. It is `undefined` while the player is paused, starting, has no active source, or is unconstrained. During normal playback it returns an object whose flags describe whether:

- `playbackSlow` is set because the buffer is above `bufferLimitHigh`, yet `playbackSpeed` is more than 3% below the requested `playbackRate`; or
- `droppedFrame` is set because dropped video frames exceed 3% of the incoming video frame rate.

The effective-speed test is intentionally evaluated only with a high buffer. If little media is available, a slow playhead may simply be a network starvation symptom; with abundant buffered media, the decoder or renderer is the more likely constraint.

When this value is defined, MBR follows the downshift path even if measured network throughput appears sufficient. It therefore handles devices that can download a high-resolution rendition but cannot decode it in real time. `playbackConstraint` is an adaptation signal, not a stall counter and not a replacement for `bufferState`.

## 5. Partial reliability and adaptive frame skipping

Partial reliability is enabled by default for the HTTP adaptive source (`player.reliable === false`). In this mode, media that has become obsolete may be canceled or skipped. Setting `player.reliable = true` preserves every sequence, but a bad network can then produce longer stalls or increasing latency.

The source assigns requests to three classes:

- **reliable** requests must complete;
- **cancelable** requests may be aborted during stall recovery;
- **alterable** video, used at the lowest rendition, may be reduced to a decodable visual update instead of downloading every frame.

The recovery order is deliberate:

1. **Reduce the rendition.** If a lower rendition exists, MBR switches down before sacrificing frames.
2. **Preserve audio and a useful video update.** At the lowest rendition and in `LOW`, a completed sequence with an exact `Sequence-Duration` can be reduced to its first video sample. That sample is extended across the known remaining duration, while the skipped duration is reported in the statistics.
3. **Rejoin the live edge after a stall.** When playback is buffering, no reliable channel is active, and completed sequences exist ahead, the source can skip whole sequences instead of downloading media that is already late.

Before skipping a sequence, the client sends a request to verify that the target exists. This prevents it from skipping past the actual live edge. `Sequence-Duration` is required for frame alteration because only a completed sequence has a known remaining duration. `Max-Sequence-Duration` alone is never used to invent the duration of the open live sequence.

This distinction also handles a late publisher correctly. If the client is already consuming the open sequence, a growing wall-clock delay does not mean that a newer sequence exists. Aborting the current request would not create media that the publisher has not produced.

## 6. How the mechanisms cooperate to enable low latency

The controls are complementary rather than interchangeable:

| Observation | Primary response |
|---|---|
| Buffer reaches `LOW` without an active upshift probe | Slow playback, downshift, and enlarge the automatic buffer window if necessary |
| Buffer reaches `LOW` during an upshift probe | Abort the probe without immediately blaming the current rendition |
| Browser drops frames or cannot maintain the requested rate with a full buffer | Set `playbackConstraint` and downshift for local device capacity |
| Stable live-edge playback with a higher rendition available | Probe the additional bandwidth, then move up one level on success |
| Buffer grows beyond `HIGH` | Accelerate playback to reclaim latency |
| Stall while obsolete completed sequences exist | Abort cancelable work and skip forward in partial-reliability mode |

The result is a layered policy:

1. use a small but adaptive buffer to absorb normal jitter;
2. use playback-rate changes to correct small buffer deviations;
3. use MBR to match sustained network and device capacity;
4. use frame or sequence skipping only when quality reduction is no longer enough to preserve liveness.

Together, this layered policy enables low latency in three ways:

- **It prevents avoidable stalls.** The adaptive buffer absorbs normal jitter, while playback-rate changes and fast MBR downshifts react before the buffer becomes empty. If those measures are not enough, partial reliability avoids waiting for video that is already obsolete.
- **It stays near the live edge.** WebRTS does not build a large fixed safety buffer. It accelerates when excess buffer accumulates and, after a stall, can skip completed sequences rather than replaying increasingly late media.
- **It adapts to real-world conditions.** Network throughput is only one constraint. The client also accounts for browser decoding support, dropped frames, effective playback speed, and platform-specific behavior. It can trade temporary quality or frame completeness for continuous, current playback.

## 7. The RTS container format

RTS is a compact binary framing format for timed audio, video, and data samples. It minimizes repeated metadata and is one possible media container for WebRTS; CMAF (`mp4`) is also supported.

The current reader is implemented in [`RTSReader.ts`](./src/media/reader/RTSReader.ts). Integer fields use unsigned 7-bit variable-length encoding. On byte-stream transports, a packet can be prefixed with its encoded size; message-framed transports such as WebSocket do not need that prefix.

### 7.1 Common header

Every packet begins with an encoded header:

```text
header = encodedTrack << 2 | type
```

- `encodedTrack = trackId + 1` for track packets;
- `encodedTrack = 0` for command packets;
- the low two bits contain `type`.

| `type` | Non-zero track | Command (`encodedTrack = 0`) |
|---|---|---|
| `0` | Timed data | Metadata |
| `1` | Audio | Invalid/reserved |
| `2` | Video | Invalid/reserved |
| `3` | Reserved | Initialize tracks |

### 7.2 Audio and video packets

```text
[packetSize?] [header] [time?] [durationAndFlags] [compositionOffset?]
[custom fields...] [0] [media payload]
```

`time` is present only for the first sample of a track after an initialize-tracks command. Later timestamps are reconstructed as `previous time + previous duration`.

```text
durationAndFlags = duration << 2
                 | hasCompositionOffset << 1
                 | isKeyFrame
```

The optional composition offset represents the difference between decode and presentation order, as required by video containing reordered frames. Custom fields are length-prefixed and terminated by a zero length; currently defined fields carry subsample-encryption information and the sample initialization vector.

### 7.3 Timed data packets

```text
[packetSize?] [header] [timeDelta] [duration]
[custom fields...] [0] [data payload]
```

The first time value is absolute for that track; following values are relative to its previous data timestamp. The payload is arbitrary binary timed data and is not required to be JSON.

### 7.4 Metadata packets

```text
[packetSize?] [header] [JSON metadata payload]
```

Metadata is a command packet with `encodedTrack = 0` and `type = 0`. It describes protocol information and the available tracks and renditions.

### 7.5 Initialize-tracks packets

```text
[packetSize?] [header] [audioTrackId + 1] [videoTrackId + 1]
```

Initialize-tracks is a command packet with `encodedTrack = 0` and `type = 3`. A zero track value means that the corresponding media type is absent. The command resets timestamp reconstruction, so the next packet for each active media track carries an explicit time.
