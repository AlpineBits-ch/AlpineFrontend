//! The output contract: the exact shape the Angular layer already listens for.
//!
//! This is the Rust mirror of `src/app/models/activity.model.ts`, which is itself the mirror of
//! Echo's `Social.Contracts/Dtos/ActivityDto.cs`. All three must agree, so the field names here are
//! `camelCase` on the wire and the enums serialize by *name* -a numeric member would silently fail
//! to match the string literal every other layer speaks.
//!
//! ## Why the sanitizers live here rather than at the socket
//!
//! Everything in this module is reachable from an unauthenticated local IPC socket that any process
//! running as the user can open (see [`super::ipc`]). The server enforces the same caps and the same
//! control-character stripping, and *its* copy is the one that matters -this one exists so that a
//! hostile local process cannot get arbitrary text as far as our own renderer, and so that we are
//! not relying on a single layer. Building the caps into the constructor rather than the socket
//! loop means a future second source (media session, Isle bridge) cannot forget them.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Discord's cap, mirrored by the TypeScript model and by the server.
pub const MAX_ACTIVITIES: usize = 3;

/// Cap for `name`, and for `details` / `state` / asset text. Matches the server's validator.
pub const MAX_TEXT: usize = 128;

/// The verb. `Custom` carries no verb at all; its `name` is the whole line.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ActivityType {
    Playing,
    Streaming,
    Listening,
    Watching,
    Competing,
    Custom,
}

impl ActivityType {
    /// Maps Discord's numeric activity type, which is what an RPC `SET_ACTIVITY` carries.
    ///
    /// Anything unrecognised lands on `Playing`: a game that invents a type should still show up as
    /// a game rather than vanishing.
    pub fn from_discord(value: i64) -> Self {
        match value {
            1 => Self::Streaming,
            2 => Self::Listening,
            3 => Self::Watching,
            4 => Self::Custom,
            5 => Self::Competing,
            _ => Self::Playing,
        }
    }
}

/// Where the activity was observed. The arbiter merges the sources and only the winner reaches the
/// frontend, but the tag survives so the UI can explain provenance.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ActivitySource {
    ProcessScan,
    Rpc,
    Media,
    Manual,
    Native,
}

impl ActivitySource {
    /// Merge priority, lower wins. `Rpc > Native > ProcessScan > Media` is the spec's order;
    /// `Manual` is not produced by anything in this process today and sorts last so that adding a
    /// producer later cannot silently outrank a detected game.
    pub fn priority(self) -> u8 {
        match self {
            Self::Rpc => 0,
            Self::Native => 1,
            Self::ProcessScan => 2,
            Self::Media => 3,
            Self::Manual => 4,
        }
    }
}

/// Artwork, already resolved to URLs.
///
/// **Never populated by this process.** Artwork is deferred by product decision and the server
/// strips the field unconditionally, because until it has a vetted source an asset URL is an
/// attacker-chosen URL that every viewer's client would fetch. The type is carried so the contract
/// is complete and so the field can start arriving without a rewrite here.
#[allow(dead_code)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAssets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_text: Option<String>,
}

/// Group size, when the game reports one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivityParty {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
}

impl ActivityParty {
    pub fn is_empty(&self) -> bool {
        self.id.is_none() && self.size.is_none() && self.max.is_none()
    }
}

/// One activity, in the shape `presence://changed` delivers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    #[serde(rename = "type")]
    pub kind: ActivityType,
    /// Best-effort for local rendering only.
    ///
    /// An RPC `SET_ACTIVITY` payload almost never carries a name -Discord fills it in from the
    /// application id -so this is frequently empty when the activity leaves [`super::protocol`].
    /// The arbiter is what resolves an empty name (see `Arbiter::merge`); an empty name never
    /// escapes to the frontend. The server discards whatever we send here regardless and resolves
    /// the canonical name from `application_id`.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// **Load-bearing for RPC activities.** The server resolves the canonical game name from this
    /// and drops any activity whose id does not resolve, so an RPC activity without one is
    /// discarded server-side no matter how well-formed the rest of it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_id: Option<String>,
    /// Epoch **milliseconds**, UTC. Never a duration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
    /// Always `None`; see [`ActivityAssets`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<ActivityAssets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party: Option<ActivityParty>,
    pub source: ActivitySource,
}

