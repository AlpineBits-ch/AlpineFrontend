//! End-to-end proof that a screen share this client publishes reaches a viewer.
//!
//! Real frames, the real OpenH264 encoder, a real peer connection, real SRTP, and the shipping
//! pump and writer. `a_published_screen_arrives_at_a_viewer_end_to_end` asserts on *the NAL units a
//! viewer reassembles*, not on a counter.
//!
//! The backend is mocked at the socket: a small HTTP server on 127.0.0.1 speaking the four
//! Cloudflare endpoints, with a stand-in SFU peer connection behind it. The real `Signalling` and
//! real `reqwest` run against it, so the URL routing and the camelCase JSON contract are covered on
//! the way past rather than only in isolation.
//!
//! This exists because screen sharing broke twice with the whole suite green, and both faults were
//! invisible from the sharing side. A keyframe interval counted in *frames* on a screen that
//! produces almost none meant a viewer waited forty-five seconds for a decodable picture. One full
//! UDP send queue - which is exactly what a single keyframe's worth of packets does on Windows -
//! ended the publication outright, while capture and encoding carried on happily. In both cases the
//! share reported "running" everywhere except on the wire, and the sharer's own preview is drawn
//! from the capture source and looked perfect throughout.
//!
//! CI runs this on every push. If it fails, do not merge; there is no version of this failing that
//! is not "screen sharing is broken".

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::RgbaImage;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::h264::H264Packet;
use webrtc::rtp::packetizer::Depacketizer;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;

use super::encoder::{
    new_software_encoder, provision_async, EncodeOutcome, EncodedChunk, EncoderContent, EncoderSpec,
    VideoEncoder,
};
use super::pump::{FramePump, PreviewSink, PumpLayer};
use super::rtc::{publisher_api, FrameSink, Publication};
use super::session::{run_writer, WRITE_FAILURES_BEFORE_GIVING_UP};
use super::signalling::{SessionRole, Signalling, VoiceTarget};

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
/// Access unit delimiter and filler data. The payloader drops both by design (RFC 6184 Â§5.4) -
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

// â”€â”€ The stand-in backend â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

struct BackendState {
    /// Cloudflare's side of the connection, and the viewer: the publisher's only peer.
    sfu: Arc<RTCPeerConnection>,
    media_session_id: String,
    /// What `tracks/new` reports, so the renegotiation path can be driven.
    require_renegotiation: bool,
    renegotiations: AtomicU32,
    /// The SSRC of the inbound video, learned from `on_track`. Needed to address a PLI at it.
    media_ssrc: Arc<Mutex<Option<u32>>>,
    closed_tracks: Mutex<Vec<String>>,
    /// Every track name the publisher asked to publish, in order.
    published_tracks: Mutex<Vec<String>>,
    /// Every request path served, so tests can assert on what the publisher actually asked for.
    paths: Mutex<Vec<String>>,
    /// The offer SDP as it arrived, so a test can assert on the bytes the SFU actually reads.
    ///
    /// Simulcast is invisible from this side otherwise: the publisher can hold three tracks and
    /// still have offered one encoding, because webrtc-rs writes the rid and simulcast attributes
    /// from what is attached to the *sender*, not from what the caller is holding.
    offer_sdp: Mutex<Option<String>>,
}

