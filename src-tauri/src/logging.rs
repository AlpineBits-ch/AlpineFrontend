//! Everything the client writes to stderr, teed into a rotating file.
//!
//! Deliberately not a logging facade. The client already says what it needs to say through
//! `eprintln!` - the voice pipeline's per-call stats, the publisher's chosen encoder, every
//! diagnostic added for a failure that could not be reproduced from a user's description - and the
//! native code underneath writes to stderr too, which no Rust-side facade could capture. Taking
//! over the process's own stderr catches all of it, panics included, without touching a call site.
//!
//! The console still gets everything unchanged. `attach_parent_console` exists precisely so a
//! release build started from a terminal can be read at all, and swallowing that to gain a file
//! would be a poor trade.
//!
//! Windows only, like `attach_parent_console` itself. The other targets keep the console-only
//! behaviour they have now rather than growing a second, untested path.

use std::path::PathBuf;

/// Bytes the live log may reach before it is rolled over.
///
/// One file of history is kept, so the worst case on disk is twice this. A megabyte is a few hours
/// of a running call at the five-second stats cadence, which is the window that matters for "it
/// broke just now, send me the log".
const MAX_BYTES: u64 = 1024 * 1024;

/// Start teeing stderr to the log file, returning where it went.
pub fn start() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        windows_impl::start()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::mem::ManuallyDrop;
    use std::os::windows::io::FromRawHandle;
    use std::path::{Path, PathBuf};

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{GetStdHandle, SetStdHandle, STD_ERROR_HANDLE};
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::SystemInformation::GetLocalTime;

    use super::MAX_BYTES;

    pub fn start() -> Option<PathBuf> {
        start_at(log_path()?)
    }

    /// Split from [`start`] so the redirection itself can be exercised against a temporary path.
    /// Nothing else about it is test-only: this is the code that runs in production.
    fn start_at(path: PathBuf) -> Option<PathBuf> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok()?;
        }

        // The handle stderr had before we take it over. Kept so the console keeps working; absent
        // when the app was launched from Explorer and never had one.
        let console = unsafe { GetStdHandle(STD_ERROR_HANDLE) }
            .ok()
            .filter(|handle| !handle.is_invalid())
            .map(|handle| handle.0 as isize);

        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        // A real buffer rather than the system default of about 4 kB. Writing to stderr blocks once
        // the pipe is full, so the whole client would stall behind the pump on a slow or full disk.
        // 64 kB is several seconds of the noisiest thing here, the five-second stats line.
        unsafe { CreatePipe(&mut read, &mut write, None, 64 * 1024) }.ok()?;

        // From here on, everything written to stderr - by us, by a native library, by the panic
        // handler - arrives on the read end of that pipe. `std::io::stderr` resolves the handle per
        // write rather than caching it, which is what makes this work at all.
        unsafe { SetStdHandle(STD_ERROR_HANDLE, write) }.ok()?;

        let reader = unsafe { File::from_raw_handle(read.0 as _) };
        let destination = path.clone();
        std::thread::Builder::new()
            .name("log-pump".into())
            .spawn(move || pump(reader, console, destination))
            .ok()?;

        Some(path)
    }

    /// `%LOCALAPPDATA%\com.alpinebits.venta\logs\venta.log`.
    ///
    /// The same directory Tauri's own `app_log_dir()` resolves to, spelled out rather than asked
    /// for: logging starts before there is an `AppHandle` to ask, and the first thing worth
    /// capturing is whatever happens on the way to having one.
    fn log_path() -> Option<PathBuf> {
        let local = std::env::var_os("LOCALAPPDATA")?;
        Some(
            PathBuf::from(local)
                .join("com.alpinebits.venta")
                .join("logs")
                .join("venta.log"),
        )
    }

    /// Generic over the reader so a test can drive it without hijacking the process's stderr,
    /// which is the one thing a test in this crate must not do to itself.
    fn pump<R: Read>(mut reader: R, console: Option<isize>, path: PathBuf) {
        // Wrapped so dropping it cannot close the console's handle, which we borrowed rather than
        // own.
        let mut console =
            console.map(|raw| unsafe { ManuallyDrop::new(File::from_raw_handle(raw as _)) });

        let mut file = open(&path);
        let mut written = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());

        let mut buffer = [0u8; 8192];
        let mut partial: Vec<u8> = Vec::new();

        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buffer[..read];

            // Byte for byte, so a terminal sees exactly what it saw before this existed.
            if let Some(console) = console.as_mut() {
                let _ = console.write_all(chunk);
            }

            // The file gets whole lines, stamped. Held back across reads because a write to stderr
            // is not guaranteed to end on a line boundary, and half a line with a timestamp in
            // front of it is worse than no timestamp at all.
            partial.extend_from_slice(chunk);
            while let Some(end) = partial.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = partial.drain(..=end).collect();
                emit(&mut file, &mut written, &path, &line);
            }
        }

        // Whatever arrived without a closing newline. `eprintln!` always supplies one, but the last
        // thing a dying process writes is not always an `eprintln!` - and that is precisely the
        // line the log exists for.
        if !partial.is_empty() {
            partial.push(b'\n');
            emit(&mut file, &mut written, &path, &partial);
        }
    }

    /// Write one complete line, rolling the file over first if it would not fit.
    fn emit(file: &mut Option<File>, written: &mut u64, path: &Path, line: &[u8]) {
        let stamped = format!("{} {}", now(), String::from_utf8_lossy(line));

        if *written + stamped.len() as u64 > MAX_BYTES {
            // Closed before renaming: Windows will not rename a file that is still open.
            *file = None;
            roll(path);
            *file = open(path);
            *written = 0;
        }

        if let Some(handle) = file.as_mut() {
            if handle.write_all(stamped.as_bytes()).is_ok() {
                *written += stamped.len() as u64;
            }
        }
    }

    fn open(path: &Path) -> Option<File> {
        OpenOptions::new().create(true).append(true).open(path).ok()
    }

    /// Move the live log aside, replacing whatever was there. One generation, no more: this exists
    /// so a support request can carry the recent past, not so the disk can carry all of it.
    fn roll(path: &Path) {
        let previous = path.with_extension("log.1");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(path, &previous);
    }

    /// Local time, because the person reading this log is the person the clock on the wall belongs
    /// to. Straight from Win32 rather than through a date crate the client does not otherwise need.
    fn now() -> String {
        let t = unsafe { GetLocalTime() };
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("venta-log-test-{name}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// The only test that proves the redirection works, rather than proving the pump does.
        ///
        /// Ignored because it takes over the process's stderr for good, and every test after it in
        /// the same binary would have its output swallowed. Run it on its own:
        /// `cargo test --lib logging -- --ignored --nocapture`
        #[test]
        #[ignore = "hijacks the process's stderr for the rest of the run"]
        fn what_is_written_to_stderr_reaches_the_file() {
            let dir = temp_dir("redirect");
            let live = dir.join("venta.log");

            start_at(live.clone()).expect("the redirection must install");
            eprintln!("[test] a line that must survive the pipe");
            std::panic::catch_unwind(|| panic!("[test] a panic that must survive too")).ok();

            // The pump is a thread reading a pipe; give it a moment to see both.
            std::thread::sleep(std::time::Duration::from_millis(300));

            let text = fs::read_to_string(&live).expect("the log file must exist");
            assert!(
                text.contains("a line that must survive the pipe"),
                "stderr did not reach the file: {text:?}"
            );
            assert!(
                text.contains("a panic that must survive too"),
                "a panic did not reach the file, which is the case it exists for: {text:?}"
            );
        }

        #[test]
        fn a_timestamp_is_a_sortable_local_datetime() {
            // Sortable because the first thing anybody does with a support log is look at the end
            // of it, and the second is diff two of them.
            let stamp = now();
            assert_eq!(stamp.len(), 23, "unexpected shape: {stamp}");
            assert_eq!(&stamp[4..5], "-");
            assert_eq!(&stamp[10..11], " ");
            assert_eq!(&stamp[13..14], ":");
            assert_eq!(&stamp[19..20], ".");
        }

        #[test]
        fn rolling_keeps_exactly_one_generation() {
            let dir = temp_dir("roll");
            let live = dir.join("venta.log");

            fs::write(&live, b"first").unwrap();
            roll(&live);
            assert!(!live.exists(), "the live log should have been moved aside");
            assert_eq!(fs::read(dir.join("venta.log.1")).unwrap(), b"first");

            fs::write(&live, b"second").unwrap();
            roll(&live);
            assert_eq!(
                fs::read(dir.join("venta.log.1")).unwrap(),
                b"second",
                "the older generation must be replaced, not accumulated"
            );
            assert!(
                !dir.join("venta.log.2").exists(),
                "only one generation is kept"
            );
        }

        #[test]
        fn every_line_is_stamped_and_kept_whole() {
            let dir = temp_dir("stamp");
            let live = dir.join("venta.log");

            // Deliberately split mid-line across two reads is not expressible through `&[u8]`, so
            // the partial-line path is covered by the unterminated-tail test below; this pins the
            // shape of what lands in the file.
            pump(&b"first
second
"[..], None, live.clone());

            let text = fs::read_to_string(&live).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            assert_eq!(lines.len(), 2, "got {text:?}");
            assert!(lines[0].ends_with(" first"), "{}", lines[0]);
            assert!(lines[1].ends_with(" second"), "{}", lines[1]);
            assert_eq!(&lines[0][23..24], " ", "timestamp then a space: {}", lines[0]);
        }

        #[test]
        fn a_final_line_without_a_newline_is_not_lost() {
            // `eprintln!` always terminates its line, but the last thing a dying process writes is
            // not always an `eprintln!` - and that is the line the log exists for.
            let dir = temp_dir("tail");
            let live = dir.join("venta.log");

            pump(&b"done
abrupt"[..], None, live.clone());

            let text = fs::read_to_string(&live).unwrap();
            assert!(text.contains("abrupt"), "got {text:?}");
        }

        #[test]
        fn the_log_rolls_over_at_the_size_limit() {
            let dir = temp_dir("rollover");
            let live = dir.join("venta.log");

            // Comfortably past the limit twice over, so both the first roll and a later one run.
            let filler = "x".repeat(200);
            let input: String = (0..12_000).map(|i| format!("{filler} {i}
")).collect();
            assert!(input.len() as u64 > MAX_BYTES * 2, "the input must cross the limit twice");

            pump(input.as_bytes(), None, live.clone());

            let live_len = fs::metadata(&live).unwrap().len();
            assert!(live_len <= MAX_BYTES, "the live log grew to {live_len} bytes");
            assert!(
                dir.join("venta.log.1").exists(),
                "rolling over must leave the previous generation behind"
            );
            assert!(!dir.join("venta.log.2").exists(), "only one generation is kept");

            // The most recent lines are the point of the exercise: a rollover that kept the oldest
            // megabyte and discarded the newest would be worse than no rotation at all.
            let text = fs::read_to_string(&live).unwrap();
            assert!(text.contains(" 11999"), "the newest line is missing after rollover");
        }

        #[test]
        fn rolling_a_log_that_is_not_there_yet_is_harmless() {
            // The first roll of a fresh install, and every roll after a user deletes the folder.
            let dir = temp_dir("missing");
            roll(&dir.join("venta.log"));
        }

        #[test]
        fn the_log_lives_beside_the_rest_of_the_app_data() {
            // Pinned because a support request says "send me %LOCALAPPDATA%\com.alpinebits.venta",
            // and a log written somewhere else is a log nobody sends.
            let Some(path) = log_path() else {
                return;
            };
            assert!(path.ends_with("com.alpinebits.venta/logs/venta.log"), "{path:?}");
        }
    }
}
