# Stream Stats For Nerds - Design

**Date:** 2026-08-16
**Status:** Approved, not yet implemented.

## Problem

A screen share can be wrong in a dozen ways that all look identical from the tile: a stream that
publishes but never arrives, a simulcast ladder where only the top layer is real, an encoder that
fell back to software, a connection relaying through TURN at triple the latency. Today the only
numbers on a share tile are one frame rate each way - `CALL.FPS_OUT` and `CALL.FPS_IN` in
`call-share-tile.component.html:200-214` - and the only other readout in the whole call surface is
`call-stats-popover`, which reports four aggregate kbps figures for the entire call and cannot
attribute any of them to a stream.

That gap is expensive right now. `project_simulcast_publish_spike` records simulcast as confirmed
broken for real viewers, with the SFU accepting the publish proving nothing about what is actually
going out per layer. The number that would settle it - per-rid `bytes_sent` against each rung's
target kbps - exists in both peer connections already and reaches no user and no bug report.

So: a right-click on any screen share tile, inbound or outbound, opening a live per-stream readout,
and a way to put that readout on the clipboard.

## What the code already gives us, and what it does not

**Inbound is nearly free.** Both RTC services already poll `getStats()` on a 2s interval and already
keep a mid to track-owner map:

- `voice-rtc.service.ts:431` (`pollStats`), map `midMeta` at `:193`
- `call-webrtc.service.ts:926` (`pollStats`), map `midMap`

Everything the panel needs - `inbound-rtp`, `codec`, `candidate-pair`, `transport` - is in the
report each poll already fetches. The code keeps `framesPerSecond` and drops the rest.

**Outbound on desktop is the real work, and it is worse than it looks.** Two findings:

1. **Nothing bridges the publisher's stats to the webview.** The publish peer connection lives in
   Rust. `PublishHandle` (`session.rs:46`) holds neither the `Publication` - it is moved into
   `run_writer` at `session.rs:441` - nor the pump's counters, which live on the capture thread.
2. **webrtc-rs cannot report encoder stats at all.** `OutboundRTPStats`
   (webrtc 0.14, `src/stats/mod.rs:587`) carries `ssrc`, `kind`, `packets_sent`, `bytes_sent`,
   `header_bytes_sent`, `mid`, `rid`, `nack_count`, `fir_count`, `pli_count` - and explicitly omits
   `frameWidth`, `frameHeight`, `framesPerSecond`, `framesSent`, `framesEncoded`,
   `keyFramesEncoded`, `qpSum`, `targetBitrate`, `qualityLimitationReason` and
   `encoderImplementation`, with a comment saying why: those are encoder-specific and webrtc-rs is
   not the encoder. Our pump is.

So the desktop outbound readout is not a passthrough of one stats call. It is a **merge of two
sources**: transport counters from `pc.get_stats()`, and encoder counters from `pump.rs`.

**One upside falls out of the same reading.** `OutboundRTPStats.rid` is populated, so per-simulcast-
layer outbound rows need no new plumbing on the transport half.

**Web already works.** `WebScreenPublisher` keeps its own `pc` (`screen-publisher.web.ts:229`), so
`getStats()` there is a browser report with every encoder field present.

**Existing patterns to follow rather than invent:**

- `inbound-fps.ts` - a pure mapper over a `{forEach}` structural type, unit-tested against a fake
  report with no peer connection in sight. The new mappers copy this exactly.
- `call-context-menu` - the document-click and Escape dismissal pattern.
- `call-stats-popover` - the labelled-rows panel look.
- `CallScreenLayoutComponent.nameOf` (`call-screen-layout.component.ts:60`) - the precedent for
  taking a resolver function as an input because the DM and guild surfaces draw the same
  information from completely different services.

**The two surfaces key inbound stats differently, and the panel must not paper over it.**
`inbound-fps.ts` documents the reason at length: `VoiceRTCService.inboundVideoFps` is keyed by
**user id**, because `guildScreenShares` builds one row per participant and a user cannot collide;
`CallWebRtcService.inboundVideoFpsByShare` is keyed by **share id**, because on the DM surface a
stale share can sit alongside its replacement under one user id. Worse for a naive design, the
guild projection sets `shareId: p.mediaSessionId ?? p.userId` (`call-projection.ts:163`), so a
share id on that surface is frequently *not* a user id and cannot be used to look one up. A
resolver taking a bare share id would therefore return nothing for every guild share that has a
media session - which is most of them. Both the resolver and the inspect signal carry **both ids**.

## Decisions

