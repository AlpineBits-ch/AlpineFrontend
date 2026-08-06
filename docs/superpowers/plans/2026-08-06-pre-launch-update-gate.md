# Pre-Launch Update Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check for and install updates in a small splash window *before* the main app window is created, so a client that crashes on startup can still receive a fix.

**Architecture:** The `echo` window stops being declared in `tauri.conf.json` and is built in Rust instead. On launch, `setup()` creates a small frameless `splash` window that loads a static HTML file (no Angular), runs a blocking update check against the existing updater endpoint, and only then builds `echo` and closes the splash. Everything that can panic — `presence::init`, `ptt_hook::init`, deep-link registration, OpenH264 provisioning — moves to *after* the gate, so a panic in any of them no longer prevents the client from updating itself. The gate fails open: any error at any stage proceeds to launch.

**Tech Stack:** Rust, Tauri 2, `tauri-plugin-updater` 2.10.1, `tauri-plugin-window-state` (vendored), static HTML/CSS for the splash.

## Global Constraints

- Do not change the updater endpoint: `https://api.venta.gg/api/v1/update/check/{{current_version}}`.
- Do not change the minisign `pubkey` in `tauri.conf.json`.
- The main window's label stays exactly `echo`. Angular, the capabilities files, and `tauri-plugin-window-state`'s saved geometry all key off that string.
- The gate is **fail-open**. Every error path — network down, malformed response, signature failure, install failure — logs and proceeds to launch the app. A broken updater must never stop the app from starting.
- The gate must not run in debug builds. Gate on `#[cfg(not(debug_assertions))]` plus an `ALPINE_SKIP_UPDATE_GATE` env-var escape hatch for testing release builds locally.
- Desktop only. All new code is behind `#[cfg(not(any(target_os = "android", target_os = "ios")))]`, matching the existing module gating in `src-tauri/src/lib.rs:3-25`.
- Splash window label is `splash`. It needs its own capability file; it must NOT inherit the `default` capability (which is scoped to `["*", "echo"]` and grants far more than a splash needs).
- Rust edition 2021, matching `src-tauri/Cargo.toml`.

---

## Background: why `echo` must move out of the config

`src-tauri/tauri.conf.json` declares the `echo` window with `"visible": false`. That is not enough to keep it hidden. The vendored `tauri-plugin-window-state` registers an `on_window_ready` hook (`src-tauri/vendor/tauri-plugin-window-state/src/lib.rs:421`) which calls `restore_state`, and that function ends with:

```rust
if flags.contains(StateFlags::VISIBLE) && should_show {
    self.show()?;
    self.set_focus()?;
}
```

(`src-tauri/vendor/tauri-plugin-window-state/src/lib.rs:262-265`)

`should_show` is initialised to `true` (line 179) and `StateFlags::VISIBLE` is in the default flag set. A config-declared window is created during `Builder::run` before our `setup()` body finishes, so `echo` is shown almost immediately whatever the config says.

Building `echo` in Rust after the gate fixes this and keeps window-state working: `on_window_ready` still fires when we build it, so geometry restore and the vendored maximize fix are unaffected.

## File Structure

**Create:**
- `src-tauri/src/update_gate.rs` — the gate. Decision logic (pure, unit-tested) plus the async run loop that drives `tauri-plugin-updater` and emits progress to the splash.
- `src-tauri/src/main_window.rs` — one function that builds the `echo` window, holding the config previously in `tauri.conf.json`.
- `src/assets/splash.html` — the splash UI. Static, self-contained, no Angular, no build step. Lands at `dist/alpine/browser/assets/splash.html` via the existing asset glob in `angular.json`.
- `src-tauri/capabilities/splash.json` — minimal capability for the `splash` window.

**Modify:**
- `src-tauri/src/lib.rs:331-380` — reorder `setup()`; add `mod` declarations.
- `src-tauri/tauri.conf.json` — remove `app.windows[0]`; change `plugins.updater.windows.installMode` to `quiet`.

**Test:**
- `src-tauri/src/update_gate.rs` — `#[cfg(test)] mod tests` at the bottom of the file, matching the convention used elsewhere in this crate (e.g. `src-tauri/src/presence/detect.rs:685`).

---

### Task 1: Gate decision logic

