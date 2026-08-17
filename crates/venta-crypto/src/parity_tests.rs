//! Native/wasm32 parity vectors.
//!
//! **This is the test the whole browser-crypto design rests on.** The design claim is "one engine,
//! no divergence": the same Rust compiled to `wasm32-unknown-unknown` must produce the same bytes as
//! the desktop build, or a browser session and a desktop session are two clients that cannot read
//! each other - and they would find out in the field, on a message or a recovery, not here.
//!
//! Every assertion below is against a **checked-in fixture and a pinned literal**, never against
//! "whatever this build produced". A round trip that only compares an engine with itself passes
//! identically on two engines that have both drifted the same way, which is precisely the failure
//! mode this exists to exclude - see `project_media_e2e_test_traps` for the same trap in the media
//! suite.
//!
//! ## Why it is in this file rather than in `integration_tests`
//!
//! `integration_tests` above is `#[cfg(not(target_arch = "wasm32"))]`: it writes real state files,
//! reads `testdata/` off disk and walks the TypeScript tree, none of which exists on
//! `wasm32-unknown-unknown` where `std::fs` is a stub returning `Unsupported`. This module reads its
//! fixtures with `include_str!` - resolved by the *compiler*, on both targets - so it compiles and
//! runs unchanged under both.
//!
//! ## Running it
//!
//! ```text
//! cargo test -p venta-crypto parity                       # native
//! wasm-pack test --node crates/venta-crypto -- parity     # wasm32
//! ```
//!
//! The wasm half needs `wasm-pack`; without it this module still proves the native side and still
//! *compiles* for wasm32 under `cargo check --target wasm32-unknown-unknown`, which is what catches
//! the "reaches for a filesystem" class of divergence.

use super::*;
use crate::crypto::{decrypt_master_key, normalize_recovery_code_checked, EncryptedMasterKey};

// Both fixtures are shared byte for byte with venta-mobile's checkout - see
// `testdata/mls-golden/v1/README.md`. Embedded rather than read, because a wasm target has no
// filesystem to read them from, and because embedding makes the two targets provably consume the
// *same bytes* rather than two reads of a path.
const MLS_FIXTURE: &str = include_str!("../../../testdata/mls-golden/v1/fixture.json");
const MASTER_KEY_FIXTURE: &str =
    include_str!("../../../testdata/mls-golden/v1/recovery-code-alpine.json");

// ---------------------------------------------------------------------------
// Pinned expectations
// ---------------------------------------------------------------------------
//
// Literals, not values recomputed from the fixture. A test that derives its expectation from the
// same bytes it is checking asserts only that the derivation is deterministic - it would pass on a
// wasm build whose SHA-256 was wrong in exactly the same way twice.

/// SHA-256 of Bob's golden key-package bytes, hex. `inspect_key_package` binds an approval to
/// these exact bytes, so this is the value a reviewer's "yes" is really about.
const GOLDEN_KEY_PACKAGE_HASH: &str =
    "ca8dfd0cbcb135a70d31e26b0f6ffbda98d2705ceaa931133234bd0c4cd6d87a";

/// Bob's signature-key fingerprint, in the five-character groups `format_fingerprint` produces.
/// This is the string a user reads aloud, and it must be the same string on every host.
const GOLDEN_SIGNATURE_FINGERPRINT: &str = "C80B2-400F0-8590C-57748";

/// The master key sealed inside both wrappings of `recovery-code-alpine.json`, base64.
const GOLDEN_MASTER_KEY: &str = "6Y/Si/BNytCJKcajHanfl1TA04qk5boCw/9fjxTCMFg=";

/// The Argon2id parameters this build writes. **Part of the at-rest format.**
///
/// Pinned here as well as in `crypto.rs` because wasm is where the temptation to weaken them lives:
/// Argon2 is materially slower in a browser, and 64 MiB / t=3 / p=1 is what a desktop build needs to
/// find in an envelope the browser wrote. Weakening them on one host makes every blob that host
/// writes silently weaker and every blob it reads a different key.
const ARGON2_MEMORY_KIB: u64 = 65_536;
const ARGON2_ITERATIONS: u64 = 3;
const ARGON2_PARALLELISM: u64 = 1;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// One temp directory for the native run, cleaned up when the test binary exits.
///
/// Native only, and this is the *only* place the two targets are set up differently: on native every
/// mutating operation persists, and persisting without a path is a hard error by design. On wasm
/// there is no filesystem, `state_path` stays `None`, and `save_to_disk` is a documented no-op - see
/// `MlsState::save_to_disk`. Nothing about the crypto differs, which is why the assertions below are
/// shared.
#[cfg(not(target_arch = "wasm32"))]
fn parity_state_dir() -> &'static std::path::Path {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    DIR.get_or_init(|| tempfile::tempdir().expect("temp dir"))
        .path()
}

