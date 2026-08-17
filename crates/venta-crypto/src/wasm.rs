//! wasm-bindgen wrappers - the browser's edge on the same engine.
//!
//! The third host, beside Tauri's `#[tauri::command]` wrappers and venta-mobile's FFI. Every
//! function here is a thin adapter: parse a JSON argument object, take the engine lock, call the
//! engine function, serialize the result. **No logic, ever.** Anything that did something would be
//! behaviour one host has and the others do not, which is the failure this whole split exists to
//! avoid.
//!
//! ## Why JSON strings in and JSON strings out
//!
//! Because the argument shapes are already settled, already shared with venta-mobile, and already
//! written down on the TypeScript side. A wasm-bindgen signature per command would restate them in a
//! third place and create a third place for them to drift; taking `{"groupIdB64": "..."}` means the
//! web adapter passes the exact object it passes to Tauri's `invoke`, and `MlsEngine.call(command,
//! args)` stays one function for both hosts - see the port contracts in
//! `docs/superpowers/specs/2026-08-11-browser-only-build-design.md`.
//!
//! Field names are `camelCase`, matching what Tauri's IPC deserializes today. Unknown fields are
//! ignored, also matching Tauri, so a caller that passes an extra key is not broken by it.
//!
//! ## What is deliberately not exposed
//!
//! * `mls_current_state_dir` - it reports a filesystem path, and there is no filesystem. It has no
//!   TypeScript caller on any host.
//! * `device_cert_verify` - no TypeScript caller yet. §H.2 verification is pure and would port in
//!   one function the moment the payments directory check is wired up; adding an entry point with no
//!   caller is how surfaces rot unnoticed.
//!
//! ## The two places the browser behaves differently
//!
//! Both are documented at their source and neither is in the crypto:
//!
//! 1. `state_path` is `None`, so `MlsState::save_to_disk` is a no-op. **There is no autosave on the
//!    web.** The adapter must call `mls_export_state` after any mutating call and put the blob in
//!    IndexedDB, or the operation is lost on reload. Same encrypted format the desktop writes.
//! 2. [`mls_init_storage`] cannot re-read a state file, because there is none. See its own note for
//!    what it does keep.

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{de::DeserializeOwned, Serialize};
use wasm_bindgen::prelude::*;

use crate::crypto::{CredentialKind, EncryptedMasterKey};
use crate::mls::{self, BackupAccountIdentity, MlsState};

// ---------------------------------------------------------------------------
// Engine instance
// ---------------------------------------------------------------------------

/// The one engine for this page.
///
/// Tauri holds `MlsStateHandle` in managed state and venta-mobile in a process-global `OnceLock`;
/// this is mobile's shape, for the same reason - there is no framework here to hold it for us. A
/// browser tab is one process with one account, and switching accounts on the web is a reload (see
/// `project_multi_account`), so a single instance is the whole requirement.
fn engine() -> &'static Mutex<MlsState> {
    static ENGINE: OnceLock<Mutex<MlsState>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(MlsState::default()))
}

/// Takes the engine lock, reporting a poisoned mutex the way the Tauri wrappers do.
fn lock() -> Result<MutexGuard<'static, MlsState>, JsValue> {
    engine().lock().map_err(|e| JsValue::from_str(&e.to_string()))
}

// ---------------------------------------------------------------------------
// JSON plumbing
// ---------------------------------------------------------------------------

/// Parses a command's argument object.
///
/// A malformed object is an `Err`, not a default-filled struct - the same failure Tauri produces
/// when a required parameter is missing, and for the same reason: silently substituting a default
/// for an absent argument is how `rewrap_master_key` could be invoked with three of its five
/// arguments and fail 100% of the time with nothing to read.
fn args<T: DeserializeOwned>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|e| {
        JsValue::from_str(&format!(
            "InvalidArguments: could not read the argument object: {e}"
        ))
    })
}

/// Serializes a command's result, or turns the engine's `String` error into a thrown JS value.
///
/// The error travels as a plain string because that is what the TypeScript layer already matches on
/// - `MlsError:`, `InvalidRecoveryCode:`, "no state key was supplied" - and those prefixes are load
/// bearing: `mls.service.ts` uses them to tell a transient keychain failure from a corrupt state
/// file, and only the second wipes a device's groups.
fn out<T: Serialize>(result: Result<T, String>) -> Result<String, JsValue> {
    match result {
        Ok(value) => serde_json::to_string(&value).map_err(|e| {
            JsValue::from_str(&format!("InternalError: could not serialize the result: {e}"))
        }),
        Err(message) => Err(JsValue::from_str(&message)),
    }
}

