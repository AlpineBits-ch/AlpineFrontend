//! A `webrtc-rs` peer connection that publishes one H.264 screen track to Cloudflare Realtime.
//!
//! This is the transport half of the Rust publisher. Frames arrive already encoded from
//! [`super::encoder`]; this module owns the peer connection, the signalling handshake and the RTP
//! packetisation, and knows nothing about capture.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

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

use super::signalling::{LocalTrack, SessionDescription, Signalling};

/// A live publication: the peer connection, the track being fed, and the identifiers other clients
/// need in order to subscribe.
pub struct Publication {
    peer_connection: Arc<RTCPeerConnection>,
    track: Arc<TrackLocalStaticSample>,
    signalling: Signalling,
    pub cf_session_id: String,
    pub track_name: String,
}

impl Publication {
    /// Open a Cloudflare session and publish an H.264 track named `screen-<share_id>`.
    ///
    /// Deliberately mirrors the webview's publish path so subscribers cannot tell the difference:
    /// they resolve a stream from `{cfSessionId, trackName}` and neither field says who produced it.
    pub async fn start(
        signalling: Signalling,
        share_id: &str,
        ice_urls: Vec<String>,
    ) -> Result<Self, String> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .map_err(|e| e.to_string())?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)
            .map_err(|e| e.to_string())?;

        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: ice_urls,
                ..Default::default()
            }],
            ..Default::default()
        };

        let peer_connection = Arc::new(
            api.new_peer_connection(config)
                .await
                .map_err(|e| e.to_string())?,
        );

        let track_name = format!("screen-{share_id}");
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90_000,
                // Constrained Baseline 3.1 with non-interleaved packetisation: the profile every
                // browser decoder accepts, which matters because Cloudflare forwards whatever we
                // send and a viewer that cannot decode it simply sees nothing.
                sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
                    .to_owned(),
                ..Default::default()
            },
            "video".to_owned(),
            track_name.clone(),
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

        let cf_session_id = signalling.create_session().await?;

        // The mid is assigned during offer creation, so it can only be read now.
        let mid = peer_connection
            .get_transceivers()
            .await
            .first()
            .ok_or_else(|| "no transceiver on the publishing connection".to_string())?
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
                    track_name: track_name.clone(),
                }],
            )
            .await?;

        if let Some(error) = response.tracks.iter().find_map(|t| t.error.as_ref()) {
            return Err(format!("Cloudflare rejected the track: {error}"));
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
            track,
            signalling,
            cf_session_id,
            track_name: resolved_track_name,
        };

        if response.requires_immediate_renegotiation {
            publication.renegotiate().await?;
        }

        Ok(publication)
    }

    /// Hand one encoded access unit to the packetiser.
    pub async fn write_frame(&self, data: Vec<u8>, duration: Duration) -> Result<(), String> {
        self.track
            .write_sample(&Sample {
                data: data.into(),
                timestamp: SystemTime::now(),
                duration,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())
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
    pub async fn stop(self) {
        let _ = self
            .signalling
            .close_tracks(&self.cf_session_id, &[self.track_name.clone()])
            .await;
        let _ = self.peer_connection.close().await;
    }
}