impl Activity {
    /// The triple the server uses to decide whether `started_at` is preserved, and the key the
    /// arbiter deduplicates on.
    pub fn identity(&self) -> (ActivityType, String, Option<String>) {
        (
            self.kind,
            self.name.to_lowercase(),
            self.application_id.clone(),
        )
    }
}

/// Epoch milliseconds now.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether a string is a plausible Discord snowflake: decimal digits only, at most 20 of them.
///
/// This is the `client_id` gate. It is not cosmetic -the id is what the server resolves the
/// displayed game name from, so anything that is not an id must never reach it.
pub fn is_snowflake(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit())
}

/// Strips control characters and bidi/zero-width trickery, trims, and caps to `max_chars`.
///
/// Returns `None` for anything that is empty once cleaned, so a caller can use `Option` to mean
/// "the game did not supply this" without a separate emptiness check at every site.
///
/// Truncation is by `char`, not by byte: cutting a UTF-8 sequence in half would either panic on a
/// slice boundary or produce a string that no downstream JSON encoder can represent.
pub fn sanitize(input: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| !is_forbidden(*c))
        .take(max_chars)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// C0, DEL, C1, the bidi overrides/isolates, and the zero-width joiners used to hide text.
///
/// Newlines and tabs are dropped along with the rest: every surface that renders an activity is a
/// single line, so a newline is only ever useful for making one entry look like several.
fn is_forbidden(c: char) -> bool {
    let code = c as u32;
    code < 0x20
        || code == 0x7F
        || (0x80..=0x9F).contains(&code)
        || matches!(
            code,
            0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xFEFF
        )
}

