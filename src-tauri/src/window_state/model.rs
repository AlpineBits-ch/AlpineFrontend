//! The persisted schema and its sanity rules.
//!
//! Nothing here touches `tauri`. The types are plain data and the two entry
//! points - [`parse_state`] and [`serialize_state`] - are pure functions over
//! bytes, which is what lets every corruption case be tested directly.
//!
//! Two units are in play and mixing them is the bug this module exists to
//! prevent. [`LogicalSize`] and [`LogicalOffset`] are **logical** pixels, the
//! unit the user actually perceives. [`MonitorId`] is **physical**, because it
//! is an identity fingerprint rather than a measurement - see the design doc,
//! `docs/superpowers/specs/2026-08-15-window-geometry-restore-design.md`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Bumped only when the meaning of an existing field changes. A file whose
/// version is not exactly this is treated as corrupt - including a *newer* one,
/// deliberately. See [`ParseError::Version`].
pub const SCHEMA_VERSION: u32 = 1;

/// How much of the window must remain inside a work area, in logical pixels.
/// The main window is `decorations(false)` with a custom titlebar, so the drag
/// handle is the top strip - these are the dimensions of "enough to grab".
pub const MIN_VISIBLE_WIDTH: f64 = 120.0;
pub const MIN_VISIBLE_HEIGHT: f64 = 40.0;

/// Larger than any real display arrangement, small enough to stay well inside
/// what the platform will accept. Values beyond this are nonsense, not extremes.
pub const MAX_LOGICAL_EXTENT: f64 = 32767.0;

/// The range of display scale factors treated as believable. 0.1 and 10.0 are
/// both far outside what any shipping OS offers; the point is to reject 0 and
/// NaN and absurd values, not to police unusual-but-real setups.
pub const MIN_SCALE: f64 = 0.1;
pub const MAX_SCALE: f64 = 10.0;

/// Scale factors are compared with a tolerance because they survive a JSON
/// round trip as decimal text. 1.25 and 1.5 are exact in binary; 1.1 is not.
const SCALE_EPSILON: f64 = 1e-6;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicalSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicalOffset {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhysPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhysSize {
    pub width: u32,
    pub height: u32,
}

/// Identifies a display well enough to recognise it again on the next launch.
///
/// No single field is sufficient on its own. `name` is `None` on some platforms
/// and is renumbered across reboots by some Windows drivers; geometry alone
/// cannot tell two identically-arranged displays apart. Matching walks them in
/// order of confidence - see `placement::match_monitor`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorId {
    /// `\\.\DISPLAY1` on Windows. Optional because `Monitor::name()` is.
    #[serde(default)]
    pub name: Option<String>,
    pub position: PhysPoint,
    pub size: PhysSize,
    pub scale: f64,
}

impl MonitorId {
    /// Same display, unchanged: every field agrees.
    pub fn matches_exactly(&self, other: &MonitorId) -> bool {
        self.name == other.name
            && self.position == other.position
            && self.size == other.size
            && (self.scale - other.scale).abs() < SCALE_EPSILON
    }

    /// Same display, possibly reconfigured. Only meaningful when both names are
    /// present - two `None`s are not evidence of anything.
    pub fn matches_by_name(&self, other: &MonitorId) -> bool {
        match (&self.name, &other.name) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }

    /// The same rectangle in the desktop arrangement. Used when names are
    /// absent or untrustworthy.
    pub fn matches_by_geometry(&self, other: &MonitorId) -> bool {
        self.position == other.position && self.size == other.size
    }
}

/// What the window was, as one value rather than a pair of booleans that can
/// contradict each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    Windowed,
    Maximized,
    Fullscreen,
}

/// One window's remembered geometry.
///
/// `size` and `offset` are *by definition* the last plain-windowed rect -
/// nothing writes them while maximized or fullscreen. That invariant is what
/// makes leaving fullscreen land somewhere sane, and it is enforced at the
/// commit site in `mod.rs`, not here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub size: LogicalSize,
    /// From the origin of `monitor`'s work area, in logical pixels.
    pub offset: LogicalOffset,
    pub monitor: MonitorId,
    pub mode: WindowMode,
}

