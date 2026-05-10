use std::collections::HashMap;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use openmls::prelude::{
    tls_codec::{Deserialize as TlsCodecDeserialize, DeserializeBytes, Serialize as TlsSerialize},
    BasicCredential, Ciphersuite, CredentialWithKey, GroupId, KeyPackage, KeyPackageIn,
    LeafNodeIndex, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn,
    MlsMessageIn, OpenMlsProvider, ProcessedMessageContent, ProtocolVersion, SignatureScheme,
    StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde::Serialize;
use uuid::Uuid;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

// ---------------------------------------------------------------------------
// Output types (serialized over IPC)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPackageResult {
    /// TLS-serialized KeyPackage (base64) — upload to server.
    pub key_package: String,
    /// HPKE init private key (base64) — store encrypted under the master key.
    pub init_private_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsKeyPackageBatch {
    /// Ed25519 public key (base64).
    pub signing_public_key: String,
    /// Ed25519 private key (base64) — store encrypted under the master key; pass to
    /// `mls_load_signing_key` on each session unlock, then discard from JS memory.
    pub signing_private_key: String,
    pub key_packages: Vec<KeyPackageResult>,
    /// Opaque session handle — use this instead of the raw private key for all
    /// subsequent group operations in this session.
    pub key_handle: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MlsMemberInfo {
    pub leaf_index: u32,
    pub identity: String,
    pub encryption_key: String,
    pub signature_key: String,
}

#[derive(Serialize)]
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
    /// TLS-serialized MlsMessage containing the commit (base64).
    pub commit: String,
    /// TLS-serialized MlsMessage containing the welcome (base64), if any.
    pub welcome: Option<String>,
    /// Group epoch after this commit was applied.
    pub epoch: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsProcessedMessage {
    /// "application" | "commit" | "proposal"
    pub kind: String,
    /// Plaintext bytes (base64) for application messages.
    pub plaintext: Option<String>,
    /// True when the commit removed us from the group.
    pub self_removed: bool,
    /// Members added by this commit (identity extracted from credential).
    pub added_members: Vec<MlsMemberInfo>,
    /// Leaf indices removed by this commit.
    pub removed_leaf_indices: Vec<u32>,
    /// Identity string of the sender (from BasicCredential), if available.
    pub sender_identity: Option<String>,
    /// Epoch after applying the commit.
    pub epoch: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlsRejoinOut {
    /// Metadata about the group after rejoining.
    pub group_info: MlsGroupInfo,
    /// TLS-serialized external commit (base64) — broadcast to all group members.
    pub external_commit: String,
}

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

/// A signing key loaded into the session store.
struct SignerEntry {
    /// Raw Ed25519 public key bytes.
    pub_bytes: Vec<u8>,
    /// Raw Ed25519 private key bytes.
    priv_bytes: Vec<u8>,
    /// Human-readable identity tied to this credential.
    identity: String,
}

pub struct MlsState {
    provider: OpenMlsRustCrypto,
    groups: HashMap<Vec<u8>, MlsGroup>,
    /// Session-scoped signing key store. JS holds opaque UUID handles; raw
    /// private key bytes never cross the IPC boundary after the initial load.
    signers: HashMap<String, SignerEntry>,
    /// Per-group pending message buffer for future-epoch messages.
    /// group_id_bytes → Vec<(epoch, raw_message_bytes)>
    pending_messages: HashMap<Vec<u8>, Vec<(u64, Vec<u8>)>>,
}

impl Default for MlsState {
    fn default() -> Self {
        Self {
            provider: OpenMlsRustCrypto::default(),
            groups: HashMap::new(),
            signers: HashMap::new(),
            pending_messages: HashMap::new(),
        }
    }
}

pub type MlsStateHandle = Mutex<MlsState>;

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
    mls.signers
        .get(key_handle)
        .ok_or_else(|| format!("KeyNotFound: no signing key loaded for handle '{}'", key_handle))
}

/// Maps OpenMLS error strings to typed prefixes consumed by the JS MlsError parser.
fn map_mls_error(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let lower = s.to_lowercase();
    if lower.contains("wrong epoch") || lower.contains("epoch mismatch") || lower.contains("wrongepoch") {
        format!("WrongEpoch: {}", s)
    } else if lower.contains("unknown sender") || lower.contains("invalid sender") || lower.contains("unknownsender") {
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
    MlsGroupCreateConfig::builder()
        .use_ratchet_tree_extension(true)
        .build()
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .build()
}

fn serialize_welcome(welcome_msg: openmls::prelude::MlsMessageOut) -> Result<String, String> {
    welcome_msg
        .tls_serialize_detached()
        .map(|b| B64.encode(&b))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands — key handle management
// ---------------------------------------------------------------------------

/// Load a signing key into the session store and return an opaque handle.
///
/// Call this once on session unlock (e.g. after the user authenticates).
/// Pass the returned handle to all group operations instead of the raw private key.
/// The private key bytes are never returned to JS after this call.
#[tauri::command]
pub fn mls_load_signing_key(
    state: tauri::State<MlsStateHandle>,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    identity: String,
) -> Result<String, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    let pub_bytes = B64.decode(&signing_public_key_b64).map_err(|e| e.to_string())?;
    let priv_bytes = B64.decode(&signing_private_key_b64).map_err(|e| e.to_string())?;

    let handle = Uuid::new_v4().to_string();
    mls.signers.insert(handle.clone(), SignerEntry { pub_bytes, priv_bytes, identity });
    Ok(handle)
}

/// Remove a signing key from the session store.
///
/// Call this on session lock / logout to clear key material from memory.
#[tauri::command]
pub fn mls_unload_signing_key(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    mls.signers.remove(&key_handle);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — key package generation
// ---------------------------------------------------------------------------

/// Generate fresh MLS key packages for this client.
///
/// Store `signingPrivateKey` and each `initPrivateKey` encrypted under the
/// master key; upload each `keyPackage` and `signingPublicKey` to the server.
/// The returned `keyHandle` can be used immediately for group operations this
/// session without re-loading the key.
#[tauri::command]
pub fn generate_mls_key_packages(
    state: tauri::State<MlsStateHandle>,
    identity: String,
    count: u32,
) -> Result<MlsKeyPackageBatch, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
        .map_err(|e| e.to_string())?;

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

    // Auto-load into session store so the key is usable immediately.
    let handle = Uuid::new_v4().to_string();
    mls.signers.insert(handle.clone(), SignerEntry {
        pub_bytes: signer.public().to_vec(),
        priv_bytes: signer.private().to_vec(),
        identity,
    });

    Ok(MlsKeyPackageBatch {
        signing_public_key: pub_b64,
        signing_private_key: priv_b64,
        key_packages,
        key_handle: handle,
    })
}

/// Generate additional key packages using an existing session signing key.
///
/// Unlike `generate_mls_key_packages`, this reuses the key already loaded
/// under `key_handle` — no new keypair is created, so the signing key is not
/// rotated. Use this to replenish the server's key package supply.
#[tauri::command]
pub fn mls_generate_key_packages_with_handle(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
    count: u32,
) -> Result<Vec<KeyPackageResult>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;

    let (signer, identity) = {
        let entry = get_signer_entry(&mls, &key_handle)?;
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

    Ok(key_packages)
}

// ---------------------------------------------------------------------------
// Tauri commands — group lifecycle
// ---------------------------------------------------------------------------

/// Create a new MLS group with a specific group ID.
///
/// Uses the signing key referenced by `key_handle` (loaded via
/// `mls_load_signing_key` or returned by `generate_mls_key_packages`).
#[tauri::command]
pub fn mls_create_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let group_id = GroupId::from_slice(&group_id_bytes);

    let (signer, identity) = {
        let entry = get_signer_entry(&mls, &key_handle)?;
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
        .map_err(|e| map_mls_error(e))?
    };

    let info = build_group_info(&group);
    mls.groups.insert(group_id_bytes, group);
    Ok(info)
}

/// Add one or more members to an existing group.
///
/// Returns the commit (broadcast to all members) and welcome (send to new
/// members only).
#[tauri::command]
pub fn mls_add_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    key_packages_b64: Vec<String>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    let signer = {
        let entry = get_signer_entry(&mls, &key_handle)?;
        build_signer_from_entry(entry)
    };

    let key_packages: Vec<KeyPackage> = {
        let crypto = mls.provider.crypto();
        key_packages_b64
            .iter()
            .map(|kp_b64| {
                let kp_bytes = B64.decode(kp_b64).map_err(|e| e.to_string())?;
                let kp_in = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..])
                    .map_err(|e| e.to_string())?;
                kp_in
                    .validate(crypto, ProtocolVersion::Mls10)
                    .map_err(|e| map_mls_error(e))
            })
            .collect::<Result<_, _>>()?
    };

    let MlsState { provider, groups, .. } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    let (commit_msg, welcome_msg, _group_info) = group
        .add_members(provider, &signer, &key_packages)
        .map_err(|e| map_mls_error(e))?;

    group
        .merge_pending_commit(provider)
        .map_err(|e| e.to_string())?;

    let epoch = group.epoch().as_u64();

    let commit_bytes = commit_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;
    let welcome_bytes = welcome_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    Ok(MlsCommitOut {
        commit: B64.encode(&commit_bytes),
        welcome: Some(B64.encode(&welcome_bytes)),
        epoch,
    })
}

