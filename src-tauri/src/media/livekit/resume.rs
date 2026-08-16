//! What to do when the signal connection drops.
//!
//! Separated from the room itself because it is a *policy*, and the whole of it is decidable from
//! four facts with no I/O. The room calls this and obeys; the tests below are the specification.

use std::time::Duration;

/// How long a join token is good for.
///
/// The server's default is 10 minutes (`LIVEKIT_JOIN_TOKEN_TTL_SECONDS`), which is well past any
/// reconnect ladder. Held here as the client's own assumption rather than read from the token: a
/// client that parsed the JWT would be trusting a clock it does not control, and being *early* is
/// harmless (one wasted refetch) while being late is a reconnect loop that cannot authenticate.
pub const TOKEN_TTL: Duration = Duration::from_secs(600);

/// Deliberately short of [`TOKEN_TTL`]. A token that expires between the decision and the WebSocket
/// upgrade is refused, and the retry costs more than re-fetching would have.
const REFETCH_MARGIN: Duration = Duration::from_secs(30);

/// What the room should do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resume {
    /// Reconnect with the token and URL already held. The ordinary case.
    Restart,
    /// Ask the backend for a new connection first. The token cannot be relied on any more.
    Refetch,
}

/// Whether to resume with what we hold, or ask for a new connection first.
///
/// The rule, from the migration spec §2.4:
///
/// * **The URL is never re-fetched for its own sake.** A room is placed on a node once and never
///   moved while it exists, so a resume to the same URL cannot be wrong. The registry row is dropped
///   only for a room the SFU no longer has - and that is a room there is nothing to resume into.
/// * **The token is the only expiring part**, and re-fetching one is cheap: no roster write, no
///   re-announce.
/// * **Never re-fetch per attempt.** That is the failure this function exists to prevent: a
///   reconnect ladder that mints a token on every retry asks the backend for credentials at the
///   SFU's retry rate, which is a self-inflicted load spike precisely when the network is already
///   unhappy.
///
/// `disconnected_for` is how long the signal has been down, and `token_age` how long ago the token
/// was minted - which are not the same number after a long healthy session.
pub fn resume_action(
    token_age: Duration,
    disconnected_for: Duration,
    auth_refused: bool,
) -> Resume {
    // The server has told us the credential is no good. No amount of retrying fixes that, and it is
    // the one signal that is authoritative rather than inferred.
    if auth_refused {
        return Resume::Refetch;
    }

    // Expired, or close enough that it would expire mid-handshake.
    if token_age + REFETCH_MARGIN >= TOKEN_TTL {
        return Resume::Refetch;
    }

    // A gap longer than the token's whole life means the token is expired regardless of when it was
    // minted, so this is belt-and-braces against a clock that jumped rather than a separate rule.
    if disconnected_for >= TOKEN_TTL {
        return Resume::Refetch;
    }

    Resume::Restart
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn a_fresh_token_resumes_rather_than_refetching() {
        // The ordinary reconnect: a few seconds of network trouble on a session that has just
        // started. Re-fetching here is the behaviour the policy exists to prevent.
        assert_eq!(resume_action(5 * SECOND, 2 * SECOND, false), Resume::Restart);
    }

    #[test]
    fn every_attempt_in_a_ladder_still_resumes() {
        // The same decision at 1s, 2s, 4s, 8s, 16s of a retry ladder. If any of these answered
        // `Refetch` the client would mint tokens at the SFU's retry rate.
        for attempt in [1, 2, 4, 8, 16] {
            assert_eq!(
                resume_action(30 * SECOND, attempt * SECOND, false),
                Resume::Restart,
                "attempt at {attempt}s must not re-fetch"
            );
        }
    }

    #[test]
    fn an_auth_refusal_refetches_immediately() {
        // Authoritative, and the only signal here that is. A fresh token that the server refuses is
        // still a token the server refuses.
        assert_eq!(resume_action(SECOND, SECOND, true), Resume::Refetch);
    }

    #[test]
    fn a_token_near_its_ttl_refetches_before_it_expires() {
        // 9m45s old, 15s of headroom left, and the margin is 30s - so this refetches rather than
        // racing the handshake against the expiry.
        let nearly = TOKEN_TTL - 15 * SECOND;
        assert_eq!(resume_action(nearly, SECOND, false), Resume::Refetch);
    }

    #[test]
    fn a_token_with_room_to_spare_still_resumes() {
        // Just the other side of the margin. Pinned next to the test above so the boundary is
        // visible: these two are what the margin means.
        let comfortable = TOKEN_TTL - 90 * SECOND;
        assert_eq!(resume_action(comfortable, SECOND, false), Resume::Restart);
    }

    #[test]
    fn a_gap_longer_than_the_ttl_refetches_whatever_the_token_age_says() {
        // Guards a clock that jumped or a process that was suspended: the age says "fine", the gap
        // says the token cannot possibly still be valid, and the gap wins.
        assert_eq!(resume_action(SECOND, TOKEN_TTL, false), Resume::Refetch);
    }
}
