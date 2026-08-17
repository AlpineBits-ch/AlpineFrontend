//! The Discord RPC conversation, as a pure state machine.
//!
//! [`Session::on_packet`] takes a decoded [`Packet`] and returns [`Action`]s. It performs no I/O and
//! owns no socket, which is the whole point: the handshake rules, the rate limit, the nonce echo and
//! every validation decision are testable without a pipe, and the transport in [`super::ipc`] is
//! reduced to a loop that reads, calls this, and writes what it is told.
//!
//! ## The reply that everyone forgets
//!
//! A `SET_ACTIVITY` **must** be answered with a `FRAME` carrying the same `nonce`. The C++
//! `discord-rpc` library and several wrappers treat a missing response as a dead connection and
//! enter a reconnect loop, so an implementation that snoops the activity and stays silent looks
//! like it works -the activity arrives once -and then the game reconnects forever. The same is true
//! of the `READY` dispatch: `discord-rpc` will not send anything at all until it has seen one.
//!
//! ## Relay mode
//!
//! In proxy mode the real Discord is downstream and *its* replies are relayed back, so this machine
//! must produce no replies of its own or the game sees two READYs and two responses per nonce.
//! [`Session::relaying`] switches that off while leaving validation and snooping intact.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::codec::{Opcode, Packet};
use super::model::{
    self, Activity, ActivityParty, ActivitySource, ActivityType, MAX_TEXT,
};

/// Discord's own RPC write limit, and the one the server rate-limits to. Mirrored here so a game
/// that updates every frame cannot drive an event storm through the arbiter.
pub const ACTIVITY_INTERVAL: Duration = Duration::from_secs(15);

/// RPC close codes, as Discord documents them.
pub mod close {
    /// Ordinary teardown.
    pub const NORMAL: u32 = 1000;
    /// We do not speak whatever this is.
    pub const UNSUPPORTED: u32 = 1001;
    pub const INVALID_CLIENT_ID: u32 = 4000;
    /// Also used for the connection cap, which is the same statement one level up.
    pub const RATE_LIMITED: u32 = 4002;
    pub const INVALID_VERSION: u32 = 4004;
}

/// What the transport should do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Write this frame back to the game.
    Reply(Packet),
    /// Send a `CLOSE` with this code and stop.
    Close { code: u32, message: String },
    /// Hand this to the arbiter. `None` clears.
    Activity(Option<Activity>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    AwaitHandshake,
    Ready,
    Closed,
}

/// One game's connection.
pub struct Session {
    stage: Stage,
    client_id: Option<String>,
    /// Proxy mode: the downstream Discord owns every reply.
    relaying: bool,
    /// When the last *accepted* activity landed, for the rate limit.
    last_activity_at: Option<Instant>,
    activity_interval: Duration,
}

impl Session {
    pub fn new() -> Self {
        Self {
            stage: Stage::AwaitHandshake,
            client_id: None,
            relaying: false,
            last_activity_at: None,
            activity_interval: ACTIVITY_INTERVAL,
        }
    }

    /// Suppresses our own replies; validation and snooping are unchanged.
    #[cfg(test)]
    pub fn relaying(mut self) -> Self {
        self.relaying = true;
        self
    }

    /// Flipped once, after the handshake has been validated and a downstream Discord has answered.
    ///
    /// The handshake is deliberately processed *before* this is known: a connection whose handshake
    /// is rejected must never cause us to open a downstream connection, or a hostile local process
    /// gets to hammer Discord's pipe by spamming bad handshakes at ours.
    pub fn set_relaying(&mut self, relaying: bool) {
        self.relaying = relaying;
    }

    pub fn with_interval(mut self, interval: Duration) -> Self {
        self.activity_interval = interval;
        self
    }

    /// The validated snowflake, which is what an activity's `application_id` is taken from.
    /// Part of the state machine's surface and asserted on by the tests; the transport reads it
    /// only indirectly, through the activities the session produces.
    #[allow(dead_code)]
    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    pub fn is_closed(&self) -> bool {
        self.stage == Stage::Closed
    }

