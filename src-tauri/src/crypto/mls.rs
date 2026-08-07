//! MLS (RFC 9420) group engine.
//!
//! Shared line-for-line with venta-mobile's `packages/venta_mls/rust/src/mls.rs`. Both clients talk
//! to the same server, join the same groups and read each other's ciphertext, so any divergence in
//! the engine below is a divergence in the wire protocol. Only the edges differ: mobile drives it
//! through a process-global `Mutex` and an explicitly passed storage path, Alpine through Tauri's
//! `State`/`AppHandle`.
//!
//! That edge is the whole reason this file has its own shape. The engine functions take `&str` and
//! mirror mobile's exactly; the `#[tauri::command]` wrappers and the `*_impl` shims that adapt
//! `String` for them live at the bottom, in their own clearly marked sections. Anything else -
//! reordering, renaming, "tidying" a signature - makes the next port a merge instead of a copy,
//! which is how this file came to be overwritten with mobile's wholesale in the first place.
//!
//! Two things deliberately do **not** come across from mobile:
//!
//! * The account master key (`setup_master_key`, `wrap_master_key`, recovery codes,
//!   `EncryptedMasterKey`). Alpine already owns every one of those in `crypto::crypto`, registered
//!   as its own Tauri commands. They sit in a different module there, so importing mobile's copy
//!   would *compile* and ship two divergent implementations of the same wrapping in one binary.
//! * Admission proofs and protection levels (§G, §G.3). No Alpine caller reaches them, and an
//!   unreachable signing surface is worse than an absent one.
//! * Device-certificate **issuance** (§H.2), for the same reason. Device-certificate
//!   *verification* is a different matter and now lives in `crypto::device_cert`: it is what the
//!   payments key directory is checked against, so it has a caller, and it signs nothing. Note that
//!   it does not depend on this module beyond `format_fingerprint` - a payments screen must not
//!   fail closed because the MLS engine happens to be locked.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::{
    aead::{Aead, Payload},
    {Aes256Gcm, KeyInit, Nonce},
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use openmls::prelude::*;
use openmls::prelude::{
    tls_codec::{Deserialize as TlsCodecDeserialize, DeserializeBytes, Serialize as TlsSerialize},
    BasicCredential, Ciphersuite, CredentialWithKey, GroupId, KeyPackage, KeyPackageIn,
    LeafNodeIndex, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn,
    MlsMessageIn, OpenMlsProvider, ProcessedMessageContent, ProtocolVersion, SignatureScheme,
    StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Must match venta-mobile's exactly. A group created under one ciphersuite cannot be joined by a
/// device offering a key package built under another.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

// ---------------------------------------------------------------------------
// Output types (serialized to JSON across the IPC boundary)
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyPackageResult {
    pub key_package: String,
    pub init_private_key: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MlsKeyPackageBatch {
    pub signing_public_key: String,
    pub signing_private_key: String,
    pub key_packages: Vec<KeyPackageResult>,
    pub key_handle: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MlsMemberInfo {
    pub leaf_index: u32,
    pub identity: String,
    pub encryption_key: String,
    pub signature_key: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MlsGroupInfo {
    pub group_id: String,
    pub epoch: u64,
    pub own_leaf_index: u32,
    pub members: Vec<MlsMemberInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsCommitOut {
    pub commit: String,
    pub welcome: Option<String>,
    pub epoch: u64,
    /// GroupInfo for the epoch this commit **establishes**, produced by the commit itself.
    ///
    /// Publish this rather than calling `export_group_info`. Both engines used to discard openmls's
    /// third return value as `_group_info` and export one separately - but an exported GroupInfo can
    /// only ever describe the epoch the group is on *now*, and a commit is deliberately not merged
    /// until the server accepts it. So every published GroupInfo was one epoch stale, and a device
    /// recovering by external commit landed behind the group it was rejoining. No amount of
    /// reordering export-versus-merge fixes that; the value openmls hands back is the only one that
    /// describes the right epoch.
    pub group_info: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsProcessedMessage {
    pub kind: String,
    pub plaintext: Option<String>,
    pub self_removed: bool,
    pub added_members: Vec<MlsMemberInfo>,
    pub removed_leaf_indices: Vec<u32>,
    pub sender_identity: Option<String>,
    pub epoch: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsSendOut {
    pub ciphertext: String,
    pub epoch: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsRejoinOut {
    pub group_info: MlsGroupInfo,
    pub external_commit: String,
}

/// Everything a reviewer needs to decide whether a key package really belongs to who it claims.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsKeyPackageInfo {
    /// Identity from the BasicCredential - the user id the package claims.
    pub identity: String,
    /// Long-lived Ed25519 signature key (base64).
    pub signature_public_key: String,
    /// Human-comparable fingerprint of the *signature* key.
    ///
    /// Deliberately not a hash of the key package: that changes with every package a device mints,
    /// so two people reading it to each other would never agree on anything. The signature key is
    /// the device's stable identity, so this is the value that means something out of band.
    pub signature_key_fingerprint: String,
    /// SHA-256 of the key package bytes, hex. Binds an approval to these exact bytes.
    pub key_package_hash: String,
}

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct PersistedMlsState {
    version: u32,
    group_ids: Vec<String>,
    storage: HashMap<String, String>,
}

struct SignerEntry {
    pub_bytes: Vec<u8>,
    priv_bytes: Vec<u8>,
    identity: String,
}

#[derive(Default)]
pub struct MlsState {
    provider: OpenMlsRustCrypto,
    groups: HashMap<Vec<u8>, MlsGroup>,
    signers: HashMap<String, SignerEntry>,
    pending_messages: HashMap<Vec<u8>, Vec<BufferedMessage>>,
    state_path: Option<PathBuf>,

    /// AES-256 key the state file is sealed under, held by the OS keychain on the TypeScript side.
    ///
    /// `mls_state.json` is every epoch secret, every leaf HPKE private key and every init private
    /// key this device holds. It used to be plain JSON on disk, so anyone with the disk, an
    /// OS-level backup or a restored device image could read live group keys out of it with no
    /// keychain access and no unlock. Sealing it under a key that lives in the OS credential store -
    /// which backups do not carry - is what makes the file worthless off the device that wrote it.
    ///
    /// Never legitimately `None` past [`init_storage_from_parts`], which refuses outright: there is
    /// no unsealed way to save, and pretending otherwise is how the private keys ended up on disk
    /// in cleartext.
    ///
    /// Mobile carries a `read_only` flag alongside this, for the iOS notification-service extension
    /// that loads state in a *separate process* and must never write it back. Alpine has no second
    /// process sharing this store, so the flag is deliberately absent rather than present and
    /// permanently false.
    state_key: Option<Vec<u8>>,
}

impl MlsState {
    fn to_persisted(&self) -> PersistedMlsState {
        let values = self.provider.storage().values.read().unwrap();
        let storage = values
            .iter()
            .map(|(k, v)| (B64.encode(k), B64.encode(v)))
            .collect();
        let group_ids = self.groups.keys().map(|k| B64.encode(k)).collect();
        PersistedMlsState {
            version: 1,
            group_ids,
            storage,
        }
    }

    /// Persists the provider store, sealed, via [`write_state_file`].
    ///
    /// A missing `state_path` is an **error**, not a no-op.
    ///
    /// It used to return `Ok(())`, which meant an engine that was never initialised - or whose
    /// initialisation failed - performed every operation perfectly and persisted none of it. Every
    /// group it joined and every commit it merged vanished on the next launch, and nothing anywhere
    /// said so.
    fn save_to_disk(&self) -> Result<(), String> {
        let Some(path) = &self.state_path else {
            return Err(
                "MlsError: MLS storage is not initialised - initStorage must succeed before any \
                 group operation, or the operation is silently lost"
                    .to_string(),
            );
        };
        let json = serde_json::to_vec(&self.to_persisted()).map_err(|e| e.to_string())?;
        write_state_file(path, &json, self.state_key.as_deref())
    }
}

/// Marks a sealed `mls_state.json`. Present so a file written before the state file was encrypted
/// still loads and is upgraded in place, and so a sealed file read without a key fails loudly
/// rather than as "not JSON".
///
/// This replaces a heuristic - try to decrypt, and on failure see whether the bytes happen to parse
/// as JSON - which could not tell a legacy plaintext file apart from a sealed one opened with the
/// wrong key except by guessing.
const STATE_FILE_MAGIC: &[u8] = b"VENTAMLS1";

/// Seals `json` under `state_key`, then writes it atomically.
///
/// **There is no unsealed branch, and adding one back is the bug.** This used to fall back to
/// `json.to_vec()` when no key was supplied - inside the one function whose whole job is to encrypt
/// the thing - so a device whose keychain would not answer wrote every init key, every leaf HPKE
/// private key and every epoch secret to disk in cleartext and reported success. Refusing is the
/// point: a caller with no key has nowhere safe to put this, and "encryption is unavailable this
/// launch" is a recoverable state where "encryption happened, in cleartext" is not.
///
/// Reading a legacy plaintext file is still supported and still upgrades it in place - see
/// [`init_storage_from_parts`]. Only *producing* one is impossible.
///
/// Shared by [`MlsState::save_to_disk`] and that in-place upgrade, so the two cannot produce
/// different formats.
fn write_state_file(
    path: &std::path::Path,
    json: &[u8],
    state_key: Option<&[u8]>,
) -> Result<(), String> {
    let key = state_key.ok_or_else(|| {
        "MlsError: refusing to write mls_state.json without a state key - it holds this device's \
         leaf private keys and every epoch secret, and unsealed on disk is exactly how a device \
         backup carries them off the handset"
            .to_string()
    })?;
    let mut bytes = STATE_FILE_MAGIC.to_vec();
    bytes.extend_from_slice(&encrypt_blob(json, key)?);

    let tmp = path.with_extension("json.tmp");
    let written = (|| -> Result<(), String> {
        {
            let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut file, &bytes).map_err(|e| e.to_string())?;
            // Before the rename, not after: a rename that lands while the data is still in the page
            // cache can survive a power cut pointing at a file full of zeroes.
            file.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();

    if let Err(e) = written {
        // The temp file holds the same private keys the real one does, under a name nothing reads
        // and nothing else ever cleans up. Leaving it behind on a failed write is a second copy of
        // the state file that no longer has anyone watching it.
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // `sync_all` above orders the file's *bytes* before the rename. It says nothing about the
    // directory entry the rename creates, which can still be lost to a power cut - leaving either
    // the previous state file or no file at all, from a call that returned success. Unix only:
    // there is no portable equivalent on Windows.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// Tauri's managed state. Mobile's equivalent is a process-global `OnceLock<Mutex<MlsState>>`,
/// because Flutter has no `State`.
pub type MlsStateHandle = Mutex<MlsState>;

/// How many early messages one group may hold before the oldest is dropped.
///
/// Unbounded would let a peer that keeps sending from a future epoch grow this without limit. The
/// oldest goes first: by the time we catch up it is the one most likely to be past the ratchet's
/// reach anyway.
///
/// **The buffer is deliberately not persisted.** [`PersistedMlsState`] has no field for it and
/// gains none: the bytes are ciphertext the server still holds, so a process that dies with a full
/// buffer refetches rather than loses, while writing them out would put unread ciphertext in the
/// state file for no gain.
const MAX_BUFFERED_PER_GROUP: usize = 256;

/// A message that arrived before the commit that makes it readable.
#[derive(Clone)]
struct BufferedMessage {
    epoch: u64,
    message_id: Option<String>,
    bytes: Vec<u8>,
}

/// One buffered message that has since become readable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsReplayedMessage {
    /// The caller's id for it, when one was supplied at buffer time.
    pub message_id: Option<String>,
    pub plaintext: String,
    pub sender_identity: Option<String>,
    pub epoch: u64,
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

fn encrypt_blob(plaintext: &[u8], key_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| e.to_string())?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_blob(data: &[u8], key_bytes: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 {
        return Err("MlsError: encrypted blob too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|e| e.to_string())
}

fn decode_state_key(key_b64: &str) -> Result<Vec<u8>, String> {
    let key = B64
        .decode(key_b64)
        .map_err(|e| format!("MlsError: state key is not base64: {}", e))?;
    if key.len() != 32 {
        return Err(format!(
            "MlsError: state key must be 32 bytes, got {}",
            key.len()
        ));
    }
    Ok(key)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn build_signer_from_entry(entry: &SignerEntry) -> SignatureKeyPair {
    SignatureKeyPair::from_raw(
        SignatureScheme::ED25519,
        entry.priv_bytes.clone(),
        entry.pub_bytes.clone(),
    )
}

fn get_signer_entry<'a>(mls: &'a MlsState, key_handle: &str) -> Result<&'a SignerEntry, String> {
    mls.signers.get(key_handle).ok_or_else(|| {
        format!(
            "KeyNotFound: no signing key loaded for handle '{}'",
            key_handle
        )
    })
}

/// Prefixes the error with a kind the TypeScript side can branch on. Same vocabulary as mobile's,
/// because the two clients hit the same failures and a `WrongEpoch` has to mean "buffer and retry"
/// on both.
fn map_mls_error(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let lower = s.to_lowercase();
    if lower.contains("wrong epoch")
        || lower.contains("epoch mismatch")
        || lower.contains("wrongepoch")
    {
        format!("WrongEpoch: {}", s)
    } else if lower.contains("unknown sender")
        || lower.contains("invalid sender")
        || lower.contains("unknownsender")
    {
        format!("UnknownSender: {}", s)
    } else if lower.contains("validation") || lower.contains("invalid message") {
        format!("ValidationError: {}", s)
    } else if lower.contains("group not found") || lower.contains("no such group") {
        format!("GroupNotFound: {}", s)
    } else if lower.contains("key not found") || lower.contains("no key") {
        format!("KeyNotFound: {}", s)
    } else {
        format!("MlsError: {}", s)
    }
}

fn member_to_info(m: openmls::prelude::Member) -> MlsMemberInfo {
    let identity = BasicCredential::try_from(m.credential)
        .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
        .unwrap_or_default();
    MlsMemberInfo {
        leaf_index: m.index.u32(),
        identity,
        encryption_key: B64.encode(&m.encryption_key),
        signature_key: B64.encode(&m.signature_key),
    }
}

fn group_members(group: &MlsGroup) -> Vec<MlsMemberInfo> {
    group.members().map(member_to_info).collect()
}

fn build_group_info(group: &MlsGroup) -> MlsGroupInfo {
    MlsGroupInfo {
        group_id: B64.encode(group.group_id().as_slice()),
        epoch: group.epoch().as_u64(),
        own_leaf_index: group.own_leaf_index().u32(),
        members: group_members(group),
    }
}

/// `SenderRatchetConfiguration::new(out_of_order_tolerance, maximum_forward_distance)`.
///
/// **The argument order is the opposite of what it reads like**, and both clients had the two
/// literals transposed with comments asserting the reverse. Checked against
/// `openmls-0.8.1/src/tree/sender_ratchet.rs:40`, whose default is `(5, 1000)`:
///
/// * `out_of_order_tolerance` is how many *spent* decryption secrets are kept so a message that
///   arrives late can still be read. Every one of them is live key material sitting in the state
///   file, so this is the parameter that costs intra-epoch forward secrecy. 500 of them per sender
///   per epoch - which is what `new(500, 10)` actually configured - is ~100x the library default
///   for no benefit anybody asked for.
/// * `maximum_forward_distance` is how many generations may be *skipped*. The transposed value made
///   this 10, so the eleventh message read ahead of the app in one epoch - trivially reached by a
///   lock screen full of notifications - was rejected permanently, with no attacker involved.
///
/// venta-mobile pins the same two numbers and must mirror this exactly: a device that keeps fewer
/// secrets than its peers assume is a device that drops messages.
const OUT_OF_ORDER_TOLERANCE: u32 = 10;
const MAXIMUM_FORWARD_DISTANCE: u32 = 500;

fn ratchet_config() -> SenderRatchetConfiguration {
    SenderRatchetConfiguration::new(OUT_OF_ORDER_TOLERANCE, MAXIMUM_FORWARD_DISTANCE)
}

fn create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .sender_ratchet_configuration(ratchet_config())
        .use_ratchet_tree_extension(true)
        .build()
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .sender_ratchet_configuration(ratchet_config())
        .use_ratchet_tree_extension(true)
        .build()
}

fn serialize_welcome(welcome_msg: openmls::prelude::MlsMessageOut) -> Result<String, String> {
    welcome_msg
        .tls_serialize_detached()
        .map(|b| B64.encode(&b))
        .map_err(|e| e.to_string())
}

/// The GroupInfo openmls hands back with a commit - the one describing the epoch that commit
/// *establishes*. See [`MlsCommitOut::group_info`] for why it has to be this one and never an
/// exported one.
///
/// Wrapped in an `MlsMessageOut` on the way out, because that is the shape `rejoin_group` reads
/// back off the wire - openmls hands the commit's GroupInfo over as the bare struct.
fn serialize_group_info(
    group_info: Option<openmls::messages::group_info::GroupInfo>,
) -> Result<Option<String>, String> {
    group_info
        .map(|gi| {
            openmls::prelude::MlsMessageOut::from(gi)
                .tls_serialize_detached()
                .map(|b| B64.encode(&b))
                .map_err(|e| e.to_string())
        })
        .transpose()
}

// ---------------------------------------------------------------------------
// Operations
//
// Signatures mirror venta-mobile's exactly. The `String`-taking `*_impl` shims the tests and Tauri
// wrappers use are at the bottom of the file, so this section stays diffable against mobile.
// ---------------------------------------------------------------------------

pub fn load_signing_key(
    mls: &mut MlsState,
    signing_public_key_b64: &str,
    signing_private_key_b64: &str,
    identity: String,
) -> Result<String, String> {
    let pub_bytes = B64
        .decode(signing_public_key_b64)
        .map_err(|e| e.to_string())?;
    let priv_bytes = B64
        .decode(signing_private_key_b64)
        .map_err(|e| e.to_string())?;
    let handle = Uuid::new_v4().to_string();
    mls.signers.insert(
        handle.clone(),
        SignerEntry {
            pub_bytes,
            priv_bytes,
            identity,
        },
    );
    Ok(handle)
}

pub fn unload_signing_key(mls: &mut MlsState, key_handle: &str) -> Result<(), String> {
    mls.signers.remove(key_handle);
    Ok(())
}

pub fn generate_key_packages(
    mls: &mut MlsState,
    identity: String,
    count: u32,
) -> Result<MlsKeyPackageBatch, String> {
    let signer =
        SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(|e| e.to_string())?;
    let credential = BasicCredential::new(identity.clone().into_bytes());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    let mut key_packages = Vec::with_capacity(count as usize);
    {
        let provider = &mls.provider;
        for _ in 0..count {
            let bundle = KeyPackage::builder()
                .build(CIPHERSUITE, provider, &signer, credential_with_key.clone())
                .map_err(|e| e.to_string())?;
            let kp_bytes = bundle
                .key_package()
                .tls_serialize_detached()
                .map_err(|e| e.to_string())?;
            key_packages.push(KeyPackageResult {
                key_package: B64.encode(&kp_bytes),
                init_private_key: B64.encode(&**bundle.init_private_key()),
            });
        }
    }
    let pub_b64 = B64.encode(signer.public());
    let priv_b64 = B64.encode(signer.private());
    let handle = Uuid::new_v4().to_string();
    mls.signers.insert(
        handle.clone(),
        SignerEntry {
            pub_bytes: signer.public().to_vec(),
            priv_bytes: signer.private().to_vec(),
            identity,
        },
    );
    let batch = MlsKeyPackageBatch {
        signing_public_key: pub_b64,
        signing_private_key: priv_b64,
        key_packages,
        key_handle: handle,
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(batch)
}

pub fn generate_key_packages_with_handle(
    mls: &MlsState,
    key_handle: &str,
    count: u32,
) -> Result<Vec<KeyPackageResult>, String> {
    let (signer, identity) = {
        let entry = get_signer_entry(mls, key_handle)?;
        (build_signer_from_entry(entry), entry.identity.clone())
    };
    let credential = BasicCredential::new(identity.into_bytes());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    let mut key_packages = Vec::with_capacity(count as usize);
    {
        let provider = &mls.provider;
        for _ in 0..count {
            let bundle = KeyPackage::builder()
                .build(CIPHERSUITE, provider, &signer, credential_with_key.clone())
                .map_err(|e| e.to_string())?;
            let kp_bytes = bundle
                .key_package()
                .tls_serialize_detached()
                .map_err(|e| e.to_string())?;
            key_packages.push(KeyPackageResult {
                key_package: B64.encode(&kp_bytes),
                init_private_key: B64.encode(&**bundle.init_private_key()),
            });
        }
    }
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(key_packages)
}

pub fn create_group(
    mls: &mut MlsState,
    group_id_b64: &str,
    key_handle: &str,
) -> Result<MlsGroupInfo, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let group_id = GroupId::from_slice(&group_id_bytes);
    let (signer, identity) = {
        let entry = get_signer_entry(mls, key_handle)?;
        (build_signer_from_entry(entry), entry.identity.clone())
    };
    let credential = BasicCredential::new(identity.into_bytes());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    let group = {
        let MlsState { provider, .. } = &*mls;
        MlsGroup::new_with_group_id(
            provider,
            &signer,
            &create_config(),
            group_id,
            credential_with_key,
        )
        .map_err(map_mls_error)?
    };
    let info = build_group_info(&group);
    mls.groups.insert(group_id_bytes, group);
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(info)
}

pub fn add_members(
    mls: &mut MlsState,
    group_id_b64: &str,
    key_handle: &str,
    key_packages_b64: &[String],
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, key_handle)?;
        build_signer_from_entry(entry)
    };
    let key_packages: Vec<KeyPackage> = {
        let crypto = mls.provider.crypto();
        key_packages_b64
            .iter()
            .map(|kp_b64| {
                let kp_bytes = B64.decode(kp_b64).map_err(|e| e.to_string())?;
                let kp_in =
                    KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]).map_err(|e| e.to_string())?;
                kp_in
                    .validate(crypto, ProtocolVersion::Mls10)
                    .map_err(map_mls_error)
            })
            .collect::<Result<_, _>>()?
    };
    let commit_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let (commit_msg, welcome_msg, group_info) = group
            .add_members(provider, &signer, &key_packages)
            .map_err(map_mls_error)?;
        // Deliberately *not* merged here. The server accepts exactly one commit per epoch, so a
        // commit that loses that race must never have been applied locally - a group that advanced
        // on a commit nobody else has is forked, and MLS gives no way to walk that back. The caller
        // merges via `merge_pending_commit` once the server takes it, or discards via
        // `clear_pending_commit` when it does not.
        let epoch = group.epoch().as_u64() + 1;
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        let welcome_bytes = welcome_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        MlsCommitOut {
            commit: B64.encode(&commit_bytes),
            welcome: Some(B64.encode(&welcome_bytes)),
            epoch,
            group_info: serialize_group_info(group_info)?,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(commit_out)
}

pub fn join_group(
    mls: &mut MlsState,
    welcome_b64: &str,
    key_handle: &str,
) -> Result<MlsGroupInfo, String> {
    get_signer_entry(mls, key_handle)?;
    let welcome_bytes = B64.decode(welcome_b64).map_err(|e| e.to_string())?;
    let welcome_msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&welcome_bytes).map_err(|e| e.to_string())?;
    let welcome = match welcome_msg_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err("MlsError: message is not a Welcome".to_string()),
    };
    let group = {
        let MlsState { provider, .. } = &*mls;
        let staged = StagedWelcome::new_from_welcome(provider, &join_config(), welcome, None)
            .map_err(map_mls_error)?;
        staged.into_group(provider).map_err(map_mls_error)?
    };
    let info = build_group_info(&group);
    let group_id_bytes = group.group_id().as_slice().to_vec();
    mls.groups.insert(group_id_bytes, group);
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(info)
}

/// In MLS a member cannot commit their own removal, so this produces a Remove *proposal*. Callers
/// broadcast it so a remaining member can commit it via [`commit_pending_proposals`]. Local group
/// state is dropped immediately, so the leaver loses access whether or not anyone ever commits it.
pub fn leave_group(
    mls: &mut MlsState,
    group_id_b64: &str,
    key_handle: &str,
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, key_handle)?;
        build_signer_from_entry(entry)
    };
    let proposal_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let own_leaf = group.own_leaf_index();
        let (proposal_msg, _group_info) = group
            .propose_remove_member(provider, &signer, own_leaf)
            .map_err(map_mls_error)?;
        let proposal_bytes = proposal_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        groups.remove(&group_id_bytes);
        MlsCommitOut {
            commit: B64.encode(&proposal_bytes),
            welcome: None,
            epoch: 0,
            // A proposal establishes no epoch, so there is no GroupInfo to describe - and local
            // state is already gone by this point.
            group_info: None,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(proposal_out)
}

pub fn commit_pending_proposals(
    mls: &mut MlsState,
    group_id_b64: &str,
    key_handle: &str,
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, key_handle)?;
        build_signer_from_entry(entry)
    };
    let commit_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let (commit_msg, welcome_opt, group_info) = group
            .commit_to_pending_proposals(provider, &signer)
            .map_err(map_mls_error)?;
        // Staged, not merged - see add_members for why.
        let epoch = group.epoch().as_u64() + 1;
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        let welcome = welcome_opt.map(serialize_welcome).transpose()?;
        MlsCommitOut {
            commit: B64.encode(&commit_bytes),
            welcome,
            epoch,
            group_info: serialize_group_info(group_info)?,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(commit_out)
}

/// Second half of the two-phase commit dance: applies a staged commit once the server has accepted
/// it. Safe to retry - merging with nothing staged is a no-op, so a client that published and then
/// died can merge on next launch.
pub fn merge_pending_commit(mls: &mut MlsState, group_id_b64: &str) -> Result<u64, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let epoch = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        group.merge_pending_commit(provider).map_err(map_mls_error)?;
        group.epoch().as_u64()
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(epoch)
}

/// Discards a staged commit the server refused, leaving the group where it was. This is the losing
/// side of a concurrent-commit race; applying a commit the server did not take would fork this
/// device off the group permanently.
pub fn clear_pending_commit(mls: &mut MlsState, group_id_b64: &str) -> Result<(), String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        group
            .clear_pending_commit(provider.storage())
            .map_err(|e| e.to_string())?;
    }
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(())
}

pub fn export_group_info(
    mls: &MlsState,
    group_id_b64: &str,
    key_handle: &str,
) -> Result<String, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, key_handle)?;
        build_signer_from_entry(entry)
    };
    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
    let group_info_msg = group
        .export_group_info(mls.provider.crypto(), &signer, true)
        .map_err(|e| e.to_string())?;
    let bytes = group_info_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;
    Ok(B64.encode(&bytes))
}

