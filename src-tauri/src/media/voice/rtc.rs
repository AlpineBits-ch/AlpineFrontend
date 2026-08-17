//! One Opus microphone track, published over whichever SFU the target speaks to.
//!
//! The transport half of the Rust voice pipeline. Packets arrive already encoded from
//! [`super::chain`]; this module owns the transport and knows nothing about audio.
//!
//! # Two transports, and which target takes which
//!
//! Guild channels and DM calls publish into a LiveKit [`Room`] (see
//! `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`). Isle proximity voice
//! keeps the `webrtc-rs` peer connection and the Cloudflare offer/answer handshake it has always
//! had, unchanged, because proximity voice has no room model on either side and nothing about it
//! was migrated.
//!
//! [`Transport`] is where the two meet, and it is deliberately the *only* place they differ:
//! capture, gating, denoise, Opus, the jitter buffer and the mixer are shared by both, and
//! [`VoicePublication::write_packet`] is identical on either arm because both end at a
//! `TrackLocalStaticSample`.
//!
//! Shaped after `publisher::rtc`, which does the same job for screen video. The difference that
//! matters on the Cloudflare arm is the session role: voice is the *primary* session, because the
//! backend records the primary session as the participant's audio.

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

use crate::media::livekit::registry;
use crate::media::livekit::room::{RemoteTrack as LiveKitTrack, Room};
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

/// How long a LiveKit publisher connection may take to start carrying media before the join fails.
///
/// Generous: ICE against a node that is up finishes in well under a second, and a room that already
/// has the screen share on it is connected before this is even called. Exceeding it is treated as a
/// failed join rather than logged and carried on with, because the alternative is the failure this
/// whole file is annotated against - a call that reports connected, transports nothing, and has
/// nothing anywhere saying so. A failed join is at least something the user can retry.
const LIVEKIT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
    voice_api_with(webrtc::api::setting_engine::SettingEngine::default())
}

/// [`voice_api`], with gathering confined by `settings`.
///
/// Taken as a parameter rather than built here because the only useful setting is which local
/// addresses may be gathered on, and that depends on the SFU being connected to - see
/// `media::livekit::egress`. A default engine gathers on every interface, which is what every
/// caller did before that module existed.
pub fn voice_api_with(
    settings: webrtc::api::setting_engine::SettingEngine,
) -> Result<webrtc::api::API, String> {
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
        .with_setting_engine(settings)
        .build())
}

/// Where RTP from subscribed tracks goes, keyed by the routing key its transport addresses it by -
/// the mid Cloudflare assigned, or the track SID LiveKit issued.
///
/// Set once by the session after construction. Behind a mutex only because the handler is installed
/// before the consumer exists - see the note in `start_cloudflare`.
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
    /// Packets whose routing key matched a subscribed source and reached its jitter buffer.
    ///
    /// Zero against a climbing `rtp_received` is the reading that says media is arriving and being
    /// binned, which is a different fault from either counter alone. It is exactly what the LiveKit
    /// arm read before [`VoicePublication::on_audio`] handed its sink to the room as well as to
    /// `packet_sink` - the room owns the only `on_track` handler, so a sink set only here is a sink
    /// nothing ever writes to.
    pub rtp_routed: AtomicU64,
    /// Packets discarded because their routing key was in no source map. The inbound task drops
    /// these with a bare `continue`, so without this counter a routing bug is invisible.
    pub rtp_unmapped: AtomicU64,
    /// Latest transport states. On Cloudflare, the peer connection and its ICE agent; on LiveKit,
    /// the publisher connection and the subscriber connection, which is the pair that decides
    /// whether we are heard and whether we can hear.
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

