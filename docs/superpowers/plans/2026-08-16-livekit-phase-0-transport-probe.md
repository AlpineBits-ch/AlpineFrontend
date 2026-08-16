# LiveKit Phase 0: transport probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that `webrtc-rs` can publish to and subscribe from a LiveKit server using
`livekit-api`'s signalling client, so the rest of the migration can be planned against facts.

**Architecture:** Take `livekit_api::signal_client` as a dependency (it is transport-blind and pulls
no libwebrtc), drive two `webrtc-rs` peer connections from the signal events it yields, and push our
existing Opus packets and H.264 access units through them unchanged. Everything lands in a new
`src-tauri/src/media/livekit/` module; nothing existing is rewired in this plan.

**Tech Stack:** Rust, `livekit-api` 0.6.3 (`signal-client-tokio`), `livekit-protocol`, `webrtc-rs`
0.14, tokio, a local `livekit-server --dev`.

**Spec:** `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`

## Scope

This plan covers **Phase 0 only**, plus the one rename that Phase 0 has to verify. Phases 1 to 4 of
the spec get their own plans, written after Task 8 reports - the spec calls Phase 0 a spike whose
output is an answer, and Phase 1's shape depends on that answer in at least two ways (whether
single-peer-connection mode is available, and whether our H.264 negotiates at all).

**Nothing in this plan is shipped code.** The module it builds is a probe. It is kept in-tree rather
than thrown away because Phase 1 grows out of it, but no production path calls it and no existing
file changes behaviour, except Task 4.

## Global Constraints

- **Publish rids are `f` (full), `h` (half), `q` (quarter)**, highest first. LiveKit maps rid to
  quality through the `layers` list in `AddTrackRequest`; it never sorts or matches rid names.
- **`layer` and `maxLayer` from the server are `a`/`b`/`c`**, a ranking vocabulary, not rids. Not
  used in this plan; do not conflate them with the above.
- **`auto_subscribe` is always false.** The server's plan decides what we pull.
- **Identity is the bare user id**, or `{userId}#{tag}` for a secondary connection. Split on the
  first `#`.
- **`SignalOptions`, `SignalSdkOptions` and `SignalEvent` are `#[non_exhaustive]`.** They cannot be
  built with a struct literal outside their crate. Assign fields onto `Default::default()`.
- Track names are the contract: `audio`, `screen-{shareId}`, `screen-audio-{shareId}`. Test
  `screen-audio-` before `screen-`.
- No new TLS stack: `livekit-api` uses `native-tls`, matching the `reqwest` already in `src-tauri`.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/media/livekit/mod.rs` | module wiring only |
| `src-tauri/src/media/livekit/signal.rs` | our connect options and the URL/token pair; the only place that names `livekit_api` |
| `src-tauri/src/media/livekit/probe.rs` | the probe engine: two peer connections driven by signal events |
| `src-tauri/src/media/livekit/probe_tests.rs` | every test in this plan; live ones are `#[ignore]`d |
| `docker/livekit-dev/compose.yaml` | a dev server to probe against |
| `src-tauri/src/media/publisher/simulcast.rs` | modified: rid rename (Task 4) |
| `src-tauri/Cargo.toml` | modified: dependencies (Task 1) |

---

### Task 1: Take the LiveKit signalling dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/media/livekit/mod.rs`
- Create: `src-tauri/src/media/livekit/signal.rs`
- Test: `src-tauri/src/media/livekit/probe_tests.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `media::livekit::signal::connect_options() -> livekit_api::signal_client::SignalOptions`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/media/livekit/probe_tests.rs`:

```rust
//! The Phase 0 transport probe.
//!
//! Live tests are `#[ignore]`d: they need a LiveKit server on `ws://127.0.0.1:7880`. See
//! `docker/livekit-dev/compose.yaml`, and the Windows note in it before reaching for Docker.

use super::signal::connect_options;

