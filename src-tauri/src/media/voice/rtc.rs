//! A `webrtc-rs` peer connection publishing one Opus microphone track to Cloudflare Realtime.
//!
//! The transport half of the Rust voice pipeline. Packets arrive already encoded from
//! [`super::chain`]; this module owns the peer connection and the signalling handshake and knows
//! nothing about audio.
//!
//! Shaped after `publisher::rtc`, which does the same job for screen video. The difference that
//! matters is the session role: voice is the *primary* session, because the backend records the
//! primary session as the participant's audio.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::{RTCRtpTransceiver, RTCRtpTransceiverInit};

use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::{
    LocalTrack, RemoteTrack, SessionDescription, Signalling,
};
use super::jitter::Packet;

/// The name every other client resolves a participant's microphone by.
///
/// It matches what the webview published before this pipeline existed, so a client on the previous
/// build can still find the track.
pub const TRACK_NAME: &str = "audio";

/// One packet every 20 ms - the packetisation the encoder is configured for.
const PACKET_DURATION: Duration = Duration::from_millis(20);

/// How long to wait for ICE gathering before offering with what we have.
///
/// Generous, because exceeding it degrades connectivity, and stingy compared to "forever", which is
/// what it was. Host candidates are immediate and server-reflexive ones arrive in well under a
/// second on a working network.
const GATHER_TIMEOUT: Duration = Duration::from_secs(5);

/// How the microphone track is described in SDP.
pub fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48_000,
        channels: 1,
        // `useinbandfec=1` is what makes the receiver ask for forward error correction, which the
        // encoder already produces - omitting it would quietly waste redundancy we pay for.
        // `minptime=10` states the shortest packet we will send.
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
        ..Default::default()
    }
}

/// The API every voice peer connection is built from.
///
/// Public, and used by `super::e2e_tests` rather than copied there. Which codecs and interceptors
/// are registered is precisely what decides whether an inbound stream can be matched to a
/// transceiver at all, so a test that builds its own media engine tests its own media engine - and
/// a copy that drifts from this one passes while the client cannot hear anybody.
pub fn voice_api() -> Result<webrtc::api::API, String> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|e| e.to_string())?;

    let mut registry = Registry::new();
    registry =
        register_default_interceptors(registry, &mut media_engine).map_err(|e| e.to_string())?;

    Ok(APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build())
}

/// Where RTP from subscribed tracks goes, keyed by the mid Cloudflare assigned.
///
/// Set once by the session after construction. Behind a mutex only because the handler is installed
/// before the consumer exists - see the note in `start`.
pub type PacketSink = Arc<std::sync::Mutex<Option<tokio::sync::mpsc::Sender<(String, Packet)>>>>;

/// Counters for one publication, for `voice_stats`.
///
/// Every one of these exists because the corresponding failure was previously silent. A voice call
/// that is signalled correctly but transports nothing looked exactly like a working call from the
/// frontend's side: `subscribe` returns `Ok`, the UI reports "connected", and no log says otherwise.
/// These are what tell "the SFU never sent us anything" apart from "it sent packets we could not
/// route" apart from "we routed them and the mixer dropped them".
#[derive(Default)]
pub struct PublicationStats {
    /// Encoded microphone packets handed to this publication's writer task.
    pub packets_sent: AtomicU64,
    /// Packets dropped because the writer's queue was full - playout or network is behind.
    pub packets_dropped: AtomicU64,
    /// `write_packet` failures. Non-zero means the track stopped accepting samples.
    pub write_errors: AtomicU64,
    /// `on_track` firings - one per subscribed remote track that actually opened.
    pub tracks_opened: AtomicU64,
    /// RTP packets read off subscribed tracks. Zero while subscribes succeed means the
    /// handshake completed but no media is arriving.
    pub rtp_received: AtomicU64,
    /// Packets whose mid matched a subscribed source and reached its jitter buffer.
    pub rtp_routed: AtomicU64,
    /// Packets discarded because their mid was in no source map. The inbound task drops these
    /// with a bare `continue`, so without this counter a mid-mapping bug is invisible.
    pub rtp_unmapped: AtomicU64,
    /// Latest peer-connection and ICE states, as webrtc-rs reports them.
    pub peer_state: std::sync::Mutex<String>,
    pub ice_state: std::sync::Mutex<String>,
    /// The `a=candidate:` lines this side offered.
    ///
    /// The one thing that distinguishes the two ways ICE fails here. This connection is configured
    /// with no STUN or TURN servers on the argument that Cloudflare's SFU is publicly routable and
    /// will answer to whatever source address it sees - which holds only if our checks reach it at
    /// all. Host-only candidates and a failed connection means that argument did not hold on this
    /// network; candidates present and still failing means something is dropping the traffic.
    pub local_candidates: std::sync::Mutex<Vec<String>>,
}

