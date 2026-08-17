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
//! # Candidates: ours ride in the SDP, theirs trickle
//!
//! **The two directions are not symmetric, and conflating them cost a working connection.**
//!
//! *Outbound*, `gathering_complete_promise()` rather than trickle, matching `media::voice::rtc` and
//! `media::publisher::rtc`: an offer that carries its own candidates needs no `TrickleRequest`, and
//! the server is happy with it.
//!
//! *Inbound* is the opposite. LiveKit **trickles its own candidates** rather than putting them all
//! in the answer, so a client that ignores `Trickle` has no remote candidates at all: the SDP
//! exchange completes, the peer connection sits at `connecting` until the server gives up with
//! `LeaveRequest { reason: ConnectionTimeout }`, and nothing anywhere says the word "candidate".
//! A local dev server hides this, because gathering finishes before it sends the answer and the
//! candidates end up inline.
//!
//! They also arrive **before** the description they belong to, so they are buffered until the
//! remote description exists and flushed immediately after - `add_ice_candidate` on a connection
//! with no remote description is an error, and dropping them is the same failure again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use livekit_api::signal_client::{SignalClient, SignalEvent, SignalEvents};
use livekit_protocol as proto;
use tokio::sync::Mutex;
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use super::egress::Route;
use super::identity::user_of;
use crate::media::voice::jitter::Packet;
use super::resume::{resume_action, Resume};
use crate::media::publisher::rtc::{h264_capability, publisher_api_with};
use crate::media::voice::rtc::voice_api_with;

/// How long to wait for the server to confirm a publication.
///
/// Exceeding it means `AddTrackRequest` was refused rather than delayed - a codec or naming
/// disagreement - which is a different problem from a slow network and should not be retried as one.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(5);

/// How often [`Room::supervise`] looks at the publisher.
const SUPERVISOR_POLL: Duration = Duration::from_secs(1);

/// How long `Disconnected` is tolerated before an ICE restart is considered.
///
/// **ICE gets first refusal, and generously.** `Disconnected` is not a failure - it is consent
/// freshness lapsing, and it recovers on its own most of the time. Restarting into that window
/// tears down a connection that was about to come back, so this is set well past the point where
/// webrtc-rs would have given up and said `Failed` instead. Even after it elapses a restart only
/// happens if the route actually moved; see `Room::supervise`.
const DISCONNECT_GRACE: Duration = Duration::from_secs(15);

/// How many restarts before the supervisor stops.
///
/// A machine with no usable route would otherwise renegotiate for the life of the call, which is
/// both useless and indistinguishable from an attack on the SFU.
const MAX_ICE_RESTARTS: u32 = 5;

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
    /// Remote ICE candidates applied to the publisher, and to the subscriber.
    ///
    /// Split because routing is what can be wrong: `Trickle` carries a target and a candidate added
    /// to the wrong connection is rejected. Zero on one side with a healthy count on the other is a
    /// routing bug; zero on both is a server that never trickled.
    pub publisher_candidates: AtomicU64,
    pub subscriber_candidates: AtomicU64,
    /// Remote candidates the server sent that could not be applied.
    pub candidates_rejected: AtomicU64,
    /// ICE restarts attempted after a connection dropped. See [`Room::restart_ice`].
    pub ice_restarts: AtomicU64,
}

pub struct Room {
    signal: Arc<SignalClient>,
    publisher: Arc<RTCPeerConnection>,
    subscriber: Arc<RTCPeerConnection>,
    /// The connection we were given, kept for resume. See [`super::resume`].
    url: String,
    /// Which local addresses gathering may use, re-resolvable. See [`super::egress`].
    route: Option<Route>,
    /// Held for the whole of any offer/answer exchange this end starts.
    ///
    /// Two negotiators on the publisher interleave: both create an offer, the second overwrites the
    /// first's local description, and the first's answer then applies to an SDP that no longer
    /// matches. That was survivable while publishing was the only thing that offered; an ICE
    /// restart firing from the supervisor while a share is being published makes it reachable.
    negotiating: Mutex<()>,
    token: Mutex<String>,
    token_minted: Mutex<Instant>,
    /// Confirmed publications, keyed by the cid we asked under.
    published: Arc<Mutex<HashMap<String, Publication>>>,
    /// Local tracks, retained so something can be written to them.
    local: Arc<Mutex<HashMap<String, Arc<TrackLocalStaticSample>>>>,
    /// What the server has told us other people are publishing.
    remote: Arc<Mutex<HashMap<String, RemoteTrack>>>,
    pub stats: Arc<RoomStats>,
    /// Where inbound audio is forwarded. See [`AudioSink`].
    audio_sink: AudioSink,
    /// Set once the pump stops, for whatever reason. See [`Self::signal_is_closed`].
    signal_closed: Arc<AtomicBool>,
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

        // What the node actually offered us, which is otherwise unknowable from a log. Whether a
        // relay is on that list decides whether a client with no working direct path has any
        // fallback at all. URLs only: the credential is a short-lived secret and belongs in no log.
        for server in &config.ice_servers {
            eprintln!(
                "[livekit] ICE server from the join: {} ({})",
                server.urls.join(", "),
                if server.credential.is_empty() {
                    "no credential"
                } else {
                    "credentialed"
                }
            );
        }

