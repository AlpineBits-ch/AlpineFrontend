# Venta

Tauri 2 + Angular desktop client. The frontend is Angular; everything from audio capture to the
WebRTC transport lives in Rust under `src-tauri/`.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| [Rust](https://rustup.rs) (stable, MSVC toolchain) | The whole `src-tauri` crate | `rustup default stable-x86_64-pc-windows-msvc` |
| [Bun](https://bun.sh) | Package manager and script runner | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| Visual Studio Build Tools with **Desktop development with C++** | MSVC (`cl`, `link`), which Rust and the vendored C++ both need | [Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |
| WebView2 runtime | The webview Tauri renders into | Preinstalled on Windows 11 |
| Python 3 | Runs meson | [python.org](https://www.python.org/downloads/) or `winget install Python.Python.3.12` |
| **meson** and **ninja** | Build echo cancellation from source — see below | `pip install meson ninja` |
| CMake | libopus, vendored by `audiopus_sys` | `winget install Kitware.CMake` |

CI installs exactly this set; the Windows job in `.github/workflows/build.yml` is the reference.

### The `aec` feature is the one that bites

`src-tauri/Cargo.toml` declares `default = ["aec"]`. That feature compiles WebRTC's AudioProcessing
module — real C++, built from source through meson and ninja — and it is what provides echo
cancellation, noise suppression and gain control. Because it is a **default** feature, a plain
`cargo build`, `cargo test` or `tauri build` all turn it on, and a machine without meson on `PATH`
fails the build outright with `Failed to execute meson. Do you have it installed?`.

Two consequences worth knowing before you debug anything audio-related:

- Building with `--no-default-features` succeeds without meson, but produces a **different
  executable** from the one CI ships: `media::voice::process::create` returns the passthrough
  processor instead of the real one. Voice still works, without echo cancellation.
- meson only finds `cl` if MSVC is already on `PATH`. A plain PowerShell prompt has no MSVC and
  fails with an unhelpful `[WinError 2]`. Build from an **x64 Native Tools Command Prompt for VS**,
  or run `vcvars64.bat` first.

## Running

```bash
bun install
bun run tauri dev          # debug build, Angular dev server, hot reload
```

`tauri dev` is *not* the artifact CI produces. It is a debug build (no optimisations, debug
assertions on, a console attached) running against `ng serve`. Timing-sensitive faults — anything
involving WebRTC negotiation, device callbacks or thread scheduling — can appear in one and not the
other, so a bug reproduced only in `dev` is not evidence about the shipped client, and vice versa.

### Reproducing the CI artifact

```bash
bun run tauri:ci          # byte-for-byte what release-windows builds: NSIS installer, release profile,
                          # default features, production Angular bundle
bun run tauri:ci:run      # the same binary without the installer, launched with its output captured
```

`tauri:ci:run` writes a transcript to `logs/venta-<timestamp>.log` as well as to the terminal. That
file is what to attach to a bug report.

**Do not substitute `cargo build --release`.** It compiles, it produces `Venta.exe`, and the app it
produces loads `http://localhost:1420` and shows *"localhost refused to connect"* unless `ng serve`
happens to be up. Whether a build is a dev build or a production one has nothing to do with the
cargo profile: `tauri`'s build script sets `dev = !custom-protocol`, and the `custom-protocol`
feature is passed by the Tauri CLI, not by cargo. So `cargo build --release` is an *optimised dev
build* — release profile, dev frontend wiring — which is a configuration CI never produces and
nothing should be diagnosed against. Always go through `tauri build` (or the scripts above).

### Reading a release build's output

Release builds are linked with `windows_subsystem = "windows"` so no console window appears when the
app is launched from Explorer. That also leaves the process with no standard handles, and Rust
silently discards writes to an absent stderr — which is why a shipped client used to produce no
diagnostics at all.

`attach_parent_console` in `src-tauri/src/main.rs` adopts the console of whatever started the
process, so **an installed client run from a terminal prints its full log**:

```powershell
& "$env:LOCALAPPDATA\Venta\Venta.exe"
```

Double-clicking still opens no console, exactly as before.

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml            # Rust, debug
cargo test --manifest-path src-tauri/Cargo.toml --release  # Rust, as CI compiles it
bun run test                                               # Angular
```

`media::voice::e2e_tests` is the gate on the voice pipeline: two real peer connections, real Opus
and real SRTP, asserting on the samples a speaker would emit. If it fails, voice is broken — there
is no version of it failing that means anything else. Worth running under `--release` too, since
that is the profile users get and several of these faults are timing-dependent.