The one genuinely unit-testable piece. Whether the gate should run at all is a pure function of build profile and environment, so it gets tests; the network path does not (see Task 3's note).

**Files:**
- Create: `src-tauri/src/update_gate.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod update_gate;`)
- Test: `src-tauri/src/update_gate.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum GateDecision { Run, Skip(&'static str) }` and
  `pub fn decide(is_debug: bool, skip_env: Option<&str>) -> GateDecision`.
  Task 3 calls `decide`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/update_gate.rs` with only the test module and the type signatures it needs:

```rust
/// Decides whether the pre-launch update gate should run.
///
/// Split out as a pure function so the policy is testable without a Tauri app,
/// a network, or a release build.
#[derive(Debug, PartialEq, Eq)]
pub enum GateDecision {
    Run,
    Skip(&'static str),
}

pub fn decide(_is_debug: bool, _skip_env: Option<&str>) -> GateDecision {
    todo!()
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
}
```

Add to `src-tauri/src/lib.rs`, next to the other desktop-only modules (after line 22):

```rust
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod update_gate;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --no-default-features update_gate`

(`--no-default-features` turns off `aec`, which needs meson/ninja on PATH — see the note in `src-tauri/Cargo.toml`. The gate has nothing to do with audio, so skipping it makes the cycle much faster.)

Expected: FAIL — panics with `not yet implemented` on all four tests.

- [ ] **Step 3: Write minimal implementation**

Replace the `todo!()` body:

```rust
pub fn decide(is_debug: bool, skip_env: Option<&str>) -> GateDecision {
    if is_debug {
        return GateDecision::Skip("debug build");
    }
    if skip_env.is_some_and(|v| !v.is_empty()) {
        return GateDecision::Skip("ALPINE_SKIP_UPDATE_GATE set");
    }
    GateDecision::Run
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --no-default-features update_gate`
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/update_gate.rs src-tauri/src/lib.rs
git commit -m "feat(updater): add pre-launch gate decision logic"
```

---

### Task 2: Splash window UI and capability

A static page with no framework. It must render instantly — its whole purpose is to appear before anything heavy loads.

**Files:**
- Create: `src/assets/splash.html`
- Create: `src-tauri/capabilities/splash.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a page that listens for a Tauri event named `update://progress` with payload
  `{ phase: "checking" | "downloading" | "installing", percent: number | null }`.
  Task 3 emits exactly that event name and payload shape.

- [ ] **Step 1: Write the splash page**

Create `src/assets/splash.html`. Colours are lifted from `src/index.html`'s existing `#app-loading` overlay so the two are visually continuous:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Venta</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background: transparent;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        user-select: none;
        cursor: default;
      }
      .shell {
        height: 100%;
        border-radius: 12px;
        background: #06090f;
        border: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 22px;
      }
      .ring {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 2.5px solid rgba(75, 91, 196, 0.18);
        border-top-color: #4b5bc4;
        border-right-color: rgba(75, 91, 196, 0.55);
        animation: spin 0.85s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .label {
        color: rgba(255, 255, 255, 0.6);
        font-size: 0.8125rem;
        letter-spacing: 0.01em;
      }
      .track {
        width: 180px;
        height: 3px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }
      .bar {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: #4b5bc4;
        transition: width 0.2s ease;
      }
      .track[hidden] { display: none; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="ring"></div>
      <div class="label" id="label">Checking for updates…</div>
      <div class="track" id="track" hidden><div class="bar" id="bar"></div></div>
    </div>
    <script>
      const LABELS = {
        checking: 'Checking for updates…',
        downloading: 'Downloading update…',
        installing: 'Installing update…',
      };
      const label = document.getElementById('label');
      const track = document.getElementById('track');
      const bar = document.getElementById('bar');

      // The splash is a plain page outside the Angular bundle, so it has no
      // bundler and cannot resolve the '@tauri-apps/api' bare specifier.
      // Rust drives it through WebviewWindow::eval instead, calling this hook
      // directly - which also needs no capability grant and cannot race a
      // splash that has not finished parsing. A dropped tick is cosmetic.
      window.__VENTA_SPLASH__ = (payload) => {
        const { phase, percent } = payload;
        label.textContent = LABELS[phase] ?? LABELS.checking;
        if (typeof percent === 'number') {
          track.hidden = false;
          bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
        } else {
          track.hidden = true;
        }
      };
    </script>
  </body>
</html>
```

- [ ] **Step 2: Create the splash capability**

Create `src-tauri/capabilities/splash.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "description": "Minimal capability for the pre-launch update splash window",
  "identifier": "splash",
  "windows": ["splash"],
  "permissions": []
}
```

The splash calls no commands — Rust drives it entirely through `eval` — so it needs no permissions at all. An empty list is correct, not an oversight.

- [ ] **Step 3: Verify the splash renders standalone**

Run: `bun run build`
Then confirm the file was copied:

Run: `ls dist/alpine/browser/assets/splash.html`
Expected: the file exists.

Open `dist/alpine/browser/assets/splash.html` directly in a browser. Expected: dark rounded panel, spinning ring, "Checking for updates…", no progress bar. In the browser console, run `window.__VENTA_SPLASH__({phase:'downloading',percent:40})` and confirm the label changes and the bar fills to 40%.

- [ ] **Step 4: Commit**

```bash
git add src/assets/splash.html src-tauri/capabilities/splash.json
git commit -m "feat(updater): add pre-launch splash page and capability"
```

---

### Task 3: The gate itself

**Files:**
- Modify: `src-tauri/src/update_gate.rs`

**Interfaces:**
- Consumes: `decide` / `GateDecision` from Task 1; the `window.__VENTA_SPLASH__` hook from Task 2.
- Produces: `pub async fn run(app: &tauri::AppHandle) -> ()`. Task 5 awaits this
  between creating the splash and building `echo`. It never returns an error —
  fail-open is enforced inside.

- [ ] **Step 1: Write the implementation**

Append to `src-tauri/src/update_gate.rs`:

```rust
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

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
/// Fail-open by construction: every branch that can go wrong logs and returns,
/// letting the app start on the version already installed. A client that cannot
/// reach the update server must still be a usable client.
///
/// On Windows a successful install never returns - `tauri-plugin-updater` hands
/// off to the NSIS installer and calls `std::process::exit(0)`, and the
/// installer relaunches the app itself via its `/R` flag.
pub async fn run(app: &AppHandle) {
    match decide(cfg!(debug_assertions), std::env::var("ALPINE_SKIP_UPDATE_GATE").ok().as_deref()) {
        GateDecision::Skip(why) => {
            log::info!("update gate skipped: {why}");
            return;
        }
        GateDecision::Run => {}
    }

    report(app, "checking", None);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("update gate: updater unavailable: {e}");
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            log::info!("update gate: already up to date");
            return;
        }
        Err(e) => {
            log::warn!("update gate: check failed: {e}");
            return;
        }
    };

