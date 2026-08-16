//! The transport half of the Rust screen publisher: one H.264 simulcast ladder and, when the user
//! shares their sound, one Opus track - published into the LiveKit room the microphone is already on.
//!
//! Frames arrive already encoded from [`super::encoder`]; this module owns the publication and the
//! RTP packetisation and knows nothing about capture.
//!
//! # There is no Cloudflare path here any more
//!
//! `start_screen_publish` has only ever accepted a guild channel or a DM call, and Isle never screen
//! shares - so unlike `media::voice` this side has no second dialect to branch on. The Cloudflare
//! half is deleted rather than kept behind a transport switch: a branch nothing can reach is a
//! branch nothing tests.
//!
//! # The room is shared, and that is the whole point
//!
//! [`crate::media::livekit::registry`] hands back the connection the microphone almost always
//! already holds, so the share publishes on the *same participant*. A second connection would be a
//! second identity, which is exactly the case `VoiceShareSnapshot.mediaSessionId` exists to
//! disambiguate - and desktop now stops producing it. See the migration spec §2.1.
//!
//! # Nothing in here negotiates
//!
//! [`crate::media::livekit::room::Room`] owns every offer. This module reads RTCP off the publishing
//! connection and writes samples to tracks; a second negotiator would interleave with the room's own
//! offer, and the first answer would then apply to an SDP that no longer matches. The only thing it
//! does about negotiation is *wait* for it - see [`await_stable`].
//!
//! # A renegotiation over a live ladder corrupts it
//!
//! `webrtc-rs` 0.14 writes the rid and simulcast attributes of an *existing* video m-line twice on
//! every subsequent offer - once from the rid map it parsed out of the last answer and once from the
//! sender's own encodings (`peer_connection/sdp/mod.rs`). The offer then carries
//! `a=simulcast:send f;h;q` twice and LiveKit answers `a=simulcast:recv f;h;q;f;h;q`, after which the
//! video track is gone from the participant: accepted, given a SID, and in nobody's roster.
//!
//! [`Publication::start`] avoids it for its own two halves by publishing the ladder **last**. It
//! cannot avoid it for the room at large: anything that publishes or unpublishes on this connection
//! afterwards - the microphone arriving late, or leaving - re-offers over the ladder and breaks a
//! share that is already running. Closing that needs `Room` to stop re-deriving the rid map from the
//! answer, and is not this module's to fix.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use livekit_protocol as proto;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::signaling_state::RTCSignalingState;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTCRtpHeaderExtensionCapability, RTPCodecType,
};
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::simulcast::Layer;
use crate::media::livekit::registry;
use crate::media::livekit::room::Room;

/// One ICE server, mirroring the browser's `RTCIceServer`.
///
/// Credentials travel with the URLs rather than being dropped: `webrtc-rs` validates the
/// configuration up front and refuses a `turn:` URL with no credentials, where a browser accepts
/// the same config and only fails later when TURN authentication is actually attempted.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// High profile, Level 5.2, non-interleaved: what a screen share is published as.
///
/// **The level is the half that was a bug.** This used to declare `42001f` - Baseline *Level 3.1*,
/// whose formal ceiling is 1280x720 (3600 macroblocks a frame). Every resolution above 720p that
/// this app offers exceeded it: 1080p by 2.3x, 1440p by 4x, 2160p by 9x. It worked only because
/// decoders in practice size themselves from the SPS in the bitstream rather than from the
/// negotiated level, so a receiver that honoured the declaration was entitled to allocate a
/// 720p decoder or refuse the stream outright. `0x34` = 52 = Level 5.2, which is the first level
/// that actually covers 2160p60 - 5.0 stops short of 1440p60 and 5.1 of 4K60.
///
/// **The profile is the half that buys quality.** High (`0x64`) brings CABAC and the 8x8 transform,
/// which are precisely what sharp text edges cost the most bits without. Worth roughly 10-20%
/// BD-rate on screen content.
///
/// Declaring *more* than we send is the safe direction - a receiver allocates for the ceiling and
/// is never surprised - which is why the level is pinned at the top of the range rather than
/// computed per share.
///
/// Public, and used by `super::e2e_tests` rather than copied there - see [`publisher_api`] for why
/// a copy is the wrong shape.
pub fn h264_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90_000,
        sdp_fmtp_line: H264_HIGH_5_2_FMTP.to_owned(),
        ..Default::default()
    }
}

