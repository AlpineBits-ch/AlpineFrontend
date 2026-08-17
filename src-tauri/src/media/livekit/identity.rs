//! Who a LiveKit participant is, in our terms.
//!
//! The SFU names participants by an opaque string. Ours is the user id on a primary connection and
//! `{userId}#{tag}` on a secondary, and the `#` is guaranteed safe to split on: user ids are Sqids
//! and never contain one, and the server strips any `#` out of the tag before appending it.
//!
//! That guarantee is what lets a receiving client map a remote participant to a user **without
//! consulting the snapshot** - which matters because tracks can arrive before a snapshot does, and a
//! client that cannot name their owner has to drop them.

/// The tag a secondary connection falls back to when nothing usable is left after sanitising.
///
/// Matches the server. A client that computed a different fallback would predict the wrong identity
/// for its own second connection, which is exactly the string it needs in order to recognise
/// its own tracks coming back.
const FALLBACK_TAG: &str = "alt";

/// The longest tag the server keeps. Anything beyond this is truncated rather than rejected.
const MAX_TAG: usize = 32;

/// A tag as the server will store it: letters and digits only, truncated, never empty.
///
/// Sanitised here as well as server-side, deliberately. This is not defensive duplication - it is
/// how a caller can know what its own identity will be *before* the connection reply arrives, and
/// the alternative is waiting for a round trip to learn a string we already determine.
pub fn sanitize_tag(tag: &str) -> String {
    let kept: String = tag
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(MAX_TAG)
        .collect();
    if kept.is_empty() {
        FALLBACK_TAG.to_string()
    } else {
        kept
    }
}

/// The identity a connection will be given.
///
/// `None` is the primary connection and is the bare user id - **not** `{userId}#primary`. One tag
/// per user per room: two connections sharing a tag share an identity, and the SFU disconnects the
/// earlier one, so a screen connection minted under the same tag as the view connection would kick
/// the client's own room off the air.
pub fn identity_for(user_id: &str, tag: Option<&str>) -> String {
    match tag {
        None => user_id.to_string(),
        Some(tag) => format!("{user_id}#{}", sanitize_tag(tag)),
    }
}

/// The user behind an identity, primary or secondary.
///
/// Splits on the **first** `#`. A later one can only be inside a tag the server should have
/// stripped, and splitting on the last would then hand back a user id with part of a tag glued to
/// it - a participant silently attributed to nobody.
pub fn user_of(identity: &str) -> &str {
    match identity.find('#') {
        Some(at) => &identity[..at],
        None => identity,
    }
}

/// Whether this identity is a secondary connection.
pub fn is_secondary(identity: &str) -> bool {
    identity.contains('#')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_primary_identity_is_the_bare_user_id() {
        // Not `user-1#primary`. The roster records this string as `mediaSessionId`, and a decorated
        // one would not match the participant the server announces.
        assert_eq!(identity_for("user-1", None), "user-1");
        assert_eq!(user_of("user-1"), "user-1");
        assert!(!is_secondary("user-1"));
    }

    #[test]
    fn a_secondary_identity_carries_its_tag() {
        assert_eq!(identity_for("user-1", Some("view")), "user-1#view");
        assert_eq!(user_of("user-1#view"), "user-1");
        assert!(is_secondary("user-1#view"));
    }

    #[test]
    fn the_split_takes_the_first_hash_not_the_last() {
        // The server strips `#` from tags, so a second one should be impossible - but splitting on
        // the last would attribute this participant to `user-1#view`, which is nobody.
        assert_eq!(user_of("user-1#view#extra"), "user-1");
    }

    #[test]
    fn a_sqid_user_id_survives_untouched() {
        // Sqids are alphanumeric and never contain `#`, which is the whole basis for splitting on
        // it. If this ever fails, the identity scheme is broken rather than this function.
        for id in ["Uk1sRT", "bM2cD9xQ", "1"] {
            assert_eq!(user_of(id), id);
            assert_eq!(identity_for(id, None), id);
        }
    }

    #[test]
    fn a_tag_is_reduced_to_letters_and_digits() {
        assert_eq!(sanitize_tag("view"), "view");
        assert_eq!(sanitize_tag("screen-2"), "screen2");
        assert_eq!(sanitize_tag("a b#c"), "abc");
    }

    #[test]
    fn a_tag_with_nothing_usable_falls_back_rather_than_vanishing() {
        // An empty tag would produce `user-1#`, which splits to the right user but is not the
        // identity the server minted - so the two ends would disagree about our own name.
        assert_eq!(sanitize_tag("---"), "alt");
        assert_eq!(identity_for("user-1", Some("!!")), "user-1#alt");
    }

    #[test]
    fn a_long_tag_is_truncated_to_what_the_server_keeps() {
        let long = "v".repeat(64);
        assert_eq!(sanitize_tag(&long).len(), 32);
    }

    #[test]
    fn a_hash_inside_a_tag_cannot_forge_a_second_separator() {
        // Sanitising strips it, so the identity has exactly one `#` and `user_of` is unambiguous.
        let identity = identity_for("user-1", Some("vi#ew"));
        assert_eq!(identity, "user-1#view");
        assert_eq!(user_of(&identity), "user-1");
    }
}