/// Join a group from a Welcome message produced by `mls_add_members`.
///
/// The init private key is consumed from the provider key store — replayed
/// Welcomes targeting the same KeyPackage will fail at the OpenMLS layer.
#[tauri::command]
pub fn mls_join_group(
    state: tauri::State<MlsStateHandle>,
    welcome_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    // Validate the key handle exists before proceeding.
    get_signer_entry(&mls, &key_handle)?;

    let welcome_bytes = B64.decode(&welcome_b64).map_err(|e| e.to_string())?;
    let welcome_msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&welcome_bytes).map_err(|e| e.to_string())?;
    let welcome = match welcome_msg_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err("MlsError: message is not a Welcome".to_string()),
    };

    let group = {
        let MlsState { provider, .. } = &*mls;
        let staged =
            StagedWelcome::new_from_welcome(provider, &join_config(), welcome, None)
                .map_err(|e| map_mls_error(e))?;
        staged.into_group(provider).map_err(|e| map_mls_error(e))?
    };

    let info = build_group_info(&group);
    let group_id_bytes = group.group_id().as_slice().to_vec();
    mls.groups.insert(group_id_bytes, group);
    Ok(info)
}

/// Leave a group by proposing and committing self-removal.
///
/// The produced `commit` must be broadcast to all remaining members.
/// The group is automatically removed from the local store after this call.
#[tauri::command]
pub fn mls_leave_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    let signer = {
        let entry = get_signer_entry(&mls, &key_handle)?;
        build_signer_from_entry(entry)
    };

    let MlsState { provider, groups, .. } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    // Self-removal: propose and commit removal of own leaf node.
    let own_leaf = group.own_leaf_index();
    let (commit_msg, welcome_opt, _group_info) = group
        .remove_members(provider, &signer, &[own_leaf])
        .map_err(|e| map_mls_error(e))?;

    group
        .merge_pending_commit(provider)
        .map_err(|e| e.to_string())?;

    let epoch = group.epoch().as_u64();

    let commit_bytes = commit_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    let welcome = welcome_opt
        .map(serialize_welcome)
        .transpose()?;

    // Remove from store — the local node has left this group.
    groups.remove(&group_id_bytes);

    Ok(MlsCommitOut {
        commit: B64.encode(&commit_bytes),
        welcome,
        epoch,
    })
}