        // **Gather only where the SFU is actually reachable from.** A VPN tunnel adapter otherwise
        // contributes a host candidate that can never carry media, and on the machine this was
        // measured on that was enough to stop the publisher connecting at all. See `super::egress`.
        let route = Route::to_url(url);
        match &route {
            Some(route) => eprintln!("[livekit] {}", route.describe()),
            None => eprintln!("[livekit] no host in {url}; gathering on every interface"),
        }
        let publisher_settings = route
            .as_ref()
            .map(Route::settings)
            .unwrap_or_default();
        let subscriber_settings = route
            .as_ref()
            .map(Route::settings)
            .unwrap_or_default();

        // `publisher_api`, never `voice_api`, for the publishing side. The offer's codec list comes
        // from the media engine, and only that one registers H.264 High 5.2 on payload type 118 -
        // which is what the SFU now answers with, and what makes 1440p60 conformant.
        let publisher = Arc::new(
            publisher_api_with(publisher_settings)?
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
            voice_api_with(subscriber_settings)?
                .new_peer_connection(subscriber_config)
                .await
                .map_err(|e| e.to_string())?,
        );

        // Installed before anything negotiates, so the first state change is not missed. Until
        // these existed the only observable fact about a connection was the state it happened to be
        // in when someone asked, which cannot tell "ICE never checked" from "ICE checked and
        // failed" from "ICE connected and DTLS stalled" - three different faults that all read as
        // `connecting`.
        watch_connection(&publisher, "publisher");
        watch_connection(&subscriber, "subscriber");

        let stats = Arc::new(RoomStats::default());
        let remote = Arc::new(Mutex::new(HashMap::new()));
        let published = Arc::new(Mutex::new(HashMap::new()));

        let audio_sink: AudioSink = Arc::new(std::sync::Mutex::new(None));
        install_receive_reader(&subscriber, stats.clone(), audio_sink.clone());

        let signal = Arc::new(signal);
        let signal_closed = Arc::new(AtomicBool::new(false));
        tokio::spawn(pump(
            events,
            signal.clone(),
            publisher.clone(),
            subscriber.clone(),
            published.clone(),
            remote.clone(),
            stats.clone(),
            signal_closed.clone(),
        ));

        // Whatever the join already told us about, before any event arrives.
        record_participants(&remote, &join.other_participants).await;

