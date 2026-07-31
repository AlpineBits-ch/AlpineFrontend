//! A `webrtc-rs` peer connection publishing one Opus microphone track to Cloudflare Realtime.
//!
//! The transport half of the Rust voice pipeline. Packets arrive already encoded from
//! [`super::chain`]; this module owns the peer connection and the signalling handshake and knows
//! nothing about audio.
//!
//! Shaped after `publisher::rtc`, which does the same job for screen video. The difference that
//! matters is the session role: voice is the *primary* session, because the backend records the
//! primary session as the participant's audio.

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

use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::{LocalTrack, SessionDescription, Signalling};

/// The name every other client resolves a participant's microphone by.
///
/// It matches what the webview published before this pipeline existed, so a client on the previous
/// build can still find the track.
pub const TRACK_NAME: &str = "audio";

/// One packet every 20 ms - the packetisation the encoder is configured for.
const PACKET_DURATION: Duration = Duration::from_millis(20);

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

pub struct VoicePublication {
    peer_connection: Arc<RTCPeerConnection>,
    track: Arc<TrackLocalStaticSample>,
    signalling: Signalling,
    pub cf_session_id: String,
    pub track_name: String,
}

impl VoicePublication {
    pub async fn start(
        signalling: Signalling,
        ice_servers: Vec<IceServerConfig>,
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

        let offer = peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;

        // Cloudflare needs a complete SDP, and there is no trickle path to the backend here, so
        // wait for ICE gathering before offering.
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
            cf_session_id,
            track_name,
        };

        if response.requires_immediate_renegotiation {
            publication.renegotiate().await?;
        }

        Ok(publication)
    }

    /// Hand one encoded packet to the packetiser.
    pub async fn write_packet(&self, packet: Vec<u8>) -> Result<(), String> {
        self.track
            .write_sample(&Sample {
                data: packet.into(),
                timestamp: SystemTime::now(),
                duration: PACKET_DURATION,
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

#[cfg(test)]
mod tests {
    use super::*;

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