fn parity_engine() -> MlsState {
    #[allow(unused_mut)]
    let mut mls = MlsState::default();

    #[cfg(not(target_arch = "wasm32"))]
    {
        mls.state_path =
            Some(parity_state_dir().join(format!("parity_{}.json", uuid::Uuid::new_v4())));
        mls.state_key = Some(vec![0x5A; 32]);
    }

    mls
}

fn fixture(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

fn text(v: &serde_json::Value) -> &str {
    v.as_str().expect("fixture field is a string")
}

// ---------------------------------------------------------------------------
// 1. Master-key wrap / unwrap
// ---------------------------------------------------------------------------

/// A wrapping produced by an earlier build opens to the same master key on both targets.
///
/// This is the single most important assertion in the file. Argon2id is the one primitive with a
/// plausible reason to behave differently in wasm - it is memory-hard, it is slow in a browser, and
/// the parameters are declared in the envelope rather than fixed by the reader. If a browser derived
/// even one different byte here, a user who set their master key on the web could never unlock it on
/// desktop and the error would read "wrong password".
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_golden_master_key_wrappings_unwrap_identically() {
    let f = fixture(MASTER_KEY_FIXTURE);

    // The fixture has not been edited out from under the pin.
    assert_eq!(
        text(&f["masterKey"]),
        GOLDEN_MASTER_KEY,
        "the fixture's master key no longer matches the literal pinned in this file"
    );

    // Both credentials open the same key. A password is used exactly as typed; a recovery code is
    // normalized first, and by the same public function the UI validates with.
    let password_envelope: EncryptedMasterKey =
        serde_json::from_value(f["passwordWrapping"].clone()).expect("password wrapping");
    let password_key = decrypt_master_key(password_envelope, text(&f["password"]).to_string())
        .expect("the password wrapping must open");
    assert_eq!(
        B64.encode(&password_key),
        GOLDEN_MASTER_KEY,
        "Argon2id + AES-GCM produced a different master key on this target"
    );

    let normalized = normalize_recovery_code_checked(text(&f["recoveryCode"]).to_string())
        .expect("the fixture's recovery code must normalize");
    assert_eq!(
        normalized,
        text(&f["normalized"]),
        "recovery-code normalisation differs on this target - a correct code would be told it is wrong"
    );

    let code_envelope: EncryptedMasterKey =
        serde_json::from_value(f["recoveryCodeWrapping"].clone()).expect("code wrapping");
    let code_key = decrypt_master_key(code_envelope, normalized)
        .expect("the recovery-code wrapping must open");
    assert_eq!(
        B64.encode(&code_key),
        GOLDEN_MASTER_KEY,
        "the recovery-code wrapping opened to different bytes than the password wrapping"
    );
}

/// A wrapping produced *on this target* declares the parameters desktop expects, and opens again.
///
/// The test above proves the read direction. This proves the write direction, which is the one that
/// strands a user: a browser that wrote a weaker envelope would round-trip perfectly against itself
/// and be unopenable - or openable at a lower cost than intended - everywhere else.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_wrapping_written_on_this_target_declares_the_shared_argon2_parameters() {
    let wrapped = crate::crypto::setup_master_key("parity-password".to_string(), None)
        .expect("wrap a fresh master key");

    let json = serde_json::to_value(&wrapped).expect("envelope serializes");
    assert_eq!(
        json["argon2Memory"].as_u64(),
        Some(ARGON2_MEMORY_KIB),
        "this target writes a different Argon2 memory cost - the at-rest format has forked"
    );
    assert_eq!(json["argon2Iterations"].as_u64(), Some(ARGON2_ITERATIONS));
    assert_eq!(json["argon2Parallelism"].as_u64(), Some(ARGON2_PARALLELISM));
    assert_eq!(json["version"].as_u64(), Some(1));
    // §L.11: every wrapping this client produces carries the verifier, or the server cannot prove a
    // re-wrap seals the same key.
    assert!(
        json["publicVerifier"].is_string(),
        "the public verifier is missing from a wrapping written on this target"
    );

    let reread: EncryptedMasterKey = serde_json::from_value(json).expect("re-read the envelope");
    let unwrapped = decrypt_master_key(reread, "parity-password".to_string())
        .expect("what this target wrapped must unwrap");
    assert_eq!(unwrapped.len(), 32);
}