- **Inbound and outbound both**, on both surfaces (guild voice and DM call).
- **The panel is an overlay inside the tile**, pinned top-left, dismissed by Escape or a click
  away. It is a sibling of the pan/zoom surface, so it travels into pop-out and fullscreen for free
  and cannot be zoomed or panned with the picture.
- **A second menu item copies the raw snapshot as JSON.** The panel and the clipboard render the
  same object, so this costs one serialiser. It is what makes a user's report of the simulcast bug
  actionable: per-rid bytes against the ladder's targets, rather than a screenshot of a table.
- **Screen shares only, not cameras.** The mappers key by mid, so cameras are a later step, not a
  redesign.
- **A live table only.** No graphs, no history, no retained series.
- **Rust returns cumulative counters; the webview differentiates them into rates.** Keeps the Rust
  command stateless and puts rate arithmetic in one already-tested TypeScript place, matching how
  `call-webrtc.service.ts:950-968` already derives kbps from two samples.
- **No gate.** This is read-only diagnostics, and the point is that a user can open it and read it
  back to us. It costs nothing while closed.
- **qp is not shipped on desktop.** See Known asymmetry.

## Architecture

### 1. The shared model - `src/app/shared/call/stream-stats.ts`

One shape for both directions and both hosts, so the panel, the clipboard serialiser and every
mapper agree on one vocabulary:

```ts
export interface StreamStatsSnapshot {
    direction: 'inbound' | 'outbound';
    /** Which pipeline produced this. Decides which fields may legitimately be absent. */
    source: 'webview' | 'native';
    capturedAt: number;
    codec?: string;
    /** From the negotiated fmtp, when present. The line that decides what the encoder may emit. */
    profileLevelId?: string;
    transport?: {
        rttMs?: number;
        localCandidateType?: string;
        remoteCandidateType?: string;
        protocol?: string;
        availableOutgoingKbps?: number;
    };
    layers: StreamLayerStats[];
    audio?: StreamAudioStats;
}

export interface StreamLayerStats {
    /** Absent on a single-encoding publication, which is the pre-simulcast case exactly. */
    rid?: string;
    ssrc?: number;
    mid?: string;
    width?: number;
    height?: number;
    fps?: number;
    /** Measured, from differentiated byte counters. */
    kbps?: number;
    /** What this rung was configured for. The pair is the finding - see the simulcast note. */
    targetKbps?: number;
    framesEncoded?: number;
    framesDecoded?: number;
    keyFrames?: number;
    framesDropped?: number;
    packets?: number;
    packetsLost?: number;
    nackCount?: number;
    pliCount?: number;
    firCount?: number;
    jitterMs?: number;
    qp?: number;
    /** e.g. MediaFoundation, openh264. Native outbound only. */
    encoder?: string;
}
```

Every numeric field is optional, and that is load-bearing rather than lax. A field that a pipeline
genuinely cannot produce must render as absent, never as `0` - the same distinction
`inbound-fps.ts` already makes for `framesPerSecond`, and for the same reason: a stream that has
not reported yet and a stream stalled at zero are different findings.

Alongside the types, two pure mappers in the `inbound-fps.ts` style:

- `inboundStatsFor(report, mid): StreamStatsSnapshot | null`
- `outboundStatsFromReport(report, mid): StreamStatsSnapshot | null` (the web host)

and one rate helper that turns two cumulative samples into `kbps`, shared by every caller.

### 2. Inbound

Each RTC service gains:

```ts
/** Which stream the open panel is reading, carrying both ids - see the keying note above. */
readonly inspected = signal<{shareId: string; userId: string} | null>(null);
readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);
```

Each service reads the id its own track map is keyed by and ignores the other: `VoiceRTCService`
resolves the mid through `midMeta` by `userId`, `CallWebRtcService` through `midMap` by `shareId`.
Neither has to know what the other does, which is the same division `inboundScreenFpsByUser` and
`inboundScreenFpsByShare` already draw.

`pollStats` in both services additionally builds the detailed snapshot **for that one share only**.
The number of `getStats()` calls does not change; while nothing is inspected, the added cost is one
null check per poll.

The poll interval drops from 2s to 1s while a panel is open and returns to 2s when it closes. A
diagnostics readout that updates every two seconds is hard to read against a stream that is
visibly stuttering.

`stopStatsPolling` clears both new signals alongside the existing ones.

### 3. Outbound on web

`WebScreenPublisher.stats(shareId)` reads its own `live.pc.getStats()` and runs
`outboundStatsFromReport`. Full encoder fields, `source: 'webview'`.

### 4. Outbound on desktop

Four Rust changes, each following a pattern already in the file it touches.

**4.1 `rtc.rs` - reach the peer connection.** `Publication` already holds
`peer_connection: Arc<RTCPeerConnection>` (`rtc.rs:252`). Add an accessor beside the existing
`keyframe_requests()` and `audio_track()`:

