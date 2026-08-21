# Building

The quick start is in the README. This page is the things that go wrong.

## Prerequisites

| Tool                                                      | Why                                                            | Install                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Rust](https://rustup.rs) (stable, MSVC toolchain)        | The whole `src-tauri` crate                                    | `rustup default stable-x86_64-pc-windows-msvc`                                         |
| [Bun](https://bun.sh)                                     | Package manager and script runner                              | `powershell -c "irm bun.sh/install.ps1 \| iex"`                                        |
| Visual Studio Build Tools, "Desktop development with C++" | MSVC (`cl`, `link`), which Rust and the vendored C++ both need | [Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/)    |
| WebView2 runtime                                          | The webview Tauri renders into                                 | Preinstalled on Windows 11                                                             |
| Python 3                                                  | Runs meson                                                     | [python.org](https://www.python.org/downloads/) or `winget install Python.Python.3.12` |
| meson and ninja                                           | Build echo cancellation from source, see below                 | `pip install meson ninja`                                                              |
| CMake                                                     | libopus, vendored by `audiopus_sys`                            | `winget install Kitware.CMake`                                                         |

CI installs exactly this set. The Windows job in `.github/workflows/build.yml` is the reference.

## The `aec` feature is the one that bites

`src-tauri/Cargo.toml` declares `default = ["aec"]`. That feature compiles WebRTC's AudioProcessing
module, real C++, built from source through meson and ninja. It provides echo cancellation, noise
suppression and gain control. Because it is a default feature, a plain `cargo build`, `cargo test` or
`tauri build` all turn it on, and a machine without meson on `PATH` fails outright with
`Failed to execute meson. Do you have it installed?`.

Two consequences before you debug anything audio related:

- Building with `--no-default-features` succeeds without meson but produces a different executable
  from the one CI ships. `media::voice::process::create` returns the passthrough processor instead of
  the real one. Voice still works, without echo cancellation.
- meson only finds `cl` if MSVC is already on `PATH`. A plain PowerShell prompt has no MSVC and fails
  with an unhelpful `[WinError 2]`. Build from an x64 Native Tools Command Prompt for VS, or run
  `vcvars64.bat` first.

## `tauri dev` is not what CI ships

```bash
bun run tauri dev          # debug build, Angular dev server, hot reload
```

That is a debug build with no optimisations, debug assertions on and a console attached, running
against `ng serve`. Timing sensitive faults, anything involving WebRTC negotiation, device callbacks
or thread scheduling, can appear in one and not the other. A bug reproduced only in `dev` is not
evidence about the shipped client, and the reverse is also true.

### Reproducing the CI artifact

```bash
bun run tauri:ci          # exactly what release-windows builds: NSIS installer, release profile,
                          # default features, production Angular bundle
bun run tauri:ci:run      # the same binary without the installer, launched with its output captured
```

`tauri:ci:run` writes a transcript to `logs/venta-<timestamp>.log` as well as to the terminal. That
file is what to attach to a bug report.

### Do not substitute `cargo build --release`

It compiles, it produces `Venta.exe`, and the app it produces loads `http://localhost:1420` and shows
"localhost refused to connect" unless `ng serve` happens to be up.

Whether a build is a dev build or a production one has nothing to do with the cargo profile. Tauri's
build script sets `dev = !custom-protocol`, and the `custom-protocol` feature is passed by the Tauri
CLI, not by cargo. So `cargo build --release` is an optimised dev build, a configuration CI never
produces and nothing should be diagnosed against. Always go through `tauri build` or the scripts
above.

## Reading a release build's output

Release builds link with `windows_subsystem = "windows"`, so no console appears when the app is
launched from Explorer. That also leaves the process with no standard handles, and Rust silently
discards writes to an absent stderr. A shipped client used to produce no diagnostics at all.

`attach_parent_console` in `src-tauri/src/main.rs` adopts the console of whatever started the process,
so an installed client run from a terminal prints its full log:

```powershell
& "$env:LOCALAPPDATA\Venta\Venta.exe"
```

Double clicking still opens no console.

## Tests

```bash
bun run test                                               # Angular
cargo test --manifest-path src-tauri/Cargo.toml            # Rust, debug
cargo test --manifest-path src-tauri/Cargo.toml --release  # Rust, as CI compiles it
```

`media::voice::e2e_tests` is the gate on the voice pipeline: two real peer connections, real Opus and
real SRTP, asserting on the samples a speaker would emit. If it fails, voice is broken. There is no
version of it failing that means anything else. Worth running under `--release` too, since that is the
profile users get and several of these faults are timing dependent.