    log::info!("update gate: installing {}", update.version);
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
                let percent = total.map(|t| {
                    ((downloaded as f64 / t as f64) * 100.0).clamp(0.0, 100.0) as u8
                });
                report(app, "downloading", percent.or(Some(0)));
            },
            || {
                report(app, "installing", None);
            },
        )
        .await;

    if let Err(e) = result {
        // Fail open. A failed install leaves the current version in place, which
        // is strictly better than refusing to start.
        log::warn!("update gate: install failed: {e}");
    }
}
```

- [ ] **Step 2: Add the `log` dependency**

`tauri-plugin-updater` already pulls in `log`, but this crate does not declare it. Add to `src-tauri/Cargo.toml` under `[dependencies]`, after the `sha2` entry:

```toml
# Used by update_gate, which must report why it bailed. The updater plugin logs
# through the same facade, so gate and plugin messages interleave in order.
log = "0.4"
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check --no-default-features`
Expected: no errors. Warnings about `run` being unused are expected until Task 5.

- [ ] **Step 4: Re-run the Task 1 tests**

Run: `cd src-tauri && cargo test --no-default-features update_gate`
Expected: PASS — the 4 tests from Task 1 still pass.

> **Note on test coverage:** `run` is not unit-tested. It needs a live signed
> endpoint, a real installer, and a process that exits mid-function. Task 6 covers
> it with a scripted manual test against a real build, which is the only place
> its behaviour is actually observable. Do not fake this with a mock that proves
> nothing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/update_gate.rs src-tauri/Cargo.toml
git commit -m "feat(updater): run the update check before the main window exists"
```

---

### Task 4: Build `echo` from Rust

