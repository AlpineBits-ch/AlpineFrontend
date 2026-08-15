# Changing a screen share's resolution without dropping the stream

Date: 2026-08-15

## The problem

On desktop, changing the resolution of a running screen share makes every viewer's layout
collapse. The stream, the tile, and sometimes the entire stage disappear for one to four seconds
and then come back.

The cause is that the Rust publisher's encoder is built once, for one geometry, and never
reconfigured. A resolution change therefore goes stop-then-start:

- `voice-rtc.service.ts` `restartRustPublish` calls `stopScreenPublish()` and then
  `publishScreenFromRust()`.
- The new publish opens a new Cloudflare session, so it gets a new `mediaSessionId`, a new
  `trackName`, and a new `shareId`.
- `voice-channel.service.ts` `setScreenPreset` announces `ScreenShareStopped(old)` followed by
  `ScreenShareStarted(new)`.

On every viewer that plays out as:

1. `guild.voice.TrackClosed(screen)` arrives. `voice-channel.service.ts` `onTrackClosed` sets
   `isScreenSharing: false` on that participant.
2. `guildScreenSharers` (`call-projection.ts`) filters on that flag, so the share leaves
   `displayedShares`.
3. The grid reflows. `gridClass` recomputes, `stripParticipants` reshuffles, and `showInviteCard`
   can flip on where the stream used to be.
4. If the viewer had maximised that share, `displayedShares` filters to `shareId === maximizedId`
   and returns an empty array, so `displayedTiles` is empty and the stage goes completely blank.
5. `hiddenIds` is pruned, so a share the viewer had deliberately hidden un-hides itself.
6. `shareWatch` reports the sharer's viewer count as zero and then back up.

The gap is roughly one to four seconds: up to two waiting for the capture thread
(`CAPTURE_EXIT_TIMEOUT`), plus CreateSession, SDP, ICE and the first keyframe.

The web publisher does not have this bug. `voice-rtc.setScreenPreset`'s non-Rust branch changes
capture geometry and sender encoding in place and never touches the share id. Desktop is the
outlier.

## Approach

Two changes, in order.

**A. The publisher reconfigures its encoder in place, so a resolution change stops being a
restart at all.** This is the fix the user will verify. Same session, same track, same share id,
so no viewer ever learns a resolution changed.

**B. The viewer treats a share that goes away as `resuming` rather than gone.** Restarts still
happen for other reasons - the sharer switches source, the publication dies on a run of write
failures, the network drops, the web fallback - and all of them hit the same blank-stage path
today.

A third option, make-before-break (overlap the new publish with the old), is rejected.
`session.rs` `PublishHandle::stop` documents at length why the overlap was engineered away: two
capture sessions on one monitor, two Media Foundation encoders configuring against the same
hardware, and the outgoing encoder's `Drop` sending `END_STREAMING` while the incoming one
negotiates its media types. It would also double upstream for the overlap and briefly show two
tiles for one person.

## A. In-place encoder reconfiguration

### What already exists

`MediaFoundationEncoder::reconfigure` is already written and already exercised. It flushes, ends
streaming, drains posted events, clears the input type, applies the new spec and restarts
streaming. It exists because destroying a used NVIDIA MFT faults inside the driver, so the
encoder is parked between shares and retyped rather than rebuilt.

`FramePump::on_frame` already calls `fit_into(rgba, self.width, self.height)`, with the comment
"the source can change size mid-session, the encoder cannot". That is the seam.

### The hazard

`SoftwareEncoder::encode` returns `EncodeOutcome::Failed` whenever the frame's dimensions differ
from the spec it was built for, and `Failed` means "this encoder is broken, replace it", which in
the pump ends the capture loop. So the pump's `width`/`height` and the encoder's spec **must**
change inside one call. Any window where they disagree kills the share on the next frame.

This is pinned by a test, not by a comment.

### Changes

1. `encoder.rs`: `VideoEncoder` gains `fn reconfigure(&mut self, spec: EncoderSpec) -> Result<(),
   String>`. Required rather than defaulted, so a future encoder cannot silently not implement it.
2. `encoder_sw.rs`: `SoftwareEncoder::reconfigure` rebuilds itself from the new spec. openh264
   emits SPS/PPS with the IDR that follows, so a rebuilt encoder produces a decodable stream.
3. `encoder_mf.rs`: the existing inherent `reconfigure` is renamed `retype` so the trait method
   can carry the name without shadowing games. `MediaFoundationEncoder` and `PooledEncoder` both
   implement the trait method by delegating to it.
4. `encoder.rs`: `ResilientEncoder::reconfigure` forwards to the active encoder and records the
   new spec, so a later fallback to software builds at the current geometry rather than the one
   the share opened with.
