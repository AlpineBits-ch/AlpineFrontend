//! Cloudflare Realtime signalling, spoken from Rust.
//!
//! Deliberately a mirror of the frontend's `GuildVoiceService`: the same backend endpoints, the
//! same request and response shapes, the same bearer token. The publisher opens its *own*
//! Cloudflare session alongside the webview's, so other clients subscribe to the resulting screen
//! track exactly as they already do - they only ever see `{cfSessionId, trackName}` and cannot tell
//! which process published it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescription {
    #[serde(rename = "type")]
    pub sdp_type: String,
    pub sdp: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub location: &'static str,
    pub mid: String,
    pub track_name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct TracksNewRequest<'a> {
    cf_session_id: &'a str,
    session_description: &'a SessionDescription,
    tracks: &'a [LocalTrack],
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackResult {
    pub mid: Option<String>,
    pub track_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TracksNewResponse {
    pub session_description: SessionDescription,
    #[serde(default)]
    pub tracks: Vec<TrackResult>,
    #[serde(default)]
    pub requires_immediate_renegotiation: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub cf_session_id: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenegotiateResponse {
    pub session_description: SessionDescription,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct RenegotiateRequest<'a> {
    cf_session_id: &'a str,
    session_description: &'a SessionDescription,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CloseTracksRequest<'a> {
    cf_session_id: &'a str,
    track_names: &'a [String],
}

/// Which call surface a publish belongs to. The two have separate controllers and route shapes but
/// identical request and response bodies, so only the endpoint root differs.
#[derive(Debug, Clone)]
pub enum VoiceTarget {
    /// A guild voice channel.
    GuildChannel { guild_id: String, channel_id: String },
    /// A direct-message call.
    Call { call_id: String },
}

/// Signalling client scoped to one voice channel or call.
pub struct Signalling {
    client: reqwest::Client,
    base_url: String,
    token: String,
    target: VoiceTarget,
}

impl Signalling {
    pub fn new(base_url: String, token: String, target: VoiceTarget) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_owned(),
            token,
            target,
        })
    }

    /// Endpoint root, matching `GuildVoiceService.base()` and `VoiceService`'s call routes.
    pub fn voice_base(&self) -> String {
        match &self.target {
            VoiceTarget::GuildChannel {
                guild_id,
                channel_id,
            } => format!(
                "{}/api/v1/guild/guilds/{guild_id}/channels/{channel_id}/voice",
                self.base_url
            ),
            VoiceTarget::Call { call_id } => {
                format!("{}/api/v1/voice/calls/{call_id}", self.base_url)
            }
        }
    }

    /// URL for opening this publisher's Cloudflare session.
    ///
    /// `primary=false` is load-bearing. Without it the backend records this session as the
    /// participant's, which in a guild channel leaves later joiners subscribing to a session with
    /// no audio, and in a DM call triggers device-takeover and hangs up the call being shared into.
    pub fn session_url(&self) -> String {
        format!("{}/session?primary=false", self.voice_base())
    }

    /// Open a Cloudflare session for the screen track alone.
    pub async fn create_session(&self) -> Result<String, String> {
        let response: CreateSessionResponse =
            self.post(&self.session_url(), &serde_json::json!({})).await?;
        Ok(response.cf_session_id)
    }

    pub async fn tracks_new(
        &self,
        cf_session_id: &str,
        session_description: &SessionDescription,
        tracks: &[LocalTrack],
    ) -> Result<TracksNewResponse, String> {
        self.post(
            &format!("{}/cf/tracks/new", self.voice_base()),
            &TracksNewRequest {
                cf_session_id,
                session_description,
                tracks,
            },
        )
        .await
    }

    pub async fn renegotiate(
        &self,
        cf_session_id: &str,
        session_description: &SessionDescription,
    ) -> Result<RenegotiateResponse, String> {
        self.put(
            &format!("{}/cf/renegotiate", self.voice_base()),
            &RenegotiateRequest {
                cf_session_id,
                session_description,
            },
        )
        .await
    }

    pub async fn close_tracks(
        &self,
        cf_session_id: &str,
        track_names: &[String],
    ) -> Result<(), String> {
        let url = format!("{}/cf/tracks/close", self.voice_base());
        let response = self
            .client
            .put(&url)
            .bearer_auth(&self.token)
            .json(&CloseTracksRequest {
                cf_session_id,
                track_names,
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("{url} returned HTTP {}", response.status()));
        }
        Ok(())
    }

    async fn post<B: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        url: &str,
        body: &B,
    ) -> Result<R, String> {
        self.send(self.client.post(url), url, body).await
    }

    async fn put<B: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        url: &str,
        body: &B,
    ) -> Result<R, String> {
        self.send(self.client.put(url), url, body).await
    }

    async fn send<B: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        request: reqwest::RequestBuilder,
        url: &str,
        body: &B,
    ) -> Result<R, String> {
        let response = request
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            // Include the body: Cloudflare surfaces per-track errors this way, and a bare status
            // code is not enough to tell a bad SDP from an expired token.
            return Err(format!("{url} returned HTTP {status}: {text}"));
        }

        serde_json::from_str(&text).map_err(|e| format!("{url} returned unparseable JSON: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signalling() -> Signalling {
        Signalling::new(
            "https://api.example.test/".into(),
            "tok".into(),
            VoiceTarget::GuildChannel {
                guild_id: "g1".into(),
                channel_id: "c1".into(),
            },
        )
        .unwrap()
    }

    fn call_signalling() -> Signalling {
        Signalling::new(
            "https://api.example.test".into(),
            "tok".into(),
            VoiceTarget::Call {
                call_id: "call-1".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn voice_base_matches_the_frontend_guild_route() {
        // Must stay identical to GuildVoiceService.base() in guild-voice.service.ts.
        assert_eq!(
            signalling().voice_base(),
            "https://api.example.test/api/v1/guild/guilds/g1/channels/c1/voice"
        );
    }

    #[test]
    fn voice_base_matches_the_call_route() {
        // Must stay identical to CloudflareController's [Route] in the backend.
        assert_eq!(
            call_signalling().voice_base(),
            "https://api.example.test/api/v1/voice/calls/call-1"
        );
    }

    #[test]
    fn trailing_slashes_on_the_base_url_do_not_double_up() {
        assert!(!signalling().voice_base().contains("//api/v1"));
        assert!(!call_signalling().voice_base().contains("//api/v1"));
    }

    #[test]
    fn session_description_serialises_with_a_type_field() {
        let sdp = SessionDescription {
            sdp_type: "offer".into(),
            sdp: "v=0".into(),
        };
        let json = serde_json::to_value(&sdp).unwrap();
        assert_eq!(json["type"], "offer");
        assert_eq!(json["sdp"], "v=0");
    }

    #[test]
    fn tracks_new_request_uses_camel_case_keys() {
        let sdp = SessionDescription {
            sdp_type: "offer".into(),
            sdp: "v=0".into(),
        };
        let tracks = [LocalTrack {
            location: "local",
            mid: "0".into(),
            track_name: "screen-abc".into(),
        }];
        let json = serde_json::to_value(TracksNewRequest {
            cf_session_id: "sess",
            session_description: &sdp,
            tracks: &tracks,
        })
        .unwrap();

        assert_eq!(json["cfSessionId"], "sess");
        assert_eq!(json["sessionDescription"]["type"], "offer");
        assert_eq!(json["tracks"][0]["location"], "local");
        assert_eq!(json["tracks"][0]["trackName"], "screen-abc");
        assert_eq!(json["tracks"][0]["mid"], "0");
    }

    #[test]
    fn close_tracks_request_uses_camel_case_keys() {
        let names = ["screen-abc".to_string()];
        let json = serde_json::to_value(CloseTracksRequest {
            cf_session_id: "sess",
            track_names: &names,
        })
        .unwrap();
        assert_eq!(json["cfSessionId"], "sess");
        assert_eq!(json["trackNames"][0], "screen-abc");
    }

    #[test]
    fn tracks_new_response_parses_the_backend_shape() {
        let parsed: TracksNewResponse = serde_json::from_str(
            r#"{
                "sessionDescription": {"type": "answer", "sdp": "v=0"},
                "tracks": [{"mid": "0", "trackName": "screen-abc"}],
                "requiresImmediateRenegotiation": true
            }"#,
        )
        .unwrap();

        assert_eq!(parsed.session_description.sdp_type, "answer");
        assert_eq!(parsed.tracks[0].track_name.as_deref(), Some("screen-abc"));
        assert!(parsed.requires_immediate_renegotiation);
    }

    #[test]
    fn tracks_new_response_tolerates_omitted_optional_fields() {
        // The backend omits requiresImmediateRenegotiation when false, and per-track error is only
        // present on failure; neither absence should fail the whole response.
        let parsed: TracksNewResponse =
            serde_json::from_str(r#"{"sessionDescription": {"type": "answer", "sdp": "v=0"}}"#)
                .unwrap();
        assert!(!parsed.requires_immediate_renegotiation);
        assert!(parsed.tracks.is_empty());
    }

    #[test]
    fn create_session_response_parses() {
        let parsed: CreateSessionResponse =
            serde_json::from_str(r#"{"cfSessionId": "abc123"}"#).unwrap();
        assert_eq!(parsed.cf_session_id, "abc123");
    }

    #[test]
    fn session_requests_are_always_secondary() {
        // Guards the one flag that keeps a screen publish from clobbering the participant's audio
        // session (guild) or triggering device takeover (DM call). Asserted on both surfaces
        // because each has its own backend controller.
        for client in [signalling(), call_signalling()] {
            assert!(
                client.session_url().ends_with("/session?primary=false"),
                "session URL must carry primary=false, got {}",
                client.session_url()
            );
        }
    }
}
