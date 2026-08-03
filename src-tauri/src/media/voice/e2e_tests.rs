//! End-to-end proof that this client can hear another one.
//!
//! Two real peer connections, real Opus, real SRTP, and the shipping jitter buffer, decoder, mixer
//! and render path on the receiving side. `a_remote_participant_is_audible_end_to_end` asserts on
//! the *samples a speaker would emit*, not on a counter.
//!
//! This exists because the voice pipeline broke, repeatedly, while every test in the tree stayed
//! green. Each stage had thorough unit tests and each of them kept passing, because the faults were
//! in the joins between stages: a handler that starved every track after the first, a render path
//! that ignored the output device's sample rate. Both were invisible to any test that stopped short
//! of putting sound in one end and listening at the other, and invisible to the counters too - the
//! call connected, the subscribes returned `Ok`, and nobody could hear anybody.
//!
//! CI runs this on every push to `main`. If it fails, do not merge; there is no version of this
//! failing that is not "voice is broken".

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::{APIBuilder, API};
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use super::codec::{VoiceEncoder, MAX_PACKET, PACKET_SAMPLES};
use super::jitter::Packet;
use super::mixer::Mixer;
use super::playout;
use super::receive::RemoteSource;
use super::rtc::{opus_capability, route_inbound_audio, PacketSink, PublicationStats};
use super::{FRAME, SAMPLE_RATE};

/// Matches `VoicePublication::start` - the codecs and interceptors are what decide whether an
/// inbound stream can be matched to a transceiver at all.
fn api() -> API {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().unwrap();
    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine).unwrap();
    APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build()
}

async fn pc() -> Arc<RTCPeerConnection> {
    Arc::new(
        api()
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap(),
    )
}

async fn gather(pc: &RTCPeerConnection) {
    let mut done = pc.gathering_complete_promise().await;
    let _ = tokio::time::timeout(Duration::from_secs(10), done.recv()).await;
}

/// One offer/answer round trip, driven the way `negotiate_subscription` drives it.
async fn negotiate(from: &RTCPeerConnection, to: &RTCPeerConnection) {
    let offer = from.create_offer(None).await.unwrap();
    from.set_local_description(offer).await.unwrap();
    gather(from).await;
    let local = from.local_description().await.unwrap();

    to.set_remote_description(RTCSessionDescription::offer(local.sdp).unwrap())
        .await
        .unwrap();
    let answer = to.create_answer(None).await.unwrap();
    to.set_local_description(answer).await.unwrap();
    gather(to).await;
    let remote = to.local_description().await.unwrap();

    from.set_remote_description(RTCSessionDescription::answer(remote.sdp).unwrap())
        .await
        .unwrap();
}

/// Feed a track continuously, so the receiver has something to read for the whole test.
fn pump(track: Arc<TrackLocalStaticSample>) {
    tokio::spawn(async move {
        loop {
            let _ = track
                .write_sample(&Sample {
                    data: bytes::Bytes::from_static(&[0xfc, 0xff, 0xfe]),
                    duration: Duration::from_millis(20),
                    ..Default::default()
                })
                .await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
}

/// Publish a microphone and pull `count` remote tracks, then report which mids delivered RTP.
///
/// The pulls are set up as one renegotiation carrying every recvonly m-line, so which tracks open is
/// decided by the receive plumbing rather than by the order the stand-in SFU happens to match
/// m-lines in.
async fn subscribe_and_read(count: usize) -> (Vec<String>, u64) {
    let client = pc().await;
    let sfu = pc().await;

    // The production routing, driven directly: the same handler, the same sink, the same counters.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(String, Packet)>(256);
    let sink: PacketSink = Arc::new(std::sync::Mutex::new(Some(tx)));
    let stats = Arc::new(PublicationStats::default());
    route_inbound_audio(&client, &sink, &stats);

    // The microphone publish, exactly as `VoicePublication::start` adds it.
    let mic = Arc::new(TrackLocalStaticSample::new(
        opus_capability(),
        "audio".to_owned(),
        "audio".to_owned(),
    ));
    client
        .add_track(Arc::clone(&mic) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .unwrap();

    // One recvonly transceiver per pulled track, as `subscribe` adds them, and one sendonly track on
    // the far side to answer each.
    let mut remotes = Vec::new();
    for i in 0..count {
        client
            .add_transceiver_from_kind(
                RTPCodecType::Audio,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    send_encodings: vec![],
                }),
            )
            .await
            .unwrap();

        let remote = Arc::new(TrackLocalStaticSample::new(
            opus_capability(),
            format!("remote-{i}"),
            format!("remote-{i}"),
        ));
        sfu.add_transceiver_from_track(
            Arc::clone(&remote) as Arc<dyn TrackLocal + Send + Sync>,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Sendonly,
                send_encodings: vec![],
            }),
        )
        .await
        .unwrap();
        remotes.push(remote);
    }

    negotiate(&client, &sfu).await;
    pump(mic);
    for remote in remotes {
        pump(remote);
    }

    let mut seen: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while seen.len() < count {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some((mid, packet))) => {
                assert!(!packet.payload.is_empty(), "an empty payload decodes to nothing");
                if !seen.contains(&mid) {
                    eprintln!("[test] first RTP on mid {mid}");
                    seen.push(mid);
                }
            }
            _ => break,
        }
    }
    seen.sort();
    (seen, stats.tracks_opened.load(Ordering::Relaxed))
}