    /// True once a valid handshake has been accepted.
    #[allow(dead_code)]
    pub fn is_ready(&self) -> bool {
        self.stage == Stage::Ready
    }

    pub fn on_packet(&mut self, packet: &Packet, now: Instant) -> Vec<Action> {
        if self.stage == Stage::Closed {
            return Vec::new();
        }

        let Some(opcode) = Opcode::from_u32(packet.opcode) else {
            return self.close(close::UNSUPPORTED, format!("unknown opcode {}", packet.opcode));
        };

        match opcode {
            Opcode::Handshake => self.on_handshake(packet),
            Opcode::Frame => self.on_frame(packet, now),
            Opcode::Close => {
                self.stage = Stage::Closed;
                // The game is going away; drop whatever it was reporting.
                vec![Action::Activity(None)]
            }
            // The payload is echoed verbatim: some clients put a token in it and compare.
            Opcode::Ping => {
                if self.relaying {
                    Vec::new()
                } else {
                    vec![Action::Reply(Packet::new(
                        Opcode::Pong,
                        packet.payload.clone(),
                    ))]
                }
            }
            Opcode::Pong => Vec::new(),
        }
    }

    fn close(&mut self, code: u32, message: String) -> Vec<Action> {
        self.stage = Stage::Closed;
        vec![
            Action::Activity(None),
            Action::Close { code, message },
        ]
    }

    fn on_handshake(&mut self, packet: &Packet) -> Vec<Action> {
        if self.stage != Stage::AwaitHandshake {
            return self.close(close::UNSUPPORTED, "duplicate handshake".into());
        }

        let Ok(value) = serde_json::from_slice::<Value>(&packet.payload) else {
            return self.close(close::INVALID_CLIENT_ID, "malformed handshake".into());
        };

        // `v` arrives as a number from every library we have seen, and as a string from at least
        // one. Both are accepted; anything that is not 1 is not.
        let version = value
            .get("v")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
        if version != Some(1) {
            return self.close(close::INVALID_VERSION, "unsupported rpc version".into());
        }

        // Likewise `client_id`: a string in the protocol, a number in a couple of wrappers.
        let client_id = value.get("client_id").and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_u64().map(|n| n.to_string()))
        });
        let Some(client_id) = client_id.filter(|id| model::is_snowflake(id)) else {
            return self.close(close::INVALID_CLIENT_ID, "invalid client id".into());
        };

        self.client_id = Some(client_id);
        self.stage = Stage::Ready;

        if self.relaying {
            Vec::new()
        } else {
            vec![Action::Reply(Packet::new(Opcode::Frame, ready_payload()))]
        }
    }

    fn on_frame(&mut self, packet: &Packet, now: Instant) -> Vec<Action> {
        // No frames before a successful handshake. This is not merely tidiness: `client_id` is what
        // an activity's `application_id` is taken from, and it does not exist yet.
        if self.stage != Stage::Ready {
            return self.close(close::INVALID_CLIENT_ID, "frame before handshake".into());
        }

        let Ok(value) = serde_json::from_slice::<Value>(&packet.payload) else {
            return self.close(close::INVALID_CLIENT_ID, "malformed frame".into());
        };

        let command = value.get("cmd").and_then(Value::as_str).unwrap_or_default();
        // Echoed verbatim, whatever its type -string, number or null. A client that sent a number
        // and got a string back would not match it to its pending request.
        let nonce = value.get("nonce").cloned().unwrap_or(Value::Null);

        if command != "SET_ACTIVITY" {
            // Everything else (SUBSCRIBE, INVITE_BROWSER, …) is answered rather than ignored, for
            // exactly the reason SET_ACTIVITY is: a request with no response reads as a dead socket.
            return self.ack(command, Value::Null, nonce);
        }

        let raw = value.get("args").and_then(|args| args.get("activity"));
        let cleared = matches!(raw, None | Some(Value::Null));

        let mut actions = Vec::new();
        if cleared {
            // Clearing is never throttled. Someone who quits a game a second after launching it
            // must not stay visible as playing until the window expires -the same rule the server
            // applies on the write path.
            self.last_activity_at = None;
            actions.push(Action::Activity(None));
        } else if let Some(activity) =
            parse_activity(raw.unwrap(), self.client_id.as_deref().unwrap_or_default())
        {
            let allowed = self
                .last_activity_at
                .is_none_or(|last| now.duration_since(last) >= self.activity_interval);
            if allowed {
                self.last_activity_at = Some(now);
                actions.push(Action::Activity(Some(activity)));
            }
            // A throttled update is dropped, not queued: the next one carries newer truth anyway,
            // and the reply below still goes out so the client never sees a stall.
        }

        // Echo what we were given, which is what arrpc and the real client both do. Even a dropped
        // or unparseable activity is acknowledged -refusing here would put the game into its
        // reconnect loop over a field we chose not to keep.
        let data = raw.cloned().unwrap_or(Value::Null);
        actions.extend(self.ack("SET_ACTIVITY", data, nonce));
        actions
    }

    fn ack(&self, command: &str, data: Value, nonce: Value) -> Vec<Action> {
        if self.relaying {
            return Vec::new();
        }
        let payload = json!({
            "cmd": command,
            "data": data,
            "evt": Value::Null,
            "nonce": nonce,
        });
        match serde_json::to_vec(&payload) {
            Ok(bytes) => vec![Action::Reply(Packet::new(Opcode::Frame, bytes))],
            Err(_) => Vec::new(),
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

/// The `READY` dispatch every client waits for before it will send anything.
///
/// The shape is Discord's, because that is what the client libraries parse; `config` and `user` are
/// present because `discord-rpc` reads both and a missing `user` is a null dereference in some
/// wrappers. The user is plainly ours rather than a spoof of a real account.
fn ready_payload() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "cmd": "DISPATCH",
        "evt": "READY",
        "nonce": Value::Null,
        "data": {
            "v": 1,
            "config": {
                "cdn_host": "cdn.discordapp.com",
                "api_endpoint": "//discord.com/api",
                "environment": "production"
            },
            "user": {
                "id": "0",
                "username": "venta",
                "discriminator": "0",
                "global_name": "Venta",
                "avatar": Value::Null,
                "bot": false,
                "flags": 0,
                "premium_type": 0
            }
        }
    }))
    .unwrap_or_else(|_| b"{}".to_vec())
}