        Ok(Self {
            signal,
            publisher,
            subscriber,
            url: url.to_string(),
            route,
            negotiating: Mutex::new(()),
            token: Mutex::new(token.to_string()),
            token_minted: Mutex::new(Instant::now()),
            published,
            local: Arc::new(Mutex::new(HashMap::new())),
            remote,
            stats,
            audio_sink,
            signal_closed,
        })
    }

    /// Whether the signalling connection has ended, for any reason.
    ///
    /// **A room that reads true can never carry anything again**, and telling it apart from a live
    /// one is what makes a rejoin possible. Both peer connections may still report `Connected` -
    /// ICE has no idea the WebSocket went away - so every state this module otherwise exposes says
    /// the room is healthy while nothing it publishes can be announced and nothing it subscribes to
    /// will ever be offered.
    ///
    /// Read by [`super::registry::acquire`], which is the only place it can do any good: the
    /// registry hands the *same* room to the next caller for a given channel, so without this a
    /// dropped signal is inherited by every rejoin for the life of the process. Reconnect proper is
    /// still unbuilt (`resume.rs` is tested and unwired); this only ensures the next attempt starts
    /// from a fresh connection rather than from the corpse of the last one.
    pub fn signal_is_closed(&self) -> bool {
        self.signal_closed.load(Ordering::Relaxed)
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

        // **A lone layer takes the plain constructor, not a rid.** `media::publisher::rtc` has always
        // branched here and this did not, which is a real difference rather than a tidier spelling:
        // a rid on a single encoding puts `a=rid`/`a=simulcast` in the offer and a RID header
        // extension on the wire, describing a ladder that has one rung. An SFU that classifies
        // simulcast by rid then has one stream to file under three declared layers.
        //
        // Kept as a branch for the same reason that file gives: going through the same call the
        // pre-simulcast path did is what makes "drop to one layer" a true rollback rather than a
        // similar-looking one.
        let mut ladder: Vec<Arc<TrackLocalStaticSample>> = Vec::with_capacity(layers.len());
        if layers.len() == 1 {
            ladder.push(Arc::new(TrackLocalStaticSample::new(
                h264_capability(),
                name.to_string(),
                name.to_string(),
            )));
        }
        for (rid, _, _) in layers.iter().filter(|_| layers.len() > 1) {
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

    /// Stop publishing the named tracks.
    ///
    /// There is no "unpublish" message in the protocol: the server learns a track is gone from the
    /// renegotiation that follows removing its sender. So this removes every matching sender first
    /// and offers once, rather than offering per track - one offer is one round trip, and a share
    /// with audio would otherwise announce its two halves leaving separately.
    ///
    /// Unknown names are ignored rather than reported. Teardown runs on failure paths as well as on
    /// success, so it is routinely asked to remove things that were never added, and making that an
    /// error would turn every failed publish into two failures.
    pub async fn unpublish(&self, track_names: &[String]) -> Result<(), String> {
        let mut removed = false;

        // Over transceivers rather than senders, because removing a track is only half of letting
        // go of one - see the `stop` below, which is the half that decides whether this room can
        // ever publish that name again.
        for transceiver in self.publisher.get_transceivers().await {
            let sender = transceiver.sender().await;
            let Some(track) = sender.track().await else {
                continue;
            };
            if !track_names.iter().any(|name| name == track.id()) {
                continue;
            }
            if let Err(e) = self.publisher.remove_track(&sender).await {
                eprintln!("[livekit] could not remove {}: {e}", track.id());
                continue;
            }

            // **Stopping the transceiver is what makes a rejoin possible**, and leaving it out was a
            // permanent lockout rather than a failed attempt.
            //
            // `remove_track` stops the *sender* and clears its encodings, but leaves the transceiver
            // un-stopped and its `initial_track_id` still set. `RTCPeerConnection::add_track` then
            // matches a later publish against it - the loop takes any transceiver that is
            // `!stopped`, of the right kind, whose sender's `initial_track_id` equals the new
            // track's id and whose track is now `None` - and calls `replace_track` on a sender that
            // has already been stopped. That can only fail:
            //
            //     Err(ErrRTPSenderNewTrackHasIncorrectEnvelope)
            //     "new track must have the same envelope as previous"
            //
            // Every microphone is named `audio`, so the ids always match and the second publish
            // always lands on the first one's corpse. It reached the user as "LiveKit refused the
            // microphone track", which names neither the cause nor anything they could do, and it
            // never recovered: the registry keys a room by `guild:{guild}:{channel}` and hands the
            // live one to the next caller regardless of its token, so every rejoin found the same
            // dead transceiver waiting. Anything outliving the microphone reaches it - a screen
            // share still holding the room, or a reconnect after a membership ended badly.
            //
            // Stopped, it is skipped by that loop and the publish builds a fresh transceiver.
            if let Err(e) = transceiver.stop().await {
                eprintln!("[livekit] could not stop the transceiver for {}: {e}", track.id());
            }
            removed = true;
        }

        {
            let mut local = self.local.lock().await;
            local.retain(|key, _| {
                // Ladder entries are keyed `{name}#{index}`; the microphone is keyed by its name.
                let base = key.split('#').next().unwrap_or(key);
                !track_names.iter().any(|name| name == base)
            });
        }
        self.published
            .lock()
            .await
            .retain(|_, publication| !track_names.contains(&publication.track_name));

        // Only when something actually left. An offer that changes nothing still costs a round trip
        // and, on a busy connection, a renegotiation other work has to wait behind.
        if removed {
            self.negotiate().await?;
        }
        Ok(())
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

    /// Send inbound audio here, keyed by the SID it was subscribed under.
    ///
    /// One sink per room, not per subscription, because `webrtc-rs` allows one `on_track` handler
    /// per connection and the room owns it. A second caller replaces the first rather than being
    /// added alongside - there is exactly one mixer in this process, and two sinks would mean two
    /// halves of the room's audio arriving in different places.
    pub fn on_audio(&self, sink: tokio::sync::mpsc::Sender<(String, Packet)>) {
        if let Ok(mut guard) = self.audio_sink.lock() {
            *guard = Some(sink);
        }
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

    /// The publishing peer connection itself.
    ///
    /// Handed out for one reason: RTCP. A viewer asks for a keyframe with PLI or FIR, and the only
    /// place that arrives is the sender on this connection - the screen publisher reads it to drive
    /// `keyframe_wanted`, and without it a viewer who joins mid-share waits for the next periodic
    /// IDR before seeing anything.
    ///
    /// Not for negotiating on. Every offer this connection makes is made by [`Self::negotiate`],
    /// and a second negotiator would interleave with it - both create an offer, the second
    /// overwrites the first's local description, and the first's answer then applies to an SDP that
    /// no longer matches.
    pub fn publisher_connection(&self) -> Arc<RTCPeerConnection> {
        self.publisher.clone()
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
        eprintln!("[livekit] {}", self.full_diagnosis().await);
        Err(format!(
            "publisher stuck at {} after {timeout:?}",
            self.publisher.connection_state()
        ))
    }

    /// Everything that distinguishes the ways a connection fails to come up, in one line.
    ///
    /// Printed at the moment of failure rather than left to be reconstructed. The four states this
    /// separates all present as "the publisher never connected":
    ///
    /// * no remote description - the `Answer` never arrived or never applied, so ICE never started
    /// * a remote description and no remote candidates - the server never trickled, or trickled to
    ///   the connection we did not route them to
    /// * candidates on both sides and ICE still `checking` - no pair works, which is the tunnel
    ///   adapter case `super::egress` exists for
    /// * ICE `connected` with the connection still `connecting` - DTLS stalled, which is a
    ///   different fault entirely and shares none of the same fixes
    pub async fn diagnosis(&self) -> String {
        format!(
            "publisher {} / ICE {} / remote description {} / {} remote candidate(s); \
             subscriber {} / ICE {} / {} remote candidate(s); {} rejected, {} ICE restart(s); \
             route: {}",
            self.publisher.connection_state(),
            self.publisher.ice_connection_state(),
            if self.publisher.remote_description().await.is_some() {
                "applied"
            } else {
                "MISSING"
            },
            self.stats.publisher_candidates.load(Ordering::Relaxed),
            self.subscriber.connection_state(),
            self.subscriber.ice_connection_state(),
            self.stats.subscriber_candidates.load(Ordering::Relaxed),
            self.stats.candidates_rejected.load(Ordering::Relaxed),
            self.stats.ice_restarts.load(Ordering::Relaxed),
            match &self.route {
                Some(route) => route.describe(),
                None => "unfiltered".to_string(),
            }
        )
    }

    /// [`Self::diagnosis`], plus every candidate pair on both connections.
    ///
    /// Separate because it is several lines and costs a `get_stats` on each connection, so it is
    /// printed where the answer is worth that - a connection that failed to come up - rather than
    /// on every state change.
    pub async fn full_diagnosis(&self) -> String {
        format!(
            "{}\n[livekit] {}\n[livekit] {}",
            self.diagnosis().await,
            pair_report(&self.publisher, "publisher").await,
            pair_report(&self.subscriber, "subscriber").await,
        )
    }

    pub async fn local_sdp(&self) -> Option<String> {
        self.publisher.local_description().await.map(|d| d.sdp)
    }

    pub async fn remote_sdp(&self) -> Option<String> {
        self.publisher.remote_description().await.map(|d| d.sdp)
    }

    /// Close only the signalling connection, leaving the peer connections up.
    ///
    /// Exists for the registry's eviction test, which needs the exact state a dropped connection
    /// leaves behind: a dead signal under two peer connections that still read `Connected`. Nothing
    /// in production calls it - a real drop arrives from the far end - and it is the only way to
    /// produce that state without unplugging something.
    pub async fn close_signal(&self) {
        self.signal.close().await;
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
        self.offer(None).await
    }

    /// Create an offer on the publisher and send it, with its candidates already in the SDP.
    ///
    /// Serialised on `negotiating`: see the field's own note on why a second concurrent negotiator
    /// corrupts the first's exchange rather than merely delaying it.
    async fn offer(
        &self,
        options: Option<webrtc::peer_connection::offer_answer_options::RTCOfferOptions>,
    ) -> Result<(), String> {
        let _turn = self.negotiating.lock().await;

        let offer = self
            .publisher
            .create_offer(options)
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
                    sdp: dedupe_simulcast(&local.sdp),
                    ..Default::default()
                },
            ))
            .await;
        Ok(())
    }

    /// Re-resolve the route and renegotiate the publisher onto it.
    ///
    /// **The route is re-asked first, and that ordering is the point.** An ICE restart that gathers
    /// on the same dead adapter is a slower way of failing the same way; asking the routing table
    /// again is what lets a call survive a tunnel coming up or going down, or Wi-Fi handing over to
    /// Ethernet. The filter installed at connect reads the shared set on every candidate, so the
    /// fresh answer takes effect on this gathering pass without rebuilding the connection - see
    /// [`super::egress`].
    ///
    /// Only the publisher restarts here. The subscriber is offered to by the server, so its restart
    /// is the server's to initiate; ours is to keep answering, which the pump already does.
    pub async fn restart_ice(&self) -> Result<(), String> {
        if let Some(route) = &self.route {
            route.refresh();
            eprintln!("[livekit] restarting ICE - {}", route.describe());
        } else {
            eprintln!("[livekit] restarting ICE on every interface");
        }
        self.stats.ice_restarts.fetch_add(1, Ordering::Relaxed);
        self.offer(Some(
            webrtc::peer_connection::offer_answer_options::RTCOfferOptions {
                ice_restart: true,
                voice_activity_detection: false,
            },
        ))
        .await
    }

    /// Watch the publisher, and renegotiate onto a working route if the one in use dies.
    ///
    /// Spawned rather than awaited, and holds a `Weak` so it ends when the room does rather than
    /// keeping a dropped room alive to be supervised.
    ///
    /// `Disconnected` is given a grace period and `Failed` is not, because they mean different
    /// things: ICE recovers from `Disconnected` on its own more often than not, and restarting
    /// during that window throws away a connection that was about to come back. `Failed` is
    /// terminal for that candidate set and waiting only adds silence to it.
    ///
    /// Attempts are bounded. A machine with no route at all would otherwise renegotiate for the
    /// life of the call, and a restart loop against an SFU is indistinguishable from an attack.
    pub fn supervise(self: &Arc<Self>) {
        let room = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut disconnected_since: Option<tokio::time::Instant> = None;
            let mut attempts = 0u32;

            loop {
                tokio::time::sleep(SUPERVISOR_POLL).await;
                let Some(room) = room.upgrade() else { return };

                // A dead signal cannot carry an offer, so a restart would be shouting into a closed
                // socket. Rejoining is the session layer's call - see `signal_is_closed`.
                if room.signal_is_closed() {
                    return;
                }

                // **Terminal states only, and `Connecting` is not one of them.**
                //
                // An earlier version restarted on `Connecting` too, on the theory that a connection
                // which never came up presents that way. It does - but so does every renegotiation
                // and every transient blip on a *working* call, and an ICE restart mints new
                // credentials on a live connection. That version dropped audio at random on a
                // healthy call and again whenever a screen share renegotiated, which is a far worse
                // failure than the one it was built to repair. A connection that never came up is
                // already handled: `wait_until_connected` fails the join and nothing is supervised.
                let state = room.publisher.connection_state();
                let due = match state {
                    RTCPeerConnectionState::Connected | RTCPeerConnectionState::New => {
                        disconnected_since = None;
                        attempts = 0;
                        continue;
                    }
                    RTCPeerConnectionState::Closed => return,
                    RTCPeerConnectionState::Failed => true,
                    RTCPeerConnectionState::Disconnected => {
                        let since = disconnected_since.get_or_insert_with(tokio::time::Instant::now);
                        since.elapsed() >= DISCONNECT_GRACE
                    }
                    _ => false,
                };

                if !due {
                    continue;
                }

                // **A restart is only a fix when there is somewhere new to go.**
                //
                // This exists to move a call onto a different local address after the one it was
                // using stopped working - a tunnel coming up, an adapter dying, Wi-Fi handing over
                // to Ethernet. If the routing table still answers with the same address, an ICE
                // restart gathers the identical candidates and the only thing it changes is that a
                // working connection is torn down and rebuilt. `Failed` is the exception: ICE has
                // given up there, so a restart is the only move left whatever the route says.
                let route_moved = room.route.as_ref().is_some_and(Route::refresh);
                if state != RTCPeerConnectionState::Failed && !route_moved {
                    continue;
                }
                if attempts >= MAX_ICE_RESTARTS {
                    eprintln!(
                        "[livekit] giving up after {attempts} ICE restart(s); {}",
                        room.diagnosis().await
                    );
                    return;
                }

                attempts += 1;
                disconnected_since = None;
                eprintln!("[livekit] publisher is {}; {}", room.publisher.connection_state(), room.diagnosis().await);
                if let Err(e) = room.restart_ice().await {
                    eprintln!("[livekit] ICE restart {attempts} failed: {e}");
                }
            }
        });
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

