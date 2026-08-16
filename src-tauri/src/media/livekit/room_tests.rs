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
async fn keeps_h264_high_5_2_in_the_answer() {
    // `encoder_mf` emits Constrained High because of this. Cloudflare answered `42e01f` to every
    // offer, which is why it was pinned to Constrained Baseline for so long; LiveKit forwards
    // opaquely and keeps what we offered. If this ever fails, the encoder profile has to go back
    // with it.
    //
    // `640c34`, not `640034`. Plain High is a profile essentially nothing advertises - libwebrtc
    // matches by profile equality, and Chrome and mobile hardware both offer Constrained High - so
    // the old string negotiated to no codec at all. See `H264_HIGH_5_2_FMTP`.
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
        answer.contains("640034"),
        "Constrained High 5.2 must survive negotiation - it is what makes 1440p60 conformant:\n{answer}"
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
    use crate::media::publisher::encoder::{EncodeOutcome, EncoderContent, EncoderSpec, VideoEncoder};
    use crate::media::publisher::encoder_mf::PooledEncoder;
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
    let publication = publisher
        .publish_video(
            name,
            &[
                (LAYER_RIDS[0], spec.width, spec.height),
                (LAYER_RIDS[1], spec.width / 2, spec.height / 2),
                (LAYER_RIDS[2], spec.width / 4, spec.height / 4),
            ],
        )
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
    let Some(mut encoder) = PooledEncoder::acquire(spec) else {
        println!("FORWARD: no hardware encoder on this machine; skipping");
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
        if let EncodeOutcome::Chunk(chunk) = encoder.encode(&frame, i * 33_333) {
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
