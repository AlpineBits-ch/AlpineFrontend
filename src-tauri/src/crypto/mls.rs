//! MLS (RFC 9420) group engine.
//!
//! Ported from Alpine's `src-tauri/src/crypto/mls.rs`. The logic is deliberately
//! kept line-for-line equivalent: both clients talk to the same server, join the
//! same groups and read each other's ciphertext, so any divergence here is a
//! divergence in the wire protocol. The only things that changed are the edges -
//! Tauri's `State`/`AppHandle` became a process-global `Mutex` and an explicitly
//! passed storage path, because Flutter has neither.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use aes_gcm::{
    aead::{Aead, Payload},
    {Aes256Gcm, KeyInit, Nonce},
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
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

/// Must match Alpine's exactly. A group created under one ciphersuite cannot be
/// joined by a device offering a key package built under another.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

// ---------------------------------------------------------------------------
// Output types (serialized to JSON across the FFI boundary)
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
    /// GroupInfo for the epoch this commit **establishes**, produced by the
    /// commit itself.
    ///
    /// Publish this rather than calling `export_group_info`. Both engines used
    /// to discard openmls's third return value as `_group_info` and export one
    /// separately - but an exported GroupInfo can only ever describe the epoch
    /// the group is on *now*, and a commit is deliberately not merged until the
    /// server accepts it. So every published GroupInfo was one epoch stale, and
    /// a device recovering by external commit landed behind the group it was
    /// rejoining. No amount of reordering export-versus-merge fixes that; the
    /// value openmls hands back is the only one that describes the right epoch.
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

/// Everything a reviewer needs to decide whether a key package really belongs to
/// who it claims.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsKeyPackageInfo {
    /// Identity from the BasicCredential - the user id the package claims.
    pub identity: String,
    /// Long-lived Ed25519 signature key (base64).
    pub signature_public_key: String,
    /// Human-comparable fingerprint of the *signature* key.
    ///
    /// Deliberately not a hash of the key package: that changes with every
    /// package a device mints, so two people reading it to each other would
    /// never agree on anything. The signature key is the device's stable
    /// identity, so this is the value that means something out of band.
    pub signature_key_fingerprint: String,
    /// SHA-256 of the key package bytes, hex. Binds an approval to these exact
    /// bytes.
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

    /// Loaded, but with nowhere to save.
    ///
    /// What an iOS notification-service extension needs: it is a *separate
    /// process* from the app, so it would load state at one moment and write it
    /// back at another, and anything the app committed in between would be
    /// overwritten by the older copy. Stated as its own flag rather than
    /// inferred from a missing `state_path`, because "deliberately not saving"
    /// and "never initialised" need opposite treatment and used to be the same
    /// branch.
    read_only: bool,
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

    /// Writes via a temp file, an fsync, and a rename.
    ///
    /// Android kills backgrounded apps freely and a half-written
    /// `mls_state.json` is not a recoverable state - it is every group this
    /// device belongs to, gone. The rename makes the replacement atomic, but
    /// only the `sync_all` makes it *ordered*: without it the directory entry
    /// can reach the disk before the bytes it points at, so a power loss between
    /// the two leaves a file that is valid to the filesystem and empty to us.
    ///
    /// A missing `state_path` is an **error**, not a no-op.
    ///
    /// It used to return `Ok(())`, which meant an engine that was never
    /// initialised - or whose initialisation failed - performed every operation
    /// perfectly and persisted none of it. Every group it joined and every
    /// commit it merged would vanish on the next launch, and nothing anywhere
    /// said so. The one legitimate no-save case is [`MlsState::read_only`],
    /// which is stated explicitly rather than inferred from an absent path.
    fn save_to_disk(&self) -> Result<(), String> {
        if self.read_only {
            return Ok(());
        }
        let Some(path) = &self.state_path else {
            return Err(
                "MlsError: MLS storage is not initialised - initStorage must succeed before any \
                 group operation, or the operation is silently lost"
                    .to_string(),
            );
        };
        let json = serde_json::to_vec(&self.to_persisted()).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        {
            let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut file, &json).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// How many early messages one group may hold before the oldest is dropped.
///
/// Unbounded would let a peer that keeps sending from a future epoch grow this
/// without limit, and the buffer is persisted, so it would grow the state file
/// too. The oldest goes first: by the time we catch up it is the one most likely
/// to be past the ratchet's reach anyway.
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

static STATE: OnceLock<Mutex<MlsState>> = OnceLock::new();

/// The one MLS state for the process.
///
/// A poisoned mutex is recovered from rather than propagated: the poison means
/// some earlier call panicked, not that the group data is wrong, and refusing
/// every subsequent call would turn one bad message into a permanently dead
/// engine.
pub fn with_state<T>(f: impl FnOnce(&mut MlsState) -> Result<T, String>) -> Result<T, String> {
    let mutex = STATE.get_or_init(|| Mutex::new(MlsState::default()));
    let mut guard = match mutex.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&mut guard)
}