// ── End to end ────────────────────────────────────────────────────────────────────────────────

/// Energy at `freq` in `samples`, via the Goertzel algorithm.
///
/// Cheaper than an FFT for the one question being asked: did the tone that was sent survive the
/// whole pipeline, and did it survive as itself rather than as noise?
fn energy_at(samples: &[f32], freq: f32, rate: f32) -> f32 {
    let k = std::f32::consts::TAU * freq / rate;
    let coeff = 2.0 * k.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for &sample in samples {
        let s0 = sample + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    (s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0).sqrt() / samples.len() as f32
}

/// A 440 Hz tone, encoded as the capture chain encodes it: 20 ms Opus packets at 64 kbps.
fn tone_packets(count: usize) -> Vec<Vec<u8>> {
    let mut encoder = VoiceEncoder::new(64_000).expect("an encoder");
    (0..count)
        .map(|packet| {
            let start = packet * PACKET_SAMPLES;
            let pcm: Vec<f32> = (0..PACKET_SAMPLES)
                .map(|i| {
                    let t = (start + i) as f32 / SAMPLE_RATE as f32;
                    (t * 440.0 * std::f32::consts::TAU).sin() * 0.5
                })
                .collect();
            let mut out = vec![0u8; MAX_PACKET];
            let n = encoder.encode(&pcm, &mut out).expect("an encoded packet");
            out.truncate(n);
            out
        })
        .collect()
}

/// The whole receive path, from a peer connection to the samples a speaker would emit.
///
/// One participant is pulled, their real Opus is carried over a real peer connection, and what
/// arrives is put through the production jitter buffer, decoder, mixer and render path. Every stage
/// in between is the shipping type, not a stand-in - which is the entire point: each of those stages
/// has unit tests that passed throughout the outage, because the fault was in the joins between
/// them and nothing exercised the joins.
///
/// `device_hz` is the output device's rate, so this also covers the render conversion. 44.1 kHz is
/// not exotic - it is what a great many Windows machines are set to.
async fn hear_a_participant(device_hz: u32) -> Vec<f32> {
    let client = pc().await;
    let sfu = pc().await;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<(String, Packet)>(512);
    let sink: PacketSink = Arc::new(std::sync::Mutex::new(Some(tx)));
    let stats = Arc::new(PublicationStats::default());
    route_inbound_audio(&client, &sink, &stats);

    let mic = Arc::new(TrackLocalStaticSample::new(
        opus_capability(),
        "audio".to_owned(),
        "audio".to_owned(),
    ));
    client
        .add_track(Arc::clone(&mic) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .unwrap();
    client
        .add_transceiver_from_kind(
            RTPCodecType::Audio,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: vec![],
            }),
        )
        .await
        .unwrap();

    let far_end = Arc::new(TrackLocalStaticSample::new(
        opus_capability(),
        "remote".to_owned(),
        "remote".to_owned(),
    ));
    sfu.add_transceiver_from_track(
        Arc::clone(&far_end) as Arc<dyn TrackLocal + Send + Sync>,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Sendonly,
            send_encodings: vec![],
        }),
    )
    .await
    .unwrap();

    negotiate(&client, &sfu).await;

    // Two seconds of tone, sent as the far end would send it.
    let packets = tone_packets(100);
    tokio::spawn(async move {
        for payload in packets {
            let _ = far_end
                .write_sample(&Sample {
                    data: bytes::Bytes::from(payload),
                    duration: Duration::from_millis(20),
                    ..Default::default()
                })
                .await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    // Collected before decoding rather than decoded as they land, so the jitter buffer sees the
    // arrival times of a healthy network instead of the test's own scheduling.
    let mut received: Vec<Packet> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while received.len() < 40 {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some((_, packet))) => received.push(packet),
            _ => break,
        }
    }
    assert!(
        received.len() >= 40,
        "only {} packets crossed the connection; tracks_opened={}, rtp_received={}",
        received.len(),
        stats.tracks_opened.load(Ordering::Relaxed),
        stats.rtp_received.load(Ordering::Relaxed),
    );

    // Decode, mix and render exactly as the playout thread does.
    let mut source = RemoteSource::new().expect("a decoder");
    for (i, packet) in received.iter().enumerate() {
        source.push(packet.clone(), i as u64 * 20);
    }

    let mut mixer = Mixer::new();
    let mut mixed = vec![0.0f32; FRAME * 2];
    let mut speaker = playout::test_sink(device_hz);
    // Two 10 ms frames per 20 ms packet, exactly the ratio the playout thread consumes at.
    for _ in 0..(received.len() * 2) {
        let frame = source.next_frame().to_vec();
        mixer.mix(&[("far-end", frame.as_slice())], &mut mixed);
        speaker.write_stereo(&mixed);
    }

    let mut out = vec![0.0f32; device_hz as usize * 4];
    let n = speaker.drain_for_test(&mut out);
    out.truncate(n);
    // The left channel of the interleaved stereo the device would play.
    out.iter().step_by(2).copied().collect()
}

