//! "I am still here", said by the process the operating system cannot freeze.
//!
//! # The failure this exists to prevent
//!
//! Alt-tab away from the app while screen sharing and the *other participant's* tile of your stream
//! used to disappear, permanently, while your own client showed nothing wrong.
//!
//! Room membership is asserted by a heartbeat, and every heartbeat this client had lived in the
//! webview on a `setInterval`. Once a page has been hidden for a few minutes Chromium's intensive
//! throttling aligns timer wake-ups to one-minute boundaries no matter what delay the page asked
//! for, and page freezing can withhold them entirely. So the SignalR ping missed the hub's timeout,
//! the hub declared the client gone, the server shortened the voice liveness key to its 45s
//! disconnect grace, the equally throttled `voice.Heartbeat` missed that too, and the sweep evicted
//! a participant whose screen share was still being encoded and sent - from *here*, in Rust, which
//! is why the sharer saw nothing wrong. The webview's own preview never stopped.
//!
//! The webview timeouts were widened as well (`realtime-connection.service.ts`), but widening a
//! deadline only buys margin: the renderer's clock is still the platform's to withhold. This is the
//! half that removes the dependency. Rust holds the voice publication for exactly as long as the
//! user is in the room, and nothing freezes this process, so the assertion is made from here on a
//! tokio timer that keeps its promises whatever the window is doing.
//!
//! # Why the voice publication owns it, and not the screen share
//!
//! The obvious place looks like the screen publisher, since a lost screen share is what was
//! reported. It is the wrong owner twice over: a share is optional, so a user in a channel with no
//! share would assert nothing and be swept exactly as before, and a share is shorter-lived than the
//! call, so the ping would stop while the user was still in the room. The voice publication's
//! lifetime *is* the membership being asserted, which makes it the only correct owner.
//!
//! # Isle is not on this contract
//!
//! Proximity voice has no room model - no participant list, no sweep, no `/alive` endpoint - and
//! was deliberately left on its own Cloudflare-shaped surface. [`Signalling::alive_url`] answers
//! `None` for it and [`Liveness::start`] then spawns nothing at all, so an Isle session costs no
//! task and sends no request.

use std::time::Duration;

use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;

use crate::media::publisher::signalling::{AliveError, Signalling};

/// How often the room is told we are still in it.
///
/// The server's liveness TTL is 90s and the disconnect grace is 45s. 30s therefore survives one
/// lost request inside even the shorter of the two windows, which is the case that matters: the
/// short window is the one in force after a hub blip, and a hub blip is exactly the moment a
/// request is most likely to be lost. A slower ping would fit the 90s TTL and miss the 45s one.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// A running liveness ping, stopped by dropping it.
///
/// Holds an [`AbortHandle`] rather than the `JoinHandle`, because stopping has to work through an
/// `Arc` - the publication that owns this is shared - and `abort` takes `&self` where `await`ing a
/// join handle would need ownership and an async context. Nothing waits for the task to wind down:
/// there is no cleanup to do, and the whole point is that a room we have left hears nothing more
/// from us, which abort delivers immediately.
pub struct Liveness {
    task: AbortHandle,
}

impl Liveness {
    /// Begin asserting liveness for the room `signalling` addresses.
    ///
    /// `None` when the target has no room to assert against, which today means Isle. The caller
    /// stores an `Option` either way, so the two cases cost the same and neither can be forgotten.
    ///
    /// Takes an owned [`Signalling`] of its own rather than borrowing the publication's. The
    /// publication moves its client in and does not hand it back, and a ping that outlived or
    /// under-lived the publication by sharing one would be worse than a second `reqwest::Client`,
    /// which is itself a pooled handle and cheap to hold.
    pub fn start(signalling: Signalling) -> Option<Self> {
        let url = signalling.alive_url()?;
        eprintln!("[voice] asserting liveness at {url} every {PING_INTERVAL:?}");
        let task = tokio::spawn(run(signalling)).abort_handle();
        Some(Self { task })
    }

    /// Stop pinging now.
    ///
    /// Called explicitly on the teardown path as well as running from [`Drop`]. Belt and braces on
    /// purpose: a publication is behind an `Arc`, so a command holding a clone can delay the drop
    /// past the moment the user left, and the one thing this must never do is tell the server we
    /// are in a room we have left. That would keep a ghost participant in the roster for other
    /// people until the ping stopped.
    pub fn stop(&self) {
        self.task.abort();
    }

    /// Whether the task has ended. Test-facing; production code stops it and does not ask.
    #[cfg(test)]
    fn is_running(&self) -> bool {
        !self.task.is_finished()
    }
}