/// The fmtp line for H.264 High at Level 5.2, and the **only** High entry [`publisher_api`]
/// registers.
///
/// `0x34` = 52 = Level 5.2, which is what makes 1440p60 conformant. Level 5.0 - `640032`, what the
/// webrtc-rs defaults offer - covers 1440p**30** and stops there; 5.1 stops short of 4K60.
///
/// **Constrained High (`640c34`) was tried and measured worse, twice over.** The Media Foundation
/// encoder accepts `UCConstrainedHigh` and then fails mid-encode, silently costing the hardware
/// encoder for the whole session; and `livekit-server` 1.13.5 appears to drop `640c34` from the
/// answer where it keeps `640034`.
///
/// That leaves a real open problem rather than a solved one. libwebrtc matches H.264 by profile
/// *equality*, and mobile hardware commonly advertises Constrained High or Constrained Baseline and
/// no plain High at all - so a phone will not select this entry. It is expected to negotiate down to
/// one of the Constrained Baseline entries registered beside it, which is why those are kept.
const H264_HIGH_5_2_FMTP: &str =
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034";

/// The payload type the webrtc-rs defaults use for H.264 High.
///
/// Deliberately *that* number rather than a free one. [`publisher_api`] curates the codec list
/// rather than extending the defaults, so this is the only High entry that exists - reusing its
/// payload type keeps the offer the same shape as a default one, and is what stops the SFU
/// answering two High entries onto a single payload type.
const H264_HIGH_5_2_PAYLOAD_TYPE: u8 = 123;

/// How long to wait for the room to finish a negotiation before giving up on the publish.
///
/// One round trip to the SFU plus ICE gathering, which is what `Room::negotiate` blocks on. The same
/// five seconds `Room::PUBLISH_TIMEOUT` allows, for the same reason: past it the answer is not late,
/// it is not coming.
const NEGOTIATION_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

/// The API every publishing peer connection is built from.
///
/// Public, and used by `super::e2e_tests` rather than copied there. Which codecs and interceptors
/// are registered is precisely what decides whether an inbound stream can be matched to a
/// transceiver at all, so a test that builds its own media engine tests its own media engine - and
/// a copy that drifts from this one passes while no viewer sees a picture.
pub fn publisher_api() -> Result<webrtc::api::API, String> {
    let mut media_engine = MediaEngine::default();

    // **Curated, not `register_default_codecs()` plus an extra entry**, and the difference is the
    // whole of 2K support.
    //
    // The defaults register H.264 High **5.0** (`640032`) on payload type 123. Adding our High 5.2
    // (`640034`) on a payload type of its own left the offer carrying *two* High entries, and
    // `livekit-server` answers both onto one payload type - `m=video ... 123 123`, with two
    // conflicting `a=fmtp:123` lines. A receiver then picks one arbitrarily, and picking 5.0 makes
    // 1440p60 non-conformant, which is exactly the resolution this exists to allow. Measured, in
    // `offer_shape::report_the_h264_entries_in_a_publishing_offer`.
    //
    // Registering 5.2 on 123 instead does not work either: `register_codec` silently ignores a
    // payload type already taken, so the offer comes back with 5.0 and our entry simply absent.
    // Also measured.
    //
    // So the list is built here. Only what this connection actually publishes is registered -
    // Opus for the microphone and a share's own sound, H.264 for the picture - and High 5.2 is the
    // *only* High entry, on the payload type the defaults used for High 5.0. Nothing collides,
    // nothing is silently dropped, and the Constrained Baseline entries stay so a receiver that
    // takes no High still negotiates.
    //
    // VP8, VP9, AV1 and HEVC are deliberately absent: this peer connection only ever sends, and it
    // only ever sends H.264. The *subscriber* connection is built from `voice_api`, which keeps the
    // full default set, so nothing about what we can receive changes.
    //
    // `register_default_codecs` registers no RTX entries at all, so curating loses none.
    let video_feedback = vec![
        RTCPFeedback {
            typ: "goog-remb".to_owned(),
            parameter: String::new(),
        },
        RTCPFeedback {
            typ: "ccm".to_owned(),
            parameter: "fir".to_owned(),
        },
        RTCPFeedback {
            typ: "nack".to_owned(),
            parameter: String::new(),
        },
        // How a viewer asks for the keyframe it needs in order to start decoding at all.
        RTCPFeedback {
            typ: "nack".to_owned(),
            parameter: "pli".to_owned(),
        },
    ];

    media_engine
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48_000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        )
        .map_err(|e| format!("could not register Opus: {e}"))?;

    // The Constrained Baseline rungs, verbatim from the defaults including their payload types.
    // Kept because they are what a receiver that will not take High negotiates down to - and on
    // mobile that is most of them, since Android hardware commonly advertises Constrained Baseline
    // and nothing else.
    for (payload_type, fmtp) in [
        (102u8, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"),
        (127, "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f"),
        (125, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"),
        (108, "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f"),
    ] {
        media_engine
            .register_codec(
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_H264.to_owned(),
                        clock_rate: 90_000,
                        channels: 0,
                        sdp_fmtp_line: fmtp.to_owned(),
                        rtcp_feedback: video_feedback.clone(),
                    },
                    payload_type,
                    ..Default::default()
                },
                RTPCodecType::Video,
            )
            .map_err(|e| format!("could not register H.264 {payload_type}: {e}"))?;
    }

    media_engine
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    clock_rate: 90_000,
                    channels: 0,
                    sdp_fmtp_line: H264_HIGH_5_2_FMTP.to_owned(),
                    rtcp_feedback: video_feedback.clone(),
                },
                payload_type: H264_HIGH_5_2_PAYLOAD_TYPE,
                ..Default::default()
            },
            RTPCodecType::Video,
        )
        .map_err(|e| format!("could not register H.264 High 5.2: {e}"))?;

    // What makes a simulcast layer identifiable on the wire, and the one piece `a=rid:` does not
    // imply.
    //
    // The rid and simulcast attributes describe what the sender *intends* to publish. What tells the
    // SFU which layer a packet belongs to is `sdes:rtp-stream-id` in the RTP header, and
    // `TrackLocalStaticRTP::bind` stamps it only when the URI is among the negotiated extensions -
    // when it is absent it writes no rid and reports no error. `register_default_codecs` does not
    // register these, so without this every layer left on one untagged SSRC: the offer advertised
    // three encodings, the SFU accepted and echoed all three, and no viewer ever received a
    // decodable layer. The tile loads forever rather than failing, which is why nothing upstream
    // catches it.
    //
    // `mid` is registered alongside deliberately: a stream id is only meaningful within an m-line,
    // so both are needed to place a packet. webrtc-rs refuses *inbound* simulcast when either is
    // missing (`ErrPeerConnSimulcastStreamIDRTPExtensionRequired`) - outbound has no such guard,
    // which is exactly why this was silent.
    //
    // Video only: no audio path here carries layers, and an extension registered for audio would
    // spend one of the limited extension ids for nothing.
    for uri in [
        webrtc::sdp::extmap::SDES_MID_URI,
        webrtc::sdp::extmap::SDES_RTP_STREAM_ID_URI,
    ] {
        media_engine
            .register_header_extension(
                RTCRtpHeaderExtensionCapability {
                    uri: uri.to_owned(),
                },
                RTPCodecType::Video,
                None,
            )
            .map_err(|e| format!("could not register the {uri} header extension: {e}"))?;
    }

    let mut registry = Registry::new();
    registry =
        register_default_interceptors(registry, &mut media_engine).map_err(|e| e.to_string())?;

    Ok(APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build())
}