/// The same, for the infallible commands.
fn out_infallible<T: Serialize>(value: T) -> Result<String, JsValue> {
    out::<T>(Ok(value))
}

// ---------------------------------------------------------------------------
// crypto - master key, recovery codes, key pairs
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = generate_key)]
pub fn generate_key() -> Result<String, JsValue> {
    out_infallible(crate::crypto::generate_key())
}

#[wasm_bindgen(js_name = generate_key_pairs)]
pub fn generate_key_pairs(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        count: u32,
    }
    let a: Args = args(args_json)?;
    out(crate::crypto::generate_key_pairs(a.count))
}

#[wasm_bindgen(js_name = setup_master_key)]
pub fn setup_master_key(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        password: String,
        #[serde(default)]
        user_entropy: Option<Vec<u8>>,
    }
    let a: Args = args(args_json)?;
    out(crate::crypto::setup_master_key(a.password, a.user_entropy))
}

#[wasm_bindgen(js_name = setup_master_key_dual)]
pub fn setup_master_key_dual(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        password: String,
        recovery_code: String,
        #[serde(default)]
        user_entropy: Option<Vec<u8>>,
    }
    let a: Args = args(args_json)?;
    out(crate::crypto::setup_master_key_dual(
        a.password,
        a.recovery_code,
        a.user_entropy,
    ))
}

#[wasm_bindgen(js_name = rewrap_master_key)]
pub fn rewrap_master_key(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        encrypted: EncryptedMasterKey,
        from_credential: String,
        from_kind: CredentialKind,
        to_credential: String,
        to_kind: CredentialKind,
    }
    let a: Args = args(args_json)?;
    out(crate::crypto::rewrap_master_key(
        a.encrypted,
        a.from_credential,
        a.from_kind,
        a.to_credential,
        a.to_kind,
    ))
}

#[wasm_bindgen(js_name = generate_recovery_code)]
pub fn generate_recovery_code() -> Result<String, JsValue> {
    out(crate::crypto::generate_recovery_code())
}

#[wasm_bindgen(js_name = normalize_recovery_code_checked)]
pub fn normalize_recovery_code_checked(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        code: String,
    }
    let a: Args = args(args_json)?;
    out(crate::crypto::normalize_recovery_code_checked(a.code))
}

#[wasm_bindgen(js_name = decrypt_master_key)]
pub fn decrypt_master_key(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        encrypted: EncryptedMasterKey,
        password: String,
    }
    let a: Args = args(args_json)?;
    out(crate::crypto::decrypt_master_key(a.encrypted, a.password))
}

// ---------------------------------------------------------------------------
// mls - signing keys and key packages
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = mls_load_signing_key)]
pub fn mls_load_signing_key(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        signing_public_key_b64: String,
        signing_private_key_b64: String,
        identity: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::load_signing_key(
        &mut mls,
        &a.signing_public_key_b64,
        &a.signing_private_key_b64,
        a.identity,
    ))
}

#[wasm_bindgen(js_name = mls_unload_signing_key)]
pub fn mls_unload_signing_key(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::unload_signing_key(&mut mls, &a.key_handle))
}

/// Note the name: `generate_mls_key_packages`, not `mls_generate_key_packages`. It is the one
/// command in the surface that does not carry the prefix, and renaming it here would be a silent
/// "command not found" on the web only.
#[wasm_bindgen(js_name = generate_mls_key_packages)]
pub fn generate_mls_key_packages(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        identity: String,
        count: u32,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::generate_key_packages(&mut mls, a.identity, a.count))
}

#[wasm_bindgen(js_name = mls_generate_key_packages_with_handle)]
pub fn mls_generate_key_packages_with_handle(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        key_handle: String,
        count: u32,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::generate_key_packages_with_handle(
        &mls,
        &a.key_handle,
        a.count,
    ))
}

