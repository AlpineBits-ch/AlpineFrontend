//! Catalog-backed process detection.
//!
//! Replaces a 67-line hand-written CSV matched against `process.name()` with the ~10,445-game
//! catalog the server mirrors. The catalog is fetched by the Angular layer (the endpoint is
//! `[Authorize]`, so this side cannot fetch it) and handed down through
//! [`super::presence_load_catalog`]; everything below is offline.
//!
//! ## Why the matching rules are not negotiable
//!
//! Measured over the real dataset (spec §A):
//!
//! | Property | Count |
//! |---|---|
//! | Executable rules | 11,218 |
//! | Path-qualified (contain a directory component) | **9,297 — 83%** |
//! | Distinct basenames | 10,214 |
//! | Basenames claimed by more than one game | **412** |
//! | Negation rules | 9 |
//!
//! * **Matching is a path-component suffix, not a basename and not a string suffix.** Matching
//!   `process.name()` alone cannot reach 83% of the catalog; a plain `ends_with` would let
//!   `mygame.exe` satisfy a rule for `game.exe`.
//! * **An ambiguous basename resolves to nothing, never to a guess.** `game.exe` is registered by
//!   192 different games, `hl2.exe` by 34, `dosbox.exe` by 22. The failure mode being avoided is not
//!   "we miss a game", it is "we tell your friends you are playing something you have never
//!   installed".
//! * **A negated rule suppresses its game.** Nine rules, and they carry the worst false positives in
//!   the set: Minecraft negates `java`/`javaw.exe` so that running a JVM does not announce
//!   Minecraft.
//! * **A launcher loses to a non-launcher**, and on an otherwise equal tie the more path-specific
//!   rule wins.
//!
//! ## The constraint that decides whether any of this is visible
//!
//! **A `ProcessScan` activity with no `applicationId` is dropped by the server.** `ActivityWriteGuard`
//! accepts a displayed name only if it is vouched for by a resolvable application id or is
//! user-authored (`Manual`/`Media`). A catalog entry that carries no usable id is therefore not a
//! game we can report *at all*, so [`Catalog::compile`] discards it at load time rather than letting
//! it produce a match that silently dies three layers away.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::model::{self, Activity, ActivitySource, ActivityType, MAX_TEXT};

/// How often the scanner walks the process list.
pub const SCAN_INTERVAL: Duration = Duration::from_secs(15);

/// Consecutive sightings required before a match is reported.
///
/// Installers, updaters and crash handlers share executable names with the games they belong to, and
/// they are short-lived; a single sighting is not evidence that anybody is playing anything.
pub const CONFIRM_SIGHTINGS: u32 = 2;

/// How long a confirmed match is held after its process disappears.
///
/// A crash-and-relaunch, a loading screen that respawns the process, or a scan that lands during a
/// map change must not flap the presence off and on -each flap is an event, a push and a visible
/// change in every member list the user appears in.
pub const LINGER: Duration = Duration::from_secs(30);

// ── The catalog as it arrives ───────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPayload {
    /// Opaque; the server derives it from the data rather than from the seed version.
    #[serde(default)]
    version: serde_json::Value,
    #[serde(default)]
    games: Vec<PayloadGame>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadGame {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    application_id: Option<String>,
    #[serde(default)]
    rules: Vec<PayloadRule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadRule {
    #[serde(default)]
    name: String,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    is_launcher: bool,
    #[serde(default)]
    is_negated: bool,
}

// ── The catalog as it is used ───────────────────────────────────────────────

struct Game {
    name: String,
    /// Always present. A game without one cannot be reported (see the module docs), so it never
    /// reaches this struct.
    application_id: String,
    /// The name reduced to letters and digits, for comparison against a directory component. Empty
    /// when the name is too short to be evidence of anything - see [`name_key`].
    name_key: String,
}

struct CompiledRule {
    game: u32,
    /// Normalized path components, last is the basename. Never empty.
    components: Vec<String>,
    is_launcher: bool,
    is_negated: bool,
}

/// What a scan concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub name: String,
    pub application_id: String,
}

/// Counts kept from the last compile, so the settings page and the log can say something specific
/// rather than "it did not work".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStats {
    pub games: usize,
    pub rules: usize,
    /// Catalog entries dropped because they carry no usable application id. These are not games we
    /// could have reported: the server would have discarded the activity.
    pub dropped_without_application_id: usize,
}

pub struct Catalog {
    version: String,
    games: Vec<Game>,
    rules: Vec<CompiledRule>,
    /// Basename → rule indices. The only index needed: every rule ends in a basename, and a process
    /// can only match rules that share its own.
    by_basename: HashMap<String, Vec<u32>>,
    stats: CatalogStats,
}