/// Log the lines of `sdp` that decide whether simulcast is real, tagged with the publication.
///
/// `a=rid:` and `a=simulcast:` are the ladder itself. `m=` is carried because a rid list means
/// nothing without knowing which m-line it landed on, and because an answer that renegotiated the
/// video section down to one encoding shows up here and nowhere else. `a=mid:` pairs the two, since
/// the mid is what the SFU is told to publish under.
///
/// A count rather than silence when there is nothing to print: "no rid lines in the answer" is
/// itself the finding, and an absent log reads as an absent code path.
fn log_simulcast_sdp(id: u64, which: &str, sdp: &str) {
    let lines: Vec<&str> = sdp
        .lines()
        .map(str::trim)
        .filter(|line| {
            line.starts_with("m=")
                || line.starts_with("a=mid:")
                || line.starts_with("a=rid:")
                || line.starts_with("a=simulcast:")
                // H.264 only. Which profile and level survived negotiation decides what the
                // encoder may emit: a bitstream above the level the answer kept is the black-tile
                // failure, and it is invisible from this side without this line.
                || (line.starts_with("a=fmtp:") && line.contains("profile-level-id"))
        })
        .collect();

    eprintln!(
        "[publisher] publication {id}: {which} has {} rid line(s), {} simulcast line(s)",
        lines.iter().filter(|l| l.starts_with("a=rid:")).count(),
        lines
            .iter()
            .filter(|l| l.starts_with("a=simulcast:"))
            .count(),
    );
    for line in lines {
        eprintln!("[publisher]   {which}: {line}");
    }
}

