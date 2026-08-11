//! An honest read of the OS keychain, for the entries `tauri-plugin-secure-storage` writes.
//!
//! # Why this module exists at all
//!
//! The frontend's `SecureStore` port promises that a read which **failed** rejects rather than
//! answering "no entry". That distinction is not cosmetic. `MlsService.localStateKey` mints a fresh
//! 32-byte state key when the read reports absence, and the sealed engine state (`mls_state.json`)
//! plus the whole plaintext message cache are authenticated under the key it minted. Hand it a
//! *wrong* key and the AEAD open legitimately fails, `mls-storage-init.ts`'s classifier legitimately
//! calls that "corrupt", and the launch wipes every group key and every message on the device. There
//! is no recovery from that, and it can be caused by a keychain that was merely locked for a moment.
//!
//! `tauri-plugin-secure-storage` 1.5.0 cannot keep that promise. Its `src/desktop.rs::get_item` is:
//!
//! ```text
//! let data = entry.unwrap().get_password();
//! match data {
//!     Ok(data) => Ok(GetItemResponse { data: Some(data) }),
//!     Err(_)   => Ok(GetItemResponse { data: None }),   // every error, collapsed
//! }
//! ```
//!
//! `keyring` does discriminate - [`keyring::Error::NoEntry`] ("either one was never set, or it was
//! deleted") against [`keyring::Error::NoStorageAccess`] ("it might be that the credential store is
//! locked"), plus `PlatformFailure`, `BadEncoding`, `TooLong`, `Invalid` and `Ambiguous` - and the
//! plugin throws all of it away before the IPC boundary. On Windows the two that matter are one
//! `GetLastError` apart: `ERROR_NOT_FOUND -> NoEntry`, `ERROR_NO_SUCH_LOGON_SESSION ->
//! NoStorageAccess` (`keyring-3.6.3/src/windows.rs::decode_error`).
//!
//! So this module re-reads the *same entry* through `keyring` directly and keeps the distinction:
//! `NoEntry` is the only error that becomes "absent". Everything else is an `Err` naming the variant
//! and carrying the platform detail, which the adapter turns into a rejected promise.
//!
//! # The part that must not be got wrong: the address
//!
//! An entry is addressed by `(service, user)`. If this module computed either differently from the
//! plugin, every existing install's keys would read as absent - a self-inflicted copy of the very
//! bug being fixed, and worse, because it would fire on *every* machine rather than on unlucky ones.
//!
//! The plugin derives the pair in two halves, one per language:
//!
//! - **JS** (`tauri-plugin-secure-storage-api`, `dist-js/index.js`): `SecureStorage` is constructed
//!   with `this.prefix = 'tauri-storage_'`, `prefixedKey(key) { return this.prefix + key; }`, and
//!   `getItem`/`setItem`/`removeItem` all send `prefixedKey: this.prefixedKey(key)`. The prefix is
//!   only mutable through `setKeyPrefix`, which this app never calls.
//! - **Rust** (`src/desktop.rs`): `Entry::new(&*app.config().product_name.clone().unwrap(),
//!   &*key.unwrap())` - service is `productName` from `tauri.conf.json`, user is that prefixed key.
//!
//! [`entry_address`] below reproduces both halves, and `keychain_read` passes the result to the same
//! `keyring::Entry::new`. Note what makes this exact rather than merely similar: there is one
//! `keyring` 3.6.3 in `Cargo.lock` and one compilation of it in the binary, `Entry::new` resolves the
//! credential through a process-global default builder, and nothing here or in the plugin calls
//! `keyring::set_default_credential_builder`. Same crate instance, same builder, same two strings -
//! so the platform credential is identical by construction, not by re-implementation.
//!
//! # Desktop only, on purpose
//!
//! Gated `#[cfg(desktop)]`, which is the exact gate the plugin uses to choose `desktop.rs` over
//! `mobile.rs`. On mobile the plugin does **not** use `keyring` at all - it calls into a native
//! iOS/Android plugin - so a `keyring` read there would address a different entry than the plugin's
//! writes, and on Android `keyring` has no credential store and silently falls back to its in-memory
//! `mock` (`keyring-3.6.3/src/lib.rs`: `pub use mock as default` for every unrecognised target),
//! which answers `NoEntry` for everything. Both are the catastrophe this module exists to prevent, so
//! the command is registered in the desktop `generate_handler!` list only; a mobile build would fail
//! the `invoke` loudly instead of reading a wrong answer quietly. Tauri mobile is dropped anyway -
//! mobile is a separate Flutter app.

/// The prefix the plugin's JS wrapper puts on every key before it reaches Rust.
///
/// From `dist-js/index.js`: `this.prefix = 'tauri-storage_'` in `SecureStorage`'s constructor, applied
/// by `prefixedKey`. **Every existing entry on every existing install is stored under this.** It is a
/// constant here rather than a parameter because the frontend has no business knowing the plugin's
/// wire format, and because a value that travels over IPC is a value that can be got wrong in transit.
const JS_KEY_PREFIX: &str = "tauri-storage_";

