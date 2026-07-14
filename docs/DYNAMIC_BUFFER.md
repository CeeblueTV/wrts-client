# Adaptive Playback Rate, Silent-Freeze Recovery & DynamicBuffer

> **Status:** experimental, opt-in, off by default. Enable by setting `player.bufferLimitHigh = undefined`
> (the `examples/player.html` "Dynamic Buffer" toggle / `&dynamicBuffer` URL flag); a concrete
> `player.bufferLimitHigh = <ms>` turns it back off — mirroring how `videoTrack`/`audioTrack` toggle MBR.
> Lives on `feat/player-improvements` (PR targets `dev`). This document is the design of record — read it
> before touching the playback-rate, freeze-detection or buffer-tuning code in `src/Player.ts` /
> `src/DynamicBuffer.ts`.

## The algorithm in three rules

What it concretely does, and the reasoning each rule encodes:

1. **Shrink for latency only when stable at the top rendition.** The buffer target is probed *down* (SHRINK,
   reclaiming latency) **only** while playback is at the highest rendition, the buffer is not `LOW`, playback is
   keeping up, and it has stayed calm for `COMFORT_AFTER` ticks; any dip cancels the probe. At the top rendition
   there is no higher quality to climb to, so spending headroom on latency is safe — below it, that headroom is
   what MBR needs to switch up. (`DynamicBuffer._tick` → `_shrink`.)
2. **Detect freezes via `playbackRate` vs `playbackSpeed`, and GROW.** A silent freeze (playhead near-stopped
   while nominal `playbackRate > 1`) or the decoder failing to sustain the acceleration (`playbackSpeed <
   playbackRate · KEEP_UP`) grows the target — as does a `LOW`/stall/MBR-down right after a shrink. Every grow
   locks a floor a later shrink can't cross. Growth is self-limiting: a wider band oscillates slower, so the
   dips stop and growth stops. (`Player._checkStall` → `onFreeze`; `DynamicBuffer._growHigh`.)
3. **Change `playbackRate` as rarely as possible.** The rate is *held* at one of three fixed levels —
   accelerate in `HIGH`, decelerate in `LOW`, otherwise `1×` — flipped only on a buffer-state transition, never a per-tick ramp.
   Safari and PlayReady hiccup on *every* rate change, so each change avoided is a stutter avoided.
   (`Player.adjustPlaybackRate` → `_setRate`.)

## 1. The problem

Low-latency live keeps the buffer small and nudges `playbackRate` to stay near the live edge (see
[WEBRTS.md §2](WEBRTS.md)). On some decoders that backfires:

- **macOS Safari** and **PlayReady (Edge/Chrome)** hiccup — playback briefly slows — on *every* change of
  `playbackRate`. Chrome does not. PlayReady is the worst (a change can stall it for 0.5–2 s); Safari is mild;
  Chrome is unaffected.
- The original ticket ("periodic playback freeze because of audio misread buffer state", Safari 27, fixed-GOP)
  is the same family: acceleration causing a stutter/freeze that did **not** increment the stall counter.

The decode itself is fine at `1.16×` above a healthy buffer — the pain is the **rate change**, and draining a
**too-tight** buffer into the point where the decoder can't keep up.

## 2. Key findings (the expensive ones — don't relearn them)

1. **It's the rate *change*, not the rate *value*.** A fixed `1.16×` (via the example's Rate selector, Dynamic
   Buffer off) plays fine — Chrome & Safari just mild-sawtooth, no catastrophic freeze. Our old logic changed
   the rate constantly (a 12-step 1.08→1.16 ramp on every buffer tick, plus freeze-recovery toggling it), so on
   Safari/PlayReady it **generated the very hiccups it then panicked about** → runaway.
2. **A too-tight band sawtooths, and on Safari that sawtooth is the bad UX.** With `accelerate-in-HIGH` and a
   narrow `[middle,high]` band (e.g. `[400,800]` → band 600–800), the buffer crosses the band every ~1–2 s, so
   the rate toggles `1↔1.16` that often, and Safari micro-stutters on each toggle — even though `Stalls = 0`.
