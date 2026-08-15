//! A `webrtc-rs` peer connection that publishes one H.264 screen track to Cloudflare Realtime.
//!
//! This is the transport half of the Rust publisher. Frames arrive already encoded from
//! [`super::encoder`]; this module owns the peer connection, the signalling handshake and the RTP
//! packetisation, and knows nothing about capture.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
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

use super::signalling::{LocalTrack, SessionDescription, Signalling, VideoIntent};
use super::simulcast::LAYER_RIDS;
use crate::media::voice::rtc::opus_capability;

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

/// The codec capability every screen track is published with.
///
/// Constrained Baseline 3.1 with non-interleaved packetisation: the profile every browser decoder
/// accepts, which matters because Cloudflare forwards whatever we send and a viewer that cannot
/// decode it simply sees nothing.
///
/// Public, and used by `super::e2e_tests` rather than copied there - see [`publisher_api`] for why
/// a copy is the wrong shape.
pub fn h264_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90_000,
        sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
            .to_owned(),
        ..Default::default()
    }
}

/// The API every publishing peer connection is built from.
///
/// Public, and used by `super::e2e_tests` rather than copied there. Which codecs and interceptors
/// are registered is precisely what decides whether an inbound stream can be matched to a
/// transceiver at all, so a test that builds its own media engine tests its own media engine - and
/// a copy that drifts from this one passes while no viewer sees a picture.
pub fn publisher_api() -> Result<webrtc::api::API, String> {
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

/// A live publication: the peer connection, the track being fed, and the identifiers other clients
/// need in order to subscribe.
pub struct Publication {
    peer_connection: Arc<RTCPeerConnection>,
    /// The simulcast layers, highest first. Index 0 is rid `a` and is what every non-simulcast path
    /// in this file means when it says "the track": it carries the `FrameSink` writes and its
    /// failure is the share's failure. One element is the pre-simulcast publication.
    tracks: Vec<Arc<TrackLocalStaticSample>>,
    signalling: Signalling,
    /// Set when a viewer asks for a keyframe over RTCP, cleared when the encoder produces one.
    ///
    /// A flag rather than a channel because the request is idempotent: ten viewers asking at once,
    /// or one viewer asking ten times while a frame is in flight, all want the same single IDR.
    keyframe_wanted: Arc<AtomicBool>,
    pub media_session_id: String,
    pub track_name: String,
    /// The Opus track carrying the share's own sound, when the user chose to share it.
    ///
    /// Optional rather than always-present: a share without audio must not publish an empty track,
    /// or every viewer opens a decoder and a mixer slot for silence that will never arrive.
    audio_track: Option<Arc<TrackLocalStaticSample>>,
    pub audio_track_name: Option<String>,
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

    /// Open a Cloudflare session and publish an H.264 track named `screen-<share_id>`.
    ///
    /// Deliberately mirrors the webview's publish path so subscribers cannot tell the difference:
    /// they resolve a stream from `{cfSessionId, trackName}` and neither field says who produced it.
    /// `with_audio` adds a second Opus track, `screen-audio-<share_id>`, published in the *same*
    /// negotiation as the video. One call rather than two because the contract asks for it, and
    /// because two negotiations would announce the halves of one share separately - a viewer would
    /// build the tile, then have audio arrive against a share it had already finished laying out.
    pub async fn start(
        signalling: Signalling,
        share_id: &str,
        ice_servers: Vec<IceServerConfig>,
        with_audio: bool,
        video: Option<VideoIntent>,
        layer_count: usize,
    ) -> Result<Self, String> {
        let api = publisher_api()?;

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

        let track_name = format!("screen-{share_id}");
        let layer_count = layer_count.clamp(1, LAYER_RIDS.len());

        // One layer keeps the pre-simulcast constructor. A rid on a lone encoding writes no rid or
        // simulcast attribute into the SDP either way - webrtc-rs emits those only for a sender
        // holding more than one - but going through the same call the previous release did is what
        // makes "drop to one layer" a true rollback rather than a similar-looking path.
        let mut layer_tracks: Vec<Arc<TrackLocalStaticSample>> = Vec::with_capacity(layer_count);
        if layer_count == 1 {
            layer_tracks.push(Arc::new(TrackLocalStaticSample::new(
                h264_capability(),
                "video".to_owned(),
                track_name.clone(),
            )));
        } else {
            // Every layer shares `id` and `stream_id` and differs only by rid: `add_encoding`
            // rejects any other combination, and the base track must itself carry a rid or it
            // refuses with ErrRTPSenderNoBaseEncoding.
            for rid in LAYER_RIDS.iter().take(layer_count) {
                layer_tracks.push(Arc::new(TrackLocalStaticSample::new_with_rid(
                    h264_capability(),
                    "video".to_owned(),
                    (*rid).to_owned(),
                    track_name.clone(),
                )));
            }
        }

        let rtp_sender = peer_connection
            .add_track(Arc::clone(&layer_tracks[0]) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        // Every encoding has to be attached before the offer is created and before anything is
        // written: the sender refuses one afterwards (ErrRTPSenderSendAlreadyCalled), and the SDP
        // is generated from whatever is attached at that moment.
        for track in layer_tracks.iter().skip(1) {
            rtp_sender
                .add_encoding(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|e| format!("could not attach a simulcast layer: {e}"))?;
        }

        // The audio half. Added before the offer so both m-lines are in one negotiation.
        let audio_track_name = with_audio.then(|| format!("screen-audio-{share_id}"));
        let audio_track = match &audio_track_name {
            Some(name) => {
                let audio = Arc::new(TrackLocalStaticSample::new(
                    opus_capability(),
                    // A distinct stream id from the video's "video". Sharing one would have the two
                    // halves arrive as one MediaStream, which is what a *camera* looks like - the
                    // receiving client groups a share by its track names, not by its stream.
                    "screen-audio".to_owned(),
                    name.clone(),
                ));
                let audio_sender = peer_connection
                    .add_track(Arc::clone(&audio) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                    .map_err(|e| e.to_string())?;
                // Drained and discarded. Unlike the video sender there is nothing to act on - audio
                // has no keyframes - but an undrained sender fills its buffers and stalls the track.
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 1500];
                    while audio_sender.read(&mut buf).await.is_ok() {}
                });
                Some(audio)
            }
            None => None,
        };

        // RTCP has to be drained or the sender's buffers fill and stall the track - but *what* is in
        // it matters, and until now none of it was read.
        //
        // A WebRTC receiver cannot decode anything until it has a keyframe, and the way it asks for
        // one is an RTCP Picture Loss Indication. Discarding those means a viewer who joins after a
        // share began waits for whatever periodic IDR the encoder happens to emit - and a viewer who
        // loses a packet stays frozen or smeared until then, rather than recovering on request.
        //
        // `read_rtcp` rather than `read`: the same drain, already parsed.
        let keyframe_wanted = Arc::new(AtomicBool::new(false));
        let rtcp_keyframe_wanted = Arc::clone(&keyframe_wanted);
        tokio::spawn(async move {
            while let Ok((packets, _)) = rtp_sender.read_rtcp().await {
                for packet in packets {
                    // Both mean "send me a keyframe". PLI is what browsers send; FIR is the older
                    // request and some SFUs still relay it, so honour either.
                    let wants_keyframe = packet
                        .as_any()
                        .downcast_ref::<PictureLossIndication>()
                        .is_some()
                        || packet
                            .as_any()
                            .downcast_ref::<FullIntraRequest>()
                            .is_some();
                    if wants_keyframe {
                        rtcp_keyframe_wanted.store(true, Ordering::Relaxed);
                    }
                }
            }
        });

        let offer = peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;

        // Cloudflare needs a complete SDP, and webrtc-rs has no trickle path to the backend here,
        // so wait for ICE gathering before offering.
        let mut gathering = peer_connection.gathering_complete_promise().await;
        peer_connection
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let _ = gathering.recv().await;

        let local = peer_connection
            .local_description()
            .await
            .ok_or_else(|| "no local description after gathering".to_string())?;

        let media_session_id = signalling.create_session().await?;

        // Mids are assigned during offer creation, so they can only be read now. Taken in
        // transceiver order, which is add_track order: video first, then audio if it exists.
        let transceivers = peer_connection.get_transceivers().await;
        let mid_at = |index: usize| -> Result<String, String> {
            transceivers
                .get(index)
                .ok_or_else(|| format!("no transceiver {index} on the publishing connection"))
                .map(|t| {
                    t.mid()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| index.to_string())
                })
        };

        let mut tracks = vec![LocalTrack {
            mid: mid_at(0)?,
            track_name: track_name.clone(),
        }];
        if let Some(name) = &audio_track_name {
            tracks.push(LocalTrack {
                mid: mid_at(1)?,
                track_name: name.clone(),
            });
        }

        let response = signalling
            .tracks_new(
                &media_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: local.sdp,
                },
                &tracks,
                video,
            )
            .await?;

        if let Some(error) = response.tracks.iter().find_map(|t| t.error.as_ref()) {
            return Err(format!("the SFU rejected the track: {error}"));
        }

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        let resolved_track_name = response
            .tracks
            .first()
            .and_then(|t| t.track_name.clone())
            .unwrap_or_else(|| track_name.clone());

        let publication = Self {
            peer_connection,
            tracks: layer_tracks,
            signalling,
            keyframe_wanted,
            media_session_id,
            track_name: resolved_track_name,
            audio_track,
            audio_track_name,
        };

        if response.requires_immediate_renegotiation {
            publication.renegotiate().await?;
        }

        Ok(publication)
    }

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
                &self.media_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: offer.sdp,
                },
                // The publish this follows already declared the size, and it has not changed. An
                // absent declaration leaves the server's recorded one exactly where it is.
                None,
            )
            .await?;

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
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

    /// Close every track server-side and tear down the connection.
    ///
    /// Both halves of a share go in one close call. Closing only the video would leave viewers
    /// holding a live audio track from a share that no longer exists - silent, but still subscribed,
    /// still mixed, and still counted against the sharer's egress.
    async fn stop(self) {
        let mut names = vec![self.track_name.clone()];
        if let Some(audio) = &self.audio_track_name {
            names.push(audio.clone());
        }
        let _ = self
            .signalling
            .close_tracks(&self.media_session_id, &names)
            .await;
        let _ = self.peer_connection.close().await;
    }
}