impl PublicationStats {
    fn set_peer_state(&self, state: &RTCPeerConnectionState) {
        if let Ok(mut guard) = self.peer_state.lock() {
            *guard = state.to_string();
        }
    }

    fn set_ice_state(&self, state: &RTCIceConnectionState) {
        if let Ok(mut guard) = self.ice_state.lock() {
            *guard = state.to_string();
        }
    }
}

pub struct VoicePublication {
    peer_connection: Arc<RTCPeerConnection>,
    track: Arc<TrackLocalStaticSample>,
    signalling: Signalling,
    packet_sink: PacketSink,
    stats: Arc<PublicationStats>,
    /// Serialises offer/answer cycles on this connection.
    ///
    /// The webview subscribes concurrently on purpose - `subscribeAudio` fans its targets out with
    /// `Promise.all` so one participant losing the publish race cannot hold up everyone announced
    /// alongside them - and each of those lands here as its own `voice_subscribe`. JSEP allows
    /// exactly one negotiation in flight per connection, so without this two of them interleave:
    /// both create an offer, the second overwrites the first's local description, and the first's
    /// answer then applies to an SDP that no longer matches. `webrtc-rs` rejects it, both
    /// subscribes fail, and the participants stay silent for the session.
    ///
    /// The webview's own connection has always had this, as `enqueueNegotiation` in
    /// `voice-rtc.service.ts`. This connection did not, which is what made joining a busy channel -
    /// where the backend backfills the whole room at once - the case that broke.
    negotiation: tokio::sync::Mutex<()>,
    pub cf_session_id: String,
    pub track_name: String,
}

/// Build the pull request for a set of `(cf_session_id, track_name)` pairs.
///
/// Split out from `subscribe` so the request shape is testable without a peer connection or a
/// network. The shape is the part that is easy to get wrong; the plumbing around it is not.
fn subscription_tracks(sources: &[(String, String)]) -> Vec<RemoteTrack> {
    sources
        .iter()
        .map(|(session_id, track_name)| RemoteTrack {
            location: "remote",
            track_name: track_name.clone(),
            session_id: session_id.clone(),
        })
        .collect()
}