/// The answer to one keychain read.
///
/// `absent` is a **positive** assertion, not the absence of `data`. That is deliberate: the whole
/// defect being fixed is a missing value being read as "nothing was ever stored", so the honest
/// answer says so out loud and the adapter refuses any shape that is not one of the two below.
///
/// - absent: `{ absent: true, data: null }` - and only for [`keyring::Error::NoEntry`].
/// - present: `{ absent: false, data: "<stored string>" }`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainRead {
    /// True only when the platform said, specifically, that no such credential exists.
    pub absent: bool,
    /// The stored string. `None` exactly when `absent`.
    pub data: Option<String>,
}

/// Reads one entry written by `tauri-plugin-secure-storage`, without collapsing errors.
///
/// `Ok(absent: true)` means the credential store was reachable and reported no such credential -
/// the one answer that licenses `MlsService.localStateKey` to mint. Every other failure is `Err`,
/// which `invoke` surfaces as a rejected promise.
#[cfg(desktop)]
#[tauri::command]
pub fn keychain_read(app: tauri::AppHandle, key: String) -> Result<KeychainRead, String> {
    // `product_name` is `Option`, and the plugin `unwrap()`s it - a None would panic inside the
    // plugin today. Refusing with a message is the same answer minus the abort, and it must not be
    // defaulted to anything: guessing a service name would read the wrong entry, which is absence.
    let product_name = app
        .config()
        .product_name
        .clone()
        .ok_or_else(|| {
            "keychain read refused: tauri.conf.json has no productName, which is the keyring \
             service name every existing secure-storage entry was written under. Reading under a \
             guessed name would report absence for entries that exist."
                .to_string()
        })?;

    let (service, user) = entry_address(&product_name, &key);

    // `Entry::new` fails on an invalid or over-long service/user. The plugin `unwrap()`s this too.
    // It is emphatically not "absent": a name the platform rejected tells us nothing about whether
    // a credential is there.
    let entry = keyring::Entry::new(&service, &user)
        .map_err(|err| describe(&err, "could not address the keychain entry for"))?;

    classify(entry.get_password(), &user)
}

/// The `(service, user)` pair identifying an entry, derived exactly as the plugin derives it.
///
/// Split out from the command so it can be asserted without an `AppHandle` - see the tests. A change
/// to either half orphans every stored key, so this is the one function in the module worth pinning
/// character for character.
fn entry_address(product_name: &str, key: &str) -> (String, String) {
    (product_name.to_owned(), format!("{JS_KEY_PREFIX}{key}"))
}

/// Turns one `keyring` read outcome into the wire answer.
///
/// **The single decision this module exists to make.** [`keyring::Error::NoEntry`] - and nothing
/// else, including the `#[non_exhaustive]` variants that do not exist yet - is absence.
fn classify(read: keyring::Result<String>, user: &str) -> Result<KeychainRead, String> {
    match read {
        Ok(data) => Ok(KeychainRead { absent: false, data: Some(data) }),
        // "There is no underlying credential entry in the platform for this entry. Either one was
        // never set, or it was deleted." That, and only that, is a fresh device.
        Err(keyring::Error::NoEntry) => Ok(KeychainRead { absent: true, data: None }),
        Err(err) => Err(describe(&err, &format!("could not read keychain entry \"{user}\":"))),
    }
}