/// A Cloudflare-shaped backend on loopback, with a real peer connection behind it.
struct MockBackend {
    base_url: String,
    state: Arc<BackendState>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for MockBackend {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl MockBackend {
    /// Bind, start serving, and return the access units the viewer reassembles.
    async fn start(require_renegotiation: bool) -> (Self, mpsc::Receiver<AccessUnit>) {
        // The production builder, not a copy of it. Which codecs and interceptors are registered is
        // what decides whether the inbound stream can be matched to a transceiver at all, so a
        // test that builds its own media engine tests its own media engine.
        let sfu = Arc::new(
            publisher_api()
                .expect("the publisher API")
                .new_peer_connection(RTCConfiguration::default())
                .await
                .expect("a peer connection"),
        );

        let (tx, rx) = mpsc::channel::<AccessUnit>(256);
        let media_ssrc = Arc::new(Mutex::new(None));
        route_inbound_video(&sfu, tx, Arc::clone(&media_ssrc));

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
        let port = listener.local_addr().unwrap().port();

        let state = Arc::new(BackendState {
            sfu,
            media_session_id: "cf-session-under-test".to_owned(),
            require_renegotiation,
            renegotiations: AtomicU32::new(0),
            // The same handle the `on_track` reader writes to.
            media_ssrc,
            closed_tracks: Mutex::new(Vec::new()),
            published_tracks: Mutex::new(Vec::new()),
            paths: Mutex::new(Vec::new()),
            offer_sdp: Mutex::new(None),
        });

        let serving = Arc::clone(&state);
        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let state = Arc::clone(&serving);
                tokio::spawn(async move {
                    if let Err(e) = handle_request(stream, state).await {
                        eprintln!("[mock-backend] {e}");
                    }
                });
            }
        });

        (
            Self {
                base_url: format!("http://127.0.0.1:{port}"),
                state,
                server,
            },
            rx,
        )
    }

    /// Block until the transport can actually carry media.
    ///
    /// `Publication::start` returns as soon as the answer is applied, which is *before* ICE and DTLS
    /// finish - in production that is right, because capture should not wait on a handshake and a
    /// viewer's PLI recovers whatever the opening window loses. In a test it is the difference
    /// between asserting on the stream and asserting on a race: without this the first frames are
    /// written into a transport that is not up yet and simply vanish.
    async fn wait_until_connected(&self) {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        self.state
            .sfu
            .on_peer_connection_state_change(Box::new(move |state| {
                let tx = tx.clone();
                Box::pin(async move {
                    if state == RTCPeerConnectionState::Connected {
                        let _ = tx.try_send(());
                    }
                })
            }));

        if self.state.sfu.connection_state() == RTCPeerConnectionState::Connected {
            return;
        }
        tokio::time::timeout(Duration::from_secs(20), rx.recv())
            .await
            .expect("the peer connection must connect")
            .expect("the state-change channel must stay open");
    }

    /// A viewer asking for a decodable picture, the way a browser does: an RTCP PLI.
    async fn request_keyframe(&self) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let ssrc = loop {
            let seen = *self.state.media_ssrc.lock().unwrap();
            if let Some(ssrc) = seen {
                break ssrc;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no inbound track to ask for a keyframe on"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };

        self.state
            .sfu
            .write_rtcp(&[Box::new(PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: ssrc,
            })])
            .await
            .expect("the PLI must reach the publisher");
    }

    fn renegotiations(&self) -> u32 {
        self.state.renegotiations.load(Ordering::Relaxed)
    }

    fn closed_tracks(&self) -> Vec<String> {
        self.state.closed_tracks.lock().unwrap().clone()
    }

    fn published_tracks(&self) -> Vec<String> {
        self.state.published_tracks.lock().unwrap().clone()
    }

    fn paths(&self) -> Vec<String> {
        self.state.paths.lock().unwrap().clone()
    }
}

/// Reassemble inbound RTP into access units.
///
/// The reader is **spawned** and the handler returns immediately: `webrtc-rs` holds one mutex around
/// the `on_track` closure for as long as the future it returns is alive, so reading inside it would
/// starve every track after the first.
fn route_inbound_video(
    sfu: &RTCPeerConnection,
    tx: mpsc::Sender<AccessUnit>,
    media_ssrc: Arc<Mutex<Option<u32>>>,
) {
    sfu.on_track(Box::new(move |track, _receiver, _transceiver| {
        let tx = tx.clone();
        let media_ssrc = Arc::clone(&media_ssrc);
        Box::pin(async move {
            if track.kind() != RTPCodecType::Video {
                return;
            }
            *media_ssrc.lock().unwrap() = Some(track.ssrc());

            tokio::spawn(async move {
                let mut depacketizer = H264Packet::default();
                let mut unit: Vec<u8> = Vec::new();
                while let Ok((packet, _)) = track.read_rtp().await {
                    if packet.payload.is_empty() {
                        continue;
                    }
                    if let Ok(bytes) = depacketizer.depacketize(&packet.payload) {
                        unit.extend_from_slice(&bytes);
                    }
                    // The marker bit ends the access unit: one sample in, one sample out.
                    if packet.header.marker && !unit.is_empty() {
                        if tx.send(nal_bodies(&unit)).await.is_err() {
                            return;
                        }
                        unit.clear();
                    }
                }
            });
        })
    }));
}

