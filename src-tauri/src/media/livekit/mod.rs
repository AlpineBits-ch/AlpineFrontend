//! Speaking LiveKit's signalling protocol over our own media transport.
//!
//! `livekit_api::signal_client` owns the WebSocket, the protocol version, the request queue and the
//! reconnect ladder. Everything below the signal - peer connections, codecs, jitter, mixing - stays
//! `webrtc-rs` and stays ours.
//!
//! The `livekit` crate itself is not usable here: its `SignalClient` is private and it links
//! libwebrtc unconditionally, which would mean surrendering the capture chain, the Media Foundation
//! encoder and the mixer to it. `livekit-api`'s `signal-client` feature exists precisely so the
//! signalling half can be taken without the media half - upstream describes it as "blind to the
//! transport backend".
//!
//! See `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`.

pub mod identity;
pub mod resume;
pub mod room;
pub mod signal;

#[cfg(test)]
mod room_tests;
