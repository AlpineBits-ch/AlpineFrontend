//! The Phase 0 transport probe.
//!
//! Live tests are `#[ignore]`d: they need a LiveKit server on `ws://127.0.0.1:7880`. See
//! `docker/livekit-dev/compose.yaml`, and the Windows note in it before reaching for Docker.

use livekit_api::access_token::{AccessToken, TokenVerifier, VideoGrants};
use livekit_api::signal_client::SignalClient;

use super::probe::Probe;
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

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880 - see docker/livekit-dev/compose.yaml"]
async fn connects_and_receives_a_join_response() {
    let token = dev_token("probe-connect", "user-1");

    let (client, join, _events) = SignalClient::connect(DEV_URL, &token, connect_options(), None)
        .await
        .expect("the signalling connect must succeed");

    // The room and our identity come back from the server rather than being echoed from the token,
    // so this is the first point at which the whole path is proven rather than assumed.
    assert_eq!(join.room.expect("room").name, "probe-connect");
    assert_eq!(join.participant.expect("participant").identity, "user-1");

    // Recorded rather than asserted: whether this server offers single-peer-connection mode decides
    // how much of Phase 1 exists at all. See the spec's Phase 0 note.
    println!("PROBE single-pc mode active: {}", client.is_single_pc_mode_active());
    println!("PROBE subscriber primary: {}", join.subscriber_primary);
    println!("PROBE ice servers: {}", join.ice_servers.len());
    println!("PROBE server version: {:?}", join.server_info.as_ref().map(|s| &s.version));

    client.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn reports_whether_the_server_accepts_single_peer_connection_mode() {
    // Asked for explicitly. `connect_options()` leaves this off, so the reading in
    // `connects_and_receives_a_join_response` says only that we did not ask - it is not evidence
    // about the server. If this comes back true, the publisher/subscriber split in the spec's §2.3
    // collapses to one peer connection and Phase 1 gets materially smaller.
    let mut options = connect_options();
    options.single_peer_connection = true;

    let (client, _join, _events) =
        SignalClient::connect(DEV_URL, &dev_token("probe-singlepc", "user-1"), options, None)
            .await
            .expect("connect");

    println!("PROBE single-pc when asked for: {}", client.is_single_pc_mode_active());

    client.close().await;
}

#[tokio::test]
#[ignore = "needs a LiveKit server on 127.0.0.1:7880"]
async fn publishes_an_opus_track_under_our_own_name() {
    let probe = Probe::connect(DEV_URL, &dev_token("probe-audio", "user-1"))
        .await
        .expect("connect");

    let sid = probe.publish_audio("audio").await.expect("publish");

    // The SID is the server's, and its existence is the whole assertion: it is only issued after
    // `AddTrackRequest` was accepted, which is where a codec or naming disagreement would surface.
    assert!(!sid.is_empty());
    println!("PROBE audio track sid: {sid}");

    // Media, not just signalling. A publication nothing is written to proves only that the
    // handshake worked.
    probe.pump_tone_for(std::time::Duration::from_secs(2));
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let sent = probe.packets_sent();
    println!("PROBE opus packets written: {sent}");
    assert!(sent > 50, "expected ~100 packets in two seconds, wrote {sent}");

    // Without this the test passes against a connection that never completed ICE: `write_sample`
    // hands the sample to a packetiser and nothing downstream reports back. See
    // `project_media_e2e_test_traps`.
    use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
    println!("PROBE publisher state: {}", probe.publisher_state());
    assert_eq!(probe.publisher_state(), RTCPeerConnectionState::Connected);

    probe.close().await;
}