/// Read one HTTP/1.1 request, answer it, close.
async fn handle_request(mut stream: TcpStream, state: Arc<BackendState>) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];

    let (body_start, content_length) = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.trim()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            break (end + 4, length);
        }
    };

    while buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    let head = String::from_utf8_lossy(&buf[..body_start]).to_string();
    let request_line = head.lines().next().unwrap_or_default().to_owned();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_owned();
    let path = parts.next().unwrap_or("/").to_owned();
    let body: serde_json::Value =
        serde_json::from_slice(&buf[body_start..]).unwrap_or(serde_json::Value::Null);

    // Method and path together, because the neutral rename changed one without the other: the close
    // route became a POST while Isle's stayed a PUT, and a client that keeps the old verb gets a 405
    // from a path that exists - which reads like a routing problem rather than a contract one.
    state
        .paths
        .lock()
        .unwrap()
        .push(format!("{method} {path}"));
    let response = route(&path, &body, &state).await;
    let payload = response.to_string();

    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{payload}",
                payload.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.flush().await
}

async fn route(
    path: &str,
    body: &serde_json::Value,
    state: &Arc<BackendState>,
) -> serde_json::Value {
    let route = path.split('?').next().unwrap_or(path);

    if route.ends_with("/voice/session") || route.ends_with("/cf/session") {
        // The neutral shape. `backend` is what tells a client which media implementation to pick,
        // and answering without it is how a client would silently assume Cloudflare forever.
        return serde_json::json!({
            "mediaSessionId": state.media_session_id,
            "backend": "cloudflare",
        });
    }

    // The neutral surface collapsed publish and subscribe onto one route; Isle's `cf/tracks/new` is
    // accepted too so the same mock can stand in for either dialect.
    if route.ends_with("/voice/tracks") || route.ends_with("/cf/tracks/new") {
        // Asserted rather than assumed: a publisher that sent Cloudflare's `location` to this route
        // would still get a plausible answer here and fail only against the real backend, which is
        // exactly the class of bug the neutral rename introduces.
        let direction = &body["tracks"][0]["direction"];
        assert_eq!(
            direction, "publish",
            "the neutral surface expects `direction`, got tracks: {}",
            body["tracks"]
        );
        assert!(
            body["mediaSessionId"].is_string(),
            "the neutral surface expects `mediaSessionId`, got body: {body}"
        );

        let answer = answer_the_offer(state, body).await;
        // Every track echoed, not just the first. A share with audio publishes two in one call, and
        // answering for one of them makes the second look like it was silently dropped.
        let echoed: Vec<serde_json::Value> = body["tracks"]
            .as_array()
            .map(|tracks| {
                tracks
                    .iter()
                    .map(|t| serde_json::json!({ "mid": t["mid"], "trackName": t["trackName"] }))
                    .collect()
            })
            .unwrap_or_default();
        state
            .published_tracks
            .lock()
            .unwrap()
            .extend(echoed.iter().filter_map(|t| {
                t["trackName"].as_str().map(str::to_owned)
            }));
        return serde_json::json!({
            "sessionDescription": { "type": "answer", "sdp": answer },
            "tracks": echoed,
            "requiresImmediateRenegotiation": state.require_renegotiation,
        });
    }

    if route.ends_with("/voice/negotiate") || route.ends_with("/cf/renegotiate") {
        state.renegotiations.fetch_add(1, Ordering::Relaxed);
        let answer = answer_the_offer(state, body).await;
        return serde_json::json!({
            "sessionDescription": { "type": "answer", "sdp": answer },
        });
    }

    if route.ends_with("/voice/tracks/close") || route.ends_with("/cf/tracks/close") {
        if let Some(names) = body["trackNames"].as_array() {
            let mut closed = state.closed_tracks.lock().unwrap();
            closed.extend(names.iter().filter_map(|n| n.as_str().map(str::to_owned)));
        }
        return serde_json::json!({});
    }

    // Answered rather than panicked, because this runs in a spawned task where a panic would only
    // hang the request until reqwest's timeout. An empty body fails to deserialise into whatever
    // the caller expected, which surfaces as a real error at the call site.
    eprintln!("[mock-backend] no route for {path}");
    serde_json::json!({})
}