/// The gate. If this fails, nobody can hear anybody.
///
/// Deliberately asserts on audible energy rather than on packet counts: every counter in the
/// pipeline read healthy through an outage in which not one person could hear another, because a
/// counter proves a stage ran and only the samples prove it produced sound.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_participant_is_audible_end_to_end() {
    for device_hz in [SAMPLE_RATE, 44_100] {
        let played = hear_a_participant(device_hz).await;
        assert!(
            played.len() > device_hz as usize / 2,
            "at {device_hz} Hz only {} samples reached the speakers",
            played.len()
        );

        let tone = energy_at(&played, 440.0, device_hz as f32);
        // A frequency the far end never sent, to tell "the tone arrived" apart from "something
        // loud arrived" - a burst of noise or a stuck buffer would carry both.
        let elsewhere = energy_at(&played, 3_000.0, device_hz as f32);

        assert!(
            tone > 0.01,
            "at {device_hz} Hz the 440 Hz tone came out at {tone}, which is silence"
        );
        assert!(
            tone > elsewhere * 8.0,
            "at {device_hz} Hz the output is not the tone that was sent: 440 Hz {tone}, 3 kHz {elsewhere}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pulled_track_delivers_rtp() {
    let (mids, opened) = subscribe_and_read(1).await;
    assert_eq!(opened, 1, "on_track must fire for the pulled track");
    assert_eq!(mids.len(), 1, "the pulled track must deliver RTP");
}

/// The regression that made the Rust client unable to hear anyone.
///
/// `webrtc-rs` holds one mutex around the `on_track` closure for as long as the future it returns is
/// alive. A handler that reads RTP inline therefore blocks every *later* track from ever being
/// handled - `on_track` never fires for them and not one packet is read. Two tracks is the smallest
/// case that shows it, and two is what a call has as soon as a second person is in it, or as soon as
/// one person's subscription is replaced.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_pulled_track_delivers_rtp_not_just_the_first() {
    let (mids, opened) = subscribe_and_read(3).await;
    assert_eq!(opened, 3, "on_track must fire once per pulled track");
    assert_eq!(mids.len(), 3, "every pulled track must deliver RTP, got {mids:?}");
}