pub fn rejoin_group(
    mls: &mut MlsState,
    group_info_b64: &str,
    key_handle: &str,
) -> Result<MlsRejoinOut, String> {
    let (signer, identity) = {
        let entry = get_signer_entry(mls, key_handle)?;
        (build_signer_from_entry(entry), entry.identity.clone())
    };
    let gi_bytes = B64.decode(group_info_b64).map_err(|e| e.to_string())?;
    let gi_msg = MlsMessageIn::tls_deserialize_exact_bytes(&gi_bytes).map_err(|e| e.to_string())?;
    let verifiable_group_info = match gi_msg.extract() {
        MlsMessageBodyIn::GroupInfo(vgi) => vgi,
        _ => return Err("MlsError: message is not a GroupInfo".to_string()),
    };
    let credential = BasicCredential::new(identity.into_bytes());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    let rejoin_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(join_config())
            .build_group(provider, verifiable_group_info, credential_with_key)
            .map_err(map_mls_error)?
            .load_psks(provider.storage())
            .map_err(map_mls_error)?
            .build(provider.rand(), provider.crypto(), &signer, |_| true)
            .map_err(map_mls_error)?
            .finalize(provider)
            .map_err(|e| e.to_string())?;
        let external_commit_bytes = bundle
            .into_commit()
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        let info = build_group_info(&group);
        let group_id_bytes = group.group_id().as_slice().to_vec();
        groups.insert(group_id_bytes, group);
        MlsRejoinOut {
            group_info: info,
            external_commit: B64.encode(&external_commit_bytes),
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(rejoin_out)
}

pub fn delete_group(mls: &mut MlsState, group_id_b64: &str) -> Result<(), String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    if mls.groups.remove(&group_id_bytes).is_none() {
        return Err("GroupNotFound: group not found".to_string());
    }
    mls.pending_messages.remove(&group_id_bytes);
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(())
}

pub fn send_message(
    mls: &mut MlsState,
    group_id_b64: &str,
    key_handle: &str,
    plaintext_b64: &str,
) -> Result<MlsSendOut, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let plaintext = B64.decode(plaintext_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, key_handle)?;
        build_signer_from_entry(entry)
    };
    let out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let msg_out = group
            .create_message(provider, &signer, &plaintext)
            .map_err(map_mls_error)?;
        let epoch = group.epoch().as_u64();
        let msg_bytes = msg_out
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        MlsSendOut {
            ciphertext: B64.encode(&msg_bytes),
            epoch,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(out)
}

pub fn process_message(
    mls: &mut MlsState,
    group_id_b64: &str,
    message_b64: &str,
    message_id: Option<String>,
) -> Result<MlsProcessedMessage, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let msg_bytes = B64.decode(message_b64).map_err(|e| e.to_string())?;
    let msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&msg_bytes).map_err(|e| e.to_string())?;
    let protocol_msg = msg_in
        .try_into_protocol_message()
        .map_err(|e| e.to_string())?;
    let message_epoch = protocol_msg.epoch().as_u64();

    // A message from an epoch we have not reached yet is early, not wrong. Dropping it loses it for
    // good - the wire copy decrypts exactly once - so it waits for the commit that makes it
    // readable and `drain_pending_messages` picks it up afterwards. `pending_messages` was
    // declared, retained and cleared but never actually written to, so this buffer did not exist
    // and an early message was simply gone.
    {
        let current_epoch = mls
            .groups
            .get(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?
            .epoch()
            .as_u64();

        if message_epoch > current_epoch {
            buffer_message(mls, &group_id_bytes, message_epoch, message_id, msg_bytes);
            mls.save_to_disk()
                .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
            return Ok(MlsProcessedMessage {
                kind: "buffered".into(),
                plaintext: None,
                self_removed: false,
                added_members: vec![],
                removed_leaf_indices: vec![],
                sender_identity: None,
                epoch: Some(message_epoch),
            });
        }
    }

    let processed_msg = {
        let MlsState {
            provider,
            groups,
            pending_messages,
            ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let processed = group
            .process_message(provider, protocol_msg)
            .map_err(map_mls_error)?;
        let sender_identity = BasicCredential::try_from(processed.credential().clone())
            .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
            .ok();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => MlsProcessedMessage {
                kind: "application".into(),
                plaintext: Some(B64.encode(app_msg.into_bytes())),
                self_removed: false,
                added_members: vec![],
                removed_leaf_indices: vec![],
                sender_identity,
                epoch: None,
            },
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                let self_removed = staged_commit.self_removed();
                let removed: Vec<u32> = staged_commit
                    .remove_proposals()
                    .map(|p| p.remove_proposal().removed().u32())
                    .collect();
                let added: Vec<MlsMemberInfo> = staged_commit
                    .add_proposals()
                    .map(|p| {
                        let kp = p.add_proposal().key_package();
                        let leaf = kp.leaf_node();
                        let identity = BasicCredential::try_from(leaf.credential().clone())
                            .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
                            .unwrap_or_default();
                        let enc_key = leaf
                            .encryption_key()
                            .tls_serialize_detached()
                            .map(|b| B64.encode(&b))
                            .unwrap_or_default();
                        MlsMemberInfo {
                            leaf_index: 0,
                            identity,
                            encryption_key: enc_key,
                            signature_key: B64.encode(leaf.signature_key().as_slice()),
                        }
                    })
                    .collect();
                group
                    .merge_staged_commit(provider, *staged_commit)
                    .map_err(|e| e.to_string())?;
                let epoch = group.epoch().as_u64();
                // `>=`, not `>`. Anything below where we now are can never be decrypted - the
                // ratchet only moves forward - but a message *at* the new epoch is exactly the one
                // this commit just made readable, and the old `>` threw away precisely those.
                if let Some(buf) = pending_messages.get_mut(&group_id_bytes) {
                    buf.retain(|m| m.epoch >= epoch);
                }
                MlsProcessedMessage {
                    kind: "commit".into(),
                    plaintext: None,
                    self_removed,
                    added_members: added,
                    removed_leaf_indices: removed,
                    sender_identity,
                    epoch: Some(epoch),
                }
            }
            ProcessedMessageContent::ProposalMessage(queued_proposal) => {
                group
                    .store_pending_proposal(provider.storage(), *queued_proposal)
                    .map_err(|e| e.to_string())?;
                MlsProcessedMessage {
                    kind: "proposal".into(),
                    plaintext: None,
                    self_removed: false,
                    added_members: vec![],
                    removed_leaf_indices: vec![],
                    sender_identity,
                    epoch: None,
                }
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(queued_proposal) => {
                group
                    .store_pending_proposal(provider.storage(), *queued_proposal)
                    .map_err(|e| e.to_string())?;
                MlsProcessedMessage {
                    kind: "proposal".into(),
                    plaintext: None,
                    self_removed: false,
                    added_members: vec![],
                    removed_leaf_indices: vec![],
                    sender_identity,
                    epoch: None,
                }
            }
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(processed_msg)
}

fn buffer_message(
    mls: &mut MlsState,
    group_id_bytes: &[u8],
    epoch: u64,
    message_id: Option<String>,
    bytes: Vec<u8>,
) {
    let buf = mls
        .pending_messages
        .entry(group_id_bytes.to_vec())
        .or_default();

    // The same message twice - a socket delivery racing a REST page - must not accumulate. Both
    // carry the same server-side id.
    if let Some(id) = &message_id {
        if buf.iter().any(|m| m.message_id.as_deref() == Some(id)) {
            return;
        }
    }

    if buf.len() >= MAX_BUFFERED_PER_GROUP {
        // Oldest first: by the time we catch up it is the one most likely to be past the ratchet's
        // reach anyway, so it is the cheapest to give up on.
        buf.remove(0);
    }

    buf.push(BufferedMessage {
        epoch,
        message_id,
        bytes,
    });
}

/// Replays every buffered message the group has now caught up to.
///
/// Call after applying commits. Messages still ahead of the group stay buffered; messages the
/// ratchet has moved past are dropped, because retrying them forever would be a permanent
/// background failure that never resolves.
pub fn drain_pending_messages(
    mls: &mut MlsState,
    group_id_b64: &str,
) -> Result<Vec<MlsReplayedMessage>, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;

    let Some(mut buffered) = mls.pending_messages.remove(&group_id_bytes) else {
        return Ok(vec![]);
    };
    buffered.sort_by_key(|m| m.epoch);

    let mut replayed = Vec::new();
    let mut still_pending = Vec::new();

    for message in buffered {
        let current_epoch = mls
            .groups
            .get(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?
            .epoch()
            .as_u64();

        if message.epoch > current_epoch {
            still_pending.push(message);
            continue;
        }

        let Ok(msg_in) = MlsMessageIn::tls_deserialize_exact_bytes(&message.bytes) else {
            continue;
        };
        let Ok(protocol_msg) = msg_in.try_into_protocol_message() else {
            continue;
        };

        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

        let Ok(processed) = group.process_message(provider, protocol_msg) else {
            // Past the ratchet's reach. Dropped rather than kept: it can never succeed, and keeping
            // it would be a failure that retries forever.
            continue;
        };

        let sender_identity = BasicCredential::try_from(processed.credential().clone())
            .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
            .ok();

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => {
                replayed.push(MlsReplayedMessage {
                    message_id: message.message_id,
                    plaintext: B64.encode(app_msg.into_bytes()),
                    sender_identity,
                    epoch: message.epoch,
                });
            }
            // Only application messages are ever buffered - commits arrive through the ordered
            // catch-up, which never runs ahead of the group.
            _ => continue,
        }
    }

    if !still_pending.is_empty() {
        mls.pending_messages.insert(group_id_bytes, still_pending);
    }

    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(replayed)
}

pub fn remove_members(
    mls: &mut MlsState,
    group_id_b64: &str,
    key_handle: &str,
    leaf_indices: &[u32],
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, key_handle)?;
        build_signer_from_entry(entry)
    };
    let members: Vec<LeafNodeIndex> = leaf_indices.iter().map(|i| LeafNodeIndex::new(*i)).collect();
    let commit_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let (commit_msg, welcome_opt, group_info) = group
            .remove_members(provider, &signer, &members)
            .map_err(map_mls_error)?;
        // Staged, not merged - see add_members for why.
        let epoch = group.epoch().as_u64() + 1;
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        let welcome = welcome_opt.map(serialize_welcome).transpose()?;
        MlsCommitOut {
            commit: B64.encode(&commit_bytes),
            welcome,
            epoch,
            group_info: serialize_group_info(group_info)?,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(commit_out)
}

/// Renders a fingerprint as five-character groups, which is what makes it readable aloud without
/// losing your place. Uppercase hex over the SHA-256 of the key, truncated to 80 bits.
///
/// `pub(crate)` for `crypto::device_cert`, which prints the same fingerprint over the same key -
/// the device key a payment handle is sealed to *is* the device's MLS signature key, so a user
/// comparing what the payments screen shows against what the join-request review shows is comparing
/// one string against itself. A second implementation would be a second string.
pub(crate) fn format_fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .take(10)
        .map(|b| format!("{:02X}", b))
        .collect::<String>()
        .as_bytes()
        .chunks(5)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// Fingerprint of the signing key already loaded under `key_handle`.
///
/// **Alpine-only.** Mobile's nearest equivalent, `fingerprint_for_signature_key`, takes the key
/// itself; this takes a session handle and never exposes the key to the caller.
/// `MlsJoinRequestService.ownFingerprint` depends on this shape, so it is kept rather than replaced.
///
/// Same value `inspect_key_package` reports for any key package this device mints - the leaf's
/// signature key *is* this key. Deriving it here matters because the alternative was generating a
/// key package purely to read its fingerprint and throwing the package away: key packages are
/// single-use and finite, so a screen that showed your own fingerprint would quietly drain the
/// device's supply and eventually leave it unaddable to any group.
pub fn signing_key_fingerprint(mls: &MlsState, key_handle: &str) -> Result<String, String> {
    let entry = get_signer_entry(mls, key_handle)?;
    Ok(format_fingerprint(&entry.pub_bytes))
}

/// Inspects a key package so a reviewer can check who it really belongs to before vouching for it,
/// and so the committing client can confirm the bytes match what was approved.
pub fn inspect_key_package(
    mls: &MlsState,
    key_package_b64: &str,
) -> Result<MlsKeyPackageInfo, String> {
    let kp_bytes = B64.decode(key_package_b64).map_err(|e| e.to_string())?;
    let kp_in = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]).map_err(|e| e.to_string())?;

    // Validated, not merely parsed. A reviewer must never be shown an identity lifted from a
    // malformed or expired package that would then be rejected at add time - or worse, be talked
    // into approving one whose signature does not actually check out.
    let key_package = kp_in
        .validate(mls.provider.crypto(), ProtocolVersion::Mls10)
        .map_err(map_mls_error)?;

    let leaf = key_package.leaf_node();
    let identity = BasicCredential::try_from(leaf.credential().clone())
        .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
        .unwrap_or_default();

    let signature_key = leaf.signature_key().as_slice().to_vec();

    Ok(MlsKeyPackageInfo {
        identity,
        signature_public_key: B64.encode(&signature_key),
        signature_key_fingerprint: format_fingerprint(&signature_key),
        key_package_hash: Sha256::digest(&kp_bytes)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect(),
    })
}

pub fn get_members(mls: &MlsState, group_id_b64: &str) -> Result<Vec<MlsMemberInfo>, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
    Ok(group_members(group))
}

pub fn get_group_info(mls: &MlsState, group_id_b64: &str) -> Result<MlsGroupInfo, String> {
    let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
    Ok(build_group_info(group))
}