/// Apply the publisher's offer to the stand-in SFU and answer it, candidates included.
///
/// Gathering is awaited before answering because there is no trickle path here, exactly as there is
/// none between the publisher and Cloudflare.
async fn answer_the_offer(state: &Arc<BackendState>, body: &serde_json::Value) -> String {
    let offer = body["sessionDescription"]["sdp"]
        .as_str()
        .expect("an offer SDP")
        .to_owned();
    // Kept before it is applied: this is the only place the exact bytes the SFU reads are visible.
    *state.offer_sdp.lock().unwrap() = Some(offer.clone());

    state
        .sfu
        .set_remote_description(RTCSessionDescription::offer(offer).expect("a parseable offer"))
        .await
        .expect("the offer must apply");

    let answer = state.sfu.create_answer(None).await.expect("an answer");
    let mut gathering = state.sfu.gathering_complete_promise().await;
    state
        .sfu
        .set_local_description(answer)
        .await
        .expect("the answer must apply");
    let _ = tokio::time::timeout(Duration::from_secs(10), gathering.recv()).await;

    state
        .sfu
        .local_description()
        .await
        .expect("a local description after gathering")
        .sdp
}

// â”€â”€ Test doubles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Records every access unit on its way to the transport, so what arrives can be compared with what
/// was sent rather than merely counted.
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

// â”€â”€ Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

/// A frame with structure that moves, so the encoder has something to code and successive frames
/// are genuinely different.
fn frame(shift: u32) -> RgbaImage {
    RgbaImage::from_fn(WIDTH, HEIGHT, |x, y| {
        let v = (((x + shift) / 8 + y / 8) % 2) as u8;
        image::Rgba([v * 255, (x % 256) as u8, ((y + shift) % 256) as u8, 255])
    })
}

