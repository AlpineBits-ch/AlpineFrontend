# Screen publish, proven end to end

**Date:** 2026-08-07
**Status:** approved, ready to plan

## The problem

Screen shares arrive sometimes and never arrive other times, and nothing in the tree can tell the
two apart. `media::publisher::rtc` and `media::publisher::session` have no tests at all, and they
are where both recent flakiness fixes landed:

- `ae5de86 fix(publisher): keyframes a viewer can actually wait for` — the encoder's keyframe
  interval is a frame count, and a static desktop produces a handful of frames a second, so an
  interval meant to be two seconds became forty-five. A viewer has nothing to decode until the
  first IDR and shows a placeholder until then.
- `d24d807 fix(publisher): a full socket queue must not end the share` — Windows answers
  `WSAENOBUFS` when a UDP socket's send queue is momentarily full, which is exactly what one
  keyframe's worth of packets does. A single failed write used to end the publication outright,
  while capture and encoding carried on happily and nothing above reported it.

Both were invisible to every test in the tree, and both present identically from the sharing side:
the share is "running" everywhere except on the wire, and the sharer's own preview is drawn from
the capture source and looks perfect either way.

This is the same failure class `media::voice::e2e_tests` was written for, and the answer is the
same: put frames in one end and assert on what comes out the other.

## Scope

**In:** the Rust publish path, from a frame handed to the pump through to RTP arriving at a
stand-in viewer, with the backend mocked over real HTTP.

**Out:** receiving video in Rust. The webview keeps that, deliberately — the browser's
`RTCPeerConnection` runs the receive-side jitter buffer, NACK, keyframe requests and the
bandwidth estimation that makes *this* sender adapt, and decoded 1080p RGBA is ~250 MB/s, which
does not cross the Tauri IPC boundary. Voice receives in Rust because it needs HRTF, mixing and
denoise at 64 kbps; video needs none of that and costs a thousand times more to move. The
asymmetry tracks what each medium needs.

**Out:** decoding the received bitstream. The test proves the bytes arrive intact and in order,
not that a decoder renders them.

## Production refactor

Four seams. Three remove a hard blocker; one (`FrameSink`) exists for the test and is accepted
knowingly, because the write-failure behaviour cannot be reached otherwise.

### `publisher/pump.rs` — the frame loop, extracted

The closure body at `session.rs:207-291` becomes `FramePump::on_frame(&mut self, rgba: &RgbaImage)`,
with its captured state as fields: output geometry, `fps: Arc<AtomicU32>`, `encoder`,
`keyframe_wanted: Arc<AtomicBool>`, `frame_tx`, `timestamp_us`, `last_keyframe`, `next_preview`,
the jpeg scratch buffer and the three counters.

`session::start` builds one and passes `|rgba, _, _| pump.on_frame(&rgba)` to `run_capture_loop`,
which already takes `on_frame: impl FnMut(RgbaImage, u32, u32)`. No behaviour change; the pump is
now constructible without a screen.

### The keyframe interval becomes a field

`KEYFRAME_INTERVAL` moves from a module constant read inline to a `FramePump` field defaulting to
today's two seconds. Tests build a pump with 50 ms and assert the rule in milliseconds.

Deliberately not a fake clock. The rule — "a keyframe on elapsed time regardless of frame count" —
is the logic; the specific two seconds is a tuning constant and testing it would only restate it.

### `PreviewSink`

`trait PreviewSink { fn send(&self, frame: PreviewFrame); }`, implemented for
`tauri::ipc::Channel<PreviewFrame>`. Exists only because `tauri::ipc::Channel` cannot be
constructed in a unit test. Tests pass a collector.

### `FrameSink` and `run_writer`

```rust
trait FrameSink {
    async fn write_frame(&self, data: Vec<u8>, duration: Duration) -> Result<(), String>;
    async fn stop(self);
}
```

Implemented by `Publication`. The writer task at `session.rs:156-188` becomes
`run_writer(sink, rx)`, generic over it — not `dyn`, so async-fn-in-trait is fine and no
`async-trait` dependency is needed.

This is the seam that exists for the test. Without it there is no way to make a write fail on
demand, and `WRITE_FAILURES_BEFORE_GIVING_UP` — the constant `d24d807` turned on — is unreachable.

### `publisher_api()` and `h264_capability()`

Pulled out of `Publication::start`, mirroring `voice_api()` / `opus_capability()` in
`media::voice::rtc`. The stand-in SFU must register the same codecs and interceptors as the
publisher, and `voice/e2e_tests.rs:40-48` records why that must not be a copy: which codecs are
registered decides whether an inbound stream can be matched to a transceiver at all, so a
duplicated builder is the most load-bearing thing in the file and would stop matching silently.