/// Points the engine at `state_path` and restores whatever is there.
///
/// Returns `true` when state was restored, `false` when starting fresh.
///
/// The body of [`mls_init_storage`], with the `AppHandle` resolved away, so the crash-safety and
/// at-rest behaviour is reachable from tests. Needing a Tauri `AppHandle` is precisely why none of
/// this was covered, and why three defects accumulated in it.
///
/// Mobile's equivalent takes a directory plus a `read_only` flag; Alpine resolves the directory in
/// the command wrapper and has no second process to be read-only for.
pub(crate) fn init_storage_from_parts(
    mls: &mut MlsState,
    state_path: PathBuf,
    state_key_b64: Option<String>,
) -> Result<bool, String> {
    let state_key = state_key_b64.as_deref().map(decode_state_key).transpose()?;

    // Nothing this engine does can be persisted without one, so say so here rather than at
    // whichever group operation happens to save first - which would surface as a failed invite
    // rather than as "the keychain is not answering".
    //
    // The wording names the state key on purpose. The TypeScript side matches on it to tell "the
    // key is unavailable this launch" apart from "the state file is corrupt", and only the second
    // wipes the device's groups. Getting classified as the second here would be an irreversible
    // response to a transient fault.
    if state_key.is_none() {
        return Err(
            "MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so \
             encryption stays unavailable until the keychain produces one"
                .to_string(),
        );
    }

    // Already pointing here. Re-reading the file over live state would drop anything held in memory
    // and not yet saved.
    if mls.state_path.as_deref() == Some(state_path.as_path()) {
        return Ok(state_path.exists());
    }

    // Pointing somewhere new. Everything currently loaded belongs to whatever was here before - a
    // different account on this machine, in practice - and it has to go before this file's state
    // comes in.
    //
    // This used to be an insert into whatever was already in the provider, which merged two
    // accounts' key material into one store: the next save wrote account A's private keys into
    // account B's file. That is a confidentiality failure rather than a corruption one, so it is
    // cleared unconditionally, including the signers - a handle minted for the previous account
    // must not stay usable against this one's groups.
    mls.groups.clear();
    mls.pending_messages.clear();
    mls.signers.clear();
    mls.provider.storage().values.write().unwrap().clear();

    mls.state_key = state_key;
    mls.state_path = Some(state_path.clone());

    if !state_path.exists() {
        return Ok(false);
    }

    let raw = std::fs::read(&state_path).map_err(|e| e.to_string())?;
    let sealed = raw.starts_with(STATE_FILE_MAGIC);
    let json = if sealed {
        let key = mls.state_key.as_ref().ok_or_else(|| {
            "MlsError: mls_state.json is sealed but no state key was supplied - the keychain entry \
             that opens it is missing"
                .to_string()
        })?;
        decrypt_blob(&raw[STATE_FILE_MAGIC.len()..], key).map_err(|e| {
            format!(
                "MlsError: mls_state.json did not open with this device's state key: {}",
                e
            )
        })?
    } else {
        raw
    };
    let persisted: PersistedMlsState = serde_json::from_slice(&json).map_err(|e| e.to_string())?;

    // An install that predates the sealed format. Rewriting it now is the whole migration: the
    // plaintext copy is what an OS-level backup would have carried, so it should not survive the
    // first launch that can replace it. Best-effort because a failure here must not cost the user
    // their groups - the next save tries again.
    if !sealed {
        if let Err(e) = write_state_file(&state_path, &json, mls.state_key.as_deref()) {
            eprintln!("MlsError: could not seal the existing state file: {}", e);
        }
    }

    {
        let mut values = mls.provider.storage().values.write().unwrap();
        for (k_b64, v_b64) in &persisted.storage {
            let k = B64.decode(k_b64).map_err(|e| e.to_string())?;
            let v = B64.decode(v_b64).map_err(|e| e.to_string())?;
            values.insert(k, v);
        }
    }

    for group_id_b64 in &persisted.group_ids {
        let group_id_bytes = B64.decode(group_id_b64).map_err(|e| e.to_string())?;
        let group_id = GroupId::from_slice(&group_id_bytes);
        match MlsGroup::load(mls.provider.storage(), &group_id) {
            Ok(Some(group)) => {
                mls.groups.insert(group_id_bytes, group);
            }
            Ok(None) => {
                return Err(format!(
                    "MlsError: group {} is listed in state but its data is missing from storage - state may be corrupted",
                    group_id_b64
                ));
            }
            Err(e) => {
                return Err(format!(
                    "MlsError: failed to load group {} from storage: {}",
                    group_id_b64, e
                ));
            }
        }
    }

    Ok(true)
}

pub fn clear_storage(mls: &mut MlsState) -> Result<(), String> {
    if let Some(path) = &mls.state_path {
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("MlsError: failed to remove state file: {}", e))?;
        }
    }
    mls.groups.clear();
    mls.pending_messages.clear();
    mls.provider.storage().values.write().unwrap().clear();
    Ok(())
}

pub fn export_state(mls: &MlsState, encryption_key_b64: &str) -> Result<String, String> {
    let persisted = mls.to_persisted();
    let json = serde_json::to_vec(&persisted).map_err(|e| e.to_string())?;
    let key_bytes = B64.decode(encryption_key_b64).map_err(|e| e.to_string())?;
    let encrypted = encrypt_blob(&json, &key_bytes)?;
    Ok(B64.encode(&encrypted))
}

pub fn import_state(
    mls: &mut MlsState,
    encrypted_b64: &str,
    encryption_key_b64: &str,
) -> Result<(), String> {
    let encrypted = B64.decode(encrypted_b64).map_err(|e| e.to_string())?;
    let key_bytes = B64.decode(encryption_key_b64).map_err(|e| e.to_string())?;
    let json = decrypt_blob(&encrypted, &key_bytes)?;
    let persisted: PersistedMlsState = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    restore_persisted(mls, persisted)?;
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(())
}

/// Replaces the provider store and group set with `persisted`. Shared by [`import_state`], the §D
/// backup import and the cross-client golden vectors, so none of them can drift apart.
fn restore_persisted(mls: &mut MlsState, persisted: PersistedMlsState) -> Result<(), String> {
    let decoded_storage: Vec<(Vec<u8>, Vec<u8>)> = persisted
        .storage
        .iter()
        .map(|(k, v)| {
            let k = B64.decode(k).map_err(|e| e.to_string())?;
            let v = B64.decode(v).map_err(|e| e.to_string())?;
            Ok((k, v))
        })
        .collect::<Result<_, String>>()?;
    let decoded_group_ids: Vec<Vec<u8>> = persisted
        .group_ids
        .iter()
        .map(|g| B64.decode(g).map_err(|e| e.to_string()))
        .collect::<Result<_, String>>()?;
    mls.groups.clear();
    mls.pending_messages.clear();
    {
        let mut values = mls.provider.storage().values.write().unwrap();
        values.clear();
        for (k, v) in decoded_storage {
            values.insert(k, v);
        }
    }
    for group_id_bytes in decoded_group_ids {
        let group_id = GroupId::from_slice(&group_id_bytes);
        if let Ok(Some(group)) = MlsGroup::load(mls.provider.storage(), &group_id) {
            mls.groups.insert(group_id_bytes, group);
        }
    }
    Ok(())
}

/// The directory the engine currently persists to, if any.
///
/// Exists so a caller can tell "this engine is loaded for the account I mean" from "initialising
/// here would swap the whole engine out from under the running session". Since
/// [`init_storage_from_parts`] now *clears* on a path change - it has to, or two accounts' key
/// material ends up in one store - initialising blindly is no longer free.
pub fn current_state_dir(mls: &MlsState) -> Option<String> {
    mls.state_path
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Backup envelope (contract §D)
//
// Byte-for-byte identical to venta-mobile's. The whole point is that a `.venta-keys` file written
// on one client opens on the other, so every constant below is wire format: changing one here
// without changing it there makes the two mutually unreadable, silently, until someone actually
// needs a restore.
// ---------------------------------------------------------------------------

const BACKUP_VERSION: u32 = 1;
const BACKUP_AAD_PREFIX: &str = "venta.keybackup.v1";
const ARGON2_M_KIB: u32 = 65536;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 4;

// Ceilings on the KDF parameters a *blob header* may declare (§L.9).
//
// Both formats here are deliberately self-describing - the reader derives from the declared
// parameters, never from the write-side constants, because that is the only way a blob written
// under one parameter set stays openable by a build compiled with another. The cost is that the
// header is attacker-controlled, and `m` is a u32 of kibibytes: 4 TiB, allocated eagerly, on the
// recovery path.
//
// These are not a security boundary. Weak parameters do not make a stolen blob crackable - the
// attacker would need our ciphertext *and* would have to make us read their header, and the
// wrapping still fails closed. This is denial of service only, so the ceilings are set well above
// anything either client writes (64 MiB / t=3 / p=4) and well below anything that hangs a machine.
const KDF_MAX_MEMORY_KIB: u32 = 1024 * 1024; // 1 GiB
const KDF_MAX_ITERATIONS: u32 = 10;
const KDF_MAX_PARALLELISM: u32 = 16;

/// Rejects a declared KDF header before it is handed to Argon2.
///
/// Deliberately an error rather than a clamp: silently deriving with parameters other than the ones
/// declared produces the wrong key and reports it as a wrong passphrase, which is the single worst
/// diagnostic to give someone mid-recovery.
fn check_kdf_parameters(memory_kib: u32, iterations: u32, parallelism: u32) -> Result<(), String> {
    if memory_kib > KDF_MAX_MEMORY_KIB
        || iterations > KDF_MAX_ITERATIONS
        || parallelism > KDF_MAX_PARALLELISM
    {
        return Err(format!(
            "MlsError: refusing declared Argon2 parameters (m={} KiB, t={}, p={}) - above the \
             m<={} KiB, t<={}, p<={} this build will attempt",
            memory_kib,
            iterations,
            parallelism,
            KDF_MAX_MEMORY_KIB,
            KDF_MAX_ITERATIONS,
            KDF_MAX_PARALLELISM
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct BackupKdf {
    alg: String,
    salt: String,
    m: u32,
    t: u32,
    p: u32,
}

#[derive(Serialize, Deserialize)]
struct BackupEnvelope {
    v: u32,
    kdf: BackupKdf,
    aead: String,
    nonce: String,
    aad: String,
    ct: String,
}

struct BackupSigning {
    pub_: String,
    priv_: String,
    identity: String,
}

// `pub` and `priv` are Rust keywords, so the field names are mangled and mapped back here. The wire
// names are what the contract fixes; venta-mobile writes exactly these.
impl BackupSigning {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "pub": self.pub_, "priv": self.priv_, "identity": self.identity })
    }

    fn from_json(value: &serde_json::Value) -> Result<Self, String> {
        let field = |name: &str| -> Result<String, String> {
            value
                .get(name)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("MlsError: backup signing block has no '{}'", name))
        };
        Ok(Self {
            pub_: field("pub")?,
            priv_: field("priv")?,
            identity: field("identity")?,
        })
    }
}

/// What `mls_import_backup` hands back once the §D envelope has been opened and applied.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MlsBackupImportResult {
    pub user_id: String,
    /// The device the backup was taken on - not necessarily this one.
    pub device_id: String,
    pub created_at: String,
    pub app_version: String,
    pub identity: String,
    /// Session handle for the restored signing key, immediately usable.
    pub key_handle: String,
    /// The restored signing keypair.
    ///
    /// Handed back because the caller keeps this pair in the OS keychain, not in the engine's
    /// store - unlock reads it from there on every cold start, so a restore that only loaded it
    /// into memory would work until the app was next killed and then look exactly like lost keys.
    /// It is the same secret the caller has already supplied a passphrase to open, so nothing is
    /// exposed that the caller did not already hold.
    pub signing_public_key: String,
    pub signing_private_key: String,
    /// False on a new device, where cloning the ratchet state would be unsafe.
    pub engine_restored: bool,
    pub group_registry: HashMap<String, serde_json::Value>,
    pub message_cache: HashMap<String, String>,
    /// The account identity key (§H.2), when the envelope carried one.
    ///
    /// Read so a blob written by venta-mobile round-trips intact. Alpine does not yet mint one -
    /// §H is not ported here - so these are `None` on anything this client wrote.
    pub account_identity_public_key: Option<String>,
    pub account_identity_private_key: Option<String>,
}

fn derive_backup_key(passphrase: &str, salt: &[u8]) -> Result<Vec<u8>, String> {
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(32))
        .map_err(|e| format!("MlsError: bad Argon2 parameters: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = vec![0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("MlsError: key derivation failed: {}", e))?;
    Ok(key)
}

fn backup_aad(user_id: &str, device_id: &str) -> String {
    format!("{}|{}|{}", BACKUP_AAD_PREFIX, user_id, device_id)
}

/// The §H account identity keypair, when the caller holds one.
///
/// <p>Alpine does not mint these - §H is not ported here - but it can now be <i>holding</i> one: an
/// envelope written by venta-mobile carries it, `import_backup` has always read it back out, and
/// nothing stored it. Re-exporting on Alpine therefore destroyed it. Round-tripping a key this
/// client cannot itself produce is the whole point of carrying it.</p>
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupAccountIdentity {
    #[serde(rename = "pub")]
    pub pub_: String,
    #[serde(rename = "priv")]
    pub priv_: String,
}

#[allow(clippy::too_many_arguments)]
pub fn export_backup(
    mls: &MlsState,
    passphrase: String,
    user_id: String,
    device_id: String,
    app_version: String,
    key_handle: String,
    group_registry: HashMap<String, serde_json::Value>,
    message_cache: Option<HashMap<String, String>>,
    account_identity: Option<BackupAccountIdentity>,
) -> Result<String, String> {
    if passphrase.is_empty() {
        return Err("MlsError: a backup passphrase is required".to_string());
    }

    let entry = get_signer_entry(mls, &key_handle)?;
    let signing = BackupSigning {
        pub_: B64.encode(&entry.pub_bytes),
        priv_: B64.encode(&entry.priv_bytes),
        identity: entry.identity.clone(),
    };

    let mut payload = serde_json::json!({
        "userId": user_id,
        "deviceId": device_id,
        "createdAt": current_iso8601(),
        "appVersion": app_version,
        // Read by the import path, not by a human: cloning ratchet state onto a second
        // concurrently-live device reuses generations, which openmls treats as a replay, and voids
        // forward secrecy for that leaf.
        "engineRestore": "same-device-only",
        "signing": signing.to_json(),
        "engine": mls.to_persisted(),
        "groupRegistry": group_registry,
        "messageCache": message_cache.unwrap_or_default(),
    });

    // Written only when there is one. An `accountIdentity` present but null or empty is worse than
    // absent: mobile's import reads the field, and a half-formed one turns "this backup has no
    // account identity key" into "this backup's account identity key is unusable".
    if let Some(identity) = account_identity {
        payload["accountIdentity"] = serde_json::json!({
            "pub": identity.pub_,
            "priv": identity.priv_,
        });
    }

    let plaintext = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_backup_key(&passphrase, &salt)?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let aad = backup_aad(&user_id, &device_id);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| e.to_string())?;

    let envelope = BackupEnvelope {
        v: BACKUP_VERSION,
        kdf: BackupKdf {
            alg: "argon2id".to_string(),
            salt: B64.encode(salt),
            m: ARGON2_M_KIB,
            t: ARGON2_T,
            p: ARGON2_P,
        },
        aead: "AES-256-GCM".to_string(),
        nonce: B64.encode(nonce_bytes),
        aad,
        ct: B64.encode(&ciphertext),
    };

    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

pub fn import_backup(
    mls: &mut MlsState,
    blob: String,
    passphrase: String,
    expected_user_id: String,
    current_device_id: String,
) -> Result<MlsBackupImportResult, String> {
    let envelope: BackupEnvelope =
        serde_json::from_str(&blob).map_err(|e| format!("MlsError: not a backup file: {}", e))?;

    // Split, because the remedies are opposites and only one of them is "update". Collapsed into
    // one message, the UI told a user holding a *older* file to update the app - advice that makes
    // their situation strictly worse if they act on it, and that cannot work either way.
    if envelope.v > BACKUP_VERSION {
        return Err(format!(
            "MlsError: backup version {} is newer than this build supports",
            envelope.v
        ));
    }
    if envelope.v < BACKUP_VERSION {
        return Err(format!(
            "MlsError: backup version {} is older than this build supports",
            envelope.v
        ));
    }
    if envelope.aead != "AES-256-GCM" || envelope.kdf.alg != "argon2id" {
        return Err("MlsError: unsupported backup cipher or key derivation".to_string());
    }

    let salt = B64.decode(&envelope.kdf.salt).map_err(|e| e.to_string())?;
    let nonce = B64.decode(&envelope.nonce).map_err(|e| e.to_string())?;
    let ciphertext = B64.decode(&envelope.ct).map_err(|e| e.to_string())?;
    if nonce.len() != 12 {
        return Err("MlsError: backup nonce is not 12 bytes".to_string());
    }

    check_kdf_parameters(envelope.kdf.m, envelope.kdf.t, envelope.kdf.p)?;
    let params = Params::new(envelope.kdf.m, envelope.kdf.t, envelope.kdf.p, Some(32))
        .map_err(|e| format!("MlsError: bad Argon2 parameters: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = vec![0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|e| format!("MlsError: key derivation failed: {}", e))?;

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                // Binding the envelope's own aad means a blob re-labelled for another account or
                // device fails to open rather than opening and being wrong.
                aad: envelope.aad.as_bytes(),
            },
        )
        .map_err(|_| {
            "MlsError: could not open the backup - wrong passphrase, or the file has been altered"
                .to_string()
        })?;

    let payload: serde_json::Value =
        serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;

    let string_field = |name: &str| -> Result<String, String> {
        payload
            .get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("MlsError: backup has no '{}'", name))
    };

    let user_id = string_field("userId")?;
    let device_id = string_field("deviceId")?;

    // Refused, not merged. A backup carries another account's private keys and its group registry;
    // importing it over the signed-in account would leave this device signing as one identity while
    // holding leaves issued to another.
    if user_id != expected_user_id {
        return Err(format!(
            "MlsError: this backup belongs to a different account ({}), not the one signed in",
            user_id
        ));
    }
    if envelope.aad != backup_aad(&user_id, &device_id) {
        return Err("MlsError: backup header does not match its contents".to_string());
    }

    let signing = BackupSigning::from_json(
        payload
            .get("signing")
            .ok_or_else(|| "MlsError: backup has no signing key".to_string())?,
    )?;

    // The one rule that cannot be left to documentation. Two devices sharing a leaf derive the same
    // sender-ratchet keys, so at least one of them becomes unable to send, forward secrecy for that
    // leaf is gone, and an Update from one leaves the other holding keys the group thinks were
    // rotated. Same-device recovery adopts the backup's device id first, which is required anyway -
    // the keychain entries are named after it.
    let engine_restored = device_id == current_device_id;

    // Parsed before anything is touched, so a malformed engine section fails while the live state
    // is still whole. `restore_persisted` clears `groups`, `pending_messages` and the entire
    // provider store before it re-inserts, so reaching it and then failing is not a no-op - it is
    // the running session's group state, gone.
    let persisted: Option<PersistedMlsState> = if engine_restored {
        match payload.get("engine") {
            Some(engine) => Some(
                serde_json::from_value(engine.clone())
                    .map_err(|e| format!("MlsError: backup engine state is unreadable: {}", e))?,
            ),
            None => None,
        }
    } else {
        None
    };

    // Ordered deliberately: every fallible step runs *before* the destructive one.
    //
    // `load_signing_key` base64-decodes two keys and can fail; it used to run after
    // `restore_persisted`, so a blob carrying a good engine and a corrupt signing key wiped the
    // live engine, replaced it with the backup's groups, and *then* returned an error - leaving the
    // session holding foreign state that no caller had been told was applied, and that the next
    // save would write to disk. Loading the signer first is additive (one entry in `signers`,
    // keyed by a fresh handle, which `restore_persisted` does not clear) and cannot destroy
    // anything if the engine restore later fails.
    let key_handle = load_signing_key(
        mls,
        &signing.pub_,
        &signing.priv_,
        signing.identity.clone(),
    )?;

    if let Some(persisted) = persisted {
        restore_persisted(mls, persisted)?;
    }

    let group_registry = payload
        .get("groupRegistry")
        .and_then(|v| v.as_object())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    let message_cache = payload
        .get("messageCache")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let account_identity = payload.get("accountIdentity");
    let account_field = |name: &str| -> Option<String> {
        account_identity
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;

    Ok(MlsBackupImportResult {
        user_id,
        device_id,
        created_at: payload
            .get("createdAt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        app_version: payload
            .get("appVersion")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        identity: signing.identity,
        key_handle,
        signing_public_key: signing.pub_,
        signing_private_key: signing.priv_,
        engine_restored,
        group_registry,
        message_cache,
        account_identity_public_key: account_field("pub"),
        account_identity_private_key: account_field("priv"),
    })
}

/// Seconds-precision UTC, without pulling `chrono` in for one timestamp.
fn current_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let days = now / 86_400;
    let secs_of_day = now % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Howard Hinnant's days-from-civil, inverted. Exact for the whole proleptic Gregorian range.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------------------
// `String` shims - test-only
//
// The engine above takes `&str` and `&[T]`, matching venta-mobile exactly, because keeping the two
// diffable is what stops the next re-port being a merge. Alpine's integration tests were written
// against the previous `String`-taking `*_impl` names, and they are the evidence that this port
// changed no behaviour - so they are called unchanged and these adapt the signatures for them.
//
// `#[cfg(test)]` because the Tauri wrappers below take the owned values Tauri hands them and pass
// borrows straight to the engine; nothing in a release build goes through here. Do not put logic in
// this module - a shim that did something would be behaviour the tests cover and the app does not.
// ---------------------------------------------------------------------------

#[cfg(test)]
#[rustfmt::skip]
mod shims {
    use super::*;

    pub(super) fn load_signing_key_impl(m: &mut MlsState, a: String, b: String, i: String) -> Result<String, String> { load_signing_key(m, &a, &b, i) }
    pub(super) fn unload_signing_key_impl(m: &mut MlsState, h: String) -> Result<(), String> { unload_signing_key(m, &h) }
    pub(super) fn generate_key_packages_impl(m: &mut MlsState, i: String, c: u32) -> Result<MlsKeyPackageBatch, String> { generate_key_packages(m, i, c) }
    pub(super) fn generate_key_packages_with_handle_impl(m: &MlsState, h: String, c: u32) -> Result<Vec<KeyPackageResult>, String> { generate_key_packages_with_handle(m, &h, c) }
    pub(super) fn create_group_impl(m: &mut MlsState, g: String, h: String) -> Result<MlsGroupInfo, String> { create_group(m, &g, &h) }
    pub(super) fn add_members_impl(m: &mut MlsState, g: String, h: String, k: Vec<String>) -> Result<MlsCommitOut, String> { add_members(m, &g, &h, &k) }
    pub(super) fn join_group_impl(m: &mut MlsState, w: String, h: String) -> Result<MlsGroupInfo, String> { join_group(m, &w, &h) }
    pub(super) fn leave_group_impl(m: &mut MlsState, g: String, h: String) -> Result<MlsCommitOut, String> { leave_group(m, &g, &h) }
    pub(super) fn commit_pending_proposals_impl(m: &mut MlsState, g: String, h: String) -> Result<MlsCommitOut, String> { commit_pending_proposals(m, &g, &h) }
    pub(super) fn merge_pending_commit_impl(m: &mut MlsState, g: String) -> Result<u64, String> { merge_pending_commit(m, &g) }
    pub(super) fn clear_pending_commit_impl(m: &mut MlsState, g: String) -> Result<(), String> { clear_pending_commit(m, &g) }
    pub(super) fn export_group_info_impl(m: &MlsState, g: String, h: String) -> Result<String, String> { export_group_info(m, &g, &h) }
    pub(super) fn rejoin_group_impl(m: &mut MlsState, g: String, h: String) -> Result<MlsRejoinOut, String> { rejoin_group(m, &g, &h) }
    pub(super) fn delete_group_impl(m: &mut MlsState, g: String) -> Result<(), String> { delete_group(m, &g) }
    pub(super) fn send_message_impl(m: &mut MlsState, g: String, h: String, p: String) -> Result<MlsSendOut, String> { send_message(m, &g, &h, &p) }
    pub(super) fn remove_members_impl(m: &mut MlsState, g: String, h: String, l: Vec<u32>) -> Result<MlsCommitOut, String> { remove_members(m, &g, &h, &l) }
    pub(super) fn signing_key_fingerprint_impl(m: &MlsState, h: String) -> Result<String, String> { signing_key_fingerprint(m, &h) }
    pub(super) fn inspect_key_package_impl(m: &MlsState, k: String) -> Result<MlsKeyPackageInfo, String> { inspect_key_package(m, &k) }
    pub(super) fn get_members_impl(m: &MlsState, g: String) -> Result<Vec<MlsMemberInfo>, String> { get_members(m, &g) }
    pub(super) fn get_group_info_impl(m: &MlsState, g: String) -> Result<MlsGroupInfo, String> { get_group_info(m, &g) }
    pub(super) fn export_state_impl(m: &MlsState, k: String) -> Result<String, String> { export_state(m, &k) }
    pub(super) fn import_state_impl(m: &mut MlsState, e: String, k: String) -> Result<(), String> { import_state(m, &e, &k) }

    /// The one shim that is not a pure re-borrow. Mobile's `process_message` takes a caller-supplied
    /// message id, which it stores on the buffered copy so `drain_pending_messages` can hand the id
    /// back with the plaintext. The tests predate that argument and pass three; `None` there means
    /// "no id was supplied", which is exactly what an untagged replay reports. The Tauri wrapper
    /// takes the id, because the TypeScript caller has always passed one.
    pub(super) fn process_message_impl(m: &mut MlsState, g: String, b: String) -> Result<MlsProcessedMessage, String> { process_message(m, &g, &b, None) }
}

#[cfg(test)]
use shims::*;

// ---------------------------------------------------------------------------
// Tauri commands - thin wrappers around the engine above
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mls_load_signing_key(
    state: tauri::State<MlsStateHandle>,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    identity: String,
) -> Result<String, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    load_signing_key(
        &mut mls,
        &signing_public_key_b64,
        &signing_private_key_b64,
        identity,
    )
}

#[tauri::command]
pub fn mls_unload_signing_key(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    unload_signing_key(&mut mls, &key_handle)
}

#[tauri::command]
pub fn generate_mls_key_packages(
    state: tauri::State<MlsStateHandle>,
    identity: String,
    count: u32,
) -> Result<MlsKeyPackageBatch, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    generate_key_packages(&mut mls, identity, count)
}