fn signalling_to(base_url: &str) -> Signalling {
    Signalling::new(
        base_url.to_owned(),
        "test-token".to_owned(),
        "test-device".to_owned(),
        VoiceTarget::GuildChannel {
            guild_id: "g1".to_owned(),
            channel_id: "c1".to_owned(),
        },
        SessionRole::Secondary,
    )
    .expect("a signalling client")
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

/// Collect access units until `want` have arrived or the stream goes quiet for `idle`.
///
/// Idle-based rather than a single deadline: a stream that has stopped is the interesting outcome
/// and should be reported immediately, not waited out.
async fn collect(rx: &mut mpsc::Receiver<AccessUnit>, want: usize, idle: Duration) -> Vec<AccessUnit> {
    let mut units = Vec::new();
    while units.len() < want {
        match tokio::time::timeout(idle, rx.recv()).await {
            Ok(Some(unit)) => units.push(unit),
            _ => break,
        }
    }
    units
}

/// Three encodings on one m-line, under the rid names the ladder declares.
///
/// <p>Asserted on the offer SDP rather than on our own structs, because the SDP is the only thing
/// the SFU actually reads. webrtc-rs writes `a=rid:<id> send` and `a=simulcast:send f;h;q` from what
/// is attached to the *sender*, so a wiring mistake that created three tracks and attached one would
/// leave `layer_tracks()` looking perfectly correct while the wire carried a single encoding - and
/// the only visible symptom would be an egress bill that never fell.</p>
#[tokio::test]
async fn offers_three_rid_tagged_encodings_on_one_track() {
    let (backend, _frames) = MockBackend::start(false).await;

    let publication = Publication::start(
        signalling_to(&backend.base_url),
        "abc",
        vec![],
        false,
        None,
        3,
    )
    .await
    .expect("the publication must start");

    let sdp = backend
        .state
        .offer_sdp
        .lock()
        .unwrap()
        .clone()
        .expect("an offer must have reached the backend");

    assert!(
        sdp.contains("a=simulcast:send f;h;q"),
        "no simulcast attribute in the offer:\n{sdp}"
    );
    for rid in ["f", "h", "q"] {
        assert!(
            sdp.contains(&format!("a=rid:{rid} send")),
            "no rid {rid} in the offer:\n{sdp}"
        );
    }
    // One video m-line, not three: simulcast is encodings within a track, not separate tracks. Three
    // m-lines would mean three track names, which is a shape the room contract has no room for.
    assert_eq!(sdp.matches("m=video").count(), 1);
    assert_eq!(publication.layer_tracks().len(), 3);
}

/// The merge against a real connection, not a synthetic report. A publication that negotiated
/// three rungs must produce at least one outbound video row for `publish_stats` to pair the ladder
/// against, whatever the wire says about the other two.
///
/// <p>Asserted on `pc.get_stats()` directly rather than through `publish_stats` itself: the command
/// reads its sources from this module's global `active()` handle, and no test may set that handle
/// without racing every other test in the binary that touches the same publish state. Reading the
/// report is the same data `publish_stats` would merge, so this still proves the transport half is
/// really there to be paired with the ladder - only the pairing itself is covered by `stats_tests`
/// in `mod.rs`.</p>
#[tokio::test]
async fn a_started_publication_reports_at_least_one_outbound_video_stream() {
    let (backend, _frames) = MockBackend::start(false).await;

    let publication = Publication::start(
        signalling_to(&backend.base_url),
        "abc",
        vec![],
        false,
        None,
        3,
    )
    .await
    .expect("the publication must start");

    // `get_stats()` only reports an outbound stream once the sender's RTP transport is actually
    // up - `Publication::start` returns as soon as the answer is applied, which in production is
    // deliberately before ICE and DTLS finish, so a report taken immediately after would race the
    // handshake rather than prove anything about it. See `MockBackend::wait_until_connected`.
    backend.wait_until_connected().await;

    // And even connected, webrtc-rs's stats interceptor only starts tracking an SSRC once it has
    // actually carried a packet - a track that has never been written to has nothing to report,
    // same as a rung the pump never got a frame to encode.
    publication
        .write_frame(vec![0, 0, 0, 1, 0x65], Duration::from_millis(33))
        .await
        .expect("a frame should reach the transport");

    let pc = publication.peer_connection();
    let report = pc.get_stats().await;

    let outbound = report
        .reports
        .values()
        .filter(|v| matches!(v, webrtc::stats::StatsReportType::OutboundRTP(s) if s.kind == "video"))
        .count();

    assert!(outbound > 0, "a started publication reports at least one outbound video stream");
}

/// The offer must negotiate the RID header extension, or the ladder is decorative.
///
/// <p><b>This is the half `offers_three_rid_tagged_encodings_on_one_track` cannot see.</b> The
/// `a=rid:`/`a=simulcast:` attributes are written from what is attached to the sender and say what
/// the publisher *intends* to send. What tells the SFU which layer a given packet belongs to is the
/// `sdes:rtp-stream-id` RTP header extension, and `TrackLocalStaticRTP::bind` only stamps it onto
/// outgoing packets when that URI is among the negotiated extensions - see
/// `track_local_static_rtp.rs`, which looks the id up and silently writes no rid when it is absent.</p>
///
/// <p>`MediaEngine::register_default_codecs` does not register it. So without an explicit
/// `register_header_extension`, an offer advertises three encodings, an SFU accepts all three, and
/// then every packet arrives untagged on one SSRC set that cannot be demultiplexed. Nothing errors:
/// the publish succeeds, the answer echoes the rids back, and viewers simply never receive a
/// decodable layer - a tile that loads forever rather than a tile that fails.</p>
#[tokio::test]
async fn offers_the_rid_header_extension_that_makes_layers_identifiable() {
    let (backend, _frames) = MockBackend::start(false).await;

    let _publication = Publication::start(
        signalling_to(&backend.base_url),
        "abc",
        vec![],
        false,
        None,
        3,
    )
    .await
    .expect("the publication must start");

    let sdp = backend
        .state
        .offer_sdp
        .lock()
        .unwrap()
        .clone()
        .expect("an offer must have reached the backend");

    // The mid extension is required alongside it: a stream id is scoped to an m-line, so an SFU
    // needs both to place a packet. webrtc-rs refuses inbound simulcast without either, and the
    // same pairing is what makes outbound identifiable.
    for uri in [
        "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
        "urn:ietf:params:rtp-hdrext:sdes:mid",
    ] {
        assert!(
            sdp.contains(uri),
            "the offer advertises three encodings but never negotiates {uri}, \
             so every packet leaves without a layer tag:\n{sdp}"
        );
    }
}

/// The rollback path. One layer must offer exactly what shipped before simulcast existed.
#[tokio::test]
async fn a_single_layer_offers_no_simulcast_attributes_at_all() {
    let (backend, _frames) = MockBackend::start(false).await;

    let publication = Publication::start(
        signalling_to(&backend.base_url),
        "abc",
        vec![],
        false,
        None,
        1,
    )
    .await
    .expect("the publication must start");

    let sdp = backend
        .state
        .offer_sdp
        .lock()
        .unwrap()
        .clone()
        .expect("an offer must have reached the backend");

    assert!(
        !sdp.contains("a=simulcast:"),
        "a one-layer share advertised simulcast:\n{sdp}"
    );
    assert!(
        !sdp.contains("a=rid:"),
        "a one-layer share advertised a rid:\n{sdp}"
    );
    assert_eq!(publication.layer_tracks().len(), 1);
}

/// The pump, the writer and a live publication, wired as `session::start` wires them.
struct Publishing {
    pump: FramePump<()>,
    sent: Arc<Mutex<Vec<AccessUnit>>>,
}

async fn publishing(
    backend: &MockBackend,
    keyframe_interval: Duration,
    encoder: Box<dyn VideoEncoder>,
) -> Publishing {
    let publication = Publication::start(signalling_to(&backend.base_url), "abc", vec![], false, None, 1)
        .await
        .expect("the publication must start against the mock backend");
    let keyframe_wanted = publication.keyframe_requests();

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
        keyframe_wanted,
        (),
    )
    .with_keyframe_interval(keyframe_interval);

    Publishing { pump, sent }
}

