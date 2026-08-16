//! The Phase 0 probe engine: a LiveKit publisher driven by signal events.
//!
//! Deliberately minimal. It answers the compatibility questions in the spec's Phase 0 and nothing
//! else - no reconnect, no roster, no stats, no entitlements. Phase 1 grows the real engine from
//! what this learns, and none of this is on a production path.
//!
//! **Candidates ride in the SDP rather than trickling.** `gathering_complete_promise()` is what
//! `media::voice::rtc` and `media::publisher::rtc` both already do, and an offer that carries its
//! candidates needs no `TrickleRequest` at all. Trickle is the more responsive design and Phase 1
//! may well want it; for a probe it is a moving part with nothing to prove.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use livekit_api::signal_client::{SignalClient, SignalEvent, SignalEvents};
use livekit_protocol as proto;
use tokio::sync::Mutex;
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::media::publisher::rtc::h264_capability;
use crate::media::voice::rtc::voice_api;

/// How long to wait for the server to confirm a publication before giving up.
///
/// The SID only exists once `AddTrackRequest` was accepted, so exceeding this means the request was
/// rejected rather than delayed - a codec or naming disagreement, which is exactly what the probe
/// is here to surface.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Probe {
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    /// The connection the server offers on. We never add anything to it locally.
    subscriber: Arc<RTCPeerConnection>,
    /// Track SIDs the server has confirmed, as `(cid, sid)`.
    published: Arc<Mutex<Vec<(String, String)>>>,
    /// Published audio tracks, retained so something can be written to them.
    audio: Arc<Mutex<Vec<Arc<TrackLocalStaticSample>>>>,
    /// Opus packets successfully handed to a track.
    packets_sent: Arc<AtomicU64>,
    /// RTP packets read off subscribed tracks.
    rtp_received: Arc<AtomicU64>,
}

