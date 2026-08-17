//! The arbiter: one source of truth for what this machine is doing.
//!
//! Several detectors can be running at once -the RPC server ([`super::ipc`]), the process scanner,
//! and later the media session and the Isle bridge. Each of them knows only its own half. The
//! arbiter merges them by priority (`Rpc > Native > ProcessScan > Media`), deduplicates, caps the
//! result at [`MAX_ACTIVITIES`], and emits `presence://changed` **only when the merged result
//! actually changes**.
//!
//! "Only on change" is the load-bearing part. The frontend's outbound `PUT me/activity` is
//! coalesced to one per 15 s, but every emit still costs an IPC hop, a signal write and a change
//! detection pass; a detector that re-reports the same game every few seconds would spend all of
//! them for nothing. It is also what lets the Angular layer stop polling: an event channel that only
//! speaks when something happened is a channel you can trust as the sole input.
//!
//! ## Emitting is not gated on privacy here
//!
//! `ShareActivity` and the per-game opt-outs are applied in `RichPresenceService.publishable` before
//! anything leaves the machine, and again -authoritatively -server-side. The arbiter deliberately
//! reports everything it detects, because the settings page has to be able to list the games it has
//! seen in order to offer a toggle for them.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use super::model::{Activity, ActivitySource, ActivityType, MAX_ACTIVITIES};

/// The Tauri event the Angular layer already listens for. Payload is `Activity[]`; an empty array
/// clears.
pub const EVENT: &str = "presence://changed";

/// Shown when an RPC activity carries no name and nothing else can supply one.
///
/// A `SET_ACTIVITY` payload almost never has a `name` -Discord resolves it from the application id,
/// and so does our server, which discards whatever we send. This string therefore only ever reaches
/// a renderer for the instant between a game connecting and the server answering.
const UNNAMED: &str = "Game";

/// Where a merged activity list goes. A trait rather than a bare `AppHandle` so the merge rules can
/// be tested without a Tauri runtime -which is most of what is worth testing here.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, activities: &[Activity]);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl Sink for tauri::AppHandle {
    fn emit(&self, activities: &[Activity]) {
        use tauri::Emitter;
        // A failed emit means the webview is gone, which is not something this side can act on.
        let _ = Emitter::emit(self, EVENT, activities);
    }
}

#[derive(Default)]
struct Inner {
    /// Keyed by connection id, not by application id: two copies of the same game (two Steam
    /// accounts, a game and its launcher) are two connections and each owns its own slot, and a
    /// disconnect must remove exactly the one that went away. `BTreeMap` so the merge order is the
    /// connection order rather than whatever a hash gives us today.
    rpc: BTreeMap<u64, Activity>,
    native: Vec<Activity>,
    process_scan: Vec<Activity>,
    media: Vec<Activity>,
    manual: Vec<Activity>,
    /// The last list handed to the sink. Compared against, never emitted from.
    emitted: Vec<Activity>,
}

pub struct Arbiter {
    sink: Box<dyn Sink>,
    inner: Mutex<Inner>,
}