```rust
pub fn peer_connection(&self) -> Arc<RTCPeerConnection> { Arc::clone(&self.peer_connection) }
```

Taken in `session::start` before the publication moves into `run_writer`, exactly as
`keyframe_requests` already is at `session.rs:394`.

**4.2 `pump.rs` - shared, per-layer counters.** `PumpStats` (`pump.rs:92`) is a `Copy` struct owned
by the pump, and per `pump.rs:389` only the top layer counts at all - a lower layer's drops are
invisible today. Replace it with an `Arc<PumpCounters>` of relaxed atomics, one set per layer:

```rust
pub struct LayerCounters {
    pub encoded_frames: AtomicU64,
    pub keyframes: AtomicU64,
    pub dropped_frames: AtomicU64,
}
pub struct PumpCounters { pub layers: Vec<LayerCounters> }
```

The pump writes; the handle reads. This is the widest edit in the change and the only one on the
frame loop's hot path - see Risks.

**4.3 `session.rs` - carry all three.** `PublishHandle` gains:

```rust
peer_connection: Arc<RTCPeerConnection>,
pump_counters: Arc<PumpCounters>,
/// rid -> the geometry and budget that rung was actually built for.
ladder: Vec<Layer>,
```

The ladder is what makes `targetKbps` truthful: `layers_for` (`simulcast.rs:66`) splits the session
budget 68/24/8 and floors each rung, so the target is not derivable from the preset the UI asked
for. It is already computed in `session::start` and currently only logged (`session.rs:430-438`).

**4.4 `mod.rs` - the command.**

```rust
#[tauri::command]
pub async fn publish_stats() -> Option<PublishStats>
```

Async because `get_stats()` is. It merges, per rid:

- from `pc.get_stats()`: `OutboundRTP` (`ssrc`, `mid`, `rid`, `packets_sent`, `bytes_sent`,
  `nack_count`, `pli_count`, `fir_count`), `RemoteInboundRTP` (`round_trip_time`, `packets_lost`,
  `fraction_lost`), and `CandidatePair` for the ICE path
- from `PumpCounters`: encoded frames, keyframes, dropped frames
- from `ladder`: width, height, fps, target kbps
- from the handle: `encoder_name`
- from `screen_audio_stats()` (`session.rs:169`): packets encoded and dropped

Returns cumulative byte and packet counters. The webview differentiates.

Registered in the existing publisher command list; the `active()` lock is taken and released the
same way every other command in the file does it.

### 5. The port and the service

```ts
// screen-publisher.port.ts
abstract stats(shareId: string): Promise<StreamStatsSnapshot | null>;
```

`TauriScreenPublisher` invokes `publish_stats` and maps the payload; `WebScreenPublisher` reads its
`pc`. Both validate `shareId` against the running share and answer `null` for a stale one, matching
the port's existing rule that a stale id fails rather than silently addressing somebody else's
stream (`screen-publisher.port.ts:60-68`).

`RustMediaService` gains `outboundStats = signal<StreamStatsSnapshot | null>(null)` and a 1s poll
started only while a panel is open on the local tile, differentiating successive samples into
`kbps` before it publishes the signal.

### 6. UI wiring

**The split, and why it is not symmetrical.** `CallShareTileComponent` already injects
`RustMediaService` (`call-share-tile.component.ts:23`), and that service is the same object on both
surfaces because it wraps the `ScreenPublisher` port on either host. So **outbound is sourced by
the tile directly**. Inbound is not: it comes from `VoiceRTCService` on the guild surface and
`CallWebRtcService` on the DM surface, and neither is injectable into a shared component. That is
the identical constraint `nameOf` already solves, so it gets the identical answer - a resolver
passed down as an input:

```ts
// CallScreenLayoutComponent, forwarded to the tile
inboundStatsOf = input<(share: CallScreenShare) => StreamStatsSnapshot | null>(() => null);
statsInspect = output<CallScreenShare | null>();
```

Both carry the whole `CallScreenShare` rather than an id, for the keying reason above: the tile has
the object already, and passing it lets the guild host read `userId` while the DM host reads
`shareId` without either one having to reconstruct what it was not given. The default resolver
returns null, so a host that never wires this gets a panel saying it has no inbound data rather
than a crash.

Each host wires `statsInspect` to its RTC service's `inspected` signal and `inboundStatsOf` to its
`inspectedStats`.

