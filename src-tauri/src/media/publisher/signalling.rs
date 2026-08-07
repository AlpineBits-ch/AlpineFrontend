//! Voice signalling, spoken from Rust.
//!
//! Deliberately a mirror of the frontend's `GuildVoiceService`: the same backend endpoints, the
//! same request and response shapes, the same bearer token. The publisher opens its *own* media
//! session alongside the webview's, so other clients subscribe to the resulting screen track
//! exactly as they already do - they only ever see `{mediaSessionId, trackName}` and cannot tell
//! which process published it.
//!
//! # Two dialects, on purpose
//!
//! Guild channels and calls moved to a backend-neutral contract (Echo `075c096`): `mediaSessionId`,
//! `direction: publish|subscribe`, and routes with no `cf/` in them. Isle deliberately did *not* -
//! it drives `CloudflareService` directly, has no room model, and was left on the Cloudflare-shaped
//! surface. So one `Signalling` has to speak both, and the difference is not incidental: the
//! session-id field name, the per-track direction key *and* its values, and three of the four route
//! suffixes all change. [`Dialect`] is the one place that knows which.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Prefix on the error of a subscribe for media nobody is publishing any more.
///
/// <p>The server answers `409 {"error":"staleSubscription","action":"refetchSnapshot"}` when the
/// roster says the track is gone. It is not a transport fault and it is not late - retrying the
/// identical body is guaranteed to fail again, which is exactly the loop that put voice on the
/// status page in VNT-GE21R3P7. The caller must refetch the snapshot and reconcile instead.</p>
///
/// <p>Everything across the Tauri boundary is `Result<_, String>`, so this travels as a prefix. It
/// is a constant on both sides rather than a substring of prose precisely so that rewording the
/// message cannot quietly turn the stale path back into a retry loop.</p>
pub const STALE_SUBSCRIPTION: &str = "staleSubscription";

/// Whether a failed response is the server telling us our view of the room is out of date.
///
/// <p>Both halves are required. The status alone would catch an unrelated 409 - the room-contention
/// retry answers 503, but nothing stops another endpoint using 409 for something else - and the
/// body alone would match a 200 that merely mentions the word.</p>
fn is_stale_subscription(status: reqwest::StatusCode, body: &str) -> bool {
    status == reqwest::StatusCode::CONFLICT && body.contains(STALE_SUBSCRIPTION)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescription {
    #[serde(rename = "type")]
    pub sdp_type: String,
    pub sdp: String,
}

/// A track this client is publishing.
///
/// Carries no direction field: which key that is (`direction` or `location`) and which value
/// (`publish` or `local`) depends on the dialect, so [`Signalling`] adds it on the way out rather
/// than every caller having to know.
#[derive(Debug, Clone)]
pub struct LocalTrack {
    pub mid: String,
    pub track_name: String,
}

/// A track to pull from another participant's session.
///
/// A separate type from [`LocalTrack`] rather than the same one with an optional `mid`: a remote
/// pull that sends a mid is rejected by the SFU, and an optional field is exactly the kind of thing
/// that gets filled in by accident.
#[derive(Debug, Clone)]
pub struct RemoteTrack {
    pub track_name: String,
    /// The session publishing it.
    pub session_id: String,
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
    /// `mediaSessionId` on the neutral surface, `cfSessionId` on Isle's. Aliased rather than
    /// branched: one field means one thing to every caller, and the alias costs nothing.
    #[serde(alias = "cfSessionId")]
    pub media_session_id: String,
    /// Which SFU is behind the session, on surfaces that declare one. Absent on Isle.
    ///
    /// Read but not acted on: this publisher speaks WebRTC to whatever answers, and the SDP
    /// exchange is the same shape either way. It exists so an unrecognised backend is *loggable*
    /// rather than silently assumed to be Cloudflare.
    #[serde(default)]
    pub backend: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenegotiateResponse {
    pub session_description: SessionDescription,
}

/// Which vocabulary a surface speaks. See the module docs for why there are two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Guild channels and DM calls, after Echo `075c096`.
    Neutral,
    /// Isle proximity voice, which still talks Cloudflare's shape.
    Cloudflare,
}

impl Dialect {
    /// The name of the "which session is this" field, in request bodies.
    fn session_key(self) -> &'static str {
        match self {
            Dialect::Neutral => "mediaSessionId",
            Dialect::Cloudflare => "cfSessionId",
        }
    }

    /// The per-track direction key, and its two values.
    ///
    /// The neutral form says what the caller is *doing*; the Cloudflare form says where the media
    /// sits. They are not interchangeable - sending `location` to the neutral surface deserialises
    /// to a null direction and the track is rejected.
    fn direction_key(self) -> &'static str {
        match self {
            Dialect::Neutral => "direction",
            Dialect::Cloudflare => "location",
        }
    }

    fn publish_value(self) -> &'static str {
        match self {
            Dialect::Neutral => "publish",
            Dialect::Cloudflare => "local",
        }
    }

    fn subscribe_value(self) -> &'static str {
        match self {
            Dialect::Neutral => "subscribe",
            Dialect::Cloudflare => "remote",
        }
    }

    /// The field naming the session a remote track is pulled *from*.
    fn remote_source_key(self) -> &'static str {
        match self {
            Dialect::Neutral => "mediaSessionId",
            Dialect::Cloudflare => "sessionId",
        }
    }
}