impl Arbiter {
    pub fn new(sink: impl Sink) -> Self {
        Self {
            sink: Box::new(sink),
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Records (or clears) one RPC connection's activity.
    ///
    /// `started_at` is made sticky here as well as server-side: as long as the connection keeps
    /// reporting the same `(type, name, application_id)`, the first stamp is preserved. Without it,
    /// a game that re-sends its activity every 15 s would restamp the clock every 15 s and the
    /// elapsed timer would read "a few seconds" forever -the single easiest thing to get wrong in
    /// this feature, and it is wrong in both directions if only one layer handles it.
    pub fn set_rpc(&self, connection: u64, activity: Option<Activity>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match activity {
            None => {
                inner.rpc.remove(&connection);
            }
            Some(mut activity) => {
                let previous = inner.rpc.get(&connection);
                activity.started_at = sticky_start(previous, &activity);
                inner.rpc.insert(connection, activity);
            }
        }
        self.publish(&mut inner);
    }

    /// Replaces everything a non-RPC source is reporting.
    ///
    /// Passing [`ActivitySource::Rpc`] here is a no-op: RPC activities are keyed by connection and
    /// go through [`Arbiter::set_rpc`], so a wholesale replace would silently drop the mapping that
    /// makes a disconnect removable.
    pub fn set_source(&self, source: ActivitySource, activities: Vec<Activity>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let slot = match source {
            ActivitySource::Rpc => return,
            ActivitySource::Native => &mut inner.native,
            ActivitySource::ProcessScan => &mut inner.process_scan,
            ActivitySource::Media => &mut inner.media,
            ActivitySource::Manual => &mut inner.manual,
        };

        // Same stickiness rule as the RPC path, matched positionally against what this source last
        // reported. A process scanner that re-reports the same game every 15 s must not restamp it.
        let previous = std::mem::take(slot);
        *slot = activities
            .into_iter()
            .map(|mut activity| {
                let matching = previous
                    .iter()
                    .find(|old| old.identity() == activity.identity());
                activity.started_at = sticky_start(matching, &activity);
                activity
            })
            .collect();

        self.publish(&mut inner);
    }

    /// The current merged list, for a caller that wants to read rather than be told.
    pub fn current(&self) -> Vec<Activity> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        merge(&inner)
    }

    fn publish(&self, inner: &mut Inner) {
        let merged = merge(inner);
        if merged == inner.emitted {
            return;
        }
        inner.emitted = merged.clone();
        // Emitted under the lock on purpose: two detectors updating concurrently must not be able
        // to deliver their events in the opposite order to the states they wrote.
        self.sink.emit(&merged);
    }
}

/// Keeps the earlier stamp when the activity has not really changed, otherwise takes what the
/// source gave us, otherwise stamps now.
fn sticky_start(previous: Option<&Activity>, next: &Activity) -> Option<i64> {
    if let Some(previous) = previous {
        if previous.identity() == next.identity() {
            // The source's own stamp still wins if it has one -a game that reports a real match
            // start time knows better than we do.
            return next.started_at.or(previous.started_at);
        }
    }
    next.started_at.or_else(|| Some(super::model::now_ms()))
}

/// The name a nameless activity may take from a process-scan sighting, if any may.
///
/// <b>Only from a sighting of the same application.</b> An RPC payload carries no name because
/// Discord resolves it centrally from the application id, so borrowing one is the only way an
/// RPC-reported game gets a label before the server answers - but the id is exactly what says
/// *which* game, and it has to be checked.
///
/// The bug this closes: any nameless RPC activity used to take the name of whatever process scanning
/// had found. Start Microsoft Flight Simulator, then start Volanta - a flight tracker that publishes
/// its own rich presence - and Volanta's connection was relabelled "Microsoft Flight Simulator 2024".
/// The dedup below then saw the real sighting as a duplicate of it and dropped it, so one
/// application's activity silently replaced another's and the game disappeared from the panel. Two
/// unrelated applications running at once is the ordinary case, not an exotic one.
fn borrowed_name(inner: &Inner, activity: &Activity) -> Option<String> {
    let application_id = activity.application_id.as_deref()?;

    inner
        .process_scan
        .iter()
        .find(|sighting| sighting.application_id.as_deref() == Some(application_id))
        .map(|sighting| sighting.name.clone())
        .filter(|name| !name.is_empty())
}

/// Merges every source into the list the frontend receives.
fn merge(inner: &Inner) -> Vec<Activity> {
    let ordered: [&[Activity]; 4] = [&inner.native, &inner.process_scan, &inner.media, &inner.manual];
    let mut candidates: Vec<&Activity> = inner.rpc.values().collect();
    let mut rest: Vec<&Activity> = ordered.iter().flat_map(|slice| slice.iter()).collect();
    // The Rpc bucket is already first; the remaining four sort among themselves by priority. A
    // stable sort keeps each source's own ordering intact within its band.
    rest.sort_by_key(|activity| activity.source.priority());
    candidates.extend(rest);

    let mut seen: HashSet<(ActivityType, String)> = HashSet::new();
    let mut merged = Vec::with_capacity(MAX_ACTIVITIES);

    for activity in candidates {
        let mut activity = activity.clone();
        if activity.name.is_empty() {
            activity.name = borrowed_name(inner, &activity).unwrap_or_else(|| UNNAMED.to_owned());
        }

        // Deduplicated by `(type, name)`, deliberately *not* including the application id: the whole
        // point is that the RPC report and the process-scan sighting of one game collapse into one
        // entry.
        //
        // A *placeholder* name is keyed by application id instead. Two applications that both failed
        // to name themselves are two activities, not one, and keying them both on "Game" would hide
        // whichever arrived second.
        let key = if activity.name == UNNAMED {
            activity
                .application_id
                .clone()
                .unwrap_or_else(|| UNNAMED.to_owned())
        } else {
            activity.name.to_lowercase()
        };

        if !seen.insert((activity.kind, key)) {
            continue;
        }

        merged.push(activity);
        if merged.len() == MAX_ACTIVITIES {
            break;
        }
    }

    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Clone, Default)]
    struct Recorder(Arc<StdMutex<Vec<Vec<Activity>>>>);

    impl Recorder {
        fn emissions(&self) -> Vec<Vec<Activity>> {
            self.0.lock().unwrap().clone()
        }

        fn count(&self) -> usize {
            self.0.lock().unwrap().len()
        }

        fn last(&self) -> Vec<Activity> {
            self.0.lock().unwrap().last().cloned().unwrap_or_default()
        }
    }

    impl Sink for Recorder {
        fn emit(&self, activities: &[Activity]) {
            self.0.lock().unwrap().push(activities.to_vec());
        }
    }

    fn activity(name: &str, source: ActivitySource) -> Activity {
        Activity {
            kind: ActivityType::Playing,
            name: name.into(),
            details: None,
            state: None,
            // A process-scan sighting carries one too, and always has since `detect` started
            // resolving matches against the catalog - `Match` cannot exist without an application
            // id. This helper used to hand `ProcessScan` a `None`, which is why nothing here
            // noticed that name-borrowing ignored the id entirely.
            application_id: match source {
                ActivitySource::Rpc | ActivitySource::ProcessScan => Some("356875221078245376".into()),
                _ => None,
            },
            started_at: Some(1_754_300_000_000),
            ends_at: None,
            assets: None,
            party: None,
            source,
        }
    }

    fn arbiter() -> (Arbiter, Recorder) {
        let recorder = Recorder::default();
        (Arbiter::new(recorder.clone()), recorder)
    }

    #[test]
    fn nothing_is_emitted_until_something_is_detected() {
        let (arbiter, recorder) = arbiter();
        arbiter.set_source(ActivitySource::ProcessScan, Vec::new());
        arbiter.set_rpc(1, None);
        assert_eq!(recorder.count(), 0);
        assert!(arbiter.current().is_empty());
    }

    #[test]
    fn an_unchanged_report_does_not_emit_again() {
        let (arbiter, recorder) = arbiter();

        arbiter.set_source(
            ActivitySource::ProcessScan,
            vec![activity("Overwatch", ActivitySource::ProcessScan)],
        );
        assert_eq!(recorder.count(), 1);

        // The same sighting, five more times. This is exactly what a 15 s scanner does.
        for _ in 0..5 {
            arbiter.set_source(
                ActivitySource::ProcessScan,
                vec![activity("Overwatch", ActivitySource::ProcessScan)],
            );
        }
        assert_eq!(recorder.count(), 1);

        // A real change does emit.
        arbiter.set_source(
            ActivitySource::ProcessScan,
            vec![activity("Deep Rock Galactic", ActivitySource::ProcessScan)],
        );
        assert_eq!(recorder.count(), 2);

        // And so does going away.
        arbiter.set_source(ActivitySource::ProcessScan, Vec::new());
        assert_eq!(recorder.count(), 3);
        assert!(recorder.last().is_empty());
    }

    #[test]
    fn rpc_outranks_process_scan_for_the_same_game() {
        let (arbiter, recorder) = arbiter();

        arbiter.set_source(
            ActivitySource::ProcessScan,
            vec![activity("Overwatch", ActivitySource::ProcessScan)],
        );
        arbiter.set_rpc(7, Some(activity("Overwatch", ActivitySource::Rpc)));

        let merged = recorder.last();
        // Deduplicated to one entry, and the richer source is the one that survived.
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, ActivitySource::Rpc);
        assert!(merged[0].application_id.is_some());
    }

    #[test]
    fn dedup_is_case_insensitive_on_name() {
        let (arbiter, _recorder) = arbiter();
        arbiter.set_source(
            ActivitySource::ProcessScan,
            vec![activity("overwatch", ActivitySource::ProcessScan)],
        );
        arbiter.set_rpc(1, Some(activity("Overwatch", ActivitySource::Rpc)));
        assert_eq!(arbiter.current().len(), 1);
    }

    #[test]
    fn sources_are_ordered_rpc_native_process_scan_media() {
        let (arbiter, _recorder) = arbiter();

        arbiter.set_source(
            ActivitySource::Media,
            vec![activity("Spotify", ActivitySource::Media)],
        );
        arbiter.set_source(
            ActivitySource::ProcessScan,
            vec![activity("Overwatch", ActivitySource::ProcessScan)],
        );
        arbiter.set_source(
            ActivitySource::Native,
            vec![activity("Isle", ActivitySource::Native)],
        );
        arbiter.set_rpc(3, Some(activity("Deep Rock Galactic", ActivitySource::Rpc)));

        let merged = arbiter.current();
        // Capped at three, in priority order, so Media is the one that loses its seat.
        assert_eq!(merged.len(), MAX_ACTIVITIES);
        assert_eq!(
            merged
                .iter()
                .map(|a| a.source)
                .collect::<Vec<_>>(),
            vec![
                ActivitySource::Rpc,
                ActivitySource::Native,
                ActivitySource::ProcessScan
            ]
        );
    }

    #[test]
    fn several_rpc_connections_each_keep_a_slot_and_a_disconnect_removes_only_its_own() {
        let (arbiter, _recorder) = arbiter();

        arbiter.set_rpc(1, Some(activity("Overwatch", ActivitySource::Rpc)));
        arbiter.set_rpc(2, Some(activity("Deep Rock Galactic", ActivitySource::Rpc)));
        assert_eq!(arbiter.current().len(), 2);

        arbiter.set_rpc(1, None);
        let merged = arbiter.current();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "Deep Rock Galactic");
    }

    #[test]
    fn an_rpc_activity_with_no_name_borrows_the_process_scan_name() {
        let (arbiter, _recorder) = arbiter();

        arbiter.set_source(
            ActivitySource::ProcessScan,
            vec![activity("Overwatch", ActivitySource::ProcessScan)],
        );
        let mut unnamed = activity("", ActivitySource::Rpc);
        unnamed.details = Some("Competitive".into());
        arbiter.set_rpc(1, Some(unnamed));

        let merged = arbiter.current();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "Overwatch");
        assert_eq!(merged[0].source, ActivitySource::Rpc);
        assert_eq!(merged[0].details.as_deref(), Some("Competitive"));
    }

    /// The reported bug, in the shape it was reported: Microsoft Flight Simulator detected by
    /// process scanning, then Volanta - a separate application with its own rich presence - connects
    /// over RPC. Volanta must not be relabelled as the game, and the game must not disappear.
    #[test]
    fn an_unnamed_rpc_activity_never_takes_another_applications_name() {
        let (arbiter, _recorder) = arbiter();

        let mut game = activity("Microsoft Flight Simulator 2024", ActivitySource::ProcessScan);
        game.application_id = Some("1308492082369003631".into());
        arbiter.set_source(ActivitySource::ProcessScan, vec![game]);

        let mut volanta = activity("", ActivitySource::Rpc);
        volanta.application_id = Some("1293582351376584824".into());
        volanta.details = Some("Idle".into());
        arbiter.set_rpc(1, Some(volanta));

        let merged = arbiter.current();

        assert_eq!(merged.len(), 2, "both applications survive the merge");

        let volanta = merged
            .iter()
            .find(|a| a.application_id.as_deref() == Some("1293582351376584824"))
            .expect("the RPC application is still present");
        assert_eq!(volanta.name, UNNAMED, "it may not wear the game's name");
        assert_eq!(volanta.details.as_deref(), Some("Idle"));

        let game = merged
            .iter()
            .find(|a| a.application_id.as_deref() == Some("1308492082369003631"))
            .expect("the detected game was not deduplicated away");
        assert_eq!(game.name, "Microsoft Flight Simulator 2024");
    }

    /// Two applications that both failed to name themselves are two activities.
    #[test]
    fn two_unnamed_applications_do_not_collapse_into_one() {
        let (arbiter, _recorder) = arbiter();

        let mut first = activity("", ActivitySource::Rpc);
        first.application_id = Some("1293582351376584824".into());
        let mut second = activity("", ActivitySource::Rpc);
        second.application_id = Some("1111111111111111111".into());

        arbiter.set_rpc(1, Some(first));
        arbiter.set_rpc(2, Some(second));

        assert_eq!(arbiter.current().len(), 2);
    }

    #[test]
    fn an_unnamed_rpc_activity_with_no_process_scan_still_renders() {
        let (arbiter, _recorder) = arbiter();
        arbiter.set_rpc(1, Some(activity("", ActivitySource::Rpc)));

        let merged = arbiter.current();
        assert_eq!(merged.len(), 1);
        // Never empty: the TypeScript contract makes `name` required, and an empty subtitle reads
        // as a broken row rather than a minimal one.
        assert_eq!(merged[0].name, UNNAMED);
        assert!(merged[0].application_id.is_some());
    }

    #[test]
    fn started_at_is_sticky_across_repeated_reports() {
        let (arbiter, recorder) = arbiter();

        let mut first = activity("Overwatch", ActivitySource::Rpc);
        first.started_at = Some(1_754_300_000_000);
        arbiter.set_rpc(1, Some(first));

        // The same activity again, this time with no timestamp at all -which is what a game that
        // only sets details/state re-sends.
        let mut second = activity("Overwatch", ActivitySource::Rpc);
        second.started_at = None;
        second.state = Some("In Queue".into());
        arbiter.set_rpc(1, Some(second));

        let merged = recorder.last();
        assert_eq!(merged[0].started_at, Some(1_754_300_000_000));
        assert_eq!(merged[0].state.as_deref(), Some("In Queue"));
    }

    #[test]
    fn a_source_with_no_timestamp_is_stamped_once_and_then_held() {
        let (arbiter, _recorder) = arbiter();

        let mut scan = activity("Overwatch", ActivitySource::ProcessScan);
        scan.started_at = None;
        arbiter.set_source(ActivitySource::ProcessScan, vec![scan.clone()]);
        let stamped = arbiter.current()[0].started_at;
        assert!(stamped.is_some());

        // Re-reporting must not restamp, or the elapsed timer resets on every scan.
        arbiter.set_source(ActivitySource::ProcessScan, vec![scan]);
        assert_eq!(arbiter.current()[0].started_at, stamped);
    }

    #[test]
    fn a_different_game_gets_a_fresh_stamp() {
        let (arbiter, _recorder) = arbiter();

        let mut first = activity("Overwatch", ActivitySource::ProcessScan);
        first.started_at = Some(1_000);
        arbiter.set_source(ActivitySource::ProcessScan, vec![first]);

        let mut second = activity("Deep Rock Galactic", ActivitySource::ProcessScan);
        second.started_at = None;
        arbiter.set_source(ActivitySource::ProcessScan, vec![second]);

        let stamped = arbiter.current()[0].started_at.unwrap();
        assert!(stamped > 1_000, "a new game must not inherit the old stamp");
    }

    #[test]
    fn the_list_is_capped_at_three() {
        let (arbiter, _recorder) = arbiter();
        for id in 0..10u64 {
            arbiter.set_rpc(id, Some(activity(&format!("Game {id}"), ActivitySource::Rpc)));
        }
        assert_eq!(arbiter.current().len(), MAX_ACTIVITIES);
    }

    #[test]
    fn set_source_ignores_rpc_so_the_connection_mapping_cannot_be_clobbered() {
        let (arbiter, recorder) = arbiter();
        arbiter.set_rpc(1, Some(activity("Overwatch", ActivitySource::Rpc)));
        arbiter.set_source(ActivitySource::Rpc, Vec::new());
        assert_eq!(arbiter.current().len(), 1);
        assert_eq!(recorder.count(), 1);
    }

    #[test]
    fn every_emission_carries_the_whole_list_not_a_delta() {
        let (arbiter, recorder) = arbiter();
        arbiter.set_rpc(1, Some(activity("Overwatch", ActivitySource::Rpc)));
        arbiter.set_source(
            ActivitySource::Media,
            vec![activity("Spotify", ActivitySource::Media)],
        );

        let emissions = recorder.emissions();
        assert_eq!(emissions.len(), 2);
        assert_eq!(emissions[0].len(), 1);
        assert_eq!(emissions[1].len(), 2);
    }
}