#[tauri::command]
pub fn mls_generate_key_packages_with_handle(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
    count: u32,
) -> Result<Vec<KeyPackageResult>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    generate_key_packages_with_handle(&mls, &key_handle, count)
}

#[tauri::command]
pub fn mls_create_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    create_group(&mut mls, &group_id_b64, &key_handle)
}

#[tauri::command]
pub fn mls_add_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    key_packages_b64: Vec<String>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    add_members(&mut mls, &group_id_b64, &key_handle, &key_packages_b64)
}

#[tauri::command]
pub fn mls_join_group(
    state: tauri::State<MlsStateHandle>,
    welcome_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    join_group(&mut mls, &welcome_b64, &key_handle)
}

#[tauri::command]
pub fn mls_leave_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    leave_group(&mut mls, &group_id_b64, &key_handle)
}

/// Commit all pending proposals for a group (e.g. a leave proposal from a departing member).
///
/// Returns a commit that must be broadcast to all remaining members.
#[tauri::command]
pub fn mls_commit_pending_proposals(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    commit_pending_proposals(&mut mls, &group_id_b64, &key_handle)
}

/// This device's own identity fingerprint, for reading out to whoever is reviewing its admission.
#[tauri::command]
pub fn mls_signing_key_fingerprint(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    signing_key_fingerprint(&mls, &key_handle)
}

/// Inspects a key package so a reviewer can check who it really belongs to before vouching for it,
/// and so the committing client can confirm the bytes match what was approved.
#[tauri::command]
pub fn mls_inspect_key_package(
    state: tauri::State<MlsStateHandle>,
    key_package_b64: String,
) -> Result<MlsKeyPackageInfo, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    inspect_key_package(&mls, &key_package_b64)
}

/// Applies a commit staged by add/remove/commit-proposals, once the server has accepted it.
/// Returns the group's epoch afterwards.
#[tauri::command]
pub fn mls_merge_pending_commit(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<u64, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    merge_pending_commit(&mut mls, &group_id_b64)
}

/// Discards a staged commit the server refused, leaving the group exactly where it was.
#[tauri::command]
pub fn mls_clear_pending_commit(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    clear_pending_commit(&mut mls, &group_id_b64)
}

#[tauri::command]
pub fn mls_export_group_info(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    export_group_info(&mls, &group_id_b64, &key_handle)
}

#[tauri::command]
pub fn mls_rejoin_group(
    state: tauri::State<MlsStateHandle>,
    group_info_b64: String,
    key_handle: String,
) -> Result<MlsRejoinOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    rejoin_group(&mut mls, &group_info_b64, &key_handle)
}

#[tauri::command]
pub fn mls_delete_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    delete_group(&mut mls, &group_id_b64)
}

#[tauri::command]
pub fn mls_send_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    plaintext_b64: String,
) -> Result<MlsSendOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    send_message(&mut mls, &group_id_b64, &key_handle, &plaintext_b64)
}

/// Processes one incoming MLS message.
///
/// `message_id` is the caller's id for it. A message from an epoch this device has not reached yet
/// is buffered rather than refused, and the id is what lets `mls_drain_pending_messages` hand the
/// plaintext back against the right row once the commit arrives.
#[tauri::command]
pub fn mls_process_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    message_b64: String,
    message_id: Option<String>,
) -> Result<MlsProcessedMessage, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    process_message(&mut mls, &group_id_b64, &message_b64, message_id)
}

/// Replays every buffered message the group has now caught up to. Usually empty.
#[tauri::command]
pub fn mls_drain_pending_messages(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<Vec<MlsReplayedMessage>, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    drain_pending_messages(&mut mls, &group_id_b64)
}

#[tauri::command]
pub fn mls_remove_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    leaf_indices: Vec<u32>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    remove_members(&mut mls, &group_id_b64, &key_handle, &leaf_indices)
}

#[tauri::command]
pub fn mls_get_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<Vec<MlsMemberInfo>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    get_members(&mls, &group_id_b64)
}

#[tauri::command]
pub fn mls_get_group_info(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<MlsGroupInfo, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    get_group_info(&mls, &group_id_b64)
}

/// Points the engine at its state file and restores whatever is in it.
///
/// `state_key_b64` is a 32-byte AES key the TypeScript layer keeps in the OS keychain. It is what
/// makes the state file - every init key, leaf HPKE private key and epoch secret this device
/// holds - useless to anyone reading the disk, an OS-level backup, or a restored device image.
/// A legacy plaintext file is accepted once and immediately rewritten sealed, because refusing it
/// would strand every device that predates this.
///
/// `scope` is the account's device id, and it names the file: `mls_state_{scope}.json`. Two
/// accounts on one machine held one `mls_state.json` between them before it existed, which
/// `init_storage_from_parts` was already written to survive - it clears everything when the path
/// changes - but only because the *path* changing is what tells it the account did.
#[tauri::command]
pub fn mls_init_storage(
    state: tauri::State<MlsStateHandle>,
    app: tauri::AppHandle,
    state_key_b64: Option<String>,
    scope: Option<String>,
    adopt_legacy: Option<bool>,
) -> Result<bool, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let state_path = data_dir.join(state_file_name(scope.as_deref()));

    if adopt_legacy.unwrap_or(false) {
        adopt_legacy_state_file(&data_dir.join("mls_state.json"), &state_path)?;
    }

    let mut mls = state.lock().map_err(|e| e.to_string())?;
    init_storage_from_parts(&mut mls, state_path, state_key_b64)
}

/// Moves the pre-scope state file under the name the account that owns it now resolves to.
///
/// <p>Called only for the one slot that inherited the pre-scope device id - the keychain entries
/// and the state key are named after it, so no other account could open this file anyway. Without
/// the move that slot starts on an empty engine and presents to the user as this device having been
/// ejected from every group it belongs to.</p>
///
/// <p>Refuses to overwrite. A scoped file that already exists is this account's real state, and a
/// stale legacy file left over from before the upgrade must not replace it.</p>
fn adopt_legacy_state_file(legacy: &std::path::Path, scoped: &std::path::Path) -> Result<(), String> {
    if scoped == legacy || scoped.exists() || !legacy.exists() {
        return Ok(());
    }
    std::fs::rename(legacy, scoped).map_err(|e| {
        format!(
            "MlsError: could not adopt the existing state file - this account's groups are in {} \
             and could not be moved to {}: {}",
            legacy.display(),
            scoped.display(),
            e
        )
    })
}

/// The state file for an account, or the pre-scope name when there is none.
///
/// <p>The unscoped fallback is not dead code: it is what a caller that has not yet resolved an
/// account slot gets, and it is the file every installation predating per-account scoping already
/// has on disk. `DeviceIdentityService` hands the first slot that pre-scope device id, so the
/// scoped name that slot resolves to is the one the migration renames this file to.</p>
fn state_file_name(scope: Option<&str>) -> String {
    match scope {
        // Rejected rather than sanitised: a scope that is not a plain id is a bug in the caller,
        // and quietly rewriting it into a different filename would silently start a second,
        // empty engine for an account that already had one.
        Some(s) if is_safe_scope(s) => format!("mls_state_{}.json", s),
        _ => "mls_state.json".to_string(),
    }
}

/// Device ids are UUIDs. Anything else must not reach a path join.
fn is_safe_scope(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= 64
        && scope
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The directory the engine is currently persisting to, or `null` before initialisation.
#[tauri::command]
pub fn mls_current_state_dir(
    state: tauri::State<MlsStateHandle>,
) -> Result<Option<String>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    Ok(current_state_dir(&mls))
}

#[tauri::command]
pub fn mls_clear_storage(state: tauri::State<MlsStateHandle>) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    clear_storage(&mut mls)
}

#[tauri::command]
pub fn mls_export_state(
    state: tauri::State<MlsStateHandle>,
    encryption_key_b64: String,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    export_state(&mls, &encryption_key_b64)
}

#[tauri::command]
pub fn mls_import_state(
    state: tauri::State<MlsStateHandle>,
    encrypted_b64: String,
    encryption_key_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    import_state(&mut mls, &encrypted_b64, &encryption_key_b64)
}

/// Seals everything needed to restore this device into one passphrase-protected envelope (§D).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn mls_export_backup(
    state: tauri::State<MlsStateHandle>,
    passphrase: String,
    user_id: String,
    device_id: String,
    app_version: String,
    key_handle: String,
    group_registry: HashMap<String, serde_json::Value>,
    message_cache: Option<HashMap<String, String>>,
    account_identity: Option<BackupAccountIdentity>,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    export_backup(
        &mls,
        passphrase,
        user_id,
        device_id,
        app_version,
        key_handle,
        group_registry,
        message_cache,
        account_identity,
    )
}

/// Opens a §D backup envelope and applies it.
#[tauri::command]
pub fn mls_import_backup(
    state: tauri::State<MlsStateHandle>,
    blob: String,
    passphrase: String,
    expected_user_id: String,
    current_device_id: String,
) -> Result<MlsBackupImportResult, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    import_backup(
        &mut mls,
        blob,
        passphrase,
        expected_user_id,
        current_device_id,
    )
}

// ---------------------------------------------------------------------------
// Integration tests -call _impl functions directly, no Tauri runtime needed
// ---------------------------------------------------------------------------
//
// Run with:  cargo test --package alpine --lib
// The frontend does not need to be built.

#[cfg(test)]
mod integration_tests {
    use super::{
        add_members_impl, clear_pending_commit_impl, commit_pending_proposals_impl,
        create_group_impl, delete_group_impl, inspect_key_package_impl, merge_pending_commit_impl,
        signing_key_fingerprint_impl,
        export_group_info_impl, export_state_impl, generate_key_packages_impl,
        generate_key_packages_with_handle_impl, get_group_info_impl, get_members_impl,
        import_state_impl, init_storage_from_parts, join_group_impl, leave_group_impl, PersistedMlsState,
        load_signing_key_impl,
        process_message_impl, rejoin_group_impl, remove_members_impl, send_message_impl,
        unload_signing_key_impl, MlsState,
        derive_backup_key, export_backup, import_backup, BackupEnvelope,
        adopt_legacy_state_file, get_signer_entry, state_file_name,
        BackupAccountIdentity, BACKUP_VERSION,
    };
    use openmls::prelude::OpenMlsProvider;
    use aes_gcm::{aead::{Aead, Payload}, Aes256Gcm, KeyInit, Nonce};
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use rand::RngCore;

