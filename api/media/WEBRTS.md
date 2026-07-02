# WebRTS Internals Mechanisms

Web Real-Time Streaming (WebRTS) is a transport-agnostic framework designed to enable live streaming over the web with minimal latency. This document examines the internal methods of WebRTS to achieves low-latency playback while adapting to diverse network conditions.


## 1. Transport layer

The WebRTS mechanisms are transport-agnostic, but our current implementation targets HTTP/2 for seamless integration with CDNs and the existing global web infrastructure. By leveraging HTTP/2’s multiplexing capabilities, audio and video segment requests are delivered over a single connection, reducing resource overhead. Now in the near future, we plan to evaluate WebRTS over HTTP/3 (or other QUIC variants) to unlock further performance gains—particularly for long-distance streaming—while preserving broad deployment compatibility.


## 2. Low-Latency Playback & Frame Skipping

The primary goal of the WebRTS client is to maintain playback as close to the live edge as possible, even under poor network conditions. This is achieved through a combination of intelligent buffer management and a strategy we call "adaptive frame skipping".

This logic is primarily handled within the `Player` class (`src/Player.ts`) and the different `Source` implementations (e.g., `src/sources/HTTPAdaptiveSource.ts`).

### The Core Concepts

1.  **Buffer Management**: The player constantly monitors the amount of buffered media in the `HTMLVideoElement`. It defines three buffer states:
    -   **`LOW`**: The buffer is running low (e.g., < 150ms). This indicates network congestion or a delay in receiving data.
    -   **`MIDDLE`**: The buffer is in a healthy state.
    -   **`HIGH`**: The buffer is growing too large (e.g., > 550ms), meaning the client is downloading data faster than it's being played.
    
2.  **Adaptive Bitrate**: When the stream offers multiple quality tracks, the algorithm adapts the selected track based on the playback state.
    -   In the `LOW` state, it chooses a lower-quality track.
    -   If the buffer level rises above the `MIDDLE` threshold, it can switch to a higher-quality track—provided the estimated bandwidth permits it .

3.  **Dynamic Playback Rate**: To gently manage the buffer without noticeable skips, the player slightly adjusts the video's `playbackRate`:
    -   In `LOW` state, `playbackRate` is reduced (e.g., to `0.92x`) to slow down consumption and allow the buffer to refill.
    -   In `HIGH` state, `playbackRate` is increased (e.g., to `1.08x`) to drain the buffer faster and move closer to the live edge.

4.  **Partial Reliability & Frame Skipping**: This is the most critical part of the low-latency strategy. When the player is configured for partial reliability and the network deteriorates while the buffer is under the `LOW` state, it doesn’t wait for every video frame—risking a stall—instead it can **proactively skip individual frames** to preserve audio continuity, or if a stall has already occurred **skip several video segments** to rejoin the live edge.

### How Frame Skipping Works (in `HTTPAdaptiveSource`)

The `HTTPAdaptiveSource` is a pull-based protocol, fetching media in sequences (similar to HLS segments). Here's the frame-skipping process:

1.  **Stall/Low Buffer Detection**: The `Player` notifies the `HTTPAdaptiveSource` when the buffer state becomes `LOW` or when a playback `stall` is detected.

2.  **Abort Current Downloads**: If the `reliable` property is `false`, the source immediately aborts any ongoing video segment downloads. This frees up the network connection instantly.

3.  **Calculate the Delay**: The source calculates the time difference between the current playback time and the live edge (`delay = metadata.liveTime - player.currentTime`).

4.  **Skip Sequences**: If the calculated `delay` is larger than the duration of a sequence, the client will not download the next expected media sequence. Instead, it increments the sequence number and effectively "skips" that segment of video. It repeats this until the `delay` is smaller than a sequence duration.

    *Example*: If the player is 2.5 seconds behind the live edge and each sequence is 1 second long, it will skip sequences `n` and `n+1` and will try to download sequence `n+2`.

5.  **Prioritize Audio**: In severe congestion scenarios, the client can be configured to download only the audio and the first frame of the video sequence. This ensures that the audio remains continuous (which is less jarring to the user than broken audio) while providing a visual update, even if it's just a single frame, before resuming smooth video playback once the connection improves.

