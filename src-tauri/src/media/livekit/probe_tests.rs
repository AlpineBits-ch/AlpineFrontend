//! The Phase 0 transport probe.
//!
//! Live tests are `#[ignore]`d: they need a LiveKit server on `ws://127.0.0.1:7880`. See
//! `docker/livekit-dev/compose.yaml`, and the Windows note in it before reaching for Docker.

use livekit_api::access_token::{AccessToken, TokenVerifier, VideoGrants};

use super::signal::connect_options;

/// Dev mode ships this fixed pair. It is not a secret, and it must never reach a config file that a
/// release build reads - a client never signs its own join token.
const DEV_KEY: &str = "devkey";
const DEV_SECRET: &str = "secret";

pub const DEV_URL: &str = "ws://127.0.0.1:7880";

/// A join token for the local dev server.
pub fn dev_token(room: &str, identity: &str) -> String {
    AccessToken::with_api_key(DEV_KEY, DEV_SECRET)
        .with_identity(identity)
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: true,
            can_subscribe: true,
            ..Default::default()
        })
        .to_jwt()
        .expect("dev token")
}

#[test]
fn dev_token_carries_the_identity_and_room() {
    let token = dev_token("probe", "user-1#view");

    let claims = TokenVerifier::with_api_key(DEV_KEY, DEV_SECRET)
        .verify(&token)
        .expect("the token we just minted must verify");

    // The `#` is what separates a secondary connection from its user, and it has to survive a round
    // trip through the JWT unescaped. A token that mangled it would map every secondary participant
    // to the wrong user, or to none.
    assert_eq!(claims.sub, "user-1#view");
    assert_eq!(claims.video.room, "probe");
}

#[test]
fn connect_options_never_auto_subscribe() {
    let options = connect_options();

    // The server's subscription plan decides what we pull - guide §6.6. A room that subscribes us
    // to everyone costs egress nobody is listening to, and nothing corrects it.
    assert!(!options.auto_subscribe);
    assert_eq!(options.sdk_options.sdk, "venta");
}