#[wasm_bindgen(js_name = mls_inspect_key_package)]
pub fn mls_inspect_key_package(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        key_package_b64: String,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::inspect_key_package(&mls, &a.key_package_b64))
}

#[wasm_bindgen(js_name = mls_signing_key_fingerprint)]
pub fn mls_signing_key_fingerprint(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::signing_key_fingerprint(&mls, &a.key_handle))
}

// ---------------------------------------------------------------------------
// mls - groups
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = mls_create_group)]
pub fn mls_create_group(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::create_group(&mut mls, &a.group_id_b64, &a.key_handle))
}

#[wasm_bindgen(js_name = mls_add_members)]
pub fn mls_add_members(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
        key_packages_b64: Vec<String>,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::add_members(
        &mut mls,
        &a.group_id_b64,
        &a.key_handle,
        &a.key_packages_b64,
    ))
}

#[wasm_bindgen(js_name = mls_remove_members)]
pub fn mls_remove_members(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
        leaf_indices: Vec<u32>,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::remove_members(
        &mut mls,
        &a.group_id_b64,
        &a.key_handle,
        &a.leaf_indices,
    ))
}

#[wasm_bindgen(js_name = mls_join_group)]
pub fn mls_join_group(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        welcome_b64: String,
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::join_group(&mut mls, &a.welcome_b64, &a.key_handle))
}

#[wasm_bindgen(js_name = mls_leave_group)]
pub fn mls_leave_group(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::leave_group(&mut mls, &a.group_id_b64, &a.key_handle))
}

#[wasm_bindgen(js_name = mls_commit_pending_proposals)]
pub fn mls_commit_pending_proposals(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::commit_pending_proposals(
        &mut mls,
        &a.group_id_b64,
        &a.key_handle,
    ))
}

#[wasm_bindgen(js_name = mls_merge_pending_commit)]
pub fn mls_merge_pending_commit(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::merge_pending_commit(&mut mls, &a.group_id_b64))
}

#[wasm_bindgen(js_name = mls_clear_pending_commit)]
pub fn mls_clear_pending_commit(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::clear_pending_commit(&mut mls, &a.group_id_b64))
}

#[wasm_bindgen(js_name = mls_export_group_info)]
pub fn mls_export_group_info(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::export_group_info(
        &mls,
        &a.group_id_b64,
        &a.key_handle,
    ))
}

#[wasm_bindgen(js_name = mls_rejoin_group)]
pub fn mls_rejoin_group(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_info_b64: String,
        key_handle: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::rejoin_group(
        &mut mls,
        &a.group_info_b64,
        &a.key_handle,
    ))
}

#[wasm_bindgen(js_name = mls_delete_group)]
pub fn mls_delete_group(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::delete_group(&mut mls, &a.group_id_b64))
}

#[wasm_bindgen(js_name = mls_get_members)]
pub fn mls_get_members(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::get_members(&mls, &a.group_id_b64))
}

#[wasm_bindgen(js_name = mls_get_group_info)]
pub fn mls_get_group_info(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::get_group_info(&mls, &a.group_id_b64))
}

// ---------------------------------------------------------------------------
// mls - messages
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = mls_send_message)]
pub fn mls_send_message(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        key_handle: String,
        plaintext_b64: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::send_message(
        &mut mls,
        &a.group_id_b64,
        &a.key_handle,
        &a.plaintext_b64,
    ))
}

#[wasm_bindgen(js_name = mls_process_message)]
pub fn mls_process_message(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
        message_b64: String,
        /// Optional exactly as over IPC. A message from an epoch this device has not reached is
        /// buffered rather than refused, and this is what lets `mls_drain_pending_messages` hand the
        /// plaintext back against the right row.
        #[serde(default)]
        message_id: Option<String>,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::process_message(
        &mut mls,
        &a.group_id_b64,
        &a.message_b64,
        a.message_id,
    ))
}

#[wasm_bindgen(js_name = mls_drain_pending_messages)]
pub fn mls_drain_pending_messages(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        group_id_b64: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::drain_pending_messages(&mut mls, &a.group_id_b64))
}

// ---------------------------------------------------------------------------
// mls - storage
// ---------------------------------------------------------------------------