/// Export a TLS-serialized GroupInfo message for use in external commits.
///
/// Publish this blob via the server so offline members can re-sync using
/// `mls_rejoin_group` without needing a new Welcome.
#[tauri::command]
pub fn mls_export_group_info(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    let signer = {
        let entry = get_signer_entry(&mls, &key_handle)?;
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

/// Re-join a group via an external commit after missing commits while offline.
///
/// `group_info_b64` must be a TLS-serialized GroupInfo exported by
/// `mls_export_group_info`. The returned `externalCommit` must be broadcast
/// to all existing group members so they can advance their state.
#[tauri::command]
pub fn mls_rejoin_group(
    state: tauri::State<MlsStateHandle>,
    group_info_b64: String,
    key_handle: String,
) -> Result<MlsRejoinOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    let (signer, identity) = {
        let entry = get_signer_entry(&mls, &key_handle)?;
        (build_signer_from_entry(entry), entry.identity.clone())
    };

    let gi_bytes = B64.decode(&group_info_b64).map_err(|e| e.to_string())?;
    let gi_msg =
        MlsMessageIn::tls_deserialize_exact_bytes(&gi_bytes).map_err(|e| e.to_string())?;
    let verifiable_group_info = match gi_msg.extract() {
        MlsMessageBodyIn::GroupInfo(vgi) => vgi,
        _ => return Err("MlsError: message is not a GroupInfo".to_string()),
    };

    let credential = BasicCredential::new(identity.into_bytes());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };

    let MlsState { provider, groups, .. } = &mut *mls;

    let (group, bundle) = MlsGroup::external_commit_builder()
        .with_config(join_config())
        .build_group(provider, verifiable_group_info, credential_with_key)
        .map_err(|e| map_mls_error(e))?
        .load_psks(provider.storage())
        .map_err(|e| map_mls_error(e))?
        .build(provider.rand(), provider.crypto(), &signer, |_| true)
        .map_err(|e| map_mls_error(e))?
        .finalize(provider)
        .map_err(|e| e.to_string())?;

    let external_commit_bytes = bundle
        .into_commit()
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    let info = build_group_info(&group);
    let group_id_bytes = group.group_id().as_slice().to_vec();
    groups.insert(group_id_bytes, group);

    Ok(MlsRejoinOut {
        group_info: info,
        external_commit: B64.encode(&external_commit_bytes),
    })
}