/// Count every RTP packet arriving on any subscribed track.
///
/// The reader is **spawned** and the handler returns immediately, matching `media::voice::rtc`:
/// `webrtc-rs` serialises `on_track`, so reading inline blocks every later track from ever opening.
fn install_receive_counter(subscriber: &Arc<RTCPeerConnection>, counter: Arc<AtomicU64>) {
    subscriber.on_track(Box::new(move |track, _receiver, _transceiver| {
        let counter = counter.clone();
        Box::pin(async move {
            tokio::spawn(async move {
                while track.read_rtp().await.is_ok() {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
            });
        })
    }));
}

impl Probe {
    pub async fn connect(url: &str, token: &str) -> Result<Self, String> {
        let (signal, join, events) =
            SignalClient::connect(url, token, super::signal::connect_options(), None)
                .await
                .map_err(|e| e.to_string())?;

        // ICE servers come from the JoinResponse rather than from our own configuration. This is
        // the difference the spec calls out: there is no `/voice/ice-servers` read any more and no
        // static list, because the node tells us what it is reachable on.
        let config = RTCConfiguration {
            ice_servers: join
                .ice_servers
                .iter()
                .map(|server| RTCIceServer {
                    urls: server.urls.clone(),
                    username: server.username.clone(),
                    credential: server.credential.clone(),
                })
                .collect(),
            ..Default::default()
        };

        // Cloned rather than rebuilt: both connections talk to the same node, so they take the same
        // ICE configuration, and `RTCConfiguration` is consumed by `new_peer_connection`.
        let config_for_subscriber = config.clone();

        let api = voice_api()?;
        let publisher = Arc::new(
            api.new_peer_connection(config)
                .await
                .map_err(|e| e.to_string())?,
        );

        // LiveKit gates publisher readiness on these two existing. A publisher connection without
        // them negotiates and then never reaches connected, with nothing saying why.
        publisher
            .create_data_channel("_lossy", None)
            .await
            .map_err(|e| e.to_string())?;
        publisher
            .create_data_channel("_reliable", None)
            .await
            .map_err(|e| e.to_string())?;

        // The subscriber connection. LiveKit is subscriber-primary: the server offers on this one
        // whenever it has something for us, and we only ever answer. Nothing is added to it locally.
        let api = voice_api()?;
        let subscriber = Arc::new(
            api.new_peer_connection(config_for_subscriber)
                .await
                .map_err(|e| e.to_string())?,
        );

        let rtp_received = Arc::new(AtomicU64::new(0));
        install_receive_counter(&subscriber, rtp_received.clone());

        let signal = Arc::new(signal);
        let published = Arc::new(Mutex::new(Vec::new()));

        tokio::spawn(pump(
            events,
            signal.clone(),
            publisher.clone(),
            subscriber.clone(),
            published.clone(),
        ));

        Ok(Self {
            signal,
            publisher,
            subscriber,
            published,
            audio: Arc::new(Mutex::new(Vec::new())),
            packets_sent: Arc::new(AtomicU64::new(0)),
            rtp_received,
        })
    }

    /// Ask the server for one published track. It answers by offering on the subscriber connection.
    pub async fn subscribe(&self, track_sid: &str) -> Result<(), String> {
        self.signal
            .send(proto::signal_request::Message::Subscription(
                proto::UpdateSubscription {
                    track_sids: vec![track_sid.to_string()],
                    subscribe: true,
                    ..Default::default()
                },
            ))
            .await;
        Ok(())
    }

    /// RTP packets read off subscribed tracks.
    ///
    /// Packets, not a connection state. A subscriber that reaches `connected` and receives nothing
    /// is a distinct failure from one that never connected, and only a counter tells them apart.
    pub fn rtp_received(&self) -> u64 {
        self.rtp_received.load(Ordering::Relaxed)
    }

    /// Publish one Opus track under `name`, and return the SID the server assigned it.
    pub async fn publish_audio(&self, name: &str) -> Result<String, String> {
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48_000,
                channels: 1,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                ..Default::default()
            },
            name.to_string(),
            name.to_string(),
        ));
        let cid = track.id().to_string();

        // Request first: the server issues the SID, and adding a track without asking produces a
        // publication the roster never learns about - the media equivalent of not calling
        // `POST .../voice/publish`.
        self.signal
            .send(proto::signal_request::Message::AddTrack(
                proto::AddTrackRequest {
                    cid: cid.clone(),
                    name: name.to_string(),
                    r#type: proto::TrackType::Audio as i32,
                    source: proto::TrackSource::Microphone as i32,
                    ..Default::default()
                },
            ))
            .await;

        self.publisher
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        self.audio.lock().await.push(track);

        self.negotiate().await?;
        self.await_sid(&cid).await
    }

    /// Publish H.264 as a simulcast ladder, and return the SID the server assigned it.
    ///
    /// The `layers` we declare are what the server maps rid to quality by; it never reads the rid
    /// names themselves. Highest first, matching `LAYER_RIDS`.
    pub async fn publish_video(
        &self,
        name: &str,
        layers: &[(&str, u32, u32)],
    ) -> Result<String, String> {
        if layers.is_empty() {
            return Err("a ladder needs at least one layer".to_string());
        }

        self.signal
            .send(proto::signal_request::Message::AddTrack(
                proto::AddTrackRequest {
                    cid: name.to_string(),
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
                },
            ))
            .await;

        // One track per rid, sharing id and stream_id and differing only by rid. This is the same
        // construction `media::publisher::rtc` already uses: `add_encoding` rejects any other
        // combination, and the base track must itself carry a rid or the sender refuses with
        // ErrRTPSenderNoBaseEncoding.
        let mut layer_tracks: Vec<Arc<TrackLocalStaticSample>> = Vec::with_capacity(layers.len());
        for (rid, _, _) in layers {
            layer_tracks.push(Arc::new(TrackLocalStaticSample::new_with_rid(
                h264_capability(),
                name.to_string(),
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
        self.await_sid(name).await
    }

    /// Wait until the publisher connection is carrying media, or give up.
    ///
    /// **`publish_*` returning is not this.** The SID arrives on `TrackPublishedResponse`, which the
    /// server can send before its `Answer` - so a caller that reads the remote description straight
    /// after publishing finds nothing there. Anything that depends on the negotiation having
    /// completed has to wait for it explicitly.
    pub async fn wait_until_connected(&self, timeout: Duration) -> Result<(), String> {
        use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            match self.publisher.connection_state() {
                RTCPeerConnectionState::Connected => return Ok(()),
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    return Err(format!("publisher {}", self.publisher.connection_state()))
                }
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        Err(format!(
            "publisher stuck at {} after {timeout:?}",
            self.publisher.connection_state()
        ))
    }

    /// The offer this connection last sent, for inspecting what was actually negotiated.
    pub async fn local_sdp(&self) -> Option<String> {
        self.publisher.local_description().await.map(|d| d.sdp)
    }

    /// The answer the server returned, which is where a rejected codec shows up.
    pub async fn remote_sdp(&self) -> Option<String> {
        self.publisher.remote_description().await.map(|d| d.sdp)
    }

    async fn negotiate(&self) -> Result<(), String> {
        let offer = self
            .publisher
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        let mut gathering = self.publisher.gathering_complete_promise().await;
        self.publisher
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let _ = gathering.recv().await;

        let local = self
            .publisher
            .local_description()
            .await
            .ok_or("no local description after gathering")?;

        self.signal
            .send(proto::signal_request::Message::Offer(
                proto::SessionDescription {
                    r#type: "offer".to_string(),
                    sdp: local.sdp,
                    ..Default::default()
                },
            ))
            .await;
        Ok(())
    }

    async fn await_sid(&self, cid: &str) -> Result<String, String> {
        let deadline = tokio::time::Instant::now() + PUBLISH_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if let Some((_, sid)) = self
                .published
                .lock()
                .await
                .iter()
                .find(|(candidate, _)| candidate == cid)
                .cloned()
            {
                return Ok(sid);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(format!("no TrackPublishedResponse for cid {cid}"))
    }

    /// Send a 440 Hz tone for `duration`, one 20 ms Opus packet at a time.
    ///
    /// A tone rather than silence: Opus encodes true silence to a handful of bytes, and a receiver
    /// discarding those looks identical to one that never got the stream at all. It is also what
    /// makes the listening check meaningful.
    pub fn pump_tone_for(&self, duration: Duration) {
        let audio = self.audio.clone();
        let sent = self.packets_sent.clone();
        tokio::spawn(async move {
            let Some(track) = audio.lock().await.first().cloned() else {
                return;
            };
            let mut encoder = crate::media::voice::codec::VoiceEncoder::new(32_000)
                .expect("opus encoder for the probe tone");

            // 20 ms at 48 kHz mono - the packetisation `media::voice::rtc` is built around.
            const SAMPLES: usize = 960;
            let mut pcm = [0f32; SAMPLES];
            let mut out = [0u8; 4000];
            let mut phase = 0f32;

            let deadline = tokio::time::Instant::now() + duration;
            while tokio::time::Instant::now() < deadline {
                for sample in pcm.iter_mut() {
                    phase += 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
                    *sample = phase.sin() * 0.25;
                }
                let Ok(len) = encoder.encode(&pcm, &mut out) else {
                    break;
                };
                if track
                    .write_sample(&webrtc::media::Sample {
                        data: bytes::Bytes::copy_from_slice(&out[..len]),
                        duration: Duration::from_millis(20),
                        ..Default::default()
                    })
                    .await
                    .is_ok()
                {
                    sent.fetch_add(1, Ordering::Relaxed);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
    }

    pub fn packets_sent(&self) -> u64 {
        self.packets_sent.load(Ordering::Relaxed)
    }

    /// The publisher connection's own state.
    ///
    /// Load-bearing in the tests rather than diagnostic. `write_sample` returns `Ok` for a track on
    /// a peer connection that never completed ICE - it hands the sample to a packetiser and nothing
    /// downstream reports back - so a packet count on its own passes against a dead connection.
    pub fn publisher_state(&self) -> webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState {
        self.publisher.connection_state()
    }

    pub async fn close(self) {
        self.signal.close().await;
        let _ = self.publisher.close().await;
    }
}

/// Apply what the server says. Only the messages the probe needs are handled.
async fn pump(
    mut events: SignalEvents,
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    subscriber: Arc<RTCPeerConnection>,
    published: Arc<Mutex<Vec<(String, String)>>>,
) {
    while let Some(event) = events.recv().await {
        let SignalEvent::Message(message) = event else {
            break;
        };
        match *message {
            // The server offers on the subscriber connection whenever it has something for us -
            // this is the whole of subscriber-primary. We only ever answer.
            proto::signal_response::Message::Offer(offer) => {
                if let Err(e) = answer_subscriber(&signal, &subscriber, offer.sdp).await {
                    eprintln!("[probe] could not answer the subscriber offer: {e}");
                }
            }
            proto::signal_response::Message::Answer(answer) => {
                match RTCSessionDescription::answer(answer.sdp) {
                    Ok(description) => {
                        if let Err(e) = publisher.set_remote_description(description).await {
                            eprintln!("[probe] publisher answer rejected: {e}");
                        }
                    }
                    Err(e) => eprintln!("[probe] unparseable answer: {e}"),
                }
            }
            proto::signal_response::Message::TrackPublished(response) => {
                let sid = response.track.map(|track| track.sid).unwrap_or_default();
                published.lock().await.push((response.cid, sid));
            }
            proto::signal_response::Message::Leave(leave) => {
                eprintln!("[probe] server asked us to leave: {leave:?}");
                break;
            }
            _ => {}
        }
    }
}

/// Answer an offer the server made on the subscriber connection.
///
/// Candidates ride in the answer for the same reason they ride in the offer - see the module note.
async fn answer_subscriber(
    signal: &Arc<SignalClient>,
    subscriber: &Arc<RTCPeerConnection>,
    sdp: String,
) -> Result<(), String> {
    let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
    subscriber
        .set_remote_description(offer)
        .await
        .map_err(|e| e.to_string())?;

    let answer = subscriber
        .create_answer(None)
        .await
        .map_err(|e| e.to_string())?;
    let mut gathering = subscriber.gathering_complete_promise().await;
    subscriber
        .set_local_description(answer)
        .await
        .map_err(|e| e.to_string())?;
    let _ = gathering.recv().await;

    let local = subscriber
        .local_description()
        .await
        .ok_or("no local description after gathering")?;

    signal
        .send(proto::signal_request::Message::Answer(
            proto::SessionDescription {
                r#type: "answer".to_string(),
                sdp: local.sdp,
                ..Default::default()
            },
        ))
        .await;
    Ok(())
}