/// Pull the `profile-level-id` out of an `a=fmtp:` line, if one is there.
///
/// The same filter `log_simulcast_sdp` applies before printing this value, reused rather than
/// duplicated: an `a=fmtp:` line naming `profile-level-id` is the only place this ever lives, and a
/// second parser drifting from the first would read a different line than the log did.
fn profile_level_id_in(sdp: &str) -> Option<String> {
    sdp.lines()
        .map(str::trim)
        .find(|line| line.starts_with("a=fmtp:") && line.contains("profile-level-id"))
        .and_then(|line| {
            line.split(';')
                .find(|p| p.trim_start().starts_with("profile-level-id="))
                .and_then(|p| p.split('=').nth(1))
                .map(|v| v.trim().to_string())
        })
}

/// Where encoded frames go once they leave the pump.
///
/// A trait rather than a bare [`Publication`] so the writer loop's failure handling can be driven
/// directly. The behaviour it guards - a burst of failed writes is survived, a genuinely dead
/// connection is not encoded into forever - is reachable no other way: the failure it exists for is
/// a full UDP send queue, which cannot be provoked from outside the socket.
///
/// Generic rather than `dyn`, so async fn in trait is enough and no `async-trait` is needed.
/// `Sync` because the futures are taken from `&self` and have to cross the writer task's threads.
pub trait FrameSink: Send + Sync + 'static {
    /// Hand one encoded access unit to the transport.
    fn write_frame(
        &self,
        data: Vec<u8>,
        duration: Duration,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    /// Tear the transport down. Consumes the sink: nothing may be written afterwards.
    fn stop(self) -> impl std::future::Future<Output = ()> + Send;
}

/// A live publication: the room it sits on, the tracks being fed, and the names other clients need
/// in order to subscribe.
pub struct Publication {
    /// The shared room. Held rather than borrowed because this struct is moved into the writer task
    /// and outlives every other reference to it in `session::start`.
    room: Arc<Room>,
    /// The registry key the room was acquired under, so teardown can let go of exactly what it took.
    room_key: String,
    /// The simulcast layers, highest first. Index 0 is rid `f` and is what every non-simulcast path
    /// in this file means when it says "the track": it carries the `FrameSink` writes and its
    /// failure is the share's failure. One element is the pre-simulcast publication.
    tracks: Vec<Arc<TrackLocalStaticSample>>,
    /// Set when a viewer asks for a keyframe over RTCP, cleared when the encoder produces one.
    ///
    /// A flag rather than a channel because the request is idempotent: ten viewers asking at once,
    /// or one viewer asking ten times while a frame is in flight, all want the same single IDR.
    keyframe_wanted: Arc<AtomicBool>,
    /// The server's id for the video track, issued on `TrackPublishedResponse`.
    ///
    /// Diagnostics only: the roster is what tells a viewer which SID to subscribe to, and this side
    /// never sends it anywhere. It is logged because a publish that returned without one is a
    /// publish the SFU never confirmed, and that is otherwise indistinguishable from a slow one.
    pub video_sid: String,
    pub track_name: String,
    /// The Opus track carrying the share's own sound, when the user chose to share it.
    ///
    /// Optional rather than always-present: a share without audio must not publish an empty track,
    /// or every viewer opens a decoder and a mixer slot for silence that will never arrive.
    audio_track: Option<Arc<TrackLocalStaticSample>>,
    pub audio_track_name: Option<String>,
    /// The `profile-level-id` the answer kept, if the answer named one.
    ///
    /// <p>Already parsed for the log and then discarded. Which profile and level survived
    /// negotiation decides what the encoder may legally emit, and a bitstream above the level the
    /// answer kept is the black-tile failure - invisible from this side without this.</p>
    pub profile_level_id: Option<String>,
}

impl Publication {
    /// The Opus track to feed, when this share carries audio.
    ///
    /// Handed out as the track rather than written through `&self`, for the same reason
    /// [`Self::keyframe_requests`] is: the publication is moved into the video writer task, and the
    /// audio writer is a separate task that never holds it.
    pub fn audio_track(&self) -> Option<Arc<TrackLocalStaticSample>> {
        self.audio_track.clone()
    }