/// Normalizes a timestamp that may be in seconds or milliseconds into milliseconds.
///
/// Discord's own gateway model is milliseconds, but the C game SDK takes `int64_t` **seconds** and
/// several wrappers pass that straight through, so both appear on this socket in practice. The
/// split is unambiguous for any value that could describe a running game: `1e11` ms is 1973 and
/// `1e11` s is the year 5138, so nothing real sits near the boundary.
///
/// Returns `None` for non-positive values rather than clamping -a zero here means "the game did not
/// set a timestamp", and turning that into 1970 would render "playing for 56 years".
pub fn normalize_epoch_ms(value: i64) -> Option<i64> {
    const SECONDS_CEILING: i64 = 100_000_000_000;
    if value <= 0 {
        return None;
    }
    Some(if value < SECONDS_CEILING {
        value.saturating_mul(1000)
    } else {
        value
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_typescript_contract() {
        let activity = Activity {
            kind: ActivityType::Playing,
            name: "Overwatch".into(),
            details: Some("Competitive".into()),
            state: Some("In Queue".into()),
            application_id: Some("356875221078245376".into()),
            started_at: Some(1_754_300_000_000),
            ends_at: None,
            assets: None,
            party: Some(ActivityParty {
                id: Some("party-1".into()),
                size: Some(2),
                max: Some(5),
            }),
            source: ActivitySource::Rpc,
        };

        let json: serde_json::Value = serde_json::to_value(&activity).unwrap();

        // Field names, not just values: the whole point is that Angular can read this untouched.
        assert_eq!(json["type"], "Playing");
        assert_eq!(json["name"], "Overwatch");
        assert_eq!(json["details"], "Competitive");
        assert_eq!(json["state"], "In Queue");
        assert_eq!(json["applicationId"], "356875221078245376");
        assert_eq!(json["startedAt"], 1_754_300_000_000i64);
        assert_eq!(json["source"], "Rpc");
        assert_eq!(json["party"]["size"], 2);
        assert_eq!(json["party"]["max"], 5);
        // Absent rather than null -both are legal for the TS optional, absent is smaller.
        assert!(json.get("endsAt").is_none());
        assert!(json.get("assets").is_none());
    }

    #[test]
    fn every_source_and_type_round_trips_by_name() {
        for source in [
            ActivitySource::ProcessScan,
            ActivitySource::Rpc,
            ActivitySource::Media,
            ActivitySource::Manual,
            ActivitySource::Native,
        ] {
            let text = serde_json::to_string(&source).unwrap();
            assert_eq!(
                serde_json::from_str::<ActivitySource>(&text).unwrap(),
                source
            );
        }
        for kind in [
            ActivityType::Playing,
            ActivityType::Streaming,
            ActivityType::Listening,
            ActivityType::Watching,
            ActivityType::Competing,
            ActivityType::Custom,
        ] {
            let text = serde_json::to_string(&kind).unwrap();
            assert_eq!(serde_json::from_str::<ActivityType>(&text).unwrap(), kind);
        }
    }

    #[test]
    fn discord_numeric_types_map_across() {
        assert_eq!(ActivityType::from_discord(0), ActivityType::Playing);
        assert_eq!(ActivityType::from_discord(1), ActivityType::Streaming);
        assert_eq!(ActivityType::from_discord(2), ActivityType::Listening);
        assert_eq!(ActivityType::from_discord(3), ActivityType::Watching);
        assert_eq!(ActivityType::from_discord(4), ActivityType::Custom);
        assert_eq!(ActivityType::from_discord(5), ActivityType::Competing);
        // Unknown falls back rather than dropping the activity.
        assert_eq!(ActivityType::from_discord(99), ActivityType::Playing);
        assert_eq!(ActivityType::from_discord(-1), ActivityType::Playing);
    }

    #[test]
    fn snowflakes_are_digits_only_and_bounded() {
        assert!(is_snowflake("356875221078245376"));
        assert!(is_snowflake("0"));
        assert!(!is_snowflake(""));
        assert!(!is_snowflake("35687522107824537a"));
        assert!(!is_snowflake("-1"));
        assert!(!is_snowflake("1 "));
        assert!(!is_snowflake("../../etc/passwd"));
        // 20 digits is the ceiling; 21 is not.
        assert!(is_snowflake(&"9".repeat(20)));
        assert!(!is_snowflake(&"9".repeat(21)));
    }

    #[test]
    fn sanitize_strips_control_and_bidi_and_caps_length() {
        assert_eq!(sanitize("Overwatch", MAX_TEXT).as_deref(), Some("Overwatch"));
        assert_eq!(
            sanitize("Over\u{0}wat\nch\u{7}", MAX_TEXT).as_deref(),
            Some("Overwatch")
        );
        // The classic display-spoofing set.
        assert_eq!(
            sanitize("safe\u{202E}gnihsihp", MAX_TEXT).as_deref(),
            Some("safegnihsihp")
        );
        assert_eq!(sanitize("a\u{200B}b\u{FEFF}c", MAX_TEXT).as_deref(), Some("abc"));
        assert_eq!(sanitize("   ", MAX_TEXT), None);
        assert_eq!(sanitize("", MAX_TEXT), None);
        assert_eq!(sanitize("\u{0}\u{1}\u{2}", MAX_TEXT), None);

        let long = "x".repeat(1000);
        assert_eq!(sanitize(&long, MAX_TEXT).unwrap().chars().count(), MAX_TEXT);
    }

    #[test]
    fn sanitize_truncates_on_char_boundaries() {
        // Four-byte scalars: a byte-wise truncation here would panic or emit invalid UTF-8.
        let emoji = "\u{1F600}".repeat(200);
        let out = sanitize(&emoji, MAX_TEXT).unwrap();
        assert_eq!(out.chars().count(), MAX_TEXT);
        assert_eq!(out.len(), MAX_TEXT * 4);
    }

    #[test]
    fn timestamps_normalize_to_milliseconds() {
        // Seconds, as the C game SDK emits.
        assert_eq!(normalize_epoch_ms(1_754_300_000), Some(1_754_300_000_000));
        // Already milliseconds.
        assert_eq!(
            normalize_epoch_ms(1_754_300_000_000),
            Some(1_754_300_000_000)
        );
        assert_eq!(normalize_epoch_ms(0), None);
        assert_eq!(normalize_epoch_ms(-5), None);
        // No overflow panic on a hostile value.
        assert!(normalize_epoch_ms(i64::MAX).is_some());
    }

    #[test]
    fn source_priority_is_the_specified_order() {
        let mut sources = [
            ActivitySource::Media,
            ActivitySource::ProcessScan,
            ActivitySource::Rpc,
            ActivitySource::Native,
        ];
        sources.sort_by_key(|s| s.priority());
        assert_eq!(
            sources,
            [
                ActivitySource::Rpc,
                ActivitySource::Native,
                ActivitySource::ProcessScan,
                ActivitySource::Media,
            ]
        );
    }
}