/// Web has no state file, so this validates and reports rather than loading.
///
/// <p><b>This is the one command whose behaviour genuinely differs from the desktop one, and the
/// difference is deliberate.</b> The native command resolves an app-data path, optionally adopts a
/// pre-scope file, and reads whatever is there - returning whether it found state. None of that
/// exists in a browser, so:</p>
///
/// * The state key is still **required**, and refused with the same message the native path uses -
///   `mls.service.ts` matches on that wording to tell "the keychain is not answering this launch"
///   from "the state file is corrupt", and only the second wipes a device's groups. Reporting a
///   different error here would misclassify a transient failure as an irreversible one.
/// * It always returns `false`: there is no file to have found. The web adapter's next step is
///   `mls_import_state` with the blob it holds in IndexedDB, which is the same encrypted format and
///   the same code path the desktop build uses for a §D restore.
/// * `scope` and `adoptLegacy` are accepted and unused. `adoptLegacy` renames a file; `scope` names
///   one. Neither has a meaning without a filesystem, and both are in the argument object every
///   caller already sends.
///
/// <p><b>What is therefore not inherited:</b> the native path *clears* the engine when the state
/// path changes, which is what stops two accounts' key material landing in one provider store. With
/// no path there is nothing to compare, so this does not clear. That is safe because switching
/// accounts on the web is a page reload - see `project_multi_account` - which is a fresh engine by
/// construction. It would stop being safe the moment a web build let one page swap accounts in
/// place, and that is the change that must come back here.</p>
#[wasm_bindgen(js_name = mls_init_storage)]
pub fn mls_init_storage(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        #[serde(default)]
        state_key_b64: Option<String>,
        #[serde(default)]
        #[allow(dead_code)]
        scope: Option<String>,
        #[serde(default)]
        #[allow(dead_code)]
        adopt_legacy: Option<bool>,
    }
    let a: Args = args(args_json)?;

    if a.state_key_b64.is_none() {
        // Wording copied from `init_storage_from_parts`, not paraphrased. It is a contract with the
        // TypeScript classifier.
        return Err(JsValue::from_str(
            "MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so \
             encryption stays unavailable until the keychain produces one",
        ));
    }

    out_infallible(false)
}

#[wasm_bindgen(js_name = mls_clear_storage)]
pub fn mls_clear_storage() -> Result<String, JsValue> {
    let mut mls = lock()?;
    out(mls::clear_storage(&mut mls))
}

/// Seals the engine's whole provider store into one blob. **Web persistence is this function.**
///
/// On the desktop every mutating operation also writes `mls_state_{scope}.json`; on the web nothing
/// does, so the adapter has to call this after any mutation and store what it returns. Same format
/// on both hosts.
#[wasm_bindgen(js_name = mls_export_state)]
pub fn mls_export_state(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        encryption_key_b64: String,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::export_state(&mls, &a.encryption_key_b64))
}

#[wasm_bindgen(js_name = mls_import_state)]
pub fn mls_import_state(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        encrypted_b64: String,
        encryption_key_b64: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::import_state(
        &mut mls,
        &a.encrypted_b64,
        &a.encryption_key_b64,
    ))
}

// ---------------------------------------------------------------------------
// mls - §D backup envelope
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = mls_export_backup)]
pub fn mls_export_backup(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        passphrase: String,
        user_id: String,
        device_id: String,
        app_version: String,
        key_handle: String,
        group_registry: std::collections::HashMap<String, serde_json::Value>,
        #[serde(default)]
        message_cache: Option<std::collections::HashMap<String, String>>,
        #[serde(default)]
        account_identity: Option<BackupAccountIdentity>,
    }
    let a: Args = args(args_json)?;
    let mls = lock()?;
    out(mls::export_backup(
        &mls,
        a.passphrase,
        a.user_id,
        a.device_id,
        a.app_version,
        a.key_handle,
        a.group_registry,
        a.message_cache,
        a.account_identity,
    ))
}

#[wasm_bindgen(js_name = mls_import_backup)]
pub fn mls_import_backup(args_json: &str) -> Result<String, JsValue> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        blob: String,
        passphrase: String,
        expected_user_id: String,
        current_device_id: String,
    }
    let a: Args = args(args_json)?;
    let mut mls = lock()?;
    out(mls::import_backup(
        &mut mls,
        a.blob,
        a.passphrase,
        a.expected_user_id,
        a.current_device_id,
    ))
}