**The tile.** A `(contextmenu)` handler on the `#root` element in
`call-share-tile.component.html:10`, calling `preventDefault()` and `stopPropagation()`. Note that
`app.component.ts:75` already swallows contextmenu globally in production builds, so the tile's own
`preventDefault` is what keeps the OS menu away in dev and the global one is not sufficient to rely
on. The handler is on the root rather than the surface, deliberately inverting the click rule
documented at `call-share-tile.component.html:22-27`: a right-click anywhere on the tile, chrome
included, should open this.

**`app-call-stream-menu`** - a new component, not an extension of `call-context-menu`. That one is
keyed to `CallParticipantMenuData` and speaks volume sliders, kick, ban and server deafen; a share
menu has two items and no participant. It reuses the same `@HostListener` document-click and
Escape dismissal and the same host `(click)` stopPropagation.

**`app-call-stream-stats-panel`** - renders a `StreamStatsSnapshot` as a header block (codec,
profile-level-id, transport) plus one section per layer, headed by its rid when there is one.
Absent fields render as absent rows, not as zeroes. `tabular-nums` throughout so a live-updating
number does not reflow its row.

Hosted by the tile itself, so it can be positioned against the tile box and inherits the tile's
lifecycle. Opening it emits `statsInspect` upward with the share id; closing emits null.

### 7. i18n

New `CALL.STATS_NERD.*` keys in `src/assets/i18n/locales/en.json` (plus `de` and `fr`), beside the
existing `CALL.STATS.*` block at `en.json:814`. The locales directory is a git submodule, so the
strings land in their own commit there. No em dashes in any of the copy.

## Known asymmetry

The desktop outbound panel is structurally thinner than the web one, and it must say so rather than
imply a missing number is a zero. webrtc-rs cannot report `qp`, `qualityLimitationReason` or
`encoderImplementation` from the transport side. Of those:

- **encoder** is recovered from `PublishHandle::encoder_name`.
- **geometry, fps, target kbps, frames encoded, keyframes, frames dropped** are recovered from the
  ladder and the pump counters.
- **qp is not shipped on desktop.** It exists only inside Media Foundation and openh264 and would
  need a new field plumbed out of both encoder implementations. That is its own change, and
  blocking this one on it would trade the whole readout for one row.

`source: 'native'` is what the panel branches on to omit those rows entirely instead of drawing
them empty.

## Testing

- **Pure mappers** (`stream-stats.spec.ts`) against hand-built fake reports, mirroring
  `inbound-fps.spec.ts` - including the case that distinguishes an absent field from a zero one.
- **The rate helper** against two samples with a known interval, including the first-sample case
  that must produce nothing rather than an infinite rate.
- **Rust:** a unit test on the merge against a synthetic `StatsReport` plus counters, asserting one
  row per rid and that a rid present in the ladder but absent from the report still produces a row
  carrying its target (that combination is the simulcast failure signature).
- **Rust e2e:** `publisher/e2e_tests.rs` already stands up a real `Publication`, so a test there can
  assert `publish_stats()` returns a layer per published rid.
- **Components:** right-click opens the menu; the menu item opens the panel; Escape and an outside
  click close it; the panel renders one section per layer; opening emits `statsInspect` and closing
  emits null.
- Per `project_media_e2e_test_traps`, each media test must be shown to fail when what it guards is
  mutated, before it is trusted.

## Risks

1. **The pump counters change touches the frame loop.** Relaxed atomic increments are cheap, but
   this is the one edit that could regress capture throughput, and it is on the path that runs at up
   to 60fps at 4K. It gets its own implementation step with a before-and-after check rather than
   riding along with the command.
2. **`PublishHandle` growing three fields widens `session::start`'s already long wiring block.** All
   three are taken at points where a sibling value is already being taken, so the ordering rule the
   file documents does not change - but the constructor is worth re-reading as a whole afterwards.
3. **A stats poll is another caller of `active().lock()`.** Every existing command takes that lock
   briefly and `stop_active_publish` deliberately takes the handle out from under it before waiting
   (`mod.rs`). The stats command must follow the same discipline: clone what it needs, drop the
   lock, then await `get_stats()`. Awaiting under the lock would let a stats poll block the
   framerate and mute controls.

## Phasing

1. Shared model and pure mappers, with specs. No UI, no Rust.
2. Inbound: both RTC services, both surfaces. The panel is fully usable on remote shares here.
3. Outbound on web, through the new port method.
4. Rust: pump counters (own step, with the throughput check), then the handle fields, then the
   command.
5. Outbound on desktop, through the Tauri adapter.
6. Copy raw stats.

Steps 1 to 3 are shippable on their own: a panel that works on every remote share and says the
local one has no data yet is strictly better than today, and it de-risks the Rust work by settling
the model before anything crosses the IPC boundary.