/// The real codec, for the assertions that are about the bitstream.
async fn real_encoder() -> Box<dyn VideoEncoder> {
    provision_async().await;
    new_software_encoder(spec()).expect("the software encoder")
}

// â”€â”€ End to end â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// The one that matters: frames in one end, the same NAL units out the other.
///
/// Every stage of the publish path is real except the backend - the OpenH264 encoder, the pump, the
/// bounded queue, the writer, the peer connection, SRTP, and the RTP packetiser - and the assertion
/// is on what a viewer reassembles rather than on any counter this side keeps. Both failures screen
/// sharing has actually suffered were invisible to a counter.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_published_screen_arrives_at_a_viewer_end_to_end() {
    let (backend, mut units) = MockBackend::start(false).await;
    let mut publishing = publishing(&backend, Duration::from_secs(60), real_encoder().await).await;
    backend.wait_until_connected().await;

    pump_frames(&mut publishing.pump, 32, Duration::from_millis(20), 0).await;
    let received = collect(&mut units, 16, Duration::from_secs(3)).await;

    assert!(
        received.len() >= 8,
        "only {} access units reached the viewer; a share that signals correctly and transports \
         nothing looks exactly like a working one from this side",
        received.len()
    );

    // A viewer cannot decode anything until it has the parameter sets and an IDR, and the first
    // thing it ever sees is the first thing sent. This is the difference between a share that
    // appears at once and one that sits on a placeholder.
    let first: Vec<u8> = received[0].iter().map(|nal| nal_type(nal)).collect();
    for required in [NAL_SPS, NAL_PPS, NAL_IDR] {
        assert!(
            first.contains(&required),
            "the first access unit a viewer receives must carry SPS, PPS and an IDR; got {first:?}"
        );
    }

    // Byte for byte, NAL for NAL, in order.
    let sent = publishing.sent.lock().unwrap().clone();
    assert!(
        sent.len() >= received.len(),
        "the viewer received {} access units but only {} were ever written",
        received.len(),
        sent.len()
    );
    for (index, unit) in received.iter().enumerate() {
        assert_eq!(
            unit, &sent[index],
            "access unit {index} arrived different from how it was sent"
        );
    }
}