/// Which call surface a publish belongs to.
#[derive(Debug, Clone)]
pub enum VoiceTarget {
    /// A guild voice channel.
    GuildChannel { guild_id: String, channel_id: String },
    /// A direct-message call.
    Call { call_id: String },
    /// Isle proximity voice. One session per player, no channel or call to address.
    Isle,
}

impl VoiceTarget {
    fn dialect(&self) -> Dialect {
        match self {
            VoiceTarget::Isle => Dialect::Cloudflare,
            _ => Dialect::Neutral,
        }
    }
}

/// Whether this session is the one the backend should record as the participant's audio.
///
/// Exactly one session per participant may be primary. The screen publisher is always secondary:
/// marking it primary leaves later joiners in a guild channel subscribing to a session with no
/// audio, and in a DM call triggers device-takeover and hangs up the call being shared into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRole {
    Primary,
    Secondary,
}

impl SessionRole {
    fn as_query_value(self) -> &'static str {
        match self {
            SessionRole::Primary => "true",
            SessionRole::Secondary => "false",
        }
    }
}

/// Signalling client scoped to one voice channel or call.
pub struct Signalling {
    client: reqwest::Client,
    base_url: String,
    token: String,
    device_id: String,
    target: VoiceTarget,
    role: SessionRole,
}

