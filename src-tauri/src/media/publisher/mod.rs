//! Rust-native screen-share publishing.
//!
//! The existing capture path encodes each frame to JPEG, base64s it across the Tauri IPC boundary,
//! decodes it in JS, draws it to a canvas and lets the browser re-encode the canvas for WebRTC.
//! That is two lossy encodes and a full round trip per frame. This module is the replacement:
//! captured frames go straight into a real video encoder in Rust.
//!
//! Discord does the equivalent natively - OS capture into a hardware encoder, with frames never
//! leaving the process - which is why their streams stay sharp on text.

//! Status: the encoder layer is built and tested. The RTP publishing layer (a `webrtc-rs` peer
//! connection publishing to Cloudflare Realtime through the backend's existing signalling
//! endpoints) is designed but not yet implemented - see the plan referenced in
//! `docs/superpowers/plans/2026-07-31-discord-parity-streaming.md`.

pub mod encoder;
pub mod encoder_sw;
