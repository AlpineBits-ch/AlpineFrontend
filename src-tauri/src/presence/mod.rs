//! Rich presence: what this machine is doing, and how it gets told to everyone else.
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`model`] | The output contract -the exact shape `presence://changed` delivers. |
//! | [`codec`] | Discord's RPC framing, and the length cap that makes it safe to read. |
//! | [`protocol`] | The RPC conversation as a pure state machine: handshake, nonce echo, rate limit. |
//! | [`ipc`] | The transport: named pipes / Unix sockets, the proxy relay, the connection cap. |
//! | [`detect`] | Catalog-backed process detection: matching, debounce, sticky `started_at`. |
//! | [`arbiter`] | Merges every source by priority and emits `presence://changed` only on change. |
//!
//! ## Who owns the `ProcessScan` slot
//!
//! Exactly one of two paths, never both:
//!
//! * **A catalog is loaded** → the scanner thread started by `spawn_scanner` owns it, on a 15 s
//!   cadence, and `scan_game_process` degrades to a read of the detector's current answer. No
//!   process list is walked twice.
//! * **No catalog** → nothing is scanned in here at all, and the legacy CSV path in
//!   [`crate::rich_presence`] reports through [`report_process_scan`] exactly as before. That is
//!   what keeps a client with no catalog yet working instead of silently reporting nothing.
//!
//! The catalog itself is fetched by the Angular layer -`GET /api/v1/social/games/catalog` is
//! `[Authorize]` and auth lives in the HTTP interceptor stack, so this side cannot fetch it -and
//! handed down through [`presence_load_catalog`]. We own the on-disk cache and the ETag, so the
//! frontend's only job is a conditional GET.
//!
//! **The RPC server does not start by itself.** Binding `discord-ipc-0` takes the socket away from
//! the real Discord for any game that starts afterwards, which is a thing the user has to agree to;
//! [`presence_rpc_start`] is what the settings switch calls.

pub mod arbiter;
pub mod codec;
pub mod detect;
pub mod ipc;
pub mod model;
pub mod protocol;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

use serde::Serialize;
use tauri::Manager;

use arbiter::Arbiter;
use detect::{Catalog, CatalogStats, Detector};
use ipc::{Config, Mode, Server, Status};
use model::{Activity, ActivitySource, ActivityType};

static ARBITER: OnceLock<Arbiter> = OnceLock::new();
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
static CONFIG: OnceLock<Mutex<Config>> = OnceLock::new();

static CATALOG: OnceLock<RwLock<Option<Arc<Catalog>>>> = OnceLock::new();
static CATALOG_ETAG: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static DETECTOR: OnceLock<Mutex<Detector>> = OnceLock::new();
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
static SCANNER_STARTED: AtomicBool = AtomicBool::new(false);

const CATALOG_FILE: &str = "game-catalog.json";
const ETAG_FILE: &str = "game-catalog.etag";

/// Installs the arbiter and, if a catalog was cached on a previous run, the detector with it.
///
/// The cached catalog is loaded on a background thread: it is a couple of megabytes of JSON and this
/// runs inside Tauri's `setup`, where the cost would be a directly visible delay before the window
/// appears.
pub fn init(app: &tauri::AppHandle) {
    let _ = ARBITER.set(Arbiter::new(app.clone()));

    if let Ok(dir) = app.path().app_data_dir() {
        let _ = CACHE_DIR.set(dir);
    }

    std::thread::spawn(load_cached_catalog);
}

/// The process-wide arbiter, or `None` if [`init`] has not run (mobile, or a unit test).
///
/// `&'static` rather than an `Arc` because every RPC connection task holds one for as long as it
/// lives and the arbiter outlives all of them by construction.
pub fn arbiter() -> Option<&'static Arbiter> {
    ARBITER.get()
}

fn server_slot() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

fn config_slot() -> &'static Mutex<Config> {
    CONFIG.get_or_init(|| Mutex::new(Config::default()))
}

fn catalog_slot() -> &'static RwLock<Option<Arc<Catalog>>> {
    CATALOG.get_or_init(|| RwLock::new(None))
}

fn etag_slot() -> &'static RwLock<Option<String>> {
    CATALOG_ETAG.get_or_init(|| RwLock::new(None))
}

fn detector_slot() -> &'static Mutex<Detector> {
    DETECTOR.get_or_init(|| Mutex::new(Detector::new()))
}