/// Turns a `SET_ACTIVITY` activity object into the output contract.
///
/// `client_id` becomes `application_id` unconditionally: the payload itself never carries one, and
/// the server drops any activity it cannot resolve an id for, so an activity without it is dead on
/// arrival no matter how complete the rest of it is.
///
/// `name` is usually absent -Discord fills it in from the application -and is left empty here for
/// the arbiter to resolve. `assets` is deliberately not read at all.
pub fn parse_activity(value: &Value, client_id: &str) -> Option<Activity> {
    if !value.is_object() {
        return None;
    }

    let kind = value
        .get("type")
        .and_then(Value::as_i64)
        .map(ActivityType::from_discord)
        .unwrap_or(ActivityType::Playing);

    let name = value
        .get("name")
        .and_then(Value::as_str)
        .and_then(|s| model::sanitize(s, MAX_TEXT))
        .unwrap_or_default();

    let details = value
        .get("details")
        .and_then(Value::as_str)
        .and_then(|s| model::sanitize(s, MAX_TEXT));
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .and_then(|s| model::sanitize(s, MAX_TEXT));

    let timestamps = value.get("timestamps");
    let started_at = timestamps
        .and_then(|t| t.get("start"))
        .and_then(Value::as_i64)
        .and_then(model::normalize_epoch_ms);
    let ends_at = timestamps
        .and_then(|t| t.get("end"))
        .and_then(Value::as_i64)
        .and_then(model::normalize_epoch_ms);

    let party = value.get("party").and_then(parse_party);

    let activity = Activity {
        kind,
        name,
        details,
        state,
        application_id: Some(client_id.to_owned()),
        started_at,
        ends_at,
        assets: None,
        party,
        source: ActivitySource::Rpc,
    };

    Some(activity)
}