3. **The catastrophic "silent freeze + buffer runaway to 12 s" was mostly our own doing.** Same stream, same
   `reliable=true`; the *only* variable that flipped benign→catastrophic was our over-reactive freeze detector
   (250 ms, "stalled" at `< 0.5×`) firing on normal dips and cascading rate-caps / buffer-grows.
4. **Per-browser reality:** Chrome tolerates rate changes → shrinks happily to low latency. Safari needs a
   *wider* buffer to run smooth. PlayReady barely tolerates acceleration at all (deprioritized — rarely used).

## 3. Architecture

Two responsibilities, both gated by the opt-in `Player.stallRecovery` flag (auto-tuning enables it when `bufferLimitHigh` is set to `undefined`).

### Player (`src/Player.ts`) — playback rate & freeze detection

- **Held, three-level rate** (`adjustPlaybackRate` → `_setRate`): three fixed levels chosen from the buffer
  state — `maxRate` in `HIGH`, `minRate` in `LOW`, else `1×`. Because the buffer state has hysteresis (`HIGH`
  persists down to `middle`, `LOW` up to `middle`), the rate flips **only on state transitions**, never a
  per-tick ramp. This is the core fix: change the rate as rarely as possible.
- **Settle window** (`_settleTicks = RATE_SETTLE_TICKS`): after *any* `_setRate` change, freeze detection is
  paused for ~1.5 s, because the decoder slows transiently right after a rate change and that dip must not be
  read as a freeze.
- **Strict silent-freeze detector** (`_checkStall`, a 250 ms timer): only a genuinely near-stopped playhead
  (`< STALL_FROZEN_RATIO` of real-time) sustained for `STALL_FREEZE_TICKS` (~1 s) counts. On a real freeze it
  drops to `1×`, holds `_recovering` until `playbackSpeed` is back in `[STALL_RECOVERED_SPEED, STALL_CATCHUP_SPEED]`
  for `STALL_STABLE_TICKS`, and fires **`onFreeze`**. **No `goLive`** in this path (a seek just re-triggers it
  and thrashes). A brief sawtooth dip is left to the normal stall machinery.
- **Owns DynamicBuffer**: `player.bufferLimitHigh = undefined` lazily creates and enables it (re-baselines if
  already running); a concrete `player.bufferLimitHigh = <ms>` pins the target and turns it off.

### DynamicBuffer (`src/DynamicBuffer.ts`) — buffer-target tuning (AIMD)

Tunes `Player.bufferLimitHigh` (which slides `bufferLimitMiddle`, the real target) to converge on the lowest
*stable* latency. It **shrinks** while calm (probe down for latency) and **grows** on three signals, each of
which locks `_floorHigh` so a later shrink can't undo it:

| Grow signal | Trigger | Factor |
|---|---|---|
| Freeze | `Player.onFreeze` | `×WALL_MARGIN` (1.3) |
| Over-shrink | `LOW` / `stall` / `MBR-down` right after a shrink | `×WALL_MARGIN` (1.3) |
| **Not keeping up** | `playbackSpeed < playbackRate·KEEP_UP` for `STRUGGLE_TICKS` ticks | `×GROW_STEP` (1.15) |

The third one is the subtle, important one: it catches the Safari sawtooth (the decoder slowing on each toggle)
and grows the band until the oscillation is slow enough to run smooth. It is **self-limiting** — a wider band →
slower oscillation → fewer dips → `keepingUp` holds → growth stops. It is also what distinguishes Safari (dips,
so it grows) from Chrome (keeps up, so it shrinks to low latency).

## 4. Constants / dials

**`src/Player.ts`**

| Const | Value | Meaning |
|---|---|---|
| `PLAYBACK_RATE_MAX` / `PLAYBACK_RATE_MIN` | 116 / 84 | accel level in HIGH / decel level in LOW (percent) |
| `STALL_CHECK_MS` | 250 | freeze-detector tick period |
| `STALL_FROZEN_RATIO` | 0.1 | "frozen" = playhead advanced < this × real-time |
| `STALL_FREEZE_TICKS` | 4 | frozen ticks (~1 s) before it's treated as a real silent freeze |
| `STALL_RECOVERED_SPEED` / `STALL_CATCHUP_SPEED` | 0.9 / 1.2 | normal-speed band to leave recovery (excludes goLive catch-up spikes) |
| `STALL_STABLE_TICKS` | 2 | consecutive normal-speed ticks to leave recovery |
| `RATE_SETTLE_TICKS` | 6 | freeze-detection grace (~1.5 s) after a rate change |

