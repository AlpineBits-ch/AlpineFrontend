//! How this client introduces itself to a LiveKit room.

use livekit_api::signal_client::{SignalOptions, SignalSdkOptions};

/// The options every Venta connection opens with.
///
/// Built by assignment rather than a struct literal because both types are `#[non_exhaustive]`,
/// which forbids literal construction outside their own crate however many fields are named.
pub fn connect_options() -> SignalOptions {
    let mut sdk = SignalSdkOptions::default();
    sdk.sdk = "venta".to_string();
    sdk.sdk_version = Some(env!("CARGO_PKG_VERSION").to_string());

    let mut options = SignalOptions::default();
    // Never true. See the test, and the voice guide §6.6: the server's plan decides what we pull,
    // and a room that subscribes us to everyone costs egress nobody is listening to.
    options.auto_subscribe = false;
    // Adaptive stream is the JS SDK's viewport tracking. There is no viewport in this process.
    options.adaptive_stream = false;
    options.sdk_options = sdk;
    options
}
