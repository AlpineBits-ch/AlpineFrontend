//! End-to-end proof that a screen share this client publishes reaches a viewer.
//!
//! Real frames, the real OpenH264 encoder, the real `webrtc-rs` transport, real SRTP, the shipping
//! pump and writer - and, for everything that touches the wire, **a real LiveKit server** on
//! `ws://127.0.0.1:7880`. Those tests are `#[ignore]`d with the same reason string as
//! `media::livekit::room_tests`; see `docker/livekit-dev/compose.yaml`.
//!
//! # Why the mock backend is gone
//!
//! This file used to stand up an HTTP server on loopback speaking `/voice/session` and
//! `/voice/tracks` with a stand-in SFU peer connection behind it. Neither route exists any more, and
//! more to the point a mock cannot answer the questions that are now interesting: whether the SFU
//! accepts our rid ladder, whether it keeps High 5.2 in the answer, and whether one participant may
//! carry the microphone and the share at once. Those are properties of *the server*, and asserting
//! them against something we wrote ourselves is the trap `project_media_e2e_test_traps` names -
//! several of the old assertions were satisfied by the mock's own recorded requests.
//!
//! # What is still covered without a server
//!
//! The pump's keyframe policy and the writer's failure handling need no transport at all, and both
//! exist because screen sharing broke twice with the whole suite green: a keyframe interval counted
//! in *frames* on a screen that produces almost none, and one full UDP send queue ending a
//! publication outright. In both cases the share reported "running" everywhere except on the wire,
//! and the sharer's own preview is drawn from the capture source and looked perfect throughout.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::RgbaImage;
use livekit_api::access_token::{AccessToken, VideoGrants};
use tokio::sync::mpsc;

use super::encoder::{
    new_software_encoder, provision_async, EncodeOutcome, EncodedChunk, EncoderContent, EncoderSpec,
    VideoEncoder,
};
use super::pump::{FramePump, PreviewSink, PumpLayer};
use super::rtc::{release_room, FrameSink, Publication};
use super::session::{run_writer, WRITE_FAILURES_BEFORE_GIVING_UP};
use super::simulcast::{self, Layer};
use crate::media::livekit::registry;
use crate::media::livekit::room::Room;

/// One access unit as a viewer reassembles it: the NAL units it contains, without start codes.
///
/// Start codes are stripped because the packetiser does not preserve their length - openh264 emits
/// a mix of three- and four-byte codes and the depacketiser writes four-byte codes throughout - and
/// a comparison that failed on that difference would be failing on nothing.
type AccessUnit = Vec<Vec<u8>>;

/// NAL unit type 5: a coded slice of an IDR picture. Nothing decodes until one arrives.
const NAL_IDR: u8 = 5;
/// Sequence and picture parameter sets. A viewer needs both before it can decode the IDR.
const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
/// Access unit delimiter and filler data. The payloader drops both by design (RFC 6184 §5.4) -
/// they carry no picture information - so they must be excluded from what we expect to arrive.
const NAL_AUD: u8 = 9;
const NAL_FILLER: u8 = 12;

fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map(|b| b & 0x1f).unwrap_or(0)
}

/// Split an Annex-B byte stream into its NAL unit bodies, dropping what the payloader drops.
fn nal_bodies(annex_b: &[u8]) -> AccessUnit {
    let mut starts: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + 3 <= annex_b.len() {
        if annex_b[i] == 0 && annex_b[i + 1] == 0 {
            if annex_b[i + 2] == 1 {
                starts.push((i, 3));
                i += 3;
                continue;
            }
            if i + 4 <= annex_b.len() && annex_b[i + 2] == 0 && annex_b[i + 3] == 1 {
                starts.push((i, 4));
                i += 4;
                continue;
            }
        }
        i += 1;
    }

    let mut nals = Vec::new();
    for (index, &(offset, code_len)) in starts.iter().enumerate() {
        let body_start = offset + code_len;
        let body_end = starts.get(index + 1).map(|&(n, _)| n).unwrap_or(annex_b.len());
        let body = &annex_b[body_start..body_end];
        if body.is_empty() {
            continue;
        }
        let kind = nal_type(body);
        if kind == NAL_AUD || kind == NAL_FILLER {
            continue;
        }
        nals.push(body.to_vec());
    }
    nals
}

// ── The live server ───────────────────────────────────────────────────────────────────────────

const DEV_URL: &str = "ws://127.0.0.1:7880";

/// Dev mode ships this fixed pair. It is not a secret, and it must never reach a config file a
/// release build reads - a client never signs its own join token.
const DEV_KEY: &str = "devkey";
const DEV_SECRET: &str = "secret";