/// Read every remote track this connection opens, and forward its RTP to `sink`, keyed by mid.
///
/// Split out of [`VoicePublication::start`] so `super::e2e_tests` drives the *real* handler rather
/// than a copy of its shape - a copy is exactly what would have kept passing while this broke.
///
/// The reader is **spawned**, and the handler returns immediately. `webrtc-rs` keeps one `on_track`
/// closure behind a mutex and holds that mutex for as long as the future the closure returns is
/// alive (`RTCPeerConnection::do_track`). A reader lives as long as its track, so awaiting it inside
/// the handler means the first remote track to open holds the mutex for the rest of the call and
/// every track opening after it blocks on `handler.lock()` forever: `on_track` never fires for them,
/// not one packet is read, and `tracks_opened` stops at one.
///
/// That is the whole of "this client cannot hear anyone". The second participant is silent, and so
/// is the *first* whenever their subscription is replaced - a corrected session id, a rejoin -
/// because the superseded track's reader is still sitting on the mutex. Nothing above it reports a
/// fault: the subscribe returns `Ok`, the connection stays healthy, the audio simply never arrives.
pub fn route_inbound_audio(
    peer_connection: &RTCPeerConnection,
    packet_sink: &PacketSink,
    stats: &Arc<PublicationStats>,
) {
    let handler_sink = Arc::clone(packet_sink);
    let track_stats = Arc::clone(stats);
    peer_connection.on_track(Box::new(move |track, _receiver, transceiver| {
        let sink = Arc::clone(&handler_sink);
        let stats = Arc::clone(&track_stats);

        tokio::spawn(async move {
            let Some(mid) = transceiver.mid().map(|m| m.to_string()) else {
                eprintln!("[voice] a remote track opened with no mid - its audio cannot be routed");
                return;
            };
            stats.tracks_opened.fetch_add(1, Ordering::Relaxed);
            eprintln!("[voice] remote track opened on mid {mid}");
            loop {
                match track.read_rtp().await {
                    Ok((rtp, _)) => {
                        stats.rtp_received.fetch_add(1, Ordering::Relaxed);
                        // Cloned out of the lock rather than held across the send: the sink is
                        // written once at startup, and holding a std mutex across an await is how a
                        // deadlock gets written by accident.
                        let sender = match sink.lock() {
                            Ok(guard) => guard.clone(),
                            Err(_) => return,
                        };
                        let Some(sender) = sender else { continue };
                        let packet = Packet {
                            seq: rtp.header.sequence_number,
                            payload: rtp.payload.to_vec(),
                        };
                        // try_send, not send: the consumer is the playout thread and the network
                        // task must never wait on it. A full queue means playout has stalled, and
                        // dropping is what keeps latency bounded rather than unbounded.
                        let _ = sender.try_send((mid.clone(), packet));
                    }
                    // The track ended, or the connection went away.
                    Err(_) => return,
                }
            }
        });

        // Handed straight back, so the next track can be handled. See this function's note.
        Box::pin(async {})
    }));
}

/// Retire transceivers added for a subscribe that then failed.
///
/// Stopping is the most that can be done: JSEP has no way to take an m-line back out of a session
/// that has already offered it. A stopped one is offered as inactive and can be recycled by a later
/// negotiation, which is what keeps a retried subscribe from growing the SDP without bound.
///
/// Failures are logged and swallowed. This only ever runs on a path that is already returning an
/// error, and replacing the real reason a subscribe failed with a cleanup error would hide it.
async fn stop_transceivers(transceivers: Vec<Arc<RTCRtpTransceiver>>) {
    for transceiver in transceivers {
        if let Err(e) = transceiver.stop().await {
            eprintln!("[voice] could not stop a transceiver after a failed subscribe: {e}");
        }
    }
}

