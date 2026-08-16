//! One LiveKit room: the signal connection, two peer connections, and what is published on them.
//!
//! Grown from the Phase 0 probe, which is deleted now that this covers it. Everything below the
//! transport - capture, processing, Opus, the Media Foundation encoder, jitter, the mixer - is
//! untouched and lives where it always did. This module is only how those bytes reach the SFU.
//!
//! # Two peer connections, and why not one
//!
//! LiveKit is *subscriber primary*: the server offers on the subscriber connection whenever it has
//! something for us, and we offer on the publisher connection when we have something for it. The
//! roles never cross, which is what makes the negotiation here as simple as it is - every offer this
//! module creates is ours, and every offer it receives is the server's.
//!
//! `livekit-server` 1.13.5 does support a single bidirectional connection
//! (`SignalOptions::single_peer_connection`, measured available on 2026-08-16). It is deliberately
//! not used: collapsing the two would mean both ends can offer on one connection, which is glare,
//! and glare handling is a poor trade for one saved connection in a client that drives `webrtc-rs`
//! directly rather than through LiveKit's own SDK.
//!
//! # Candidates ride in the SDP
//!
//! `gathering_complete_promise()` rather than trickle, matching `media::voice::rtc` and
//! `media::publisher::rtc`. An offer that carries its own candidates needs no `TrickleRequest` at
//! all, and the probe confirmed the server is happy with it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use livekit_api::signal_client::{SignalClient, SignalEvent, SignalEvents};
use livekit_protocol as proto;
use tokio::sync::Mutex;
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use super::identity::user_of;
use super::resume::{resume_action, Resume};
use crate::media::publisher::rtc::{h264_capability, publisher_api};
use crate::media::voice::rtc::voice_api;

/// How long to wait for the server to confirm a publication.
///
/// Exceeding it means `AddTrackRequest` was refused rather than delayed - a codec or naming
/// disagreement - which is a different problem from a slow network and should not be retried as one.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(5);

/// One track we have published, as both ends name it.
#[derive(Debug, Clone)]
pub struct Publication {
    /// Our name for it: `audio`, `screen-{shareId}`, `screen-audio-{shareId}`.
    pub track_name: String,
    /// The server's id, issued on `TrackPublishedResponse` and required to unpublish.
    pub sid: String,
}

/// A remote track the server has told us about.
#[derive(Debug, Clone)]
pub struct RemoteTrack {
    pub sid: String,
    pub track_name: String,
    /// The publisher's identity, which may be `{userId}#{tag}`.
    pub identity: String,
    /// The user behind that identity. See [`super::identity`].
    pub user_id: String,
    pub kind: proto::TrackType,
}

/// Counters for one room.
///
/// Every one of these exists because the corresponding failure was otherwise silent, exactly as in
/// `media::voice::rtc::PublicationStats`. A room that signals correctly and carries nothing looks
/// identical to a working one from every layer above.
#[derive(Default)]
pub struct RoomStats {
    /// Encoded packets handed to a local track.
    pub packets_sent: AtomicU64,
    /// RTP packets read off subscribed tracks.
    pub rtp_received: AtomicU64,
    /// `on_track` firings - one per subscribed track that actually opened.
    pub tracks_opened: AtomicU64,
    /// Signal connection drops. Non-zero with a healthy call is the interesting case.
    pub signal_drops: AtomicU64,
}

pub struct Room {
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    subscriber: Arc<RTCPeerConnection>,
    /// The connection we were given, kept for resume. See [`super::resume`].
    url: String,
    token: Mutex<String>,
    token_minted: Mutex<Instant>,
    /// Confirmed publications, keyed by the cid we asked under.
    published: Arc<Mutex<HashMap<String, Publication>>>,
    /// Local tracks, retained so something can be written to them.
    local: Arc<Mutex<HashMap<String, Arc<TrackLocalStaticSample>>>>,
    /// What the server has told us other people are publishing.
    remote: Arc<Mutex<HashMap<String, RemoteTrack>>>,
    pub stats: Arc<RoomStats>,
}