/// Duplicated from `media::livekit::room_tests` rather than shared, because that module is a private
/// `#[cfg(test)] mod` and making it reachable would mean editing `livekit/`, which this change does
/// not own. Both copies must keep signing with the same dev pair or the server refuses the join.
fn dev_token(room: &str, identity: &str) -> String {
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

/// Take the room for `key` exactly as `start_screen_publish` does - through the registry, never by
/// connecting directly. Connecting directly is what the merge these tests guard exists to prevent.
async fn share_room(key: &str, room: &str, identity: &str) -> Arc<Room> {
    registry::acquire(key, DEV_URL, &dev_token(room, identity))
        .await
        .expect("the LiveKit server must accept the join")
}

/// Poll a room's RTP counter until something arrives or `patience` runs out.
///
/// Packets, not a connection state: a subscriber that reaches `connected` and receives nothing is a
/// different failure from one that never connected, and only a counter tells them apart.
async fn rtp_within(room: &Room, patience: Duration) -> u64 {
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let seen = room.stats.rtp_received.load(Ordering::Relaxed);
        if seen > 0 || tokio::time::Instant::now() >= deadline {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// What a third party can see other people publishing, once at least `want` tracks have shown up.
///
/// Polled rather than read once: the roster arrives on `JoinResponse` for anything published before
/// the join and on `ParticipantUpdate` for anything after, and which of those a freshly published
/// track lands in is the server's timing, not ours. Reading once turns that into a flaky test that
/// would fail as "the share opened a second identity" - the opposite of the finding.
async fn tracks_within(
    room: &Room,
    want: usize,
    patience: Duration,
) -> Vec<crate::media::livekit::room::RemoteTrack> {
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let seen = room.remote_tracks().await;
        if seen.len() >= want || tokio::time::Instant::now() >= deadline {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ── Test doubles ──────────────────────────────────────────────────────────────────────────────

/// Records every access unit on its way to the transport, so what is written can be inspected
/// rather than merely counted.
struct TeeSink<S: FrameSink> {
    inner: S,
    sent: Arc<Mutex<Vec<AccessUnit>>>,
}

impl<S: FrameSink> FrameSink for TeeSink<S> {
    async fn write_frame(&self, data: Vec<u8>, duration: Duration) -> Result<(), String> {
        // Scoped, so the guard is provably gone before the await and the future stays Send.
        {
            let mut sent = self.sent.lock().unwrap();
            sent.push(nal_bodies(&data));
        }
        self.inner.write_frame(data, duration).await
    }

    async fn stop(self) {
        self.inner.stop().await;
    }
}

/// A transport that fails the first `failures` writes and then works.
///
/// The failure this stands in for is a full UDP send queue - `WSAENOBUFS`, os error 10055 - which
/// cannot be provoked from outside the socket.
struct FailingSink {
    failures: u32,
    writes: Arc<AtomicU32>,
    delivered: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
}

impl FrameSink for FailingSink {
    async fn write_frame(&self, _data: Vec<u8>, _duration: Duration) -> Result<(), String> {
        let attempt = self.writes.fetch_add(1, Ordering::Relaxed);
        if attempt < self.failures {
            return Err("os error 10055".to_owned());
        }
        self.delivered.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn stop(self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct EncoderLog {
    /// How many times a keyframe was asked for.
    keyframe_requests: u32,
    /// Encode calls seen.
    encodes: u32,
    /// The encode index (1-based) of every frame emitted as a keyframe.
    keyframes_at: Vec<u32>,
}

/// An encoder that always produces output and records what it was asked for.
///
/// Used where the assertion is about the pump's policy rather than about the bitstream, so a real
/// codec's rate control cannot make the test flaky.
struct RecordingEncoder {
    log: Arc<Mutex<EncoderLog>>,
    pending_keyframe: bool,
    /// Bytes per emitted frame, for the backlog test.
    payload: usize,
}

impl VideoEncoder for RecordingEncoder {
    fn encode(&mut self, _frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome {
        let is_keyframe = std::mem::take(&mut self.pending_keyframe);
        let mut log = self.log.lock().unwrap();
        log.encodes += 1;
        if is_keyframe {
            let index = log.encodes;
            log.keyframes_at.push(index);
        }

        let mut data = vec![0, 0, 0, 1, if is_keyframe { 0x65 } else { 0x41 }];
        data.resize(self.payload.max(5), 0xaa);
        EncodeOutcome::Chunk(EncodedChunk {
            data,
            is_keyframe,
            timestamp_us,
        })
    }

    fn request_keyframe(&mut self) {
        self.log.lock().unwrap().keyframe_requests += 1;
        self.pending_keyframe = true;
    }

    fn reconfigure(&mut self, _spec: EncoderSpec) -> Result<(), String> {
        Ok(())
    }

    fn name(&self) -> &'static str {
        "recording"
    }
}

fn recording_encoder() -> (Box<dyn VideoEncoder>, Arc<Mutex<EncoderLog>>) {
    let log = Arc::new(Mutex::new(EncoderLog::default()));
    (
        Box::new(RecordingEncoder {
            log: Arc::clone(&log),
            pending_keyframe: false,
            // Big enough to survive the wire: the depacketiser rejects anything of two bytes or
            // fewer as a short packet, so a token NAL would vanish between the two ends and read as
            // "nothing arrived".
            payload: 256,
        }),
        log,
    )
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/// Small on purpose. The whole path runs over loopback UDP, and a 1080p keyframe is hundreds of
/// packets handed to the socket at once - which is the very burst that used to kill a publication.
/// Proving the path works should not depend on surviving it.
const WIDTH: u32 = 320;
const HEIGHT: u32 = 240;

fn spec() -> EncoderSpec {
    EncoderSpec {
        width: WIDTH,
        height: HEIGHT,
        fps: 30,
        kbps: 800,
        content: EncoderContent::Text,
    }
}

/// A source big enough to ladder three ways, for the tests that are about the SDP rather than the
/// bitstream. 320x240 quarters below the layer floor and would silently publish fewer rungs.
fn laddered_spec() -> EncoderSpec {
    EncoderSpec {
        width: 1920,
        height: 1080,
        fps: 30,
        kbps: 2600,
        content: EncoderContent::Text,
    }
}

/// The ladder as `session::start` builds it - the shipping function, not a hand-written list, so a
/// change to the rid vocabulary or the rung geometry lands here too.
fn ladder(base: EncoderSpec, rungs: usize) -> Vec<Layer> {
    let built = simulcast::layers_for(base, rungs);
    assert_eq!(built.len(), rungs, "the fixture asked for a ladder it cannot have");
    built
}

/// A frame with structure that moves, so the encoder has something to code and successive frames
/// are genuinely different.
fn frame(shift: u32) -> RgbaImage {
    RgbaImage::from_fn(WIDTH, HEIGHT, |x, y| {
        let v = (((x + shift) / 8 + y / 8) % 2) as u8;
        image::Rgba([v * 255, (x % 256) as u8, ((y + shift) % 256) as u8, 255])
    })
}

/// Feed `count` frames through the pump at `interval`, as a capture thread would.
async fn pump_frames<P: PreviewSink>(
    pump: &mut FramePump<P>,
    count: u32,
    interval: Duration,
    first_shift: u32,
) {
    for i in 0..count {
        pump.on_frame(&frame(first_shift + i));
        tokio::time::sleep(interval).await;
    }
}

// ── What the SFU is told ──────────────────────────────────────────────────────────────────────

/// Three encodings on one m-line, under the rid names the ladder declares, **and accepted**.
///
/// <p>Asserted on the SDP rather than on our own structs, because the SDP is the only thing the SFU
/// actually reads. `webrtc-rs` writes `a=rid:<id> send` and `a=simulcast:send f;h;q` from what is
/// attached to the *sender*, so a wiring mistake that created three tracks and attached one would
/// leave `layer_tracks()` looking perfectly correct while the wire carried a single encoding - and
/// the only visible symptom would be an egress bill that never fell.</p>
///
/// <p>The answer half is what a mock could never establish. LiveKit maps rid to quality through the
/// `layers` list in `AddTrackRequest`, not through the strings, so "the server accepted three rids
/// in our order" is a statement about the server.</p>
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn offers_three_rid_tagged_encodings_on_one_track() {
    let key = "guild:e2e:simulcast";
    let room = share_room(key, "pub-simulcast", "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 3),
        false,
    )
    .await
    .expect("the publication must start");

    let offer = room.local_sdp().await.expect("an offer must have been made");
    assert!(
        offer.contains("a=simulcast:send f;h;q"),
        "no simulcast attribute in the offer:\n{offer}"
    );
    for rid in ["f", "h", "q"] {
        assert!(
            offer.contains(&format!("a=rid:{rid} send")),
            "no rid {rid} in the offer:\n{offer}"
        );
    }
    // One video m-line, not three: simulcast is encodings within a track, not separate tracks.
    // Three m-lines would mean three track names, which is a shape the room contract has no room
    // for.
    assert_eq!(offer.matches("m=video").count(), 1);
    assert_eq!(publication.layer_tracks().len(), 3);

    let answer = room.remote_sdp().await.expect("an answer must have been applied");
    assert!(
        answer.contains("a=simulcast:recv f;h;q"),
        "the server did not accept all three rids in our order:\n{answer}"
    );

    publication.stop().await;
}

/// The offer must negotiate the RID header extension, or the ladder is decorative.
///
/// <p><b>This is the half `offers_three_rid_tagged_encodings_on_one_track` cannot see.</b> The
/// `a=rid:`/`a=simulcast:` attributes are written from what is attached to the sender and say what
/// the publisher *intends* to send. What tells the SFU which layer a given packet belongs to is the
/// `sdes:rtp-stream-id` RTP header extension, and `TrackLocalStaticRTP::bind` only stamps it onto
/// outgoing packets when that URI is among the negotiated extensions - see
/// `track_local_static_rtp.rs`, which looks the id up and silently writes no rid when it is
/// absent.</p>
///
/// <p>`MediaEngine::register_default_codecs` does not register it. So without an explicit
/// `register_header_extension`, an offer advertises three encodings, an SFU accepts all three, and
/// then every packet arrives untagged on one SSRC set that cannot be demultiplexed. Nothing errors:
/// the publish succeeds, the answer echoes the rids back, and viewers simply never receive a
/// decodable layer - a tile that loads forever rather than a tile that fails.</p>
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn offers_the_rid_header_extension_that_makes_layers_identifiable() {
    let key = "guild:e2e:ridext";
    let room = share_room(key, "pub-ridext", "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 3),
        false,
    )
    .await
    .expect("the publication must start");

    let offer = room.local_sdp().await.expect("an offer");
    // The mid extension is required alongside it: a stream id is scoped to an m-line, so an SFU
    // needs both to place a packet. webrtc-rs refuses inbound simulcast without either, and the
    // same pairing is what makes outbound identifiable.
    for uri in [
        "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
        "urn:ietf:params:rtp-hdrext:sdes:mid",
    ] {
        assert!(
            offer.contains(uri),
            "the offer advertises three encodings but never negotiates {uri}, \
             so every packet leaves without a layer tag:\n{offer}"
        );
    }

    publication.stop().await;
}

/// The rollback path. One layer must offer exactly what shipped before simulcast existed.
///
/// <p>`Room::publish_video` builds every rung with `new_with_rid`, including a lone one - unlike the
/// Cloudflare path, which had a separate ridless constructor for it. That is only safe because
/// `webrtc-rs` writes rid and simulcast attributes from a sender holding *more than one* encoding,
/// so a single rung produces neither. This is the test that says so.</p>
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_single_layer_offers_no_simulcast_attributes_at_all() {
    let key = "guild:e2e:onelayer";
    let room = share_room(key, "pub-onelayer", "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 1),
        false,
    )
    .await
    .expect("the publication must start");

    let offer = room.local_sdp().await.expect("an offer");
    assert!(
        !offer.contains("a=simulcast:"),
        "a one-layer share advertised simulcast:\n{offer}"
    );
    assert!(
        !offer.contains("a=rid:"),
        "a one-layer share advertised a rid:\n{offer}"
    );
    assert_eq!(publication.layer_tracks().len(), 1);

    publication.stop().await;
}

/// The negotiated profile and level, read off the answer and kept.
///
/// A bitstream above the level the answer kept is a black tile rather than a soft one, and it is
/// invisible from the sending side without this. LiveKit forwards opaquely and keeps the High 5.2
/// entry our media engine offers; if this ever fails, `encoder_mf`'s profile has to move with it.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn keeps_the_profile_level_the_answer_agreed_to() {
    let key = "guild:e2e:profile";
    let room = share_room(key, "pub-profile", "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 3),
        false,
    )
    .await
    .expect("the publication must start");

    let profile = publication
        .profile_level_id()
        .expect("the answer named a profile and the publication must have kept it");
    assert!(
        profile.len() == 6 && u32::from_str_radix(&profile, 16).is_ok(),
        "profile-level-id must be the six hex digits the answer carried, got {profile}"
    );

    publication.stop().await;
}

// ── One participant, two publications ─────────────────────────────────────────────────────────

/// **The §2.1 merge.** The share must publish on the participant the microphone is already on.
///
/// <p>This is the whole point of routing the publisher through the registry. Under Cloudflare the
/// share opened a session of its own, which is a second *identity*, and
/// `VoiceShareSnapshot.mediaSessionId` exists only to tell other clients which of a user's sessions
/// a share is on. A share that opens its own LiveKit connection would restore that - and worse,
/// since a second connection under the same identity evicts the first, it would take the microphone
/// down with it.</p>
///
/// <p>Asserted from a third party's point of view, because that is the only place the failure is
/// visible: from this side two connections look exactly like one.</p>
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn the_share_publishes_on_the_participant_the_microphone_is_on() {
    let key = "guild:e2e:merge";
    let name = "pub-merge";

    // The microphone gets there first, as it almost always does.
    let mic = share_room(key, name, "user-1").await;
    mic.publish_audio("audio")
        .await
        .expect("the microphone must publish");

    // The share asks for the same target and must be handed the live connection.
    let share = share_room(key, name, "user-1").await;
    assert!(
        Arc::ptr_eq(&mic, &share),
        "the registry opened a second connection for a room it already held"
    );

    let publication = Publication::start(
        Arc::clone(&share),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 3),
        true,
    )
    .await
    .expect("the publication must start");

    // A few frames down the top rung before anybody looks. A LiveKit video track is announced to the
    // room when its primary layer starts carrying RTP, not when `AddTrackRequest` is accepted, so a
    // share that has published and never encoded is genuinely not in the roster yet - and asserting
    // before that point fails as "the share opened a second identity", which is the opposite of the
    // finding.
    share
        .wait_until_connected(Duration::from_secs(15))
        .await
        .expect("the publisher must reach connected");
    let top = publication.layer_tracks().remove(0);
    for _ in 0..10 {
        Publication::write_layer(&top, vec![0, 0, 0, 1, 0x65], Duration::from_millis(33))
            .await
            .expect("a frame must reach the top rung");
        tokio::time::sleep(Duration::from_millis(33)).await;
    }

    let viewer = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("a viewer must be able to join");
    let remote = tracks_within(&viewer, 3, Duration::from_secs(10)).await;

    let identities: std::collections::BTreeSet<&str> =
        remote.iter().map(|t| t.identity.as_str()).collect();
    assert_eq!(
        identities.len(),
        1,
        "the share opened a second identity; the room sees {identities:?}"
    );
    assert_eq!(identities.iter().next().copied(), Some("user-1"));

    let names: std::collections::BTreeSet<&str> =
        remote.iter().map(|t| t.track_name.as_str()).collect();
    for expected in ["audio", "screen-abc", "screen-audio-abc"] {
        assert!(
            names.contains(expected),
            "one participant must carry all three tracks; got {names:?}"
        );
    }

    viewer.close().await;
    publication.stop().await;
    // The microphone's hold, which the share's teardown must not have taken with it.
    assert!(registry::is_held(key).await, "the share's teardown closed the microphone's room");
    release_room(key).await;
}

/// A share that carries its own sound publishes both halves and forgets both.
///
/// <p>Closing only the video would leave viewers holding a live audio track from a share that no
/// longer exists - silent, but still subscribed, still mixed, and still counted against the sharer's
/// egress. Asserted through `Room::local_track`, because a forgotten name is what stops a later
/// write going to a sender nobody reads.</p>
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_share_with_audio_publishes_and_unpublishes_both_tracks() {
    let key = "guild:e2e:audioshare";
    let room = share_room(key, "pub-audioshare", "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 1),
        true,
    )
    .await
    .expect("the publication must start");

    assert_eq!(
        publication.audio_track_name.as_deref(),
        Some("screen-audio-abc"),
        "the audio half must be named for the share it belongs to"
    );
    assert!(
        publication.audio_track().is_some(),
        "an audio share must expose a track for the writer to feed"
    );
    assert!(room.local_track("screen-audio-abc").await.is_some());
    assert!(!room.local_ladder("screen-abc").await.is_empty());

    // Held past the teardown on purpose, so the room survives to be inspected. `stop` releases the
    // publication's hold; this one is what keeps the connection open.
    let held = share_room(key, "pub-audioshare", "user-1").await;
    publication.stop().await;

    assert!(
        held.local_ladder("screen-abc").await.is_empty(),
        "the video half is still writable after the share ended"
    );
    assert!(
        held.local_track("screen-audio-abc").await.is_none(),
        "the audio half is still writable after the share ended"
    );

    drop(held);
    release_room(key).await;
}

/// The other half of the same rule: no audio asked for, no audio track announced.
///
/// A track that exists and never carries anything is worse than one that was never announced -
/// viewers read `shares[].trackNames` and would open a decoder and a mixer slot for silence.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_share_without_audio_announces_no_audio_track() {
    let key = "guild:e2e:noaudio";
    let name = "pub-noaudio";
    let room = share_room(key, name, "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 1),
        false,
    )
    .await
    .expect("the publication must start");

    assert!(publication.audio_track_name.is_none());
    assert!(publication.audio_track().is_none());

    let viewer = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("a viewer must be able to join");
    let names: Vec<String> = tracks_within(&viewer, 1, Duration::from_secs(10))
        .await
        .into_iter()
        .map(|t| t.track_name)
        .collect();
    assert_eq!(names, vec!["screen-abc".to_string()]);

    viewer.close().await;
    publication.stop().await;
}

/// The merge against a real connection, not a synthetic report. A publication that negotiated three
/// rungs must produce at least one outbound video row for `publish_stats` to pair the ladder
/// against, whatever the wire says about the other two.
///
/// <p>Asserted on `pc.get_stats()` directly rather than through `publish_stats` itself: the command
/// reads its sources from `mod.rs`'s global `active()` handle, and no test may set that handle
/// without racing every other test in the binary that touches the same publish state. Reading the
/// report is the same data `publish_stats` would merge, so this still proves the transport half is
/// really there to be paired with the ladder - only the pairing itself is covered by `stats_tests`
/// in `mod.rs`.</p>
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_started_publication_reports_at_least_one_outbound_video_stream() {
    let key = "guild:e2e:stats";
    let room = share_room(key, "pub-stats", "user-1").await;

    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(laddered_spec(), 3),
        false,
    )
    .await
    .expect("the publication must start");

    // `get_stats()` only reports an outbound stream once the sender's RTP transport is actually up.
    // Publishing having returned is not that: the SID arrives on `TrackPublishedResponse`, which the
    // server can send before its answer, let alone before ICE and DTLS finish.
    room.wait_until_connected(Duration::from_secs(15))
        .await
        .expect("the publisher must reach connected");

    // And even connected, webrtc-rs's stats interceptor only starts tracking an SSRC once it has
    // actually carried a packet - a track that has never been written to has nothing to report,
    // same as a rung the pump never got a frame to encode.
    publication
        .write_frame(vec![0, 0, 0, 1, 0x65], Duration::from_millis(33))
        .await
        .expect("a frame should reach the transport");

    let report = publication.peer_connection().get_stats().await;
    let outbound = report
        .reports
        .values()
        .filter(|v| matches!(v, webrtc::stats::StatsReportType::OutboundRTP(s) if s.kind == "video"))
        .count();

    assert!(
        outbound > 0,
        "a started publication reports at least one outbound video stream"
    );

    publication.stop().await;
}

// ── End to end ────────────────────────────────────────────────────────────────────────────────

/// The pump, the writer and a live publication, wired as `session::start` wires them.
struct Publishing {
    pump: FramePump<()>,
    sent: Arc<Mutex<Vec<AccessUnit>>>,
    /// The server's id for the video track, which is what a viewer subscribes by.
    video_sid: String,
    keyframe_wanted: Arc<AtomicBool>,
}

async fn publishing(
    room: Arc<Room>,
    key: &str,
    keyframe_interval: Duration,
    encoder: Box<dyn VideoEncoder>,
) -> Publishing {
    let publication = Publication::start(room, key.to_owned(), "abc", &ladder(spec(), 1), false)
        .await
        .expect("the publication must start against the LiveKit server");
    let keyframe_wanted = publication.keyframe_requests();
    let video_sid = publication.video_sid.clone();

    let sent = Arc::new(Mutex::new(Vec::new()));
    let (frame_tx, frame_rx) = mpsc::channel::<(Vec<u8>, Duration)>(2);
    tokio::spawn(run_writer(
        TeeSink {
            inner: publication,
            sent: Arc::clone(&sent),
        },
        frame_rx,
    ));

    let pump = FramePump::new(
        vec![PumpLayer {
            encoder,
            frame_tx,
            width: WIDTH,
            height: HEIGHT,
        }],
        Arc::new(AtomicU32::new(30)),
        Arc::clone(&keyframe_wanted),
        (),
    )
    .with_keyframe_interval(keyframe_interval);

    Publishing {
        pump,
        sent,
        video_sid,
        keyframe_wanted,
    }
}

/// The real codec, for the assertions that are about the bitstream.
async fn real_encoder() -> Box<dyn VideoEncoder> {
    provision_async().await;
    new_software_encoder(spec()).expect("the software encoder")
}

/// The far end's own report of what it received, or `None` until one arrives.
///
/// An RTCP receiver report is the SFU telling us, unprompted, how our stream is arriving. It is the
/// only evidence available from this process that packets were *received* rather than merely handed
/// to a socket - see the note on `a_published_screen_reaches_the_sfu_end_to_end` for why a viewer in
/// this process cannot supply it.
async fn far_end_report(
    connection: &Arc<webrtc::peer_connection::RTCPeerConnection>,
    patience: Duration,
) -> Option<(u64, bool)> {
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let report = connection.get_stats().await;
        let sent: u64 = report
            .reports
            .values()
            .filter_map(|v| match v {
                webrtc::stats::StatsReportType::OutboundRTP(s) if s.kind == "video" => {
                    Some(s.packets_sent)
                }
                _ => None,
            })
            .sum();
        let acknowledged = report
            .reports
            .values()
            .any(|v| matches!(v, webrtc::stats::StatsReportType::RemoteInboundRTP(_)));

        if (sent > 0 && acknowledged) || tokio::time::Instant::now() >= deadline {
            return (sent > 0).then_some((sent, acknowledged));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The one that matters: real frames in one end, RTP off the machine and acknowledged out the other.
///
/// Every stage of the publish path is real - the OpenH264 encoder, the pump, the bounded queue, the
/// writer, the peer connection, SRTP, the RTP packetiser and a real SFU - and the assertion is on
/// what left rather than on any counter this side keeps about what it produced. Both failures screen
/// sharing has actually suffered were invisible to a producing counter: `write_sample` returns `Ok`
/// into a transport that never came up.
///
/// <p><b>Why the viewer is not in this process.</b> The old Cloudflare version compared a viewer's
/// reassembled access units byte for byte against what was written, because the stand-in SFU was a
/// plain peer connection this file owned. A `Room` cannot stand in for it, for two independent
/// reasons, and both are by design: its subscriber connection is built from `voice_api`, whose media
/// engine has no Constrained High entry and so answers our own video m-line away; and §2.1 of the
/// migration says the Rust room subscribes to **audio only** because video receive belongs to the
/// webview. A Rust viewer of a Rust screen share is a thing that must never work.</p>
///
/// <p>So the receiving evidence is the SFU's own RTCP receiver report, which is unprompted and
/// cannot be produced by a transport that is not carrying the stream. What is genuinely lost is the
/// NAL-for-NAL comparison; the parameter-set check below is on what was written, and a real viewer
/// is a job for the webview's own tests.</p>
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_published_screen_reaches_the_sfu_end_to_end() {
    let key = "guild:e2e:endtoend";
    let name = "pub-endtoend";
    let room = share_room(key, name, "user-1").await;
    let publication = Publication::start(
        Arc::clone(&room),
        key.to_owned(),
        "abc",
        &ladder(spec(), 1),
        false,
    )
    .await
    .expect("the publication must start");

    room.wait_until_connected(Duration::from_secs(15))
        .await
        .expect("the publisher must reach connected");

    // A viewer, so the SFU is actually forwarding rather than merely accepting. It cannot decode the
    // stream from this process - see the note above - but a subscribed track is what makes the SFU
    // do the work a real one would.
    let viewer = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("a viewer must be able to join");
    viewer.subscribe(&publication.video_sid).await;

    let sent = Arc::new(Mutex::new(Vec::new()));
    let (frame_tx, frame_rx) = mpsc::channel::<(Vec<u8>, Duration)>(2);
    let keyframe_wanted = publication.keyframe_requests();
    let connection = publication.peer_connection();

    let mut pump = FramePump::new(
        vec![PumpLayer {
            encoder: real_encoder().await,
            frame_tx,
            width: WIDTH,
            height: HEIGHT,
        }],
        Arc::new(AtomicU32::new(30)),
        keyframe_wanted,
        (),
    )
    .with_keyframe_interval(Duration::from_secs(60));

    // The shipping writer, holding the real publication, exactly as `session::start` wires it.
    let tee = TeeSink {
        inner: publication,
        sent: Arc::clone(&sent),
    };
    let writing = tokio::spawn(run_writer(tee, frame_rx));

    // Pumped *while* the far end is waited on. A receiver report takes a second or two to come back,
    // and a share that had already stopped sending by then would be scored as "nothing arrived" -
    // which is this test's failure message and would be a lie.
    let pumping = tokio::spawn(async move {
        pump_frames(&mut pump, 400, Duration::from_millis(20), 0).await;
    });

    let seen = far_end_report(&connection, Duration::from_secs(15)).await;
    pumping.abort();

    let (packets, acknowledged) = seen.expect(
        "the share signalled correctly and transported nothing; from this side that looks \
         exactly like a working share",
    );
    assert!(
        acknowledged,
        "{packets} packets were sent and the SFU never reported receiving any of them"
    );

    // A viewer cannot decode anything until it has the parameter sets and an IDR, and the first
    // thing it ever sees is the first thing sent. This is the difference between a share that
    // appears at once and one that sits on a placeholder.
    let written = sent.lock().unwrap().clone();
    assert!(!written.is_empty(), "nothing was ever written to the transport");
    let first: Vec<u8> = written[0].iter().map(|nal| nal_type(nal)).collect();
    for required in [NAL_SPS, NAL_PPS, NAL_IDR] {
        assert!(
            first.contains(&required),
            "the first access unit a viewer receives must carry SPS, PPS and an IDR; got {first:?}"
        );
    }

    viewer.close().await;
    writing.abort();
}

/// A viewer that joins mid-share asks for a keyframe over RTCP, and the request must reach us.
///
/// <p>Discarding those requests means waiting out whatever periodic IDR the encoder happens to
/// emit, which on a static screen is the forty-five-second wait this whole area exists to close.
/// The request now arrives on a connection this module does not own, read off
/// `Room::publisher_connection` - so this is also the test that says that connection really is
/// readable from here.</p>
///
/// <p>The recording encoder, not the real one, and the wall-clock floor pushed out of reach: after
/// the opening frame the *only* thing in the system that can produce a keyframe is the viewer's
/// request. With openh264 here the assertion would pass whether or not the RTCP path works at all -
/// a moving screen makes it emit intra frames of its own accord, which is exactly how a test like
/// this ends up proving nothing.</p>
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_viewer_that_joins_late_gets_a_keyframe_on_request() {
    let key = "guild:e2e:keyframe";
    let name = "pub-keyframe";
    let room = share_room(key, name, "user-1").await;

    let (encoder, log) = recording_encoder();
    let mut publishing = publishing(Arc::clone(&room), key, Duration::from_secs(600), encoder).await;

    room.wait_until_connected(Duration::from_secs(15))
        .await
        .expect("the publisher must reach connected");

    // Get the stream into delta frames, and let the opening keyframe through.
    pump_frames(&mut publishing.pump, 10, Duration::from_millis(20), 0).await;
    assert_eq!(
        log.lock().unwrap().keyframes_at,
        vec![1],
        "only the opening frame should be a keyframe so far"
    );
    publishing.keyframe_wanted.store(false, Ordering::Relaxed);

    let viewer = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("a viewer must be able to join");
    viewer.subscribe(&publishing.video_sid).await;

    // Long enough for the subscriber's transport to come up and for the SFU to notice it has no
    // decodable picture to hand it.
    pump_frames(&mut publishing.pump, 150, Duration::from_millis(20), 10).await;

    assert!(
        log.lock().unwrap().keyframes_at.len() >= 2,
        "the viewer's PLI never reached the encoder; a late joiner would sit on a placeholder \
         until the periodic keyframe, which on a static screen can be a minute away"
    );

    viewer.close().await;
}

// ── Pump policy ───────────────────────────────────────────────────────────────────────────────

fn pump_with(
    encoder: Box<dyn VideoEncoder>,
    keyframe_wanted: Arc<AtomicBool>,
    queue: usize,
) -> (FramePump<()>, mpsc::Receiver<(Vec<u8>, Duration)>) {
    let (frame_tx, frame_rx) = mpsc::channel::<(Vec<u8>, Duration)>(queue);
    let pump = FramePump::new(
        vec![PumpLayer {
            encoder,
            frame_tx,
            width: WIDTH,
            height: HEIGHT,
        }],
        Arc::new(AtomicU32::new(30)),
        keyframe_wanted,
        (),
    );
    (pump, frame_rx)
}

/// A share whose first frame is a delta frame shows every viewer nothing until the next IDR.
#[tokio::test]
async fn the_first_frame_of_a_share_is_a_keyframe() {
    let (encoder, log) = recording_encoder();
    let (mut pump, _rx) = pump_with(encoder, Arc::new(AtomicBool::new(false)), 8);

    pump.on_frame(&frame(0));

    let log = log.lock().unwrap();
    assert_eq!(
        log.keyframes_at,
        vec![1],
        "the very first frame of a share must be a keyframe, not the first one after an interval"
    );
}

/// The keyframe floor is wall-clock, not a frame count.
///
/// Both encoders express their keyframe interval in frames, and a still desktop produces a handful
/// of frames a second - so an interval meant to be two seconds became forty-five. What a viewer
/// waits is the wall clock.
#[tokio::test]
async fn a_still_screen_still_gets_a_keyframe_on_the_wall_clock() {
    let (encoder, log) = recording_encoder();
    let (pump, _rx) = pump_with(encoder, Arc::new(AtomicBool::new(false)), 8);
    let mut pump = pump.with_keyframe_interval(Duration::from_millis(80));

    // Frame 1 opens the share, frame 2 follows immediately and must not be a keyframe.
    pump.on_frame(&frame(0));
    pump.on_frame(&frame(1));
    assert_eq!(
        log.lock().unwrap().keyframes_at,
        vec![1],
        "a frame arriving straight after a keyframe must not force another"
    );

    // Barely any frames, but plenty of time. This is the static-desktop case exactly.
    tokio::time::sleep(Duration::from_millis(120)).await;
    pump.on_frame(&frame(2));

    assert_eq!(
        log.lock().unwrap().keyframes_at,
        vec![1, 3],
        "the interval elapsed, so the third frame must be a keyframe regardless of how few frames \
         the screen produced"
    );
}

/// A viewer's RTCP request reaches the encoder, which lives on another thread entirely.
#[tokio::test]
async fn a_keyframe_request_from_a_viewer_reaches_the_encoder() {
    let (encoder, log) = recording_encoder();
    let wanted = Arc::new(AtomicBool::new(false));
    let (pump, _rx) = pump_with(encoder, Arc::clone(&wanted), 8);
    let mut pump = pump.with_keyframe_interval(Duration::from_secs(600));

    pump.on_frame(&frame(0));
    pump.on_frame(&frame(1));

    wanted.store(true, Ordering::Relaxed);
    pump.on_frame(&frame(2));
    pump.on_frame(&frame(3));

    let log = log.lock().unwrap();
    assert_eq!(
        log.keyframes_at,
        vec![1, 3],
        "the request must be served on the next frame and then cleared, not served forever"
    );
}

/// Capture must never wait for the network.
///
/// Dropping the newest frame when the writer is behind keeps latency bounded, which for a live
/// screen matters far more than completeness.
#[tokio::test]
async fn a_backlog_drops_frames_rather_than_stalling_capture() {
    let (encoder, _log) = recording_encoder();
    // Nothing ever drains this, so after the queue fills every frame must be dropped.
    let (mut pump, _rx) = pump_with(encoder, Arc::new(AtomicBool::new(false)), 2);

    let started = std::time::Instant::now();
    for i in 0..40 {
        pump.on_frame(&frame(i));
    }
    let elapsed = started.elapsed();

    let stats = pump.counters().snapshot()[0];
    assert_eq!(stats.encoded_frames, 40, "every frame should still be encoded");
    assert_eq!(
        stats.dropped_frames, 38,
        "the queue holds two, so the other 38 must be dropped rather than queued"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "capture blocked for {elapsed:?} on a writer that never drained"
    );
}

// ── Writer resilience ─────────────────────────────────────────────────────────────────────────

fn failing_writer(
    failures: u32,
) -> (
    mpsc::Sender<(Vec<u8>, Duration)>,
    tokio::task::JoinHandle<()>,
    Arc<AtomicU32>,
    Arc<AtomicBool>,
) {
    let delivered = Arc::new(AtomicU32::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<(Vec<u8>, Duration)>(256);
    let handle = tokio::spawn(run_writer(
        FailingSink {
            failures,
            writes: Arc::new(AtomicU32::new(0)),
            delivered: Arc::clone(&delivered),
            stopped: Arc::clone(&stopped),
        },
        rx,
    ));
    (tx, handle, delivered, stopped)
}

/// One keyframe is hundreds of packets handed to the socket at once, and Windows answers
/// `WSAENOBUFS` when its send queue is momentarily full. That used to end the share outright - and
/// the viewer sat on a placeholder forever while this side went on encoding perfectly happily.
#[tokio::test]
async fn a_burst_of_write_failures_does_not_end_the_publication() {
    let (tx, handle, delivered, stopped) = failing_writer(WRITE_FAILURES_BEFORE_GIVING_UP - 1);

    for _ in 0..(WRITE_FAILURES_BEFORE_GIVING_UP + 10) {
        tx.send((vec![0, 0, 0, 1, 0x41], Duration::from_millis(33)))
            .await
            .expect("the writer must still be listening");
    }
    drop(tx);
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("the writer must finish once the queue closes")
        .expect("the writer must not panic");

    assert!(
        delivered.load(Ordering::Relaxed) >= 10,
        "the burst was survivable and the frames after it should have been delivered; only {} were",
        delivered.load(Ordering::Relaxed)
    );
    assert!(stopped.load(Ordering::Relaxed), "the sink must be stopped on the way out");
}

/// The other side of the same constant: a connection that has genuinely gone away must be torn
/// down rather than encoded into forever.
#[tokio::test]
async fn a_dead_connection_ends_the_publication() {
    let (tx, handle, delivered, stopped) = failing_writer(u32::MAX);

    for _ in 0..(WRITE_FAILURES_BEFORE_GIVING_UP + 10) {
        // The writer is expected to give up partway through, which closes the receiver.
        if tx
            .send((vec![0, 0, 0, 1, 0x41], Duration::from_millis(33)))
            .await
            .is_err()
        {
            break;
        }
    }

    // Deliberately without dropping the sender: the writer must end on its own.
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("the writer must give up on its own, without the queue closing")
        .expect("the writer must not panic");

    assert_eq!(delivered.load(Ordering::Relaxed), 0);
    assert!(stopped.load(Ordering::Relaxed), "the publication must be torn down");
}