**Files:**
- Create: `src-tauri/src/main_window.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/lib.rs` (add `mod main_window;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn build(app: &tauri::AppHandle) -> tauri::Result<()>`. Task 5 calls it after the gate.

- [ ] **Step 1: Write the window builder**

Create `src-tauri/src/main_window.rs`. Every value mirrors the `app.windows[0]` block being deleted from `tauri.conf.json` in Step 2 — check them against each other before deleting:

```rust
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// Builds the main window.
///
/// This lives in Rust rather than `tauri.conf.json` because a config-declared
/// window is created before `setup()` finishes, and the vendored
/// `tauri-plugin-window-state` shows it from its `on_window_ready` hook
/// regardless of `"visible": false`. Building it here is what lets the update
/// gate run first. See docs/superpowers/plans/2026-08-06-pre-launch-update-gate.md.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "echo", WebviewUrl::default())
        .title("Venta")
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .decorations(false)
        .shadow(true)
        .drag_drop_handler(false)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .center()
        .transparent(true)
        // Left hidden deliberately: tauri-plugin-window-state shows and focuses
        // it from on_window_ready once geometry is restored.
        .visible(false)
        .build()?;
    Ok(())
}
```

Add to `src-tauri/src/lib.rs` beside the `update_gate` declaration from Task 1:

```rust
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod main_window;
```

- [ ] **Step 2: Remove the window from the config**

In `src-tauri/tauri.conf.json`, replace the whole `app` block:

```json
  "app": {
    "security": {
      "csp": null
    },
    "windows": [
      {
        "label": "echo",
        "height": 800,
        "title": "Venta",
        "width": 1200,
        "minWidth": 900,
        "minHeight": 600,
        "decorations": false,
        "shadow": true,
        "dragDropEnabled": false,
        "visible": false,
        "resizable": true,
        "maximizable": true,
        "minimizable": true,
        "center": true,
        "transparent": true
      }
    ]
  },
```

with:

```json
  "app": {
    "security": {
      "csp": null
    },
    "windows": []
  },
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check --no-default-features`
Expected: no errors. An unused-function warning for `build` is expected until Task 5.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main_window.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "refactor(window): build the echo window from Rust instead of config"
```

---

### Task 5: Reorder `setup()` and switch to quiet installs

The task that actually delivers the goal. Everything before it was scaffolding.

**Files:**
- Modify: `src-tauri/src/lib.rs:331-380`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `update_gate::run` (Task 3), `main_window::build` (Task 4).
- Produces: nothing further.

- [ ] **Step 1: Move the risky initialisers behind the gate**

In `src-tauri/src/lib.rs`, the first `.setup(...)` (currently at line 334) contains `windows_notifications::setup` and `media::publisher::spawn_provisioning`; the desktop `.setup(...)` (line 367) contains `deep_link().register`, `ptt_hook::init` and `presence::init`. Both currently run before any window exists — so a panic in any of them today prevents the client from ever reaching an update.

Delete both `.setup(...)` blocks and add a single one on the desktop builder, immediately before `build_and_run(builder)`:

```rust
    #[cfg(desktop)]
    let builder = builder.setup(|app| {
        let handle = app.handle().clone();

        // Everything below the gate can panic without costing us the ability to
        // ship a fix - that is the entire point of the ordering. Nothing that is
        // not required to *perform* an update may run before `update_gate::run`.
        tauri::async_runtime::spawn(async move {
            let splash = tauri::WebviewWindowBuilder::new(
                &handle,
                "splash",
                tauri::WebviewUrl::App("assets/splash.html".into()),
            )
            .title("Venta")
            .inner_size(320.0, 260.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .center()
            .always_on_top(true)
            .skip_taskbar(false)
            .build();

            let splash = match splash {
                Ok(w) => Some(w),
                Err(e) => {
                    // No splash is survivable; no update is not. Press on.
                    log::warn!("splash window failed to build: {e}");
                    None
                }
            };

            update_gate::run(&handle).await;

            // Only reached when there was no update, or installing one failed.
            // A successful Windows install never returns here - the plugin
            // execs the installer and exits the process.
            if let Some(splash) = splash {
                let _ = splash.close();
            }

            if let Err(e) = main_window::build(&handle) {
                log::error!("failed to build main window: {e}");
                return;
            }

            #[cfg(target_os = "windows")]
            windows_notifications::setup("Alpine");

            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = handle.deep_link().register("venta") {
                    log::warn!("deep link registration failed: {e}");
                }
            }
            ptt_hook::init(&handle);
            presence::init(&handle);
            media::publisher::spawn_provisioning(&handle);
        });

        Ok(())
    });
```

> **Implementer note:** `ptt_hook::init`, `presence::init` and
> `media::publisher::spawn_provisioning` are currently called with `app.handle()`
> (a `&AppHandle`). `handle` above is an owned `AppHandle`, so `&handle` matches.
> If any signature disagrees, fix the call site — do not change the function.

- [ ] **Step 2: Switch the updater to silent installs**

In `src-tauri/tauri.conf.json`, under `plugins.updater.windows`, change:

```json
      "windows": {
        "installMode": "passive"
      },
```

to:

```json
      "windows": {
        "installMode": "quiet"
      },
```

This changes the NSIS flags from `/P /R` to `/S /R` (`tauri-plugin-updater-2.10.1/src/config.rs:36-42`), removing the installer's progress window. `/R` still relaunches `Venta.exe` on success.

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check --no-default-features`
Expected: no errors, and no unused-function warnings for `update_gate::run` or `main_window::build`.

- [ ] **Step 4: Verify the app still starts in dev**

Run: `bun run tauri dev`
Expected: the splash appears briefly and closes, then the main window opens and Angular loads as before. The gate logs `update gate skipped: debug build`. Confirm the window remembers its size and position across a restart — that proves `tauri-plugin-window-state` still binds to the Rust-built `echo`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat(updater): gate app launch on the update check, install quietly"
```

---

### Task 6: Remove the redundant startup check, and verify against a real build

**Files:**
- Modify: `src/app/app.component.ts:124-127`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Drop the launch-time check from Angular**

The gate now covers startup, so the immediate call is redundant — and worse, it can pop the update dialog seconds after the splash decided there was nothing to install. The periodic check stays: it catches a release published while the app is open.

In `src/app/app.component.ts`, replace:

```ts
        void this.updateService.checkForUpdates();
        this.updateInterval = setInterval(() => {
```

with:

```ts
        // No check on launch: update_gate.rs already ran one before this window
        // existed. Only the periodic check remains, for a release that ships
        // while the app is open.
        this.updateInterval = setInterval(() => {
```

- [ ] **Step 2: Run the frontend tests**

Run: `bun run test` (or `bunx vitest run` if the script name differs — check `package.json`)
Expected: PASS, no new failures.

- [ ] **Step 3: Build a release bundle**

Run: `bun run tauri build --bundles nsis`
Expected: succeeds, producing `src-tauri/target/release/bundle/nsis/Venta_3.0.177_x64-setup.exe`.

> Needs meson, ninja and Python on PATH for the default `aec` feature, from an
> "x64 Native Tools" prompt — see the comment in `src-tauri/Cargo.toml`.

- [ ] **Step 4: Verify the gate against the live endpoint**

Install the bundle, then run these three checks. This is the only place the gate's real behaviour is observable, so do not skip it.

1. **Up-to-date path.** Launch. Expected: splash shows "Checking for updates…" briefly, closes, main window opens. Total added delay should be well under two seconds on a normal connection.
2. **Offline path (the fail-open guarantee).** Disconnect the network, launch. Expected: the splash appears, the check fails, and **the app still opens**. If it hangs or never opens, the gate is not fail-open and this is a release blocker.
3. **Update path.** Point a local build at a version the endpoint considers stale (temporarily lower `version` in both `tauri.conf.json` and `Cargo.toml`, rebuild, install). Expected: the splash shows "Downloading update…" with a filling bar, then the app relaunches on the new version **with no NSIS window at any point**. Confirm the installed version afterwards.

- [ ] **Step 5: Verify the bricking fix**

The whole point of the plan. Temporarily add `panic!("simulated startup crash");` as the first line of `presence::init` in `src-tauri/src/presence/mod.rs`, rebuild, install, and launch with an update available.

Expected: the splash still appears, still downloads, and the update still installs — because the panic now happens after the gate. Before this plan the same panic would have made the client permanently unupdatable.

**Revert the panic before committing.**

- [ ] **Step 6: Commit**

```bash
git add src/app/app.component.ts
git commit -m "refactor(updater): drop the launch-time check now the gate covers it"
```

---

## Verification results (2026-08-06)

All six tasks executed. Verified against a real release build and the live
`api.venta.gg` endpoint, not just compiled.

| Check | Result |
|---|---|
| Gate skips in debug | `[update-gate] skipped: debug build` |
| Gate runs in release, up-to-date path | `[update-gate] already up to date` (endpoint 204 for 3.0.178) |
| Fail-open when server unreachable | check fails, app still starts; `[openh264] ready` proves the whole post-gate chain ran |
| `ALPINE_SKIP_UPDATE_GATE` hatch | skips as designed |
| Silent first install (`/S`) | exit 0, no wizard, `%LOCALAPPDATA%\Venta`, no UAC |
| Real update: download, verify, install, relaunch | binary replaced (sha `1ED76B00…` → `F3E5D16C…`), relaunched from `%LOCALAPPDATA%`, no installer UI |
| **Bricking fix** | controlled pair, below |
| window-state still binds `echo` | geometry persisted across restarts |
| Rust tests | 466 passed |
| Angular tests | 2322 passed |

**The bricking test was run as a control pair**, because the single test in Task 6
Step 5 cannot distinguish "the gate ran first" from "the panic never fired":

- **A** — panic in `presence::init`, version 3.0.178 (no update): `already up to
  date`, then the panic fires and the app dies. Proves the panic is reachable.
- **B** — same panic, version 3.0.177 (update available): `installing 3.0.178`,
  process exits before `presence::init`, **no panic**, app relaunches clean.

Under the old ordering B would have died before the Angular check could run.

### Deviations from the plan as written

1. **`log = "0.4"` was not added.** No logger is installed in this crate, so
   `log::*` would compile and be silently discarded - the worst outcome for code
   whose only job is explaining why an update did not happen. Used
   `eprintln!("[update-gate] …")`, matching the 83 existing call sites.
2. **`windows_notifications::setup` stayed ahead of the gate.** It sets the
   process AppUserModelID, which Windows reads at first window creation, and every
   fallible call inside is already handled - it has no panic path to protect
   against.
3. **`main_window` is not desktop-gated.** Removing the window from the config
   removed it on every platform, so mobile needs its own (gate-less) build path.
4. **`.drag_drop_handler(false)` does not exist**; the builder method is
   `.disable_drag_drop_handler()` with no argument.
5. **`progress_percent` was extracted and unit-tested** rather than left inline,
   covering absent content-length, a zero total (`inf as u8` saturates to 255
   rather than panicking), and a server understating the length.
6. **`splash` had to be added to the window-state denylist.** `on_window_ready`
   fires for every window, so the plugin was persisting the splash's geometry and
   would restore it next launch, overriding `.center()` - and once a bad position
   was recorded, the splash would reopen off-screen with no way to drag it back.

### Gotcha

Running the installer as `./Venta_x64-setup.exe /S` **from Git Bash does not
install silently**. MSYS path conversion rewrites the leading `/S` into a path, so
NSIS never sees the flag and shows the full wizard. Use PowerShell
(`Start-Process -ArgumentList '/S'`) or `MSYS_NO_PATHCONV=1`.

## Self-Review

**Spec coverage.** Requirement (b) — "the update must run before the actual app is launched" — is delivered by Tasks 3 and 5, and verified end-to-end by Task 6 Step 5. The "ugly installer during updates" half of requirement (a) is delivered by Task 5 Step 2 (`quiet`). The first-install half of requirement (a) is **not** in this plan; it is Plan B (wizard-less NSIS template + CI signing hook) and is deliberately scoped out — it shares no code with this one and ships independently.

**Known gaps, called out rather than hidden:**

1. **Linux is unaddressed.** `tauri-plugin-updater` installs `.deb`/`.rpm` via `pkexec`/GUI-sudo (`updater.rs:1049-1141`), so a Linux user gets a password prompt from the splash — worse than the current behaviour, where it at least happens in a window they opened. The gate skips cleanly if the check fails, but this should be confirmed on Linux before shipping there, and the real fix is bundling AppImage. Out of scope here.
2. **Residual bricking window.** A panic *before* `setup()` — during plugin construction, or a broken WebView2 — still prevents the gate from running. Closing that needs the separate launcher process (option B2 from the investigation), which is a much larger change. This plan shrinks the window substantially; it does not eliminate it.
3. **`run` has no unit tests**, for the reasons stated in Task 3 Step 4. Task 6 is its test.

**Type consistency.** `decide` (Task 1) is called in Task 3 with `(bool, Option<&str>)` — matches. `GateDecision` variants `Run`/`Skip(&'static str)` are matched exhaustively in Task 3. `update_gate::run(&AppHandle)` (Task 3) is awaited in Task 5 with `&handle` where `handle: AppHandle` — matches. `main_window::build(&AppHandle) -> tauri::Result<()>` (Task 4) is called in Task 5 inside `if let Err(e) = ...` — matches. The `phase` strings emitted by `report` (`"checking"`, `"downloading"`, `"installing"`) match the `LABELS` keys in Task 2 Step 2 exactly. `window.__VENTA_SPLASH__` is spelled identically in Task 2 Step 2 and Task 3 Step 1.

**Placeholder scan.** No TBDs, no "handle errors appropriately", no "similar to Task N". Every code step carries the literal content to write. The reason the splash is driven by `eval` rather than Tauri's event system is stated in a comment inside the code it justifies, so it survives being read out of order.