impl Drop for Liveness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The ping loop.
///
/// Never returns on its own and has no error path out: every failure is swallowed after logging,
/// because this runs alongside a live call and there is no failure here worth ending one over. A
/// dropped request means one missed assertion inside a window sized to absorb it; a rejection means
/// the server disagrees about the room, which the next tick cannot fix but which also does not make
/// the audio and video currently flowing any less real. Tearing the media down on either would turn
/// a transient backend hiccup into a dropped call, which is a strictly worse outcome than the bug
/// this file exists to fix.
async fn run(signalling: Signalling) {
    let mut ticker = tokio::time::interval(PING_INTERVAL);
    // A machine resuming from sleep has missed several ticks. `Delay` spaces the catch-up out;
    // the default `Burst` would fire them back to back, which asserts nothing extra and arrives as
    // a small spike of identical requests at the exact moment the backend is fielding everybody
    // else's reconnect.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        // The first tick completes immediately, so membership is asserted as soon as the
        // publication is attached rather than 30 seconds into the call. That opening gap is small
        // but it is real: a rejoin lands inside the previous session's grace window.
        ticker.tick().await;

        match signalling.assert_alive().await {
            Ok(()) => {}
            // Logged distinctly because it is not a fault, it is a disagreement: the server does
            // not place this device in this room. Media keeps flowing regardless - see the note on
            // this function - but this is the line that explains a room which has stopped showing
            // us to other people, and without it the symptom is invisible from this side.
            Err(e @ AliveError::NotOurRoom(_)) => {
                eprintln!("[voice] liveness rejected: {e}");
            }
            Err(e) => eprintln!("[voice] liveness ping failed, retrying next tick: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::publisher::signalling::{SessionRole, VoiceTarget};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn signalling(target: VoiceTarget) -> Signalling {
        Signalling::new(
            "https://api.example.test".into(),
            "tok".into(),
            "dev-1".into(),
            target,
            SessionRole::Primary,
        )
        .unwrap()
    }

    /// Isle must cost nothing at all here, not merely fail quietly: no task, no timer, no request.
    /// Asserted on the absence of a `Liveness` rather than on log output, because "spawned a task
    /// that errors every 30 seconds forever" would pass any test that only checked for silence.
    #[tokio::test]
    async fn isle_starts_no_ping_at_all() {
        assert!(Liveness::start(signalling(VoiceTarget::Isle)).is_none());
    }

    #[tokio::test]
    async fn a_guild_channel_starts_a_ping() {
        let liveness = Liveness::start(signalling(VoiceTarget::GuildChannel {
            guild_id: "g1".into(),
            channel_id: "c1".into(),
        }));
        assert!(liveness.is_some());
    }

    #[tokio::test]
    async fn a_call_starts_a_ping() {
        let liveness = Liveness::start(signalling(VoiceTarget::Call {
            call_id: "call-1".into(),
        }));
        assert!(liveness.is_some());
    }

    /// A stand-in for the real loop: same shape - tick, do work, forever - with a counter where the
    /// HTTP request would be, so the stopping behaviour is testable without a server. Driving the
    /// real `run` here would test reqwest's error handling, not this file's.
    fn counting_liveness(counter: Arc<AtomicUsize>) -> Liveness {
        let task = tokio::spawn(async move {
            loop {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .abort_handle();
        Liveness { task }
    }

    /// The guarantee the whole design rests on: a ping for a room the user has left must never go
    /// out. The publication is dropped when the engine unpublishes the slot, and dropping it has to
    /// be enough on its own - there is no other teardown hook on that path.
    #[tokio::test]
    async fn dropping_it_stops_the_ping() {
        let counter = Arc::new(AtomicUsize::new(0));
        let liveness = counting_liveness(Arc::clone(&counter));

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(counter.load(Ordering::SeqCst) > 0, "the ping never started");

        drop(liveness);
        // Let the abort land, then take the reading everything after must match.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let after_drop = counter.load(Ordering::SeqCst);

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            counter.load(Ordering::SeqCst),
            after_drop,
            "a dropped Liveness went on asserting membership of a room the user has left"
        );
    }

    /// The explicit path, used by `Engine::unpublish` so the ping stops the moment the user leaves
    /// rather than whenever the last `Arc<Publication>` clone happens to go away.
    #[tokio::test]
    async fn stopping_it_explicitly_stops_the_ping() {
        let counter = Arc::new(AtomicUsize::new(0));
        let liveness = counting_liveness(Arc::clone(&counter));

        tokio::time::sleep(Duration::from_millis(20)).await;
        liveness.stop();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let after_stop = counter.load(Ordering::SeqCst);

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(counter.load(Ordering::SeqCst), after_stop);
        assert!(!liveness.is_running());
    }

    /// Stopping twice, and stopping something already dropped, must not panic - `unpublish` stops
    /// it and then drops it, so the double call is the normal path, not an edge case.
    #[tokio::test]
    async fn stopping_twice_is_harmless() {
        let liveness = counting_liveness(Arc::new(AtomicUsize::new(0)));
        liveness.stop();
        liveness.stop();
        drop(liveness);
    }
}