/// How one publication reaches an SFU.
///
/// The two arms are not two implementations of one protocol - they are two protocols, and the only
/// thing they have in common is that a `TrackLocalStaticSample` comes out the far end. Keeping them
/// in one enum rather than behind a trait is deliberate: every difference between them is visible
/// here in one screen, and the compiler names every site that has to care.
pub enum Transport {
    /// A guild channel or a DM call, publishing into a room shared with the screen publisher.
    LiveKit {
        /// Taken out on [`VoicePublication::stop`], which is what lets the room be closed.
        ///
        /// [`Room::close`] consumes `self`, and this publication is one of at least two holders of
        /// the `Arc` - the registry holds the other. Nothing can close a room while a strong
        /// reference is still parked in a struct field, so the field gives its reference up first
        /// and only then asks the registry whether it was the last holder.
        ///
        /// A `std::sync::Mutex` rather than tokio's, because the reporting path reads it from a
        /// synchronous `voice_stats` and only ever clones the handle out - nothing is held across
        /// an await.
        room: std::sync::Mutex<Option<Arc<Room>>>,
        /// The registry key this room was acquired under, and the key it must be released with.
        registry_key: String,
        /// The runtime to send an unsubscribe on, captured while there was certainly one.
        ///
        /// `voice_unsubscribe` is a synchronous Tauri command and `Engine::unpublish` runs under
        /// the engine mutex, so neither can await - and neither can promise it is standing in a
        /// runtime context either. Asking `Handle::try_current()` at that point and giving up when
        /// it answers `Err` would drop the unsubscribe with nothing said, leaving the SFU forwarding
        /// a track nobody decodes for the rest of the call. Held from construction, where the
        /// answer is not in doubt.
        runtime: tokio::runtime::Handle,
    },
    /// Isle proximity voice. Unchanged from before the migration, and deliberately so.
    Cloudflare {
        peer_connection: Arc<RTCPeerConnection>,
        signalling: Signalling,
    },
}

impl Transport {
    /// The room, or `None` on the Cloudflare arm and after [`VoicePublication::stop`].
    fn room(&self) -> Option<Arc<Room>> {
        match self {
            Transport::LiveKit { room, .. } => room.lock().ok().and_then(|r| r.clone()),
            Transport::Cloudflare { .. } => None,
        }
    }

    /// The room, taken out so this publication no longer holds it. See the field's own note.
    fn take_room(&self) -> Option<Arc<Room>> {
        match self {
            Transport::LiveKit { room, .. } => room.lock().ok().and_then(|mut r| r.take()),
            Transport::Cloudflare { .. } => None,
        }
    }
}

pub struct VoicePublication {
    transport: Transport,
    track: Arc<TrackLocalStaticSample>,
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
    pub media_session_id: String,
    pub track_name: String,
}

/// Build the pull request for a set of `(media_session_id, track_name)` pairs.
///
/// Split out from `subscribe` so the request shape is testable without a peer connection or a
/// network. The shape is the part that is easy to get wrong; the plumbing around it is not.
fn subscription_tracks(sources: &[(String, String)]) -> Vec<RemoteTrack> {
    sources
        .iter()
        .map(|(session_id, track_name)| RemoteTrack {
            track_name: track_name.clone(),
            session_id: session_id.clone(),
        })
        .collect()
}

/// The server-issued SID for the track the caller named as `(media_session_id, track_name)`.
///
/// **This is the one place the two SFUs address a remote track differently, and the shape change is
/// not cosmetic.** Cloudflare pulls a track by the pair the roster carries; LiveKit only ever
/// accepts a SID it issued itself, so the pair has to be resolved against what the room has told us
/// other people are publishing. Everything above this - the roster, the announcements, the
/// `voice_subscribe` command - still speaks in pairs, and that is why the translation lives here
/// rather than leaking upwards.
///
/// `media_session_id` is matched against the *identity* first and the user id second. Under the
/// migration a participant's identity is the bare user id on their primary connection and
/// `{userId}#{tag}` on a secondary (spec §2.1), so a caller naming a user matches whichever
/// connection actually carries the track, while a caller naming an exact identity is never handed
/// back a different connection's track of the same name. Preferring the exact match is what keeps a
/// request for the primary's `audio` from resolving to a secondary that happens to publish one.
fn sid_for(tracks: &[LiveKitTrack], media_session_id: &str, track_name: &str) -> Option<String> {
    let named = || tracks.iter().filter(|t| t.track_name == track_name);
    named()
        .find(|t| t.identity == media_session_id)
        .or_else(|| named().find(|t| t.user_id == media_session_id))
        .map(|t| t.sid.clone())
}

/// Read every remote track this connection opens, and forward its RTP to `sink`, keyed by mid.
///
/// Split out of [`VoicePublication::start_cloudflare`] so `super::e2e_tests` drives the *real*
/// handler rather than a copy of its shape - a copy is exactly what would have kept passing while
/// this broke.
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

