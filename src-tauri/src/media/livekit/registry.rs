//! The one room per call, shared by everything in this process that publishes into it.
//!
//! # Why a registry rather than an owner
//!
//! Under Cloudflare the microphone and the screen share each opened their own SFU session, because
//! the SFU keyed participants by session and a second one was the only way to publish twice. LiveKit
//! publishes many tracks on one participant, so the two can share a single connection - and should,
//! because a second connection means a second *identity*, which is what
//! `VoiceShareSnapshot.mediaSessionId` exists to disambiguate. Desktop stops producing that case
//! entirely once both live here.
//!
//! Neither of them can own it. The voice publication's lifetime is the room membership, so it
//! outlives any share - but a share can start before the microphone is published and must not have
//! to wait for it. So the room is owned here, reference-counted, and torn down when the last holder
//! lets go.
//!
//! # Isle is not in here
//!
//! Proximity voice has no room model and stays on Cloudflare. It never asks this registry for
//! anything, and [`key_for`] has no arm for it.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::room::Room;
use crate::media::publisher::signalling::VoiceTarget;

/// A stable string for a target, used as the map key.
///
/// `None` for Isle, which does not belong here. Callers treat that as "this target has no LiveKit
/// room" rather than as an error, which is what keeps the Isle path free of LiveKit vocabulary.
pub fn key_for(target: &VoiceTarget) -> Option<String> {
    match target {
        VoiceTarget::GuildChannel {
            guild_id,
            channel_id,
        } => Some(format!("guild:{guild_id}:{channel_id}")),
        VoiceTarget::Call { call_id } => Some(format!("call:{call_id}")),
        VoiceTarget::Isle => None,
    }
}

struct Entry {
    room: Arc<Room>,
    /// How many holders. The room closes when this reaches zero, not when any one of them stops.
    holders: usize,
}

fn rooms() -> &'static Mutex<HashMap<String, Entry>> {
    static ROOMS: std::sync::OnceLock<Mutex<HashMap<String, Entry>>> = std::sync::OnceLock::new();
    ROOMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Take a reference to the room for `key`, connecting it if this is the first holder.
///
/// `url` and `token` are only consulted when a connection is actually opened. A second caller
/// joining an existing room gets the live one and its own credentials are ignored, which is correct:
/// two holders of one membership share one connection by definition, and the first one's token is
/// the one the SFU already accepted.
pub async fn acquire(key: &str, url: &str, token: &str) -> Result<Arc<Room>, String> {
    let mut rooms = rooms().lock().await;

    if let Some(entry) = rooms.get_mut(key) {
        // **A room whose signal has ended is not a room to join.** Handing it back is how a single
        // dropped connection became a permanent lockout: the key is `guild:{guild}:{channel}`, so
        // every rejoin to that channel found the same dead room, published a microphone nothing
        // would announce, and subscribed to tracks that would never be offered - while both peer
        // connections still read `Connected`, because ICE cannot see a closed WebSocket.
        //
        // Evicting is not reconnecting. `resume.rs` is still unwired (spec §4.1), and a room that
        // drops mid-call still ends that call. What this buys is that the *next* attempt starts
        // from a fresh connection instead of inheriting the last one's corpse.
        //
        // The evicted entry is dropped rather than closed: closing is async and this holds the
        // registry lock, and any holder still referencing it releases it by the usual path. Their
        // `release` finds nothing and returns `None`, which is already the harmless case.
        if entry.room.signal_is_closed() {
            rooms.remove(key);
        } else {
            entry.holders += 1;
            return Ok(entry.room.clone());
        }
    }

    let room = Arc::new(Room::connect(url, token).await?);
    rooms.insert(
        key.to_string(),
        Entry {
            room: room.clone(),
            holders: 1,
        },
    );
    Ok(room)
}

/// Let go of the room for `key`. The last holder out closes it.
///
/// Returns the room to close, if this was the last holder - closing is left to the caller because it
/// is async and this must not hold the registry lock across it. A caller that drops the returned
/// value simply leaks the connection until the process ends, so it is `#[must_use]`.
#[must_use = "the last holder must close the room it is handed back"]
pub async fn release(key: &str) -> Option<Arc<Room>> {
    let mut rooms = rooms().lock().await;

    let entry = rooms.get_mut(key)?;
    entry.holders = entry.holders.saturating_sub(1);
    if entry.holders > 0 {
        return None;
    }

    rooms.remove(key).map(|entry| entry.room)
}

/// Whether a room is currently held for `key`. Diagnostics only.
pub async fn is_held(key: &str) -> bool {
    rooms().lock().await.contains_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guild_and_call_targets_get_distinct_keys() {
        let guild = key_for(&VoiceTarget::GuildChannel {
            guild_id: "g1".into(),
            channel_id: "c1".into(),
        });
        let call = key_for(&VoiceTarget::Call {
            call_id: "c1".into(),
        });

        assert_eq!(guild.as_deref(), Some("guild:g1:c1"));
        assert_eq!(call.as_deref(), Some("call:c1"));
        // A guild channel and a call sharing an id must not collide - they are different rooms, and
        // a shared key would have one hand back the other's connection.
        assert_ne!(guild, call);
    }

    #[test]
    fn isle_has_no_room() {
        // Not an error. Proximity voice keeps its Cloudflare session and never reaches this map.
        assert_eq!(key_for(&VoiceTarget::Isle), None);
    }

    /// A dead room is never handed to the next joiner.
    ///
    /// **This is the lockout**, and it is the reason the fix lives here rather than in the session
    /// layer. The signal drops - a restart elsewhere, a server-side eviction, a network blip - and
    /// the pump stops. Nothing else changes: both peer connections still report `Connected`, because
    /// ICE cannot see a closed WebSocket. So the room looks perfectly healthy to everything above it
    /// and stays in this map, keyed by channel, and every rejoin to that channel gets it back and
    /// publishes into a connection the server stopped listening to.
    ///
    /// The real signal is closed here rather than faked, so this also asserts the wiring: that the
    /// pump ending is what sets the flag. A stub would pass with `Room::connect` never spawning it.
    #[tokio::test]
    #[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
    async fn a_room_whose_signal_has_ended_is_replaced_rather_than_rejoined() {
        use crate::media::livekit::room_tests::{dev_token, DEV_URL};

        let key = "guild:evict:me";
        let first = acquire(key, DEV_URL, &dev_token("lk-evict", "user-1"))
            .await
            .expect("the first join connects");

        // Straight from a live room to a dead one, the way a dropped connection does it.
        first.close_signal().await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !first.signal_is_closed() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the pump must notice its signal closing");

        let second = acquire(key, DEV_URL, &dev_token("lk-evict", "user-1"))
            .await
            .expect("the rejoin must connect rather than inherit");

        assert!(
            !Arc::ptr_eq(&first, &second),
            "the rejoin was handed the same dead room, which is the lockout this prevents"
        );
        assert!(!second.signal_is_closed(), "the replacement must be live");

        if let Some(room) = release(key).await {
            drop(room);
        }
    }

    #[tokio::test]
    async fn releasing_a_key_that_was_never_held_is_harmless() {
        // The teardown path runs on failure as well as on success, so it is reached with nothing
        // acquired more often than one would think.
        assert!(release("guild:never:held").await.is_none());
        assert!(!is_held("guild:never:held").await);
    }
}