fn parse_party(value: &Value) -> Option<ActivityParty> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .and_then(|s| model::sanitize(s, MAX_TEXT));

    // `size` is `[current, max]`, and both entries are clamped: a game reporting a party of four
    // billion is either broken or probing, and either way it is not rendering.
    let sizes = value.get("size").and_then(Value::as_array);
    let read = |index: usize| -> Option<u32> {
        sizes
            .and_then(|s| s.get(index))
            .and_then(Value::as_i64)
            .filter(|n| *n > 0)
            .map(|n| n.min(100_000) as u32)
    };

    let party = ActivityParty {
        id,
        size: read(0),
        max: read(1),
    };
    if party.is_empty() {
        None
    } else {
        Some(party)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn handshake(body: Value) -> Packet {
        Packet::new(Opcode::Handshake, serde_json::to_vec(&body).unwrap())
    }

    fn frame(body: Value) -> Packet {
        Packet::new(Opcode::Frame, serde_json::to_vec(&body).unwrap())
    }

    fn reply_json(actions: &[Action]) -> Value {
        for action in actions {
            if let Action::Reply(packet) = action {
                if packet.opcode == Opcode::Frame.as_u32() {
                    return serde_json::from_slice(&packet.payload).unwrap();
                }
            }
        }
        panic!("no frame reply in {actions:?}");
    }

    fn activity_of(actions: &[Action]) -> Option<Option<Activity>> {
        actions.iter().find_map(|a| match a {
            Action::Activity(activity) => Some(activity.clone()),
            _ => None,
        })
    }

    fn close_code(actions: &[Action]) -> Option<u32> {
        actions.iter().find_map(|a| match a {
            Action::Close { code, .. } => Some(*code),
            _ => None,
        })
    }

    fn ready_session() -> Session {
        let mut session = Session::new();
        let actions = session.on_packet(
            &handshake(json!({"v": 1, "client_id": "356875221078245376"})),
            Instant::now(),
        );
        assert!(close_code(&actions).is_none());
        session
    }

    // ── Handshake ───────────────────────────────────────────────────────────

    #[test]
    fn valid_handshake_is_accepted_and_answered_with_ready() {
        let mut session = Session::new();
        let actions = session.on_packet(
            &handshake(json!({"v": 1, "client_id": "356875221078245376"})),
            Instant::now(),
        );

        assert!(session.is_ready());
        assert_eq!(session.client_id(), Some("356875221078245376"));

        let ready = reply_json(&actions);
        assert_eq!(ready["cmd"], "DISPATCH");
        assert_eq!(ready["evt"], "READY");
        assert_eq!(ready["data"]["v"], 1);
        assert!(ready["data"]["user"]["id"].is_string());
    }

    #[test]
    fn a_string_version_and_numeric_client_id_are_accepted() {
        let mut session = Session::new();
        session.on_packet(
            &handshake(json!({"v": "1", "client_id": 356875221078245376u64})),
            Instant::now(),
        );
        assert!(session.is_ready());
        assert_eq!(session.client_id(), Some("356875221078245376"));
    }

    #[test]
    fn wrong_version_closes_with_invalid_version() {
        for version in [json!(0), json!(2), json!("v1"), Value::Null] {
            let mut session = Session::new();
            let actions = session.on_packet(
                &handshake(json!({"v": version, "client_id": "1"})),
                Instant::now(),
            );
            assert_eq!(close_code(&actions), Some(close::INVALID_VERSION));
            assert!(session.is_closed());
        }
    }

    #[test]
    fn a_missing_or_malformed_version_field_closes() {
        let mut session = Session::new();
        let actions = session.on_packet(&handshake(json!({"client_id": "1"})), Instant::now());
        assert_eq!(close_code(&actions), Some(close::INVALID_VERSION));
    }

    #[test]
    fn empty_or_non_snowflake_client_ids_close_with_invalid_client_id() {
        for client_id in [
            json!(""),
            json!("   "),
            json!("not-a-snowflake"),
            json!("../../../etc/passwd"),
            json!("9999999999999999999999999"),
            json!(true),
            Value::Null,
        ] {
            let mut session = Session::new();
            let actions = session.on_packet(
                &handshake(json!({"v": 1, "client_id": client_id})),
                Instant::now(),
            );
            assert_eq!(
                close_code(&actions),
                Some(close::INVALID_CLIENT_ID),
                "client_id {client_id:?} should have been rejected"
            );
            assert!(session.is_closed());
        }
    }

    #[test]
    fn a_missing_client_id_closes() {
        let mut session = Session::new();
        let actions = session.on_packet(&handshake(json!({"v": 1})), Instant::now());
        assert_eq!(close_code(&actions), Some(close::INVALID_CLIENT_ID));
    }

    #[test]
    fn a_handshake_that_is_not_json_closes_rather_than_panicking() {
        let mut session = Session::new();
        let actions = session.on_packet(
            &Packet::new(Opcode::Handshake, b"\xff\xfe not json".to_vec()),
            Instant::now(),
        );
        assert_eq!(close_code(&actions), Some(close::INVALID_CLIENT_ID));
    }

    #[test]
    fn a_second_handshake_closes_the_connection() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &handshake(json!({"v": 1, "client_id": "1"})),
            Instant::now(),
        );
        assert_eq!(close_code(&actions), Some(close::UNSUPPORTED));
    }

    #[test]
    fn a_frame_before_the_handshake_closes_the_connection() {
        let mut session = Session::new();
        let actions = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "n", "args": {"activity": {}}})),
            Instant::now(),
        );
        assert_eq!(close_code(&actions), Some(close::INVALID_CLIENT_ID));
        assert!(session.is_closed());
        assert!(activity_of(&actions).unwrap().is_none());
    }

    #[test]
    fn nothing_is_processed_after_close() {
        let mut session = Session::new();
        session.on_packet(&handshake(json!({"v": 9})), Instant::now());
        let actions = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "n"})),
            Instant::now(),
        );
        assert!(actions.is_empty());
    }

    // ── Opcodes ─────────────────────────────────────────────────────────────

    #[test]
    fn ping_is_answered_with_pong_carrying_the_same_payload() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &Packet {
                opcode: Opcode::Ping.as_u32(),
                payload: b"token-42".to_vec(),
            },
            Instant::now(),
        );
        match actions.as_slice() {
            [Action::Reply(packet)] => {
                assert_eq!(packet.opcode, Opcode::Pong.as_u32());
                assert_eq!(packet.payload, b"token-42");
            }
            other => panic!("expected a single pong, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_opcode_closes_the_connection() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &Packet {
                opcode: 42,
                payload: Vec::new(),
            },
            Instant::now(),
        );
        assert_eq!(close_code(&actions), Some(close::UNSUPPORTED));
        assert!(session.is_closed());
    }

    #[test]
    fn a_close_opcode_clears_the_activity() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &Packet::new(Opcode::Close, b"{}".to_vec()),
            Instant::now(),
        );
        assert_eq!(activity_of(&actions), Some(None));
        assert!(session.is_closed());
    }

    // ── SET_ACTIVITY ────────────────────────────────────────────────────────

    #[test]
    fn set_activity_is_parsed_into_the_output_contract() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({
                "cmd": "SET_ACTIVITY",
                "nonce": "abc-123",
                "args": {
                    "pid": 1234,
                    "activity": {
                        "details": "Competitive \u{2014} Mirage",
                        "state": "In Queue (4 of 5)",
                        "timestamps": {"start": 1_754_300_000, "end": 1_754_303_600},
                        "assets": {"large_image": "mirage", "large_text": "Mirage"},
                        "party": {"id": "party-7", "size": [4, 5]},
                        "buttons": ["Join"],
                        "instance": true
                    }
                }
            })),
            Instant::now(),
        );

        let activity = activity_of(&actions).unwrap().unwrap();
        assert_eq!(activity.kind, ActivityType::Playing);
        assert_eq!(activity.details.as_deref(), Some("Competitive — Mirage"));
        assert_eq!(activity.state.as_deref(), Some("In Queue (4 of 5)"));
        assert_eq!(activity.source, ActivitySource::Rpc);
        // Always present, or the server drops the activity outright.
        assert_eq!(
            activity.application_id.as_deref(),
            Some("356875221078245376")
        );
        // Seconds normalized to milliseconds.
        assert_eq!(activity.started_at, Some(1_754_300_000_000));
        assert_eq!(activity.ends_at, Some(1_754_303_600_000));
        let party = activity.party.unwrap();
        assert_eq!(party.id.as_deref(), Some("party-7"));
        assert_eq!(party.size, Some(4));
        assert_eq!(party.max, Some(5));
        // Never populated: artwork is deferred and the server strips it unconditionally.
        assert!(activity.assets.is_none());
    }

    #[test]
    fn the_response_frame_echoes_the_nonce() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({
                "cmd": "SET_ACTIVITY",
                "nonce": "d4f3-9a11",
                "args": {"pid": 1, "activity": {"details": "x"}}
            })),
            Instant::now(),
        );

        let reply = reply_json(&actions);
        assert_eq!(reply["cmd"], "SET_ACTIVITY");
        assert_eq!(reply["nonce"], "d4f3-9a11");
        assert_eq!(reply["evt"], Value::Null);
        assert_eq!(reply["data"]["details"], "x");
    }

    #[test]
    fn a_numeric_nonce_is_echoed_as_a_number() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": 7, "args": {"activity": null}})),
            Instant::now(),
        );
        assert_eq!(reply_json(&actions)["nonce"], 7);
    }

    #[test]
    fn a_null_activity_clears_and_is_still_answered() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "n", "args": {"pid": 9, "activity": null}})),
            Instant::now(),
        );
        assert_eq!(activity_of(&actions), Some(None));
        assert_eq!(reply_json(&actions)["nonce"], "n");
        assert_eq!(reply_json(&actions)["data"], Value::Null);
    }

    #[test]
    fn a_missing_activity_argument_also_clears() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "n", "args": {"pid": 9}})),
            Instant::now(),
        );
        assert_eq!(activity_of(&actions), Some(None));
    }

    #[test]
    fn other_commands_are_acknowledged_rather_than_ignored() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({"cmd": "SUBSCRIBE", "evt": "ACTIVITY_JOIN", "nonce": "s1"})),
            Instant::now(),
        );
        let reply = reply_json(&actions);
        assert_eq!(reply["cmd"], "SUBSCRIBE");
        assert_eq!(reply["nonce"], "s1");
        assert!(activity_of(&actions).is_none());
    }

    #[test]
    fn hostile_text_is_capped_and_stripped_before_it_leaves_the_socket() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({
                "cmd": "SET_ACTIVITY",
                "nonce": "n",
                "args": {"activity": {
                    "name": "x".repeat(5000),
                    "details": format!("evil\u{202E}{}", "y".repeat(5000)),
                    "state": "line\none\u{0}two",
                    "party": {"id": "z".repeat(400), "size": [9_000_000_000i64, -3]}
                }}
            })),
            Instant::now(),
        );

        let activity = activity_of(&actions).unwrap().unwrap();
        assert_eq!(activity.name.chars().count(), MAX_TEXT);
        assert_eq!(activity.details.unwrap().chars().count(), MAX_TEXT);
        assert_eq!(activity.state.as_deref(), Some("lineonetwo"));
        let party = activity.party.unwrap();
        assert_eq!(party.id.unwrap().chars().count(), MAX_TEXT);
        assert_eq!(party.size, Some(100_000));
        // A negative "max" is not a size; it is dropped rather than wrapped into a huge u32.
        assert_eq!(party.max, None);
    }

    #[test]
    fn an_activity_that_is_not_an_object_is_dropped_but_still_answered() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "n", "args": {"activity": "hello"}})),
            Instant::now(),
        );
        // No activity action at all: nothing to set, and nothing to clear either.
        assert!(activity_of(&actions).is_none());
        assert_eq!(reply_json(&actions)["nonce"], "n");
    }

    #[test]
    fn a_frame_that_is_not_json_closes() {
        let mut session = ready_session();
        let actions = session.on_packet(
            &Packet::new(Opcode::Frame, b"{not json".to_vec()),
            Instant::now(),
        );
        assert_eq!(close_code(&actions), Some(close::INVALID_CLIENT_ID));
    }

    // ── Rate limiting ───────────────────────────────────────────────────────

    #[test]
    fn activity_updates_are_rate_limited_but_always_answered() {
        let start = Instant::now();
        let mut session = ready_session().with_interval(Duration::from_secs(15));

        let set = |n: &str| {
            frame(json!({
                "cmd": "SET_ACTIVITY",
                "nonce": n,
                "args": {"activity": {"details": n}}
            }))
        };

        let first = session.on_packet(&set("a"), start);
        assert!(activity_of(&first).unwrap().is_some());

        // Inside the window: dropped, but the client still gets its nonce back, or it decides the
        // socket is dead and reconnects.
        let second = session.on_packet(&set("b"), start + Duration::from_secs(1));
        assert!(activity_of(&second).is_none());
        assert_eq!(reply_json(&second)["nonce"], "b");

        let third = session.on_packet(&set("c"), start + Duration::from_secs(14));
        assert!(activity_of(&third).is_none());

        // The window has passed.
        let fourth = session.on_packet(&set("d"), start + Duration::from_secs(15));
        assert_eq!(
            activity_of(&fourth).unwrap().unwrap().details.as_deref(),
            Some("d")
        );
    }

    #[test]
    fn clearing_is_never_throttled() {
        let start = Instant::now();
        let mut session = ready_session().with_interval(Duration::from_secs(15));

        session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "a", "args": {"activity": {}}})),
            start,
        );

        // A game quit one second after launching must not stay visible for fourteen more.
        let cleared = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "b", "args": {"activity": null}})),
            start + Duration::from_secs(1),
        );
        assert_eq!(activity_of(&cleared), Some(None));

        // And the clear resets the window, so relaunching is visible immediately too.
        let relaunched = session.on_packet(
            &frame(json!({"cmd": "SET_ACTIVITY", "nonce": "c", "args": {"activity": {}}})),
            start + Duration::from_secs(2),
        );
        assert!(activity_of(&relaunched).unwrap().is_some());
    }

    // ── Relay mode ──────────────────────────────────────────────────────────

    #[test]
    fn relaying_snoops_without_replying() {
        let mut session = Session::new().relaying();
        let start = Instant::now();

        let handshake_actions = session.on_packet(
            &handshake(json!({"v": 1, "client_id": "356875221078245376"})),
            start,
        );
        // No READY of our own: the downstream Discord sends its own and we relay it.
        assert!(handshake_actions.is_empty());
        assert!(session.is_ready());

        let actions = session.on_packet(
            &frame(json!({
                "cmd": "SET_ACTIVITY",
                "nonce": "n",
                "args": {"activity": {"details": "Mirage"}}
            })),
            start,
        );
        // Snooped …
        assert_eq!(
            activity_of(&actions).unwrap().unwrap().details.as_deref(),
            Some("Mirage")
        );
        // … and nothing written back, or the game would see two responses per nonce.
        assert!(!actions.iter().any(|a| matches!(a, Action::Reply(_))));
    }

    #[test]
    fn relaying_still_rejects_a_bad_handshake() {
        let mut session = Session::new().relaying();
        let actions = session.on_packet(
            &handshake(json!({"v": 1, "client_id": "nope"})),
            Instant::now(),
        );
        assert_eq!(close_code(&actions), Some(close::INVALID_CLIENT_ID));
    }

    #[test]
    fn relaying_does_not_answer_pings() {
        let mut session = Session::new().relaying();
        session.on_packet(
            &handshake(json!({"v": 1, "client_id": "1"})),
            Instant::now(),
        );
        let actions = session.on_packet(
            &Packet::new(Opcode::Ping, b"x".to_vec()),
            Instant::now(),
        );
        assert!(actions.is_empty());
    }
}
