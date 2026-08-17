// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Reattach the release build's output to the terminal it was started from, if there is one.
///
/// `windows_subsystem = "windows"` above is what stops a console window appearing when the app is
/// launched from Explorer or the Start menu, and it must stay. What it also does is leave the
/// process with no standard handles at all, and Rust's `Stderr` quietly discards writes when the
/// handle is absent - so every `eprintln!` in the client, including the whole `[voice]` trace, goes
/// nowhere in exactly the build users run. A released build could not be diagnosed at all: the only
/// way to see any of it was to run a debug build, which is a different executable with different
/// timing, and therefore not evidence about the one that is broken.
///
/// `AttachConsole(ATTACH_PARENT_PROCESS)` adopts the console of whatever started us and points the
/// standard handles at it. It fails harmlessly when there is no parent console, which is the
/// Explorer case, so the double-click behaviour is unchanged and no window is created here.
///
/// This must run before anything writes to stderr - Rust looks the handle up per write, but the
/// first `[update-gate]` line is emitted early enough to be worth not racing.
#[cfg(all(windows, not(debug_assertions)))]
fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    // Errors are the normal case, not a fault: there is no parent console when the app is launched
    // from Explorer, and one is already attached if the shell provided it.
    let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

#[cfg(not(all(windows, not(debug_assertions))))]
fn attach_parent_console() {}

fn main() {
    attach_parent_console();
    alpine_lib::run()
}