    /// A handle to the viewers' keyframe requests, for the capture thread to consume.
    ///
    /// Handed out as the shared flag rather than read through `&self`, because the publication
    /// itself is moved into the writer task while the encoder lives on the capture thread - the two
    /// halves that need this never hold the same object.
    pub fn keyframe_requests(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.keyframe_wanted)
    }

    /// The publishing connection, for whoever needs to read its statistics.
    ///
    /// <p>Handed out exactly like [`Self::keyframe_requests`] and [`Self::audio_track`], and taken
    /// at the same point in `session::start`: this struct is moved into the writer task, so after
    /// that moment nothing else can reach it.</p>
    ///
    /// <p><b>Shared with the microphone now.</b> `get_stats()` on it reports every outbound stream
    /// the participant has, not just this share's - which is harmless for `publish_stats` only
    /// because the ladder is the sole *video* publication on it, and the mic and the share's audio
    /// are filtered out by kind. A camera published from Rust would break that assumption; it is
    /// published from the webview's own room, and that is one of the reasons why.</p>
    pub fn peer_connection(&self) -> Arc<webrtc::peer_connection::RTCPeerConnection> {
        self.room.publisher_connection()
    }

    /// The `profile-level-id` the answer kept, if the answer named one.
    ///
    /// <p>Which profile and level survived negotiation decides what the encoder may legally emit,
    /// and a bitstream above the level the answer kept is the black-tile failure - invisible from
    /// this side without this.</p>
    pub fn profile_level_id(&self) -> Option<String> {
        self.profile_level_id.clone()
    }

    /// The layer tracks, highest first. Index 0 is rid `a`.
    ///
    /// Handed out for the same reason [`Self::audio_track`] is: the publication is moved into the
    /// top layer's writer task, and the lower layers' writers are separate tasks that never hold
    /// it.
    pub fn layer_tracks(&self) -> Vec<Arc<TrackLocalStaticSample>> {
        self.tracks.clone()
    }

    /// Hand one encoded access unit to a specific layer's packetiser.
    ///
    /// Free-standing rather than part of [`FrameSink`] because the lower layers have no say in the
    /// publication's lifetime - only the top layer's writer may end the share, and `FrameSink`
    /// carries `stop`.
    pub async fn write_layer(
        track: &Arc<TrackLocalStaticSample>,
        data: Vec<u8>,
        duration: Duration,
    ) -> Result<(), String> {
        track
            .write_sample(&Sample {
                data: data.into(),
                timestamp: SystemTime::now(),
                duration,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())
    }

    /// Publish `screen-<share_id>` as a simulcast ladder on the shared room.
    ///
    /// `layers` is the ladder an encoder was actually built for, highest rung first - not the one
    /// the geometry could support. A rid advertised with no encoder behind it is a layer the SFU
    /// will select and then find empty, which is a tile that loads forever rather than a tile that
    /// fails, so `session::start` truncates the ladder to the encoders it got and this publishes
    /// exactly that.
    ///
    /// `with_audio` adds `screen-audio-<share_id>` under `TrackSource::ScreenShareAudio`, so a
    /// client that groups by source does not read the share's own sound as a second person talking.
    ///
    /// # Two round trips, not one, and audio before video
    ///
    /// The Cloudflare path published both halves in a single offer, deliberately: a viewer that
    /// learns of the video first builds the tile, and audio then arrives against a share it has
    /// already finished laying out. `Room::publish_video` and `Room::publish_audio_as` each
    /// negotiate on their own, so **a share with audio now costs two offers** and its halves are
    /// announced separately. Batching them needs a publish-many entry point on `Room`, which is not
    /// this module's to add.
    ///
    /// Two things follow, and both are load-bearing rather than tidy-up:
    ///
    /// 1. Each offer must wait for the previous answer, or the answer applies to an SDP that no
    ///    longer matches. See [`await_stable`], which also carries the mid-collision this prevents.
    /// 2. The ladder goes in the **last** negotiation, because `webrtc-rs` corrupts a simulcast
    ///    m-line it re-offers. See the comment at the call site.
    pub async fn start(
        room: Arc<Room>,
        room_key: String,
        share_id: &str,
        layers: &[Layer],
        with_audio: bool,
    ) -> Result<Self, String> {
        // Which publication a line belongs to. Every `[publisher]` line looked alike, so two
        // overlapping shares - or one that was torn down while its replacement was starting - read
        // as a single publication doing something impossible: publishing, then closing, then
        // connecting. That is two publications interleaved, and nothing in the log said so.
        //
        // It matters more now, not less. The share rides on a connection it neither owns nor opened
        // and shares with the microphone, so this number is the only thing in the log separating a
        // share that is starting from one that is going away on the very same room.
        static NEXT_PUBLICATION: AtomicU64 = AtomicU64::new(1);
        let id = NEXT_PUBLICATION.fetch_add(1, Ordering::Relaxed);
        eprintln!("[publisher] publication {id}: starting for share {share_id} on room {room_key}");

        let track_name = format!("screen-{share_id}");

        // `(rid, width, height)`, highest rung first, which is the order `Room::publish_video` maps
        // onto `VideoQuality::High`/`Medium`/`Low`. The server never reads the rid strings as an
        // ordering - it reads the `layers` list - but the list's order *is* the ranking, so a ladder
        // handed over out of order would declare the quarter rung as the high one.
        let wire_layers: Vec<(&str, u32, u32)> = layers
            .iter()
            .map(|layer| (layer.rid, layer.spec.width, layer.spec.height))
            .collect();

        // **Before the first publish, not only between the two halves.** The microphone publishes on
        // this same connection and does not wait for its own answer, so a share starting moments
        // after a join arrives with an offer still outstanding. That is not just a lost
        // renegotiation: `webrtc-rs` numbers a new transceiver from the greatest mid it has seen in
        // the *current remote description*, and the m-line for the mandatory data channels is not
        // counted there - so with the answer still in flight the video is handed the data channel's
        // mid. Two m-lines under one mid, the SFU keeps whichever it resolves last, and the share
        // simply never appears in anybody's roster. Measured, not theorised.
        await_stable(&room, id, "an earlier publication on this room").await?;

        // **Audio first, video last.** The Cloudflare publish put the video first in its `tracks`
        // array; this is the opposite order and it is not a preference.
        //
        // `webrtc-rs` 0.14 writes the rid and simulcast attributes of an *existing* video m-line
        // twice on every subsequent offer: once from the rid map it parsed out of the last answer,
        // and once from the sender's own encodings (`sdp/mod.rs`, the `rid_map` block and the
        // `encodings.len() > 1` block). The result is `a=simulcast:recv f;h;q;f;h;q`, and LiveKit
        // answers it by dropping the video track from the participant entirely - the share is
        // accepted, gets a SID, and then appears in nobody's roster. Measured against
        // `livekit-server` 1.13.5; the test that caught it is
        // `the_share_publishes_on_the_participant_the_microphone_is_on`.
        //
        // Publishing the ladder in the *last* negotiation of the share means nothing renegotiates
        // over it. That closes this publication's own two-step; it does not close the general case -
        // anything that offers again later on this connection corrupts a live ladder the same way.
        // See the module docs and the report that accompanied this change.
        let audio_track_name = with_audio.then(|| format!("screen-audio-{share_id}"));
        if let Some(name) = &audio_track_name {
            // `ScreenShareAudio`, never `Microphone`. The track *name* carries the pairing, but the
            // source is what tells a client the kind before it has parsed a name - and a share's own
            // sound announced as a microphone is a second person talking in every roster that
            // groups by source.
            let audio = room
                .publish_audio_as(name, proto::TrackSource::ScreenShareAudio)
                .await?;
            eprintln!("[publisher] publication {id}: {name} accepted as {}", audio.sid);
            // Waiting for the answer is not politeness: `create_offer` on a connection still in
            // `have-local-offer` builds an SDP the outstanding answer no longer matches, and the
            // publish that was already accepted then dies on a description nothing can apply.
            await_stable(&room, id, "the audio half").await?;
        }

        let video = room.publish_video(&track_name, &wire_layers).await?;
        eprintln!(
            "[publisher] publication {id}: {track_name} accepted as {} ({} layer(s))",
            video.sid,
            wire_layers.len()
        );
        await_stable(&room, id, "the publish").await?;

        // Ordered, highest first. A short ladder is a failed publish and not a share with fewer
        // rungs: everything downstream indexes rung 0 as "the track" and pairs the rest against the
        // encoders that were already built, so a mismatch here would silently write one layer's
        // frames into another layer's packetiser.
        let tracks = room.local_ladder(&track_name).await;
        if tracks.len() != wire_layers.len() {
            return Err(format!(
                "published {} of {} layer(s) for {track_name}",
                tracks.len(),
                wire_layers.len()
            ));
        }

        let audio_track = match &audio_track_name {
            Some(name) => Some(
                room.local_track(name)
                    .await
                    .ok_or_else(|| format!("{name} was published but has no writable track"))?,
            ),
            None => None,
        };

        // RTCP has to be drained or the sender's buffers fill and stall the track - but *what* is in
        // it matters, and until this existed none of it was read.
        //
        // A WebRTC receiver cannot decode anything until it has a keyframe, and the way it asks for
        // one is an RTCP Picture Loss Indication. Discarding those means a viewer who joins after a
        // share began waits for whatever periodic IDR the encoder happens to emit - and a viewer who
        // loses a packet stays frozen or smeared until then, rather than recovering on request.
        //
        // `read_rtcp` rather than `read`: the same drain, already parsed. Read off the room's
        // publishing connection and nothing else - see `Room::publisher_connection`, which is handed
        // out for exactly this and must never be negotiated on.
        let keyframe_wanted = Arc::new(AtomicBool::new(false));
        let video_sender = sender_for(&room, &track_name)
            .await
            .ok_or_else(|| format!("no sender for {track_name} on the publishing connection"))?;
        let rtcp_keyframe_wanted = Arc::clone(&keyframe_wanted);
        tokio::spawn(async move {
            while let Ok((packets, _)) = video_sender.read_rtcp().await {
                for packet in packets {
                    // Both mean "send me a keyframe". PLI is what browsers send; FIR is the older
                    // request and some SFUs still relay it, so honour either.
                    let wants_keyframe = packet
                        .as_any()
                        .downcast_ref::<PictureLossIndication>()
                        .is_some()
                        || packet.as_any().downcast_ref::<FullIntraRequest>().is_some();
                    if wants_keyframe {
                        rtcp_keyframe_wanted.store(true, Ordering::Relaxed);
                    }
                }
            }
        });

        // Drained and discarded. Unlike the video sender there is nothing to act on - audio has no
        // keyframes - but an undrained sender fills its buffers and stalls the track.
        if let Some(name) = &audio_track_name {
            match sender_for(&room, name).await {
                Some(sender) => {
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 1500];
                        while sender.read(&mut buf).await.is_ok() {}
                    });
                }
                // Not fatal, and worth saying out loud: the share sound stalls rather than fails,
                // which is the shape of bug that gets reported as "audio cut out after a minute".
                None => eprintln!("[publisher] publication {id}: no sender to drain for {name}"),
            }
        }

        // What the ladder looks like on the wire, offered and answered.
        //
        // Accepting the publish and honouring the ladder are different things, and only the first
        // was ever observable: a `TrackPublishedResponse` says the SFU took the track, not that it
        // understood three encodings. If the answer carries no rid or simulcast attribute back, the
        // layers exist on this side only - every viewer is then pulling a track the SFU thinks has
        // one encoding, which loads forever rather than failing.
        //
        // Both descriptions now cover the whole participant, microphone included, so the m-line
        // count is no longer the ladder's. The rid and simulcast counts still are.
        match room.local_sdp().await {
            Some(sdp) => log_simulcast_sdp(id, "offer", &sdp),
            None => eprintln!("[publisher] publication {id}: no local description to read"),
        }
        let answer = room.remote_sdp().await;
        match &answer {
            Some(sdp) => log_simulcast_sdp(id, "answer", sdp),
            // Accepted, with no answer applied. `TrackPublishedResponse` can arrive before the
            // `Answer` (migration spec §7), and `await_stable` above is what closes that window -
            // so reaching here means it did not, and the profile below is read off nothing.
            None => eprintln!("[publisher] publication {id}: accepted with no answer applied"),
        }
        // Captured here rather than only logged: the negotiated profile and level decide what the
        // encoder may legally emit, and a black tile from a level mismatch is otherwise invisible
        // from this side.
        let profile_level_id = answer.as_deref().and_then(profile_level_id_in);

        Ok(Self {
            room,
            room_key,
            tracks,
            keyframe_wanted,
            video_sid: video.sid,
            track_name,
            audio_track,
            audio_track_name,
            profile_level_id,
        })
    }
}