// ---------------------------------------------------------------------------
// Encryption helpers (encrypted state backup)
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

/// Prefixes the error with a kind the Dart side can branch on. Same vocabulary
/// as Alpine's `parseMlsError`, because the two clients hit the same failures
/// and a `WrongEpoch` has to mean "buffer and retry" on both.
pub fn map_mls_error(e: impl std::fmt::Display) -> String {
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

fn create_config() -> MlsGroupCreateConfig {
    let ratchet_config = SenderRatchetConfiguration::new(
        500, // max_forward_distance
        10,  // out_of_order_tolerance
    );
    MlsGroupCreateConfig::builder()
        .sender_ratchet_configuration(ratchet_config)
        .use_ratchet_tree_extension(true)
        .build()
}

fn join_config() -> MlsGroupJoinConfig {
    let ratchet_config = SenderRatchetConfiguration::new(500, 10);
    MlsGroupJoinConfig::builder()
        .sender_ratchet_configuration(ratchet_config)
        .use_ratchet_tree_extension(true)
        .build()
}

fn serialize_welcome(welcome_msg: openmls::prelude::MlsMessageOut) -> Result<String, String> {
    welcome_msg
        .tls_serialize_detached()
        .map(|b| B64.encode(&b))
        .map_err(|e| e.to_string())
}

/// The GroupInfo openmls hands back with a commit - the one describing the epoch
/// that commit *establishes*. See [`MlsCommitOut::group_info`] for why it has to
/// be this one and never an exported one.
/// Wrapped in an `MlsMessageOut` on the way out, because that is the shape
/// `rejoin_group` reads back off the wire - openmls hands the commit's GroupInfo
/// over as the bare struct.
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
        // Deliberately *not* merged here. The server accepts exactly one commit
        // per epoch, so a commit that loses that race must never have been
        // applied locally - a group that advanced on a commit nobody else has is
        // forked, and MLS gives no way to walk that back. The caller merges via
        // `merge_pending_commit` once the server takes it, or discards via
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

/// In MLS a member cannot commit their own removal, so this produces a Remove
/// *proposal*. Callers broadcast it so a remaining member can commit it via
/// [`commit_pending_proposals`]. Local group state is dropped immediately, so
/// the leaver loses access whether or not anyone ever commits it.
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
            // A proposal establishes no epoch, so there is no GroupInfo to
            // describe - and local state is already gone by this point.
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

/// Second half of the two-phase commit dance: applies a staged commit once the
/// server has accepted it. Safe to retry - merging with nothing staged is a
/// no-op, so a client that published and then died can merge on next launch.
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

/// Discards a staged commit the server refused, leaving the group where it was.
/// This is the losing side of a concurrent-commit race; applying a commit the
/// server did not take would fork this device off the group permanently.
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
    let msg_in = MlsMessageIn::tls_deserialize_exact_bytes(&msg_bytes).map_err(|e| e.to_string())?;
    let protocol_msg = msg_in
        .try_into_protocol_message()
        .map_err(|e| e.to_string())?;
    let message_epoch = protocol_msg.epoch().as_u64();

    // A message from an epoch we have not reached yet is early, not wrong.
    // Dropping it loses it for good - the wire copy decrypts exactly once - so
    // it waits for the commit that makes it readable and `drain_pending_messages`
    // picks it up afterwards. `pending_messages` was declared, retained and
    // cleared but never actually written to, so this buffer did not exist and an
    // early message was simply gone.
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
                // `>=`, not `>`. Anything below where we now are can never be
                // decrypted - the ratchet only moves forward - but a message
                // *at* the new epoch is exactly the one this commit just made
                // readable, and the old `>` threw away precisely those.
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

    // The same message twice - a socket delivery racing a REST page - must not
    // accumulate. Both carry the same server-side id.
    if let Some(id) = &message_id {
        if buf.iter().any(|m| m.message_id.as_deref() == Some(id)) {
            return;
        }
    }

    if buf.len() >= MAX_BUFFERED_PER_GROUP {
        // Oldest first: by the time we catch up it is the one most likely to be
        // past the ratchet's reach anyway, so it is the cheapest to give up on.
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
/// Call after applying commits. Messages still ahead of the group stay buffered;
/// messages the ratchet has moved past are dropped, because retrying them
/// forever would be a permanent background failure that never resolves.
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
            // Past the ratchet's reach. Dropped rather than kept: it can never
            // succeed, and keeping it would be a failure that retries forever.
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
            // Only application messages are ever buffered - commits arrive
            // through the ordered catch-up, which never runs ahead of the group.
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

/// Renders a fingerprint as five-character groups, which is what makes it
/// readable aloud without losing your place. Uppercase hex over the SHA-256 of
/// the key, truncated to 80 bits.
fn format_fingerprint(bytes: &[u8]) -> String {
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

/// The fingerprint for a signature public key, without needing a key package.
///
/// A device's *own* fingerprint is a pure function of its long-lived signing
/// key, which the caller already holds. Deriving it by minting a key package
/// just to inspect it would write a fresh init keypair into the engine's store
/// on every call - permanently, since nothing ever consumes it - and the store
/// is rewritten in full on every save, so that cost lands on every later
/// encrypt and decrypt too.
pub fn fingerprint_for_signature_key(signature_public_key_b64: &str) -> Result<String, String> {
    let key = B64
        .decode(signature_public_key_b64)
        .map_err(|e| e.to_string())?;
    Ok(format_fingerprint(&key))
}

/// Inspects a key package so a reviewer can check who it really belongs to
/// before vouching for it, and so the committing client can confirm the bytes
/// match what was approved.
pub fn inspect_key_package(
    mls: &MlsState,
    key_package_b64: &str,
) -> Result<MlsKeyPackageInfo, String> {
    let kp_bytes = B64.decode(key_package_b64).map_err(|e| e.to_string())?;
    let kp_in = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]).map_err(|e| e.to_string())?;

    // Validated, not merely parsed. A reviewer must never be shown an identity
    // lifted from a malformed or expired package that would then be rejected at
    // add time - or worse, be talked into approving one whose signature does not
    // actually check out.
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

/// Points the engine at `<dir>/mls_state.json` and restores whatever is there.
///
/// Returns `true` when state was restored, `false` when starting fresh. The
/// path is passed in rather than discovered: Flutter owns the app's directory
/// layout via `path_provider`, and the Rust side guessing at it would disagree
/// with wherever the rest of the app stores things.
///
/// `read_only` loads the state but leaves the engine with nowhere to save,
/// which is what an iOS notification-service extension needs. The extension is
/// a *separate process* from the app: it would load state at one moment and
/// write it back at another, and anything the app committed in between - a new
/// group, a merged commit - would be silently overwritten by the older copy.
/// Decrypting one notification is not worth that risk, and the plaintext it
/// produces is kept in the message cache anyway, so nothing is lost by throwing
/// the advanced ratchet away.
pub fn init_storage(mls: &mut MlsState, dir: &str, read_only: bool) -> Result<bool, String> {
    let dir_path = PathBuf::from(dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| e.to_string())?;
    let state_path = dir_path.join("mls_state.json");

    // Already pointing here. A second Dart isolate in the same process - which is
    // exactly what Android's FCM background handler is - re-initialises on every
    // push, and re-reading the file over live state would drop anything the main
    // isolate has in memory but has not yet saved.
    if !read_only && mls.state_path.as_deref() == Some(state_path.as_path()) {
        return Ok(state_path.exists());
    }

    // Pointing somewhere new. Everything currently loaded belongs to whatever
    // was here before - a different account on this handset, in practice - and
    // it has to go before this directory's state comes in.
    //
    // This used to be an insert into whatever was already in the provider,
    // which merged two accounts' key material into one store: the next save
    // wrote account A's private keys into account B's file. That is a
    // confidentiality failure rather than a corruption one, so it is cleared
    // unconditionally, including the signers - a handle minted for the previous
    // account must not stay usable against this one's groups.
    mls.groups.clear();
    mls.pending_messages.clear();
    mls.signers.clear();
    mls.provider.storage().values.write().unwrap().clear();

    mls.read_only = read_only;
    // Left unset when read-only, so nothing can write even by accident. The
    // `read_only` flag above is what keeps `save_to_disk` from reading that as
    // "never initialised".
    mls.state_path = if read_only { None } else { Some(state_path.clone()) };

    if !state_path.exists() {
        return Ok(false);
    }

    let json = std::fs::read(&state_path).map_err(|e| e.to_string())?;
    let persisted: PersistedMlsState = serde_json::from_slice(&json).map_err(|e| e.to_string())?;

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

/// Replaces the provider store and group set with `persisted`. Shared by
/// [`import_state`] and the §D backup import so the two cannot drift apart.
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
/// Exists so the push path can tell "this notification is for the account that
/// is loaded" from "this one would swap the whole engine out from under the
/// running app". Since [`init_storage`] now *clears* on a directory change - it
/// has to, or two accounts' key material ends up in one store - blindly
/// initialising for whichever account a notification names would tear down the
/// foreground session.
pub fn current_state_dir(mls: &MlsState) -> Option<String> {
    mls.state_path
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Backup envelope (contract §D)
//
// Byte-for-byte identical to Alpine's `src-tauri/src/crypto/mls.rs`. The whole
// point is that a `.venta-keys` file written on one client opens on the other,
// so every constant below is wire format: changing one here without changing it
// there makes the two mutually unreadable, silently, until someone actually
// needs a restore.
// ---------------------------------------------------------------------------

const BACKUP_VERSION: u32 = 1;
const BACKUP_AAD_PREFIX: &str = "venta.keybackup.v1";
const ARGON2_M_KIB: u32 = 65536;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 4;

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

// `pub` and `priv` are Rust keywords, so the field names are mangled and mapped
// back here. The wire names are what the contract fixes; Alpine writes exactly
// these.
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

/// What `importBackup` hands back once the envelope has been opened and applied.
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
    /// Handed back because mobile keeps this pair in the OS keychain, not in the
    /// engine's store - `unlock()` reads it from there on every cold start, so a
    /// restore that only loaded it into memory would work until the app was next
    /// killed and then look exactly like lost keys. It is the same secret the
    /// caller has already supplied a passphrase to open, so nothing is exposed
    /// that the caller did not already hold.
    pub signing_public_key: String,
    pub signing_private_key: String,
    /// False on a new device, where cloning the ratchet state would be unsafe.
    pub engine_restored: bool,
    pub group_registry: HashMap<String, serde_json::Value>,
    pub message_cache: HashMap<String, String>,
    /// The account identity key (§H.2), when the envelope carried one. This is
    /// what makes full-loss recovery possible at all: without it a restored
    /// device can prove nothing to anyone and every external commit it makes is
    /// indistinguishable from the server injecting a leaf.
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
    account_identity: Option<(String, String)>,
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
        // Read by the import path, not by a human: cloning ratchet state onto a
        // second concurrently-live device reuses generations, which openmls
        // treats as a replay, and voids forward secrecy for that leaf.
        "engineRestore": "same-device-only",
        "signing": signing.to_json(),
        "engine": mls.to_persisted(),
        "groupRegistry": group_registry,
        "messageCache": message_cache.unwrap_or_default(),
    });

    // Optional so a blob written before §H still opens. Absent means the account
    // had no identity key yet, which §I.2 says is the normal state of every
    // existing account until an upgraded client unlocks it.
    if let Some((public, private)) = account_identity {
        payload["accountIdentity"] = serde_json::json!({
            "pub": public,
            "priv": private,
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

    if envelope.v != BACKUP_VERSION {
        return Err(format!(
            "MlsError: backup version {} is not supported by this build",
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
                // Binding the envelope's own aad means a blob re-labelled for
                // another account or device fails to open rather than opening
                // and being wrong.
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

    // Refused, not merged. A backup carries another account's private keys and
    // its group registry; importing it over the signed-in account would leave
    // this device signing as one identity while holding leaves issued to
    // another.
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

    // The one rule that cannot be left to documentation. Two devices sharing a
    // leaf derive the same sender-ratchet keys, so at least one of them becomes
    // unable to send, forward secrecy for that leaf is gone, and an Update from
    // one leaves the other holding keys the group thinks were rotated.
    // Same-device recovery adopts the backup's device id first, which is
    // required anyway - the keychain entries are named after it.
    let engine_restored = device_id == current_device_id;
    if engine_restored {
        if let Some(engine) = payload.get("engine") {
            let persisted: PersistedMlsState = serde_json::from_value(engine.clone())
                .map_err(|e| format!("MlsError: backup engine state is unreadable: {}", e))?;
            restore_persisted(mls, persisted)?;
        }
    }

    let key_handle = load_signing_key(
        mls,
        &signing.pub_,
        &signing.priv_,
        signing.identity.clone(),
    )?;

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

/// Howard Hinnant's days-from-civil, inverted. Exact for the whole proleptic
/// Gregorian range.
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
// Account master key (contract §C.1)
//
// Ported from Alpine's `src-tauri/src/crypto/crypto.rs`, parameter for
// parameter. `ApplicationUser.EncryptedMasterKey` is one row per account and
// both clients read it, so a parameter that differed here would leave mobile
// unable to unwrap a key the desktop client wrapped - and the failure would look
// exactly like a wrong password.
//
// Note the parallelism: **1**, not the backup envelope's 4. Two envelopes with
// separate histories; matching them would break every key already wrapped.
// ---------------------------------------------------------------------------

const MASTER_ARGON2_MEM: u32 = 65536;
const MASTER_ARGON2_ITERS: u32 = 3;
const MASTER_ARGON2_LANES: u32 = 1;
const MASTER_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMasterKey {
    pub cipher_text: String,
    pub salt: String,
    pub iv: String,
    pub argon2_iterations: u32,
    pub argon2_memory: u32,
    pub argon2_parallelism: u32,
    pub version: u32,
}

fn derive_wrap_key(
    password: &str,
    salt: &[u8],
    memory: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<[u8; 32], String> {
    let params = Params::new(memory, iterations, parallelism, Some(32))
        .map_err(|e| format!("MlsError: bad Argon2 parameters: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut wrap_key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut wrap_key)
        .map_err(|e| format!("MlsError: key derivation failed: {}", e))?;
    Ok(wrap_key)
}

/// An account master key wrapped twice, under two independently-derived keys
/// (contract §C.1.1).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterKeySetup {
    pub password_wrapping: EncryptedMasterKey,
    pub recovery_code_wrapping: EncryptedMasterKey,
    /// Shown to the user exactly once. Never sent to the server, and not
    /// derivable from anything the server holds.
    pub recovery_code: String,
    /// The unwrapped key, so the caller can cache it without a second Argon2
    /// pass immediately after setup.
    pub master_key: String,
}

/// Characters a person can read aloud and type back without ambiguity.
///
/// Contract §C.1.2, and this is **wire format**: a recovery code generated on one
/// client has to open the wrapping on the other, so the alphabet is shared and
/// exactly 31 symbols. No `I`, `L`, `O`, `0` or `1` - those are the pairs people
/// transcribe wrongly, and a misread code fails at the one moment its owner has
/// nothing else to try.
///
/// This briefly carried a 32nd symbol, `*`, purely so a 5-bit mask would be
/// uniform. Sound reasoning about bias, wrong trade: `*` is punctuation in a
/// string a human copies off paper under stress, and it is not in the desktop
/// client's alphabet - so its validator rejected every code containing one and
/// fell back to the *unnormalised* input, deriving a different key silently,
/// during the one operation the code exists for. Roughly one character in 32 was
/// a `*`, so most codes were affected. [`generate_recovery_code`] uses rejection
/// sampling instead, which removes the bias without adding a character.
const RECOVERY_CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RECOVERY_CODE_GROUPS: usize = 8;
const RECOVERY_CODE_GROUP_LEN: usize = 4;
const RECOVERY_CODE_LEN: usize = RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LEN;

/// Largest multiple of 31 that fits in a byte (31 * 8). Bytes at or above it are
/// discarded rather than folded, which is what keeps `% 31` unbiased.
const RECOVERY_SAMPLE_CEILING: u8 = 248;

/// A ~158.5-bit recovery code, in eight groups of four.
///
/// This is the **only** credential that survives a password reset, which is what
/// makes it worth the UX cost of showing it once and demanding confirmation.
///
/// Rejection sampling: a byte at or above [`RECOVERY_SAMPLE_CEILING`] is thrown
/// away instead of folded, so every symbol is equally likely. The discard rate is
/// 8/256 and this runs once per account, so the loop costs nothing worth
/// optimising - and the alternative, padding the alphabet to a power of two, is
/// what broke cross-client recovery.
pub fn generate_recovery_code() -> String {
    let mut chars = Vec::with_capacity(RECOVERY_CODE_LEN);
    let mut buffer = [0u8; RECOVERY_CODE_LEN];

    while chars.len() < RECOVERY_CODE_LEN {
        rand::thread_rng().fill_bytes(&mut buffer);
        for byte in buffer {
            if chars.len() == RECOVERY_CODE_LEN {
                break;
            }
            if byte >= RECOVERY_SAMPLE_CEILING {
                continue;
            }
            chars.push(
                RECOVERY_CODE_ALPHABET[byte as usize % RECOVERY_CODE_ALPHABET.len()] as char,
            );
        }
    }

    chars
        .chunks(RECOVERY_CODE_GROUP_LEN)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// Folds a retyped recovery code back to the form it was generated in, or fails.
///
/// Users copy these off paper, so grouping dashes, stray whitespace and lower
/// case all have to disappear before the KDF sees them - otherwise a *correct*
/// code derives the wrong key and its owner is told their only surviving
/// credential is wrong.
///
/// **Total, by design.** Anything that is not a well-formed recovery code is an
/// error, never a pass-through. A silent fallback to the raw input converts a
/// recoverable typo into unrecoverable data loss with no diagnostic: the KDF
/// happily derives *a* key from the typo, the AEAD fails, and the only thing the
/// user learns is "wrong code". This function is called on recovery codes only -
/// a password is case-sensitive, may contain anything, and never comes through
/// here.
pub fn normalize_recovery_code(code: &str) -> Result<String, String> {
    let normalized: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(|c| c.to_uppercase())
        .collect();

    if normalized.len() != RECOVERY_CODE_LEN {
        return Err(format!(
            "RecoveryCodeInvalid: a recovery code is {} characters, this one has {}",
            RECOVERY_CODE_LEN,
            normalized.len()
        ));
    }
    if let Some(bad) = normalized
        .bytes()
        .find(|b| !RECOVERY_CODE_ALPHABET.contains(b))
    {
        return Err(format!(
            "RecoveryCodeInvalid: '{}' is not a recovery-code character",
            bad as char
        ));
    }
    Ok(normalized)
}

/// Wraps a master key under one secret. Identical shape for both wrappings -
/// they seal the same bytes under different credentials.
fn wrap_master_key(master_key: &[u8], secret: &str) -> Result<EncryptedMasterKey, String> {
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut iv);

    let wrap_key = derive_wrap_key(
        secret,
        &salt,
        MASTER_ARGON2_MEM,
        MASTER_ARGON2_ITERS,
        MASTER_ARGON2_LANES,
    )?;
    let cipher = Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), master_key)
        .map_err(|e| e.to_string())?;

    Ok(EncryptedMasterKey {
        cipher_text: B64.encode(ciphertext),
        salt: B64.encode(salt),
        iv: B64.encode(iv),
        argon2_iterations: MASTER_ARGON2_ITERS,
        argon2_memory: MASTER_ARGON2_MEM,
        argon2_parallelism: MASTER_ARGON2_LANES,
        version: MASTER_SCHEMA_VERSION,
    })
}

/// Mints an account master key and wraps it **twice** - once under the password,
/// once under a recovery code (contract §C.1.1).
///
/// One wrapping is not enough, and the reason is not hypothetical: a password
/// reset leaves the envelope sealed under a password the user has, by definition
/// of a reset, forgotten. Every backup blob and the account identity key become
/// permanently unopenable, silently, at exactly the moment someone is trying to
/// recover their account. The recovery code is the only credential that survives
/// that.
///
/// The key itself is random and never leaves the client; a secret only ever
/// produces a *wrap* key, so a password change re-wraps rather than re-keys and
/// every blob already sealed under the master key stays readable.
///
/// [recovery_code] is accepted so a UI can show the code and get confirmation
/// before committing to it; generated here when absent, so the entropy source is
/// never the caller's.
pub fn setup_master_key(
    password: &str,
    recovery_code: Option<&str>,
) -> Result<MasterKeySetup, String> {
    let mut master_key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut master_key);

    // A caller-supplied code has to be well-formed, and the error says so rather
    // than quietly generating a different one - a UI that showed the user one
    // code and wrapped under another would hand them a credential that opens
    // nothing.
    let code = match recovery_code {
        Some(c) => {
            normalize_recovery_code(c)?;
            c.to_owned()
        }
        None => generate_recovery_code(),
    };

    Ok(MasterKeySetup {
        password_wrapping: wrap_master_key(&master_key, password)?,
        recovery_code_wrapping: wrap_master_key(&master_key, &normalize_recovery_code(&code)?)?,
        recovery_code: code,
        master_key: B64.encode(master_key),
    })
}

/// Wraps an already-unwrapped master key under an arbitrary secret.
///
/// For retrofitting an account that only ever had the password wrapping - which
/// is every account created before §C.1.1, each of them one password reset away
/// from losing everything - and for re-wrapping under a new password after a
/// reset.
pub fn wrap_master_key_under(
    master_key_b64: &str,
    secret: &str,
) -> Result<EncryptedMasterKey, String> {
    let master_key = B64.decode(master_key_b64).map_err(|e| e.to_string())?;
    if master_key.len() != 32 {
        return Err("MlsError: a master key must be 32 bytes".to_string());
    }
    wrap_master_key(&master_key, secret)
}

/// Unwraps the master key. The parameters come from the envelope rather than the
/// constants above, so a key wrapped under older ones still opens.
pub fn decrypt_master_key(
    encrypted: &EncryptedMasterKey,
    password: &str,
) -> Result<String, String> {
    let ciphertext = B64
        .decode(&encrypted.cipher_text)
        .map_err(|e| e.to_string())?;
    let salt = B64.decode(&encrypted.salt).map_err(|e| e.to_string())?;
    let iv = B64.decode(&encrypted.iv).map_err(|e| e.to_string())?;

    let wrap_key = derive_wrap_key(
        password,
        &salt,
        encrypted.argon2_memory,
        encrypted.argon2_iterations,
        encrypted.argon2_parallelism,
    )?;
    let cipher = Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| e.to_string())?;
    let master_key = cipher
        .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
        .map_err(|_| {
            "MlsError: could not unwrap the master key - wrong password, or the envelope has been \
             altered"
                .to_string()
        })?;
    Ok(B64.encode(&master_key))
}

/// Re-wraps an already-unwrapped master key under a new password.
///
/// A password change must not mint a *new* master key: every backup blob and
/// every admission proof is bound to the existing one, and replacing it would
/// orphan all of them silently. Identical to [`wrap_master_key_under`] - kept as
/// a name so the call sites read as what they are.
pub fn rewrap_master_key(
    master_key_b64: &str,
    new_password: &str,
) -> Result<EncryptedMasterKey, String> {
    wrap_master_key_under(master_key_b64, new_password)
}

/// Cryptographically strong random bytes, base64.
///
/// For the §G admission challenge, which has to be unpredictable to the *server*
/// or a proof could be precomputed for a challenge it intends to issue later.
pub fn random_bytes_b64(count: usize) -> String {
    let mut bytes = vec![0u8; count.clamp(1, 1024)];
    rand::thread_rng().fill_bytes(&mut bytes);
    B64.encode(&bytes)
}

// ---------------------------------------------------------------------------
// Account identity, device certificates and admission proofs (contract §G/§H)
//
// Three separate secrets, deliberately:
//
// * the **account master key** - Argon2id from the password, held only by the
//   user's own devices. It authorises a *new device of yours* (§G).
// * the **account identity key** - long-lived Ed25519, wrapped under the
//   recovery key. It lets a *peer* verify offline that a device belongs to an
//   account, with none of that account's devices online (§H).
// * the **device signing key** - per device, already the MLS credential.
//
// Every signed or MAC'd payload below is built by `tagged_payload`, which
// length-prefixes each field. Plain concatenation is ambiguous - ("ab","c") and
// ("a","bc") produce identical bytes - and an attacker who can move a byte from
// one field to the next can make one signature vouch for two different
// statements.
// ---------------------------------------------------------------------------

const DEVICE_CERT_LABEL: &str = "venta.device-cert.v1";
const ADMISSION_INFO: &[u8] = b"venta.device-admission.v1";
const ADMISSION_LABEL: &str = "venta.device-admission.v1";
const PROTECTION_LEVEL_LABEL: &str = "venta.protection-level.v1";

type HmacSha256 = Hmac<Sha256>;

/// `label || len(f0) || f0 || len(f1) || f1 || ...`, lengths as 4-byte
/// big-endian. See the module comment for why the lengths are not optional.
fn tagged_payload(label: &str, fields: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(label.len() + fields.iter().map(|f| f.len() + 4).sum::<usize>());
    out.extend_from_slice(label.as_bytes());
    for field in fields {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsAccountIdentity {
    pub public_key: String,
    pub private_key: String,
}

/// Mints an account identity key. Once per account, ever - §H.5 rotation is a
/// security event that invalidates every peer's pinning, not a routine one.
pub fn generate_account_identity(mls: &MlsState) -> Result<MlsAccountIdentity, String> {
    let (private, public) = mls
        .provider
        .crypto()
        .signature_key_gen(SignatureScheme::ED25519)
        .map_err(|e| format!("MlsError: could not generate an account identity key: {:?}", e))?;
    Ok(MlsAccountIdentity {
        public_key: B64.encode(&public),
        private_key: B64.encode(&private),
    })
}

/// Signs a device certificate with the account identity key.
///
/// The server cannot mint one of these - it never holds the private half - which
/// is exactly what stops an external-commit rejoin (§H.3) from being a
/// server-side backdoor into every group.
pub fn issue_device_certificate(
    mls: &MlsState,
    account_identity_private_key_b64: &str,
    device_id: &str,
    device_signature_key_b64: &str,
    issued_at: i64,
    expires_at: i64,
) -> Result<String, String> {
    let private = B64
        .decode(account_identity_private_key_b64)
        .map_err(|e| e.to_string())?;
    let payload = device_cert_payload(device_id, device_signature_key_b64, issued_at, expires_at);
    let signature = mls
        .provider
        .crypto()
        .sign(SignatureScheme::ED25519, &payload, &private)
        .map_err(|e| format!("MlsError: could not sign the device certificate: {:?}", e))?;
    Ok(B64.encode(&signature))
}

/// Verifies a device certificate against a **pinned** account identity key.
///
/// Returns `false` rather than erroring for an invalid signature: at §I.1's
/// `Observe` and `Warn` phases the caller counts and warns rather than acting,
/// and an error type would push that decision down here.
pub fn verify_device_certificate(
    mls: &MlsState,
    account_identity_public_key_b64: &str,
    device_id: &str,
    device_signature_key_b64: &str,
    issued_at: i64,
    expires_at: i64,
    certificate_b64: &str,
) -> Result<bool, String> {
    let public = B64
        .decode(account_identity_public_key_b64)
        .map_err(|e| e.to_string())?;
    let signature = match B64.decode(certificate_b64) {
        Ok(s) => s,
        // Malformed base64 is a failed verification, not a caller error - the
        // bytes came off the wire.
        Err(_) => return Ok(false),
    };
    let payload = device_cert_payload(device_id, device_signature_key_b64, issued_at, expires_at);
    Ok(mls
        .provider
        .crypto()
        .verify_signature(SignatureScheme::ED25519, &payload, &public, &signature)
        .is_ok())
}

fn device_cert_payload(
    device_id: &str,
    device_signature_key_b64: &str,
    issued_at: i64,
    expires_at: i64,
) -> Vec<u8> {
    tagged_payload(
        DEVICE_CERT_LABEL,
        &[
            device_id.as_bytes(),
            device_signature_key_b64.as_bytes(),
            &issued_at.to_be_bytes(),
            &expires_at.to_be_bytes(),
        ],
    )
}

/// HKDF-SHA256 over the account master key. A derived key rather than the master
/// key itself so that a proof, if it ever leaked, cannot be turned back into the
/// key that unwraps the backup envelope.
fn derive_admission_key(master_key: &[u8]) -> Result<[u8; 32], String> {
    let hkdf = Hkdf::<Sha256>::new(None, master_key);
    let mut out = [0u8; 32];
    hkdf.expand(ADMISSION_INFO, &mut out)
        .map_err(|e| format!("MlsError: admission key derivation failed: {}", e))?;
    Ok(out)
}

/// Proves possession of the account master key for a device admission (§G.1).
///
/// Symmetric on purpose: both sides of this exchange are devices of the *same*
/// account, so both hold the master key, and a MAC is exactly the right shape.
/// The server relays the bytes and can verify nothing, which is the property
/// that makes `TrustedSignIn` a real security level rather than "trust the
/// server".
pub fn sign_admission_proof(
    master_key_b64: &str,
    challenge_b64: &str,
    requester_device_id: &str,
    signature_key_fingerprint: &str,
) -> Result<String, String> {
    let master = B64.decode(master_key_b64).map_err(|e| e.to_string())?;
    let challenge = B64.decode(challenge_b64).map_err(|e| e.to_string())?;
    let key = derive_admission_key(&master)?;
    let payload = tagged_payload(
        ADMISSION_LABEL,
        &[
            &challenge,
            requester_device_id.as_bytes(),
            signature_key_fingerprint.as_bytes(),
        ],
    );
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key).map_err(|e| e.to_string())?;
    mac.update(&payload);
    Ok(B64.encode(mac.finalize().into_bytes()))
}

/// Constant-time verification of [`sign_admission_proof`].
pub fn verify_admission_proof(
    master_key_b64: &str,
    challenge_b64: &str,
    requester_device_id: &str,
    signature_key_fingerprint: &str,
    proof_b64: &str,
) -> Result<bool, String> {
    let master = B64.decode(master_key_b64).map_err(|e| e.to_string())?;
    let challenge = B64.decode(challenge_b64).map_err(|e| e.to_string())?;
    let proof = match B64.decode(proof_b64) {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    let key = derive_admission_key(&master)?;
    let payload = tagged_payload(
        ADMISSION_LABEL,
        &[
            &challenge,
            requester_device_id.as_bytes(),
            signature_key_fingerprint.as_bytes(),
        ],
    );
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key).map_err(|e| e.to_string())?;
    mac.update(&payload);
    // `verify_slice` is constant-time; comparing the base64 strings would not be.
    Ok(mac.verify_slice(&proof).is_ok())
}

/// Signs a protection-level assertion with the account identity key (§G.3).
///
/// The level must not be a server-side boolean: a server that could flip a
/// `VerifiedDevices` account to `TrustedSignIn` could then auto-admit its own
/// device, which defeats the whole tier. Signed by the account identity key
/// because that is the only account-scoped key a *peer* can also check, and
/// because §H.5 already gives rotation of it a ceremony.
pub fn sign_protection_level(
    mls: &MlsState,
    account_identity_private_key_b64: &str,
    user_id: &str,
    level: &str,
    version: u64,
    updated_at: &str,
) -> Result<String, String> {
    let private = B64
        .decode(account_identity_private_key_b64)
        .map_err(|e| e.to_string())?;
    let payload = protection_level_payload(user_id, level, version, updated_at);
    let signature = mls
        .provider
        .crypto()
        .sign(SignatureScheme::ED25519, &payload, &private)
        .map_err(|e| format!("MlsError: could not sign the protection level: {:?}", e))?;
    Ok(B64.encode(&signature))
}

pub fn verify_protection_level(
    mls: &MlsState,
    account_identity_public_key_b64: &str,
    user_id: &str,
    level: &str,
    version: u64,
    updated_at: &str,
    assertion_b64: &str,
) -> Result<bool, String> {
    let public = match B64.decode(account_identity_public_key_b64) {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    let signature = match B64.decode(assertion_b64) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    let payload = protection_level_payload(user_id, level, version, updated_at);
    Ok(mls
        .provider
        .crypto()
        .verify_signature(SignatureScheme::ED25519, &payload, &public, &signature)
        .is_ok())
}

fn protection_level_payload(
    user_id: &str,
    level: &str,
    version: u64,
    updated_at: &str,
) -> Vec<u8> {
    tagged_payload(
        PROTECTION_LEVEL_LABEL,
        &[
            user_id.as_bytes(),
            level.as_bytes(),
            &version.to_be_bytes(),
            updated_at.as_bytes(),
        ],
    )
}