/// A message naming the `keyring` variant and whatever platform detail came with it.
///
/// The variant name is included as well as the `Display` text because the two carry different
/// information: `Display` for `NoStorageAccess` is "Couldn't access platform secure storage: {err}"
/// with the OS error inside, while the variant is what says *which* of the seven cases this was -
/// and that is what a bug report needs in order to tell a locked store from a corrupt one.
fn describe(err: &keyring::Error, context: &str) -> String {
    let variant = match err {
        keyring::Error::PlatformFailure(_) => "PlatformFailure",
        keyring::Error::NoStorageAccess(_) => "NoStorageAccess",
        keyring::Error::NoEntry => "NoEntry",
        keyring::Error::BadEncoding(_) => "BadEncoding",
        keyring::Error::TooLong(_, _) => "TooLong",
        keyring::Error::Invalid(_, _) => "Invalid",
        keyring::Error::Ambiguous(_) => "Ambiguous",
        // `keyring::Error` is `#[non_exhaustive]`. An unrecognised variant is still a failure, and
        // must not fall into the absent branch by default - which is why this match returns a label
        // rather than deciding anything.
        _ => "Unrecognised",
    };
    format!("{context} keyring::Error::{variant}: {err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The address the plugin's two halves compose to, asserted literally.
    ///
    /// If this test is ever "fixed" by changing the expectation, read the module header first: the
    /// expectation is a description of data already on users' disks, not a preference.
    #[test]
    fn addresses_the_entry_the_plugin_addresses() {
        let (service, user) = entry_address("Venta", "alpine_mls_device-7_statekey");

        // Service: `app.config().product_name`, verbatim (`desktop.rs`, `Entry::new`'s first arg).
        assert_eq!(service, "Venta");
        // User: the JS wrapper's `this.prefix + key` (`dist-js/index.js`, `prefixedKey`).
        assert_eq!(user, "tauri-storage_alpine_mls_device-7_statekey");
    }

    /// Pins the prefix on its own, because the composition test above would still pass if the
    /// constant and the expectation were changed together in one edit.
    #[test]
    fn uses_the_plugin_js_wrappers_key_prefix() {
        assert_eq!(JS_KEY_PREFIX, "tauri-storage_");
    }

    #[test]
    fn a_stored_value_reads_back_as_present() {
        let answer = classify(Ok("c3RvcmVkLWtleQ==".to_string()), "tauri-storage_k").expect("present");

        assert!(!answer.absent);
        assert_eq!(answer.data.as_deref(), Some("c3RvcmVkLWtleQ=="));
    }

    /// The first-run path. If this ever became an `Err`, no device could complete initial setup -
    /// the opposite catastrophe to the one this module fixes, and just as total.
    #[test]
    fn no_entry_is_the_one_error_that_means_absent() {
        let answer = classify(Err(keyring::Error::NoEntry), "tauri-storage_k").expect("absent");

        assert!(answer.absent);
        assert_eq!(answer.data, None);
    }

    /// A locked credential store. `NoStorageAccess`'s own doc comment says "it might be that the
    /// credential store is locked" - the exact case that used to arrive as `null` and get minted over.
    #[test]
    fn a_locked_store_is_an_error_and_never_absent() {
        let cause = std::io::Error::other("Windows ERROR_NO_SUCH_LOGON_SESSION");
        let err = classify(
            Err(keyring::Error::NoStorageAccess(Box::new(cause))),
            "tauri-storage_alpine_mls_device-7_statekey",
        )
        .expect_err("a locked store must not resolve");

        assert!(err.contains("NoStorageAccess"), "{err}");
        assert!(err.contains("ERROR_NO_SUCH_LOGON_SESSION"), "platform detail lost: {err}");
        assert!(err.contains("alpine_mls_device-7_statekey"), "entry not named: {err}");
    }

    /// The two failures that motivated the fix specifically, because they are the ones where reads
    /// fail while writes still succeed - so the "a write would have failed too" accident that
    /// half-covered this does not apply to them.
    #[test]
    fn bad_encoding_and_ambiguity_are_errors_and_never_absent() {
        let bad = classify(Err(keyring::Error::BadEncoding(vec![0xff, 0xfe])), "tauri-storage_k")
            .expect_err("non-UTF-8 bytes must not resolve");
        assert!(bad.contains("BadEncoding"), "{bad}");

        let ambiguous = classify(Err(keyring::Error::Ambiguous(Vec::new())), "tauri-storage_k")
            .expect_err("two matching credentials must not resolve");
        assert!(ambiguous.contains("Ambiguous"), "{ambiguous}");
    }

    #[test]
    fn platform_failure_and_invalid_names_are_errors_and_never_absent() {
        let platform = classify(
            Err(keyring::Error::PlatformFailure(Box::new(std::io::Error::other("dbus died")))),
            "tauri-storage_k",
        )
        .expect_err("a platform failure must not resolve");
        assert!(platform.contains("PlatformFailure"), "{platform}");
        assert!(platform.contains("dbus died"), "{platform}");

        let invalid = classify(
            Err(keyring::Error::Invalid("user".into(), "cannot be empty".into())),
            "tauri-storage_",
        )
        .expect_err("an invalid attribute must not resolve");
        assert!(invalid.contains("Invalid"), "{invalid}");

        let too_long = classify(Err(keyring::Error::TooLong("target".into(), 32)), "tauri-storage_k")
            .expect_err("an over-long attribute must not resolve");
        assert!(too_long.contains("TooLong"), "{too_long}");
    }

    /// Exhaustiveness, phrased so it cannot rot: every variant `keyring` has today is either the one
    /// absent case or an error. A new `#[non_exhaustive]` variant lands in the `Unrecognised` arm,
    /// which is an error - the safe direction.
    #[test]
    fn exactly_one_of_keyrings_variants_is_absent() {
        let errors: Vec<keyring::Error> = vec![
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("x"))),
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("x"))),
            keyring::Error::BadEncoding(vec![0]),
            keyring::Error::TooLong("a".into(), 1),
            keyring::Error::Invalid("a".into(), "b".into()),
            keyring::Error::Ambiguous(Vec::new()),
        ];

        for err in errors {
            let label = describe(&err, "");
            assert!(
                classify(Err(err), "tauri-storage_k").is_err(),
                "collapsed into absence: {label}",
            );
        }

        assert!(classify(Err(keyring::Error::NoEntry), "tauri-storage_k").is_ok());
    }
}