### Why This Enables Low Latency

-   **Prevents Stalls**: By proactively skipping frames, the player avoids the most significant cause of user-perceived latency: the rebuffering or stalling of the video.
-   **Stays at the Live Edge**: Traditional players will buffer several seconds of video, creating a built-in delay. The WebRTS client aggressively tries to keep the buffer minimal, and when it falls behind, it can actively skips content to catch up rather than delaying playback.
-   **Adapts to Real-World Conditions**: The combination of adaptive bitrate (choosing a adapted quality) and frame skipping (throwing away data) provides a two-tiered defense against poor network conditions, ensuring the stream remains live, even if it means a temporary reduction in quality or frame rate.

---

## 3. The RTS Container Format

To achieve maximum efficiency and low overhead, the client utilizes a custom, lightweight container format called RTS. This format is designed to be simple, extensible, and optimized for real-time delivery over the web. It minimizes the container overhead, allowing for the direct transport of encoded frames with just enough metadata to reconstruct the media on the client-side.

The RTS format is defined in `src/media/reader/RTSReader.ts`.

### Packet Structure

RTS packets are structured with a small header followed by a payload
All the fields excepting payload are encoded in the [LEB128](https://en.wikipedia.org/wiki/LEB128) variable-length format (also called *7-bit encoding*) to save space. 

There are four main packet types:

1.  **Media Packet**: Carries audio or video frame data.
2.  **Data Packet**: Carries generic data, such as timed metadata.
3.  **Metadata Packet**: Carries stream-level metadata (like SDP information).
4.  **Init Tracks Packet**: A special control message to signal track initialization.

### Header Format

The header for each packet starts with a *7-bit encoded* number that contains the `trackId` and `type`.

`header = (trackId + 1) << 2 | type`

-   **`trackId`**: A 0-indexed identifier for the media track. It is incremented by 1 to ensure the value is never zero, as a `trackId` of 0 is reserved for non-media packets.
-   **`type`**: A 2-bit field indicating the packet type:
    -   `0`: Data or Metadata when `trackId` is 0
    -   `1`: Audio
    -   `2`: Video
    -   `3`: Reserved or Init Tracks when `trackId` is 0

### Media Packet (Audio/Video)

Media packets contain the core audio and video frames.

`[header] [time?] [duration_and_flags] [compositionOffset?] [payload...]`

-   `header`: `trackId` & `type` equals `1` for Audio or `2` for Video, see [Header Format](#header-format)
-   `time`: The timestamp of the first frame in the packet, relative to the start of the stream. This is only sent for the first packet of a track after an `Init Tracks` signal. Subsequent timestamps are calculated using the duration of the previous frames (`next_timestamp = previous_timestamp + previous_duration`).
-   `duration`: The duration of the frame in milliseconds.
-   `isKeyFrame`: A flag indicating if the frame is a keyframe (I-frame).
-   `compositionOffset`: The composition time offset, used for frames with decoding and presentation order differences (e.g., B-frames).
- `payload`: binary frame


###  Data Packet

Used for generic, timed data payloads.

`[header] [time] [payload...]`

-   `header`: `trackId` & `type` equals `0`, see [Header Format](#header-format)
-   `time`: The timestamp for the data payload.
-   `payload`: Data payload in JSON


### Metadata Packet

Carries a JSON object with stream metadata. This is typically the first packet received.

`[header] [payload...]`

-   `header`: `trackId` is `0` & `type` is `0`, see [Header Format](#header-format)
-   `payload`: Data payload in JSON


### Init Tracks Packet

A control message to signal the (re)initialization of tracks. It contains the `trackId` for the active audio and video tracks. This forces the client to expect a new `time` field in the next media packet for each track.

`[header] [videoTrackId+1] [audioTrackId+1]`

-   `header`: `trackId` is `0` & `type` is `3`, see [Header Format](#header-format)
-   `videoTrackId`: The ID of the current video track incremented by `1` to use `0` as a special value when there is no video track.
-   `audioTrackId`: The ID of the current audio track incremented by `1` to use `0` as a special value when there is no audio track.