impl FrameSink for Publication {
    /// Hand one encoded access unit to the packetiser.
    async fn write_frame(&self, data: Vec<u8>, duration: Duration) -> Result<(), String> {
        self.tracks[0]
            .write_sample(&Sample {
                data: data.into(),
                timestamp: SystemTime::now(),
                duration,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())
    }

    /// Unpublish both halves and let go of the room.
    ///
    /// Both halves go in one `unpublish` call. Closing only the video would leave viewers holding a
    /// live audio track from a share that no longer exists - silent, but still subscribed, still
    /// mixed, and still counted against the sharer's egress. Unlike publishing, `Room::unpublish`
    /// takes the whole list and offers once, so this really is one round trip.
    ///
    /// **The connection is not closed here unless we are the last one out.** The microphone is
    /// almost always the other holder and its lifetime is the room membership; closing the room
    /// because a share ended would drop the call.
    async fn stop(self) {
        let mut names = vec![self.track_name.clone()];
        if let Some(audio) = &self.audio_track_name {
            names.push(audio.clone());
        }
        // Named by track rather than by publication number, which this does not carry - it is enough
        // to pair with the "accepted as" line from `start` and say which one went away. A teardown
        // landing *after* its replacement has started is the interleaving that made the states look
        // impossible, and it can only be read off the log if the close says so too.
        eprintln!(
            "[publisher] unpublishing from room {}: {}",
            self.room_key,
            names.join(", ")
        );

        let Publication { room, room_key, .. } = self;
        if let Err(e) = room.unpublish(&names).await {
            eprintln!("[publisher] could not unpublish {}: {e}", names.join(", "));
        }
        // Ours before the registry is asked, or `release` can never be the last holder and the room
        // is kept alive by the very publication that is going away.
        drop(room);
        release_room(&room_key).await;
    }
}

/// Let go of a room acquired from the registry, closing it if this was the last holder.
///
/// A room handed back is one nobody else is using, and a caller that merely drops it leaks the
/// signal connection and both peer connections until the process ends - which is why `release` is
/// `#[must_use]`. Kept here rather than inlined because two paths need it: an ordinary teardown,
/// and `start_screen_publish` failing after it has already acquired.
pub async fn release_room(key: &str) {
    let Some(room) = registry::release(key).await else {
        return;
    };
    match Arc::try_unwrap(room) {
        Ok(room) => {
            eprintln!("[publisher] closing room {key}: last holder out");
            room.close().await;
        }
        // The registry says nobody holds it and an `Arc` says somebody does, which is a bookkeeping
        // disagreement rather than a media fault - so it is logged rather than fatal. What it costs
        // is the connection staying open for the rest of the session.
        Err(room) => eprintln!(
            "[publisher] room {key} was released but {} reference(s) outlive the registry; \
             its connection stays open",
            Arc::strong_count(&room)
        ),
    }
}

/// Wait for the publishing connection to finish the negotiation it is in the middle of.
///
/// `Room` sends an offer per publication and applies the answer on its event pump, so there is a
/// window after any publish where the connection is in `have-local-offer` with an answer still in
/// flight. Anything that offers again inside that window overwrites the local description the
/// outstanding answer was generated against, and both negotiations then fail - the same interleaving
/// `Room::publisher_connection` warns about, reached from the other direction.
///
/// Polled rather than signalled because `Room` exposes the state and not an event, and 20 ms is well
/// under the round trip this is waiting on.
async fn await_stable(room: &Room, id: u64, what: &str) -> Result<(), String> {
    let publisher = room.publisher_connection();
    let deadline = tokio::time::Instant::now() + NEGOTIATION_SETTLE_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if publisher.signaling_state() == RTCSignalingState::Stable {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Distinctly worded from a publish timeout: this is an answer that never arrived, not a request
    // that was refused, and the two want different things looked at.
    Err(format!(
        "[publisher] publication {id}: {what} was never answered - the connection is still {}",
        publisher.signaling_state()
    ))
}

/// The sender carrying a named local track on the room's publishing connection.
///
/// Looked up rather than kept from the publish, because `Room` owns `add_track` and hands back a
/// `Publication` rather than an `RTCRtpSender`. The lookup is by track id, which is the track *name*
/// for everything this module publishes - including every rung of a ladder, since simulcast layers
/// share one id and differ only by rid.
async fn sender_for(room: &Room, track_id: &str) -> Option<Arc<RTCRtpSender>> {
    for sender in room.publisher_connection().get_senders().await {
        if let Some(track) = sender.track().await {
            if track.id() == track_id {
                return Some(sender);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_profile_level_id_the_answer_kept() {
        let sdp = "m=video 9 UDP/TLS/RTP/SAVPF 102\r\n\
                   a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";

        assert_eq!(profile_level_id_in(sdp).as_deref(), Some("42e01f"));
    }

    #[test]
    fn answers_none_when_the_answer_names_no_profile() {
        assert_eq!(profile_level_id_in("m=video 9 UDP/TLS/RTP/SAVPF 102\r\n"), None);
    }
}

#[cfg(test)]
mod offer_shape {
    use super::*;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
    use webrtc::track::track_local::TrackLocal;

    /// Prints every H.264 entry our publishing offer actually carries.
    ///
    /// The question this answers: we register High 5.2 on our own payload type *in addition to* the
    /// High 5.0 that `register_default_codecs` provides, so the offer carries two High entries. The
    /// SFU then answers both onto one payload type - `m=video ... 123 123`, with two conflicting
    /// `a=fmtp:123` lines - and a receiver has to pick one arbitrarily. For 2K that ambiguity is the
    /// whole problem: picking `640032` (Level 5.0) makes 1440p60 non-conformant.
    #[tokio::test]
    async fn report_the_h264_entries_in_a_publishing_offer() {
        let api = publisher_api().expect("publisher api");
        let pc = api
            .new_peer_connection(RTCConfiguration::default())
            .await
            .expect("peer connection");

        let track = Arc::new(TrackLocalStaticSample::new(
            h264_capability(),
            "video".to_owned(),
            "screen-test".to_owned(),
        ));
        pc.add_track(track as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .expect("add track");

        let offer = pc.create_offer(None).await.expect("offer");
        for line in offer.sdp.lines() {
            if line.starts_with("m=video") || line.contains("profile-level-id") {
                println!("OFFER {line}");
            }
        }
        let _ = pc.close().await;
    }
}