impl Room {
    /// Open a room. `tag` is `None` for the primary connection - see [`super::identity`].
    pub async fn connect(url: &str, token: &str) -> Result<Self, String> {
        let (signal, join, events) =
            SignalClient::connect(url, token, super::signal::connect_options(), None)
                .await
                .map_err(|e| e.to_string())?;

        // ICE configuration comes from the join, not from us. There is no `/voice/ice-servers` read
        // any more and no static list: the node states what it is reachable on, and a room lives on
        // exactly one node.
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
        let subscriber_config = config.clone();

        // `publisher_api`, never `voice_api`, for the publishing side. The offer's codec list comes
        // from the media engine, and only that one registers H.264 High 5.2 on payload type 118 -
        // which is what the SFU now answers with, and what makes 1440p60 conformant.
        let publisher = Arc::new(
            publisher_api()?
                .new_peer_connection(config)
                .await
                .map_err(|e| e.to_string())?,
        );

        // Mandatory. LiveKit gates publisher readiness on both existing; without them the
        // connection negotiates and then never reaches `connected`, with nothing saying why.
        publisher
            .create_data_channel("_lossy", None)
            .await
            .map_err(|e| e.to_string())?;
        publisher
            .create_data_channel("_reliable", None)
            .await
            .map_err(|e| e.to_string())?;

        let subscriber = Arc::new(
            voice_api()?
                .new_peer_connection(subscriber_config)
                .await
                .map_err(|e| e.to_string())?,
        );

        let stats = Arc::new(RoomStats::default());
        let remote = Arc::new(Mutex::new(HashMap::new()));
        let published = Arc::new(Mutex::new(HashMap::new()));

        install_receive_counter(&subscriber, stats.clone());

        let signal = Arc::new(signal);
        tokio::spawn(pump(
            events,
            signal.clone(),
            publisher.clone(),
            subscriber.clone(),
            published.clone(),
            remote.clone(),
            stats.clone(),
        ));

        // Whatever the join already told us about, before any event arrives.
        record_participants(&remote, &join.other_participants).await;

        Ok(Self {
            signal,
            publisher,
            subscriber,
            url: url.to_string(),
            token: Mutex::new(token.to_string()),
            token_minted: Mutex::new(Instant::now()),
            published,
            local: Arc::new(Mutex::new(HashMap::new())),
            remote,
            stats,
        })
    }

    /// Whether a reconnect can use what we hold, or needs a new connection first.
    ///
    /// The room decides; it does not fetch. Under the migration's §2.2 the webview owns every
    /// control-plane call, because it has the interceptor chain that can refresh an expired bearer -
    /// a token string captured at join time cannot.
    pub async fn resume_needs(&self, disconnected_for: Duration, auth_refused: bool) -> Resume {
        let age = self.token_minted.lock().await.elapsed();
        resume_action(age, disconnected_for, auth_refused)
    }