impl Catalog {
    /// Parses and indexes a catalog document.
    ///
    /// `os_filter` keeps only rules for the running platform when the server has not already
    /// filtered them (the endpoint takes `?os=`, but a cached document from another build might
    /// not have). A rule with no `os` at all is kept: absent is not the same as "some other
    /// platform".
    pub fn compile(json: &str, os_filter: &str) -> Result<Self, String> {
        let payload: CatalogPayload =
            serde_json::from_str(json).map_err(|e| format!("catalog is not valid json: {e}"))?;

        let version = match &payload.version {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        };

        let mut games = Vec::new();
        let mut rules = Vec::new();
        let mut by_basename: HashMap<String, Vec<u32>> = HashMap::new();
        let mut dropped = 0usize;

        for entry in payload.games {
            // The application id is what makes a match publishable, so it is the admission test.
            // `applicationId` first; `id` is accepted only when it is itself a snowflake, which is
            // how the catalog represents an application whose id *is* its primary key.
            let application_id = entry
                .application_id
                .filter(|id| model::is_snowflake(id))
                .or_else(|| entry.id.filter(|id| model::is_snowflake(id)));

            let Some(application_id) = application_id else {
                dropped += 1;
                continue;
            };

            let Some(name) = model::sanitize(&entry.name, MAX_TEXT) else {
                dropped += 1;
                continue;
            };

            let game_index = games.len() as u32;
            let mut added = false;

            for rule in entry.rules {
                if let Some(os) = &rule.os {
                    if !os.is_empty() && !os.eq_ignore_ascii_case(os_filter) {
                        continue;
                    }
                }

                // A leading `>` is stripped defensively: the server parses it into `isNegated`, but
                // a catalog written by an older build might still carry the raw form, and a rule
                // named ">hl2.exe" would then match nothing and negate nothing.
                let raw = rule.name.trim();
                let (raw, negated_by_prefix) = match raw.strip_prefix('>') {
                    Some(rest) => (rest, true),
                    None => (raw, false),
                };

                let components = normalize_components(raw);
                if components.is_empty() {
                    continue;
                }

                let index = rules.len() as u32;
                by_basename
                    .entry(components[components.len() - 1].clone())
                    .or_default()
                    .push(index);
                rules.push(CompiledRule {
                    game: game_index,
                    components,
                    is_launcher: rule.is_launcher,
                    is_negated: rule.is_negated || negated_by_prefix,
                });
                added = true;
            }

            if !added {
                // No rules for this platform: a registered application with nothing to detect. Not
                // a fault, and not counted as a drop.
                continue;
            }

            games.push(Game {
                name_key: name_key(&name),
                name,
                application_id,
            });
        }

        // Invariant, by construction: rules are pushed only on the path that also pushes the game,
        // so `rule.game` always indexes a real entry. Not repaired defensively here -a `retain`
        // would renumber the rules and silently corrupt `by_basename`, which is worse than the bug
        // it would be papering over.
        debug_assert!(rules.iter().all(|rule| (rule.game as usize) < games.len()));

        let stats = CatalogStats {
            games: games.len(),
            rules: rules.len(),
            dropped_without_application_id: dropped,
        };

        Ok(Self {
            version,
            games,
            rules,
            by_basename,
            stats,
        })
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn stats(&self) -> CatalogStats {
        self.stats
    }

    /// Picks the one game these processes are, or `None`.
    ///
    /// `None` is a real answer here, not a failure: an ambiguous basename resolves to nothing
    /// deliberately.
    pub fn detect<'a>(&self, paths: impl IntoIterator<Item = &'a str>) -> Option<Match> {
        let mut suppressed: HashSet<u32> = HashSet::new();
        let mut exact: Vec<Candidate> = Vec::new();
        let mut variant: Vec<Candidate> = Vec::new();
        let mut corroborated: Vec<Candidate> = Vec::new();

        for path in paths {
            let components = normalize_components(path);
            let Some(basename) = components.last() else {
                continue;
            };

            self.collect(&components, basename, &mut exact, &mut suppressed);
            self.collect_by_name(&components, basename, &mut corroborated);

            // Only ever a fallback: see `strip_arch_suffix`. The whole path is rebuilt around the
            // stripped basename rather than only the lookup key -a rule for `overwatch.exe` has to
            // be suffix-matched against `.../overwatch.exe`, not against the `.../overwatch64.exe`
            // we actually saw, or it can never match.
            //
            // Its *suppressions* go into the same set as the exact pass's, deliberately: erring
            // towards "do not report" is the correct bias for a negation, and it is the direction
            // that cannot invent a wrong game.
            if let Some(stripped) = strip_arch_suffix(basename) {
                let mut rebuilt = components.clone();
                let last = rebuilt.len() - 1;
                rebuilt[last] = stripped.clone();
                self.collect(&rebuilt, &stripped, &mut variant, &mut suppressed);
            }
        }

        // Strictly ordered, and a later pass runs only when every earlier one found nothing at all.
        // If the exact pass found candidates and they were ambiguous, that ambiguity is the answer -
        // widening the search would turn a deliberate "do not guess" into a guess.
        let candidates = if !exact.is_empty() {
            &exact
        } else if !variant.is_empty() {
            &variant
        } else {
            &corroborated
        };
        let winner = pick(candidates, &suppressed)?;

        let game = &self.games[winner as usize];
        Some(Match {
            name: game.name.clone(),
            application_id: game.application_id.clone(),
        })
    }

    /// Adds rules whose basename matches and whose **game name appears as a directory** in the path.
    ///
    /// **The gap this closes.** A rule's directory component records where Discord saw the game
    /// installed, and that is frequently not where it is. Microsoft Flight Simulator 2024 is
    /// registered as `limitless/flightsimulator2024.exe`; on a machine where the Store package is
    /// redirected to another drive - which the Xbox app does by default - the running path is
    /// `D:\XboxGames\Microsoft Flight Simulator 2024\Content\FlightSimulator2024.exe`. Not one
    /// directory in that path is `limitless`, so a strict suffix match can never succeed, and
    /// [`store_package_matches`] does not help either because the junction has already been
    /// resolved away by the time we see the path.
    ///
    /// **Why this is not the basename fallback I first considered.** Accepting any rule whose
    /// basename is unique in the catalog looks equivalent and is much more dangerous: measured over
    /// this catalog, `java.exe`, `start.exe`, `main.exe`, `run.exe` and `update.exe` are each
    /// claimed by *exactly one* game, so that rule would announce a game every time a JVM or an
    /// updater ran. It would reintroduce, by the back door, the false positive the negation rules
    /// exist to prevent.
    ///
    /// This instead requires **two independent pieces of evidence to agree**: the executable is one
    /// this game is known to use, *and* the game's own name is on the path. Steam
    /// (`steamapps/common/<Game Name>/`), Epic, GOG and the Xbox app all lay out directories that
    /// way, so this is the common case rather than a special one. A stray `java.exe` does not live
    /// under a directory named after the game that claims it, so it stays unmatched.
    ///
    /// Suppressions are deliberately not collected here: they are gathered once by [`collect`] over
    /// the same paths, and a negation must apply no matter which pass produced the candidate.
    fn collect_by_name(&self, components: &[String], basename: &str, candidates: &mut Vec<Candidate>) {
        let Some(indices) = self.by_basename.get(basename) else {
            return;
        };

        // The basename itself is excluded: `foo.exe` inside a directory called `foo` is one piece of
        // evidence wearing two hats, not two.
        let directories = &components[..components.len().saturating_sub(1)];

        for &index in indices {
            let rule = &self.rules[index as usize];
            if rule.is_negated {
                continue;
            }

            let key = &self.games[rule.game as usize].name_key;
            if key.is_empty() {
                continue;
            }

            if directories.iter().any(|component| name_key(component) == *key) {
                candidates.push(Candidate {
                    game: rule.game,
                    is_launcher: rule.is_launcher,
                    specificity: rule.components.len(),
                });
            }
        }
    }