fn catalog_snapshot() -> Option<Arc<Catalog>> {
    catalog_slot()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Whether catalog-backed detection is live. The legacy CSV path defers to this.
pub fn catalog_loaded() -> bool {
    catalog_snapshot().is_some()
}

/// The current confirmed detection, for the legacy `scan_game_process` accessor.
pub fn detected_game_name() -> Option<String> {
    detector_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .confirmed_name()
}

// ── Catalog plumbing ────────────────────────────────────────────────────────

/// The platform key the catalog endpoint and the rules are tagged with.
///
/// Windows is the only one with meaningful coverage -11,144 of 11,218 executable rules, against 67
/// for macOS and 7 for Linux -so on the other two this is honest rather than useful.
fn os_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn cache_path(file: &str) -> Option<PathBuf> {
    CACHE_DIR.get().map(|dir| dir.join(file))
}

/// Reads the catalog cached by a previous run.
///
/// Silent on every failure: having no catalog is an ordinary state -a fresh install, a client that
/// has not signed in yet -and not something to warn about on every start.
fn load_cached_catalog() {
    let Some(path) = cache_path(CATALOG_FILE) else {
        return;
    };
    let Ok(json) = std::fs::read_to_string(&path) else {
        return;
    };

    match Catalog::compile(&json, os_key()) {
        Ok(catalog) => {
            // The ETag is only trusted alongside a catalog that actually parsed. Keeping one for an
            // unreadable body would make the server answer 304 forever and leave detection
            // permanently dead with no visible cause.
            let etag = cache_path(ETAG_FILE)
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|etag| etag.trim().to_owned())
                .filter(|etag| !etag.is_empty());
            // `IfAbsent`, and it is load-bearing. This runs on a background thread while the webview
            // is booting, and the webview's first act is to sync the catalog. If the network round
            // trip wins the race, an unconditional install here would replace the freshly fetched
            // catalog with the stale one we were only reading as a starting point.
            install_catalog(catalog, etag, Install::IfAbsent);
        }
        Err(_) => {
            // A truncated or half-written cache: drop it, along with its ETag, so the next sync
            // re-fetches in full rather than sending a conditional request that answers 304.
            let _ = std::fs::remove_file(&path);
            if let Some(etag_path) = cache_path(ETAG_FILE) {
                let _ = std::fs::remove_file(etag_path);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Install {
    /// A freshly fetched catalog: it is newer than anything we hold by construction.
    Replace,
    /// A catalog read back from disk: only useful if nothing better arrived first.
    IfAbsent,
}

fn install_catalog(catalog: Catalog, etag: Option<String>, mode: Install) {
    {
        let mut slot = catalog_slot().write().unwrap_or_else(|e| e.into_inner());
        if mode == Install::IfAbsent && slot.is_some() {
            return;
        }
        // The ETag is swapped under the catalog's own lock so the pair can never be observed
        // half-updated -a reader that saw the new ETag beside the old catalog would send a
        // conditional request the server answers 304 to, and keep the wrong catalog forever.
        *etag_slot().write().unwrap_or_else(|e| e.into_inner()) = etag;
        *slot = Some(Arc::new(catalog));
    }

    // Outside the lock: the scanner's first act is to read it.
    if let Some(arbiter) = arbiter() {
        spawn_scanner(arbiter);
    }
}

/// Starts the process scanner. Idempotent; the thread lives for the process.
///
/// A plain OS thread rather than a tokio task, matching `ptt_hook`'s worker: `refresh_processes`
/// is a synchronous syscall sweep that can take tens of milliseconds, which is exactly what must
/// not sit on an async executor's worker.
fn spawn_scanner(arbiter: &'static Arbiter) {
    if SCANNER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    std::thread::spawn(move || {
        // `System::new()`, not `new_all()`: nothing but the process list is ever refreshed, and
        // `new_all` would collect CPU, memory, disk and network for the whole machine up front.
        let mut system = sysinfo::System::new();

        loop {
            if let Some(catalog) = catalog_snapshot() {
                let paths = detect::scan_process_paths(&mut system);
                let matched = catalog.detect(paths.iter().map(String::as_str));

                let activity = detector_slot()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .observe(matched, Instant::now());

                arbiter.set_source(ActivitySource::ProcessScan, activity.into_iter().collect());
            }

            std::thread::sleep(detect::SCAN_INTERVAL);
        }
    });
}

/// Feeds a legacy CSV sighting into the arbiter.
///
/// Only reached when no catalog is loaded -see the module docs. Once one is, the scanner thread
/// owns the `ProcessScan` slot and this would fight it.
pub fn report_process_scan(game: Option<String>) {
    let Some(arbiter) = arbiter() else {
        return;
    };
    if catalog_loaded() {
        return;
    }

    let activities = game
        .as_deref()
        .and_then(|name| model::sanitize(name, model::MAX_TEXT))
        .map(|name| {
            vec![Activity {
                kind: ActivityType::Playing,
                name,
                details: None,
                state: None,
                // The legacy CSV carries no application ids, so the server drops these on arrival.
                // That is precisely why the catalog exists; this path survives only so a client
                // without one still renders something locally.
                application_id: None,
                // Left unset on purpose: the arbiter stamps it once and then holds it, so a scan
                // every 30 s does not reset the elapsed timer.
                started_at: None,
                ends_at: None,
                assets: None,
                party: None,
                source: ActivitySource::ProcessScan,
            }]
        })
        .unwrap_or_default();

    arbiter.set_source(ActivitySource::ProcessScan, activities);
}

/// What the frontend needs in order to decide whether to re-fetch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogState {
    pub loaded: bool,
    /// The catalog's own version string, as the server stated it.
    pub version: Option<String>,
    /// The value to send back as `If-None-Match`.
    pub etag: Option<String>,
    /// The platform key to request, so the frontend does not duplicate the mapping.
    pub os: String,
    pub stats: CatalogStats,
}

fn catalog_state() -> CatalogState {
    let catalog = catalog_snapshot();
    CatalogState {
        loaded: catalog.is_some(),
        version: catalog.as_ref().map(|c| c.version().to_owned()),
        etag: etag_slot()
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        os: os_key().to_owned(),
        stats: catalog.map(|catalog| catalog.stats()).unwrap_or_default(),
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// What the frontend should send as `If-None-Match`, and whether detection is live at all.
#[tauri::command]
pub fn presence_catalog_state() -> CatalogState {
    catalog_state()
}

/// Installs a freshly fetched catalog and caches it for the next run.
///
/// Parsing happens before anything is written, so a malformed body neither replaces a working
/// catalog nor poisons the cache. The write is atomic (temp file, then rename) for the same reason:
/// a crash mid-write must not leave a half-catalog that the next start would refuse, delete, and
/// then re-request as a 304.
#[tauri::command]
pub async fn presence_load_catalog(
    json: String,
    etag: Option<String>,
) -> Result<CatalogState, String> {
    let os = os_key();
    // Compiling ~10k games and ~11k rules is single-digit-hundreds of milliseconds and would
    // otherwise run on the command's executor thread.
    let (catalog, json) = tauri::async_runtime::spawn_blocking(move || {
        Catalog::compile(&json, os).map(|catalog| (catalog, json))
    })
    .await
    .map_err(|e| e.to_string())??;

    write_cache(&json, etag.as_deref());
    install_catalog(catalog, etag, Install::Replace);
    Ok(catalog_state())
}

fn write_cache(json: &str, etag: Option<&str>) {
    let Some(path) = cache_path(CATALOG_FILE) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, json).is_err() || std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&temp);
        return;
    }

    // Written only after the body it describes, and removed when there is none: an ETag ahead of
    // its catalog makes the server answer 304 to a client that has nothing to match it with.
    if let Some(etag_path) = cache_path(ETAG_FILE) {
        match etag {
            Some(etag) => {
                let _ = std::fs::write(etag_path, etag);
            }
            None => {
                let _ = std::fs::remove_file(etag_path);
            }
        }
    }
}

/// Starts the Discord-compatible RPC server.
///
/// `mode` is `"proxy"` (default) or `"exclusive"`; anything else is read as proxy. Idempotent -
/// calling it while the server is already running returns the running server's status rather than
/// binding a second endpoint.
#[tauri::command]
pub async fn presence_rpc_start(mode: Option<String>) -> Result<Status, String> {
    let arbiter = arbiter().ok_or("presence is not initialised on this platform")?;

    let mode = Mode::parse(mode.as_deref());
    let config = {
        let mut config = config_slot().lock().unwrap_or_else(|e| e.into_inner());
        config.mode = mode;
        config.clone()
    };

    let mut slot = server_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = slot.as_ref() {
        let status = existing.status();
        if status.running && status.mode == mode {
            return Ok(status);
        }
        // A mode change is a restart: the mode is decided per connection at accept time, so an
        // already-running listener would keep serving the old one.
        existing.stop();
        *slot = None;
    }

    let server = ipc::start(config, arbiter).map_err(|e| e.to_string())?;
    let status = server.status();
    *slot = Some(server);
    Ok(status)
}

/// Stops the RPC server. Live connections unwind and release their arbiter slots.
#[tauri::command]
pub async fn presence_rpc_stop() -> Status {
    let mut slot = server_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(server) = slot.take() {
        server.stop();
    }
    let config = config_slot().lock().unwrap_or_else(|e| e.into_inner());
    Status::stopped(config.mode, config.max_connections)
}

#[tauri::command]
pub fn presence_rpc_status() -> Status {
    let slot = server_slot().lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_ref() {
        Some(server) => server.status(),
        None => {
            let config = config_slot().lock().unwrap_or_else(|e| e.into_inner());
            Status::stopped(config.mode, config.max_connections)
        }
    }
}

/// The current merged activity list.
///
/// `presence://changed` is the real channel; this exists so a frontend that started late -a webview
/// reload, a settings page opening -can read the state without waiting for the next change.
#[tauri::command]
pub fn presence_current() -> Vec<Activity> {
    arbiter().map(Arbiter::current).unwrap_or_default()
}