impl VoicePublication {
    pub async fn start(
        signalling: Signalling,
        ice_servers: Vec<IceServerConfig>,
    ) -> Result<Self, String> {
        let api = voice_api()?;

        let config = RTCConfiguration {
            ice_servers: ice_servers
                .into_iter()
                .map(|server| RTCIceServer {
                    urls: server.urls,
                    username: server.username.unwrap_or_default(),
                    credential: server.credential.unwrap_or_default(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };

        let peer_connection = Arc::new(
            api.new_peer_connection(config)
                .await
                .map_err(|e| e.to_string())?,
        );

        let track = Arc::new(TrackLocalStaticSample::new(
            opus_capability(),
            "audio".to_owned(),
            TRACK_NAME.to_owned(),
        ));

        let rtp_sender = peer_connection
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        // RTCP has to be drained or the sender's buffers fill and stall the track. We do not act on
        // the reports yet; reading and discarding is enough to keep the pipe moving.
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1500];
            while rtp_sender.read(&mut buf).await.is_ok() {}
        });

        // A spare recvonly m-line, offered now and never used, purely so this session's remote
        // description is never *exactly* one media section.
        //
        // This looks like waste and is load-bearing. `webrtc-rs` has a fallback for RTP whose SSRC
        // was never declared in SDP - `handle_undeclared_ssrc` - and it is guarded on the remote
        // description having exactly one media section. Cloudflare declares no SSRC for a pulled
        // track and starts forwarding it the moment it processes the pull, which is strictly before
        // the pull's HTTP response gets back here and is applied. In that window a publish-only
        // session has exactly one m-line, the fallback fires, and instead of matching the stream to
        // the recvonly transceiver waiting for it, `webrtc-rs` *invents* a transceiver for it. An
        // invented transceiver has no mid, and the SSRC is bound to it permanently - so
        // `route_inbound_audio` logs "a remote track opened with no mid" and that participant is
        // inaudible for the rest of the call, with the connection reporting healthy throughout.
        //
        // Observed in a release build, in order: the track opened *before* the "pulled 1 track(s)"
        // line was printed, and `rtp_received` stayed at zero for the rest of the session. It is a
        // race, not a certainty - joining an empty channel usually wins it, because the other side's
        // media starts later - but joining a channel someone is already talking in loses it
        // reliably, because their media is already flowing at Cloudflare and is forwarded instantly.
        //
        // With a second m-line present the fallback can never fire. Early RTP then fails the
        // `sdes:mid` extension check inside `handle_incoming_rtp_stream` and is rejected *before*
        // `streams_for_ssrc` binds anything, and that rejection is harmless: `accept` and `open`
        // share one stream map in `webrtc-srtp`, so the stream stays registered and buffering, and
        // the receiver started by the answer picks up the same stream with the right transceiver
        // and the right mid.
        //
        // Added after `add_track`, deliberately: the mid reported to Cloudflare below is read from
        // the *first* transceiver, which has to stay the microphone's.
        peer_connection
            .add_transceiver_from_kind(
                RTPCodecType::Audio,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    send_encodings: vec![],
                }),
            )
            .await
            .map_err(|e| e.to_string())?;

        let stats = Arc::new(PublicationStats::default());

        // Until now nothing on this connection reported whether it ever came up. Signalling
        // succeeding and media flowing are independent, and only the first of them was observable:
        // a connection that negotiated cleanly and then failed its handshake presented as a working
        // call with no audio and an empty console. These say which of the two happened.
        //
        // Logged as well as recorded, so a state change is visible in order rather than only as
        // whatever the last value was when someone asked.
        let peer_stats = Arc::clone(&stats);
        peer_connection.on_peer_connection_state_change(Box::new(move |state| {
            peer_stats.set_peer_state(&state);
            eprintln!("[voice] peer connection state: {state}");
            Box::pin(async {})
        }));

        let ice_stats = Arc::clone(&stats);
        peer_connection.on_ice_connection_state_change(Box::new(move |state| {
            ice_stats.set_ice_state(&state);
            eprintln!("[voice] ICE connection state: {state}");
            Box::pin(async {})
        }));

        // Installed now, before any subscription exists, because Cloudflare starts sending as soon
        // as it answers a pull. A handler added per-subscription races the first packets of that
        // subscription, and those are exactly the packets the jitter buffer needs to start cleanly.
        let packet_sink: PacketSink = Arc::new(std::sync::Mutex::new(None));
        route_inbound_audio(&peer_connection, &packet_sink, &stats);

        let offer = peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;

        // Cloudflare needs a complete SDP, and there is no trickle path to the backend here, so
        // wait for ICE gathering before offering.
        //
        // Bounded, because this await used to be unbounded and sits on the path the webview blocks
        // its whole negotiation queue behind: one unreachable STUN server and the caller never
        // returns, every later subscribe queues forever, and the only symptom is silence with
        // nothing in the console. Offering with the candidates gathered so far is strictly better
        // than never offering - host and server-reflexive candidates arrive first, and a relay
        // candidate that is still pending after this long is not going to save the connection.
        let mut gathering = peer_connection.gathering_complete_promise().await;
        peer_connection
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        if tokio::time::timeout(GATHER_TIMEOUT, gathering.recv())
            .await
            .is_err()
        {
            eprintln!(
                "[voice] ICE gathering did not complete within {GATHER_TIMEOUT:?}; offering with \
                 the candidates gathered so far"
            );
        }

        let local = peer_connection
            .local_description()
            .await
            .ok_or_else(|| "no local description after gathering".to_string())?;

        // Recorded before the offer goes out, so a connection that later fails can be told apart
        // from one that never had anywhere to connect from.
        let candidates: Vec<String> = local
            .sdp
            .lines()
            .filter(|line| line.starts_with("a=candidate:"))
            .map(|line| line.trim_start_matches("a=").to_owned())
            .collect();
        eprintln!("[voice] offering {} local candidate(s)", candidates.len());
        for candidate in &candidates {
            eprintln!("[voice]   {candidate}");
        }
        if let Ok(mut guard) = stats.local_candidates.lock() {
            *guard = candidates;
        }

        let cf_session_id = signalling.create_session().await?;

        // The mid is assigned during offer creation, so it can only be read now.
        let mid = peer_connection
            .get_transceivers()
            .await
            .first()
            .ok_or_else(|| "no transceiver on the voice connection".to_string())?
            .mid()
            .map(|m| m.to_string())
            .unwrap_or_else(|| "0".to_string());

        let response = signalling
            .tracks_new(
                &cf_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: local.sdp,
                },
                &[LocalTrack {
                    location: "local",
                    mid,
                    track_name: TRACK_NAME.to_owned(),
                }],
            )
            .await?;

        if let Some(error) = response.tracks.iter().find_map(|t| t.error.as_ref()) {
            return Err(format!("Cloudflare rejected the voice track: {error}"));
        }

        // Where this connection is actually trying to send, and how the far end intends to answer.
        //
        // Only the local candidates were ever logged, which makes a failed ICE handshake
        // unattributable: "checking" then "failed" says the pairs did not work, but not whether the
        // remote address was ever reachable from this machine. That address is the one thing needed
        // to tell "UDP is blocked" apart from "this particular destination is routed somewhere
        // else" - a split-tunnel VPN passes a STUN server perfectly while black-holing the media
        // server, and the two are indistinguishable without knowing which IP the media was aimed at.
        //
        // `ice-lite` is worth stating too: it is the property the empty ICE-server list depends on.
        // A lite agent never sends checks of its own, it only answers ours from the address we sent
        // to, which is why host candidates suffice and why no unsolicited inbound has to be allowed.
        let remote_sdp = &response.session_description.sdp;
        eprintln!(
            "[voice] remote is {}",
            if remote_sdp.contains("a=ice-lite") {
                "an ice-lite agent (it only answers our checks)"
            } else {
                "a full ICE agent (it will send checks of its own)"
            }
        );
        for line in remote_sdp.lines().filter(|l| l.starts_with("a=candidate:")) {
            eprintln!("[voice]   remote {}", line.trim_start_matches("a="));
        }

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        let track_name = response
            .tracks
            .first()
            .and_then(|t| t.track_name.clone())
            .unwrap_or_else(|| TRACK_NAME.to_owned());

        let publication = Self {
            peer_connection,
            track,
            signalling,
            packet_sink,
            stats,
            negotiation: tokio::sync::Mutex::new(()),
            cf_session_id,
            track_name,
        };

        if response.requires_immediate_renegotiation {
            publication.renegotiate().await?;
        }

        Ok(publication)
    }

    /// Counters for this publication. Shared, so the session's capture fan-out and inbound task
    /// report into the same set the transport does.
    pub fn stats(&self) -> Arc<PublicationStats> {
        Arc::clone(&self.stats)
    }

    /// Route every RTP packet on every subscribed track into `sink`, keyed by mid.
    pub fn on_audio(&self, sink: tokio::sync::mpsc::Sender<(String, Packet)>) {
        if let Ok(mut guard) = self.packet_sink.lock() {
            *guard = Some(sink);
        }
    }

    /// Pull a set of remote tracks onto this session, returning Cloudflare's mid for each, in the
    /// order they were asked for.
    ///
    /// Those mids are the *only* way to route incoming packets to a participant. A track that comes
    /// back without one is a failed subscribe wearing an HTTP 200, and is reported as an error
    /// rather than skipped - the webview's guild path used to skip it silently, and the participant
    /// was then unhearable for the rest of the session with nothing in any log.
    ///
    /// No ICE gathering wait here, deliberately: the connection is already established by the
    /// publish, and a subscribe is a renegotiation of it. Waiting again would reintroduce exactly
    /// the stall that wedged phase 1.
    ///
    /// `register` is called with the mids **before** the answer is applied, and that ordering is the
    /// whole reason it is a callback rather than something the caller does with the return value.
    /// Cloudflare begins sending the moment `set_remote_description` lands, so a mid-to-participant
    /// map written after this function returns loses the opening packets of every subscription.
    pub async fn subscribe<F>(
        &self,
        sources: &[(String, String)],
        register: F,
    ) -> Result<Vec<String>, String>
    where
        F: FnOnce(&[String]),
    {
        if sources.is_empty() {
            return Ok(Vec::new());
        }

        // Taken before the transceivers are added, not just around the offer: the m-lines and the
        // offer that carries them have to reach Cloudflare as one unit, or a subscribe that
        // interleaves here offers m-lines belonging to the other one. Held until the answer is
        // applied - see the field's own note.
        let _negotiating = self.negotiation.lock().await;

        // Held rather than dropped on the floor: every one of these is an m-line in the next offer,
        // and a subscribe that fails must not leave one behind. Subscribing is retried now (the
        // publisher's first RTP packet can arrive after the announcement that it exists), so an
        // un-rolled-back transceiver is no longer a one-off cost - it is one dead recvonly m-line
        // per attempt, growing the SDP of every later renegotiation on this connection.
        let mut added = Vec::with_capacity(sources.len());
        for _ in sources {
            match self
                .peer_connection
                .add_transceiver_from_kind(
                    RTPCodecType::Audio,
                    Some(RTCRtpTransceiverInit {
                        direction: RTCRtpTransceiverDirection::Recvonly,
                        send_encodings: vec![],
                    }),
                )
                .await
            {
                Ok(transceiver) => added.push(transceiver),
                Err(e) => {
                    stop_transceivers(added).await;
                    return Err(e.to_string());
                }
            }
        }

        match self.negotiate_subscription(sources, register).await {
            Ok(mids) => Ok(mids),
            Err(e) => {
                stop_transceivers(added).await;
                Err(e)
            }
        }
    }

    /// The offer/answer half of `subscribe`, split out so its caller can roll the transceivers back
    /// on any failure without repeating the cleanup at each `?`.
    async fn negotiate_subscription<F>(
        &self,
        sources: &[(String, String)],
        register: F,
    ) -> Result<Vec<String>, String>
    where
        F: FnOnce(&[String]),
    {
        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let local = self
            .peer_connection
            .local_description()
            .await
            .ok_or_else(|| "no local description for subscribe".to_string())?;

        let response = self
            .signalling
            .tracks_new_remote(
                &self.cf_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: local.sdp,
                },
                &subscription_tracks(sources),
            )
            .await?;

        let mids: Vec<String> = response
            .tracks
            .iter()
            .map(|t| t.mid.clone().unwrap_or_default())
            .collect();
        if mids.len() != sources.len() || mids.iter().any(|m| m.is_empty()) {
            return Err(format!(
                "Cloudflare returned no mid for one or more subscribed tracks: {:?}",
                response.tracks
            ));
        }

        // Before the answer, not after. See the note on this function.
        register(&mids);

        // The two ends of the window in which "a remote track opened with no mid" happens.
        //
        // Cloudflare starts sending a pulled track when it processes the pull, not when this side
        // finishes applying the answer - and until that answer is applied the remote description is
        // still the publish's single m-line. `webrtc-rs` treats a stream arriving then as having an
        // undeclared SSRC, and its handling for that case (`handle_undeclared_ssrc`) *invents* a
        // transceiver rather than matching one. An invented transceiver has no mid, and the SSRC is
        // bound to it permanently, so that participant is inaudible for the rest of the session.
        //
        // These two lines are what say whether that is what happened: a "no mid" between them is
        // this race, and one after "answer applied" is something else entirely.
        eprintln!(
            "[voice] pulled {} track(s) on mid(s) {:?}; applying the answer",
            mids.len(),
            mids
        );

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        eprintln!("[voice] answer applied for mid(s) {mids:?}");

        if response.requires_immediate_renegotiation {
            self.renegotiate().await?;
        }
        Ok(mids)
    }

    /// Hand one encoded packet to the packetiser.
    ///
    /// Takes `Bytes` rather than a `Vec` because the same packet goes to every publication at once:
    /// the capture thread allocates it once and each publication clones the handle. `Sample` wants
    /// `Bytes` anyway, so this also removes the copy that `Vec::into` used to make here.
    pub async fn write_packet(&self, packet: bytes::Bytes) -> Result<(), String> {
        let result = self
            .track
            .write_sample(&Sample {
                data: packet,
                timestamp: SystemTime::now(),
                duration: PACKET_DURATION,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string());
        match &result {
            Ok(()) => self.stats.packets_sent.fetch_add(1, Ordering::Relaxed),
            Err(_) => self.stats.write_errors.fetch_add(1, Ordering::Relaxed),
        };
        result
    }

    /// Deliberately does **not** take `negotiation` itself.
    ///
    /// Both its callers already hold it or cannot race: `subscribe` calls it through
    /// `negotiate_subscription` with the guard held, and `start` runs before the publication is
    /// shared with anything. A `tokio::sync::Mutex` is not reentrant, so locking here would deadlock
    /// the first subscribe Cloudflare asks to renegotiate immediately.
    async fn renegotiate(&self) -> Result<(), String> {
        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_local_description(offer.clone())
            .await
            .map_err(|e| e.to_string())?;

        let response = self
            .signalling
            .renegotiate(
                &self.cf_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: offer.sdp,
                },
            )
            .await?;

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    /// Close the track server-side and tear down the connection.
    ///
    /// Takes `&self` rather than `self` because the publication is shared: the writer task, the
    /// playout side and the command handles all hold it through an `Arc`.
    pub async fn stop(&self) {
        let _ = self
            .signalling
            .close_tracks(&self.cf_session_id, &[self.track_name.clone()])
            .await;
        let _ = self.peer_connection.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subscription_asks_for_remote_tracks_only() {
        // The request shape is what Cloudflare validates, and getting it wrong fails only against
        // the real SFU - which is the most expensive place to find out.
        let tracks = subscription_tracks(&[
            ("sess-a".to_string(), "audio".to_string()),
            ("sess-b".to_string(), "screen-audio-x".to_string()),
        ]);
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().all(|t| t.location == "remote"));
        assert_eq!(tracks[0].session_id, "sess-a");
        assert_eq!(tracks[0].track_name, "audio");
        assert_eq!(tracks[1].session_id, "sess-b");
        assert_eq!(tracks[1].track_name, "screen-audio-x");
    }

    #[test]
    fn an_empty_subscription_asks_for_nothing() {
        assert!(subscription_tracks(&[]).is_empty());
    }

    #[test]
    fn the_codec_is_mono_opus_at_the_pipeline_rate() {
        let cap = opus_capability();
        assert_eq!(cap.mime_type, MIME_TYPE_OPUS);
        assert_eq!(cap.clock_rate, 48_000);
        assert_eq!(cap.channels, 1);
    }

    #[test]
    fn the_fmtp_line_advertises_in_band_fec() {
        // The receiver only asks for FEC if we say we can produce it, and the encoder is configured
        // to produce it - so an fmtp line omitting this quietly wastes redundancy already paid for.
        assert!(opus_capability().sdp_fmtp_line.contains("useinbandfec=1"));
    }

    #[test]
    fn the_fmtp_line_declares_the_packet_duration() {
        assert!(opus_capability().sdp_fmtp_line.contains("minptime=10"));
    }

    #[test]
    fn the_track_name_matches_what_the_webview_used_to_publish() {
        // Other clients resolve a participant's audio by this name. Changing it orphans everyone
        // still running the previous build.
        assert_eq!(TRACK_NAME, "audio");
    }

    #[test]
    fn the_packet_duration_matches_the_encoders_packetisation() {
        use crate::media::voice::codec::PACKET_SAMPLES;
        use crate::media::voice::SAMPLE_RATE;

        // A mismatch here does not fail anywhere: it produces RTP timestamps that drift steadily
        // against the audio, which sounds like the far end slowly falling behind.
        let expected = Duration::from_micros(
            (PACKET_SAMPLES as u64 * 1_000_000) / SAMPLE_RATE as u64,
        );
        assert_eq!(PACKET_DURATION, expected);
    }
}
