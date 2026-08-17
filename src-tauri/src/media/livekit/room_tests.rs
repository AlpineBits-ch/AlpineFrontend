//! The LiveKit transport, exercised against a real server.
//!
//! Every test here is `#[ignore]`d: they need a LiveKit server on `ws://127.0.0.1:7880`. See
//! `docker/livekit-dev/compose.yaml`, and the Windows note in it before reaching for Docker.
//!
//! These grew out of the Phase 0 probe and carry its findings forward as assertions rather than as
//! prose. What they establish is recorded in the migration spec §7.

use std::sync::atomic::Ordering;
use std::time::Duration;

use livekit_api::access_token::{AccessToken, TokenVerifier, VideoGrants};
use livekit_api::signal_client::SignalClient;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

use super::room::Room;
use super::signal::connect_options;

/// Dev mode ships this fixed pair. It is not a secret, and it must never reach a config file a
/// release build reads - a client never signs its own join token.
const DEV_KEY: &str = "devkey";
const DEV_SECRET: &str = "secret";

pub const DEV_URL: &str = "ws://127.0.0.1:7880";

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

/// Write a 440 Hz tone to a published track for `duration`, returning how many packets landed.
///
/// A tone rather than silence: Opus encodes true silence to a handful of bytes, and a receiver
/// discarding those looks identical to one that never got the stream.
async fn pump_tone(room: &Room, track_name: &str, duration: Duration) -> u64 {
    let track = room
        .local_track(track_name)
        .await
        .expect("the track must exist once published");
    let mut encoder =
        crate::media::voice::codec::VoiceEncoder::new(32_000).expect("opus encoder for the tone");

    // 20 ms at 48 kHz mono - the packetisation `media::voice::rtc` is built around.
    const SAMPLES: usize = 960;
    let mut pcm = [0f32; SAMPLES];
    let mut out = [0u8; 4000];
    let mut phase = 0f32;
    let mut sent = 0u64;

    let deadline = tokio::time::Instant::now() + duration;
    while tokio::time::Instant::now() < deadline {
        for sample in pcm.iter_mut() {
            phase += 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
            *sample = phase.sin() * 0.25;
        }
        let len = encoder.encode(&pcm, &mut out).expect("encode");
        if track
            .write_sample(&webrtc::media::Sample {
                data: bytes::Bytes::copy_from_slice(&out[..len]),
                duration: Duration::from_millis(20),
                ..Default::default()
            })
            .await
            .is_ok()
        {
            sent += 1;
            room.stats.packets_sent.fetch_add(1, Ordering::Relaxed);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    sent
}

#[test]
fn dev_token_carries_the_identity_and_room() {
    let token = dev_token("probe", "user-1#view");

    let claims = TokenVerifier::with_api_key(DEV_KEY, DEV_SECRET)
        .verify(&token)
        .expect("the token we just minted must verify");

    // The `#` is what separates a secondary connection from its user, and it has to survive a round
    // trip through the JWT unescaped. A token that mangled it would map every secondary participant
    // to the wrong user, or to none.
    assert_eq!(claims.sub, "user-1#view");
    assert_eq!(claims.video.room, "probe");
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880 - see docker/livekit-dev/compose.yaml"]
async fn connects_and_receives_a_join_response() {
    let (client, join, _events) = SignalClient::connect(
        DEV_URL,
        &dev_token("lk-connect", "user-1"),
        connect_options(),
        None,
    )
    .await
    .expect("the signalling connect must succeed");

    // Both come back from the server rather than being echoed from the token, so this is the first
    // point at which the whole path is proven rather than assumed.
    assert_eq!(join.room.expect("room").name, "lk-connect");
    assert_eq!(join.participant.expect("participant").identity, "user-1");

    // Subscriber-primary is the premise of the two-connection design in `room.rs`. If this ever
    // reads false, that design is wrong rather than merely suboptimal.
    assert!(join.subscriber_primary);
    assert!(!join.ice_servers.is_empty(), "ICE configuration comes from the join");

    println!("PROBE server version: {:?}", join.server_info.as_ref().map(|s| &s.version));
    client.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn reports_whether_the_server_accepts_single_peer_connection_mode() {
    // `connect_options()` leaves this off, so this test is the only thing that can say whether the
    // server *would* accept it. Deliberately not adopted - see the module docs on `room.rs` for why
    // one bidirectional connection is a worse trade than two unidirectional ones.
    let mut options = connect_options();
    options.single_peer_connection = true;

    let (client, _join, _events) =
        SignalClient::connect(DEV_URL, &dev_token("lk-singlepc", "user-1"), options, None)
            .await
            .expect("connect");

    println!("PROBE single-pc when asked for: {}", client.is_single_pc_mode_active());
    client.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn publishes_opus_and_carries_it() {
    let room = Room::connect(DEV_URL, &dev_token("lk-audio", "user-1"))
        .await
        .expect("connect");

    let publication = room.publish_audio("audio").await.expect("publish");

    // The SID is the server's, and it is only issued after `AddTrackRequest` was accepted - which is
    // where a codec or naming disagreement would surface.
    assert!(!publication.sid.is_empty());
    assert_eq!(publication.track_name, "audio");

    room.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("the publisher must reach connected");

    let sent = pump_tone(&room, "audio", Duration::from_secs(2)).await;
    assert!(sent > 50, "expected ~100 packets in two seconds, wrote {sent}");

    // Without this the test passes against a connection that never completed ICE: `write_sample`
    // hands the sample to a packetiser and nothing downstream reports back. See
    // `project_media_e2e_test_traps`.
    assert_eq!(room.publisher_state(), RTCPeerConnectionState::Connected);

    room.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn publishes_three_h264_layers_named_for_livekit() {
    use crate::media::publisher::simulcast::LAYER_RIDS;

    let room = Room::connect(DEV_URL, &dev_token("lk-video", "user-1"))
        .await
        .expect("connect");

    let publication = room
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
    assert!(!publication.sid.is_empty());

    // The SID can arrive before the answer, so publishing having returned is not enough.
    room.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let offer = room.local_sdp().await.expect("offer");
    let answer = room.remote_sdp().await.expect("answer");

    assert_eq!(
        offer.lines().filter(|l| l.starts_with("a=rid:")).count(),
        3,
        "three encodings must reach the SDP, or there is no ladder to choose from"
    );
    assert!(
        answer.contains("a=simulcast:recv f;h;q"),
        "the server must accept all three rids, in our order:\n{answer}"
    );

    // Congestion control. Without transport-cc, receive-side bandwidth estimation never reaches our
    // sender and it will not adapt to a congested viewer - a stream that stays too big rather than
    // an error anyone sees.
    assert!(answer.contains("transport-cc"));

    room.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn keeps_constrained_baseline_5_2_in_the_answer() {
    // Cloudflare answered `42e01f` to every offer, whatever we asked for; LiveKit forwards opaquely
    // and keeps what we offered, which is what makes this assertable at all. If it ever fails, the
    // encoder's profile has to move with it - what we transmit and what we negotiated are the same
    // decision, made in `media::publisher::rtc`.
    //
    // `42e034`, not `42e01f`: identical profile, Level 5.2 rather than 3.1. The level is what makes
    // 1440p60 conformant; the profile is what makes it decodable on Codec2 Android. Both halves have
    // to survive, so this asserts the whole string rather than the profile bytes.
    //
    // It also stands as the negotiated half of the payload-type pairing: this answer is where a
    // second H.264 entry would show up, and a second entry is a black tile for every viewer. See
    // `offer_shape::the_video_m_line_offers_only_the_codec_we_transmit` for the offer half.
    let room = Room::connect(DEV_URL, &dev_token("lk-profile", "user-1"))
        .await
        .expect("connect");

    room.publish_video("screen-profile", &[("f", 2560, 1440)])
        .await
        .expect("publish");
    room.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let answer = room.remote_sdp().await.expect("answer");
    assert!(
        answer.contains("profile-level-id=42e034"),
        "Constrained Baseline 5.2 must survive negotiation - the level is what makes 1440p60 \
         conformant, the profile is what makes it decodable:\n{answer}"
    );
    assert_eq!(
        answer.matches("profile-level-id=").count(),
        1,
        "one H.264 entry, or the SFU may bind one we do not transmit on:\n{answer}"
    );

    room.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn receives_rtp_from_a_subscribed_track() {
    let name = "lk-subscribe";

    let publisher = Room::connect(DEV_URL, &dev_token(name, "user-1"))
        .await
        .expect("connect");
    let publication = publisher.publish_audio("audio").await.expect("publish");
    publisher
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("connect");
    listener.subscribe(&publication.sid).await;

    let tone = tokio::spawn(async move {
        pump_tone(&publisher, "audio", Duration::from_secs(8)).await;
        publisher
    });

    tokio::time::sleep(Duration::from_secs(5)).await;

    // Packets, not a state. A subscriber that reaches `connected` and receives nothing is a
    // different failure from one that never connected, and only a counter tells them apart.
    let received = listener.stats.rtp_received.load(Ordering::Relaxed);
    println!("PROBE rtp packets received: {received}");
    assert!(received > 0, "subscribed and connected, but no RTP arrived");
    assert_eq!(listener.subscriber_state(), RTCPeerConnectionState::Connected);

    // The listener learned whose track it is from the identity alone, with no snapshot involved.
    let remote = listener.remote_tracks().await;
    assert!(
        remote.iter().any(|t| t.user_id == "user-1"),
        "the publisher must be attributed to their user id, got {remote:?}"
    );

    listener.close().await;
    tone.await.expect("tone task").close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn unpublishing_removes_the_track_and_keeps_the_connection() {
    let room = Room::connect(DEV_URL, &dev_token("lk-unpublish", "user-1"))
        .await
        .expect("connect");

    room.publish_audio("audio").await.expect("publish");
    room.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");
    assert!(room.local_track("audio").await.is_some());

    room.unpublish(&["audio".to_string()])
        .await
        .expect("unpublish");

    assert!(
        room.local_track("audio").await.is_none(),
        "the track must be forgotten, or a later write goes to a sender nobody is reading"
    );
    // Removing a track renegotiates. The connection has to survive that - a teardown that drops the
    // whole room would take the microphone with the share.
    assert_eq!(room.publisher_state(), RTCPeerConnectionState::Connected);

    // Idempotent: teardown runs on failure paths too, and asking twice must not error.
    room.unpublish(&["audio".to_string()])
        .await
        .expect("second unpublish is harmless");

    room.close().await;
}

/// Publish the microphone, drop it, and publish it again on the same room.
///
/// **This is rejoining a channel you are already holding a room for**, and until it passed it was a
/// permanent lockout rather than a failed attempt. The registry keys a room by
/// `guild:{guild}:{channel}` and hands the live one back to the next caller, ignoring its token - so
/// a rejoin lands on the connection the last membership left behind. If a screen share is still
/// holding that room, or anything else outlived the microphone, the room survives the microphone's
/// teardown and this is the exact sequence the next join runs.
///
/// What it used to do is `webrtc-rs`'s `ErrRTPSenderNewTrackHasIncorrectEnvelope` - surfaced to the
/// user as "LiveKit refused the microphone track: new track must have the same envelope as
/// previous", which names neither the cause nor anything the user can act on. `add_track` matches an
/// existing transceiver whose sender's `initial_track_id` equals the new track's id, and every
/// microphone is `audio`, so the second publish always lands on the first one's stopped sender - and
/// a stopped sender cannot take a track back.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn the_microphone_can_be_published_again_after_being_dropped() {
    let room = Room::connect(DEV_URL, &dev_token("lk-republish", "user-1"))
        .await
        .expect("connect");

    room.publish_audio("audio").await.expect("the first publish");
    room.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    room.unpublish(&["audio".to_string()])
        .await
        .expect("unpublish");

    // The whole test. A rejoin has to be able to speak.
    let again = room
        .publish_audio("audio")
        .await
        .expect("the microphone must be publishable again on a room that outlived it");
    assert!(!again.sid.is_empty(), "the server must issue a new SID for the new track");

    // And it has to be writable, not merely accepted: an envelope that negotiates and then has no
    // encoding behind it is the same silence with a different shape.
    let track = room
        .local_track("audio")
        .await
        .expect("the republished track must be writable");
    assert_eq!(webrtc::track::track_local::TrackLocal::id(&*track), "audio");

    assert_eq!(room.publisher_state(), RTCPeerConnectionState::Connected);

    room.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn inbound_audio_reaches_the_sink_keyed_by_its_sid() {
    // This test exists for one assumption the whole inbound path rests on: that the id on the
    // arriving track is the SID the subscribe was made with. A subscriber registers its destination
    // by SID *before* the track exists, so if the key ever stopped matching, every packet would be
    // routed nowhere - `rtp_received` climbing while the mixer stays silent, with nothing erroring.
    let name = "lk-inbound";

    let publisher = Room::connect(DEV_URL, &dev_token(name, "user-1"))
        .await
        .expect("connect");
    let publication = publisher.publish_audio("audio").await.expect("publish");
    publisher
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("connect");

    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    listener.on_audio(tx);
    listener.subscribe(&publication.sid).await;

    let tone = tokio::spawn(async move {
        pump_tone(&publisher, "audio", Duration::from_secs(8)).await;
        publisher
    });

    let first = tokio::time::timeout(Duration::from_secs(8), rx.recv())
        .await
        .expect("audio must reach the sink within 8s")
        .expect("the sink must not close while the room is up");

    let (key, packet) = first;
    assert_eq!(
        key, publication.sid,
        "the routing key must be the SID the subscribe used, or every packet routes nowhere"
    );
    assert!(!packet.payload.is_empty(), "an empty payload decodes to nothing");

    listener.close().await;
    tone.await.expect("tone task").close().await;
}

/// Publish a real H.264 ladder and prove the SFU forwards it to another client.
///
/// **This is the test that was missing.** Everything else here proves the SFU *accepts* a
/// publication - it issues a track SID, the answer looks right, the connection reaches `connected`.
/// None of that says a single byte reaches a viewer, and "accepted but never forwarded" is exactly
/// what a black tile looks like from the publishing side.
///
/// It became possible only once the share moved to Constrained Baseline: the subscriber connection
/// is built from `voice_api`, whose default codec set shares that profile (`42e01f`), so it can
/// finally decode what we publish. Under High it could not, and this could only ever have been
/// checked with a browser.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn the_sfu_forwards_a_published_screen_to_a_subscriber() {
    // Through the factory, not `encoder_mf` directly: that module is `#[cfg(target_os = "windows")]`,
    // so naming it here compiles on the machine this test is run from and breaks the build everywhere
    // else. `new_encoder` is also what production publishes through, which is the point of the test.
    use crate::media::publisher::encoder::{new_encoder, EncodeOutcome, EncoderContent, EncoderSpec};
    use crate::media::publisher::simulcast::LAYER_RIDS;

    let name = "lk-forward";
    let spec = EncoderSpec {
        width: 640,
        height: 360,
        fps: 30,
        kbps: 1_200,
        content: EncoderContent::Text,
    };

    let publisher = Room::connect(DEV_URL, &dev_token(name, "user-1"))
        .await
        .expect("connect");
    // Three rungs, as production publishes - only the top one is fed below. A single-layer publish
    // is a different shape in `Room`, which always uses the rid constructor where the Cloudflare
    // path deliberately used a plain track for a lone layer, so testing one layer would be testing
    // something production never does.
    // The microphone first, as production always does: the share joins a connection that already
    // carries audio, and a video-only publisher is a shape this client never produces.
    publisher.publish_audio("audio").await.expect("publish audio");
    publisher
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("publisher connected after audio");

    let publication = publisher
        .publish_video(name, &[(LAYER_RIDS[0], spec.width, spec.height)])
        .await
        .expect("publish");
    publisher
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("publisher connected");

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("connect");
    listener.subscribe(&publication.sid).await;

    // Real encoder output, not synthetic bytes: the H.264 packetiser splits on Annex-B start codes,
    // so anything else produces no RTP at all and the test would fail for its own reasons.
    let Some(mut encoder) = new_encoder(spec) else {
        println!("FORWARD: no encoder available on this machine; skipping");
        return;
    };
    let track = publisher
        .local_ladder(name)
        .await
        .into_iter()
        .next()
        .expect("the top layer must exist once published");

    let mut written = 0u32;
    for i in 0..150u64 {
        let frame = image::RgbaImage::from_fn(spec.width, spec.height, |x, y| {
            let v = (((x + i as u32) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        });
        if let EncodeOutcome::Chunk(chunk) = encoder.encode(crate::media::publisher::encoder::CapturedFrame::Cpu(&frame), i * 33_333) {
            if track
                .write_sample(&webrtc::media::Sample {
                    data: bytes::Bytes::from(chunk.data),
                    duration: Duration::from_millis(33),
                    ..Default::default()
                })
                .await
                .is_ok()
            {
                written += 1;
            }
        }
        tokio::time::sleep(Duration::from_millis(33)).await;
    }

    for (label, sdp) in [
        ("offer", publisher.local_sdp().await),
        ("answer", publisher.remote_sdp().await),
    ] {
        let Some(sdp) = sdp else { continue };
        for line in sdp.lines() {
            if line.starts_with("m=") || line.starts_with("a=mid:")
                || line.starts_with("a=msid:") || line.starts_with("a=ssrc")
                || line.starts_with("a=sendonly") || line.starts_with("a=recvonly")
                || line.starts_with("a=inactive") || line.starts_with("a=sendrecv")
            {
                println!("FORWARD {label}: {line}");
            }
        }
    }

    // Are *we* sending? `write_sample` returning Ok only means the packetiser accepted the frame;
    // it says nothing about whether the sender is transmitting. If this is zero the SFU has nothing
    // to forward and its silence is a consequence rather than the fault.
    for (id, stat) in publisher.publisher_connection().get_stats().await.reports {
        let rendered = format!("{stat:?}");
        if rendered.contains("OutboundRTP") && rendered.contains("video") {
            println!("FORWARD outbound {id}: {rendered}");
        }
    }

    let received = listener.stats.rtp_received.load(Ordering::Relaxed);
    println!("FORWARD wrote {written} samples, subscriber received {received} RTP packets");
    println!("FORWARD subscriber state: {}", listener.subscriber_state());
    // The discriminator. Zero means the server never offered the track on the subscriber
    // connection at all - the subscribe did not take. Non-zero means the track opened and carried
    // nothing, which is a sending problem rather than a subscribing one.
    println!(
        "FORWARD subscriber tracks_opened: {}",
        listener.stats.tracks_opened.load(Ordering::Relaxed)
    );
    println!(
        "FORWARD publisher state: {}, remote tracks seen by listener: {}",
        publisher.publisher_state(),
        listener.remote_tracks().await.len()
    );

    assert!(written > 50, "the encoder produced almost nothing: {written}");
    // The whole point. Bytes, at a viewer, from a real publish.
    assert!(
        received > 0,
        "the SFU accepted the publication and forwarded nothing - {written} samples written"
    );

    listener.close().await;
    publisher.close().await;
}

/// What the server says it will accept, straight off the join.
///
/// `JoinResponse.enabled_publish_codecs` is the room's allow-list. A publisher that offers a codec
/// absent from it gets a track SID and no forwarding, which is indistinguishable from every other
/// silent failure - so it is worth reading rather than assuming.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn report_what_the_room_allows_us_to_publish() {
    let (client, join, _events) = SignalClient::connect(
        DEV_URL,
        &dev_token("lk-codecs", "user-1"),
        connect_options(),
        None,
    )
    .await
    .expect("connect");

    println!("CODECS enabled_publish_codecs: {:?}", join.enabled_publish_codecs);
    println!("CODECS server version: {:?}", join.server_info.as_ref().map(|s| &s.version));
    if let Some(info) = join.server_info.as_ref() {
        println!("CODECS server protocol: {}", info.protocol);
    }

    client.close().await;
}

/// How many packets arrived on the sink for each track SID over `window`.
///
/// Keyed rather than totalled, because the failure this exists for is *one* track going quiet while
/// another keeps flowing - a total would stay healthy throughout it.
async fn drain_by_key(
    rx: &mut tokio::sync::mpsc::Receiver<(String, crate::media::voice::jitter::Packet)>,
    window: Duration,
) -> std::collections::HashMap<String, u64> {
    let mut counts = std::collections::HashMap::new();
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some((key, _))) =
        tokio::time::timeout_at(deadline, rx.recv()).await
    {
        *counts.entry(key).or_insert(0u64) += 1;
    }
    counts
}

/// A later subscribe must not silence the track that is already flowing.
///
/// **This is "I could not hear the other party any more", and nothing above the transport can see
/// it.** Every subscribe after the first renegotiates the subscriber connection, and `webrtc-rs`
/// answers a renegotiation by walking every transceiver and stopping any receiver whose live track
/// it cannot match against the new remote description (`start_rtp`, `is_renegotiation == true`). A
/// stopped receiver ends its `TrackRemote`, so the reader `install_receive_reader` spawned returns
/// `ErrClosedPipe` and exits - while the subscription, both connection states and every counter
/// above still read healthy. The audio simply stops.
///
/// Two speakers rather than one, because a single track cannot show it: the assertion is that the
/// *first* one keeps arriving across the second one's negotiation.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_later_subscribe_does_not_silence_the_track_already_flowing() {
    let name = "lk-renegotiate";

    let first = Room::connect(DEV_URL, &dev_token(name, "user-1"))
        .await
        .expect("connect");
    let first_pub = first.publish_audio("audio").await.expect("publish");
    first
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let second = Room::connect(DEV_URL, &dev_token(name, "user-2"))
        .await
        .expect("connect");
    let second_pub = second.publish_audio("audio").await.expect("publish");
    second
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-3"))
        .await
        .expect("connect");
    let (tx, mut rx) = tokio::sync::mpsc::channel(4096);
    listener.on_audio(tx);

    let tone_a = tokio::spawn(async move {
        pump_tone(&first, "audio", Duration::from_secs(30)).await;
        first
    });
    let tone_b = tokio::spawn(async move {
        pump_tone(&second, "audio", Duration::from_secs(30)).await;
        second
    });

    // First subscription, and proof it is carrying before anything else happens to the connection.
    listener.subscribe(&first_pub.sid).await;
    let before = drain_by_key(&mut rx, Duration::from_secs(6)).await;
    println!("RENEG before the second subscribe: {before:?}");
    assert!(
        before.get(&first_pub.sid).copied().unwrap_or(0) > 0,
        "the first track never carried, so this test cannot say anything about the second: {before:?}"
    );

    // The renegotiation under test.
    listener.subscribe(&second_pub.sid).await;
    // Long enough for the offer/answer to land and for both to be well past it.
    let after = drain_by_key(&mut rx, Duration::from_secs(8)).await;
    println!("RENEG after the second subscribe: {after:?}");
    println!("RENEG subscriber state: {}", listener.subscriber_state());
    println!(
        "RENEG tracks opened: {}",
        listener.stats.tracks_opened.load(Ordering::Relaxed)
    );

    assert!(
        after.get(&second_pub.sid).copied().unwrap_or(0) > 0,
        "the second subscribe never carried at all: {after:?}"
    );
    // The regression. Silent everywhere else: the SFU is still sending it, the connection is still
    // `Connected`, and the subscription is still on the books.
    assert!(
        after.get(&first_pub.sid).copied().unwrap_or(0) > 0,
        "the first track went silent when the second was subscribed: {after:?}"
    );

    listener.close().await;
    tone_a.await.expect("tone a").close().await;
    tone_b.await.expect("tone b").close().await;
}

/// Starting a screen share must not interrupt the audio this room is already receiving.
///
/// **This is "I start a stream and can no longer hear the other party".** The share publishes on
/// the *publisher* connection of a room whose *subscriber* connection is carrying somebody's
/// microphone, and the two are supposed to be independent. They are not: the SFU renegotiates the
/// subscriber whenever the participant's published set changes, and a renegotiation is where an
/// inbound track can be dropped with every state above it still reading healthy.
///
/// The share is published exactly as `publisher::rtc::Publication::start` does it - the audio half
/// first, then the ladder, with the same track names - because the order and the number of
/// negotiations are what the failure depends on.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_screen_share_does_not_interrupt_the_audio_this_room_receives() {
    use livekit_protocol as proto;

    let name = "lk-share-vs-audio";
    let share_id = "747fa2a2";

    // The other party, talking throughout.
    let peer = Room::connect(DEV_URL, &dev_token(name, "user-peer"))
        .await
        .expect("connect");
    let peer_pub = peer.publish_audio("audio").await.expect("publish");
    peer.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    // Us: the microphone first, as production always does, then the subscription.
    let me = Room::connect(DEV_URL, &dev_token(name, "user-me"))
        .await
        .expect("connect");
    me.publish_audio("audio").await.expect("publish mic");
    me.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let (tx, mut rx) = tokio::sync::mpsc::channel(4096);
    me.on_audio(tx);
    me.subscribe(&peer_pub.sid).await;

    let tone = tokio::spawn(async move {
        pump_tone(&peer, "audio", Duration::from_secs(40)).await;
        peer
    });

    let before = drain_by_key(&mut rx, Duration::from_secs(6)).await;
    println!("SHARE before: {before:?}");
    assert!(
        before.get(&peer_pub.sid).copied().unwrap_or(0) > 0,
        "the peer never carried, so this test cannot say anything about the share: {before:?}"
    );

    // The share, in the order and shape production publishes it.
    me.publish_audio_as(
        &format!("screen-audio-{share_id}"),
        proto::TrackSource::ScreenShareAudio,
    )
    .await
    .expect("publish the share's audio half");
    me.publish_video(
        &format!("screen-{share_id}"),
        &[("f", 1920, 1080), ("h", 960, 540), ("q", 480, 270)],
    )
    .await
    .expect("publish the ladder");

    let after = drain_by_key(&mut rx, Duration::from_secs(8)).await;
    println!("SHARE after: {after:?}");
    println!("SHARE subscriber state: {}", me.subscriber_state());
    println!("SHARE publisher state: {}", me.publisher_state());

    assert!(
        after.get(&peer_pub.sid).copied().unwrap_or(0) > 0,
        "the peer went silent the moment we started sharing: {after:?}"
    );

    // And it must survive the share going away again, which is a second renegotiation.
    me.unpublish(&[
        format!("screen-{share_id}"),
        format!("screen-audio-{share_id}"),
    ])
    .await
    .expect("unpublish the share");

    let stopped = drain_by_key(&mut rx, Duration::from_secs(6)).await;
    println!("SHARE after unpublish: {stopped:?}");
    assert!(
        stopped.get(&peer_pub.sid).copied().unwrap_or(0) > 0,
        "the peer went silent when the share stopped: {stopped:?}"
    );

    me.close().await;
    tone.await.expect("tone task").close().await;
}

/// The sharer's microphone must still reach a listener after the share is taken down.
///
/// **This is "they cannot hear me any more", and from the sharing side nothing looks wrong at all.**
/// Ending a share renegotiates the publisher connection - `unpublish` removes the two senders, stops
/// their transceivers and offers once - and the microphone is a *third* sender on that same
/// connection, published long before and never touched by any of it. `write_sample` goes on
/// returning `Ok`, `packets_sent` goes on climbing, both connections stay `Connected`. Whether the
/// SFU is still forwarding any of it cannot be read from this end at all, which is why the assertion
/// is made from a second room.
///
/// `Room::publish_video` already warns that anything which offers again on this connection corrupts
/// a live ladder, and `unpublish` is exactly that - it offers. What it does to the *microphone*
/// sharing the connection was never checked in either direction.
///
/// The listener subscribes before any share exists and is never re-subscribed, as a peer already in
/// the channel does. Three windows, because "never carried" and "carried and then stopped" are
/// different faults and only the middle one tells them apart.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn the_microphone_still_reaches_a_listener_after_a_share_is_taken_down() {
    use livekit_protocol as proto;

    let name = "lk-mic-after-share";
    let share_id = "e57aa24a";
    let video = format!("screen-{share_id}");
    let audio = format!("screen-audio-{share_id}");

    let me = Room::connect(DEV_URL, &dev_token(name, "user-me"))
        .await
        .expect("connect");
    let mic = me.publish_audio("audio").await.expect("publish the microphone");
    me.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    // The peer, who subscribed to the microphone before any share existed and never again.
    let peer = Room::connect(DEV_URL, &dev_token(name, "user-peer"))
        .await
        .expect("connect");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8192);
    peer.on_audio(tx);
    peer.subscribe(&mic.sid).await;

    // Pumped in windows rather than from a task, so the share operations are ordered against the
    // audio rather than racing it. The sink queues what arrives; each drain reads one window's worth.
    pump_tone(&me, "audio", Duration::from_secs(6)).await;
    let before = drain_by_key(&mut rx, Duration::from_millis(500)).await;
    println!("MIC before the share: {before:?}");
    assert!(
        before.get(&mic.sid).copied().unwrap_or(0) > 0,
        "the microphone never carried, so this test cannot say anything about the share: {before:?}"
    );

    // The share, in the order and shape production publishes it.
    me.publish_audio_as(&audio, proto::TrackSource::ScreenShareAudio)
        .await
        .expect("publish the share's audio half");
    me.publish_video(&video, &[("f", 1920, 1080), ("h", 960, 540), ("q", 480, 270)])
        .await
        .expect("publish the ladder");

    pump_tone(&me, "audio", Duration::from_secs(6)).await;
    let during = drain_by_key(&mut rx, Duration::from_millis(500)).await;
    println!("MIC during the share: {during:?}");
    assert!(
        during.get(&mic.sid).copied().unwrap_or(0) > 0,
        "the microphone stopped reaching the peer when the share started: {during:?}"
    );

    // The renegotiation under test.
    me.unpublish(&[video, audio]).await.expect("unpublish the share");

    pump_tone(&me, "audio", Duration::from_secs(8)).await;
    let after = drain_by_key(&mut rx, Duration::from_millis(500)).await;
    println!("MIC after the share was taken down: {after:?}");
    println!("MIC publisher state: {}", me.publisher_state());
    println!("MIC peer subscriber state: {}", peer.subscriber_state());
    println!(
        "MIC peer sees these tracks: {:?}",
        peer.remote_tracks().await.iter().map(|t| t.track_name.clone()).collect::<Vec<_>>()
    );

    assert!(
        after.get(&mic.sid).copied().unwrap_or(0) > 0,
        "the microphone stopped reaching the peer when the share was taken down - \
         which is what 'they cannot hear me' looks like from a client that is still sending: {after:?}"
    );

    peer.close().await;
    me.close().await;
}

/// What the room believes other people are publishing must be what they are publishing *now*.
///
/// **This is "they cannot hear me, and rejoining does not help".** The map behind
/// [`Room::remote_tracks`] was only ever inserted into, so it accumulated every track the server
/// had ever mentioned - a share that ended, a microphone from a session that is over. The join that
/// matters is `media::voice::rtc::sid_for`, which filters that list by track name and takes the
/// first entry matching the user. Every microphone is named `audio`, so a publisher who rejoins puts
/// a *second* `audio` entry in it for the same user, and which one a subscribe resolves to is
/// `HashMap` iteration order.
///
/// Half the time that is the dead sid. `UpdateSubscription` for a track the SFU no longer has is
/// answered with silence - no offer, no track, no error - and the subscriber sits at "connecting"
/// for the rest of the session. Rejoining adds a third entry rather than clearing the second, which
/// is why it does not recover, and why it looks random.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_republished_track_replaces_the_one_it_supersedes() {
    let name = "lk-restale";

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-listener"))
        .await
        .expect("connect");

    let first = Room::connect(DEV_URL, &dev_token(name, "user-1"))
        .await
        .expect("connect");
    let gone = first.publish_audio("audio").await.expect("publish");
    first
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");
    audio_tracks_within(&listener, 1, Duration::from_secs(10)).await;

    // The publisher goes away and comes back, which is a rejoin: same user, same track name, a new
    // sid. Exactly what the app does when a call drops and is re-established.
    first.close().await;
    let second = Room::connect(DEV_URL, &dev_token(name, "user-1"))
        .await
        .expect("rejoin");
    let live = second.publish_audio("audio").await.expect("republish");
    second
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");
    assert_ne!(gone.sid, live.sid, "the rejoin must have been issued a new sid");

    let held = audio_tracks_within(&listener, 1, Duration::from_secs(10)).await;
    println!("STALE listener holds: {held:?}");

    // One entry, not two. With two, `sid_for` is a coin flip and the loser never carries a packet.
    assert_eq!(
        held.len(),
        1,
        "the room is holding a superseded microphone alongside the live one, so which of them a \
         subscribe resolves to is iteration order: {held:?}"
    );
    assert_eq!(
        held[0].sid, live.sid,
        "the room kept the dead microphone and dropped the live one"
    );

    listener.close().await;
    second.close().await;
}

/// Every `audio` track the room currently believes exists, once at least `want` have shown up.
///
/// Polled rather than read once: a track published after our join arrives on `ParticipantUpdate`,
/// and whether it has landed yet is the server's timing rather than ours.
async fn audio_tracks_within(
    room: &Room,
    want: usize,
    patience: Duration,
) -> Vec<crate::media::livekit::room::RemoteTrack> {
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let held: Vec<_> = room
            .remote_tracks()
            .await
            .into_iter()
            .filter(|t| t.track_name == "audio")
            .collect();
        if held.len() >= want || tokio::time::Instant::now() >= deadline {
            return held;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A subscriber renegotiation that changes none of our m-lines must not silence a live track.
///
/// **This is the fault, and it is not ours: `webrtc-rs` throws the track away while answering.**
/// `RTCPeerConnection::set_local_description` runs `start_rtp(is_renegotiation = true)`, which walks
/// every transceiver and stops the receiver of any live `TrackRemote` whose SSRC it cannot find in
/// the offer it is answering (`peer_connection_internal.rs`). LiveKit does not repeat `a=ssrc:` for
/// m-lines an offer does not change, so a re-offer prompted by something else entirely - somebody
/// else publishing a track we never subscribed to - tears down audio that was flowing perfectly.
/// The reader `install_receive_reader` spawned then exits with `ErrClosedPipe`, rendered as the
/// wonderfully unhelpful "DataChannel is not opened".
///
/// **And nothing gets it back.** `start_rtp_receivers` cannot reopen a track the description does
/// not describe, so `on_track` never fires again; and from the SFU's point of view we are still
/// subscribed, so re-sending `UpdateSubscription { subscribe: true }` is a no-op that produces no
/// offer. The subscription, both connection states, the route table and `packets_sent` all stay
/// healthy while that participant is inaudible for the rest of the session.
///
/// The second publication is deliberately *not* subscribed to: a subscribe of our own would add an
/// m-line, and an offer that adds one carries ssrc lines for everything, which is exactly the shape
/// that hides this.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_renegotiation_that_changes_nothing_must_not_silence_a_live_track() {
    use livekit_protocol as proto;

    let name = "lk-quiet-reneg";

    let speaker = Room::connect(DEV_URL, &dev_token(name, "user-speaker"))
        .await
        .expect("connect");
    let mic = speaker.publish_audio("audio").await.expect("publish");
    speaker
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-listener"))
        .await
        .expect("connect");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8192);
    listener.on_audio(tx);
    listener.subscribe(&mic.sid).await;

    pump_tone(&speaker, "audio", Duration::from_secs(6)).await;
    let before = drain_by_key(&mut rx, Duration::from_millis(500)).await;
    println!("QUIET before: {before:?}");
    assert!(
        before.get(&mic.sid).copied().unwrap_or(0) > 0,
        "the microphone never carried, so this test cannot say anything: {before:?}"
    );

    // Something happens in the room that we are not a party to. This is the share's audio half in
    // production; anybody publishing anything does as well.
    speaker
        .publish_audio_as("screen-audio-x", proto::TrackSource::ScreenShareAudio)
        .await
        .expect("publish a track the listener never asks for");

    pump_tone(&speaker, "audio", Duration::from_secs(8)).await;
    let after = drain_by_key(&mut rx, Duration::from_millis(500)).await;
    println!("QUIET after: {after:?}");
    println!("QUIET listener subscriber: {}", listener.subscriber_state());
    println!(
        "QUIET listener tracks opened: {}",
        listener.stats.tracks_opened.load(Ordering::Relaxed)
    );

    assert!(
        after.get(&mic.sid).copied().unwrap_or(0) > 0,
        "a renegotiation we had no part in silenced the track we were listening to, and nothing \
         above the transport can see it: {after:?}"
    );

    listener.close().await;
    speaker.close().await;
}

/// Unsubscribing and subscribing again brings a track back, which is the only recovery there is.
///
/// A live inbound track can be destroyed by a renegotiation that had nothing to do with it - see
/// `a_renegotiation_that_changes_nothing_must_not_silence_a_live_track` - and once it is, nothing
/// reopens it: `on_track` fires only for tracks `start_rtp_receivers` opens, and the SFU still has
/// us down as subscribed, so `UpdateSubscription { subscribe: true }` on its own changes nothing and
/// produces no offer. Recovery therefore has to make the server believe the subscription is *new*.
///
/// This pins that it does. If the false/true cycle ever stops producing a fresh offer, the recovery
/// built on it is silently a no-op and the failure it repairs looks exactly as it did before.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn a_resubscribe_cycle_reopens_a_track() {
    let name = "lk-recycle";

    let speaker = Room::connect(DEV_URL, &dev_token(name, "user-speaker"))
        .await
        .expect("connect");
    let mic = speaker.publish_audio("audio").await.expect("publish");
    speaker
        .wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let listener = Room::connect(DEV_URL, &dev_token(name, "user-listener"))
        .await
        .expect("connect");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8192);
    listener.on_audio(tx);
    listener.subscribe(&mic.sid).await;

    pump_tone(&speaker, "audio", Duration::from_secs(5)).await;
    let before = drain_by_key(&mut rx, Duration::from_millis(500)).await;
    assert!(
        before.get(&mic.sid).copied().unwrap_or(0) > 0,
        "the track never carried: {before:?}"
    );

    // Stand in for the destruction: the reader is gone and the m-line with it, which is the state
    // the recovery finds itself in.
    listener.unsubscribe(&mic.sid).await;
    pump_tone(&speaker, "audio", Duration::from_secs(3)).await;
    let _ = drain_by_key(&mut rx, Duration::from_millis(500)).await;

    let opened_before = listener.stats.tracks_opened.load(Ordering::Relaxed);
    listener.subscribe(&mic.sid).await;
    pump_tone(&speaker, "audio", Duration::from_secs(6)).await;
    let after = drain_by_key(&mut rx, Duration::from_millis(500)).await;

    println!("RECYCLE after the cycle: {after:?}");
    println!(
        "RECYCLE tracks opened {} -> {}",
        opened_before,
        listener.stats.tracks_opened.load(Ordering::Relaxed)
    );

    assert!(
        listener.stats.tracks_opened.load(Ordering::Relaxed) > opened_before,
        "the resubscribe produced no fresh track, so there is no recovery to build on"
    );
    assert!(
        after.get(&mic.sid).copied().unwrap_or(0) > 0,
        "the track reopened but carried nothing: {after:?}"
    );

    listener.close().await;
    speaker.close().await;
}

/// A participant update must not take away a track that is still published.
///
/// **The hazard in making each update authoritative.** `record_participants` replaces what an update
/// says about the participant it names, which is what stops a superseded microphone shadowing the
/// live one - but it means an update carrying fewer tracks than reality would erase a track that is
/// still there. `sid_for` would then resolve nothing, the subscribe would fail, and the caller's
/// rollback would leave that participant with no subscription and nothing to retry from: silent for
/// the session, exactly like the fault the replacement was introduced to fix.
///
/// So this drives the updates a share really produces - publish the audio half, publish the ladder,
/// take both down - and asserts the *microphone* is still resolvable throughout. The peer never
/// touches their microphone; only the assertions do.
#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn an_update_never_drops_a_track_that_is_still_published() {
    use livekit_protocol as proto;

    let name = "lk-update-churn";
    let share = "305187c6";
    let video = format!("screen-{share}");
    let audio = format!("screen-audio-{share}");

    let peer = Room::connect(DEV_URL, &dev_token(name, "user-peer"))
        .await
        .expect("connect");
    let mic = peer.publish_audio("audio").await.expect("publish");
    peer.wait_until_connected(Duration::from_secs(10))
        .await
        .expect("connected");

    let watcher = Room::connect(DEV_URL, &dev_token(name, "user-watcher"))
        .await
        .expect("connect");
    let held = audio_tracks_within(&watcher, 1, Duration::from_secs(10)).await;
    assert_eq!(held.len(), 1, "the watcher never learned about the microphone: {held:?}");

    // Every update a share produces, in the order production produces them.
    peer.publish_audio_as(&audio, proto::TrackSource::ScreenShareAudio)
        .await
        .expect("publish the share's audio half");
    assert_mic_survives(&watcher, &mic.sid, "the share's audio half was published").await;

    peer.publish_video(&video, &[("f", 1920, 1080), ("h", 960, 540), ("q", 480, 270)])
        .await
        .expect("publish the ladder");
    assert_mic_survives(&watcher, &mic.sid, "the ladder was published").await;

    peer.unpublish(&[video, audio]).await.expect("unpublish the share");
    assert_mic_survives(&watcher, &mic.sid, "the share was taken down").await;

    watcher.close().await;
    peer.close().await;
}

/// The microphone is still the one resolvable `audio` track for its publisher.
///
/// Given a settling window, because an update arrives on the server's timing: asserting immediately
/// would pass on the update not having landed yet, which is the opposite of the finding.
async fn assert_mic_survives(room: &Room, sid: &str, after: &str) {
    tokio::time::sleep(Duration::from_millis(750)).await;
    let held = audio_tracks_within(room, 1, Duration::from_secs(5)).await;
    println!("CHURN after {after}: {:?}", held.iter().map(|t| &t.sid).collect::<Vec<_>>());
    assert_eq!(
        held.len(),
        1,
        "after {after} the room holds {} microphone(s) for that publisher, not one: {held:?}",
        held.len()
    );
    assert_eq!(held[0].sid, sid, "after {after} the live microphone is not the one held");
}