impl WindowGeometry {
    /// Whether this entry describes a window that could exist.
    ///
    /// This is the layer that catches a file which is valid JSON of exactly the
    /// right shape and still describes an impossible window - a zero-width
    /// rect, a NaN offset, a scale factor of 0. An entry that fails here is
    /// treated as absent, not as an error.
    pub fn is_sane(&self) -> bool {
        // An extent must be a real, positive, bounded number. `is_finite`
        // rejects NaN and both infinities; `> 0.0` also rejects -0.0, which
        // compares equal to zero but is not caught by a `>= 0.0` test.
        let extent = |v: f64| v.is_finite() && v > 0.0 && v <= MAX_LOGICAL_EXTENT;
        // An offset may be negative: a display arranged to the left of primary
        // has a negative work-area origin. Only the magnitude is bounded.
        let offset = |v: f64| v.is_finite() && v.abs() <= MAX_LOGICAL_EXTENT;

        extent(self.size.width)
            && extent(self.size.height)
            && offset(self.offset.x)
            && offset(self.offset.y)
            && self.monitor.size.width > 0
            && self.monitor.size.height > 0
            && self.monitor.scale.is_finite()
            && (MIN_SCALE..=MAX_SCALE).contains(&self.monitor.scale)
    }
}

/// The whole file. `windows` is keyed by window label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateFile {
    pub version: u32,
    pub windows: BTreeMap<String, WindowGeometry>,
}

/// Why a state file could not be read at all. Every variant means the same
/// thing to the caller: quarantine the file and carry on with defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Not JSON, or not the expected shape.
    Malformed,
    /// `version` is missing, or is not [`SCHEMA_VERSION`].
    Version,
}

/// Reads a state file, dropping individual entries that are malformed or
/// insane while keeping the rest.
///
/// Per-entry isolation is the point: `windows` is deserialized as raw JSON
/// values and each one is parsed independently, so a single bad window costs
/// that window only. The plugin this replaces read the whole map in one call
/// and discarded every window when any byte was wrong.
pub fn parse_state(bytes: &[u8]) -> Result<BTreeMap<String, WindowGeometry>, ParseError> {
    /// Entries stay as raw JSON so each can fail on its own. Typing `version`
    /// as `u32` rather than a `Value` is what makes `"version": "1"` malformed
    /// rather than merely wrong-versioned - a file whose header is the wrong
    /// *shape* was not written by any version of this code.
    #[derive(Deserialize)]
    struct RawFile {
        version: Option<u32>,
        #[serde(default)]
        windows: BTreeMap<String, serde_json::Value>,
    }

    let raw: RawFile = serde_json::from_slice(bytes).map_err(|_| ParseError::Malformed)?;

    if raw.version != Some(SCHEMA_VERSION) {
        return Err(ParseError::Version);
    }

    let mut windows = BTreeMap::new();
    for (label, value) in raw.windows {
        match serde_json::from_value::<WindowGeometry>(value) {
            Ok(geometry) if geometry.is_sane() => {
                windows.insert(label, geometry);
            }
            Ok(_) => eprintln!("[window-state] dropping insane entry for '{label}'"),
            Err(e) => eprintln!("[window-state] dropping unreadable entry for '{label}': {e}"),
        }
    }

    Ok(windows)
}

