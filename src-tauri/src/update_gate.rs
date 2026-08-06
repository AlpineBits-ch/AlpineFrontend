//! The pre-launch update gate.
//!
//! Runs before the main window exists, so a build that panics during startup can
//! still receive a fix. Everything here is fail-open: any error at any stage logs
//! and returns, letting the app start on the version already installed. A client
//! that cannot reach the update server must still be a usable client.
//!
//! Diagnostics go through `eprintln!` rather than the `log` facade deliberately -
//! no logger is installed in this crate, so `log::*` would compile and then be
//! silently discarded, which is precisely the wrong failure mode for the code
//! that explains why an update did not happen.

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Decides whether the pre-launch update gate should run.
///
/// Split out as a pure function so the policy is testable without a Tauri app,
/// a network, or a release build.
#[derive(Debug, PartialEq, Eq)]
pub enum GateDecision {
    Run,
    Skip(&'static str),
}

pub fn decide(is_debug: bool, skip_env: Option<&str>) -> GateDecision {
    if is_debug {
        return GateDecision::Skip("debug build");
    }
    if skip_env.is_some_and(|v| !v.is_empty()) {
        return GateDecision::Skip("ALPINE_SKIP_UPDATE_GATE set");
    }
    GateDecision::Run
}

/// Download progress as a whole percentage, or `None` when it cannot be known.
///
/// A separate function because it is the only real logic on the download path,
/// and the surrounding `download_and_install` call cannot be exercised without a
/// live endpoint and a process that exits mid-function. `content_length` is
/// `Option` from the plugin and is genuinely absent for chunked responses, and a
/// server reporting zero must not produce a division by zero or a NaN cast.
fn progress_percent(downloaded: usize, total: Option<u64>) -> Option<u8> {
    total
        .filter(|t| *t > 0)
        .map(|t| ((downloaded as f64 / t as f64) * 100.0).clamp(0.0, 100.0) as u8)
}

/// Pushes one progress tick into the splash page.
///
/// Deliberately infallible: the splash is cosmetic, and a failure to draw a
/// progress bar must never interrupt an update that is otherwise working.
fn report(app: &AppHandle, phase: &str, percent: Option<u8>) {
    let Some(splash) = app.get_webview_window("splash") else {
        return;
    };
    let percent = match percent {
        Some(p) => p.to_string(),
        None => "null".to_string(),
    };
    let js = format!(
        "window.__VENTA_SPLASH__ && window.__VENTA_SPLASH__({{phase:{phase:?},percent:{percent}}})"
    );
    let _ = splash.eval(&js);
}

/// Checks for an update and installs it, before the main window exists.
///
/// On Windows a successful install never returns - `tauri-plugin-updater` hands
/// off to the NSIS installer and calls `std::process::exit(0)`, and the installer
/// relaunches the app itself via its `/R` flag.
pub async fn run(app: &AppHandle) {
    let skip_env = std::env::var("ALPINE_SKIP_UPDATE_GATE").ok();
    match decide(cfg!(debug_assertions), skip_env.as_deref()) {
        GateDecision::Skip(why) => {
            eprintln!("[update-gate] skipped: {why}");
            return;
        }
        GateDecision::Run => {}
    }

    report(app, "checking", None);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[update-gate] updater unavailable: {e}");
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            eprintln!("[update-gate] already up to date");
            return;
        }
        Err(e) => {
            eprintln!("[update-gate] check failed: {e}");
            return;
        }
    };

    eprintln!("[update-gate] installing {}", update.version);
    report(app, "downloading", Some(0));

    let mut downloaded: usize = 0;
    let mut total: Option<u64> = None;

    let result = update
        .download_and_install(
            |chunk, content_length| {
                if total.is_none() {
                    total = content_length;
                }
                downloaded += chunk;
                report(app, "downloading", progress_percent(downloaded, total).or(Some(0)));
            },
            || {
                report(app, "installing", None);
            },
        )
        .await;

    if let Err(e) = result {
        // Fail open. A failed install leaves the current version in place, which
        // is strictly better than refusing to start.
        eprintln!("[update-gate] install failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_in_release_with_no_env_override() {
        assert_eq!(decide(false, None), GateDecision::Run);
    }

    #[test]
    fn skips_in_debug_builds() {
        // `tauri dev` must not try to install an update over the dev server.
        assert!(matches!(decide(true, None), GateDecision::Skip(_)));
    }

    #[test]
    fn skips_when_env_var_is_set_to_anything_non_empty() {
        assert!(matches!(decide(false, Some("1")), GateDecision::Skip(_)));
        assert!(matches!(decide(false, Some("false")), GateDecision::Skip(_)));
    }

    #[test]
    fn empty_env_var_does_not_skip() {
        // An accidentally-exported empty variable should not silently disable
        // the gate in production.
        assert_eq!(decide(false, Some("")), GateDecision::Run);
    }

    #[test]
    fn progress_is_a_whole_percentage_of_the_total() {
        assert_eq!(progress_percent(0, Some(200)), Some(0));
        assert_eq!(progress_percent(50, Some(200)), Some(25));
        assert_eq!(progress_percent(200, Some(200)), Some(100));
    }

    #[test]
    fn progress_is_unknown_without_a_content_length() {
        // Chunked responses report no length; the splash hides the bar rather
        // than inventing a number.
        assert_eq!(progress_percent(1234, None), None);
    }

    #[test]
    fn zero_total_does_not_divide_by_zero() {
        // 1234 / 0 is inf in f64, and `inf as u8` saturates to 255 rather than
        // panicking - a silent 255% instead of a crash. Filtered out up front.
        assert_eq!(progress_percent(1234, Some(0)), None);
    }

    #[test]
    fn progress_clamps_when_the_server_understates_the_length() {
        // A total smaller than what actually arrives would otherwise exceed 100
        // and render as an overflowing bar.
        assert_eq!(progress_percent(500, Some(200)), Some(100));
    }
}
