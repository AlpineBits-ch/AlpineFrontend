//! The cryptographic engine, re-exported from the `venta-crypto` workspace crate.
//!
//! `mls.rs`, `crypto.rs` and `device_cert.rs` used to sit in this directory. They moved to
//! `crates/venta-crypto/src/` unchanged so the same engine can be compiled to
//! `wasm32-unknown-unknown` for the browser client without a second copy of it - see that crate's
//! `lib.rs` header, and `docs/superpowers/specs/2026-08-11-browser-only-build-design.md`.
//!
//! **This module exists so nothing else in `src-tauri` had to move with them.** `lib.rs`'s two
//! `generate_handler!` lists still say `crypto::mls::mls_send_message`, character for character, and
//! that is deliberate: those lists are the registration half of the Tauri surface, and the test
//! `the_tauri_command_surface_is_present` asserts an exact set against them. Rewriting 40 paths to
//! prove the crate split worked would have made the split's own regression gate unreadable.
//!
//! The commands themselves are `#[cfg(feature = "tauri")]` in that crate; `src-tauri` depends on it
//! with `features = ["tauri"]`, so they are present here and nowhere else.

#[allow(clippy::module_inception)]
pub use venta_crypto::crypto;
pub use venta_crypto::device_cert;
pub use venta_crypto::mls;