    /// Adopt a freshly minted token. The URL never changes - a room does not move nodes.
    pub async fn adopt_token(&self, token: &str) {
        *self.token.lock().await = token.to_string();
        *self.token_minted.lock().await = Instant::now();
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Publish the microphone. Exactly one per participant, always named `audio`.
    pub async fn publish_audio(&self, name: &str) -> Result<Publication, String> {
        self.publish_audio_as(name, proto::TrackSource::Microphone)
            .await
    }

    /// Publish an Opus track under a stated source.
    ///
    /// The source is not decoration: a screen share's own sound is
    /// `TrackSource::ScreenShareAudio`, and announcing it as a microphone would have every client
    /// that groups by source treat the share's audio as a second person talking. The track *name*
    /// still carries the pairing (`screen-audio-{shareId}`); this is what tells a client the kind
    /// before it has parsed the name.
    pub async fn publish_audio_as(
        &self,
        name: &str,
        source: proto::TrackSource,
    ) -> Result<Publication, String> {
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48_000,
                channels: 1,
                // Matches `media::voice::rtc::opus_capability` exactly. `useinbandfec=1` is what
                // makes the receiver ask for the redundancy the encoder already produces.
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                ..Default::default()
            },
            name.to_string(),
            name.to_string(),
        ));
        let cid = track.id().to_string();

        self.request_track(proto::AddTrackRequest {
            cid: cid.clone(),
            name: name.to_string(),
            r#type: proto::TrackType::Audio as i32,
            source: source as i32,
            ..Default::default()
        })
        .await;

        self.publisher
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;
        self.local.lock().await.insert(name.to_string(), track);

        self.negotiate().await?;
        self.await_publication(&cid).await
    }

    /// Publish a screen share as a simulcast ladder, highest layer first.
    ///
    /// `layers` is `(rid, width, height)`. The rids are ours (`f`/`h`/`q`); what the server maps
    /// quality by is the `layers` list in the request, not the rid strings - it never reads those.
    pub async fn publish_video(
        &self,
        name: &str,
        layers: &[(&str, u32, u32)],
    ) -> Result<Publication, String> {
        let (_, top_width, top_height) = *layers.first().ok_or("a ladder needs a layer")?;

        self.request_track(proto::AddTrackRequest {
            cid: name.to_string(),
            name: name.to_string(),
            r#type: proto::TrackType::Video as i32,
            source: proto::TrackSource::ScreenShare as i32,
            width: top_width,
            height: top_height,
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
        })
        .await;

        // One track per rid, sharing id and stream_id and differing only by rid - the construction
        // `media::publisher::rtc` already uses. `add_encoding` rejects any other combination, and
        // the base track must itself carry a rid or the sender refuses with
        // ErrRTPSenderNoBaseEncoding.
        let mut ladder: Vec<Arc<TrackLocalStaticSample>> = Vec::with_capacity(layers.len());
        for (rid, _, _) in layers {
            ladder.push(Arc::new(TrackLocalStaticSample::new_with_rid(
                h264_capability(),
                name.to_string(),
                (*rid).to_owned(),
                name.to_string(),
            )));
        }

        let sender = self
            .publisher
            .add_track(Arc::clone(&ladder[0]) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        // Every encoding has to be attached before the offer is created: the sender refuses one
        // afterwards (ErrRTPSenderSendAlreadyCalled), and the SDP is built from whatever is
        // attached at that moment.
        for track in ladder.iter().skip(1) {
            sender
                .add_encoding(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|e| format!("could not attach a simulcast layer: {e}"))?;
        }

        {
            let mut local = self.local.lock().await;
            for (index, track) in ladder.into_iter().enumerate() {
                local.insert(format!("{name}#{index}"), track);
            }
        }

        self.negotiate().await?;
        self.await_publication(name).await
    }

    /// Ask the server for a track. It answers by offering on the subscriber connection.
    pub async fn subscribe(&self, track_sid: &str) {
        self.signal
            .send(proto::signal_request::Message::Subscription(
                proto::UpdateSubscription {
                    track_sids: vec![track_sid.to_string()],
                    subscribe: true,
                    ..Default::default()
                },
            ))
            .await;
    }

    pub async fn unsubscribe(&self, track_sid: &str) {
        self.signal
            .send(proto::signal_request::Message::Subscription(
                proto::UpdateSubscription {
                    track_sids: vec![track_sid.to_string()],
                    subscribe: false,
                    ..Default::default()
                },
            ))
            .await;
    }

    /// Everything the server has told us other people are publishing.
    pub async fn remote_tracks(&self) -> Vec<RemoteTrack> {
        self.remote.lock().await.values().cloned().collect()
    }

    /// A local track by the name it was published under, for writing samples to.
    pub async fn local_track(&self, name: &str) -> Option<Arc<TrackLocalStaticSample>> {
        self.local.lock().await.get(name).cloned()
    }

    /// The simulcast ladder for a published video track, highest layer first.
    ///
    /// Ordered, and that ordering is the contract: index 0 is the top layer, which is what every
    /// non-simulcast path means when it says "the track" and what carries the frame writes. Empty
    /// when nothing of that name is published, which a caller must treat as a failed publish rather
    /// than as a share with no layers.
    pub async fn local_ladder(&self, name: &str) -> Vec<Arc<TrackLocalStaticSample>> {
        let local = self.local.lock().await;
        let mut ladder = Vec::new();
        for index in 0.. {
            match local.get(&format!("{name}#{index}")) {
                Some(track) => ladder.push(track.clone()),
                None => break,
            }
        }
        ladder
    }

    pub fn publisher_state(&self) -> RTCPeerConnectionState {
        self.publisher.connection_state()
    }

    pub fn subscriber_state(&self) -> RTCPeerConnectionState {
        self.subscriber.connection_state()
    }

    /// Wait until the publisher connection is carrying media.
    ///
    /// **Publishing having returned is not this.** The SID arrives on `TrackPublishedResponse`,
    /// which the server can send *before* its `Answer` - so a caller that reads the remote
    /// description straight after publishing finds nothing there. Measured, not theorised; it cost a
    /// red test in Phase 0.
    pub async fn wait_until_connected(&self, timeout: Duration) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            match self.publisher.connection_state() {
                RTCPeerConnectionState::Connected => return Ok(()),
                state @ (RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) => {
                    return Err(format!("publisher {state}"))
                }
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        Err(format!(
            "publisher stuck at {} after {timeout:?}",
            self.publisher.connection_state()
        ))
    }

    pub async fn local_sdp(&self) -> Option<String> {
        self.publisher.local_description().await.map(|d| d.sdp)
    }

    pub async fn remote_sdp(&self) -> Option<String> {
        self.publisher.remote_description().await.map(|d| d.sdp)
    }

    pub async fn close(self) {
        self.signal.close().await;
        let _ = self.publisher.close().await;
        let _ = self.subscriber.close().await;
    }

    async fn request_track(&self, request: proto::AddTrackRequest) {
        // Requested before the track is added, deliberately. The server issues the SID, and adding
        // a track without asking produces a publication the roster never learns about - the media
        // equivalent of publishing without calling `POST .../voice/publish`.
        self.signal
            .send(proto::signal_request::Message::AddTrack(request))
            .await;
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

    async fn await_publication(&self, cid: &str) -> Result<Publication, String> {
        let deadline = tokio::time::Instant::now() + PUBLISH_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if let Some(publication) = self.published.lock().await.get(cid).cloned() {
                return Ok(publication);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(format!("no TrackPublishedResponse for cid {cid}"))
    }
}

/// Count every RTP packet arriving on any subscribed track.
///
/// The reader is **spawned** and the handler returns immediately, matching `media::voice::rtc`:
/// `webrtc-rs` serialises `on_track`, so reading inline blocks every later track from ever opening.
fn install_receive_counter(subscriber: &Arc<RTCPeerConnection>, stats: Arc<RoomStats>) {
    subscriber.on_track(Box::new(move |track, _receiver, _transceiver| {
        let stats = stats.clone();
        Box::pin(async move {
            stats.tracks_opened.fetch_add(1, Ordering::Relaxed);
            tokio::spawn(async move {
                while track.read_rtp().await.is_ok() {
                    stats.rtp_received.fetch_add(1, Ordering::Relaxed);
                }
            });
        })
    }));
}

async fn record_participants(
    remote: &Arc<Mutex<HashMap<String, RemoteTrack>>>,
    participants: &[proto::ParticipantInfo],
) {
    let mut map = remote.lock().await;
    for participant in participants {
        for track in &participant.tracks {
            map.insert(
                track.sid.clone(),
                RemoteTrack {
                    sid: track.sid.clone(),
                    track_name: track.name.clone(),
                    identity: participant.identity.clone(),
                    // The identity is enough on its own - `{userId}#{tag}` splits on the first `#`
                    // and user ids are Sqids - so a track never has to wait for a snapshot to learn
                    // whose it is.
                    user_id: user_of(&participant.identity).to_string(),
                    kind: proto::TrackType::try_from(track.r#type)
                        .unwrap_or(proto::TrackType::Audio),
                },
            );
        }
    }
}

/// Apply what the server says.
#[allow(clippy::too_many_arguments)]
async fn pump(
    mut events: SignalEvents,
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    subscriber: Arc<RTCPeerConnection>,
    published: Arc<Mutex<HashMap<String, Publication>>>,
    remote: Arc<Mutex<HashMap<String, RemoteTrack>>>,
    stats: Arc<RoomStats>,
) {
    while let Some(event) = events.recv().await {
        let message = match event {
            SignalEvent::Message(message) => message,
            SignalEvent::Close(reason) => {
                // Recorded rather than acted on here. What to do about it is a policy the session
                // layer owns, because only it can ask for a fresh connection - see `Room::
                // resume_needs` and the migration spec §2.2.
                stats.signal_drops.fetch_add(1, Ordering::Relaxed);
                eprintln!("[livekit] signal closed: {reason}");
                break;
            }
        };

        match *message {
            // Ours, answered. The publisher connection only ever offers.
            proto::signal_response::Message::Answer(answer) => {
                match RTCSessionDescription::answer(answer.sdp) {
                    Ok(description) => {
                        if let Err(e) = publisher.set_remote_description(description).await {
                            eprintln!("[livekit] publisher answer rejected: {e}");
                        }
                    }
                    Err(e) => eprintln!("[livekit] unparseable answer: {e}"),
                }
            }
            // Theirs, answered by us. The subscriber connection only ever answers.
            proto::signal_response::Message::Offer(offer) => {
                if let Err(e) = answer_subscriber(&signal, &subscriber, offer.sdp).await {
                    eprintln!("[livekit] could not answer the subscriber offer: {e}");
                }
            }
            proto::signal_response::Message::TrackPublished(response) => {
                if let Some(track) = response.track {
                    published.lock().await.insert(
                        response.cid,
                        Publication {
                            track_name: track.name,
                            sid: track.sid,
                        },
                    );
                }
            }
            proto::signal_response::Message::Update(update) => {
                record_participants(&remote, &update.participants).await;
            }
            proto::signal_response::Message::Leave(leave) => {
                eprintln!("[livekit] server asked us to leave: {leave:?}");
                break;
            }
            _ => {}
        }
    }
}

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