    /// One temp directory for the whole test binary, cleaned up when it exits.
    fn test_state_dir() -> &'static std::path::Path {
        static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
        DIR.get_or_init(|| tempfile::tempdir().expect("temp dir"))
            .path()
    }

    /// Every group operation persists, and persisting with no path is now a hard error - so a state
    /// under test has to have somewhere real to write. That is the point of the change: the old
    /// silent `Ok(())` meant a client which never initialised storage reported every operation as
    /// successful and kept none of them.
    fn make_mls() -> MlsState {
        let mut mls = MlsState::default();
        mls.state_path = Some(
            test_state_dir().join(format!("mls_state_{}.json", uuid::Uuid::new_v4())),
        );
        // A key as well as a path: writing state without one is refused outright, because there is
        // no situation in which cleartext private keys on disk is the right outcome.
        mls.state_key = Some(rand_key_bytes());
        mls
    }

    fn rand_group_id() -> String {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        B64.encode(bytes)
    }

    fn rand_key_32() -> String {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        B64.encode(bytes)
    }

    struct TwoParty {
        alice: MlsState,
        bob: MlsState,
        group_id: String,
        alice_handle: String,
        bob_handle: String,
    }

    fn setup_two_party() -> TwoParty {
        let mut alice = make_mls();
        let mut bob = make_mls();

        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 3).expect("alice key gen");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("alice create group");

        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("bob key gen");
        let add_out = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("alice add bob");
        // Commits are staged, not applied - the server accepts one per epoch, so a commit that
        // loses that race must never have touched local state. Here nothing can refuse it.
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("alice merges her own commit");
        join_group_impl(
            &mut bob,
            add_out.welcome.expect("welcome must be present"),
            bob_batch.key_handle.clone(),
        )
        .expect("bob join group");

        TwoParty {
            alice,
            bob,
            group_id,
            alice_handle: alice_batch.key_handle,
            bob_handle: bob_batch.key_handle,
        }
    }

    // ─── Key package generation ───────────────────────────────────────────────

    #[test]
    fn key_packages_returns_requested_count() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 5).expect("should succeed");
        assert_eq!(batch.key_packages.len(), 5);
    }

    #[test]
    fn key_packages_fields_are_non_empty_valid_base64() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        assert!(!batch.signing_public_key.is_empty());
        assert!(!batch.signing_private_key.is_empty());
        assert!(!batch.key_handle.is_empty());
        B64.decode(&batch.signing_public_key)
            .expect("signing_public_key must be valid base64");
        B64.decode(&batch.key_packages[0].key_package)
            .expect("key_package must be valid base64");
    }

    #[test]
    fn key_handle_from_generate_is_immediately_usable() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        create_group_impl(&mut mls, rand_group_id(), batch.key_handle)
            .expect("handle from generate_key_packages must work for create_group");
    }

    #[test]
    fn generate_with_handle_reuses_signing_key() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let more = generate_key_packages_with_handle_impl(&mls, batch.key_handle, 3)
            .expect("should succeed");
        assert_eq!(more.len(), 3);
        for kp in &more {
            B64.decode(&kp.key_package)
                .expect("key_package must be valid base64");
        }
    }

    // ─── Key handle lifecycle ─────────────────────────────────────────────────

    #[test]
    fn load_signing_key_returns_non_empty_handle() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let handle = load_signing_key_impl(
            &mut mls,
            batch.signing_public_key,
            batch.signing_private_key,
            "alice".to_string(),
        )
        .expect("load should succeed");
        assert!(!handle.is_empty());
    }

    #[test]
    fn unloaded_handle_is_rejected_with_key_not_found() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let handle = load_signing_key_impl(
            &mut mls,
            batch.signing_public_key,
            batch.signing_private_key,
            "alice".to_string(),
        )
        .expect("load should succeed");
        unload_signing_key_impl(&mut mls, handle.clone()).expect("unload should succeed");
        let err = create_group_impl(&mut mls, rand_group_id(), handle)
            .expect_err("must fail after unload");
        assert!(err.contains("KeyNotFound"), "error was: {err}");
    }

    #[test]
    fn bogus_handle_returns_key_not_found() {
        let mut mls = make_mls();
        let err = create_group_impl(&mut mls, rand_group_id(), "no-such-handle".to_string())
            .expect_err("must fail");
        assert!(err.contains("KeyNotFound"), "error was: {err}");
    }

    // ─── Group lifecycle ──────────────────────────────────────────────────────

    #[test]
    fn create_group_starts_at_epoch_zero_with_one_member() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let info =
            create_group_impl(&mut mls, rand_group_id(), batch.key_handle).expect("should succeed");
        assert_eq!(info.epoch, 0);
        assert_eq!(info.own_leaf_index, 0);
        assert_eq!(info.members.len(), 1);
        assert_eq!(info.members[0].identity, "alice");
    }

    #[test]
    fn get_group_info_matches_create_response() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        let created = create_group_impl(&mut mls, group_id.clone(), batch.key_handle)
            .expect("should succeed");
        let queried = get_group_info_impl(&mls, group_id).expect("should succeed");
        assert_eq!(created.group_id, queried.group_id);
        assert_eq!(created.epoch, queried.epoch);
        assert_eq!(created.members.len(), queried.members.len());
    }

    #[test]
    fn get_members_lists_only_creator() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut mls, group_id.clone(), batch.key_handle).expect("should succeed");
        let members = get_members_impl(&mls, group_id).expect("should succeed");
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].identity, "alice");
    }

    #[test]
    fn get_group_info_on_unknown_group_returns_group_not_found() {
        let mls = make_mls();
        let err = get_group_info_impl(&mls, rand_group_id()).expect_err("must fail");
        assert!(err.contains("GroupNotFound"), "error was: {err}");
    }

    #[test]
    fn delete_group_makes_it_inaccessible() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut mls, group_id.clone(), batch.key_handle).expect("should succeed");
        delete_group_impl(&mut mls, group_id.clone()).expect("delete must succeed");
        let err = get_group_info_impl(&mls, group_id).expect_err("group must be gone");
        assert!(err.contains("GroupNotFound"), "error was: {err}");
    }

    #[test]
    fn delete_unknown_group_returns_group_not_found() {
        let mut mls = make_mls();
        let err = delete_group_impl(&mut mls, rand_group_id()).expect_err("must fail");
        assert!(err.contains("GroupNotFound"), "error was: {err}");
    }

    // ─── Add members + join ───────────────────────────────────────────────────

    #[test]
    fn add_members_produces_welcome_and_advances_epoch() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("should succeed");
        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("should succeed");
        let add_out = add_members_impl(
            &mut alice,
            group_id,
            alice_batch.key_handle,
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("should succeed");
        assert!(
            add_out.welcome.is_some(),
            "add_members must produce a Welcome"
        );
        assert_eq!(
            add_out.epoch, 1,
            "epoch must advance to 1 after adding first member"
        );
    }

    #[test]
    fn join_group_sees_both_members() {
        let tp = setup_two_party();
        let info = get_group_info_impl(&tp.bob, tp.group_id).expect("bob must know the group");
        assert_eq!(info.members.len(), 2);
        let names: Vec<&str> = info.members.iter().map(|m| m.identity.as_str()).collect();
        assert!(names.contains(&"alice") && names.contains(&"bob"));
    }

    #[test]
    fn alice_and_bob_have_consistent_member_count() {
        let tp = setup_two_party();
        let alice_n = get_members_impl(&tp.alice, tp.group_id.clone())
            .expect("should succeed")
            .len();
        let bob_n = get_members_impl(&tp.bob, tp.group_id)
            .expect("should succeed")
            .len();
        assert_eq!(alice_n, bob_n);
    }

    // ─── Messaging ────────────────────────────────────────────────────────────

    #[test]
    fn send_and_receive_application_message() {
        let mut tp = setup_two_party();
        let payload = B64.encode(b"hello from alice");
        let ct = send_message_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            tp.alice_handle,
            payload.clone(),
        )
        .expect("send must succeed");
        let rx = process_message_impl(&mut tp.bob, tp.group_id, ct.ciphertext).expect("process must succeed");
        assert_eq!(rx.kind, "application");
        assert_eq!(rx.plaintext, Some(payload));
        assert!(!rx.self_removed);
    }

    #[test]
    fn received_message_carries_sender_identity() {
        let mut tp = setup_two_party();
        let ct = send_message_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            tp.alice_handle,
            B64.encode(b"hi"),
        )
        .expect("should succeed");
        let rx = process_message_impl(&mut tp.bob, tp.group_id, ct.ciphertext).expect("should succeed");
        assert_eq!(rx.sender_identity.as_deref(), Some("alice"));
    }

    #[test]
    fn bidirectional_messaging_preserves_content() {
        let mut tp = setup_two_party();
        let a_to_b = B64.encode(b"ping");
        let b_to_a = B64.encode(b"pong");

        let ct1 = send_message_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            tp.alice_handle.clone(),
            a_to_b.clone(),
        )
        .expect("alice send");
        let r1 = process_message_impl(&mut tp.bob, tp.group_id.clone(), ct1.ciphertext).expect("bob receive");
        assert_eq!(r1.plaintext, Some(a_to_b));

        let ct2 = send_message_impl(
            &mut tp.bob,
            tp.group_id.clone(),
            tp.bob_handle,
            b_to_a.clone(),
        )
        .expect("bob send");
        let r2 = process_message_impl(&mut tp.alice, tp.group_id, ct2.ciphertext).expect("alice receive");
        assert_eq!(r2.plaintext, Some(b_to_a));
    }

    #[test]
    fn add_member_commit_is_processed_with_correct_kind_and_identity() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let mut charlie = make_mls();

        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 3).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("should succeed");

        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("should succeed");
        let add1 = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("should succeed");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("alice merges add-bob");
        join_group_impl(&mut bob, add1.welcome.unwrap(), bob_batch.key_handle).expect("bob joins");

        let charlie_batch = generate_key_packages_impl(&mut charlie, "charlie".to_string(), 1)
            .expect("should succeed");
        let add2 = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle,
            vec![charlie_batch.key_packages[0].key_package.clone()],
        )
        .expect("should succeed");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("alice merges add-charlie");

        let processed = process_message_impl(&mut bob, group_id, add2.commit)
            .expect("bob processes add-charlie commit");
        assert_eq!(processed.kind, "commit");
        assert_eq!(processed.added_members.len(), 1);
        assert_eq!(processed.added_members[0].identity, "charlie");
    }

    // ─── Key package inspection ───────────────────────────────────────────────
    //
    // What a reviewer is shown before vouching for someone's admission to an encrypted room.

    #[test]
    fn inspect_reports_the_identity_the_package_claims() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");

        let info = inspect_key_package_impl(&mls, batch.key_packages[0].key_package.clone())
            .expect("inspect must succeed");

        assert_eq!(info.identity, "alice");
        assert!(!info.signature_key_fingerprint.is_empty());
    }

    #[test]
    fn fingerprint_is_stable_across_a_devices_key_packages() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 3).expect("should succeed");

        let fingerprints: Vec<String> = batch
            .key_packages
            .iter()
            .map(|kp| {
                inspect_key_package_impl(&mls, kp.key_package.clone())
                    .expect("inspect must succeed")
                    .signature_key_fingerprint
            })
            .collect();

        // This is the whole point of fingerprinting the signature key rather than the package: a
        // value that changed with every package could never be read out and compared over a call.
        assert_eq!(fingerprints[0], fingerprints[1]);
        assert_eq!(fingerprints[1], fingerprints[2]);
    }

    #[test]
    fn own_fingerprint_matches_the_one_a_reviewer_sees() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");

        let from_handle = signing_key_fingerprint_impl(&mls, batch.key_handle.clone())
            .expect("should succeed");
        let from_package = inspect_key_package_impl(&mls, batch.key_packages[0].key_package.clone())
            .expect("should succeed")
            .signature_key_fingerprint;

        // The requester reads their own value aloud and the reviewer compares it against the one
        // derived from the key package. If these two ever diverged, every honest comparison would
        // fail and the review would train people to approve mismatches.
        assert_eq!(from_handle, from_package);
    }

    #[test]
    fn own_fingerprint_does_not_consume_a_key_package() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");

        for _ in 0..5 {
            signing_key_fingerprint_impl(&mls, batch.key_handle.clone()).expect("should succeed");
        }

        // Reading your own fingerprint has to be free. Minting a package per read - which is what
        // this replaced - would drain a finite supply and eventually leave the device unaddable.
        create_group_impl(&mut mls, rand_group_id(), batch.key_handle)
            .expect("the signing key must still be usable");
    }

    #[test]
    fn own_fingerprint_needs_a_loaded_key() {
        let mls = make_mls();

        let err = signing_key_fingerprint_impl(&mls, "no-such-handle".to_string())
            .expect_err("must fail");
        assert!(err.contains("KeyNotFound"), "error was: {err}");
    }

    #[test]
    fn fingerprint_differs_between_devices() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let a = generate_key_packages_impl(&mut alice, "alice".to_string(), 1).expect("ok");
        let b = generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("ok");

        let fa = inspect_key_package_impl(&alice, a.key_packages[0].key_package.clone())
            .expect("ok")
            .signature_key_fingerprint;
        let fb = inspect_key_package_impl(&bob, b.key_packages[0].key_package.clone())
            .expect("ok")
            .signature_key_fingerprint;

        assert_ne!(fa, fb);
    }

    #[test]
    fn key_package_hash_differs_per_package_and_matches_the_bytes() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 2).expect("should succeed");

        let first = inspect_key_package_impl(&mls, batch.key_packages[0].key_package.clone())
            .expect("ok");
        let second = inspect_key_package_impl(&mls, batch.key_packages[1].key_package.clone())
            .expect("ok");
        let repeat = inspect_key_package_impl(&mls, batch.key_packages[0].key_package.clone())
            .expect("ok");

        // Per-package, so it can bind an approval to exact bytes; deterministic, so the committer
        // can re-derive and compare rather than trusting what it was handed.
        assert_ne!(first.key_package_hash, second.key_package_hash);
        assert_eq!(first.key_package_hash, repeat.key_package_hash);
    }

    #[test]
    fn inspect_rejects_a_malformed_package() {
        let mls = make_mls();

        // A reviewer must never be shown an identity lifted from something that would be refused at
        // add time - or be talked into vouching for a package whose signature does not check out.
        assert!(inspect_key_package_impl(&mls, B64.encode(b"not a key package")).is_err());
    }

    #[test]
    fn fingerprint_is_grouped_for_reading_aloud() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");

        let info = inspect_key_package_impl(&mls, batch.key_packages[0].key_package.clone())
            .expect("ok");

        let groups: Vec<&str> = info.signature_key_fingerprint.split('-').collect();
        assert_eq!(groups.len(), 4, "20 hex chars in groups of five");
        assert!(groups.iter().all(|g| g.len() == 5));
        assert!(info.signature_key_fingerprint.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    // ─── Staged commits ───────────────────────────────────────────────────────
    //
    // The server accepts exactly one commit per epoch. A commit that loses that race must never
    // have been applied locally, because a group that advanced on a commit nobody else holds is
    // forked and MLS offers no way back. So commits are staged and only merged once the server has
    // taken them.

    #[test]
    fn add_members_does_not_advance_the_group_until_merged() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("should succeed");
        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("should succeed");

        add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("should succeed");

        let staged = get_group_info_impl(&alice, group_id.clone()).expect("should succeed");
        assert_eq!(staged.epoch, 0, "staging must not move the epoch");
        assert_eq!(staged.members.len(), 1, "staging must not add the member yet");

        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("merge must succeed");

        let merged = get_group_info_impl(&alice, group_id).expect("should succeed");
        assert_eq!(merged.epoch, 1);
        assert_eq!(merged.members.len(), 2);
    }

    #[test]
    fn clearing_a_staged_commit_leaves_the_group_untouched() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("should succeed");
        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("should succeed");

        add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("should succeed");
        clear_pending_commit_impl(&mut alice, group_id.clone()).expect("clear must succeed");

        // This is the losing side of a concurrent-commit race: the server took someone else's
        // commit for this epoch, so ours is discarded and the group is exactly where it started.
        let info = get_group_info_impl(&alice, group_id.clone()).expect("should succeed");
        assert_eq!(info.epoch, 0);
        assert_eq!(info.members.len(), 1);
    }

    #[test]
    fn a_cleared_commit_can_be_reissued() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("should succeed");
        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 2).expect("should succeed");

        add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("first attempt");
        clear_pending_commit_impl(&mut alice, group_id.clone()).expect("clear must succeed");

        // Losing the race has to be recoverable, or a client that gets unlucky can never add anyone.
        let retry = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle,
            vec![bob_batch.key_packages[1].key_package.clone()],
        )
        .expect("retry after clearing must succeed");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("merge must succeed");

        assert!(retry.welcome.is_some());
        assert_eq!(
            get_members_impl(&alice, group_id)
                .expect("should succeed")
                .len(),
            2
        );
    }

    #[test]
    fn merge_with_nothing_staged_does_not_advance_the_group() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        create_group_impl(&mut mls, group_id.clone(), batch.key_handle).expect("should succeed");

        // OpenMLS treats this as a no-op rather than an error, which makes the merge safe to retry:
        // a client that publishes successfully but crashes before merging can merge again on the
        // next launch without having to know whether the first one landed.
        let epoch = merge_pending_commit_impl(&mut mls, group_id.clone())
            .expect("merging nothing is a no-op, not a failure");

        assert_eq!(epoch, 0);
        assert_eq!(
            get_group_info_impl(&mls, group_id).expect("should succeed").epoch,
            0,
            "a merge with nothing staged must never move the epoch"
        );
    }

    // ─── Remove members ───────────────────────────────────────────────────────

    #[test]
    fn remove_member_decreases_count_and_marks_self_removed() {
        let mut tp = setup_two_party();
        let members = get_members_impl(&tp.alice, tp.group_id.clone()).expect("should succeed");
        let bob_leaf = members
            .iter()
            .find(|m| m.identity == "bob")
            .map(|m| m.leaf_index)
            .expect("bob must be in the group");

        let remove_out = remove_members_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            tp.alice_handle,
            vec![bob_leaf],
        )
        .expect("remove must succeed");
        merge_pending_commit_impl(&mut tp.alice, tp.group_id.clone()).expect("alice merges removal");

        let after = get_members_impl(&tp.alice, tp.group_id.clone()).expect("should succeed");
        assert_eq!(after.len(), 1, "only alice must remain after removing bob");

        let processed = process_message_impl(&mut tp.bob, tp.group_id, remove_out.commit)
            .expect("bob processes removal commit");
        assert_eq!(processed.kind, "commit");
        assert!(
            processed.self_removed,
            "self_removed must be true for the evicted member"
        );
    }

    // ─── Leave group ──────────────────────────────────────────────────────────
    //
    // In OpenMLS a member cannot commit their own removal. `leave_group_impl`
    // therefore emits a Remove *proposal*. Another group member must then call
    // `commit_pending_proposals_impl` to turn that proposal into a commit.

    #[test]
    fn leave_group_removes_local_state_and_alice_sees_removal() {
        let mut tp = setup_two_party();

        // Bob leaves: produces a Remove-self proposal and erases his local state.
        let leave_out = leave_group_impl(&mut tp.bob, tp.group_id.clone(), tp.bob_handle.clone())
            .expect("leave must succeed");

        // Bob's group is gone immediately.
        let bob_err = get_group_info_impl(&tp.bob, tp.group_id.clone())
            .expect_err("bob's group must be removed after leave");
        assert!(bob_err.contains("GroupNotFound"), "error was: {bob_err}");

        // Alice receives Bob's leave proposal.
        let proposal_result =
            process_message_impl(&mut tp.alice, tp.group_id.clone(), leave_out.commit)
                .expect("alice processes leave proposal");
        assert_eq!(proposal_result.kind, "proposal");

        // Alice commits the pending proposal (the Remove-Bob commit).
        let commit_out = commit_pending_proposals_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            tp.alice_handle.clone(),
        )
        .expect("alice commits pending proposals");
        merge_pending_commit_impl(&mut tp.alice, tp.group_id.clone())
            .expect("alice merges the remove-bob commit");
        assert!(!commit_out.commit.is_empty());

        // Alice now has only herself in the group.
        let members = get_members_impl(&tp.alice, tp.group_id).expect("should succeed");
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].identity, "alice");
    }

    // ─── Export group info + rejoin ───────────────────────────────────────────

    #[test]
    fn rejoin_via_external_commit_adds_new_member() {
        let mut tp = setup_two_party();
        let group_info_b64 =
            export_group_info_impl(&tp.alice, tp.group_id.clone(), tp.alice_handle.clone())
                .expect("export_group_info must succeed");
        assert!(!group_info_b64.is_empty());

        let mut charlie = make_mls();
        let charlie_batch = generate_key_packages_impl(&mut charlie, "charlie".to_string(), 1)
            .expect("should succeed");
        let rejoin_out = rejoin_group_impl(&mut charlie, group_info_b64, charlie_batch.key_handle)
            .expect("rejoin must succeed");

        assert!(!rejoin_out.external_commit.is_empty());
        assert_eq!(
            rejoin_out.group_info.members.len(),
            3,
            "charlie sees alice, bob, and himself after external commit"
        );

        let alice_processed = process_message_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            rejoin_out.external_commit.clone(),
        )
        .expect("alice processes external commit");
        assert_eq!(alice_processed.kind, "commit");

        process_message_impl(&mut tp.bob, tp.group_id, rejoin_out.external_commit)
            .expect("bob processes external commit");
    }

    // ─── State export / import ────────────────────────────────────────────────

    #[test]
    fn export_import_state_preserves_groups() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        let group_id = rand_group_id();
        let created = create_group_impl(&mut mls, group_id.clone(), batch.key_handle)
            .expect("should succeed");

        let key_b64 = rand_key_32();
        let exported = export_state_impl(&mls, key_b64.clone()).expect("export must succeed");
        assert!(!exported.is_empty());

        let mut new_mls = make_mls();
        import_state_impl(&mut new_mls, exported, key_b64).expect("import must succeed");

        let imported =
            get_group_info_impl(&new_mls, group_id).expect("group must be accessible after import");
        assert_eq!(imported.group_id, created.group_id);
        assert_eq!(imported.epoch, created.epoch);
        assert_eq!(imported.members.len(), created.members.len());
    }

    #[test]
    fn import_with_wrong_key_fails_decryption() {
        let mut mls = make_mls();
        let batch =
            generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("should succeed");
        create_group_impl(&mut mls, rand_group_id(), batch.key_handle).expect("should succeed");

        let key_b64 = rand_key_32();
        let exported = export_state_impl(&mls, key_b64).expect("export must succeed");

        let wrong_key = rand_key_32();
        assert!(
            import_state_impl(&mut mls, exported, wrong_key).is_err(),
            "import with the wrong key must fail"
        );
    }

    // ─── Full lifecycle ───────────────────────────────────────────────────────

    #[test]
    fn full_two_party_conversation_and_cleanup() {
        let mut alice = make_mls();
        let mut bob = make_mls();

        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 3).expect("alice key gen");
        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("bob key gen");

        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("alice create group");
        let add_out = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("alice add bob");
        assert_eq!(add_out.epoch, 1, "the epoch this commit will establish once merged");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("alice merges add-bob");

        let bob_info = join_group_impl(
            &mut bob,
            add_out.welcome.expect("welcome must exist"),
            bob_batch.key_handle.clone(),
        )
        .expect("bob join");
        assert_eq!(bob_info.members.len(), 2);

        let msg = B64.encode(b"top secret");
        let ct = send_message_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            msg.clone(),
        )
        .expect("alice send");
        let rx = process_message_impl(&mut bob, group_id.clone(), ct.ciphertext).expect("bob receive");
        assert_eq!(rx.plaintext, Some(msg));
        assert_eq!(rx.sender_identity.as_deref(), Some("alice"));

        let reply = B64.encode(b"acknowledged");
        let ct2 = send_message_impl(
            &mut bob,
            group_id.clone(),
            bob_batch.key_handle.clone(),
            reply.clone(),
        )
        .expect("bob send");
        let rx2 = process_message_impl(&mut alice, group_id.clone(), ct2.ciphertext).expect("alice receive");
        assert_eq!(rx2.plaintext, Some(reply));

        // 6. Bob leaves: produces a Remove-self proposal; Alice commits it.
        let leave_out =
            leave_group_impl(&mut bob, group_id.clone(), bob_batch.key_handle).expect("bob leave");
        assert!(get_group_info_impl(&bob, group_id.clone()).is_err());
        let proposal_result = process_message_impl(&mut alice, group_id.clone(), leave_out.commit)
            .expect("alice processes leave proposal");
        assert_eq!(proposal_result.kind, "proposal");
        let commit_out = commit_pending_proposals_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
        )
        .expect("alice commits leave proposal");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("alice merges remove-bob");
        assert!(!commit_out.commit.is_empty());
        assert_eq!(
            get_members_impl(&alice, group_id.clone())
                .expect("should succeed")
                .len(),
            1
        );

        delete_group_impl(&mut alice, group_id.clone()).expect("alice delete");
        assert!(get_group_info_impl(&alice, group_id).is_err());
    }

    // ─── Sender ratchet configuration ─────────────────────────────────────────
    //
    // openmls 0.8.1 declares `SenderRatchetConfiguration::new(out_of_order_tolerance,
    // maximum_forward_distance)`. The two literals used to be passed the other way round, which is
    // invisible in every ordinary test - a two-party exchange never runs far enough ahead to notice
    // - and shows up in production as messages that simply never arrive.

    /// How far ahead of the receiver a sender may run before the receiver refuses the message.
    ///
    /// This is the half that costs users data: a phone that shows eleven lock-screen notifications
    /// in one epoch has advanced the sender's generation eleven times, and with a forward distance
    /// of 10 the twelfth message is rejected permanently. MLS decrypts from the wire exactly once,
    /// so "rejected" here means gone.
    #[test]
    fn a_sender_may_run_far_ahead_without_the_receiver_refusing() {
        let mut tp = setup_two_party();

        // Comfortably past the transposed configuration's limit of 10, and well inside the
        // corrected 500.
        const AHEAD: usize = 60;
        let mut ciphertexts = Vec::with_capacity(AHEAD);
        for i in 0..AHEAD {
            ciphertexts.push(
                send_message_impl(
                    &mut tp.alice,
                    tp.group_id.clone(),
                    tp.alice_handle.clone(),
                    B64.encode(format!("message {i}").as_bytes()),
                )
                .expect("alice sends")
                .ciphertext,
            );
        }

        // Bob has seen none of them. Delivering only the last one is the notification-storm case:
        // the generations in between are never delivered to this device at all.
        let last = ciphertexts.pop().expect("at least one message");
        let processed = process_message_impl(&mut tp.bob, tp.group_id.clone(), last)
            .expect("a message far ahead of us must still decrypt");

        assert_eq!(
            processed.plaintext,
            Some(B64.encode(format!("message {}", AHEAD - 1).as_bytes()))
        );
    }

    /// The other half: spent keys are *not* hoarded.
    ///
    /// Out-of-order tolerance is how many used message secrets stay in the cache, and every one of
    /// them is intra-epoch forward secrecy given away - they live in the state file. The transposed
    /// configuration kept 500 per sender per epoch. This pins that a message left far enough behind
    /// is dropped rather than retained indefinitely.
    #[test]
    fn spent_message_secrets_are_not_retained_indefinitely() {
        let mut tp = setup_two_party();

        let stale = send_message_impl(
            &mut tp.alice,
            tp.group_id.clone(),
            tp.alice_handle.clone(),
            B64.encode(b"the straggler"),
        )
        .expect("alice sends")
        .ciphertext;

        // Push well past the corrected tolerance of 10 before delivering the straggler.
        for i in 0..40 {
            let ct = send_message_impl(
                &mut tp.alice,
                tp.group_id.clone(),
                tp.alice_handle.clone(),
                B64.encode(format!("later {i}").as_bytes()),
            )
            .expect("alice sends")
            .ciphertext;
            process_message_impl(&mut tp.bob, tp.group_id.clone(), ct).expect("bob keeps up");
        }

        // With a tolerance of 500 this would succeed, and Bob would be holding hundreds of spent
        // secrets on disk. A refusal here is the correct, forward-secret outcome.
        assert!(
            process_message_impl(&mut tp.bob, tp.group_id.clone(), stale).is_err(),
            "a message left far behind must be dropped, not decryptable from a hoarded secret"
        );
    }


    // ─── Persistence and at-rest confidentiality ──────────────────────────────
    //
    // The state file is every init key, leaf HPKE private key and epoch secret this device holds.
    // Reaching this code needs a Tauri `AppHandle`, which is why none of it was covered before -
    // and why three separate defects lived in one seven-line function.

    fn rand_key_bytes() -> Vec<u8> {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes.to_vec()
    }

    fn make_mls_at(path: std::path::PathBuf, key: Option<Vec<u8>>) -> MlsState {
        let mut mls = MlsState::default();
        mls.state_path = Some(path);
        mls.state_key = key;
        mls
    }

    #[test]
    fn saving_without_initialised_storage_is_an_error_not_a_no_op() {
        let mut mls = MlsState::default();
        assert!(mls.state_path.is_none());

        let err = match generate_key_packages_impl(&mut mls, "alice".to_string(), 1) {
            Ok(_) => panic!("an operation that cannot be persisted must fail loudly"),
            Err(e) => e,
        };

        // This used to return Ok(()), so every group operation reported success while persisting
        // nothing and all of it vanished on the next launch.
        assert!(err.contains("not initialised"), "error was: {err}");
    }

    #[test]
    fn the_state_file_is_not_readable_without_the_device_key() {
        let path = test_state_dir().join(format!("sealed_{}.json", uuid::Uuid::new_v4()));
        let key = rand_key_bytes();

        let mut mls = make_mls_at(path.clone(), Some(key.clone()));
        let batch = generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
        create_group_impl(&mut mls, rand_group_id(), batch.key_handle).expect("create");

        let raw = std::fs::read(&path).expect("state file must exist");
        // Not a substring check for one key - the whole file must be opaque. Anyone with the disk,
        // an OS backup, or a restored device image could previously read every private key out of
        // this as plain JSON, with no keychain access and no unlock.
        assert!(
            serde_json::from_slice::<serde_json::Value>(&raw).is_err(),
            "the state file must not be parseable JSON on disk"
        );

        let mut wrong = MlsState::default();
        assert!(
            init_storage_from_parts(&mut wrong, path, Some(B64.encode(rand_key_bytes()))).is_err(),
            "a different device key must not open the state file"
        );
    }

    #[test]
    fn a_sealed_state_file_round_trips() {
        let path = test_state_dir().join(format!("roundtrip_{}.json", uuid::Uuid::new_v4()));
        let key = rand_key_bytes();
        let group_id = rand_group_id();

        {
            let mut mls = make_mls_at(path.clone(), Some(key.clone()));
            let batch =
                generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
            create_group_impl(&mut mls, group_id.clone(), batch.key_handle).expect("create");
        }

        let mut restarted = MlsState::default();
        let restored = init_storage_from_parts(&mut restarted, path, Some(B64.encode(&key)))
            .expect("restore must succeed");

        assert!(restored);
        assert_eq!(
            get_group_info_impl(&restarted, group_id)
                .expect("the group must come back")
                .members
                .len(),
            1
        );
    }

    #[test]
    fn a_legacy_plaintext_state_file_is_adopted_and_resealed() {
        let path = test_state_dir().join(format!("legacy_{}.json", uuid::Uuid::new_v4()));
        let group_id = rand_group_id();

        // Exactly what shipped before: plain JSON on disk. Written directly rather than
        // through the engine, because the engine now refuses to produce one - this is standing in
        // for a file left behind by an *older build*, which is the only way one can exist.
        {
            let mut mls = make_mls();
            let batch =
                generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
            create_group_impl(&mut mls, group_id.clone(), batch.key_handle).expect("create");
            std::fs::write(
                &path,
                serde_json::to_vec(&mls.to_persisted()).expect("serialize"),
            )
            .expect("write legacy plaintext state");
        }
        assert!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).expect("read")).is_ok()
        );

        let key = rand_key_bytes();
        let mut upgraded = MlsState::default();
        init_storage_from_parts(&mut upgraded, path.clone(), Some(B64.encode(&key)))
            .expect("a legacy file must still open, or every existing device is stranded");

        assert!(get_group_info_impl(&upgraded, group_id).is_ok());
        assert!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).expect("read"))
                .is_err(),
            "the migration must rewrite the file sealed, not leave it in the clear"
        );
    }

    // ─── Per-account scoping of the state file ────────────────────────────────
    //
    // One `mls_state.json` per installation is how two accounts on one machine came to share every
    // epoch secret and leaf HPKE private key between them. `init_storage_from_parts` was already
    // written for this - it clears groups, signers and the whole provider store when the path
    // changes - but the command wrapper handed it a constant, so the path never changed and the
    // defence never fired.

    #[test]
    fn the_state_file_is_named_after_the_account() {
        assert_eq!(
            state_file_name(Some("2b1f0e6a-9c3d-4f77-8a21-000000000001")),
            "mls_state_2b1f0e6a-9c3d-4f77-8a21-000000000001.json"
        );
        assert_eq!(state_file_name(None), "mls_state.json");
    }

    #[test]
    fn a_scope_that_is_not_a_plain_id_falls_back_rather_than_reaching_a_path_join() {
        // Traversal is the obvious one, but the reason this refuses rather than sanitises is the
        // quieter failure: a rewritten scope names a *different* file, so an account that already
        // had state would silently start on an empty engine.
        for hostile in ["../../etc/passwd", "a/b", "a\\b", "", "with space", "a.b"] {
            assert_eq!(
                state_file_name(Some(hostile)),
                "mls_state.json",
                "scope {hostile:?} must not name a file"
            );
        }
    }

    #[test]
    fn switching_accounts_clears_the_previous_account_key_material() {
        let key = rand_key_bytes();
        let path_a = test_state_dir().join(format!("acct_a_{}.json", uuid::Uuid::new_v4()));
        let path_b = test_state_dir().join(format!("acct_b_{}.json", uuid::Uuid::new_v4()));

        let mut mls = make_mls_at(path_a.clone(), Some(key.clone()));
        let batch = generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
        let group_id = rand_group_id();
        create_group_impl(&mut mls, group_id.clone(), batch.key_handle.clone()).expect("create");

        // The same live engine now pointed at another account's file.
        init_storage_from_parts(&mut mls, path_b.clone(), Some(B64.encode(&key)))
            .expect("pointing at a fresh account file must succeed");

        assert!(
            get_group_info_impl(&mls, group_id).is_err(),
            "account A's group must not be readable after switching to account B"
        );
        assert!(
            get_signer_entry(&mls, &batch.key_handle).is_err(),
            "a signer handle minted for account A must not stay usable for account B"
        );
        assert!(
            mls.provider.storage().values.read().unwrap().is_empty(),
            "account A's provider store must be cleared, not merged into account B's"
        );
    }

    #[test]
    fn each_account_state_file_keeps_its_own_groups() {
        let key_a = rand_key_bytes();
        let key_b = rand_key_bytes();
        let path_a = test_state_dir().join(format!("own_a_{}.json", uuid::Uuid::new_v4()));
        let path_b = test_state_dir().join(format!("own_b_{}.json", uuid::Uuid::new_v4()));

        let mut a = make_mls_at(path_a.clone(), Some(key_a.clone()));
        let batch_a = generate_key_packages_impl(&mut a, "alice".to_string(), 1).expect("key gen");
        let group_a = rand_group_id();
        create_group_impl(&mut a, group_a.clone(), batch_a.key_handle).expect("create");

        let mut b = make_mls_at(path_b.clone(), Some(key_b.clone()));
        let batch_b = generate_key_packages_impl(&mut b, "bob".to_string(), 1).expect("key gen");
        create_group_impl(&mut b, rand_group_id(), batch_b.key_handle).expect("create");

        // Reopened independently: B writing its own file must not have touched A's.
        let mut reopened = MlsState::default();
        init_storage_from_parts(&mut reopened, path_a, Some(B64.encode(&key_a))).expect("reopen A");

        assert!(
            get_group_info_impl(&reopened, group_a).is_ok(),
            "account A's group must survive account B using the machine"
        );
    }

    #[test]
    fn adopting_the_pre_scope_state_file_moves_it_under_the_account_name() {
        let dir = test_state_dir().join(format!("adopt_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let legacy = dir.join("mls_state.json");
        let scoped = dir.join("mls_state_device-a.json");

        let key = rand_key_bytes();
        let mut mls = make_mls_at(legacy.clone(), Some(key.clone()));
        let batch = generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
        let group_id = rand_group_id();
        create_group_impl(&mut mls, group_id.clone(), batch.key_handle).expect("create");
        assert!(legacy.exists());

        adopt_legacy_state_file(&legacy, &scoped).expect("adopt");

        assert!(!legacy.exists(), "the pre-scope file must be moved, not copied");
        let mut upgraded = MlsState::default();
        init_storage_from_parts(&mut upgraded, scoped, Some(B64.encode(&key))).expect("open");
        assert!(
            get_group_info_impl(&upgraded, group_id).is_ok(),
            "the upgrading account must keep the groups it already belongs to"
        );
    }

    #[test]
    fn adopting_never_overwrites_an_account_that_already_has_state() {
        let dir = test_state_dir().join(format!("adopt_clash_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let legacy = dir.join("mls_state.json");
        let scoped = dir.join("mls_state_device-a.json");

        std::fs::write(&legacy, b"stale").expect("write legacy");
        std::fs::write(&scoped, b"this account's real state").expect("write scoped");

        adopt_legacy_state_file(&legacy, &scoped).expect("adopt");

        assert_eq!(
            std::fs::read(&scoped).expect("read"),
            b"this account's real state",
            "a leftover pre-scope file must never replace state the account already has"
        );
        assert!(legacy.exists(), "and the leftover must be left where it is");
    }

    #[test]
    fn adopting_is_a_no_op_when_there_is_nothing_to_adopt() {
        let dir = test_state_dir().join(format!("adopt_none_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");

        adopt_legacy_state_file(&dir.join("mls_state.json"), &dir.join("mls_state_device-a.json"))
            .expect("a fresh install has no pre-scope file and that is not an error");
    }

    #[test]
    fn a_truncated_state_file_fails_to_load_rather_than_loading_partially() {
        let path = test_state_dir().join(format!("trunc_{}.json", uuid::Uuid::new_v4()));
        let key = rand_key_bytes();

        let mut mls = make_mls_at(path.clone(), Some(key.clone()));
        let batch = generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
        create_group_impl(&mut mls, rand_group_id(), batch.key_handle).expect("create");

        let raw = std::fs::read(&path).expect("read");
        std::fs::write(&path, &raw[..raw.len() / 2]).expect("truncate");

        let mut reloaded = MlsState::default();
        assert!(
            init_storage_from_parts(&mut reloaded, path, Some(B64.encode(&key))).is_err(),
            "half a state file must be refused, not silently treated as an empty one"
        );
    }

    #[test]
    fn writing_state_without_a_key_is_refused() {
        // The branch this replaces was `None => json`: it wrote every init key, leaf HPKE key and
        // epoch secret on the device as cleartext JSON, silently, in the middle of the fix that
        // was supposed to encrypt them. Reading a legacy plaintext file is still supported;
        // producing a new one never is.
        let path = test_state_dir().join(format!("nokey_{}.json", uuid::Uuid::new_v4()));
        let mut mls = make_mls_at(path.clone(), None);

        let err = match generate_key_packages_impl(&mut mls, "alice".to_string(), 1) {
            Ok(_) => panic!("writing state in the clear must be refused"),
            Err(e) => e,
        };

        // Matched on the invariant rather than the prose. The refusal message is now shared with
        // venta-mobile verbatim, so pinning a phrase unique to one client's wording would break the
        // next time the two are re-synced - which is exactly the event this file exists to survive.
        assert!(err.contains("without a state key"), "error was: {err}");
        assert!(!path.exists(), "no state file may be produced without a key");
    }
    #[test]
    fn a_save_leaves_no_temp_file_behind() {
        let path = test_state_dir().join(format!("tmp_{}.json", uuid::Uuid::new_v4()));
        let mut mls = make_mls_at(path.clone(), Some(rand_key_bytes()));
        let batch = generate_key_packages_impl(&mut mls, "alice".to_string(), 1).expect("key gen");
        create_group_impl(&mut mls, rand_group_id(), batch.key_handle).expect("create");

        // The write goes to a temp file and is renamed over the target, so a reader sees either the
        // whole old file or the whole new one - never a prefix.
        assert!(!path.with_extension("json.tmp").exists());
        assert!(path.exists());
    }


    // ─── Cross-client golden vectors (contract §F) ────────────────────────────
    //
    // `venta_mls/rust/Cargo.toml` pins `openmls 0.8.1` with the comment "Bump both together or
    // neither". These tests are what make that an assertion. Each client's engine produces a
    // fixture, both are checked into both repos, and each asserts it consumes the *other's* bytes -
    // so a ciphersuite, protocol-version or TLS-codec drift fails here instead of surfacing as
    // "my friend texts me from desktop and I cannot read it on mobile".
    //
    // These fixtures were orphaned when this file was overwritten: the data survived in `testdata/`
    // and the only consumer was lost with the engine. An unread fixture asserts nothing, so
    // re-attaching a consumer is part of restoring the pin.

    fn golden_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("testdata")
            .join("mls-golden")
            .join("v1")
    }

    #[test]
    fn this_engine_consumes_its_own_golden_vectors() {
        // The control. When this fails alongside the one below, the fixture is stale rather than
        // the other engine having drifted.
        consume_golden_fixture("fixture.json", "alpine");
    }

    #[test]
    fn this_engine_consumes_venta_mobiles_golden_vectors() {
        // The one that proves something: bytes produced by the other implementation.
        consume_golden_fixture("fixture-venta-mobile.json", "venta-mobile");
    }

    fn consume_golden_fixture(file: &str, expected_producer: &str) {
        let path = golden_dir().join(file);
        let raw = std::fs::read(&path)
            .unwrap_or_else(|e| panic!("golden fixture missing at {}: {e}", path.display()));
        let fixture: serde_json::Value = serde_json::from_slice(&raw).expect("fixture json");

        assert_eq!(
            fixture["producedBy"].as_str(),
            Some(expected_producer),
            "{file} was not produced by the engine it is meant to test against"
        );
        // Named explicitly: a ciphersuite or version drift is the failure this exists to catch, and
        // it should say so rather than surfacing as an opaque deserialization error further down.
        assert_eq!(
            fixture["ciphersuite"].as_str(),
            Some("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
            "{file} was produced under a different ciphersuite"
        );
        assert_eq!(
            fixture["openmls"].as_str(),
            Some("0.8.1"),
            "{file} was produced by a different openmls - the version pin is broken"
        );

        let group_id = fixture["groupIdB64"].as_str().expect("groupId").to_string();
        let bob = &fixture["bob"];

        // The key package parses and validates - the shape a peer must accept before it can add
        // this device to anything.
        let scratch = make_mls();
        let info = inspect_key_package_impl(
            &scratch,
            bob["keyPackageB64"].as_str().expect("kp").to_string(),
        )
        .expect("the golden key package must validate");
        assert_eq!(info.identity, "bob");

        // Bob's provider store as it was *before* joining: it holds the private half of his key
        // package, without which the Welcome cannot be opened by anyone.
        let mut engine = make_mls();
        let persisted: PersistedMlsState =
            serde_json::from_value(bob["engine"].clone()).expect("bob engine");
        super::restore_persisted(&mut engine, persisted).expect("restore bob's store");

        let handle = load_signing_key_impl(
            &mut engine,
            bob["signingPublicKey"].as_str().expect("pub").to_string(),
            bob["signingPrivateKey"].as_str().expect("priv").to_string(),
            "bob".to_string(),
        )
        .expect("load bob's signing key");

        let joined = join_group_impl(
            &mut engine,
            fixture["welcomeB64"].as_str().expect("welcome").to_string(),
            handle,
        )
        .expect("the golden Welcome must be joinable");
        assert_eq!(joined.members.len(), 2);

        let commit = process_message_impl(
            &mut engine,
            group_id.clone(),
            fixture["commitB64"].as_str().expect("commit").to_string(),
        )
        .expect("the golden commit must apply");
        assert_eq!(commit.kind, "commit");
        assert_eq!(commit.added_members.len(), 1);

        let message = process_message_impl(
            &mut engine,
            group_id,
            fixture["applicationMessageB64"]
                .as_str()
                .expect("message")
                .to_string(),
        )
        .expect("the golden application message must decrypt");
        assert_eq!(
            message.plaintext.as_deref(),
            fixture["applicationPlaintextB64"].as_str()
        );
        assert_eq!(message.sender_identity.as_deref(), Some("alice"));
    }

    /// Regenerates `testdata/mls-golden/v1/fixture.json` for venta-mobile to consume.
    ///
    /// Ignored by default: the fixture is a checked-in artefact, and regenerating it on every run
    /// would mean each engine only ever consumed bytes it had just produced.
    #[test]
    #[ignore]
    fn generate_golden_fixture() {
        let mut alice = make_mls();
        let mut bob = make_mls();
        let mut charlie = make_mls();

        let alice_batch =
            generate_key_packages_impl(&mut alice, "alice".to_string(), 1).expect("alice keys");
        let bob_batch =
            generate_key_packages_impl(&mut bob, "bob".to_string(), 1).expect("bob keys");
        let charlie_batch = generate_key_packages_impl(&mut charlie, "charlie".to_string(), 1)
            .expect("charlie keys");

        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), alice_batch.key_handle.clone())
            .expect("create");

        let add_bob = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![bob_batch.key_packages[0].key_package.clone()],
        )
        .expect("add bob");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("merge");

        let add_charlie = add_members_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            vec![charlie_batch.key_packages[0].key_package.clone()],
        )
        .expect("add charlie");
        merge_pending_commit_impl(&mut alice, group_id.clone()).expect("merge");

        let plaintext = B64.encode(b"golden vector application message");
        let app = send_message_impl(
            &mut alice,
            group_id.clone(),
            alice_batch.key_handle.clone(),
            plaintext.clone(),
        )
        .expect("send");

        let fixture = serde_json::json!({
            "producedBy": "alpine",
            "ciphersuite": "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
            "openmls": "0.8.1",
            "groupIdB64": group_id,
            "bob": {
                "identity": "bob",
                "signingPublicKey": bob_batch.signing_public_key,
                "signingPrivateKey": bob_batch.signing_private_key,
                "keyPackageB64": bob_batch.key_packages[0].key_package,
                "engine": bob.to_persisted(),
            },
            "welcomeB64": add_bob.welcome.expect("welcome"),
            "commitB64": add_charlie.commit,
            "applicationMessageB64": app.ciphertext,
            "applicationPlaintextB64": plaintext,
        });

        std::fs::create_dir_all(golden_dir()).expect("mkdir");
        std::fs::write(
            golden_dir().join("fixture.json"),
            serde_json::to_vec_pretty(&fixture).expect("serialize"),
        )
        .expect("write fixture");
    }


    // ─── §D backup envelope: export, import, and the restore rules ────────────
    //
    // Untested until now, on both sides. The logout flow told the user it was saving their keys,
    // wrote the envelope, and wiped the keychain, the state file, the registry and the cache - and
    // nothing anywhere had ever asserted that what was written could be read back. It could not:
    // the only TypeScript caller of `mls_import_backup` did not exist, and the command dropped the
    // signing keypair on the floor, so even a wired restore would have worked until the app was
    // next killed and then looked exactly like lost keys.

    /// Exports the state of `mls`, sealed under `passphrase`, for `(user_id, device_id)`.
    fn export_for(
        mls: &MlsState,
        passphrase: &str,
        user_id: &str,
        device_id: &str,
        key_handle: &str,
    ) -> String {
        let mut registry = std::collections::HashMap::new();
        registry.insert("ctx-1#0".to_string(), serde_json::json!("Z3JvdXA="));
        registry.insert("ctx-1#active".to_string(), serde_json::json!(0));

        let mut cache = std::collections::HashMap::new();
        cache.insert("ctx-1#0#msg-1".to_string(), "aGVsbG8=".to_string());

        export_backup(
            mls,
            passphrase.to_string(),
            user_id.to_string(),
            device_id.to_string(),
            "3.0.155".to_string(),
            key_handle.to_string(),
            registry,
            Some(cache),
            None,
        )
        .expect("export")
    }

    #[test]
    fn a_backup_round_trips_on_the_same_device() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 2).expect("key gen");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), batch.key_handle.clone())
            .expect("create group");

        let blob = export_for(&alice, "correct horse", "user-1", "device-a", &batch.key_handle);

        // The wipe the logout flow performs, in the one form that matters here: a completely fresh
        // engine, as a reinstall would produce.
        let mut restored = make_mls();
        let result = import_backup(
            &mut restored,
            blob,
            "correct horse".into(),
            "user-1".into(),
            "device-a".into(),
        )
        .expect("import");

        // Same device id, so §D says the engine comes back too.
        assert!(result.engine_restored);
        assert!(
            get_group_info_impl(&restored, group_id.clone()).is_ok(),
            "the group the backup was taken with must be usable again"
        );

        // The bug this test exists for. The keypair is what `autoUnlock` reads out of the OS
        // keychain on every cold start; an import that only handed back a session handle restored a
        // device that worked until the app was next killed. A test asserting only that the import
        // returned Ok would have passed against exactly that.
        assert_eq!(result.signing_public_key, batch.signing_public_key);
        assert_eq!(result.signing_private_key, batch.signing_private_key);
        assert_eq!(result.identity, "alice");

        // And the two host-side stores, which live outside the engine and come back out for the
        // caller to write.
        assert_eq!(
            result.group_registry.get("ctx-1#0").and_then(|v| v.as_str()),
            Some("Z3JvdXA=")
        );
        assert_eq!(result.message_cache.get("ctx-1#0#msg-1").map(String::as_str), Some("aGVsbG8="));
    }

    #[test]
    fn a_restored_group_can_still_read_what_it_could_read_before() {
        // The user-facing claim: history that was decryptable before the wipe is decryptable after
        // the restore. Asserted through the ratchet rather than through the message cache, so it is
        // the engine state being tested and not the plaintext that travelled beside it.
        let two = setup_two_party();
        let TwoParty { mut alice, mut bob, group_id, alice_handle, bob_handle } = two;

        let blob = export_for(&bob, "pass", "user-bob", "device-bob", &bob_handle);

        let sent = send_message_impl(
            &mut alice,
            group_id.clone(),
            alice_handle.clone(),
            B64.encode("after the backup"),
        )
        .expect("alice sends");

        let mut restored = make_mls();
        import_backup(&mut restored, blob, "pass".into(), "user-bob".into(), "device-bob".into())
            .expect("import");

        let processed = process_message_impl(&mut restored, group_id, sent.ciphertext)
            .expect("the restored engine must decrypt for the group it holds");
        assert_eq!(processed.kind, "application");
        assert_eq!(
            B64.decode(processed.plaintext.expect("plaintext")).expect("b64"),
            b"after the backup"
        );

        // Bob's original engine is untouched by any of this - the restore happened elsewhere.
        let _ = &mut bob;
    }

    #[test]
    fn importing_onto_a_different_device_restores_the_keys_but_not_the_engine() {
        // §D's discriminator is the **device id alone**. An earlier draft also allowed the engine
        // when "the engine holds no groups", which collapsed the two rows into one: a genuinely new
        // device always has an empty engine, so that clause would have cloned ratchet state onto
        // every new device. Two devices sharing a leaf reuse sender-ratchet generations, at least
        // one becomes unable to send, and forward secrecy for that leaf is gone.
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 2).expect("key gen");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), batch.key_handle.clone())
            .expect("create group");

        let blob = export_for(&alice, "pass", "user-1", "device-a", &batch.key_handle);

        let mut fresh = make_mls();
        let result = import_backup(
            &mut fresh,
            blob,
            "pass".into(),
            "user-1".into(),
            // A different handset.
            "device-b".into(),
        )
        .expect("import");

        assert!(!result.engine_restored);
        assert!(
            get_group_info_impl(&fresh, group_id).is_err(),
            "ratchet state must not be cloned onto a second device"
        );

        // Everything §D *does* allow still comes back: the signing keypair, the registry and the
        // cache. Without them the new device could not even name the groups it needs re-admitting
        // to.
        assert_eq!(result.signing_private_key, batch.signing_private_key);
        assert!(!result.group_registry.is_empty());
        assert!(!result.message_cache.is_empty());
    }

    #[test]
    fn a_backup_from_another_account_is_refused() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_for(&alice, "pass", "user-1", "device-a", &batch.key_handle);

        let mut other = make_mls();
        let err = import_backup(
            &mut other,
            blob,
            "pass".into(),
            "someone-else".into(),
            "device-a".into(),
        )
        .expect_err("must refuse");

        // Importing another account's blob would leave this device signing as one identity while
        // holding leaves issued to another.
        assert!(err.contains("different account"), "error was: {err}");
    }

    #[test]
    fn a_wrong_passphrase_is_refused_and_says_what_it_cannot_distinguish() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_for(&alice, "right", "user-1", "device-a", &batch.key_handle);

        let mut fresh = make_mls();
        let err =
            import_backup(&mut fresh, blob, "wrong".into(), "user-1".into(), "device-a".into())
                .expect_err("must refuse");

        // AEAD cannot tell a wrong key from altered bytes, and the message must not pretend it can:
        // sending someone to hunt for a passphrase when the file is truncated is the same mistake
        // as reporting an argument rejection as a bad credential.
        assert!(err.contains("wrong passphrase"), "error was: {err}");
        assert!(err.contains("altered"), "error was: {err}");
    }

    #[test]
    fn a_relabelled_backup_header_is_refused() {
        // The AAD binds the envelope to `(userId, deviceId)`. Re-labelling the header to another
        // device would otherwise let a blob open and then be applied under the wrong identity.
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_for(&alice, "pass", "user-1", "device-a", &batch.key_handle);

        let mut envelope: serde_json::Value = serde_json::from_str(&blob).expect("json");
        envelope["aad"] = serde_json::json!("venta.keybackup.v1|user-1|device-zzz");
        let tampered = serde_json::to_string(&envelope).expect("json");

        let mut fresh = make_mls();
        // The AEAD catches it first, because the AAD is authenticated - which is the stronger
        // outcome than the explicit comparison that follows it.
        assert!(import_backup(
            &mut fresh,
            tampered,
            "pass".into(),
            "user-1".into(),
            "device-a".into()
        )
        .is_err());
    }

    #[test]
    fn an_absurd_declared_kdf_header_is_refused_on_the_import_path() {
        // The blob is a file the user chose, so its header is attacker-controlled, and `m` is a u32
        // of kibibytes - 4 TiB, allocated eagerly, on the recovery path. §L.9. The reader derives
        // from the declared parameters on purpose (that is what keeps a blob written under other
        // values openable), so the ceiling is the only thing standing between a corrupt file and an
        // OOM.
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_for(&alice, "pass", "user-1", "device-a", &batch.key_handle);

        for (field, value) in [("m", u32::MAX), ("t", 1_000_000), ("p", 100_000)] {
            let mut envelope: serde_json::Value = serde_json::from_str(&blob).expect("json");
            envelope["kdf"][field] = serde_json::json!(value);
            let hostile = serde_json::to_string(&envelope).expect("json");

            let mut fresh = make_mls();
            let err = import_backup(
                &mut fresh,
                hostile,
                "pass".into(),
                "user-1".into(),
                "device-a".into(),
            )
            .expect_err("must refuse");
            assert!(
                err.contains("refusing declared Argon2 parameters"),
                "changing kdf.{field} must be refused before Argon2 is asked to allocate: {err}"
            );
        }
    }

    #[test]
    fn a_failed_import_does_not_leave_the_live_engine_half_replaced() {
        // `restore_persisted` clears `groups`, `pending_messages` and the whole provider store
        // before re-inserting, so any fallible step after it is a step that can destroy the running
        // session's state and then return an error. `load_signing_key` was exactly that step: a
        // blob with a valid engine and a corrupt signing key wiped the live engine, replaced it
        // with the backup's, and *then* failed - leaving the session holding foreign state nobody
        // had been told was applied.
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 2).expect("key gen");
        let group_id = rand_group_id();
        create_group_impl(&mut alice, group_id.clone(), batch.key_handle.clone())
            .expect("create group");
        let blob = export_for(&alice, "pass", "user-1", "device-a", &batch.key_handle);

        // A separate live session with a group of its own, standing in for "the app was already
        // running when the user tried to restore the wrong file".
        let mut live = make_mls();
        let live_batch = generate_key_packages_impl(&mut live, "live".into(), 2).expect("key gen");
        let live_group = rand_group_id();
        create_group_impl(&mut live, live_group.clone(), live_batch.key_handle.clone())
            .expect("create group");

        // Corrupt only the signing key, leaving the engine section intact and the AEAD valid - so
        // the failure lands after decryption, at the step ordering has to protect.
        let corrupted = {
            let salt = {
                let envelope: BackupEnvelope = serde_json::from_str(&blob).expect("json");
                B64.decode(&envelope.kdf.salt).expect("b64")
            };
            let key = derive_backup_key("pass", &salt).expect("kdf");
            let envelope: BackupEnvelope = serde_json::from_str(&blob).expect("json");
            let nonce = B64.decode(&envelope.nonce).expect("b64");
            let ct = B64.decode(&envelope.ct).expect("b64");
            let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
            let opened = cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload { msg: &ct, aad: envelope.aad.as_bytes() },
                )
                .expect("decrypt");
            let mut payload: serde_json::Value = serde_json::from_slice(&opened).expect("json");
            payload["signing"]["priv"] = serde_json::json!("!!! not base64 !!!");
            let resealed = cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &serde_json::to_vec(&payload).expect("json"),
                        aad: envelope.aad.as_bytes(),
                    },
                )
                .expect("encrypt");
            let mut re: serde_json::Value = serde_json::from_str(&blob).expect("json");
            re["ct"] = serde_json::json!(B64.encode(resealed));
            serde_json::to_string(&re).expect("json")
        };

        assert!(import_backup(
            &mut live,
            corrupted,
            "pass".into(),
            "user-1".into(),
            "device-a".into()
        )
        .is_err());

        // The session it failed inside still holds its own group, and does not hold the backup's.
        assert!(
            get_group_info_impl(&live, live_group).is_ok(),
            "a failed import must leave the running session exactly as it found it"
        );
        assert!(get_group_info_impl(&live, group_id).is_err());
    }

    #[test]
    fn a_truncated_file_is_refused_as_a_file_problem() {
        let mut fresh = make_mls();
        let err = import_backup(
            &mut fresh,
            "{\"v\":1,\"kdf\":".to_string(),
            "pass".into(),
            "user-1".into(),
            "device-a".into(),
        )
        .expect_err("must refuse");

        // Distinct wording from the passphrase failure: this one is about the file, and telling
        // someone to re-check a passphrase against a truncated file is a wasted afternoon.
        assert!(err.contains("not a backup file"), "error was: {err}");
    }

    // ─── The §H account identity keypair ──────────────────────────────────────
    //
    // Alpine mints none of these - §H is not ported here - but it can be *holding* one: a
    // venta-mobile envelope carries it, `import_backup` has always read it back out, and neither
    // side stored or re-emitted it. Importing a mobile backup on Alpine and exporting again
    // therefore destroyed the account's identity key, silently, on the path whose whole purpose is
    // not to lose key material.

    /// Opens an envelope and hands back its payload, for asserting on what was written.
    fn open_payload(blob: &str, passphrase: &str) -> serde_json::Value {
        let envelope: BackupEnvelope = serde_json::from_str(blob).expect("json");
        let salt = B64.decode(&envelope.kdf.salt).expect("b64");
        let key = derive_backup_key(passphrase, &salt).expect("kdf");
        let nonce = B64.decode(&envelope.nonce).expect("b64");
        let ct = B64.decode(&envelope.ct).expect("b64");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        let opened = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload { msg: &ct, aad: envelope.aad.as_bytes() },
            )
            .expect("decrypt");
        serde_json::from_slice(&opened).expect("json")
    }

    fn export_with_identity(
        mls: &MlsState,
        key_handle: &str,
        identity: Option<BackupAccountIdentity>,
    ) -> String {
        export_backup(
            mls,
            "pass".to_string(),
            "user-1".to_string(),
            "device-a".to_string(),
            "3.0.155".to_string(),
            key_handle.to_string(),
            std::collections::HashMap::new(),
            None,
            identity,
        )
        .expect("export")
    }

    #[test]
    fn an_account_identity_key_is_written_when_the_caller_holds_one() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");

        let blob = export_with_identity(
            &alice,
            &batch.key_handle,
            Some(BackupAccountIdentity {
                pub_: "YWNjb3VudC1wdWI=".to_string(),
                priv_: "YWNjb3VudC1wcml2".to_string(),
            }),
        );

        let payload = open_payload(&blob, "pass");
        assert_eq!(payload["accountIdentity"]["pub"], "YWNjb3VudC1wdWI=");
        assert_eq!(payload["accountIdentity"]["priv"], "YWNjb3VudC1wcml2");
    }

    #[test]
    fn the_account_identity_key_is_absent_rather_than_null_when_there_is_none() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");

        let payload = open_payload(&export_with_identity(&alice, &batch.key_handle, None), "pass");

        // Present-and-null is worse than absent: mobile's import reads this field, and a
        // half-formed one turns "this backup has no account identity key" into "this backup's
        // account identity key is unusable".
        assert!(
            payload.get("accountIdentity").is_none(),
            "an absent key must not be written as null: {payload:?}"
        );
    }

    #[test]
    fn an_account_identity_key_survives_a_round_trip() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_with_identity(
            &alice,
            &batch.key_handle,
            Some(BackupAccountIdentity {
                pub_: "YWNjb3VudC1wdWI=".to_string(),
                priv_: "YWNjb3VudC1wcml2".to_string(),
            }),
        );

        let mut fresh = make_mls();
        let result =
            import_backup(&mut fresh, blob, "pass".into(), "user-1".into(), "device-a".into())
                .expect("import");

        assert_eq!(result.account_identity_public_key.as_deref(), Some("YWNjb3VudC1wdWI="));
        assert_eq!(result.account_identity_private_key.as_deref(), Some("YWNjb3VudC1wcml2"));
    }

    #[test]
    fn a_backup_without_an_account_identity_key_imports_with_none() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_with_identity(&alice, &batch.key_handle, None);

        let mut fresh = make_mls();
        let result =
            import_backup(&mut fresh, blob, "pass".into(), "user-1".into(), "device-a".into())
                .expect("import");

        assert!(result.account_identity_public_key.is_none());
        assert!(result.account_identity_private_key.is_none());
    }

    // ─── Version rejection, split by remedy ───────────────────────────────────

    /// Re-labels an envelope's declared version without touching the sealed payload.
    fn with_declared_version(blob: &str, version: u32) -> String {
        let mut envelope: serde_json::Value = serde_json::from_str(blob).expect("json");
        envelope["v"] = serde_json::json!(version);
        serde_json::to_string(&envelope).expect("json")
    }

    #[test]
    fn a_newer_and_an_older_backup_are_refused_with_different_words() {
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_with_identity(&alice, &batch.key_handle, None);

        let newer = import_backup(
            &mut make_mls(),
            with_declared_version(&blob, BACKUP_VERSION + 1),
            "pass".into(),
            "user-1".into(),
            "device-a".into(),
        )
        .expect_err("a newer envelope must be refused");

        let older = import_backup(
            &mut make_mls(),
            with_declared_version(&blob, BACKUP_VERSION - 1),
            "pass".into(),
            "user-1".into(),
            "device-a".into(),
        )
        .expect_err("an older envelope must be refused");

        // The remedies are opposites and only one of them is "update". Collapsed into a single
        // message - which is what shipped - the UI told a user holding an older file to update the
        // app, advice that cannot work and that leaves them further from the build that could
        // have read it. `classifyBackupImport` in mls.service.ts matches on these exact phrases.
        assert!(newer.contains("is newer than this build supports"), "error was: {newer}");
        assert!(older.contains("is older than this build supports"), "error was: {older}");
        assert_ne!(newer, older);
    }

    #[test]
    fn the_message_cache_is_omitted_when_the_caller_says_so() {
        // §H.6: the cache is the single most sensitive thing in the envelope, and the cloud target
        // passes `None`. `messageCache: None` *is* `includeMessageCache: false`.
        let mut alice = make_mls();
        let batch = generate_key_packages_impl(&mut alice, "alice".into(), 1).expect("key gen");
        let blob = export_backup(
            &alice,
            "pass".to_string(),
            "user-1".to_string(),
            "device-a".to_string(),
            "3.0.155".to_string(),
            batch.key_handle.clone(),
            std::collections::HashMap::new(),
            None,
            None,
        )
        .expect("export");

        let mut fresh = make_mls();
        let result =
            import_backup(&mut fresh, blob, "pass".into(), "user-1".into(), "device-a".into())
                .expect("import");
        assert!(result.message_cache.is_empty());
    }

    // ─── Engine pin and Tauri surface ─────────────────────────────────────────
    //
    // The two engines are meant to share logic and differ only at the edges. That pin existed as a
    // comment in `venta_mls/rust/Cargo.toml` ("Bump both together or neither") and was worth
    // exactly what comments are worth: this file was silently replaced by a byte-for-byte copy of
    // mobile's engine and committed, which deleted Alpine's entire Tauri command surface. The build
    // broke, but only after the fact and with 59 cascading errors that named none of the cause.
    //
    // These two tests make the pin an assertion. The golden vectors above cover behavioural drift;
    // these cover the structural half.

    /// Every `#[tauri::command]` the frontend invokes must exist in this file, by name.
    ///
    /// Mobile's engine has none - it exposes plain `pub fn`s over a process-global mutex, because
    /// Flutter has no `State`/`AppHandle`. An empty set is the unmistakable signature of this file
    /// having been overwritten with the other client's, which is exactly what happened.
    ///
    /// Asserted as an exact set rather than a count. A count is self-defeating here: this test's
    /// own source contains the literal it searches for, so `source.matches(...)` read 28 against a
    /// `>= 25` threshold - and losing precisely three commands, which was the live situation when
    /// this was written, would have read 25 and passed.
    #[test]
    fn the_tauri_command_surface_is_present() {
        let found = tauri_command_names(include_str!("mls.rs"));

        let expected: std::collections::BTreeSet<&str> = [
            "generate_mls_key_packages",
            "mls_add_members",
            "mls_clear_pending_commit",
            "mls_clear_storage",
            "mls_commit_pending_proposals",
            "mls_create_group",
            "mls_current_state_dir",
            "mls_delete_group",
            "mls_drain_pending_messages",
            "mls_export_backup",
            "mls_export_group_info",
            "mls_export_state",
            "mls_generate_key_packages_with_handle",
            "mls_get_group_info",
            "mls_get_members",
            "mls_import_backup",
            "mls_import_state",
            "mls_init_storage",
            "mls_inspect_key_package",
            "mls_join_group",
            "mls_leave_group",
            "mls_load_signing_key",
            "mls_merge_pending_commit",
            "mls_process_message",
            "mls_rejoin_group",
            "mls_remove_members",
            "mls_send_message",
            "mls_signing_key_fingerprint",
            "mls_unload_signing_key",
        ]
        .into_iter()
        .collect();

        let missing: Vec<_> = expected.difference(&found).collect();
        assert!(
            missing.is_empty(),
            "the Tauri surface has lost {missing:?}. Every one of these is invoked from \
             TypeScript, so a missing command is a runtime 'command not found' the unit tests \
             cannot see - they mock the IPC boundary. An empty set means this file has been \
             replaced with venta-mobile's engine."
        );

        // Exact, in both directions, now that the re-port from mobile has landed. While it was
        // outstanding a gained command was merely reported, because the expected set was known to
        // be behind the file; keeping that leniency afterwards would mean a command could be added
        // here and never registered in `lib.rs`, which is a runtime 'command not found' with a
        // green test suite - the precise failure this test exists to make impossible.
        let added: Vec<_> = found.difference(&expected).collect();
        assert!(
            added.is_empty(),
            "the Tauri surface has gained {added:?}. Add each one to this set *and* to both \
             `invoke_handler` blocks in lib.rs - defining a command without registering it \
             compiles cleanly and fails only when the frontend calls it."
        );
    }

    /// The same exact-set assertion for `crypto.rs`, which the original pin did not cover.
    ///
    /// It was scoped to this file because this file was the one that got overwritten. That is a
    /// reason to have written it, not a reason to have stopped there: the master-key surface is
    /// smaller, changes less often, and is the one nothing else would notice losing - every command
    /// on it sits on a path a user reaches once, under stress, after a password reset.
    #[test]
    fn the_crypto_command_surface_is_present() {
        let found = tauri_command_names(include_str!("crypto.rs"));

        let expected: std::collections::BTreeSet<&str> = [
            "decrypt_master_key",
            "generate_key",
            "generate_key_pairs",
            "generate_recovery_code",
            "normalize_recovery_code_checked",
            "rewrap_master_key",
            "setup_master_key",
            "setup_master_key_dual",
        ]
        .into_iter()
        .collect();

        assert_eq!(
            found, expected,
            "crypto.rs's Tauri surface has drifted. Every name here must also appear in both \
             `invoke_handler` blocks in lib.rs."
        );
    }

    /// Every argument a `#[tauri::command]` requires must be supplied at its TypeScript call site.
    ///
    /// <p><b>This is the check whose absence hid C2.</b> `rewrap_master_key` takes five arguments
    /// and was invoked with three: `from_kind` and `to_kind` are `CredentialKind`, which has no
    /// `Default` and is not `Option`, so *every* call failed during argument deserialization -
    /// before a single line of crypto ran. No Alpine user could obtain a recovery code, and a user
    /// mid-recovery holding a correct code was told it was wrong. The compiler cannot see across
    /// the IPC boundary, `the_tauri_command_surface_is_present` pinned names only, and
    /// `master-key-state.service.spec.ts` mocks `MasterKeyService` wholesale - so a command that
    /// failed 100% of the time was invisible to a green suite in two languages.</p>
    ///
    /// <p>Both directions are asserted. A missing <i>required</i> argument is the fatal case; an
    /// extra TypeScript key is asserted too, because a renamed parameter shows up that way and is
    /// equally fatal. `Option<T>` parameters may be omitted - Tauri deserializes an absent key as
    /// `None`, which is exactly what `CredentialKind` could not do.</p>
    #[test]
    fn the_tauri_argument_names_match_the_typescript_call_sites() {
        let typescript = typescript_sources();
        assert!(
            !typescript.is_empty(),
            "no TypeScript sources found under ../src - this test would pass vacuously"
        );

        let mut uncalled: Vec<String> = Vec::new();
        let mut problems: Vec<String> = Vec::new();

        for source in [include_str!("mls.rs"), include_str!("crypto.rs")] {
            for (command, params) in tauri_command_signatures(source) {
                let required: std::collections::BTreeSet<String> = params
                    .iter()
                    .filter(|(_, optional)| !optional)
                    .map(|(name, _)| name.clone())
                    .collect();
                let known: std::collections::BTreeSet<String> =
                    params.iter().map(|(name, _)| name.clone()).collect();

                let mut called = false;
                for (path, invocations) in &typescript {
                    for supplied in invocations
                        .iter()
                        .filter(|(invoked, _)| *invoked == command)
                        .map(|(_, args)| args)
                    {
                        called = true;

                        let missing: Vec<_> = required.difference(&supplied).collect();
                        if !missing.is_empty() {
                            problems.push(format!(
                                "{path}: `{command}` is invoked without {missing:?}. Every one is \
                                 a required Rust parameter, so the call fails at argument \
                                 deserialization and never reaches the command body."
                            ));
                        }

                        let unknown: Vec<_> = supplied.difference(&known).collect();
                        if !unknown.is_empty() {
                            problems.push(format!(
                                "{path}: `{command}` is invoked with {unknown:?}, which the Rust \
                                 signature does not declare. A renamed parameter looks exactly \
                                 like this."
                            ));
                        }
                    }
                }

                if !called {
                    uncalled.push(command);
                }
            }
        }

        assert!(problems.is_empty(), "\n{}", problems.join("\n"));

        // Reported, not failed. A command with no caller is dead weight rather than a break -
        // today that is `mls_current_state_dir`, mobile's shape ported for parity, which Alpine's
        // desktop process has no equivalent hazard to guard against.
        //
        // `mls_rejoin_group` *is* reachable from `MlsService.rejoinGroup`, which itself has no
        // production caller. That is deliberate and must stay so until §H.4's certificate
        // validation lands: external-committing on a server-supplied GroupInfo is exactly what that
        // section exists to stop, so the unwired primitive is the safe state, not an oversight.
        if !uncalled.is_empty() {
            eprintln!("Tauri commands with no TypeScript call site: {uncalled:?}");
        }
    }

    // ─── Parsing helpers for the three tests above ────────────────────────────

    /// Names of every `#[tauri::command] pub fn` in `source`.
    ///
    /// Only an attribute directly followed by `pub fn` counts, which is what excludes the string
    /// literals in these tests and in the doc comments around them.
    fn tauri_command_names(source: &str) -> std::collections::BTreeSet<&str> {
        source
            .split("#[tauri::command]")
            .skip(1)
            .filter_map(|rest| {
                let decl = rest.trim_start();
                let name = decl.strip_prefix("pub fn ")?;
                Some(&name[..name.find('(')?])
            })
            .collect()
    }

    /// `(command, [(camelCaseArgName, isOptional)])` for every command in `source`.
    ///
    /// Tauri injects `State`, `AppHandle` and `Window` itself, so those never travel over IPC and
    /// are dropped. Everything else has to be supplied by the caller.
    fn tauri_command_signatures(source: &str) -> Vec<(String, Vec<(String, bool)>)> {
        source
            .split("#[tauri::command]")
            .skip(1)
            .filter_map(|rest| {
                let decl = rest.trim_start();
                let after_fn = decl.strip_prefix("pub fn ")?;
                let open = after_fn.find('(')?;
                let name = after_fn[..open].to_string();

                let close = matching_paren(after_fn, open)?;
                let params = split_top_level(&after_fn[open + 1..close])
                    .into_iter()
                    .filter_map(|param| {
                        let (ident, ty) = param.split_once(':')?;
                        let ty = ty.trim();
                        if ty.contains("State<") || ty.contains("AppHandle") || ty.contains("Window")
                        {
                            return None;
                        }
                        Some((to_camel_case(ident.trim()), ty.starts_with("Option<")))
                    })
                    .collect();

                Some((name, params))
            })
            .collect()
    }

    fn matching_paren(text: &str, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        for (i, b) in text.as_bytes().iter().enumerate().skip(open) {
            match b {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// Splits on commas that are not inside `<>`, `()` or `[]`.
    ///
    /// `Option<Vec<u8>>` and `Map<String, JsonValue>` both contain punctuation a naive
    /// `split(',')` would tear in half.
    fn split_top_level(list: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut depth = 0i32;
        let mut current = String::new();
        for c in list.chars() {
            match c {
                '<' | '(' | '[' => {
                    depth += 1;
                    current.push(c);
                }
                '>' | ')' | ']' => {
                    depth -= 1;
                    current.push(c);
                }
                ',' if depth == 0 => {
                    if !current.trim().is_empty() {
                        out.push(current.trim().to_string());
                    }
                    current.clear();
                }
                _ => current.push(c),
            }
        }
        if !current.trim().is_empty() {
            out.push(current.trim().to_string());
        }
        out
    }

    fn to_camel_case(snake: &str) -> String {
        let mut out = String::with_capacity(snake.len());
        let mut upper_next = false;
        for c in snake.chars() {
            if c == '_' {
                upper_next = true;
            } else if upper_next {
                out.extend(c.to_uppercase());
                upper_next = false;
            } else {
                out.push(c);
            }
        }
        out
    }

    /// Every IPC invocation found in every `.ts` file under `../src`, excluding specs.
    ///
    /// Specs assert *about* command names rather than invoking them, and a partial-argument
    /// assertion in one would read as a broken call site.
    type Invocation = (String, std::collections::BTreeSet<String>);
    fn typescript_sources() -> Vec<(String, Vec<Invocation>)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(String, Vec<Invocation>)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("ts")
                    && !path.to_string_lossy().ends_with(".spec.ts")
                {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        out.push((
                            path.file_name().unwrap().to_string_lossy().into_owned(),
                            invocations_in(&text),
                        ));
                    }
                }
            }
        }

        let mut out = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("src"),
            &mut out,
        );
        out
    }

    /// `(command, argument keys)` for every `invoke` / `call` / `callOptional` in one file.
    ///
    /// <p>Anchored on the *callee*, not on the command string. Searching for the bare literal also
    /// found `new MlsFeatureUnavailableError('mls_export_backup')`, whose `)` reads as a zero-argument
    /// invocation - a false report of the exact failure this test exists to detect, which is the
    /// one kind of false positive that would get the whole test deleted.</p>
    ///
    /// <p>An invocation with no argument object - `invoke('mls_clear_storage')` - yields an empty
    /// set rather than nothing, so a command that later gains a required parameter still fails.</p>
    fn invocations_in(text: &str) -> Vec<Invocation> {
        const CALLEES: [&str; 3] = ["invoke", "call", "callOptional"];
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0usize;

        // ASCII only, deliberately. `(0xC2 as char)` is 'Â', which `is_alphanumeric()` accepts -
        // so a UTF-8 lead byte inside a doc comment read as an identifier character and the slice
        // below then landed mid-codepoint.
        let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';

        while i < bytes.len() {
            if !is_ident(bytes[i]) || (i > 0 && is_ident(bytes[i - 1])) {
                i += 1;
                continue;
            }
            let start = i;
            while i < bytes.len() && is_ident(bytes[i]) {
                i += 1;
            }
            let ident = &text[start..i];
            if !CALLEES.contains(&ident) {
                continue;
            }

            let mut j = i;
            let skip_ws = |j: &mut usize| {
                while *j < bytes.len() && (bytes[*j] as char).is_whitespace() {
                    *j += 1;
                }
            };

            // An explicit type argument - `invoke<MlsBackupImportResult>(...)` - sits between the
            // callee and the parenthesis. Depth-counted, because `call<Record<string, unknown>>`
            // nests.
            skip_ws(&mut j);
            if bytes.get(j) == Some(&b'<') {
                let mut depth = 0i32;
                while j < bytes.len() {
                    match bytes[j] {
                        b'<' => depth += 1,
                        b'>' => {
                            depth -= 1;
                            if depth == 0 {
                                j += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
            }

            skip_ws(&mut j);
            if bytes.get(j) != Some(&b'(') {
                continue;
            }
            j += 1;
            skip_ws(&mut j);

            // A non-literal first argument is the declaration of `call` itself, or a dynamic
            // dispatch. Nothing to check either way.
            let Some(quote @ (b'\'' | b'"')) = bytes.get(j).copied() else {
                continue;
            };
            j += 1;
            let name_start = j;
            while j < bytes.len() && bytes[j] != quote {
                j += 1;
            }
            let command = text[name_start..j].to_string();
            j += 1;

            skip_ws(&mut j);
            match bytes.get(j).copied() {
                Some(b')') => out.push((command, Default::default())),
                Some(b',') => {
                    j += 1;
                    skip_ws(&mut j);
                    if bytes.get(j) == Some(&b'{') {
                        if let Some(keys) = object_literal_keys(text, j) {
                            out.push((command, keys));
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// Top-level keys of the JS object literal starting at `text[start] == '{'`.
    ///
    /// Handles shorthand (`{groupIdB64}`), `key: value`, nesting, strings and line comments -
    /// everything the real call sites use, and nothing they do not.
    fn object_literal_keys(text: &str, start: usize) -> Option<std::collections::BTreeSet<String>> {
        let bytes = text.as_bytes();
        let mut keys = std::collections::BTreeSet::new();
        let mut i = start + 1;
        let mut depth = 1i32;
        let mut expect_key = true;

        while i < bytes.len() {
            let c = bytes[i] as char;
            match c {
                '{' | '[' | '(' => {
                    depth += 1;
                    i += 1;
                    expect_key = false;
                }
                '}' | ']' | ')' => {
                    depth -= 1;
                    i += 1;
                    if depth == 0 {
                        return Some(keys);
                    }
                    expect_key = false;
                }
                ',' if depth == 1 => {
                    i += 1;
                    expect_key = true;
                }
                '\'' | '"' | '`' => {
                    let quote = c;
                    i += 1;
                    while i < bytes.len() && bytes[i] as char != quote {
                        i += if bytes[i] == b'\\' { 2 } else { 1 };
                    }
                    i += 1;
                    expect_key = false;
                }
                '/' if bytes.get(i + 1) == Some(&b'/') => {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                }
                _ if c.is_whitespace() => i += 1,
                _ => {
                    // ASCII only - see `invocations_in`. A multi-byte lead byte that passes
                    // `char::is_alphanumeric` makes the slice below land mid-codepoint.
                    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
                    if expect_key && depth == 1 && is_ident(bytes[i]) {
                        let begin = i;
                        while i < bytes.len() && is_ident(bytes[i]) {
                            i += 1;
                        }
                        keys.insert(text[begin..i].to_string());
                    } else {
                        i += 1;
                    }
                    expect_key = false;
                }
            }
        }
        None
    }

    /// The crypto dependencies both engines share must be pinned to the same versions.
    ///
    /// MLS is a wire protocol: a different `openmls` can change TLS-serialized shapes, and a client
    /// that cannot deserialize a Welcome written by the other is locked out of every group it is
    /// invited to. Bumping one side alone is the failure this guards.
    ///
    /// Skipped with a warning when the sibling checkout is absent, so this is a developer-machine
    /// and CI-with-both-repos check rather than a hard build dependency on a fixed path.
    #[test]
    fn the_shared_engine_dependencies_are_pinned_together() {
        let sibling = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("venta-mobile")
            .join("venta_mobile")
            .join("packages")
            .join("venta_mls")
            .join("rust")
            .join("Cargo.toml");

        let Ok(mobile) = std::fs::read_to_string(&sibling) else {
            eprintln!(
                "\n!!! ENGINE PIN NOT CHECKED !!!\nNo venta-mobile checkout at {}. The two engines' \
                 shared crypto dependencies were not compared this run.\n",
                sibling.display()
            );
            return;
        };

        let ours = include_str!("../../Cargo.toml");

        // Only the crates whose behaviour crosses the wire. Everything else may legitimately differ.
        for crate_name in [
            "openmls",
            "openmls_rust_crypto",
            "openmls_basic_credential",
            "aes-gcm",
            "base64",
            "sha2",
            "hkdf",
            "hmac",
        ] {
            let theirs = pinned_version(&mobile, crate_name);
            let mine = pinned_version(ours, crate_name);
            assert_eq!(
                mine, theirs,
                "`{crate_name}` is pinned to {mine:?} here and {theirs:?} in venta-mobile. The two \
                 engines must be bumped together or neither - a divergence here is a divergence in \
                 the wire protocol."
            );
        }
    }

    /// The major.minor of a crate's version requirement, or None when it is absent.
    ///
    /// Compared at major.minor rather than exactly, because `0.10` and `0.10.3` resolve to the same
    /// crate under Cargo's semver rules and a patch-level difference in the manifests is not a
    /// protocol difference.
    fn pinned_version(manifest: &str, crate_name: &str) -> Option<String> {
        manifest
            .lines()
            .map(str::trim)
            .find(|line| {
                line.starts_with(&format!("{crate_name} ="))
                    || line.starts_with(&format!("{crate_name}="))
            })
            .and_then(|line| {
                let quoted = line.split('"').nth(1)?;
                let mut parts = quoted.split('.');
                Some(format!("{}.{}", parts.next()?, parts.next()?))
            })
    }

    #[test]
    fn the_version_comparison_discriminates() {
        // Verifies the mechanism the pin test relies on. A full end-to-end mutation would mean
        // editing Cargo.toml to a different openmls and rebuilding the crate, which takes minutes
        // and can fail to compile for unrelated API reasons - so the comparison itself is pinned
        // here instead.
        let a = "openmls = \"0.8.1\"\nsha2 = \"0.10\"\n";
        let b = "openmls = \"0.7.4\"\nsha2 = \"0.10.3\"\n";

        // Differing minor is caught.
        assert_ne!(pinned_version(a, "openmls"), pinned_version(b, "openmls"));
        // A patch-only difference is not, on purpose: 0.10 and 0.10.3 resolve to the same crate.
        assert_eq!(pinned_version(a, "sha2"), pinned_version(b, "sha2"));
        // An absent crate is distinguishable from a present one.
        assert_eq!(pinned_version(a, "hkdf"), None);
        assert_eq!(pinned_version(a, "openmls"), Some("0.8".to_string()));
    }

}