    /// Adds every rule with this basename that suffix-matches the process path.
    fn collect(
        &self,
        components: &[String],
        basename: &str,
        candidates: &mut Vec<Candidate>,
        suppressed: &mut HashSet<u32>,
    ) {
        let Some(indices) = self.by_basename.get(basename) else {
            return;
        };
        for &index in indices {
            let rule = &self.rules[index as usize];
            if !matches_suffix(components, &rule.components) {
                continue;
            }
            if rule.is_negated {
                suppressed.insert(rule.game);
            } else {
                candidates.push(Candidate {
                    game: rule.game,
                    is_launcher: rule.is_launcher,
                    specificity: rule.components.len(),
                });
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Candidate {
    game: u32,
    is_launcher: bool,
    specificity: usize,
}

impl Candidate {
    /// Higher is better: a non-launcher beats a launcher outright, then the more path-specific rule
    /// wins. Ordering the tuple this way is what makes "playing Dead by Daylight" beat "sitting in
    /// the Dead by Daylight launcher".
    fn rank(&self) -> (bool, usize) {
        (!self.is_launcher, self.specificity)
    }
}

/// Chooses the single best candidate, or `None` when the best rank is shared by more than one game.
fn pick(candidates: &[Candidate], suppressed: &HashSet<u32>) -> Option<u32> {
    let live: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| !suppressed.contains(&candidate.game))
        .collect();

    let best = live.iter().map(|candidate| candidate.rank()).max()?;
    let winners: HashSet<u32> = live
        .iter()
        .filter(|candidate| candidate.rank() == best)
        .map(|candidate| candidate.game)
        .collect();

    // The 192-way `game.exe` collision lands exactly here, and lands on `None`.
    if winners.len() == 1 {
        winners.into_iter().next()
    } else {
        None
    }
}

/// Lowercases, folds `\` to `/`, and splits into path components.
///
/// Empty components and `.` are dropped so that `C:\Games\\Foo\.\bar.exe` and `c:/games/foo/bar.exe`
/// normalize identically.
fn normalize_components(path: &str) -> Vec<String> {
    path.to_lowercase()
        .split(|c| c == '/' || c == '\\')
        .filter(|component| !component.is_empty() && *component != ".")
        .map(str::to_owned)
        .collect()
}

/// Does the process path end with the rule's components, **at a component boundary**?
///
/// This is the whole difference between matching `.../game.exe` and matching `.../mygame.exe`
/// against a rule for `game.exe`. A `str::ends_with` would accept both.
///
/// Directory components additionally accept a Microsoft Store package folder that *contains* the
/// named package - see [`store_package_matches`]. The basename never does: the file itself is the
/// one thing that must be exactly what the rule says.
fn matches_suffix(process: &[String], rule: &[String]) -> bool {
    if rule.is_empty() || rule.len() > process.len() {
        return false;
    }

    let offset = process.len() - rule.len();
    rule.iter().enumerate().all(|(i, expected)| {
        let actual = &process[offset + i];
        actual == expected
            // `i + 1 < rule.len()` is what confines this to directories.
            || (i + 1 < rule.len() && store_package_matches(actual, expected))
    })
}

/// Reduces a name to letters and digits, so "Microsoft Flight Simulator 2024" and the directory
/// `Microsoft Flight Simulator 2024` compare equal, as do `Half-Life 2` and `Half Life 2`.
///
/// Returns empty for anything shorter than four characters once reduced. Short keys are not
/// evidence: a game called `AI` would otherwise be claimed by every directory named `ai`, and the
/// whole point of this comparison is that agreeing with it is unlikely by chance.
fn name_key(value: &str) -> String {
    let key: String = value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();

    if key.chars().count() < 4 {
        String::new()
    } else {
        key
    }
}

/// Does this path component name the Microsoft Store package the rule is asking for?
///
/// **The gap this closes.** Store titles install to
/// `WindowsApps\<Publisher>.<Package>_<version>_<arch>__<publisherhash>`, but the catalog names the
/// package plainly. Microsoft Flight Simulator 2024 is registered as
/// `limitless/flightsimulator2024.exe` and actually runs from
/// `C:\Program Files\WindowsApps\Microsoft.Limitless_1.8.10.0_x64__8wekyb3d8bbwe\FlightSimulator2024.exe`.
/// Compared component-for-component those are simply different strings, so *every* Store game whose
/// rule carries a directory was undetectable - and 83% of rules carry one.
///
/// **Why this is not a step back towards fuzzy matching.** The relaxation is bounded by a packaging
/// format, not by a similarity heuristic: the component must parse as a package folder, and the rule
/// must equal either the full package name (`microsoft.limitless`) or its final dotted segment
/// (`limitless`), which is the form the catalog uses. The basename still has to match exactly and an
/// ambiguous result still resolves to `None`, so this can widen what we find but not what we are
/// willing to guess.
fn store_package_matches(component: &str, expected: &str) -> bool {
    // `Name_Version_Arch__PublisherHash`. The double underscore is the anchor: package names may not
    // contain `_` at all, so everything before the first one is the name.
    let Some((left, publisher_hash)) = component.split_once("__") else {
        return false;
    };
    if publisher_hash.is_empty() || !publisher_hash.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }

    let Some((package, _version_and_arch)) = left.split_once('_') else {
        return false;
    };
    if package.is_empty() {
        return false;
    }

    // `microsoft.limitless` or `limitless`, and nothing else - not `microsoft`, which would let one
    // publisher's rule reach another publisher's package.
    package == expected
        || package
            .rsplit_once('.')
            .is_some_and(|(_, leaf)| !leaf.is_empty() && leaf == expected)
}

/// Strips an architecture marker from a basename: `overwatch64.exe` → `overwatch.exe`.
///
/// **Fallback only.** Widening the key space is the one change that can turn a correct "we do not
/// know" into a wrong answer, so [`Catalog::detect`] consults this pass only when the exact pass
/// produced no candidates whatsoever. The stem must keep at least three characters, so `64.exe`
/// does not collapse to `.exe`.
fn strip_arch_suffix(basename: &str) -> Option<String> {
    let (stem, extension) = match basename.rfind('.') {
        Some(dot) => (&basename[..dot], &basename[dot..]),
        None => (basename, ""),
    };

    // Longest first: `_x64` must not be handled as a bare `64` leaving a trailing `_`.
    for marker in ["-x64", "_x64", ".x64", "x64", "-64", "_64", "64"] {
        if let Some(trimmed) = stem.strip_suffix(marker) {
            if trimmed.len() >= 3 {
                return Some(format!("{trimmed}{extension}"));
            }
        }
    }
    None
}

// ── Debounce and stickiness ─────────────────────────────────────────────────

struct Confirmed {
    application_id: String,
    name: String,
    /// Stamped once, at the moment of confirmation, and never rewritten while the match persists.
    started_at: i64,
    last_seen: Instant,
}

/// Turns a stream of per-scan matches into an activity, with both edges debounced.
#[derive(Default)]
pub struct Detector {
    /// The game being counted towards confirmation, and how many consecutive scans have seen it.
    pending: Option<(String, u32)>,
    confirmed: Option<Confirmed>,
}

impl Detector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one scan result and returns what should be reported now.
    pub fn observe(&mut self, matched: Option<Match>, now: Instant) -> Option<Activity> {
        match matched {
            Some(matched) => self.on_sighting(matched, now),
            None => self.on_absence(now),
        }
        self.current()
    }

    fn on_sighting(&mut self, matched: Match, now: Instant) {
        if let Some(confirmed) = self.confirmed.as_mut() {
            if confirmed.application_id == matched.application_id {
                // Still the same game. Refresh liveness and take the catalog's current name, but
                // **never** the clock: restamping here is what makes "for 23 minutes" read "for a
                // few seconds" forever, and it is the single easiest thing to get wrong.
                confirmed.name = matched.name;
                confirmed.last_seen = now;
                self.pending = None;
                return;
            }
        }

        // A different game -or nothing confirmed yet. Count it towards confirmation; the incumbent
        // stays reported meanwhile and ages out through `LINGER` on its own.
        let count = match self.pending.as_mut() {
            Some((application_id, count)) if *application_id == matched.application_id => {
                *count += 1;
                *count
            }
            _ => {
                self.pending = Some((matched.application_id.clone(), 1));
                1
            }
        };

        if count >= CONFIRM_SIGHTINGS {
            self.pending = None;
            self.confirmed = Some(Confirmed {
                application_id: matched.application_id,
                name: matched.name,
                started_at: model::now_ms(),
                last_seen: now,
            });
        }
    }

    fn on_absence(&mut self, now: Instant) {
        // An unconfirmed candidate that misses a single scan starts over: "two consecutive" is the
        // point, and an installer that appears every other scan is exactly what this rejects.
        self.pending = None;

        if let Some(confirmed) = self.confirmed.as_ref() {
            if now.duration_since(confirmed.last_seen) >= LINGER {
                self.confirmed = None;
            }
        }
    }

    /// The name of the confirmed match, for the legacy `scan_game_process` accessor.
    pub fn confirmed_name(&self) -> Option<String> {
        self.confirmed.as_ref().map(|c| c.name.clone())
    }

    fn current(&self) -> Option<Activity> {
        self.confirmed.as_ref().map(|confirmed| Activity {
            kind: ActivityType::Playing,
            name: confirmed.name.clone(),
            details: None,
            state: None,
            // The reason this module exists. Without it the server drops the activity outright and
            // the whole feature looks broken from the outside.
            application_id: Some(confirmed.application_id.clone()),
            started_at: Some(confirmed.started_at),
            ends_at: None,
            assets: None,
            party: None,
            source: ActivitySource::ProcessScan,
        })
    }
}

// ── Process enumeration ─────────────────────────────────────────────────────

/// Collects one path per running process, as cheaply as the platform allows.
///
/// `ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet)` is the point: the code this
/// replaces called `System::new_all()` + `refresh_all()` every 15 s, which collects CPU, memory,
/// disk and network for every process on the machine in order to read a list of names.
/// `OnlyIfNotSet` also means each process's executable path is resolved once and then cached, since
/// a process cannot change its own image.
///
/// A process whose executable path is unreadable -most system processes, and anything running as
/// another user -contributes its bare name instead. That can only match a rule with a single
/// component, and any such basename claimed by more than one game still resolves to nothing.
pub fn scan_process_paths(system: &mut sysinfo::System) -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );

    system
        .processes()
        .values()
        .map(|process| match process.exe() {
            Some(path) => path.to_string_lossy().into_owned(),
            None => process.name().to_string_lossy().into_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog(games: serde_json::Value) -> Catalog {
        Catalog::compile(&json!({"version": "1", "games": games}).to_string(), "win32").unwrap()
    }

    fn game(app_id: &str, name: &str, rules: serde_json::Value) -> serde_json::Value {
        json!({"id": app_id, "name": name, "applicationId": app_id, "rules": rules})
    }

    fn rule(name: &str) -> serde_json::Value {
        json!({"name": name, "os": "win32", "isLauncher": false, "isNegated": false})
    }

    // ── Normalization and boundaries ────────────────────────────────────────

    #[test]
    fn paths_normalize_to_lowercase_components() {
        assert_eq!(
            normalize_components(r"C:\Program Files\Foo\\.\Bar.EXE"),
            vec!["c:", "program files", "foo", "bar.exe"]
        );
        assert_eq!(
            normalize_components("/usr/share/Games/foo"),
            vec!["usr", "share", "games", "foo"]
        );
        assert!(normalize_components("").is_empty());
    }

    #[test]
    fn suffix_matching_happens_at_component_boundaries() {
        let process = normalize_components(r"D:\Games\World of Warcraft\_retail_\Wow.exe");

        assert!(matches_suffix(&process, &normalize_components("wow.exe")));
        assert!(matches_suffix(&process, &normalize_components("_retail_/wow.exe")));
        assert!(matches_suffix(
            &process,
            &normalize_components("world of warcraft/_retail_/wow.exe")
        ));

        // The trap a `str::ends_with` would fall into.
        assert!(!matches_suffix(
            &normalize_components(r"C:\Games\mygame.exe"),
            &normalize_components("game.exe")
        ));
        // A rule longer than the path cannot match.
        assert!(!matches_suffix(
            &normalize_components("wow.exe"),
            &normalize_components("_retail_/wow.exe")
        ));
        assert!(!matches_suffix(&process, &[]));
    }

    // ── Microsoft Store packaging ───────────────────────────────────────────

    /// The regression this was written for: MSFS 2024 was running, its rule was in the catalog, and
    /// detection reported nothing because the Store package folder is not the plain package name.
    #[test]
    fn a_store_package_folder_satisfies_a_plain_package_rule() {
        let catalog = catalog(json!([game(
            "1308492082369003631",
            "Microsoft Flight Simulator 2024",
            json!([rule("limitless/flightsimulator2024.exe")])
        )]));

        let detected = catalog.detect([
            r"C:\Program Files\WindowsApps\Microsoft.Limitless_1.8.10.0_x64__8wekyb3d8bbwe\FlightSimulator2024.exe",
        ]);

        assert_eq!(
            detected,
            Some(Match {
                name: "Microsoft Flight Simulator 2024".into(),
                application_id: "1308492082369003631".into(),
            })
        );
    }

    #[test]
    fn a_store_package_matches_by_full_name_as_well_as_leaf() {
        let folder = "microsoft.limitless_1.8.10.0_x64__8wekyb3d8bbwe";

        assert!(store_package_matches(folder, "limitless"));
        assert!(store_package_matches(folder, "microsoft.limitless"));

        // The publisher alone must not reach another publisher's package - otherwise one
        // `microsoft/foo.exe` rule would claim every Microsoft-published Store title.
        assert!(!store_package_matches(folder, "microsoft"));
        assert!(!store_package_matches(folder, "limitles"));
        assert!(!store_package_matches(folder, ""));
    }

    #[test]
    fn an_ordinary_directory_is_never_read_as_a_store_package() {
        // No `__`, no version segment: nothing here may relax.
        assert!(!store_package_matches("limitless_extra", "limitless"));
        assert!(!store_package_matches("limitless", "limitless"));
        assert!(!store_package_matches("bin__", "bin"));
        assert!(!store_package_matches("_1.0_x64__abc", "package"));
        // A publisher hash has to look like one.
        assert!(!store_package_matches("foo_1.0_x64__has space", "foo"));
    }

    /// The relaxation is for directories. A Store-shaped *filename* must still be exact, or the one
    /// component that identifies the program becomes negotiable.
    #[test]
    fn the_basename_is_never_relaxed() {
        let process = normalize_components(
            r"C:\Program Files\WindowsApps\Microsoft.Limitless_1.0_x64__8wekyb3d8bbwe\game_1.0_x64__8wekyb3d8bbwe.exe",
        );

        assert!(!matches_suffix(&process, &normalize_components("game")));
        assert!(!matches_suffix(&process, &normalize_components("game.exe")));
    }

    /// A Store package must not become a way around the ambiguity rule.
    #[test]
    fn two_store_games_sharing_a_basename_still_resolve_to_nothing() {
        let catalog = catalog(json!([
            game("111111111111111111", "One", json!([rule("alpha/game.exe")])),
            game("222222222222222222", "Two", json!([rule("beta/game.exe")])),
        ]));

        assert_eq!(
            catalog.detect([
                r"C:\Program Files\WindowsApps\Pub.Alpha_1.0_x64__hash\game.exe",
                r"C:\Program Files\WindowsApps\Pub.Beta_1.0_x64__hash\game.exe",
            ]),
            None
        );
    }

    // ── Name corroboration ──────────────────────────────────────────────────

    /// The real MSFS 2024 case: the Store package is redirected to another drive, the junction is
    /// resolved away before we see the path, and no directory in it is `limitless`.
    #[test]
    fn the_game_name_on_the_path_corroborates_a_rule_whose_directory_does_not_match() {
        let catalog = catalog(json!([game(
            "1308492082369003631",
            "Microsoft Flight Simulator 2024",
            json!([rule("limitless/flightsimulator2024.exe")])
        )]));

        let detected = catalog.detect([
            r"D:\XboxGames\Microsoft Flight Simulator 2024\Content\FlightSimulator2024.exe",
        ]);

        assert_eq!(
            detected,
            Some(Match {
                name: "Microsoft Flight Simulator 2024".into(),
                application_id: "1308492082369003631".into(),
            })
        );
    }

    /// The measured false positive that ruled out a plain unique-basename fallback: `java.exe` is
    /// claimed by exactly one game in the real catalog.
    #[test]
    fn a_unique_basename_alone_is_not_enough() {
        let catalog = catalog(json!([game(
            "111111111111111111",
            "Some Java Game",
            json!([rule("somejavagame/java.exe")])
        )]));

        // An ordinary JVM. Nothing on this path agrees with the game's name.
        assert_eq!(
            catalog.detect([r"C:\Program Files\Eclipse Adoptium\jdk-21\bin\java.exe"]),
            None
        );

        // The same executable under the game's own directory is a different matter.
        assert!(catalog
            .detect([r"D:\Games\Some Java Game\bin\java.exe"])
            .is_some());
    }

    #[test]
    fn corroboration_tolerates_punctuation_and_case_differences() {
        let catalog = catalog(json!([game(
            "222222222222222222",
            "Half-Life 2",
            json!([rule("someotherdir/hl2.exe")])
        )]));

        assert!(catalog
            .detect([r"D:\SteamLibrary\steamapps\common\Half Life 2\hl2.exe"])
            .is_some());
    }

    /// Short names are not evidence - agreeing with them by chance is far too easy.
    #[test]
    fn a_name_too_short_to_be_evidence_never_corroborates() {
        assert_eq!(name_key("AI"), "");
        assert_eq!(name_key("Go!"), "");
        assert_eq!(name_key("Half-Life 2"), "halflife2");

        let catalog = catalog(json!([game(
            "333333333333333333",
            "AI",
            json!([rule("aigame/ai.exe")])
        )]));

        assert_eq!(catalog.detect([r"C:\tools\ai\ai.exe"]), None);
    }

    /// Corroboration is a last resort, so it must not overturn a confident answer.
    #[test]
    fn corroboration_never_runs_when_an_earlier_pass_found_anything() {
        let catalog = catalog(json!([
            game("444444444444444444", "Alpha", json!([rule("bin/shared.exe")])),
            game("555555555555555555", "Beta", json!([rule("beta/shared.exe")])),
        ]));

        // Alpha matches exactly. Beta would be corroborated by the directory named after it, but
        // the exact pass already answered and that answer stands.
        assert_eq!(
            catalog.detect([r"D:\Games\Beta\bin\shared.exe"]),
            Some(Match {
                name: "Alpha".into(),
                application_id: "444444444444444444".into(),
            })
        );
    }

    #[test]
    fn a_negated_rule_still_suppresses_a_corroborated_match() {
        let catalog = catalog(json!([game(
            "666666666666666666",
            "Minecraft Launcher",
            json!([
                rule("minecraftlauncher/launcher.exe"),
                {"name": "javaw.exe", "os": "win32", "isLauncher": false, "isNegated": true}
            ])
        )]));

        assert_eq!(
            catalog.detect([
                r"D:\Games\Minecraft Launcher\bin\launcher.exe",
                r"C:\Program Files\Java\bin\javaw.exe",
            ]),
            None
        );
    }

    // ── The three measured rules ────────────────────────────────────────────

    #[test]
    fn a_path_qualified_rule_matches_the_real_path() {
        // 83% of the catalog looks like this; matching `process.name()` alone reaches none of it.
        let catalog = catalog(json!([game(
            "356875221078245376",
            "World of Warcraft",
            json!([rule("_retail_/wow.exe")])
        )]));

        let matched = catalog
            .detect([r"D:\Games\World of Warcraft\_retail_\Wow.exe"])
            .unwrap();
        assert_eq!(matched.name, "World of Warcraft");
        assert_eq!(matched.application_id, "356875221078245376");

        // The same basename outside the qualifying directory is not this game.
        assert!(catalog.detect([r"D:\Other\Wow.exe"]).is_none());
    }

    #[test]
    fn mygame_exe_does_not_satisfy_a_rule_for_game_exe() {
        let catalog = catalog(json!([game("1000000000000000001", "Some Game", json!([rule("game.exe")]))]));
        assert!(catalog.detect([r"C:\Games\mygame.exe"]).is_none());
        assert!(catalog.detect([r"C:\Games\game.exe"]).is_some());
    }

    #[test]
    fn the_game_exe_collision_resolves_to_nothing_rather_than_a_guess() {
        // 192 games register `game.exe` in the real catalog. Reporting any one of them is the
        // failure this whole module is shaped around.
        let games: Vec<serde_json::Value> = (0..192)
            .map(|i| {
                game(
                    &format!("10000000000000{i:05}"),
                    &format!("Game {i}"),
                    json!([rule("game.exe")]),
                )
            })
            .collect();
        let catalog = catalog(json!(games));

        assert_eq!(catalog.stats().games, 192);
        assert!(catalog.detect([r"C:\Whatever\game.exe"]).is_none());
    }

    #[test]
    fn a_path_qualified_rule_beats_a_bare_basename_from_another_game() {
        let catalog = catalog(json!([
            game("1000000000000000001", "Generic", json!([rule("gmod.exe")])),
            game("1000000000000000002", "Garry's Mod", json!([rule("win64/gmod.exe")])),
        ]));

        let matched = catalog
            .detect([r"C:\Steam\steamapps\common\GarrysMod\win64\gmod.exe"])
            .unwrap();
        assert_eq!(matched.name, "Garry's Mod");
    }

    #[test]
    fn a_negated_rule_suppresses_its_game() {
        // Minecraft's `>javaw.exe`: running a JVM must not announce Minecraft.
        let catalog = catalog(json!([game(
            "1000000000000000001",
            "Minecraft",
            json!([
                {"name": "javaw.exe", "os": "win32", "isLauncher": false, "isNegated": true},
                {"name": "minecraft.exe", "os": "win32", "isLauncher": false, "isNegated": false}
            ])
        )]));

        // The negation fires even though a positive rule for the same game also matched.
        assert!(catalog
            .detect([r"C:\Program Files\Java\bin\javaw.exe", r"C:\Games\minecraft.exe"])
            .is_none());
        // Without the JVM, the positive rule stands.
        assert!(catalog.detect([r"C:\Games\minecraft.exe"]).is_some());
    }

    #[test]
    fn the_hl2_collision_is_resolved_by_negation() {
        // The real shape: several Source games negate `hl2.exe`, and one of them identifies itself
        // by a path-qualified rule instead.
        let catalog = catalog(json!([
            game(
                "1000000000000000001",
                "Half-Life 2",
                json!([{"name": "hl2.exe", "os": "win32", "isLauncher": false, "isNegated": true}])
            ),
            game(
                "1000000000000000002",
                "Team Fortress 2",
                json!([{"name": "hl2.exe", "os": "win32", "isLauncher": false, "isNegated": true}])
            ),
            game(
                "1000000000000000003",
                "Garry's Mod",
                json!([
                    {"name": "hl2.exe", "os": "win32", "isLauncher": false, "isNegated": true},
                    {"name": "garrysmod/gmod.exe", "os": "win32", "isLauncher": false, "isNegated": false}
                ])
            ),
        ]));

        // A bare hl2.exe identifies nothing.
        assert!(catalog.detect([r"C:\Steam\common\Half-Life 2\hl2.exe"]).is_none());

        // And the negation still holds when the game's own positive rule is also running: this is
        // the arrangement that stops the 34-way collision producing a wrong answer.
        assert!(catalog
            .detect([
                r"C:\Steam\common\Half-Life 2\hl2.exe",
                r"C:\Steam\common\GarrysMod\garrysmod\gmod.exe"
            ])
            .is_none());
    }

    #[test]
    fn a_launcher_loses_to_the_game_it_launches() {
        // Dead by Daylight's real arrangement.
        let catalog = catalog(json!([game(
            "1000000000000000001",
            "Dead by Daylight",
            json!([
                {"name": "deadbydaylight.exe", "os": "win32", "isLauncher": true, "isNegated": false},
                {"name": "deadbydaylight-win64-shipping.exe", "os": "win32", "isLauncher": false, "isNegated": false}
            ])
        )]));

        assert!(catalog.detect([r"C:\dbd\deadbydaylight.exe"]).is_some());
        assert!(catalog
            .detect([
                r"C:\dbd\deadbydaylight.exe",
                r"C:\dbd\Binaries\Win64\DeadByDaylight-Win64-Shipping.exe"
            ])
            .is_some());
    }

    #[test]
    fn a_non_launcher_from_another_game_outranks_a_launcher() {
        let catalog = catalog(json!([
            game(
                "1000000000000000001",
                "Store Front",
                json!([{"name": "store.exe", "os": "win32", "isLauncher": true, "isNegated": false}])
            ),
            game("1000000000000000002", "Real Game", json!([rule("realgame.exe")])),
        ]));

        let matched = catalog
            .detect([r"C:\store\store.exe", r"C:\game\realgame.exe"])
            .unwrap();
        assert_eq!(matched.name, "Real Game");
    }

    // ── The application id constraint ───────────────────────────────────────

    #[test]
    fn every_match_carries_an_application_id() {
        let catalog = catalog(json!([game(
            "356875221078245376",
            "Overwatch",
            json!([rule("overwatch.exe")])
        )]));
        let matched = catalog.detect([r"C:\ow\overwatch.exe"]).unwrap();
        assert!(model::is_snowflake(&matched.application_id));

        let mut detector = Detector::new();
        detector.observe(Some(matched.clone()), Instant::now());
        let activity = detector.observe(Some(matched), Instant::now()).unwrap();
        // Without this the server drops the activity and the feature looks broken end to end.
        assert_eq!(
            activity.application_id.as_deref(),
            Some("356875221078245376")
        );
        assert_eq!(activity.source, ActivitySource::ProcessScan);
    }

    #[test]
    fn entries_with_no_usable_application_id_are_dropped_at_compile_time() {
        let catalog = Catalog::compile(
            &json!({"version": "1", "games": [
                {"id": "local-1", "name": "No Id", "applicationId": null, "rules": [rule("noid.exe")]},
                {"id": "local-2", "name": "Bad Id", "applicationId": "not-a-snowflake", "rules": [rule("badid.exe")]},
                {"id": "356875221078245376", "name": "Id Is The Key", "rules": [rule("keyed.exe")]},
                game("1000000000000000001", "Fine", json!([rule("fine.exe")])),
            ]})
            .to_string(),
            "win32",
        )
        .unwrap();

        assert_eq!(catalog.stats().dropped_without_application_id, 2);
        assert_eq!(catalog.stats().games, 2);
        assert!(catalog.detect([r"C:\x\noid.exe"]).is_none());
        assert!(catalog.detect([r"C:\x\badid.exe"]).is_none());
        // `id` is accepted when it is itself a snowflake.
        assert_eq!(
            catalog.detect([r"C:\x\keyed.exe"]).unwrap().application_id,
            "356875221078245376"
        );
    }

    // ── Catalog hygiene ─────────────────────────────────────────────────────

    #[test]
    fn a_corrupt_or_empty_catalog_degrades_quietly() {
        assert!(Catalog::compile("not json at all", "win32").is_err());
        assert!(Catalog::compile("", "win32").is_err());

        // Structurally valid but empty: not an error, just a catalog that matches nothing.
        let empty = Catalog::compile(r#"{"version":"1","games":[]}"#, "win32").unwrap();
        assert_eq!(empty.stats().games, 0);
        assert!(empty.detect([r"C:\x\anything.exe"]).is_none());

        // Missing fields throughout, which is what a half-written cache file looks like.
        let sparse = Catalog::compile(r#"{"games":[{},{"name":"x"},{"rules":[]}]}"#, "win32").unwrap();
        assert_eq!(sparse.stats().games, 0);
        assert!(sparse.detect([r"C:\x\anything.exe"]).is_none());
    }

    #[test]
    fn rules_for_other_platforms_are_filtered_out() {
        let payload = json!({"version": "1", "games": [{
            "id": "1000000000000000001",
            "name": "Cross Platform",
            "applicationId": "1000000000000000001",
            "rules": [
                {"name": "game.app/contents/macos/game", "os": "darwin", "isLauncher": false, "isNegated": false},
                {"name": "crossplatform.exe", "os": "win32", "isLauncher": false, "isNegated": false}
            ]
        }]});

        let win = Catalog::compile(&payload.to_string(), "win32").unwrap();
        assert_eq!(win.stats().rules, 1);
        assert!(win.detect([r"C:\g\crossplatform.exe"]).is_some());

        let mac = Catalog::compile(&payload.to_string(), "darwin").unwrap();
        assert_eq!(mac.stats().rules, 1);
        assert!(mac.detect(["/Applications/Game.app/Contents/MacOS/Game"]).is_some());
        assert!(mac.detect([r"C:\g\crossplatform.exe"]).is_none());
    }

    #[test]
    fn a_raw_negation_prefix_is_still_understood() {
        // Belt and braces: the server parses `>` into `isNegated`, but a cache written by an older
        // build would otherwise produce a rule named ">javaw.exe" that matches nothing.
        let catalog = catalog(json!([game(
            "1000000000000000001",
            "Minecraft",
            json!([
                {"name": ">javaw.exe", "os": "win32", "isLauncher": false, "isNegated": false},
                rule("minecraft.exe")
            ])
        )]));
        assert!(catalog
            .detect([r"C:\java\javaw.exe", r"C:\mc\minecraft.exe"])
            .is_none());
    }

    // ── Architecture-variant fallback ───────────────────────────────────────

    #[test]
    fn arch_suffixes_are_stripped_only_as_a_fallback() {
        assert_eq!(strip_arch_suffix("overwatch64.exe").as_deref(), Some("overwatch.exe"));
        assert_eq!(strip_arch_suffix("game_x64.exe").as_deref(), Some("game.exe"));
        assert_eq!(strip_arch_suffix("game-64.exe").as_deref(), Some("game.exe"));
        assert_eq!(strip_arch_suffix("witcher3.exe"), None);
        // Would leave a stem too short to mean anything.
        assert_eq!(strip_arch_suffix("64.exe"), None);
        assert_eq!(strip_arch_suffix("x64.exe"), None);

        let catalog = catalog(json!([game(
            "1000000000000000001",
            "Overwatch",
            json!([rule("overwatch.exe")])
        )]));
        assert_eq!(
            catalog.detect([r"C:\ow\Overwatch64.exe"]).unwrap().name,
            "Overwatch"
        );
    }

    #[test]
    fn the_variant_pass_never_runs_when_the_exact_pass_found_anything() {
        let catalog = catalog(json!([
            game("1000000000000000001", "A", json!([rule("game.exe")])),
            game("1000000000000000002", "B", json!([rule("game.exe")])),
            game("1000000000000000003", "C", json!([rule("game64.exe")])),
        ]));

        // `game64.exe` matches C exactly; the variant pass would also have offered A and B, but it
        // never runs because the exact pass produced a candidate.
        assert_eq!(catalog.detect([r"C:\x\game64.exe"]).unwrap().name, "C");
    }

    // ── Debounce, both edges ────────────────────────────────────────────────

    fn overwatch() -> Match {
        Match {
            name: "Overwatch".into(),
            application_id: "356875221078245376".into(),
        }
    }

    fn deep_rock() -> Match {
        Match {
            name: "Deep Rock Galactic".into(),
            application_id: "1000000000000000002".into(),
        }
    }

    #[test]
    fn one_sighting_is_not_enough() {
        let mut detector = Detector::new();
        let start = Instant::now();

        // An installer or updater sharing the game's executable name appears once and goes.
        assert!(detector.observe(Some(overwatch()), start).is_none());
        assert!(detector.observe(None, start + SCAN_INTERVAL).is_none());
        // And having gone, it starts over rather than resuming its count.
        assert!(detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL * 2)
            .is_none());
        assert!(detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL * 3)
            .is_some());
    }

    #[test]
    fn two_consecutive_sightings_confirm() {
        let mut detector = Detector::new();
        let start = Instant::now();

        assert!(detector.observe(Some(overwatch()), start).is_none());
        let activity = detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL)
            .unwrap();
        assert_eq!(activity.name, "Overwatch");
        assert_eq!(
            activity.application_id.as_deref(),
            Some("356875221078245376")
        );
    }

    #[test]
    fn a_confirmed_match_is_held_across_a_gap_and_dropped_after_linger() {
        let mut detector = Detector::new();
        let start = Instant::now();

        detector.observe(Some(overwatch()), start);
        detector.observe(Some(overwatch()), start + SCAN_INTERVAL);

        // A crash-and-relaunch, or a loading screen: one missed scan must not flap the presence.
        let held = detector.observe(None, start + SCAN_INTERVAL * 2);
        assert!(held.is_some(), "the match must survive a single miss");

        // Beyond the linger window it goes.
        assert!(detector
            .observe(None, start + SCAN_INTERVAL + LINGER)
            .is_none());
    }

    #[test]
    fn a_relaunch_inside_the_linger_window_keeps_the_original_start_time() {
        let mut detector = Detector::new();
        let start = Instant::now();

        detector.observe(Some(overwatch()), start);
        let first = detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL)
            .unwrap();
        let stamped = first.started_at.unwrap();

        // Gone for one scan, back for the next -the game did not restart from the user's point of
        // view, and neither should the timer.
        assert!(detector.observe(None, start + SCAN_INTERVAL * 2).is_some());
        let resumed = detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL * 3)
            .unwrap();
        assert_eq!(resumed.started_at, Some(stamped));
    }

    #[test]
    fn started_at_is_never_restamped_while_the_match_persists() {
        let mut detector = Detector::new();
        let start = Instant::now();

        detector.observe(Some(overwatch()), start);
        let confirmed = detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL)
            .unwrap();
        let stamped = confirmed.started_at.unwrap();

        for tick in 2..20 {
            let activity = detector
                .observe(Some(overwatch()), start + SCAN_INTERVAL * tick)
                .unwrap();
            assert_eq!(
                activity.started_at,
                Some(stamped),
                "restamping is what makes elapsed read 'a few seconds' forever"
            );
        }
    }

    #[test]
    fn a_new_game_replaces_the_old_one_only_once_it_is_confirmed() {
        let mut detector = Detector::new();
        let start = Instant::now();

        detector.observe(Some(overwatch()), start);
        detector.observe(Some(overwatch()), start + SCAN_INTERVAL);

        // First sighting of the new game: the incumbent is still what we report.
        let still_old = detector
            .observe(Some(deep_rock()), start + SCAN_INTERVAL * 2)
            .unwrap();
        assert_eq!(still_old.name, "Overwatch");

        let now_new = detector
            .observe(Some(deep_rock()), start + SCAN_INTERVAL * 3)
            .unwrap();
        assert_eq!(now_new.name, "Deep Rock Galactic");
        assert_eq!(
            now_new.application_id.as_deref(),
            Some("1000000000000000002")
        );
        assert!(now_new.started_at.unwrap() >= still_old.started_at.unwrap());
    }

    #[test]
    fn the_catalog_can_rename_a_game_without_restarting_its_clock() {
        let mut detector = Detector::new();
        let start = Instant::now();

        detector.observe(Some(overwatch()), start);
        let first = detector
            .observe(Some(overwatch()), start + SCAN_INTERVAL)
            .unwrap();

        let renamed = Match {
            name: "Overwatch 2".into(),
            application_id: "356875221078245376".into(),
        };
        let after = detector
            .observe(Some(renamed), start + SCAN_INTERVAL * 2)
            .unwrap();

        assert_eq!(after.name, "Overwatch 2");
        assert_eq!(after.started_at, first.started_at);
    }

    #[test]
    fn confirmed_name_is_what_the_legacy_accessor_returns() {
        let mut detector = Detector::new();
        let start = Instant::now();
        assert_eq!(detector.confirmed_name(), None);

        detector.observe(Some(overwatch()), start);
        assert_eq!(detector.confirmed_name(), None, "unconfirmed is not detected");

        detector.observe(Some(overwatch()), start + SCAN_INTERVAL);
        assert_eq!(detector.confirmed_name().as_deref(), Some("Overwatch"));
    }
}