impl Signalling {
    pub fn new(
        base_url: String,
        token: String,
        device_id: String,
        target: VoiceTarget,
        role: SessionRole,
    ) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_owned(),
            token,
            device_id,
            target,
            role,
        })
    }

    /// The device this client acts as, sent as `X-Device-Id` on every request.
    ///
    /// Must be the id the webview sends on its own requests. `DeviceIdResolver` buckets a missing
    /// header as `"default"`, so omitting it here while the webview sends a real id splits one
    /// user across two devices - with the *primary* session, the one carrying the microphone, in
    /// the anonymous bucket.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Endpoint root, matching `GuildVoiceService.base()` and `VoiceService.base`.
    ///
    /// These are *gateway* paths, not the backend controllers' own `[Route]`s. The YARP config
    /// matches on a service segment and then strips it (`ProxyConfig.cs`: `/api/v1/guild/{**rest}`
    /// -> `/api/v1/{**rest}`), so the segment after `v1` names the service and never appears in the
    /// controller route. Deriving these from the controllers instead is how the call route came to
    /// be missing its `messaging/` segment - the DM path 404'd at the gateway and never reached the
    /// service at all.
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
                format!("{}/api/v1/messaging/voice/calls/{call_id}", self.base_url)
            }
            VoiceTarget::Isle => format!("{}/api/v1/isle/voice", self.base_url),
        }
    }

    /// URL for opening this Cloudflare session.
    ///
    /// The `primary` flag is load-bearing in both directions - see [`SessionRole`].
    ///
    /// Isle is the exception on both counts: it opens at `cf/session` rather than `session`, and
    /// it has no `primary` concept because a player has exactly one proximity session. Sending the
    /// flag anyway would be harmless but the path difference is not - see
    /// `IsleVoiceApiService.createSession`.
    pub fn session_url(&self) -> String {
        match self.target {
            VoiceTarget::Isle => format!("{}/cf/session", self.voice_base()),
            _ => format!(
                "{}/session?primary={}",
                self.voice_base(),
                self.role.as_query_value()
            ),
        }
    }

    /// Which vocabulary this target speaks.
    pub fn dialect(&self) -> Dialect {
        self.target.dialect()
    }

    /// Where tracks are published and subscribed.
    ///
    /// The neutral surface collapsed publish and subscribe onto one `POST .../tracks` and dropped
    /// the `cf/` segment; Isle still has `cf/tracks/new`.
    pub fn tracks_url(&self) -> String {
        match self.dialect() {
            Dialect::Neutral => format!("{}/tracks", self.voice_base()),
            Dialect::Cloudflare => format!("{}/cf/tracks/new", self.voice_base()),
        }
    }

    pub fn negotiate_url(&self) -> String {
        match self.dialect() {
            Dialect::Neutral => format!("{}/negotiate", self.voice_base()),
            Dialect::Cloudflare => format!("{}/cf/renegotiate", self.voice_base()),
        }
    }

    /// Note the *method* differs too, not just the path - the neutral close is a POST, Isle's a
    /// PUT. See [`Self::close_tracks`].
    pub fn close_tracks_url(&self) -> String {
        match self.dialect() {
            Dialect::Neutral => format!("{}/tracks/close", self.voice_base()),
            Dialect::Cloudflare => format!("{}/cf/tracks/close", self.voice_base()),
        }
    }

    /// A request body carrying this client's own session id under whichever name the dialect uses.
    fn body_with_session(&self, session_id: &str) -> Map<String, Value> {
        let mut body = Map::new();
        body.insert(
            self.dialect().session_key().to_owned(),
            Value::String(session_id.to_owned()),
        );
        body
    }

    /// Open a media session for this client's tracks alone.
    pub async fn create_session(&self) -> Result<String, String> {
        let response: CreateSessionResponse = self.post(&self.session_url(), &json!({})).await?;
        // Logged rather than enforced: an unrecognised SFU is still WebRTC, and refusing to publish
        // over one we merely have not heard of would be a self-inflicted outage. But a silent
        // assumption is how a backend swap would present as "screen sharing is broken".
        if let Some(backend) = response.backend.as_deref() {
            if backend != "cloudflare" {
                eprintln!("[publisher] media session on an unfamiliar backend: {backend}");
            }
        }
        Ok(response.media_session_id)
    }

    /// The publish body, built rather than sent.
    ///
    /// Split out for the same reason `subscription_tracks` is in `media::voice::rtc`: the request
    /// shape is the part that is easy to get wrong, it is validated only by the real SFU, and that
    /// is the most expensive place to find out.
    fn publish_body(
        &self,
        media_session_id: &str,
        session_description: &SessionDescription,
        tracks: &[LocalTrack],
    ) -> Result<Value, String> {
        let dialect = self.dialect();
        let mut body = self.body_with_session(media_session_id);
        body.insert(
            "sessionDescription".into(),
            serde_json::to_value(session_description).map_err(|e| e.to_string())?,
        );
        body.insert(
            "tracks".into(),
            Value::Array(
                tracks
                    .iter()
                    .map(|t| {
                        json!({
                            dialect.direction_key(): dialect.publish_value(),
                            "mid": t.mid,
                            "trackName": t.track_name,
                        })
                    })
                    .collect(),
            ),
        );
        Ok(Value::Object(body))
    }

    pub async fn tracks_new(
        &self,
        media_session_id: &str,
        session_description: &SessionDescription,
        tracks: &[LocalTrack],
    ) -> Result<TracksNewResponse, String> {
        let body = self.publish_body(media_session_id, session_description, tracks)?;
        self.post(&self.tracks_url(), &body).await
    }

    /// Subscribe to tracks published on other participants' sessions.
    ///
    /// The backend routes an all-subscribe request through its retry path, which absorbs the window
    /// where the publisher's track has not finished propagating across the SFU. That retry is what
    /// makes this safe to call the instant a ParticipantJoined arrives, rather than having to guess
    /// at a delay.
    fn subscribe_body(
        &self,
        media_session_id: &str,
        session_description: &SessionDescription,
        tracks: &[RemoteTrack],
    ) -> Result<Value, String> {
        let dialect = self.dialect();
        let mut body = self.body_with_session(media_session_id);
        body.insert(
            "sessionDescription".into(),
            serde_json::to_value(session_description).map_err(|e| e.to_string())?,
        );
        body.insert(
            "tracks".into(),
            Value::Array(
                tracks
                    .iter()
                    .map(|t| {
                        // No mid, deliberately - the SFU allocates it, and sending one is rejected.
                        json!({
                            dialect.direction_key(): dialect.subscribe_value(),
                            "trackName": t.track_name,
                            dialect.remote_source_key(): t.session_id,
                        })
                    })
                    .collect(),
            ),
        );
        Ok(Value::Object(body))
    }

    pub async fn tracks_new_remote(
        &self,
        media_session_id: &str,
        session_description: &SessionDescription,
        tracks: &[RemoteTrack],
    ) -> Result<TracksNewResponse, String> {
        let body = self.subscribe_body(media_session_id, session_description, tracks)?;
        self.post(&self.tracks_url(), &body).await
    }

    pub async fn renegotiate(
        &self,
        media_session_id: &str,
        session_description: &SessionDescription,
    ) -> Result<RenegotiateResponse, String> {
        let mut body = self.body_with_session(media_session_id);
        body.insert(
            "sessionDescription".into(),
            serde_json::to_value(session_description).map_err(|e| e.to_string())?,
        );
        self.put(&self.negotiate_url(), &Value::Object(body)).await
    }

    fn close_tracks_body(&self, media_session_id: &str, track_names: &[String]) -> Value {
        let mut body = self.body_with_session(media_session_id);
        body.insert(
            "trackNames".into(),
            Value::Array(
                track_names
                    .iter()
                    .map(|n| Value::String(n.clone()))
                    .collect(),
            ),
        );
        Value::Object(body)
    }

    pub async fn close_tracks(
        &self,
        media_session_id: &str,
        track_names: &[String],
    ) -> Result<(), String> {
        let url = self.close_tracks_url();
        let body = self.close_tracks_body(media_session_id, track_names);

        // The neutral surface takes a POST here and Isle still takes a PUT, which is the one place
        // the two dialects disagree on method rather than only on path.
        let request = match self.dialect() {
            Dialect::Neutral => self.client.post(&url),
            Dialect::Cloudflare => self.client.put(&url),
        };

        // Builds its own request rather than going through `send`, so the header has to be
        // repeated here - this is the path that would otherwise silently drop it.
        let response = request
            .bearer_auth(&self.token)
            .header("X-Device-Id", &self.device_id)
            .json(&body)
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
            .header("X-Device-Id", &self.device_id)
            .json(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            if is_stale_subscription(status, &text) {
                // Marked rather than described, because the caller has to *act* on this one and
                // acting on a substring of a human-readable message is how that stops working
                // silently. See STALE_SUBSCRIPTION.
                return Err(format!("{STALE_SUBSCRIPTION}: {url} returned {status}: {text}"));
            }
            // Include the body: the SFU surfaces per-track errors this way, and a bare status code
            // is not enough to tell a bad SDP from an expired token.
            return Err(format!("{url} returned HTTP {status}: {text}"));
        }

        serde_json::from_str(&text).map_err(|e| format!("{url} returned unparseable JSON: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signalling() -> Signalling {
        with_role(SessionRole::Secondary)
    }

    fn with_role(role: SessionRole) -> Signalling {
        Signalling::new(
            "https://api.example.test/".into(),
            "tok".into(),
            "dev-1".into(),
            VoiceTarget::GuildChannel {
                guild_id: "g1".into(),
                channel_id: "c1".into(),
            },
            role,
        )
        .unwrap()
    }

    fn call_signalling() -> Signalling {
        call_with_role(SessionRole::Secondary)
    }

    fn call_with_role(role: SessionRole) -> Signalling {
        Signalling::new(
            "https://api.example.test".into(),
            "tok".into(),
            "dev-1".into(),
            VoiceTarget::Call {
                call_id: "call-1".into(),
            },
            role,
        )
        .unwrap()
    }

    /// The webview stamps every API request with this header. If Rust does not, the backend sees
    /// two devices for one user - and the one holding the *primary* session is the anonymous
    /// `default` bucket, which reads as a takeover of the user's own call.
    #[test]
    fn carries_the_device_id() {
        assert_eq!(signalling().device_id(), "dev-1");
    }

    #[test]
    fn a_secondary_session_is_marked_non_primary() {
        assert!(with_role(SessionRole::Secondary)
            .session_url()
            .ends_with("/voice/session?primary=false"));
    }

    #[test]
    fn a_primary_session_claims_the_participants_audio() {
        assert!(with_role(SessionRole::Primary)
            .session_url()
            .ends_with("/voice/session?primary=true"));
    }

    #[test]
    fn the_role_applies_to_call_targets_too() {
        assert_eq!(
            call_with_role(SessionRole::Primary).session_url(),
            "https://api.example.test/api/v1/messaging/voice/calls/call-1/session?primary=true"
        );
    }

    #[test]
    fn a_trailing_slash_on_the_base_url_is_not_doubled_in_the_session_url() {
        assert!(!signalling().session_url().contains("//api/"));
        assert!(!call_signalling().session_url().contains("//api/"));
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
        // Must stay identical to `VoiceService.base` in voice.service.ts - the *gateway* path,
        // which carries a `messaging/` segment that YARP strips before the request reaches
        // CloudflareController. Matching the controller's own [Route] instead produces a URL that
        // no gateway route matches.
        assert_eq!(
            call_signalling().voice_base(),
            "https://api.example.test/api/v1/messaging/voice/calls/call-1"
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

    fn isle_signalling() -> Signalling {
        Signalling::new(
            "https://api.example.test".into(),
            "tok".into(),
            "dev-1".into(),
            VoiceTarget::Isle,
            SessionRole::Primary,
        )
        .unwrap()
    }

    fn offer() -> SessionDescription {
        SessionDescription {
            sdp_type: "offer".into(),
            sdp: "v=0".into(),
        }
    }

    #[test]
    fn a_publish_names_the_media_session_and_says_publish() {
        let tracks = [LocalTrack {
            mid: "0".into(),
            track_name: "screen-abc".into(),
        }];
        let json = signalling()
            .publish_body("sess", &offer(), &tracks)
            .unwrap();

        assert_eq!(json["mediaSessionId"], "sess");
        assert_eq!(json["sessionDescription"]["type"], "offer");
        assert_eq!(json["tracks"][0]["direction"], "publish");
        assert_eq!(json["tracks"][0]["trackName"], "screen-abc");
        assert_eq!(json["tracks"][0]["mid"], "0");
        assert!(
            json["tracks"][0].get("location").is_none(),
            "the neutral surface deserialises `direction`; a stray `location` leaves it null"
        );
    }

    /// Isle stayed on the Cloudflare shape because it drives `CloudflareService` directly. Sending
    /// it the neutral vocabulary is rejected, and the failure is a 4xx from a route that exists,
    /// which reads like an auth problem rather than a contract one.
    #[test]
    fn isle_still_speaks_the_cloudflare_shape() {
        let tracks = [LocalTrack {
            mid: "0".into(),
            track_name: "audio".into(),
        }];
        let json = isle_signalling()
            .publish_body("sess", &offer(), &tracks)
            .unwrap();

        assert_eq!(json["cfSessionId"], "sess");
        assert_eq!(json["tracks"][0]["location"], "local");
        assert!(json.get("mediaSessionId").is_none());
        assert!(json["tracks"][0].get("direction").is_none());
    }

    #[test]
    fn a_subscribe_names_the_publishing_session_and_claims_no_mid() {
        let tracks = [RemoteTrack {
            track_name: "audio".into(),
            session_id: "their-session".into(),
        }];
        let json = signalling()
            .subscribe_body("mine", &offer(), &tracks)
            .unwrap();

        assert_eq!(json["mediaSessionId"], "mine");
        assert_eq!(json["tracks"][0]["direction"], "subscribe");
        assert_eq!(json["tracks"][0]["trackName"], "audio");
        assert_eq!(json["tracks"][0]["mediaSessionId"], "their-session");
        assert!(
            json["tracks"][0].get("mid").is_none(),
            "a subscribe must not claim a mid - the SFU allocates it"
        );
    }

    /// The one field that changes name *and* meaning between the two: the session a track is pulled
    /// from is `mediaSessionId` on the neutral surface and `sessionId` on Isle's, while the caller's
    /// own session sits under the top-level key in both.
    #[test]
    fn isle_names_the_source_session_differently() {
        let tracks = [RemoteTrack {
            track_name: "audio".into(),
            session_id: "their-session".into(),
        }];
        let json = isle_signalling()
            .subscribe_body("mine", &offer(), &tracks)
            .unwrap();

        assert_eq!(json["cfSessionId"], "mine");
        assert_eq!(json["tracks"][0]["location"], "remote");
        assert_eq!(json["tracks"][0]["sessionId"], "their-session");
    }

    #[test]
    fn close_tracks_request_uses_camel_case_keys() {
        let names = ["screen-abc".to_string()];
        let json = signalling().close_tracks_body("sess", &names);
        assert_eq!(json["mediaSessionId"], "sess");
        assert_eq!(json["trackNames"][0], "screen-abc");
    }

    #[test]
    fn the_neutral_routes_have_no_cf_segment() {
        let client = signalling();
        assert!(client.tracks_url().ends_with("/voice/tracks"));
        assert!(client.negotiate_url().ends_with("/voice/negotiate"));
        assert!(client.close_tracks_url().ends_with("/voice/tracks/close"));
        assert!(!client.tracks_url().contains("/cf/"));
    }

    #[test]
    fn isle_keeps_its_cf_routes() {
        let client = isle_signalling();
        assert!(client.tracks_url().ends_with("/voice/cf/tracks/new"));
        assert!(client.negotiate_url().ends_with("/voice/cf/renegotiate"));
        assert!(client.close_tracks_url().ends_with("/voice/cf/tracks/close"));
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

    /// The whole point of the marker: a caller has to tell "refetch and reconcile" from "retry".
    #[test]
    fn a_stale_subscription_conflict_is_recognised() {
        assert!(is_stale_subscription(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":"staleSubscription","action":"refetchSnapshot"}"#
        ));
    }

    /// Both halves, so an unrelated conflict is not mistaken for a stale roster and silently turned
    /// into a snapshot refetch, and a success that happens to mention the word is not either.
    #[test]
    fn other_failures_are_not_mistaken_for_a_stale_subscription() {
        assert!(!is_stale_subscription(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":"somethingElse"}"#
        ));
        assert!(!is_stale_subscription(
            reqwest::StatusCode::BAD_GATEWAY,
            r#"{"error":"staleSubscription"}"#
        ));
        assert!(!is_stale_subscription(
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            "room contended"
        ));
    }

    #[test]
    fn create_session_response_parses_the_neutral_shape() {
        let parsed: CreateSessionResponse =
            serde_json::from_str(r#"{"mediaSessionId": "abc123", "backend": "cloudflare"}"#)
                .unwrap();
        assert_eq!(parsed.media_session_id, "abc123");
        assert_eq!(parsed.backend.as_deref(), Some("cloudflare"));
    }

    /// Isle answers `{cfSessionId}` and no backend, and one alias is cheaper than two response
    /// types for a field that means the same thing on both.
    #[test]
    fn create_session_response_still_parses_isles_shape() {
        let parsed: CreateSessionResponse =
            serde_json::from_str(r#"{"cfSessionId": "abc123"}"#).unwrap();
        assert_eq!(parsed.media_session_id, "abc123");
        assert!(parsed.backend.is_none());
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