/// Give a room back to the registry, closing it if nobody else is holding it.
///
/// Split out because both the failure path in [`VoicePublication::start_livekit`] and the ordinary
/// [`VoicePublication::stop`] need exactly this, and a release that forgets to close leaves a
/// WebSocket and two peer connections alive for the rest of the process - which presents as a user
/// who left a channel still appearing in it to everyone else.
async fn release_room(registry_key: &str) {
    let Some(room) = registry::release(registry_key).await else {
        // Somebody else is still publishing into it - the screen share, typically. Theirs to close.
        return;
    };
    match Arc::try_unwrap(room) {
        Ok(room) => room.close().await,
        // The registry says we were the last *holder*, so this can only be a clone taken by a
        // caller that is mid-teardown. Logged rather than retried: closing is not something that
        // can be scheduled from here, and the counter-free alternative is a silent leak.
        Err(_) => eprintln!(
            "[voice] the room for {registry_key} was released while a reference was still out; \
             it will close when that reference does"
        ),
    }
}

impl VoicePublication {
    /// Publish the microphone into the LiveKit room for `registry_key`.
    ///
    /// The room is acquired rather than connected, so the microphone and the screen share of the
    /// same call share one participant - which is what removes the case
    /// `VoiceShareSnapshot.mediaSessionId` exists for (spec §2.1). Whoever gets there first pays for
    /// the connection; the second one joins it.
    ///
    /// `url` and `token` come from the webview, which fetched `POST .../voice/connection` on this
    /// process's behalf. Rust makes no control-plane call for a LiveKit room (spec §2.2): the
    /// webview has the interceptor chain that can refresh an expired bearer, and a token string
    /// captured here at join time cannot.
    pub async fn start_livekit(
        registry_key: String,
        url: &str,
        token: &str,
    ) -> Result<Self, String> {
        eprintln!("[voice] acquiring the LiveKit room {registry_key} at {url}");
        let room = registry::acquire(&registry_key, url, token).await?;

        // Every failure from here on releases what was just acquired. Returning `Err` without it
        // would leave a room nobody publishes into holding a participant slot until the process
        // ends - and a rejoin would then find it in the registry and reuse a connection whose
        // publish had already failed once.
        // **Every failure below drops `room` before releasing it**, and that is not a style choice.
        // `release_room` closes the connection only if it is the last holder, and a live local
        // binding means it never is - so the signal client and both peer connections outlived every
        // failed join, which is exactly the leak the note on `release_room` warns about. The
        // borrow checker cannot catch it: the code reads correctly either way.
        let publication = match room.publish_audio(TRACK_NAME).await {
            Ok(publication) => publication,
            Err(e) => {
                drop(room);
                release_room(&registry_key).await;
                return Err(format!("LiveKit refused the microphone track: {e}"));
            }
        };

        let Some(track) = room.local_track(TRACK_NAME).await else {
            drop(room);
            release_room(&registry_key).await;
            return Err("the published microphone track went missing from the room".into());
        };

        // Publishing having returned is not the same thing as the connection carrying media: the
        // SID arrives on `TrackPublishedResponse`, which the server may send before its `Answer`.
        // See `Room::wait_until_connected` and spec §7.
        if let Err(e) = room.wait_until_connected(LIVEKIT_CONNECT_TIMEOUT).await {
            drop(room);
            release_room(&registry_key).await;
            return Err(format!("the LiveKit publisher never came up: {e}"));
        }

        // Only a connection that came up is worth watching, and only from here is there one. See
        // `Room::supervise`: this is what carries a call across a tunnel appearing or a handover.
        room.supervise();

        eprintln!(
            "[voice] microphone published as {} (sid {})",
            publication.track_name, publication.sid
        );

        Ok(Self {
            transport: Transport::LiveKit {
                room: std::sync::Mutex::new(Some(room)),
                registry_key,
                runtime: tokio::runtime::Handle::current(),
            },
            track,
            packet_sink: Arc::new(std::sync::Mutex::new(None)),
            stats: Arc::new(PublicationStats::default()),
            negotiation: tokio::sync::Mutex::new(()),
            // LiveKit has no session id, and inventing one here would put a string on the roster
            // that addresses nothing. The participant *is* the identity, and the webview already
            // holds it: it minted the connection this room was opened with (spec §2.2). So the
            // field is empty on this arm rather than fabricated, and every caller that reads it
            // reads a blank instead of a plausible-looking id that resolves to no session.
            media_session_id: String::new(),
            track_name: publication.track_name,
        })
    }

