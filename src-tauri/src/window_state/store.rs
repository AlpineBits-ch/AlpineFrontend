//! Getting the state file on and off disk without ever costing the user a
//! window.
//!
//! [`Store::load`] is infallible by design. Every failure - missing, empty,
//! unparseable, wrong version - degrades to "nothing saved", which the caller
//! already handles as the first-launch case. There is deliberately no way for a
//! damaged file to surface as an error the startup path has to decide about.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::model::{parse_state, serialize_state, WindowGeometry};

/// Not `.window-state.json`: that name belongs to the plugin this replaces, and
/// its contents are physical pixels with no monitor identity. A new name means
/// an old file is ignored rather than misread.
pub const FILE_NAME: &str = "window-geometry.json";

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            path: dir.as_ref().join(FILE_NAME),
        }
    }

    /// The file being written, and the file set aside when it could not be
    /// read. Both sit beside the real one so the rename stays within a
    /// directory, which is what makes it atomic.
    fn tmp_path(&self) -> PathBuf {
        self.path.with_extension("json.tmp")
    }

    fn corrupt_path(&self) -> PathBuf {
        self.path.with_extension("json.corrupt")
    }

    /// Reads the saved state, quarantining the file if it cannot be read.
    ///
    /// Never fails: an absent, empty, malformed or wrong-version file all
    /// produce an empty map, which the caller treats as a first launch.
    pub fn load(&self) -> BTreeMap<String, WindowGeometry> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            // Absent is the first-launch case and not worth a log line. Any
            // other read error (permissions, a directory in the way) is worth
            // one, but is still not worth failing startup over.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
            Err(e) => {
                eprintln!("[window-state] could not read {}: {e}", self.path.display());
                return BTreeMap::new();
            }
        };

        match parse_state(&bytes) {
            Ok(windows) => windows,
            Err(reason) => {
                self.quarantine(reason);
                BTreeMap::new()
            }
        }
    }

    /// Moves an unreadable file aside so the next save has a free path.
    ///
    /// It is renamed rather than deleted: this is a bug that by definition
    /// reproduces rarely, and the file is the only evidence of it. Renaming
    /// also has to succeed for the feature to keep working at all - a file left
    /// in place would fail to parse on every launch from here on.
    fn quarantine(&self, reason: super::model::ParseError) {
        let target = self.corrupt_path();
        eprintln!(
            "[window-state] {} is unreadable ({reason:?}); moving it to {} and starting fresh",
            self.path.display(),
            target.display()
        );

        if let Err(e) = std::fs::rename(&self.path, &target) {
            eprintln!("[window-state] could not quarantine the file: {e}");
            // Falling back to removal keeps the feature working at the cost of
            // the evidence. A file that can be neither read nor moved would
            // otherwise break every launch from here on.
            if let Err(e) = std::fs::remove_file(&self.path) {
                eprintln!("[window-state] could not remove it either: {e}");
            }
        }
    }

    /// Writes the state atomically: a full write to a sibling temporary file,
    /// flushed to the device, then renamed over the target.
    ///
    /// An interrupted write therefore leaves either the previous file or the
    /// new one, never a truncated one. `std::fs::write` - what the plugin this
    /// replaces used - truncates the target before writing, so a crash in that
    /// window leaves a zero-length file that reads as corrupt on next launch.
    pub fn save(&self, windows: &BTreeMap<String, WindowGeometry>) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let tmp = self.tmp_path();
        let bytes = serialize_state(windows);

        {
            // `File::create` truncates a stale .tmp from an earlier crash,
            // which is the only thing that should ever be done with one.
            let mut file = File::create(&tmp)?;
            file.write_all(&bytes)?;
            // Without this the rename can land before the contents do, and a
            // power loss leaves a correctly-named empty file - the exact
            // failure the atomic write exists to prevent.
            file.sync_all()?;
        }

        // No `remove_file` first: `std::fs::rename` maps to `MoveFileExW` with
        // `MOVEFILE_REPLACE_EXISTING` on Windows and `rename(2)` elsewhere, so
        // it replaces the target in one step. Removing first would open a
        // window in which the file simply does not exist.
        std::fs::rename(&tmp, &self.path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_state::model::{
        LogicalOffset, LogicalSize, MonitorId, PhysPoint, PhysSize, WindowMode,
    };
    use tempfile::TempDir;

    fn geometry(width: f64) -> WindowGeometry {
        WindowGeometry {
            size: LogicalSize {
                width,
                height: 800.0,
            },
            offset: LogicalOffset { x: 120.0, y: 60.0 },
            monitor: MonitorId {
                name: Some("\\\\.\\DISPLAY1".into()),
                position: PhysPoint { x: 0, y: 0 },
                size: PhysSize {
                    width: 3840,
                    height: 2160,
                },
                scale: 1.5,
            },
            mode: WindowMode::Windowed,
        }
    }

    fn one(width: f64) -> BTreeMap<String, WindowGeometry> {
        BTreeMap::from([("echo".to_string(), geometry(width))])
    }

    // -- the ordinary path ---------------------------------------------------

    #[test]
    fn load_returns_nothing_when_no_file_exists() {
        let dir = TempDir::new().unwrap();
        assert!(Store::new(dir.path()).load().is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());

        store.save(&one(1200.0)).unwrap();

        assert_eq!(store.load(), one(1200.0));
    }

    #[test]
    fn save_replaces_a_previous_file() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());

        store.save(&one(1200.0)).unwrap();
        store.save(&one(1600.0)).unwrap();

        assert_eq!(store.load(), one(1600.0));
    }

    #[test]
    fn save_creates_a_missing_directory() {
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("config").join("Venta");
        let store = Store::new(&nested);

        store.save(&one(1200.0)).unwrap();

        assert_eq!(store.load(), one(1200.0));
    }

    // -- atomicity -----------------------------------------------------------

    #[test]
    fn save_leaves_no_temporary_file_behind() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());

        store.save(&one(1200.0)).unwrap();

        assert!(
            !store.tmp_path().exists(),
            "a surviving .tmp means the rename did not happen"
        );
    }

    /// A `.tmp` left by a previous crash must be overwritten, not read and not
    /// treated as an obstacle.
    #[test]
    fn save_overwrites_a_stale_temporary_file() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(store.tmp_path(), b"leftover garbage from a crash").unwrap();

        store.save(&one(1200.0)).unwrap();

        assert_eq!(store.load(), one(1200.0));
        assert!(!store.tmp_path().exists());
    }

    // -- corruption ----------------------------------------------------------

    /// The signature of an interrupted non-atomic write.
    #[test]
    fn load_quarantines_a_zero_length_file() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(&store.path, b"").unwrap();

        assert!(store.load().is_empty());
        assert!(store.corrupt_path().exists());
    }

    #[test]
    fn load_quarantines_malformed_json() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(&store.path, b"{\"version\":1,\"windo").unwrap();

        assert!(store.load().is_empty());
        assert_eq!(
            std::fs::read(store.corrupt_path()).unwrap(),
            b"{\"version\":1,\"windo",
            "the bad file is preserved as evidence, not deleted"
        );
    }

    #[test]
    fn load_quarantines_an_unknown_version() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(&store.path, br#"{"version":999,"windows":{}}"#).unwrap();

        assert!(store.load().is_empty());
        assert!(store.corrupt_path().exists());
    }

    /// Quarantining moves the file aside, so the path is free for the next
    /// save - otherwise one corruption would poison every later launch.
    #[test]
    fn a_quarantined_file_leaves_the_path_free_to_write_again() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(&store.path, b"garbage").unwrap();

        assert!(store.load().is_empty());
        assert!(!store.path.exists(), "the bad file was moved, not copied");

        store.save(&one(1200.0)).unwrap();
        assert_eq!(store.load(), one(1200.0));
    }

    #[test]
    fn quarantine_replaces_an_earlier_quarantined_file() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());

        std::fs::write(&store.path, b"first failure").unwrap();
        store.load();
        std::fs::write(&store.path, b"second failure").unwrap();
        store.load();

        assert_eq!(
            std::fs::read(store.corrupt_path()).unwrap(),
            b"second failure"
        );
    }

    /// Per-entry isolation, end to end: one unreadable window must not cost the
    /// others, and this is not a corrupt file so nothing is quarantined.
    #[test]
    fn load_keeps_a_good_entry_beside_a_bad_one() {
        let dir = TempDir::new().unwrap();
        let store = Store::new(dir.path());
        let good = serde_json::to_string(&geometry(1200.0)).unwrap();
        std::fs::write(
            &store.path,
            format!(r#"{{"version":1,"windows":{{"echo":{good},"ghost":42}}}}"#),
        )
        .unwrap();

        let loaded = store.load();

        assert_eq!(loaded.get("echo"), Some(&geometry(1200.0)));
        assert!(!loaded.contains_key("ghost"));
        assert!(
            !store.corrupt_path().exists(),
            "a droppable entry is not a corrupt file"
        );
    }
}