/// A viewer that joins mid-share, or loses a burst of packets, asks for a keyframe over RTCP.
///
/// Discarding those requests means waiting out whatever periodic IDR the encoder happens to emit,
/// which on a static screen is the forty-five-second wait this whole area exists to close.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_viewer_that_joins_late_gets_a_keyframe_on_request() {
    let (backend, mut units) = MockBackend::start(false).await;

    // The recording encoder, not the real one, and the wall-clock floor pushed out of reach: after
    // the opening frame the *only* thing in the system that can produce a keyframe is the viewer's
    // request. With openh264 here this assertion passes whether or not the RTCP path works at all -
    // a moving screen makes it emit intra frames of its own accord, which is exactly how a test
    // like this ends up proving nothing.
    let (encoder, log) = recording_encoder();
    let mut publishing = publishing(&backend, Duration::from_secs(600), encoder).await;
    backend.wait_until_connected().await;

    // Get the stream into delta frames, and let the opening keyframe through.
    pump_frames(&mut publishing.pump, 10, Duration::from_millis(20), 0).await;
    let opening = collect(&mut units, 10, Duration::from_secs(3)).await;
    assert!(!opening.is_empty(), "nothing arrived before the PLI");
    assert_eq!(
        log.lock().unwrap().keyframes_at,
        vec![1],
        "only the opening frame should be a keyframe so far"
    );

    backend.request_keyframe().await;

    pump_frames(&mut publishing.pump, 20, Duration::from_millis(20), 10).await;
    let after = collect(&mut units, 20, Duration::from_secs(3)).await;

    assert!(
        log.lock().unwrap().keyframes_at.len() >= 2,
        "the viewer's PLI never reached the encoder; a late joiner would sit on a placeholder \
         until the periodic keyframe, which on a static screen can be a minute away"
    );
    assert!(
        after
            .iter()
            .any(|unit| unit.iter().any(|nal| nal_type(nal) == NAL_IDR)),
        "the encoder produced a keyframe on request but it never reached the viewer"
    );
}

/// Cloudflare sometimes answers a publish by demanding a renegotiation before media flows.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn renegotiation_is_honoured_when_the_backend_asks_for_it() {
    let (backend, mut units) = MockBackend::start(true).await;
    let mut publishing = publishing(&backend, Duration::from_secs(60), real_encoder().await).await;

    assert_eq!(
        backend.renegotiations(),
        1,
        "the backend asked for an immediate renegotiation and did not get one"
    );

    backend.wait_until_connected().await;
    pump_frames(&mut publishing.pump, 16, Duration::from_millis(33), 0).await;
    assert!(
        !collect(&mut units, 4, Duration::from_secs(3)).await.is_empty(),
        "media must still flow after a renegotiation"
    );
}

