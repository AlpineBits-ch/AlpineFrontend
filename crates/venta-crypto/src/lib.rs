//! Venta's cryptographic engine: MLS groups, master-key wrapping, device-certificate verification.
//!
//! Extracted from `src-tauri/src/crypto/` **unchanged**. The three modules below are the same files,
//! moved; the only edits are `#[cfg]` attributes and the wrapper sections at the bottom of each. See
//! the module header at the top of [`mls`], which explains why that matters and is normative.
//!
//! ## Three hosts, one engine
//!
//! | Host | How it gets in |
//! |---|---|
//! | Tauri desktop | `features = ["tauri"]`; the `#[tauri::command]` wrappers at the bottom of each module. `src-tauri` re-exports them so its `generate_handler!` list is unchanged. |
//! | venta-mobile | A separate repo that keeps `mls.rs` line-for-line and drives the engine functions directly through a process-global `Mutex`. |
//! | Browser | `wasm32-unknown-unknown`; the wasm-bindgen wrappers in [`wasm`], which take and return JSON strings so the argument shapes are the Tauri IPC ones. |
//!
//! Nothing above those wrapper layers is host-aware, with two exceptions, both of which are
//! `#[cfg(target_arch = "wasm32")]` and both of which are documented where they are:
//!
//! 1. [`now_unix_secs`] - `SystemTime::now()` panics on `wasm32-unknown-unknown`.
//! 2. `MlsState::save_to_disk` - a no-op on wasm, because there is no filesystem. Persistence on
//!    the web is the existing `export_state`/`import_state` pair, driven from TypeScript into
//!    IndexedDB. **No new at-rest format**, and no change to any KDF parameter: a blob wrapped by
//!    the browser must stay openable by the desktop build and the other way round.

#[allow(clippy::module_inception)]
pub mod crypto;
pub mod device_cert;

// `allow(dead_code)` on wasm32 only, and scoped to this module.
//
// The engine's persistence half - `write_state_file`, `init_storage_from_parts`, `state_file_name`,
// `is_safe_scope`, `adopt_legacy_state_file`, `decode_state_key`, `STATE_FILE_MAGIC` and the
// `state_key` field - is unreachable in a browser by design, and the compiler is right to say so on
// eight items. The alternative is eight `#[cfg(not(target_arch = "wasm32"))]` attributes *inside*
// `mls.rs`, which is shared line-for-line with venta-mobile and whose header explains at length why
// that file gains as little as possible.
//
// Deliberately not crate-wide and deliberately not unconditional: the native build still lints this
// module normally, so genuinely dead code is still caught - just on the target that can reach all of
// it.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub mod mls;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// That the wasm `Args` structs take the same argument objects the `#[tauri::command]`s do.
///
/// A crate-root test module rather than a child of [`wasm`], because [`wasm`] only exists on
/// `wasm32` and this has to run where the Tauri wrappers exist to be compared against - it reads all
/// four modules' source text with `include_str!` and needs none of them compiled. It is the missing
/// third side of the triangle whose other two are
/// `mls::tests::the_tauri_argument_names_match_the_typescript_call_sites` and
/// `master-key.service.spec.ts`.
#[cfg(test)]
mod wasm_args_tests;

/// Seconds since the Unix epoch.
///
/// The one place in this crate that reads a clock, and the reason it is a function.
/// `std::time::SystemTime::now()` **panics** on `wasm32-unknown-unknown` - std's clock there is
/// `unsupported`, not merely coarse - so a browser build would have aborted inside
/// `mls::current_iso8601` while writing a §D backup envelope. `Date.now()` is milliseconds since
/// the same epoch, so the conversion is exact at seconds precision and the two hosts agree on the
/// value, not just on the type.
///
/// A clock before the epoch reads as 0 on both hosts: native via `unwrap_or(0)` on the
/// `duration_since` error, wasm via the saturating cast of a negative `f64`.
pub fn now_unix_secs() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        // `as u64` on an f64 saturates in Rust: negative clamps to 0, which matches native's
        // `unwrap_or(0)` for a pre-epoch clock.
        (js_sys::Date::now() / 1000.0) as u64
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}