/// Permanently delete a group from the local store.
///
/// Call this after being removed from a group, after `mls_leave_group`, or
/// for GDPR right-to-erasure. Clears the MlsGroup and its epoch secrets.
#[tauri::command]
pub fn mls_delete_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    if mls.groups.remove(&group_id_bytes).is_none() {
        return Err("GroupNotFound: group not found".to_string());
    }

    // Also clear any pending message buffer for this group.
    mls.pending_messages.remove(&group_id_bytes);

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — messaging
// ---------------------------------------------------------------------------

/// Encrypt and send an application message to the group.
///
/// Returns a base64 TLS-serialized ciphertext to broadcast to the group.
#[tauri::command]
pub fn mls_send_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    plaintext_b64: String,
) -> Result<String, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let plaintext = B64.decode(&plaintext_b64).map_err(|e| e.to_string())?;

    let signer = {
        let entry = get_signer_entry(&mls, &key_handle)?;
        build_signer_from_entry(entry)
    };

    let MlsState { provider, groups, .. } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    let msg_out = group
        .create_message(provider, &signer, &plaintext)
        .map_err(|e| map_mls_error(e))?;

    let msg_bytes = msg_out
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    Ok(B64.encode(&msg_bytes))
}

/// Process an incoming MLS message (application data, commit, or proposal).
///
/// Commits are merged immediately. Proposals are stored pending a commit.
/// Returns a `WrongEpoch:` error when the message belongs to a future epoch —
/// the caller should buffer and retry after receiving the missing commit.
#[tauri::command]
pub fn mls_process_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    message_b64: String,
) -> Result<MlsProcessedMessage, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let msg_bytes = B64.decode(&message_b64).map_err(|e| e.to_string())?;

    let msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&msg_bytes).map_err(|e| e.to_string())?;
    let protocol_msg = msg_in
        .try_into_protocol_message()
        .map_err(|e| e.to_string())?;

    let MlsState { provider, groups, pending_messages, .. } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    let processed = group
        .process_message(provider, protocol_msg)
        .map_err(|e| map_mls_error(e))?;

    let sender_identity = BasicCredential::try_from(processed.credential().clone())
        .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
        .ok();

    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(app_msg) => Ok(MlsProcessedMessage {
            kind: "application".into(),
            plaintext: Some(B64.encode(app_msg.into_bytes())),
            self_removed: false,
            added_members: vec![],
            removed_leaf_indices: vec![],
            sender_identity,
            epoch: None,
        }),

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
                        leaf_index: 0, // assigned after merge
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

            // Flush any buffered messages for the new epoch.
            if let Some(buf) = pending_messages.get_mut(&group_id_bytes) {
                buf.retain(|(msg_epoch, _)| *msg_epoch > epoch);
            }

            Ok(MlsProcessedMessage {
                kind: "commit".into(),
                plaintext: None,
                self_removed,
                added_members: added,
                removed_leaf_indices: removed,
                sender_identity,
                epoch: Some(epoch),
            })
        }

        ProcessedMessageContent::ProposalMessage(queued_proposal) => {
            group
                .store_pending_proposal(provider.storage(), *queued_proposal)
                .map_err(|e| e.to_string())?;
            Ok(MlsProcessedMessage {
                kind: "proposal".into(),
                plaintext: None,
                self_removed: false,
                added_members: vec![],
                removed_leaf_indices: vec![],
                sender_identity,
                epoch: None,
            })
        }

        ProcessedMessageContent::ExternalJoinProposalMessage(queued_proposal) => {
            group
                .store_pending_proposal(provider.storage(), *queued_proposal)
                .map_err(|e| e.to_string())?;
            Ok(MlsProcessedMessage {
                kind: "proposal".into(),
                plaintext: None,
                self_removed: false,
                added_members: vec![],
                removed_leaf_indices: vec![],
                sender_identity,
                epoch: None,
            })
        }
    }
}