**`src/DynamicBuffer.ts`**

| Const | Value | Meaning |
|---|---|---|
| `TICK_MS` | 1000 | control-loop period |
| `KEEP_UP` | 0.9 | `playbackSpeed ≥ rate·KEEP_UP` = "keeping up" (shrink gate / struggle signal) |
| `STRUGGLE_TICKS` | 3 | "not keeping up" ticks before a struggle-grow |
| `GROW_STEP` | 1.15 | gentle grow when the band is too tight (struggle) |
| `WALL_MARGIN` | 1.3 | grow on a freeze / over-shrink failure |
| `COMFORT_AFTER` | 8 | consecutive calm ticks before a shrink |
| `SHRINK_RATIO` / `STEP_MS` | 0.1 / 100 | shrink step = max(10% of high, 100 ms) |
| `MAX_HIGH_MS` | 5000 | hard ceiling for `bufferLimitHigh` |

If Safari grows too far (latency too high) or not enough (still stutters), the dials are `GROW_STEP` and
`STRUGGLE_TICKS`. `bufferLimitLow` is never touched by DynamicBuffer — it is the MBR down-trigger.

## 5. Expected behaviour per engine

- **Chrome**: keeps up at `1.16×` → DynamicBuffer shrinks to low latency. Best case.
- **Safari**: the tight-band sawtooth trips "not keeping up" → grows to a stable width (~1000–1200 ms with a
  `[400,800]` start) and holds — smooth, at the cost of higher latency. That trade is intentional.
- **Edge/PlayReady**: big transient on each rate change; settles at a higher stable buffer. Deprioritized.

## 6. Dead-ends we already tried (do not repeat)

- **Tend-to-middle** (accelerate whenever `buffer > middle`, proportional ramp): constant rate changes → constant
  hiccups on Safari/PlayReady → runaway. Reverted to a single held accelerate-in-`HIGH` level.
- **GROW on every freeze from the instantaneous buffer**: freeze-inflated buffer read as an ever-higher "wall" →
  ratchet to the 5 s cap. Fixed by the strict detector + not treating inflation as a wall.
- **`goLive('reclaim')` / `goLive('recover stall')`**: produced a goLive-every-2 s sawtooth with `speed 0.01`
  (broken playback). Removed all goLive from the freeze path.
- **Cap the rate to `1×` on a freeze**: killed latency reclaim and left the buffer stuck at the inflated level.
- **Aggressive 250 ms / `< 0.5×` detection**: over-reacted to normal dips. Now strict (`< 0.1×`, ~1 s) + settle
  window.

## 7. How to test

- Serve the repo (`npx http-server . -p 8081`) and open `examples/player.html` (append `?events` to log raw
  `<video>` media events). Add `&dynamicBuffer` to start with it on.
- **Rate selector**: add `&playbackRate=auto` (or `&playbackRate=x1.08`, etc.) to the URL to reveal a selector
  (next to the Dynamic Buffer toggle, disabled while Dynamic Buffer is on) that forces a fixed `playbackRate` in
  real time, stepping `0.84×`–`1.16×` in `0.04` increments — for probing a decoder's tolerance by hand (e.g.
  the PlayReady hiccup on each change). Hidden unless that query param is present.
- Watch the logs: `Adapt playback rate to …` (should be infrequent), `… → GROW …`, `SHRINK …`,
  `Silent freeze: hold 1x until stable` (should be rare), and the metrics overlay's buffer / speed / stalls.

## 8. Open items

- **Audit the MSE `Force onUpdate` flush** (`MediaBuffer`/`CMAFWriter`): the frequent flush-on-event may compound
  decoder hiccups. Do it on this stable baseline, one change at a time.
- Optionally make the rate **probe back up** after a sustained calm (currently a freeze-capped decoder just holds).
- Open the PR (conventional-commit; PR targets `dev`) once validated across engines.