/// The screen publish must never be recorded as the participant's audio session.
///
/// Asserted here over real HTTP rather than only on the URL builder: marking it primary leaves
/// later joiners subscribing to a session with no audio, and in a DM call triggers device takeover
/// and hangs up the very call being shared into.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_publish_opens_a_secondary_session_and_closes_its_track() {
    let (backend, _units) = MockBackend::start(false).await;
    provision_async().await;

    let publication = Publication::start(signalling_to(&backend.base_url), "abc", vec![], false, None, 1)
        .await
        .expect("the publication must start");
    let track_name = publication.track_name.clone();
    publication.stop().await;

    let paths = backend.paths();
    assert!(
        paths
            .iter()
            .any(|p| p.contains("/voice/session?primary=false")),
        "the session must be opened as secondary; got {paths:?}"
    );
    assert_eq!(
        backend.closed_tracks(),
        vec![track_name],
        "stopping a publication must close its track server-side"
    );

    // The neutral routes, with their verbs. Both halves matter: the paths lost their `cf/` segment
    // and the close changed from PUT to POST, and either alone still reaches a real route on the
    // server and fails for a reason that does not name the contract.
    assert!(
        paths.iter().any(|p| p == "POST /api/v1/guild/guilds/g1/channels/c1/voice/tracks"),
        "publishing must POST the neutral tracks route; got {paths:?}"
    );
    assert!(
        paths
            .iter()
            .any(|p| p == "POST /api/v1/guild/guilds/g1/channels/c1/voice/tracks/close"),
        "closing must POST, not PUT as the Cloudflare surface did; got {paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p.contains("/cf/")),
        "nothing on a guild channel may still speak the Cloudflare surface; got {paths:?}"
    );
}

/// A share that carries its own sound publishes both halves in **one** negotiation, and closes both.
///
/// <p>One call rather than two is the contract (Â§2 of the frontend guide) and it is also what stops
/// a viewer laying out the tile from the video track and then having audio arrive against a share it
/// has already finished building. Asserted over real HTTP because the failure mode is a second
/// `tracks` request nobody notices.</p>
///
/// <p>The capture device is not exercised here - CI has no audio hardware and this is about the
/// negotiation, not the encoder. `publisher::audio` covers the encode path directly.</p>
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_share_with_audio_publishes_and_closes_both_tracks() {
    let (backend, _units) = MockBackend::start(false).await;
    provision_async().await;

    let publication = Publication::start(signalling_to(&backend.base_url), "abc", vec![], true, None, 1)
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

    let track_name = publication.track_name.clone();
    let audio_track_name = publication.audio_track_name.clone().unwrap();
    publication.stop().await;

    assert_eq!(
        backend.published_tracks(),
        vec![track_name.clone(), audio_track_name.clone()],
        "both halves must go out together, video first"
    );
    assert_eq!(
        backend
            .paths()
            .iter()
            .filter(|p| p.ends_with("/voice/tracks"))
            .count(),
        1,
        "one negotiation, not one per track"
    );
    // Closing only the video would leave viewers subscribed to a live audio track from a share that
    // no longer exists - silent, still mixed, and still costing the sharer egress.
    assert_eq!(backend.closed_tracks(), vec![track_name, audio_track_name]);
}

/// The other half of the same rule: no audio asked for, no audio track announced.
///
/// A track that exists and never carries anything is worse than one that was never announced -
/// viewers read `shares[].trackNames` and would open a decoder and a mixer slot for silence.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_share_without_audio_announces_no_audio_track() {
    let (backend, _units) = MockBackend::start(false).await;
    provision_async().await;

    let publication = Publication::start(signalling_to(&backend.base_url), "abc", vec![], false, None, 1)
        .await
        .expect("the publication must start");

    assert!(publication.audio_track_name.is_none());
    assert!(publication.audio_track().is_none());

    let track_name = publication.track_name.clone();
    publication.stop().await;

    assert_eq!(backend.published_tracks(), vec![track_name.clone()]);
    assert_eq!(backend.closed_tracks(), vec![track_name]);
}

// â”€â”€ Pump policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn pump_with(
    encoder: Box<dyn VideoEncoder>,
    keyframe_wanted: Arc<AtomicBool>,
    queue: usize,
) -> (
    FramePump<()>,
    mpsc::Receiver<(Vec<u8>, Duration)>,
) {
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

// â”€â”€ Writer resilience â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