/// Remove members from the group by leaf index.
///
/// Returns the commit to broadcast to remaining members.
#[tauri::command]
pub fn mls_remove_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    leaf_indices: Vec<u32>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    let signer = {
        let entry = get_signer_entry(&mls, &key_handle)?;
        build_signer_from_entry(entry)
    };

    let members: Vec<LeafNodeIndex> =
        leaf_indices.iter().map(|i| LeafNodeIndex::new(*i)).collect();

    let MlsState { provider, groups, .. } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    let (commit_msg, welcome_opt, _group_info) = group
        .remove_members(provider, &signer, &members)
        .map_err(|e| map_mls_error(e))?;

    group
        .merge_pending_commit(provider)
        .map_err(|e| e.to_string())?;

    let epoch = group.epoch().as_u64();

    let commit_bytes = commit_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    let welcome = welcome_opt
        .map(serialize_welcome)
        .transpose()?;

    Ok(MlsCommitOut {
        commit: B64.encode(&commit_bytes),
        welcome,
        epoch,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — group queries
// ---------------------------------------------------------------------------

/// Return the current member list for a group.
#[tauri::command]
pub fn mls_get_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<Vec<MlsMemberInfo>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    Ok(group_members(group))
}

/// Return current group metadata (epoch, own leaf index, members).
#[tauri::command]
pub fn mls_get_group_info(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<MlsGroupInfo, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;

    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;

    Ok(build_group_info(group))
}