5. `pump.rs`: `FramePump` holds its `EncoderSpec` and a shared `pending_spec` cell. `on_frame`
   applies a pending spec at the top of the frame - setting `width`/`height`, calling
   `encoder.reconfigure`, and forcing a keyframe, in that single step. A reconfigure that fails
   leaves the old geometry in place and logs, rather than tearing the share down.
6. `session.rs`: `PublishHandle::set_geometry(width, height, kbps)` writes the pending spec and
   updates the geometry atomics.
7. `mod.rs` + `lib.rs`: a `set_publish_geometry` command beside `set_publish_fps`.

The `Publication`, the peer connection, the SSRC, the track name and the media session id are
never touched.

### Client changes

8. `screen-publisher.port.ts`: `setGeometry(shareId, width, height, kbps)`. The port doc that
   says "a resolution change restarts the publish" is now false and is rewritten.
9. `screen-publisher.tauri.ts`: invokes `set_publish_geometry`.
10. `screen-publisher.web.ts`: implements it against the display track's constraints and the
    sender's encoding parameters, which is what the web path already did one layer up.
11. `fake-screen-publisher.ts`: records the calls.
12. `rust-media.service.ts`: `setPublishGeometry(width, height, kbps)`. It also reopens the local
    stream renderer at the new size - the sharer's own tile decodes the same H.264 through a
    `VideoDecoder` built for one geometry, and `startScreenPublish` only closed it because a
    restart happened to pass through there.
13. `voice-rtc.service.ts` and `call-session.service.ts`: `setScreenPreset` calls
    `setPublishGeometry` instead of restarting. `restartRustPublish` and `ScreenPublishRestart`
    are deleted from both.
14. `voice-channel.service.ts` `setScreenPreset` announces nothing, because there is nothing to
    announce.

## B. `resuming` instead of absence

`onTrackClosed` stops clearing `isScreenSharing` outright. It marks the participant as resuming
and starts a grace timer. A `ScreenShareStarted` for the same user inside the window adopts the
new share in place and cancels the timer; the timer expiring is what finally drops the tile.

- `CallScreenShare` gains `state: 'live' | 'resuming'`.
- `maximizedId` re-targets to the replacement share rather than collapsing to an empty grid.
- `hiddenIds` survives a re-negotiation, so a deliberate hide is not undone by one.
- `shareWatch` does not report zero viewers across the gap.

Grace window: 6 seconds. Long enough to cover a source switch and a slow renegotiation, short
enough that a real stop does not leave a ghost tile on the stage for an uncomfortable length of
time.

## The transition

The reflow is the damage, more than the missing picture. So while any share is resuming,
`gridClass` and `showInviteCard` freeze - the tile keeps its slot and its size.

The tile shows the last decoded frame rather than a spinner. A spinner on black says the stream
died; a held frame says you are still in the right place. Approach A gets this free because the
element never unmounts. Approach B captures the last frame into a canvas before the track drops,
because a `<video>` whose `srcObject` is cleared paints black.

Over the held frame: a dimming wash, a hairline sweep on the top edge, and one label. Under
`prefers-reduced-motion` the sweep becomes a static bar.

Copy names the real event in active voice and does not apologise:

- Resuming with a known target: `Switching to 1440p`
- Resuming without one: `Picture is coming back`
- Grace expired: `<name> stopped sharing`

Tokens: wash `color-mix(in srgb, var(--color-app-bg) 55%, transparent)`, hairline
`var(--color-brand-dim)`, label `--color-text-secondary` at `text-[0.6875rem]`.

## Testing

Rust:

- A pump test that changes spec mid-stream and asserts the following chunk is a keyframe and that
  no `Failed` outcome is produced. This is the software-encoder geometry hazard.
- A pump test that a failed reconfigure leaves the previous geometry intact and keeps encoding.
- `encoder.rs`: the software encoder encodes correctly after a reconfigure to a new size.
- The existing `e2e_tests.rs` harness drives frames into real RTP; a resolution change there
  proves the bitstream stays decodable across the switch.

Client:

- `setScreenPreset` at a new resolution calls `setGeometry` and neither stops nor restarts.
- It announces no share-stopped or share-started event.
- A maximised share survives its id changing.
- The grid does not reflow while a share is resuming.

## Verify before trusting - answered

Three things this design assumed and could not prove from the sending side:

1. That Cloudflare Calls forwards a mid-stream SPS/PPS change cleanly.
2. That the sharer's own tile survives it - the self-view decodes the same H.264 through a
   `VideoDecoder` built for one geometry, which change 12 reopens.
3. That the NVIDIA MFT tolerates a retype while a publication is live. The existing path retypes a
   parked encoder *between* shares; mid-publication is the same call sequence in different
   surrounding state.

**All three confirmed on 2026-08-15** by changing resolution mid-share and watching it on a second
device: the picture changes size and keeps playing, with no restart and nothing announced.