    /// Publish the microphone over a Cloudflare session of our own. Isle, and only Isle.
    pub async fn start_cloudflare(
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

        let media_session_id = signalling.create_session().await?;

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
                &media_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: local.sdp,
                },
                &[LocalTrack {
                    mid,
                    track_name: TRACK_NAME.to_owned(),
                }],
                // The microphone. Nothing about audio is laddered, so there is nothing to declare.
                None,
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
            transport: Transport::Cloudflare {
                peer_connection,
                signalling,
            },
            track,
            packet_sink,
            stats,
            negotiation: tokio::sync::Mutex::new(()),
            media_session_id,
            track_name,
        };

        if response.requires_immediate_renegotiation {
            // Read back out of the transport rather than kept aside before the move: one owner of
            // the connection, so there is no second handle that could go stale against it.
            let Transport::Cloudflare {
                peer_connection,
                signalling,
            } = &publication.transport
            else {
                unreachable!("this constructor only ever builds the Cloudflare arm");
            };
            publication.renegotiate(peer_connection, signalling).await?;
        }

        Ok(publication)
    }

    /// Counters for this publication. Shared, so the session's capture fan-out and inbound task
    /// report into the same set the transport does.
    pub fn stats(&self) -> Arc<PublicationStats> {
        Arc::clone(&self.stats)
    }

    /// Copy what the shared room knows into this publication's own counters.
    ///
    /// Only the LiveKit arm has anything to do here, and it has to be done at read time rather than
    /// continuously: the receive counters live on the [`Room`], which is shared with the screen
    /// publisher and outlives any one publication. Without this the report would show a publication
    /// with zero inbound packets on a room that is carrying the whole call - the exact reading that
    /// makes "signalled but silent" indistinguishable from "never signalled", which is what every
    /// counter in [`PublicationStats`] exists to separate.
    ///
    /// `rtp_received` and `tracks_opened` are the room's totals, not this publication's share: the
    /// Rust room subscribes audio only (spec §2.1), so they are microphones and screen audio, which
    /// is what this publication would have counted anyway.
    pub fn refresh_stats(&self) {
        let Some(room) = self.transport.room() else {
            return;
        };
        self.stats
            .rtp_received
            .store(room.stats.rtp_received.load(Ordering::Relaxed), Ordering::Relaxed);
        self.stats
            .tracks_opened
            .store(room.stats.tracks_opened.load(Ordering::Relaxed), Ordering::Relaxed);
        if let Ok(mut guard) = self.stats.peer_state.lock() {
            *guard = room.publisher_state().to_string();
        }
        // The subscriber connection rather than an ICE state, because on LiveKit those are two
        // separate peer connections and the one that carries other people's audio is the one whose
        // health explains silence. Reported under `ice_state` so the existing panel keeps its two
        // columns rather than growing a third that only one transport fills in.
        if let Ok(mut guard) = self.stats.ice_state.lock() {
            *guard = format!("sub:{}", room.subscriber_state());
        }
    }

    /// Route every RTP packet on every subscribed track into `sink`, keyed by the routing key that
    /// [`Self::subscribe`] handed back - a mid on Cloudflare, a track SID on LiveKit.
    ///
    /// **On the LiveKit arm the room does the reading, so the sink is handed to it as well.**
    /// `webrtc-rs` allows exactly one `on_track` handler per connection and the subscriber
    /// connection belongs to [`Room`], so this cannot install its own - it registers a destination
    /// on the room instead, and the room forwards each packet keyed by the track's id.
    ///
    /// Setting only `packet_sink` is what "signalled but silent" looks like from the outside:
    /// `rtp_received` climbs on the room's own counter while `rtp_routed` stays at zero and the
    /// mixer never sees a frame. Those two counters disagreeing is the reading that says the hand-off
    /// below is missing, and it is why both are reported.
    pub fn on_audio(&self, sink: tokio::sync::mpsc::Sender<(String, Packet)>) {
        if let Ok(mut guard) = self.packet_sink.lock() {
            *guard = Some(sink.clone());
        }

        // The room routes by track SID, which is the same key `subscribe_livekit` registered its
        // sources under - so the sink can be shared verbatim rather than translated.
        if let Some(room) = self.transport.room() {
            room.on_audio(sink);
        }
    }

    /// Start receiving a set of remote tracks, returning the key each one's RTP will arrive under,
    /// in the order they were asked for.
    ///
    /// **What that key is depends on the transport, and the caller must not care which.** On
    /// Cloudflare it is the mid the SFU assigned; on LiveKit it is the server-issued track SID. Both
    /// are the *only* way to route incoming packets to a participant, so both are reported as an
    /// error when they cannot be produced rather than skipped - the webview's guild path used to
    /// skip a missing mid silently, and the participant was then unhearable for the rest of the
    /// session with nothing in any log. The LiveKit arm inherits that rule for an unresolvable
    /// `(mediaSessionId, trackName)` pair, which is the same failure one layer up.
    ///
    /// `register` is called with those keys **before** any media can arrive, and that ordering is
    /// the whole reason it is a callback rather than something the caller does with the return
    /// value. Both SFUs begin sending as soon as they have processed the request, so a routing map
    /// written after this function returns loses the opening packets of every subscription.
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
        match &self.transport {
            Transport::LiveKit { .. } => self.subscribe_livekit(sources, register).await,
            Transport::Cloudflare {
                peer_connection,
                signalling,
            } => {
                self.subscribe_cloudflare(peer_connection, signalling, sources, register)
                    .await
            }
        }
    }

    /// Ask the room for each track by the SID it issued for it.
    ///
    /// There is no negotiation to serialise here and no transceiver to roll back: `UpdateSubscription`
    /// is a request the server answers by offering on its own subscriber connection, and the room
    /// handles that offer wherever it lands. That is the whole of what §2.3 means by "subscribing
    /// becomes `UpdateSubscription`".
    ///
    /// A pair with no SID is an error and never a quiet `Ok`. The room learns about a track from
    /// `JoinResponse` or a `ParticipantUpdate`, so a pair that resolves to nothing means the
    /// announcement arrived before the room knew about the publisher - and a swallowed subscribe is
    /// a participant who stays silent for the whole session while every layer above reports success.
    /// Reported with what the room *does* know, because "no sid" alone does not say whether the
    /// track is missing or the identity was written differently.
    async fn subscribe_livekit<F>(
        &self,
        sources: &[(String, String)],
        register: F,
    ) -> Result<Vec<String>, String>
    where
        F: FnOnce(&[String]),
    {
        let room = self
            .transport
            .room()
            .ok_or_else(|| "this publication has already been stopped".to_string())?;

        let known = room.remote_tracks().await;
        let mut sids = Vec::with_capacity(sources.len());
        for (media_session_id, track_name) in sources {
            match sid_for(&known, media_session_id, track_name) {
                Some(sid) => sids.push(sid),
                None => {
                    let seen: Vec<String> = known
                        .iter()
                        .map(|t| format!("{}/{}", t.identity, t.track_name))
                        .collect();
                    // **Logged here as well as returned.** The error goes back over the Tauri
                    // boundary to the webview, which prints it to a devtools console nobody has
                    // open - so a subscribe that failed left `venta.log` showing a participant
                    // going quiet with no cause anywhere in it. This is the cause.
                    let reason = format!(
                        "the room has no track sid for {track_name} on {media_session_id}; \
                         it knows about {seen:?}"
                    );
                    eprintln!("[voice] subscribe failed: {reason}");
                    return Err(reason);
                }
            }
        }

        // Before the request, for the same reason the Cloudflare arm registers before applying the
        // answer: the server can start forwarding as soon as it has processed this.
        register(&sids);

        for sid in &sids {
            room.subscribe(sid).await;
        }
        eprintln!("[voice] subscribed to track sid(s) {sids:?}");
        Ok(sids)
    }

    /// Pull a set of remote tracks onto a Cloudflare session. Unchanged; Isle's path.
    ///
    /// No ICE gathering wait here, deliberately: the connection is already established by the
    /// publish, and a subscribe is a renegotiation of it. Waiting again would reintroduce exactly
    /// the stall that wedged phase 1.
    async fn subscribe_cloudflare<F>(
        &self,
        peer_connection: &Arc<RTCPeerConnection>,
        signalling: &Signalling,
        sources: &[(String, String)],
        register: F,
    ) -> Result<Vec<String>, String>
    where
        F: FnOnce(&[String]),
    {
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
            match peer_connection
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

        match self
            .negotiate_subscription(peer_connection, signalling, sources, register)
            .await
        {
            Ok(mids) => Ok(mids),
            Err(e) => {
                stop_transceivers(added).await;
                Err(e)
            }
        }
    }

    /// The offer/answer half of `subscribe_cloudflare`, split out so its caller can roll the
    /// transceivers back on any failure without repeating the cleanup at each `?`.
    async fn negotiate_subscription<F>(
        &self,
        peer_connection: &Arc<RTCPeerConnection>,
        signalling: &Signalling,
        sources: &[(String, String)],
        register: F,
    ) -> Result<Vec<String>, String>
    where
        F: FnOnce(&[String]),
    {
        let offer = peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        peer_connection
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let local = peer_connection
            .local_description()
            .await
            .ok_or_else(|| "no local description for subscribe".to_string())?;

        let response = signalling
            .tracks_new_remote(
                &self.media_session_id,
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
        peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        eprintln!("[voice] answer applied for mid(s) {mids:?}");

        if response.requires_immediate_renegotiation {
            self.renegotiate(peer_connection, signalling).await?;
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
    /// Both its callers already hold it or cannot race: `subscribe_cloudflare` calls it through
    /// `negotiate_subscription` with the guard held, and `start_cloudflare` runs before the
    /// publication is shared with anything. A `tokio::sync::Mutex` is not reentrant, so locking here
    /// would deadlock the first subscribe Cloudflare asks to renegotiate immediately.
    ///
    /// Cloudflare only. LiveKit renegotiates from inside the room, on its own two connections, and
    /// never asks a publisher to re-offer for somebody else's subscription.
    async fn renegotiate(
        &self,
        peer_connection: &Arc<RTCPeerConnection>,
        signalling: &Signalling,
    ) -> Result<(), String> {
        let offer = peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        peer_connection
            .set_local_description(offer.clone())
            .await
            .map_err(|e| e.to_string())?;

        let response = signalling
            .renegotiate(
                &self.media_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: offer.sdp,
                },
                // Subscriptions and the SFU's own re-offers. Neither touches what this session
                // sends, so there is nothing to re-declare.
                None,
            )
            .await?;

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    /// Stop receiving the tracks behind `keys`, which are whatever [`Self::subscribe`] handed back.
    ///
    /// Synchronous and fire-and-forget on purpose. `voice_unsubscribe` is a synchronous Tauri
    /// command and `Engine::unpublish` runs while the engine mutex is held, so neither can await -
    /// and there is nothing to await *for*: the local source is dropped by the caller either way, so
    /// the worst a lost `UpdateSubscription` costs is bandwidth for a track nothing decodes. Making
    /// this async would push the mutex problem into every caller to buy a confirmation the protocol
    /// does not send anyway.
    ///
    /// A no-op on the Cloudflare arm, which is what it has always been: that transport has no
    /// per-track unsubscribe, and a Cloudflare session drops its pulls when it closes.
    pub fn unsubscribe_routes(&self, keys: &[String]) {
        let Transport::LiveKit { runtime, .. } = &self.transport else {
            return;
        };
        let Some(room) = self.transport.room() else {
            return;
        };
        if keys.is_empty() {
            return;
        }
        let keys = keys.to_vec();
        runtime.spawn(async move {
            for sid in keys {
                room.unsubscribe(&sid).await;
            }
        });
    }

    /// Close the track server-side and tear down the connection.
    ///
    /// Takes `&self` rather than `self` because the publication is shared: the writer task, the
    /// playout side and the command handles all hold it through an `Arc`.
    ///
    /// On the LiveKit arm this is a *release*, not a close: the room is shared with the screen
    /// publisher, and closing it because the microphone stopped would take a live screen share down
    /// with it. The registry decides - see [`release_room`].
    pub async fn stop(&self) {
        match &self.transport {
            Transport::LiveKit { registry_key, .. } => {
                // Taken first, so this whole arm runs exactly once. The registry counts holders,
                // and a second release for one acquire would decrement somebody else's - closing a
                // room out from under the screen share that is still publishing into it. The
                // Cloudflare arm is idempotent by accident; this one has to be on purpose.
                let Some(room) = self.transport.take_room() else {
                    return;
                };

                // The microphone leaves the room before the room is let go of, which matters only
                // in the case where it is *not* let go of: a screen share holding the same room
                // keeps the participant alive, and a track left published on it is a microphone
                // other people still see on a user who has left. The Cloudflare arm says the same
                // thing with `close_tracks`.
                if let Err(e) = room.unpublish(&[self.track_name.clone()]).await {
                    eprintln!("[voice] could not unpublish the microphone: {e}");
                }

                // Given up before the release, or the registry hands back a room this publication
                // is still holding a reference to and nothing can close it. See the field's note.
                drop(room);
                release_room(registry_key).await;
            }
            Transport::Cloudflare {
                peer_connection,
                signalling,
            } => {
                let _ = signalling
                    .close_tracks(&self.media_session_id, &[self.track_name.clone()])
                    .await;
                let _ = peer_connection.close().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subscription_asks_for_remote_tracks_only() {
        // The request shape is what the SFU validates, and getting it wrong fails only against the
        // real one - which is the most expensive place to find out. The `direction: subscribe` half
        // is now added by `Signalling` per dialect and pinned by its own tests.
        let tracks = subscription_tracks(&[
            ("sess-a".to_string(), "audio".to_string()),
            ("sess-b".to_string(), "screen-audio-x".to_string()),
        ]);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].session_id, "sess-a");
        assert_eq!(tracks[0].track_name, "audio");
        assert_eq!(tracks[1].session_id, "sess-b");
        assert_eq!(tracks[1].track_name, "screen-audio-x");
    }

    #[test]
    fn an_empty_subscription_asks_for_nothing() {
        assert!(subscription_tracks(&[]).is_empty());
    }

    /// Resolving a `(mediaSessionId, trackName)` pair to the SID LiveKit issued.
    ///
    /// The whole shape change between the two SFUs sits in this function, and every way of getting
    /// it wrong is silent: the wrong SID subscribes to somebody else, and no SID at all - if it were
    /// allowed to pass - is a participant who never makes a sound while every layer above reports a
    /// healthy subscription.
    mod livekit_track_ids {
        use super::*;
        use livekit_protocol as proto;

        fn track(sid: &str, name: &str, identity: &str) -> LiveKitTrack {
            LiveKitTrack {
                sid: sid.into(),
                track_name: name.into(),
                identity: identity.into(),
                user_id: crate::media::livekit::identity::user_of(identity).to_string(),
                kind: proto::TrackType::Audio,
            }
        }

        #[test]
        fn a_participants_microphone_resolves_by_their_user_id() {
            // What the roster actually carries for a primary connection: the bare user id.
            let known = [track("TR_a", "audio", "user_a")];
            assert_eq!(sid_for(&known, "user_a", "audio").as_deref(), Some("TR_a"));
        }

        #[test]
        fn an_unknown_pair_resolves_to_nothing_rather_than_the_first_track() {
            // Answering with anything here would subscribe to the wrong person. The caller turns
            // this `None` into an error, which is the only safe thing it can do.
            let known = [track("TR_a", "audio", "user_a")];
            assert!(sid_for(&known, "user_b", "audio").is_none());
            assert!(sid_for(&known, "user_a", "screen-audio-1").is_none());
            assert!(sid_for(&[], "user_a", "audio").is_none());
        }

        #[test]
        fn a_share_is_addressed_by_its_own_track_name() {
            // Voice and stream audio are separate sources with separate volumes, and they differ
            // only by track name on the same participant - so a match on the identity alone would
            // hand back whichever came first and cross the two.
            let known = [
                track("TR_a", "audio", "user_a"),
                track("TR_s", "screen-audio-share1", "user_a"),
            ];
            assert_eq!(
                sid_for(&known, "user_a", "screen-audio-share1").as_deref(),
                Some("TR_s")
            );
            assert_eq!(sid_for(&known, "user_a", "audio").as_deref(), Some("TR_a"));
        }

        #[test]
        fn a_secondary_connections_track_is_reachable_by_its_full_identity() {
            let known = [track("TR_v", "audio", "user_a#view")];
            assert_eq!(
                sid_for(&known, "user_a#view", "audio").as_deref(),
                Some("TR_v")
            );
        }

        #[test]
        fn an_exact_identity_beats_a_user_id_match() {
            // One user, two connections, both publishing a track called `audio`. A request naming
            // the secondary must never be served the primary's - they are different streams, and
            // the mix-up would be inaudible as a fault and audible as the wrong person.
            let known = [
                track("TR_p", "audio", "user_a"),
                track("TR_v", "audio", "user_a#view"),
            ];
            assert_eq!(
                sid_for(&known, "user_a#view", "audio").as_deref(),
                Some("TR_v")
            );
        }

        #[test]
        fn a_user_id_still_resolves_when_only_a_secondary_publishes_the_track() {
            // The roster names a user; which of their connections carries the track is the SFU's
            // business. Refusing here would leave them silent for the session.
            let known = [track("TR_v", "audio", "user_a#view")];
            assert_eq!(sid_for(&known, "user_a", "audio").as_deref(), Some("TR_v"));
        }
    }

    /// The LiveKit arm against a real server.
    ///
    /// `#[ignore]`d, like `media::livekit::room_tests`: they need a LiveKit server on
    /// `ws://127.0.0.1:7880` (`docker/livekit-dev/compose.yaml`). Everything these cover -
    /// acquiring, publishing, and above all the order in which the room is given back - is
    /// unreachable without one, and a test that asserted it against a mock would be asserting the
    /// mock.
    mod live_livekit {
        use super::*;
        use livekit_api::access_token::{AccessToken, VideoGrants};

        const DEV_URL: &str = "ws://127.0.0.1:7880";

        /// The dev-mode key pair, minted here rather than shared with `livekit::room_tests` because
        /// that module is private to its own crate path. Not a secret, and never reachable from a
        /// release build - a client does not sign its own join token.
        fn dev_token(room: &str, identity: &str) -> String {
            AccessToken::with_api_key("devkey", "secret")
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

        #[tokio::test]
        #[ignore = "needs a LiveKit server on ws://127.0.0.1:7880"]
        async fn the_microphone_publishes_into_a_livekit_room_and_carries_packets() {
            let key = "guild:test:mic";
            let publication = VoicePublication::start_livekit(
                key.to_string(),
                DEV_URL,
                &dev_token("test-mic", "user_a"),
            )
            .await
            .expect("the microphone must publish");

            // The same call the capture thread makes, on the same track the room handed back. This
            // is the whole point of the arm: everything above the transport is unchanged, so if
            // this writes, the pipeline writes.
            for _ in 0..10 {
                publication
                    .write_packet(bytes::Bytes::from_static(&[0xf8, 0xff, 0xfe]))
                    .await
                    .expect("a published track accepts samples");
            }
            assert_eq!(publication.stats.packets_sent.load(Ordering::Relaxed), 10);
            assert!(registry::is_held(key).await);

            publication.stop().await;
            assert!(
                !registry::is_held(key).await,
                "the last holder left and the room is still in the registry"
            );
        }

        /// The ordering rule the whole shared-room design rests on.
        ///
        /// The screen publisher holds the same room. Stopping the microphone must give this
        /// publication's reference up and hand the room back to the registry *without closing it* -
        /// closing it here would take a live screen share down with the microphone, which is the
        /// exact failure the registry exists to prevent.
        #[tokio::test]
        #[ignore = "needs a LiveKit server on ws://127.0.0.1:7880"]
        async fn stopping_the_microphone_leaves_a_room_another_holder_is_using() {
            let key = "guild:test:shared";
            let token = dev_token("test-shared", "user_b");

            // Stands in for the screen publisher, which acquires the same key.
            let other = registry::acquire(key, DEV_URL, &token)
                .await
                .expect("the first holder connects");

            let publication = VoicePublication::start_livekit(key.to_string(), DEV_URL, &token)
                .await
                .expect("the microphone joins the room already open");

            publication.stop().await;
            // Twice, because the teardown path is reachable twice - the writer task stops the
            // publication and a caller can drop it - and a second release would decrement a count
            // this publication does not own, closing the room under the share still using it.
            publication.stop().await;
            assert!(
                registry::is_held(key).await,
                "the microphone closed a room the screen share was still publishing into"
            );
            // The room outliving the microphone is only right if the microphone actually left it.
            // A track still on the participant is a user other people see as unmuted after they
            // have gone - and it is invisible from this side, because nothing here is sending on it.
            assert!(
                other.local_track(TRACK_NAME).await.is_none(),
                "the microphone track is still published on a room the user has left"
            );
            // Still *held* only says the registry row survived. This says the connection did: a
            // closed peer connection reports `Closed` here, and that is what a share left holding a
            // dead room would see.
            assert_ne!(
                other.publisher_state(),
                RTCPeerConnectionState::Closed,
                "the room's publisher connection was closed under the other holder"
            );

            drop(other);
            release_room(key).await;
            assert!(!registry::is_held(key).await);
        }
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