/// Where inbound audio goes, keyed by the routing key its subscriber registered.
///
/// Behind a mutex and an `Option` because the handler is installed before the consumer exists: the
/// room is built, then the voice publication attaches its jitter buffers to it. Exactly the shape
/// `media::voice::rtc::PacketSink` already uses, for the same reason.
pub type AudioSink = Arc<std::sync::Mutex<Option<tokio::sync::mpsc::Sender<(String, Packet)>>>>;

/// Read every subscribed track, count it, and forward audio to whoever is listening.
///
/// **There is one of these per connection, not per track.** `webrtc-rs` allows a single `on_track`
/// handler, so this is the only place inbound RTP can be reached - which is why the room owns
/// forwarding rather than letting each subscriber install its own reader.
///
/// The reader is **spawned** and the handler returns immediately, matching `media::voice::rtc`:
/// `webrtc-rs` serialises `on_track`, so reading inline blocks every later track from ever opening.
fn install_receive_reader(
    subscriber: &Arc<RTCPeerConnection>,
    stats: Arc<RoomStats>,
    audio: AudioSink,
) {
    subscriber.on_track(Box::new(move |track, _receiver, _transceiver| {
        let stats = stats.clone();
        let audio = audio.clone();
        Box::pin(async move {
            stats.tracks_opened.fetch_add(1, Ordering::Relaxed);

            // The routing key. LiveKit names the media stream after the track it issued, so this is
            // the same SID `subscribe` was called with - which is what lets a subscriber register a
            // destination before the track exists. Asserted live in `room_tests`, because the whole
            // inbound path silently routes nowhere if it ever stops being true.
            let key = track.id();
            let is_audio = track.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio;

            tokio::spawn(async move {
                while let Ok((rtp, _)) = track.read_rtp().await {
                    stats.rtp_received.fetch_add(1, Ordering::Relaxed);

                    // Video is read to keep the transport draining and counted, but never
                    // forwarded: on desktop the webview receives video and this connection carries
                    // audio for the mixer. Forwarding it would hand the jitter buffer packets it
                    // cannot decode.
                    if !is_audio {
                        continue;
                    }

                    let sink = audio.lock().ok().and_then(|guard| guard.clone());
                    let Some(sink) = sink else { continue };

                    // `try_send`, not `send`: the consumer is the playout thread and this network
                    // task must never wait on it. A full queue means playout has stalled, and
                    // dropping is what keeps latency bounded rather than unbounded.
                    let _ = sink.try_send((
                        key.clone(),
                        Packet {
                            seq: rtp.header.sequence_number,
                            payload: rtp.payload.to_vec(),
                        },
                    ));
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
    signal_closed: Arc<AtomicBool>,
) {
    // Set however this returns - a `break` below, or the event stream simply ending. Every exit
    // means the same thing to a caller: nothing more will be signalled on this room, so it must not
    // be handed to anyone else. See `Room::signal_is_closed`.
    let _guard = SignalClosedOnDrop(signal_closed);

    // One buffer per connection. See the module docs: the server trickles before we have a
    // description to attach the candidates to.
    let held_publisher: Pending = Arc::new(Mutex::new(Vec::new()));
    let held_subscriber: Pending = Arc::new(Mutex::new(Vec::new()));

    let publisher_side = Side {
        label: "publisher",
        applied: &stats.publisher_candidates,
        rejected: &stats.candidates_rejected,
    };
    let subscriber_side = Side {
        label: "subscriber",
        applied: &stats.subscriber_candidates,
        rejected: &stats.candidates_rejected,
    };

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
                report_ice_role(&answer.sdp, "publisher", true);
                match RTCSessionDescription::answer(answer.sdp) {
                    Ok(description) => {
                        if let Err(e) = publisher.set_remote_description(description).await {
                            eprintln!("[livekit] publisher answer rejected: {e}");
                        } else {
                            // Logged on success as well as failure. This is the only thing that
                            // gives the publisher a remote description, and without it the
                            // connection sits at `connecting` for ever - so its *absence* is a
                            // diagnosis, and an absent log line reads the same as an absent path.
                            eprintln!("[livekit] publisher answer applied");
                            flush_held(&publisher, &held_publisher, &publisher_side).await;
                        }
                    }
                    Err(e) => eprintln!("[livekit] unparseable answer: {e}"),
                }
            }
            // Theirs, answered by us. The subscriber connection only ever answers.
            proto::signal_response::Message::Offer(offer) => {
                // Logged because its *absence* is a diagnosis. A subscriber that never receives an
                // offer has nothing to answer and no track will ever open, which from every counter
                // above looks identical to a track that opened and carried nothing.
                let media = offer.sdp.matches("m=").count();
                eprintln!("[livekit] subscriber offer with {media} m-line(s)");
                // We answer this one, so `a=ice-lite` is the only thing that can make us
                // controlling - and without a controlling end nothing is ever nominated.
                report_ice_role(&offer.sdp, "subscriber", false);
                match answer_subscriber(&signal, &subscriber, offer.sdp).await {
                    Ok(()) => {
                        eprintln!("[livekit] answered the subscriber offer");
                        flush_held(&subscriber, &held_subscriber, &subscriber_side).await;
                    }
                    Err(e) => eprintln!("[livekit] could not answer the subscriber offer: {e}"),
                }
            }
            // The server's own candidates. Without this the SDP exchange completes and ICE never
            // does - see the module docs.
            proto::signal_response::Message::Trickle(trickle) => {
                match serde_json::from_str::<RTCIceCandidateInit>(&trickle.candidate_init) {
                    Ok(init) => {
                        // `SignalTarget::Publisher` is 0 and `Subscriber` is 1. Routed rather than
                        // broadcast: a candidate added to the wrong connection is rejected, and two
                        // rejections per candidate would bury the real ones in the log.
                        if trickle.target == proto::SignalTarget::Subscriber as i32 {
                            add_or_hold(&subscriber, &held_subscriber, init, &subscriber_side).await;
                        } else {
                            add_or_hold(&publisher, &held_publisher, init, &publisher_side).await;
                        }
                    }
                    Err(e) => eprintln!("[livekit] unparseable trickle candidate: {e}"),
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

/// Marks a room's signal closed however the pump ends.
///
/// A guard rather than a store at each `break`, because the pump has four exits - two breaks, a
/// `Leave`, and the event stream ending on its own - and the one that gets forgotten is the one that
/// strands a room in the registry forever.
struct SignalClosedOnDrop(Arc<AtomicBool>);

impl Drop for SignalClosedOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Report the one SDP attribute that decides which end nominates.
///
/// **`a=ice-lite` is not decoration; it picks the ICE role.** `webrtc-rs` reads it in
/// `RTCPeerConnection::set_remote_description` and takes `Controlling` only when we offered, or
/// when the remote is lite and we are not. On the subscriber connection we always answer, so
/// without this attribute we take `Controlled` and wait for a nomination.
///
/// An ice-lite agent never nominates - it only answers checks. So if the far end is lite and does
/// not say so, both ends wait, every candidate pair reaches `Succeeded`, nothing is ever selected,
/// and the connection sits at `checking` until the server gives up. That is indistinguishable from
/// a network fault from every counter above the transport, which is why it is logged rather than
/// inferred.
fn report_ice_role(sdp: &str, label: &str, we_offered: bool) {
    let remote_is_lite = sdp.lines().any(|line| line.trim() == "a=ice-lite");
    // Mirrors the rule in `webrtc::peer_connection`, which is the code that actually decides. We
    // are never lite ourselves - nothing calls `SettingEngine::set_lite`.
    let controlling = we_offered || remote_is_lite;
    eprintln!(
        "[livekit] {label}: remote is {}, so we are the {} agent{}",
        if remote_is_lite { "ice-lite" } else { "a full ICE agent" },
        if controlling { "CONTROLLING" } else { "CONTROLLED" },
        if controlling {
            " (we nominate)"
        } else {
            " (we wait to be nominated)"
        }
    );
}

/// Log every transport state change and every candidate one connection gathers.
///
/// **This is the only window into why a connection did not come up.** Signalling succeeding and
/// media flowing are independent, and before these handlers existed only the first was observable:
/// a connection that negotiated cleanly and then never carried a packet presented as a working call
/// with an empty log. `media::voice::rtc` has had exactly this on the Cloudflare path since the
/// bug that established it; the LiveKit path shipped without it and cost three rounds of inference
/// to diagnose a VPN tunnel adapter.
///
/// The gathered candidates matter as much as the states. One line per local candidate names the
/// interface it came from, which is what turns "the publisher never connected" into "the publisher
/// offered nothing but a tunnel address" - see [`super::egress`].
fn watch_connection(pc: &Arc<RTCPeerConnection>, label: &'static str) {
    pc.on_peer_connection_state_change(Box::new(move |state| {
        eprintln!("[livekit] {label} connection state: {state}");
        Box::pin(async {})
    }));

    pc.on_ice_connection_state_change(Box::new(move |state| {
        eprintln!("[livekit] {label} ICE state: {state}");
        Box::pin(async {})
    }));

    // Bounded: candidates are gathered once per negotiation, not periodically. `None` is the
    // end-of-gathering marker and is logged because "gathered nothing at all" is otherwise
    // indistinguishable from "gathering never finished".
    pc.on_ice_candidate(Box::new(move |candidate| {
        match candidate {
            Some(candidate) => eprintln!(
                "[livekit] {label} local candidate: {} {} {}:{}",
                candidate.typ, candidate.protocol, candidate.address, candidate.port
            ),
            None => eprintln!("[livekit] {label} gathering complete"),
        }
        Box::pin(async {})
    }));
}

/// Candidates the server sent before we had a description to attach them to.
type Pending = Arc<Mutex<Vec<RTCIceCandidateInit>>>;

/// One of the two connections, so the candidate helpers can count and name what they touch.
struct Side<'a> {
    label: &'a str,
    applied: &'a AtomicU64,
    rejected: &'a AtomicU64,
}

/// Every candidate pair on a connection, resolved to the path it describes.
///
/// **This is what a state of `checking` or a drop out of `connected` refuses to explain on its
/// own.** `Succeeded` pairs with nothing `NOMINATED` is the signature that matters: connectivity
/// worked and no agent ever selected a pair, which is a role or nomination fault rather than a
/// network one.
///
/// **The request/response/consent counters are deliberately not printed.** `webrtc-ice` 0.14
/// initialises `requests_sent`, `responses_received` and `consent_requests_sent` to zero in
/// `agent_stats.rs` and never increments them anywhere in the crate, so reporting them shows
/// `0/0` on a pair that demonstrably completed a check. That reads as "nothing was ever sent",
/// which is the opposite of the truth and cost a round of diagnosis here.
async fn pair_report(pc: &Arc<RTCPeerConnection>, label: &str) -> String {
    let report = pc.get_stats().await;

    // Pairs name their candidates by id, and the ids alone say nothing. Resolve both sides first.
    let mut addresses: HashMap<String, String> = HashMap::new();
    for (id, stat) in &report.reports {
        if let webrtc::stats::StatsReportType::LocalCandidate(c)
        | webrtc::stats::StatsReportType::RemoteCandidate(c) = stat
        {
            addresses.insert(id.clone(), format!("{:?} {}:{}", c.candidate_type, c.ip, c.port));
        }
    }

    let mut lines: Vec<String> = Vec::new();
    for stat in report.reports.values() {
        let webrtc::stats::StatsReportType::CandidatePair(pair) = stat else {
            continue;
        };
        let unknown = "?".to_string();
        lines.push(format!(
            "{label} pair {} -> {}: {:?}{}",
            addresses.get(&pair.local_candidate_id).unwrap_or(&unknown),
            addresses.get(&pair.remote_candidate_id).unwrap_or(&unknown),
            pair.state,
            if pair.nominated { " NOMINATED" } else { "" },
        ));
    }

    if lines.is_empty() {
        return format!("{label}: no candidate pairs at all");
    }
    lines.join("; ")
}

/// Add a remote candidate, or hold it until there is a description to add it against.
///
/// `add_ice_candidate` fails on a connection with no remote description, and these routinely arrive
/// first - the server starts trickling as soon as it has an answer to send, not after we have
/// applied one.
async fn add_or_hold(
    pc: &Arc<RTCPeerConnection>,
    pending: &Pending,
    init: RTCIceCandidateInit,
    side: &Side<'_>,
) {
    if pc.remote_description().await.is_none() {
        pending.lock().await.push(init);
        return;
    }
    // The candidate line itself, not just a count. What the SFU offers to be reached on is the
    // other half of every pair, and a count cannot say whether it offered a relay, a public
    // address, or something unroutable from here.
    eprintln!("[livekit] {} remote candidate: {}", side.label, init.candidate);
    match pc.add_ice_candidate(init).await {
        Ok(()) => {
            side.applied.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => {
            side.rejected.fetch_add(1, Ordering::Relaxed);
            eprintln!("[livekit] {} rejected a remote candidate: {e}", side.label);
        }
    }
}

/// Apply everything held for this connection. Called the moment its remote description lands.
async fn flush_held(pc: &Arc<RTCPeerConnection>, pending: &Pending, side: &Side<'_>) {
    let held: Vec<RTCIceCandidateInit> = pending.lock().await.drain(..).collect();
    if held.is_empty() {
        return;
    }
    eprintln!(
        "[livekit] {} applying {} held candidate(s)",
        side.label,
        held.len()
    );
    for init in held {
        eprintln!("[livekit] {} remote candidate: {}", side.label, init.candidate);
        match pc.add_ice_candidate(init).await {
            Ok(()) => {
                side.applied.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                side.rejected.fetch_add(1, Ordering::Relaxed);
                eprintln!("[livekit] {} rejected a held candidate: {e}", side.label);
            }
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

/// Strip the duplicate rid and simulcast attributes `webrtc-rs` writes on a *re-offer*.
///
/// # The bug this exists for
///
/// `webrtc-rs` 0.14 builds the attributes of an existing video m-line from two sources at once: the
/// rid map it parsed out of the previous answer, and the sender's own encodings. On the first offer
/// there is no previous answer, so each appears once. On every offer after that they appear twice -
/// `a=rid:f send` three times over becomes six, and `a=simulcast:send f;h;q` becomes two lines.
///
/// LiveKit answers that with `a=simulcast:recv f;h;q;f;h;q`, and then **the video track is gone from
/// the participant**: accepted, given a track SID, and in nobody's roster. So a viewer is never told
/// the share exists. It reproduces the moment anything renegotiates over a live ladder - a second
/// share after the first is stopped, or the microphone arriving late - which is exactly the shape of
/// "the first share worked and the next one was black".
///
/// # Why here rather than in the publisher
///
/// `Room` owns every offer this connection makes, so it is the only place that sees all of them.
/// `media::publisher::rtc` can order its own two publishes so the ladder lands in the last
/// negotiation, and does, but it cannot do anything about the *next* negotiation, which belongs to
/// somebody else entirely.
///
/// Per m-section, because two video m-lines legitimately carry the same rid names.
fn dedupe_simulcast(sdp: &str) -> String {
    let mut out = String::with_capacity(sdp.len());
    let mut seen_rids: Vec<String> = Vec::new();
    let mut seen_simulcast = false;

    for line in sdp.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);

        // A new media section starts a new namespace: the same rid names on the next m-line are a
        // different sender's, not a repeat of this one's.
        if trimmed.starts_with("m=") {
            seen_rids.clear();
            seen_simulcast = false;
        } else if let Some(rest) = trimmed.strip_prefix("a=rid:") {
            // `a=rid:f send` - the id is up to the first space.
            let id = rest.split_whitespace().next().unwrap_or(rest).to_string();
            if seen_rids.contains(&id) {
                continue;
            }
            seen_rids.push(id);
        } else if trimmed.starts_with("a=simulcast:") {
            if seen_simulcast {
                continue;
            }
            seen_simulcast = true;
        }

        out.push_str(line);
    }
    out
}

#[cfg(test)]
mod sdp_tests {
    use super::dedupe_simulcast;

    /// The exact shape a re-offer produces: every rid twice, the simulcast line twice.
    const RE_OFFER: &str = "v=0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 125\r\n\
a=mid:3\r\n\
a=rid:f send\r\n\
a=rid:h send\r\n\
a=rid:q send\r\n\
a=simulcast:send f;h;q\r\n\
a=rid:f send\r\n\
a=rid:h send\r\n\
a=rid:q send\r\n\
a=simulcast:send f;h;q\r\n";

    #[test]
    fn a_re_offer_keeps_one_of_each_rid_and_one_simulcast_line() {
        let cleaned = dedupe_simulcast(RE_OFFER);

        assert_eq!(cleaned.matches("a=rid:").count(), 3, "\n{cleaned}");
        assert_eq!(cleaned.matches("a=simulcast:").count(), 1, "\n{cleaned}");
        // Order is the ladder, highest first, and the SFU reads it as a ranking.
        let rids: Vec<&str> = cleaned
            .lines()
            .filter_map(|l| l.strip_prefix("a=rid:"))
            .filter_map(|l| l.split_whitespace().next())
            .collect();
        assert_eq!(rids, ["f", "h", "q"]);
    }

    #[test]
    fn a_first_offer_is_returned_untouched() {
        // The common case, and the one that must not be disturbed: nothing is duplicated yet.
        let first = "v=0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 125\r\n\
a=rid:f send\r\n\
a=rid:h send\r\n\
a=rid:q send\r\n\
a=simulcast:send f;h;q\r\n";

        assert_eq!(dedupe_simulcast(first), first);
    }

    #[test]
    fn two_video_sections_each_keep_their_own_rids() {
        // Rid names are scoped to their m-line. Deduping across sections would strip the second
        // sender's ladder entirely and leave that share with one layer.
        let two = "v=0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 125\r\n\
a=rid:f send\r\n\
a=simulcast:send f\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 125\r\n\
a=rid:f send\r\n\
a=simulcast:send f\r\n";

        assert_eq!(dedupe_simulcast(two), two);
    }

    #[test]
    fn an_sdp_with_no_simulcast_at_all_is_unchanged() {
        let plain = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n";
        assert_eq!(dedupe_simulcast(plain), plain);
    }
}