/// Renders a state map as the bytes to write. Pretty-printed: this file is
/// small, is read by humans when something has gone wrong, and is exactly the
/// thing a bug report gets asked for.
pub fn serialize_state(windows: &BTreeMap<String, WindowGeometry>) -> Vec<u8> {
    // Insane entries are filtered rather than trusted to round-trip: serde_json
    // refuses to serialize NaN and infinity, and a write that fails is a write
    // that silently stops persisting anything. Nothing should reach here in
    // that state, which is exactly why it must not be load-bearing.
    let file = StateFile {
        version: SCHEMA_VERSION,
        windows: windows
            .iter()
            .filter(|(_, geometry)| geometry.is_sane())
            .map(|(label, geometry)| (label.clone(), geometry.clone()))
            .collect(),
    };

    serde_json::to_vec_pretty(&file).unwrap_or_else(|e| {
        eprintln!("[window-state] could not serialize state, writing an empty file: {e}");
        format!("{{\n  \"version\": {SCHEMA_VERSION},\n  \"windows\": {{}}\n}}").into_bytes()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> MonitorId {
        MonitorId {
            name: Some("\\\\.\\DISPLAY1".into()),
            position: PhysPoint { x: 0, y: 0 },
            size: PhysSize {
                width: 3840,
                height: 2160,
            },
            scale: 1.5,
        }
    }

    fn geometry() -> WindowGeometry {
        WindowGeometry {
            size: LogicalSize {
                width: 1200.0,
                height: 800.0,
            },
            offset: LogicalOffset { x: 120.0, y: 60.0 },
            monitor: monitor(),
            mode: WindowMode::Windowed,
        }
    }

    fn file_with(entry_json: &str) -> Vec<u8> {
        format!(r#"{{"version":1,"windows":{{"echo":{entry_json}}}}}"#).into_bytes()
    }

    // -- is_sane ------------------------------------------------------------

    #[test]
    fn accepts_a_typical_window() {
        assert!(geometry().is_sane());
    }

    #[test]
    fn rejects_zero_width() {
        let mut g = geometry();
        g.size.width = 0.0;
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_negative_height() {
        let mut g = geometry();
        g.size.height = -800.0;
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_size_beyond_the_extent_limit() {
        let mut g = geometry();
        g.size.width = MAX_LOGICAL_EXTENT + 1.0;
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_non_finite_size() {
        let mut g = geometry();
        g.size.height = f64::INFINITY;
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_nan_offset() {
        let mut g = geometry();
        g.offset.x = f64::NAN;
        assert!(!g.is_sane());
    }

    /// A window can legitimately sit on a display arranged to the left of
    /// primary, which puts its offset origin at negative x. Only the magnitude
    /// is bounded.
    #[test]
    fn accepts_a_negative_offset() {
        let mut g = geometry();
        g.offset.x = -1920.0;
        assert!(g.is_sane());
    }

    #[test]
    fn rejects_offset_beyond_the_extent_limit() {
        let mut g = geometry();
        g.offset.y = -(MAX_LOGICAL_EXTENT + 1.0);
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_a_scale_of_zero() {
        let mut g = geometry();
        g.monitor.scale = 0.0;
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_a_scale_above_the_believable_range() {
        let mut g = geometry();
        g.monitor.scale = MAX_SCALE + 1.0;
        assert!(!g.is_sane());
    }

    #[test]
    fn rejects_a_zero_sized_monitor() {
        let mut g = geometry();
        g.monitor.size.height = 0;
        assert!(!g.is_sane());
    }

    // -- parse_state: whole-file failures -----------------------------------

    #[test]
    fn parse_rejects_empty_input() {
        assert_eq!(parse_state(b""), Err(ParseError::Malformed));
    }

    #[test]
    fn parse_rejects_truncated_json() {
        let bytes = br#"{"version":1,"windows":{"echo":{"size":{"widt"#;
        assert_eq!(parse_state(bytes), Err(ParseError::Malformed));
    }

    /// A zero-length file is what an interrupted non-atomic write leaves
    /// behind. It has to read as corrupt, not as "no windows saved".
    #[test]
    fn parse_rejects_an_empty_object() {
        assert_eq!(parse_state(b"{}"), Err(ParseError::Version));
    }

    #[test]
    fn parse_rejects_a_missing_version() {
        assert_eq!(parse_state(br#"{"windows":{}}"#), Err(ParseError::Version));
    }

    /// A downgraded client must not guess at a schema it does not know.
    #[test]
    fn parse_rejects_a_future_version() {
        let bytes = br#"{"version":999,"windows":{}}"#;
        assert_eq!(parse_state(bytes), Err(ParseError::Version));
    }

    #[test]
    fn parse_rejects_a_non_numeric_version() {
        let bytes = br#"{"version":"1","windows":{}}"#;
        assert_eq!(parse_state(bytes), Err(ParseError::Malformed));
    }

    #[test]
    fn parse_accepts_a_file_with_no_windows() {
        assert_eq!(parse_state(br#"{"version":1,"windows":{}}"#), Ok(BTreeMap::new()));
    }

    // -- parse_state: per-entry isolation ------------------------------------

    #[test]
    fn parse_reads_a_well_formed_entry() {
        let bytes = serialize_state(&BTreeMap::from([("echo".to_string(), geometry())]));
        let parsed = parse_state(&bytes).expect("round trip should parse");
        assert_eq!(parsed.get("echo"), Some(&geometry()));
    }

    #[test]
    fn parse_drops_an_entry_with_wrong_field_types() {
        let parsed = parse_state(&file_with(r#"{"size":"big","mode":"windowed"}"#))
            .expect("one bad entry is not a corrupt file");
        assert!(parsed.is_empty());
    }

    #[test]
    fn parse_drops_an_entry_whose_mode_is_unrecognised() {
        let mut good = geometry();
        good.mode = WindowMode::Windowed;
        let json = serde_json::to_string(&good).unwrap().replace(
            r#""mode":"windowed""#,
            r#""mode":"iconified""#,
        );
        let parsed = parse_state(&file_with(&json)).expect("unknown mode is not a corrupt file");
        assert!(parsed.is_empty());
    }

    /// Parses cleanly, describes an impossible window. This is the case only
    /// `is_sane` can catch.
    #[test]
    fn parse_drops_an_entry_that_parses_but_is_insane() {
        let mut insane = geometry();
        insane.size.width = 0.0;
        let json = serde_json::to_string(&insane).unwrap();
        let parsed = parse_state(&file_with(&json)).expect("an insane entry is not a corrupt file");
        assert!(parsed.is_empty());
    }

    /// The defect that motivated per-entry parsing: upstream loses every
    /// window when any one of them is unreadable.
    #[test]
    fn parse_keeps_the_good_entry_beside_a_bad_one() {
        let good = serde_json::to_string(&geometry()).unwrap();
        let bytes =
            format!(r#"{{"version":1,"windows":{{"echo":{good},"other":"nonsense"}}}}"#).into_bytes();

        let parsed = parse_state(&bytes).expect("one bad entry is not a corrupt file");

        assert_eq!(parsed.get("echo"), Some(&geometry()));
        assert!(!parsed.contains_key("other"));
    }

    #[test]
    fn serialize_then_parse_preserves_every_mode() {
        for mode in [
            WindowMode::Windowed,
            WindowMode::Maximized,
            WindowMode::Fullscreen,
        ] {
            let mut g = geometry();
            g.mode = mode;
            let bytes = serialize_state(&BTreeMap::from([("echo".to_string(), g.clone())]));
            assert_eq!(parse_state(&bytes).unwrap().get("echo"), Some(&g));
        }
    }

    /// `name` is `None` on platforms that do not report one, and the file must
    /// survive a round trip in that state.
    #[test]
    fn serialize_then_parse_preserves_a_nameless_monitor() {
        let mut g = geometry();
        g.monitor.name = None;
        let bytes = serialize_state(&BTreeMap::from([("echo".to_string(), g.clone())]));
        assert_eq!(parse_state(&bytes).unwrap().get("echo"), Some(&g));
    }

    // -- MonitorId matching --------------------------------------------------

    #[test]
    fn exact_match_requires_every_field() {
        let mut other = monitor();
        assert!(monitor().matches_exactly(&other));
        other.scale = 2.0;
        assert!(!monitor().matches_exactly(&other));
    }

    #[test]
    fn exact_match_tolerates_float_round_tripping() {
        let mut other = monitor();
        other.scale = monitor().scale + 1e-12;
        assert!(monitor().matches_exactly(&other));
    }

    #[test]
    fn name_match_survives_a_resolution_change() {
        let mut other = monitor();
        other.size = PhysSize {
            width: 1920,
            height: 1080,
        };
        other.scale = 1.0;
        assert!(!monitor().matches_exactly(&other));
        assert!(monitor().matches_by_name(&other));
    }

    /// Two displays that both report no name are not the same display.
    #[test]
    fn two_nameless_monitors_do_not_match_by_name() {
        let mut a = monitor();
        a.name = None;
        let mut b = monitor();
        b.name = None;
        assert!(!a.matches_by_name(&b));
    }

    #[test]
    fn geometry_match_ignores_the_name() {
        let mut other = monitor();
        other.name = Some("\\\\.\\DISPLAY4".into());
        assert!(monitor().matches_by_geometry(&other));
    }

    /// Two identical panels side by side differ only in where they sit. Without
    /// the position check, geometry matching would pick whichever came first.
    #[test]
    fn geometry_match_requires_the_same_position() {
        let mut other = monitor();
        other.position = PhysPoint { x: 3840, y: 0 };
        assert!(!monitor().matches_by_geometry(&other));
    }

    #[test]
    fn geometry_match_requires_the_same_size() {
        let mut other = monitor();
        other.size = PhysSize {
            width: 1920,
            height: 1080,
        };
        assert!(!monitor().matches_by_geometry(&other));
    }
}