### `new_software_encoder` becomes `pub(crate)`

CI is Linux, so Media Foundation never runs there, but a developer on Windows would get it — and
hardware encoders are pipelined, emitting nothing for the first few frames, which breaks the
one-in-one-out assertions. Tests choose the software encoder directly, exactly as `encoder.rs`'s
own tests already do via their `software()` helper.

## The mock backend

`MockBackend` binds `127.0.0.1:0` on a `tokio::net::TcpListener` and speaks HTTP/1.1 by hand: read
to `\r\n\r\n`, parse `Content-Length`, read the body, reply with `Connection: close`. Roughly 80
lines and no new dependency; the surface is four endpoints with JSON bodies.

| Endpoint | Behaviour |
|---|---|
| `POST …/voice/session?primary=false` | returns a `cfSessionId` |
| `POST …/voice/cf/tracks/new` | applies the publisher's offer to the stand-in SFU, answers from it |
| `PUT …/voice/cf/renegotiate` | the same, for the renegotiation path |
| `PUT …/voice/cf/tracks/close` | records the close |

The real `Signalling` and real `reqwest` run against it, so URL routing and the camelCase JSON
contract are exercised on the way past rather than only in isolation.

Behind it sits a stand-in SFU `RTCPeerConnection` built from `publisher_api()`. Its `on_track`
spawns a reader: `read_rtp()`, depacketise with `webrtc::rtp::codecs::h264::H264Packet`,
accumulate until the marker bit, emit one access unit on a channel.

## Tests

`media::publisher::e2e_tests`, `#[cfg(test)]`, mirroring `media::voice::e2e_tests`.

### `a_published_screen_arrives_at_a_viewer_end_to_end`

The headline. Synthetic moving `RgbaImage`s through the real OpenH264 encoder, through
`FramePump`, through a real `Publication`, through the mock backend, to the stand-in viewer.

Every access unit handed to `write_frame` is tee'd. The assertion is that **the sequence of NAL
units reassembled at the viewer equals the sequence the encoder produced** — compared as NAL
bodies with start codes stripped, because the packetiser does not preserve 3- versus 4-byte start
codes and comparing raw Annex-B would fail on a difference that means nothing.

Plus: the first arriving access unit carries SPS, PPS and an IDR, so a viewer has something
decodable from the first thing it ever sees.

### `a_viewer_that_joins_late_gets_a_keyframe_on_request`

Once the stream is producing delta frames, the SFU sends a PLI. Assert an IDR reaches the viewer
within ~500 ms. `ae5de86`'s RTCP path, end to end.

### `a_still_screen_still_gets_a_keyframe_on_the_wall_clock`

Fake encoder, 50 ms interval, frames fed far slower than the configured fps. Assert
`request_keyframe` fires on elapsed time rather than frame count. The forty-five-seconds-to-first-
picture bug.

### `the_first_frame_of_a_share_is_a_keyframe`

Covers the `last_keyframe = now - KEYFRAME_INTERVAL` initialisation — the line that stops a share
waiting out a full interval before any viewer can decode anything.

### `a_burst_of_write_failures_does_not_end_the_publication`

A `FrameSink` that fails `WRITE_FAILURES_BEFORE_GIVING_UP - 1` times and then succeeds. Assert the
writer is still alive and still delivering.

### `a_dead_connection_ends_the_publication`

The same sink failing `WRITE_FAILURES_BEFORE_GIVING_UP` times straight. Assert the writer exits and
`stop()` runs. Together with the test above, this pins both sides of the constant `d24d807`
introduced — that a burst is survived and a genuinely dead connection is not encoded into forever.

### `a_backlog_drops_frames_rather_than_stalling_capture`

A deliberately slow sink and 100 frames in. Assert the pump never blocks and the dropped-frame
counter rises. The `try_send` policy: latency stays bounded, completeness does not.

### `renegotiation_is_honoured_when_the_backend_asks_for_it`

The mock returns `requiresImmediateRenegotiation: true`. Assert the renegotiate endpoint is hit and
media still flows afterwards.

## CI

A `Screen publish end-to-end` step in `ci.yml`, mirroring the voice one at `ci.yml:222-249`:

- Its own step, so "screen sharing is broken" is legible in the checks list without opening a log.
- `grep -q` for the headline test name, because `cargo test` reports success for a filter that
  matched nothing — a module renamed, `#[ignore]`d or lost in a merge would otherwise read as a
  pass, which is exactly how a gate for a recurring regression stops being one.
- A passed-count floor, as a floor and not an exact count.

No new CI dependency. `encoder.rs`'s tests already provision Cisco's OpenH264 blob and cache it
under `src-tauri/target`; these tests reuse the same `provision()` path.