// ---------------------------------------------------------------------------
// 2. Key-package determinism, as far as it exists
// ---------------------------------------------------------------------------

/// Key-package *generation* is not deterministic and must not be: every package carries a fresh
/// HPKE init key, and a device that minted reproducible ones would hand the same private key to
/// every group it joined.
///
/// What is deterministic - and is what a human or a server ever compares - are the derived values
/// over fixed bytes: the SHA-256 an approval is bound to, and the fingerprint a user reads aloud.
/// Both are asserted against literals, over key-package bytes from the fixture, so they are
/// comparable across targets.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_golden_key_package_digests_identically() {
    let f = fixture(MLS_FIXTURE);
    let bob = &f["bob"];

    let scratch = parity_engine();
    let info = inspect_key_package(&scratch, text(&bob["keyPackageB64"]))
        .expect("the golden key package must validate on this target");

    assert_eq!(info.identity, "bob");
    assert_eq!(
        info.signature_public_key,
        text(&bob["signingPublicKey"]),
        "the signature key read out of the package is not the one the fixture says signed it"
    );
    assert_eq!(
        info.key_package_hash, GOLDEN_KEY_PACKAGE_HASH,
        "SHA-256 over identical key-package bytes differs on this target - an approval bound to \
         these bytes on one host would not match on the other"
    );
    assert_eq!(
        info.signature_key_fingerprint, GOLDEN_SIGNATURE_FINGERPRINT,
        "the fingerprint a user reads aloud differs on this target"
    );

    // The same fingerprint, reached the other way: from a loaded signing key rather than from a
    // package. These are the two call sites a user compares against each other (the join-request
    // review and the payments screen), so they must agree on every host.
    let mut engine = parity_engine();
    let handle = load_signing_key(
        &mut engine,
        text(&bob["signingPublicKey"]),
        text(&bob["signingPrivateKey"]),
        "bob".to_string(),
    )
    .expect("load bob's signing key");
    assert_eq!(
        signing_key_fingerprint(&engine, &handle).expect("fingerprint"),
        GOLDEN_SIGNATURE_FINGERPRINT
    );
}

// ---------------------------------------------------------------------------
// 3. Message decrypt - against bytes neither target produced
// ---------------------------------------------------------------------------

/// The golden Welcome, commit and application message all apply, and the message decrypts to the
/// plaintext the fixture names.
///
/// Same fixture and same sequence as `consume_golden_fixture` in `integration_tests`, deliberately:
/// that one proves the desktop engine still reads bytes from venta-mobile, this one proves the wasm
/// engine reads the same bytes to the same plaintext. The ciphertext is old and from somewhere else,
/// which is the entire value - a freshly generated message would only prove an engine can read
/// itself.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_golden_welcome_and_message_decrypt_identically() {
    let f = fixture(MLS_FIXTURE);
    let bob = &f["bob"];

    assert_eq!(
        f["ciphersuite"].as_str(),
        Some("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
        "the fixture was produced under a different ciphersuite"
    );
    assert_eq!(f["openmls"].as_str(), Some("0.8.1"));

    let mut engine = parity_engine();
    let persisted: PersistedMlsState =
        serde_json::from_value(bob["engine"].clone()).expect("bob's provider store");
    restore_persisted(&mut engine, persisted).expect("restore bob's store");

    let handle = load_signing_key(
        &mut engine,
        text(&bob["signingPublicKey"]),
        text(&bob["signingPrivateKey"]),
        "bob".to_string(),
    )
    .expect("load bob's signing key");

    let joined = join_group(&mut engine, text(&f["welcomeB64"]), &handle)
        .expect("the golden Welcome must be joinable on this target");
    assert_eq!(joined.members.len(), 2);

    let group_id = text(&f["groupIdB64"]);

    let commit = process_message(&mut engine, group_id, text(&f["commitB64"]), None)
        .expect("the golden commit must apply on this target");
    assert_eq!(commit.kind, "commit");
    assert_eq!(commit.added_members.len(), 1);

    let message = process_message(
        &mut engine,
        group_id,
        text(&f["applicationMessageB64"]),
        Some("parity-1".to_string()),
    )
    .expect("the golden application message must decrypt on this target");
    assert_eq!(
        message.plaintext.as_deref(),
        f["applicationPlaintextB64"].as_str(),
        "the golden ciphertext decrypted to different plaintext on this target"
    );
    assert_eq!(message.sender_identity.as_deref(), Some("alice"));
}