#[test]
fn connect_options_never_auto_subscribe() {
    let options = connect_options();

    // The server's subscription plan decides what we pull - guide §6.6. A room that subscribes us
    // to everyone costs egress nobody is listening to, and nothing corrects it.
    assert!(!options.auto_subscribe);
    assert_eq!(options.sdk_options.sdk, "venta");
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit`
Expected: FAIL - `file not found for module `livekit`` (the module is not declared yet).

- [ ] **Step 3: Add the dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`:

```toml
# LiveKit signalling only. The `signal-client` feature is documented upstream as "blind to the
# transport backend" and pulls no libwebrtc - the media stays `webrtc-rs`. `default-features = false`
# drops services/access-token/webhooks (reqwest, jsonwebtoken); `native-tls` matches the TLS backend
# `reqwest` already links here, so we do not end up with two.
# See docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md §1.
livekit-api = { version = "0.6.3", default-features = false, features = ["signal-client-tokio", "native-tls"] }
livekit-protocol = "0.7"
```

And under `[dev-dependencies]` (create the section if absent):

```toml
# Minting a probe token needs the JWT half, which shipping code must not carry.
livekit-api = { version = "0.6.3", default-features = false, features = ["access-token"] }
```

- [ ] **Step 4: Create the module**

`src-tauri/src/media/livekit/mod.rs`:

```rust
//! Speaking LiveKit's signalling protocol over our own media transport.
//!
//! `livekit_api::signal_client` owns the WebSocket, the protocol version, the request queue and the
//! reconnect ladder. Everything below the signal - peer connections, codecs, jitter, mixing - stays
//! `webrtc-rs` and stays ours. See the Phase 0 spec for why the `livekit` crate itself is not usable
//! here: its `SignalClient` is private and it links libwebrtc unconditionally.

pub mod signal;

#[cfg(test)]
mod probe_tests;
```

`src-tauri/src/media/livekit/signal.rs`:

```rust
//! How this client introduces itself to a LiveKit room.

use livekit_api::signal_client::{SignalOptions, SignalSdkOptions};

/// The options every Venta connection opens with.
///
/// Built by assignment rather than a struct literal because both types are `#[non_exhaustive]`,
/// which forbids literal construction outside their own crate however many fields are named.
pub fn connect_options() -> SignalOptions {
    let mut sdk = SignalSdkOptions::default();
    sdk.sdk = "venta".to_string();
    sdk.sdk_version = Some(env!("CARGO_PKG_VERSION").to_string());

    let mut options = SignalOptions::default();
    // Never true. See the test, and guide §6.6.
    options.auto_subscribe = false;
    // Adaptive stream is the JS SDK's viewport tracking; there is no viewport here.
    options.adaptive_stream = false;
    options.sdk_options = sdk;
    options
}
```

Declare the module in `src-tauri/src/media/mod.rs` alongside the existing ones:

```rust
pub mod livekit;
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit`
Expected: PASS, 1 test.

- [ ] **Step 6: Pin the protocol crate to what actually resolved**

Run: `cargo tree --manifest-path src-tauri/Cargo.toml -i livekit-protocol --depth 0`

Read the exact version and replace `livekit-protocol = "0.7"` with it, e.g.
`livekit-protocol = "0.7.12"`. Two resolved copies of the generated types would compile and then
fail to unify at the `SignalClient` boundary, which is a confusing error to meet later.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/media/mod.rs src-tauri/src/media/livekit/
git commit -m "feat(voice): take livekit-api's signalling client as a dependency"
```

---

### Task 2: A dev server and a token to reach it with

**Files:**
- Create: `docker/livekit-dev/compose.yaml`
- Modify: `src-tauri/src/media/livekit/probe_tests.rs`

**Interfaces:**
- Consumes: `connect_options()` from Task 1.
- Produces: `probe_tests::dev_token(room: &str, identity: &str) -> String` and
  `probe_tests::DEV_URL: &str`.

- [ ] **Step 1: Write the failing test**

Append to `probe_tests.rs`:

```rust
use livekit_api::access_token::{AccessToken, TokenVerifier, VideoGrants};

/// Dev mode ships this fixed pair. It is not a secret and must never reach a config file that a
/// release build reads.
const DEV_KEY: &str = "devkey";
const DEV_SECRET: &str = "secret";

pub const DEV_URL: &str = "ws://127.0.0.1:7880";

/// A join token for the local dev server.
pub fn dev_token(room: &str, identity: &str) -> String {
    AccessToken::with_api_key(DEV_KEY, DEV_SECRET)
        .with_identity(identity)
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: true,
            can_subscribe: true,
            ..Default::default()
        })
        .to_jwt()
        .expect("dev token")
}

#[test]
fn dev_token_carries_the_identity_and_room() {
    let token = dev_token("probe", "user-1#view");

    let claims = TokenVerifier::with_api_key(DEV_KEY, DEV_SECRET)
        .verify(&token)
        .expect("the token we just minted must verify");

    // The `#` is what separates a secondary connection from its user, and it survives a round trip
    // through the JWT unescaped. A token that mangled it would map every secondary participant to
    // the wrong user, or to none.
    assert_eq!(claims.sub, "user-1#view");
    assert_eq!(claims.video.room, "probe");
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit`
Expected: FAIL to compile - `access_token` is not in scope until the dev-dependency feature is
active. If it compiles and passes immediately, Task 1 Step 3 put `access-token` in the wrong
section; move it to `[dev-dependencies]`.

- [ ] **Step 3: Confirm the claim field names**

Run: `cargo doc --manifest-path src-tauri/Cargo.toml -p livekit-api --no-deps --open`, or read
`Claims` in the crate source. Correct `claims.sub` / `claims.video.room` if the field names differ,
rather than weakening the assertion.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the dev server**

Create `docker/livekit-dev/compose.yaml`:

```yaml
# A LiveKit server for the Phase 0 transport probe. Dev mode ships a fixed key pair
# (devkey / secret) and accepts any room name.
#
# WINDOWS: prefer the native binary over this file. In dev mode the server advertises the
# candidates it can see, which inside a container are the container's own addresses - unreachable
# from the host on Windows and macOS, where there is no host networking. The handshake then fails
# at ICE with everything else looking healthy, which is an expensive thing to debug. On Linux,
# `network_mode: host` avoids it. Everywhere else, run:
#
#     livekit-server --dev
#
services:
  livekit:
    image: livekit/livekit-server:latest
    command: --dev --bind 0.0.0.0
    network_mode: host
```

- [ ] **Step 6: Start it and confirm it answers**

Run (Windows/macOS): `livekit-server --dev`
Run (Linux): `docker compose -f docker/livekit-dev/compose.yaml up`

Then: `curl http://127.0.0.1:7880`
Expected: an HTTP response from the server, not a connection refusal.

- [ ] **Step 7: Commit**

```bash
git add docker/livekit-dev/compose.yaml src-tauri/src/media/livekit/probe_tests.rs
git commit -m "test(voice): a dev LiveKit server and a probe token for it"
```

---

### Task 3: Connect, and answer the first question

**Files:**
- Modify: `src-tauri/src/media/livekit/probe_tests.rs`

**Interfaces:**
- Consumes: `connect_options()`, `dev_token()`, `DEV_URL`.
- Produces: nothing beyond the test. This is the task that proves the dependency works against a
  real server at all.

- [ ] **Step 1: Write the failing test**

Append to `probe_tests.rs`:

```rust
use livekit_api::signal_client::SignalClient;

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880 - see docker/livekit-dev/compose.yaml"]
async fn connects_and_receives_a_join_response() {
    let token = dev_token("probe-connect", "user-1");

    let (client, join, _events) = SignalClient::connect(DEV_URL, &token, connect_options(), None)
        .await
        .expect("the signalling connect must succeed");

    // The room and our identity come back from the server rather than being echoed from the token,
    // so this is the first point at which the whole path is proven rather than assumed.
    assert_eq!(join.room.expect("room").name, "probe-connect");
    assert_eq!(join.participant.expect("participant").identity, "user-1");

    // Recorded rather than asserted: whether this server offers single-peer-connection mode decides
    // how much of Phase 1 exists at all. See the spec's Phase 0 note.
    println!("single-pc mode active: {}", client.is_single_pc_mode_active());
    println!("subscriber primary: {}", join.subscriber_primary);
    println!("ice servers: {}", join.ice_servers.len());

    client.close().await;
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored`
Expected: FAIL. With no server running, a connect error. With a server running but the test not yet
compiling, a compile error naming `SignalClient`.

- [ ] **Step 3: Make it pass**

Start the dev server (Task 2 Step 6). Fix whatever the compiler reports about `join`'s field names
against the real `JoinResponse` - `room` and `participant` are `Option`, and the field spellings are
the protobuf ones.

- [ ] **Step 4: Run it and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored --nocapture`
Expected: PASS, and three printed lines. **Write the three values down** - they are inputs to Task 8.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/livekit/probe_tests.rs
git commit -m "test(voice): prove the signalling client reaches a LiveKit server"
```

---

### Task 4: Rename the simulcast rids to LiveKit's vocabulary

**Files:**
- Modify: `src-tauri/src/media/publisher/simulcast.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `LAYER_RIDS: [&str; 3]` now spelled `["f", "h", "q"]`, highest first. Task 6 asserts
  against it.

This is the one task here that touches shipping code. It is safe now because the routes the old
names were chosen for no longer exist server-side, and Isle - the only remaining Cloudflare caller -
publishes no video.

- [ ] **Step 1: Write the failing test**

In `simulcast.rs`'s test module:

```rust
#[test]
fn rids_are_livekits_vocabulary_highest_first() {
    // LiveKit maps rid to quality through the `layers` list in AddTrackRequest and never sorts or
    // matches the names. `f`/`h`/`q` is its convention; the previous `a`/`b`/`c` existed only
    // because Cloudflare's sole ordering vocabulary was asciibetical and the alphabet therefore had
    // to run best-to-worst.
    assert_eq!(LAYER_RIDS, ["f", "h", "q"]);

    let layers = layers_for(EncoderSpec { width: 1920, height: 1080, fps: 60, kbps: 6000 }, 3);
    assert_eq!(layers.iter().map(|l| l.rid).collect::<Vec<_>>(), ["f", "h", "q"]);
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::publisher::simulcast`
Expected: FAIL - `assertion failed: left: ["a", "b", "c"]`.

If `EncoderSpec`'s fields differ from the literal above, correct the literal to the real shape
rather than the assertion.

- [ ] **Step 3: Rename**

In `simulcast.rs`, change `LAYER_RIDS` to `["f", "h", "q"]`, and **delete the asciibetical
rationale** in the doc comments above it and above `layers_for`. Replace it with:

```rust
/// The rid names, highest layer first.
///
/// LiveKit's convention. The server maps rid to quality through the `layers` list in
/// `AddTrackRequest` and never sorts or matches these strings, so they are a label rather than an
/// ordering. That is the opposite of what they were: under Cloudflare the same string went on the
/// wire as `preferredRid` and asciibetical was its only ordering vocabulary, so the alphabet had to
/// run best-to-worst. Do not restore that reasoning; it is what would make `a`/`b`/`c` look correct.
```

- [ ] **Step 4: Run the whole publisher suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::publisher`
Expected: PASS. Any other test asserting `"a"` is asserting the old vocabulary - update it, and read
its name first in case it was pinning something else that happened to use the letter.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/simulcast.rs
git commit -m "refactor(publish): rename simulcast rids to LiveKit's f/h/q"
```

---

### Task 5: Publish Opus, and hear it

**Files:**
- Create: `src-tauri/src/media/livekit/probe.rs`
- Modify: `src-tauri/src/media/livekit/mod.rs`, `src-tauri/src/media/livekit/probe_tests.rs`

**Interfaces:**
- Consumes: `connect_options()`, `dev_token()`, `DEV_URL`, `media::voice::rtc::voice_api()`,
  `media::voice::rtc::opus_capability()`.
- Produces:
  - `probe::Probe::connect(url: &str, token: &str) -> Result<Probe, String>`
  - `probe::Probe::publish_audio(&self, name: &str) -> Result<String, String>` returning the track
    SID the server assigned.
  - `probe::Probe::close(self)`

- [ ] **Step 1: Write the failing test**

Append to `probe_tests.rs`:

```rust
use super::probe::Probe;

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn publishes_an_opus_track_under_our_own_name() {
    let probe = Probe::connect(DEV_URL, &dev_token("probe-audio", "user-1"))
        .await
        .expect("connect");

    let sid = probe.publish_audio("audio").await.expect("publish");

    // The SID is the server's, and its existence is the whole assertion: it is only issued after
    // `AddTrackRequest` was accepted, which is where a codec or naming disagreement would surface.
    assert!(!sid.is_empty());

    probe.close().await;
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored`
Expected: FAIL to compile - no `probe` module.

- [ ] **Step 3: Write the probe**

Create `src-tauri/src/media/livekit/probe.rs`:

```rust
//! The Phase 0 probe engine: two peer connections driven by LiveKit signal events.
//!
//! Deliberately minimal. It answers the compatibility questions in the spec's Phase 0 and nothing
//! else - no reconnect, no roster, no stats. Phase 1 grows the real engine from what this learns.

use std::sync::Arc;

use livekit_api::signal_client::{SignalClient, SignalEvent, SignalEvents};
use livekit_protocol as proto;
use tokio::sync::{oneshot, Mutex};
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::media::voice::rtc::voice_api;

pub struct Probe {
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    /// Track SIDs the server has confirmed, keyed by the cid we asked under.
    published: Arc<Mutex<Vec<(String, String)>>>,
}

impl Probe {
    pub async fn connect(url: &str, token: &str) -> Result<Self, String> {
        let (signal, join, events) =
            SignalClient::connect(url, token, super::signal::connect_options(), None)
                .await
                .map_err(|e| e.to_string())?;

        // ICE servers come from the JoinResponse rather than from our own config. This is the
        // difference the spec calls out: there is no `/voice/ice-servers` read any more, and no
        // static list, because the node tells us what it is reachable on.
        let config = RTCConfiguration {
            ice_servers: join
                .ice_servers
                .iter()
                .map(|s| RTCIceServer {
                    urls: s.urls.clone(),
                    username: s.username.clone(),
                    credential: s.credential.clone(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };

        let api = voice_api()?;
        let publisher = Arc::new(api.new_peer_connection(config).await.map_err(|e| e.to_string())?);

        // LiveKit gates publisher readiness on these two existing. A publisher connection without
        // them negotiates and then never reaches connected, with nothing saying why.
        publisher.create_data_channel("_lossy", None).await.map_err(|e| e.to_string())?;
        publisher.create_data_channel("_reliable", None).await.map_err(|e| e.to_string())?;

        let signal = Arc::new(signal);
        let published = Arc::new(Mutex::new(Vec::new()));

        tokio::spawn(pump(events, signal.clone(), publisher.clone(), published.clone()));

        Ok(Self { signal, publisher, published })
    }

    pub async fn publish_audio(&self, name: &str) -> Result<String, String> {
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), ..Default::default() },
            name.to_string(),
            name.to_string(),
        ));
        let cid = track.id().to_string();

        // Request first: the server issues the SID, and adding the track before asking is what
        // produces a publication the roster never learns about.
        self.signal
            .send(proto::signal_request::Message::AddTrack(proto::AddTrackRequest {
                cid: cid.clone(),
                name: name.to_string(),
                r#type: proto::TrackType::Audio as i32,
                source: proto::TrackSource::Microphone as i32,
                ..Default::default()
            }))
            .await;

        self.publisher
            .add_track(track as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        self.negotiate().await?;
        self.await_sid(&cid).await
    }

    async fn negotiate(&self) -> Result<(), String> {
        let offer = self.publisher.create_offer(None).await.map_err(|e| e.to_string())?;
        self.publisher.set_local_description(offer.clone()).await.map_err(|e| e.to_string())?;
        self.signal
            .send(proto::signal_request::Message::Offer(proto::SessionDescription {
                r#type: "offer".to_string(),
                sdp: offer.sdp,
                ..Default::default()
            }))
            .await;
        Ok(())
    }

    async fn await_sid(&self, cid: &str) -> Result<String, String> {
        for _ in 0..50 {
            if let Some((_, sid)) =
                self.published.lock().await.iter().find(|(c, _)| c == cid).cloned()
            {
                return Ok(sid);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Err(format!("no TrackPublishedResponse for cid {cid} within 5s"))
    }

    pub async fn close(self) {
        self.signal.close().await;
        let _ = self.publisher.close().await;
    }
}

async fn pump(
    mut events: SignalEvents,
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    published: Arc<Mutex<Vec<(String, String)>>>,
) {
    while let Some(event) = events.recv().await {
        let SignalEvent::Message(message) = event else { break };
        match *message {
            proto::signal_response::Message::Answer(answer) => {
                let desc = RTCSessionDescription::answer(answer.sdp).expect("answer sdp");
                if let Err(e) = publisher.set_remote_description(desc).await {
                    eprintln!("[probe] publisher answer rejected: {e}");
                }
            }
            proto::signal_response::Message::TrackPublished(response) => {
                let sid = response.track.map(|t| t.sid).unwrap_or_default();
                published.lock().await.push((response.cid, sid));
            }
            proto::signal_response::Message::Trickle(trickle) => {
                eprintln!("[probe] trickle from server, target {}", trickle.target);
            }
            _ => {}
        }
    }
    let _ = signal;
}
```

Declare it in `mod.rs`:

```rust
pub mod probe;
```

- [ ] **Step 4: Make it compile**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit`
The protobuf field and variant names above are written from the crate's public API; correct them
against what the compiler reports rather than reshaping the flow. `voice_api()` and
`opus_capability()` may need to be made `pub(crate)` if they are not already.

- [ ] **Step 5: Send our own ICE candidates**

The offer above gathers candidates but never forwards them, so signalling completes and no media
ever flows. In `connect`, wrap the signal client in its `Arc` **before** building the peer
connection, then register:

```rust
        let signal = Arc::new(signal);

        let ice_signal = signal.clone();
        publisher.on_ice_candidate(Box::new(move |candidate| {
            let signal = ice_signal.clone();
            Box::pin(async move {
                // `None` is the end-of-candidates marker, which LiveKit does not want relayed.
                let Some(candidate) = candidate else { return };
                let Ok(init) = candidate.to_json() else { return };
                let Ok(json) = serde_json::to_string(&init) else { return };
                signal
                    .send(proto::signal_request::Message::Trickle(proto::TrickleRequest {
                        candidate_init: json,
                        target: proto::SignalTarget::Publisher as i32,
                        ..Default::default()
                    }))
                    .await;
            })
        }));
```

`candidate_init` is the JSON of an `RTCIceCandidateInit`, not the bare `candidate:` line - the
server parses it as an object and silently ignores a string it cannot read.

- [ ] **Step 6: Run the test and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored --nocapture`
Expected: PASS.

- [ ] **Step 7: Feed the track real audio**

An unfed track negotiates and proves only that signalling worked. Retain the track in `Probe` -
change `publish_audio` to push `track.clone()` into an `audio: Mutex<Vec<Arc<TrackLocalStaticSample>>>`
field before returning - and add:

```rust
    /// Send a 440 Hz tone for `duration`, one 20 ms Opus packet at a time.
    ///
    /// A tone rather than silence: Opus encodes true silence to a few bytes and a receiver that
    /// discards them looks identical to one that never got the stream. A tone is also what makes
    /// the listening check in this task's next step meaningful.
    pub fn pump_tone_for(&self, duration: std::time::Duration) {
        let audio = self.audio.clone();
        tokio::spawn(async move {
            let Some(track) = audio.lock().await.first().cloned() else { return };
            let mut encoder = crate::media::voice::codec::VoiceEncoder::new(32_000)
                .expect("opus encoder");

            // 20 ms at 48 kHz mono - the packetisation `media::voice::rtc` is built around.
            const SAMPLES: usize = 960;
            let mut pcm = [0f32; SAMPLES];
            let mut out = [0u8; 4000];
            let mut phase = 0f32;
            let deadline = std::time::Instant::now() + duration;

            while std::time::Instant::now() < deadline {
                for sample in pcm.iter_mut() {
                    phase += 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
                    *sample = (phase.sin()) * 0.25;
                }
                let len = encoder.encode(&pcm, &mut out).expect("encode");
                let _ = track
                    .write_sample(&webrtc::media::Sample {
                        data: bytes::Bytes::copy_from_slice(&out[..len]),
                        duration: std::time::Duration::from_millis(20),
                        ..Default::default()
                    })
                    .await;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        });
    }
```

Call it in the test before `close`, with a ten second duration, and hold the test open for the same
ten seconds.

- [ ] **Step 8: Verify a human can hear it**

Open LiveKit's meet client against `ws://127.0.0.1:7880` with a token for the same room, minted by
`dev_token` with a different identity, and listen while the test runs.

Expected: a clean 440 Hz tone. **This is the Opus compatibility answer** - record it for Task 8. A
tone that arrives distorted or chopped is a packetisation problem, not a codec one; capture the
answer SDP's `a=fmtp` line for the Opus payload before moving on.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/media/livekit/
git commit -m "test(voice): publish Opus to LiveKit over webrtc-rs"
```

---

### Task 6: Publish H.264 with three simulcast layers

**Files:**
- Modify: `src-tauri/src/media/livekit/probe.rs`, `src-tauri/src/media/livekit/probe_tests.rs`

**Interfaces:**
- Consumes: `Probe::connect`, `LAYER_RIDS` from Task 4.
- Produces: `Probe::publish_video(&self, name: &str, layers: &[(&str, u32, u32)]) -> Result<String, String>`
  where each tuple is `(rid, width, height)`.

- [ ] **Step 1: Write the failing test**

```rust
use crate::media::publisher::simulcast::LAYER_RIDS;

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn publishes_three_h264_layers_named_for_livekit() {
    let probe = Probe::connect(DEV_URL, &dev_token("probe-video", "user-1"))
        .await
        .expect("connect");

    let sid = probe
        .publish_video(
            "screen-abc123",
            &[
                (LAYER_RIDS[0], 1920, 1080),
                (LAYER_RIDS[1], 960, 540),
                (LAYER_RIDS[2], 480, 270),
            ],
        )
        .await
        .expect("publish");

    assert!(!sid.is_empty());

    probe.close().await;
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored`
Expected: FAIL to compile - no `publish_video`.

- [ ] **Step 3: Implement it**

Add to `probe.rs`:

```rust
    /// Publish H.264 as a simulcast ladder.
    ///
    /// The `layers` we declare are what the server maps rid to quality by; it does not read the rid
    /// names themselves. Highest first, matching `LAYER_RIDS`.
    pub async fn publish_video(
        &self,
        name: &str,
        layers: &[(&str, u32, u32)],
    ) -> Result<String, String> {
        let cid = format!("{name}-cid");

        self.signal
            .send(proto::signal_request::Message::AddTrack(proto::AddTrackRequest {
                cid: cid.clone(),
                name: name.to_string(),
                r#type: proto::TrackType::Video as i32,
                source: proto::TrackSource::ScreenShare as i32,
                width: layers[0].1,
                height: layers[0].2,
                layers: layers
                    .iter()
                    .enumerate()
                    .map(|(index, (_, width, height))| proto::VideoLayer {
                        quality: match index {
                            0 => proto::VideoQuality::High as i32,
                            1 => proto::VideoQuality::Medium as i32,
                            _ => proto::VideoQuality::Low as i32,
                        },
                        width: *width,
                        height: *height,
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }))
            .await;

        // One track per rid, sharing id and stream_id and differing only by rid. This is the same
        // construction `media::publisher::rtc` already uses; `add_encoding` rejects any other
        // combination, and the base track must itself carry a rid or the sender refuses with
        // ErrRTPSenderNoBaseEncoding.
        let mut layer_tracks: Vec<Arc<TrackLocalStaticSample>> = Vec::with_capacity(layers.len());
        for (rid, _, _) in layers {
            layer_tracks.push(Arc::new(TrackLocalStaticSample::new_with_rid(
                h264_capability(),
                "video".to_owned(),
                (*rid).to_owned(),
                name.to_string(),
            )));
        }

        let sender = self
            .publisher
            .add_track(Arc::clone(&layer_tracks[0]) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        // Every encoding has to be attached before the offer is created: the sender refuses one
        // afterwards (ErrRTPSenderSendAlreadyCalled), and the SDP is generated from whatever is
        // attached at that moment.
        for track in layer_tracks.iter().skip(1) {
            sender
                .add_encoding(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|e| format!("could not attach a simulcast layer: {e}"))?;
        }

        self.negotiate().await?;
        self.await_sid(&cid).await
    }
```

Import `h264_capability` from `crate::media::publisher::rtc` rather than declaring a second one -
the probe must offer exactly what the real publisher offers, or it answers the H.264 question for
code that does not exist.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored --nocapture`
Expected: PASS.

- [ ] **Step 5: Verify the layers exist and are selectable**

Feed the track real access units from `encoder_mf`. Open LiveKit's meet client as a second
participant, resize the tile small and then large, and watch the received resolution change.

Expected: three layers offered, and the served layer follows the tile. **This is the H.264 and
simulcast answer** - if H.264 fails to negotiate, capture the SDP of both offer and answer before
moving on; `packetization-mode` and `profile-level-id` are the two fields that matter.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/media/livekit/
git commit -m "test(voice): publish an H.264 simulcast ladder to LiveKit"
```

---

### Task 7: Subscribe to a remote audio track

**Files:**
- Modify: `src-tauri/src/media/livekit/probe.rs`, `src-tauri/src/media/livekit/probe_tests.rs`

**Interfaces:**
- Consumes: `Probe::connect`, `Probe::publish_audio`.
- Produces: `Probe::subscribe(&self, track_sid: &str) -> Result<(), String>` and
  `Probe::rtp_received(&self) -> u64`.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn receives_rtp_from_a_subscribed_track() {
    let room = "probe-subscribe";

    let publisher = Probe::connect(DEV_URL, &dev_token(room, "user-1")).await.expect("connect");
    let sid = publisher.publish_audio("audio").await.expect("publish");
    publisher.pump_tone_for(std::time::Duration::from_secs(10));

    let listener = Probe::connect(DEV_URL, &dev_token(room, "user-2")).await.expect("connect");
    listener.subscribe(&sid).await.expect("subscribe");

    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Packets, not a state. A subscriber that reaches `connected` and receives nothing is the exact
    // failure the counters in `PublicationStats` exist to tell apart, and the one a state-only
    // assertion would pass through.
    assert!(listener.rtp_received() > 0, "subscribed and connected, but no RTP arrived");

    listener.close().await;
    publisher.close().await;
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored`
Expected: FAIL to compile - no `subscribe` and no `rtp_received`.

- [ ] **Step 3: Implement the subscriber side**

In `Probe::connect`, build a **second** peer connection for subscription and register it with the
pump. The server offers on it, so the pump gains:

```rust
            proto::signal_response::Message::Offer(offer) => {
                let desc = RTCSessionDescription::offer(offer.sdp).expect("offer sdp");
                subscriber.set_remote_description(desc).await.expect("subscriber offer");
                let answer = subscriber.create_answer(None).await.expect("answer");
                subscriber.set_local_description(answer.clone()).await.expect("local answer");
                signal
                    .send(proto::signal_request::Message::Answer(proto::SessionDescription {
                        r#type: "answer".to_string(),
                        sdp: answer.sdp,
                        ..Default::default()
                    }))
                    .await;
            }
```

`subscribe` sends:

```rust
        self.signal
            .send(proto::signal_request::Message::Subscription(proto::UpdateSubscription {
                track_sids: vec![track_sid.to_string()],
                subscribe: true,
                ..Default::default()
            }))
            .await;
```

Count RTP in an `on_track` handler on the subscriber connection, incrementing an `AtomicU64` per
packet read.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit -- --ignored --nocapture`
Expected: PASS, with a non-zero packet count printed.

- [ ] **Step 5: Prove the test can fail**

Comment out the `subscribe` call and run again.
Expected: FAIL on the `rtp_received` assertion. A media test that passes with the subscribe removed
is testing nothing - see `project_media_e2e_test_traps`. Restore the call afterwards.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/media/livekit/
git commit -m "test(voice): pull RTP from a LiveKit subscription over webrtc-rs"
```

---

### Task 8: Record the answers and decide

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`

- [ ] **Step 1: Write the findings into the spec**

Add a section `## 7. Phase 0 findings, <date>` recording, for each, what happened and the evidence:

- Opus negotiated: yes/no, and what a listener heard.
- H.264 negotiated: yes/no, with the `profile-level-id` and `packetization-mode` from both SDPs.
- Three simulcast layers offered, and whether the served layer followed the tile size.
- TWCC present in the answer SDP, and whether the sender's bitrate moved under constraint.
- `single_pc_mode_active` and `subscriber_primary` from Task 3.
- `ice_servers` count from the JoinResponse.

- [ ] **Step 2: Take the decision the spec's exit criteria name**

If Opus, H.264 and congestion control are all green, the design stands and Phase 1 is planned as
written. If H.264 fails to negotiate, that is the fallback trigger: the design goes back to the
LiveKit Rust SDK and §1 is rewritten before any Phase 1 work starts.

If `single_pc_mode_active` was true, amend §2.3 - the publisher/subscriber split collapses to one
peer connection and Phase 1 shrinks.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md
git commit -m "docs(voice): Phase 0 findings"
```

- [ ] **Step 4: Write the Phase 1 plan**

Use the writing-plans skill against the amended spec.