// ---------------------------------------------------------------------------
// 4. Encrypt / decrypt round trip, generated on this target
// ---------------------------------------------------------------------------

/// Two engines on this target: create, add, join, send, decrypt.
///
/// The ciphertext here is *not* comparable across targets - MLS output depends on fresh randomness
/// at every step, so a byte comparison would be asserting that `getrandom` is broken. What this
/// covers is the half the golden vectors cannot: the **encrypt** direction, and the whole
/// randomness path (`getrandom`'s `js` feature, `OsRng`, `rand::thread_rng`) which is unused when
/// only reading fixtures and which fails at *runtime*, not compile time, when the wasm feature flag
/// is missing.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_message_encrypted_on_this_target_decrypts_on_this_target() {
    let mut alice = parity_engine();
    let mut bob = parity_engine();

    let alice_keys = generate_key_packages(&mut alice, "alice".to_string(), 1).expect("alice keys");
    let bob_keys = generate_key_packages(&mut bob, "bob".to_string(), 1).expect("bob keys");

    let group_id = B64.encode(b"parity-group-0001");
    create_group(&mut alice, &group_id, &alice_keys.key_handle).expect("create group");

    let commit = add_members(
        &mut alice,
        &group_id,
        &alice_keys.key_handle,
        &[bob_keys.key_packages[0].key_package.clone()],
    )
    .expect("add bob");
    merge_pending_commit(&mut alice, &group_id).expect("merge");

    let joined = join_group(
        &mut bob,
        &commit.welcome.expect("a welcome for bob"),
        &bob_keys.key_handle,
    )
    .expect("bob joins");
    assert_eq!(joined.members.len(), 2);

    let plaintext = B64.encode(b"parity round trip");
    let sent = send_message(&mut alice, &group_id, &alice_keys.key_handle, &plaintext)
        .expect("alice sends");

    let received = process_message(&mut bob, &group_id, &sent.ciphertext, None)
        .expect("bob decrypts");
    assert_eq!(received.kind, "application");
    assert_eq!(received.plaintext.as_deref(), Some(plaintext.as_str()));
    assert_eq!(received.sender_identity.as_deref(), Some("alice"));
}

// ---------------------------------------------------------------------------
// 5. The web persistence path, exercised on both targets
// ---------------------------------------------------------------------------

/// `export_state` → `import_state` restores a live group.
///
/// This pair *is* web persistence: the wasm host runs with `state_path: None`, so nothing autosaves,
/// and the TypeScript adapter's job is to export this blob into IndexedDB and import it on boot. It
/// is the existing format the desktop build already writes and reads - deliberately, because a new
/// at-rest format for the browser would be a second thing to keep openable.
///
/// Asserted on both targets so the browser cannot be the only host that exercises it.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn exported_state_reimports_into_a_fresh_engine() {
    let mut alice = parity_engine();
    let keys = generate_key_packages(&mut alice, "alice".to_string(), 1).expect("keys");
    let group_id = B64.encode(b"parity-group-0002");
    let created = create_group(&mut alice, &group_id, &keys.key_handle).expect("create group");

    let state_key = B64.encode([0x33u8; 32]);
    let blob = export_state(&alice, &state_key).expect("export");

    let mut restored = parity_engine();
    import_state(&mut restored, &blob, &state_key).expect("import");

    let info = get_group_info(&restored, &group_id).expect("the group must come back");
    assert_eq!(info.epoch, created.epoch);
    assert_eq!(info.group_id, created.group_id);
    assert_eq!(info.members.len(), 1);

    // A wrong key must fail closed rather than yield an empty engine that looks like "no groups".
    let mut wrong = parity_engine();
    assert!(import_state(&mut wrong, &blob, &B64.encode([0x44u8; 32])).is_err());
}
