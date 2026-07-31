use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::{
    aead::Aead,
    {Aes256Gcm, KeyInit, Nonce},
};
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
use uuid::Uuid; // This usually brings in SenderRatchetConfiguration
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

// ---------------------------------------------------------------------------
// Output types (serialized over IPC)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPackageResult {
    pub key_package: String,
    pub init_private_key: String,
}

#[derive(Serialize)]
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

pub struct MlsState {
    provider: OpenMlsRustCrypto,
    groups: HashMap<Vec<u8>, MlsGroup>,
    signers: HashMap<String, SignerEntry>,
    pending_messages: HashMap<Vec<u8>, Vec<(u64, Vec<u8>)>>,
    state_path: Option<PathBuf>,
}

impl Default for MlsState {
    fn default() -> Self {
        Self {
            provider: OpenMlsRustCrypto::default(),
            groups: HashMap::new(),
            signers: HashMap::new(),
            pending_messages: HashMap::new(),
            state_path: None,
        }
    }
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

    fn save_to_disk(&self) -> Result<(), String> {
        let Some(path) = &self.state_path else {
            return Ok(());
        };
        let json = serde_json::to_vec(&self.to_persisted()).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub type MlsStateHandle = Mutex<MlsState>;

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

fn encrypt_blob(plaintext: &[u8], key_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| e.to_string())?;
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

fn create_config() -> MlsGroupCreateConfig {
    let ratchet_config = SenderRatchetConfiguration::new(
        500, // max_forward_distance: increase this from the default (usually 100)
        10,  // out_of_order_tolerance: how many "old" keys to keep in the cache
    );
    MlsGroupCreateConfig::builder()
        .sender_ratchet_configuration(ratchet_config)
        .use_ratchet_tree_extension(true)
        .build()
}

fn join_config() -> MlsGroupJoinConfig {
    let ratchet_config = SenderRatchetConfiguration::new(
        500, // max_forward_distance: increase this from the default (usually 100)
        10,  // out_of_order_tolerance: how many "old" keys to keep in the cache
    );
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

// ---------------------------------------------------------------------------
// Core logic (_impl functions) -callable from tests without Tauri runtime
// ---------------------------------------------------------------------------

fn load_signing_key_impl(
    mls: &mut MlsState,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    identity: String,
) -> Result<String, String> {
    let pub_bytes = B64
        .decode(&signing_public_key_b64)
        .map_err(|e| e.to_string())?;
    let priv_bytes = B64
        .decode(&signing_private_key_b64)
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

fn unload_signing_key_impl(mls: &mut MlsState, key_handle: String) -> Result<(), String> {
    mls.signers.remove(&key_handle);
    Ok(())
}

fn generate_key_packages_impl(
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

fn generate_key_packages_with_handle_impl(
    mls: &MlsState,
    key_handle: String,
    count: u32,
) -> Result<Vec<KeyPackageResult>, String> {
    let (signer, identity) = {
        let entry = get_signer_entry(mls, &key_handle)?;
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

fn create_group_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let group_id = GroupId::from_slice(&group_id_bytes);
    let (signer, identity) = {
        let entry = get_signer_entry(mls, &key_handle)?;
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
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(info)
}

fn add_members_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    key_handle: String,
    key_packages_b64: Vec<String>,
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, &key_handle)?;
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
                    .map_err(|e| map_mls_error(e))
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
        let (commit_msg, welcome_msg, _group_info) = group
            .add_members(provider, &signer, &key_packages)
            .map_err(|e| map_mls_error(e))?;
        // Deliberately *not* merged here. The server accepts exactly one commit per epoch, so a
        // commit that loses that race must never have been applied locally - a group that advanced
        // on a commit nobody else has is forked, and MLS gives no way to walk that back.
        // The caller merges via `mls_merge_pending_commit` once the server has taken it, or
        // discards via `mls_clear_pending_commit` when it has not.
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
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(commit_out)
}

fn join_group_impl(
    mls: &mut MlsState,
    welcome_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    get_signer_entry(mls, &key_handle)?;
    let welcome_bytes = B64.decode(&welcome_b64).map_err(|e| e.to_string())?;
    let welcome_msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&welcome_bytes).map_err(|e| e.to_string())?;
    let welcome = match welcome_msg_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err("MlsError: message is not a Welcome".to_string()),
    };
    let group = {
        let MlsState { provider, .. } = &*mls;
        let staged = StagedWelcome::new_from_welcome(provider, &join_config(), welcome, None)
            .map_err(|e| map_mls_error(e))?;
        staged.into_group(provider).map_err(|e| map_mls_error(e))?
    };
    let info = build_group_info(&group);
    let group_id_bytes = group.group_id().as_slice().to_vec();
    mls.groups.insert(group_id_bytes, group);
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(info)
}

// In MLS a member cannot commit their own removal. `leave_group_impl` therefore
// produces a Remove *proposal* (not a commit). Callers must broadcast this
// proposal so that another group member can commit it via
// `commit_pending_proposals_impl`. The local group state is removed immediately
// so the leaver no longer has access to group keys.
fn leave_group_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, &key_handle)?;
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
            .map_err(|e| map_mls_error(e))?;
        let proposal_bytes = proposal_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        // Erase local state -the leaver no longer participates.
        groups.remove(&group_id_bytes);
        MlsCommitOut {
            commit: B64.encode(&proposal_bytes),
            welcome: None,
            epoch: 0,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(proposal_out)
}

// Allow a remaining member to commit all pending proposals (e.g. after
// processing a leave proposal from a departing member).
fn commit_pending_proposals_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, &key_handle)?;
        build_signer_from_entry(entry)
    };
    let commit_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let (commit_msg, welcome_opt, _group_info) = group
            .commit_to_pending_proposals(provider, &signer)
            .map_err(|e| map_mls_error(e))?;
        // Staged, not merged - see add_members_impl for why.
        let epoch = group.epoch().as_u64() + 1;
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        let welcome = welcome_opt.map(serialize_welcome).transpose()?;
        MlsCommitOut {
            commit: B64.encode(&commit_bytes),
            welcome,
            epoch,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(commit_out)
}

// Second half of the two-phase commit dance. `add_members` / `remove_members` /
// `commit_to_pending_proposals` stage a commit without applying it; exactly one of these two runs
// afterwards, depending on whether the server took it.
fn merge_pending_commit_impl(mls: &mut MlsState, group_id_b64: String) -> Result<u64, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let epoch = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        group
            .merge_pending_commit(provider)
            .map_err(|e| map_mls_error(e))?;
        group.epoch().as_u64()
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(epoch)
}

fn clear_pending_commit_impl(mls: &mut MlsState, group_id_b64: String) -> Result<(), String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
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

fn export_group_info_impl(
    mls: &MlsState,
    group_id_b64: String,
    key_handle: String,
) -> Result<String, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, &key_handle)?;
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

fn rejoin_group_impl(
    mls: &mut MlsState,
    group_info_b64: String,
    key_handle: String,
) -> Result<MlsRejoinOut, String> {
    let (signer, identity) = {
        let entry = get_signer_entry(mls, &key_handle)?;
        (build_signer_from_entry(entry), entry.identity.clone())
    };
    let gi_bytes = B64.decode(&group_info_b64).map_err(|e| e.to_string())?;
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
        MlsRejoinOut {
            group_info: info,
            external_commit: B64.encode(&external_commit_bytes),
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(rejoin_out)
}

fn delete_group_impl(mls: &mut MlsState, group_id_b64: String) -> Result<(), String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    if mls.groups.remove(&group_id_bytes).is_none() {
        return Err("GroupNotFound: group not found".to_string());
    }
    mls.pending_messages.remove(&group_id_bytes);
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(())
}

fn send_message_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    key_handle: String,
    plaintext_b64: String,
) -> Result<MlsSendOut, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let plaintext = B64.decode(&plaintext_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, &key_handle)?;
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
            .map_err(|e| map_mls_error(e))?;
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

fn process_message_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    message_b64: String,
) -> Result<MlsProcessedMessage, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let msg_bytes = B64.decode(&message_b64).map_err(|e| e.to_string())?;
    let msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&msg_bytes).map_err(|e| e.to_string())?;
    let protocol_msg = msg_in
        .try_into_protocol_message()
        .map_err(|e| e.to_string())?;
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
            .map_err(|e| map_mls_error(e))?;
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
                if let Some(buf) = pending_messages.get_mut(&group_id_bytes) {
                    buf.retain(|(msg_epoch, _)| *msg_epoch > epoch);
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

fn remove_members_impl(
    mls: &mut MlsState,
    group_id_b64: String,
    key_handle: String,
    leaf_indices: Vec<u32>,
) -> Result<MlsCommitOut, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = {
        let entry = get_signer_entry(mls, &key_handle)?;
        build_signer_from_entry(entry)
    };
    let members: Vec<LeafNodeIndex> = leaf_indices
        .iter()
        .map(|i| LeafNodeIndex::new(*i))
        .collect();
    let commit_out = {
        let MlsState {
            provider, groups, ..
        } = &mut *mls;
        let group = groups
            .get_mut(&group_id_bytes)
            .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
        let (commit_msg, welcome_opt, _group_info) = group
            .remove_members(provider, &signer, &members)
            .map_err(|e| map_mls_error(e))?;
        // Staged, not merged - see add_members_impl for why.
        let epoch = group.epoch().as_u64() + 1;
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| e.to_string())?;
        let welcome = welcome_opt.map(serialize_welcome).transpose()?;
        MlsCommitOut {
            commit: B64.encode(&commit_bytes),
            welcome,
            epoch,
        }
    };
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(commit_out)
}

fn get_members_impl(mls: &MlsState, group_id_b64: String) -> Result<Vec<MlsMemberInfo>, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
    Ok(group_members(group))
}

fn get_group_info_impl(mls: &MlsState, group_id_b64: String) -> Result<MlsGroupInfo, String> {
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let group = mls
        .groups
        .get(&group_id_bytes)
        .ok_or_else(|| "GroupNotFound: group not found".to_string())?;
    Ok(build_group_info(group))
}

fn export_state_impl(mls: &MlsState, encryption_key_b64: String) -> Result<String, String> {
    let persisted = mls.to_persisted();
    let json = serde_json::to_vec(&persisted).map_err(|e| e.to_string())?;
    let key_bytes = B64.decode(&encryption_key_b64).map_err(|e| e.to_string())?;
    let encrypted = encrypt_blob(&json, &key_bytes)?;
    Ok(B64.encode(&encrypted))
}

fn import_state_impl(
    mls: &mut MlsState,
    encrypted_b64: String,
    encryption_key_b64: String,
) -> Result<(), String> {
    let encrypted = B64.decode(&encrypted_b64).map_err(|e| e.to_string())?;
    let key_bytes = B64.decode(&encryption_key_b64).map_err(|e| e.to_string())?;
    let json = decrypt_blob(&encrypted, &key_bytes)?;
    let persisted: PersistedMlsState = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
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
    mls.save_to_disk()
        .map_err(|e| format!("MlsError: failed to persist state: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands -thin wrappers around the _impl functions above
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mls_load_signing_key(
    state: tauri::State<MlsStateHandle>,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    identity: String,
) -> Result<String, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    load_signing_key_impl(
        &mut mls,
        signing_public_key_b64,
        signing_private_key_b64,
        identity,
    )
}

#[tauri::command]
pub fn mls_unload_signing_key(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    unload_signing_key_impl(&mut mls, key_handle)
}

#[tauri::command]
pub fn generate_mls_key_packages(
    state: tauri::State<MlsStateHandle>,
    identity: String,
    count: u32,
) -> Result<MlsKeyPackageBatch, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    generate_key_packages_impl(&mut mls, identity, count)
}

#[tauri::command]
pub fn mls_generate_key_packages_with_handle(
    state: tauri::State<MlsStateHandle>,
    key_handle: String,
    count: u32,
) -> Result<Vec<KeyPackageResult>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    generate_key_packages_with_handle_impl(&mls, key_handle, count)
}

#[tauri::command]
pub fn mls_create_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    create_group_impl(&mut mls, group_id_b64, key_handle)
}

#[tauri::command]
pub fn mls_add_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    key_packages_b64: Vec<String>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    add_members_impl(&mut mls, group_id_b64, key_handle, key_packages_b64)
}

#[tauri::command]
pub fn mls_join_group(
    state: tauri::State<MlsStateHandle>,
    welcome_b64: String,
    key_handle: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    join_group_impl(&mut mls, welcome_b64, key_handle)
}

#[tauri::command]
pub fn mls_leave_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    leave_group_impl(&mut mls, group_id_b64, key_handle)
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
    commit_pending_proposals_impl(&mut mls, group_id_b64, key_handle)
}

/// Applies a commit staged by add/remove/commit-proposals, once the server has accepted it.
/// Returns the group's epoch afterwards.
#[tauri::command]
pub fn mls_merge_pending_commit(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<u64, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    merge_pending_commit_impl(&mut mls, group_id_b64)
}

/// Discards a staged commit the server refused, leaving the group exactly where it was.
#[tauri::command]
pub fn mls_clear_pending_commit(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    clear_pending_commit_impl(&mut mls, group_id_b64)
}

#[tauri::command]
pub fn mls_export_group_info(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    export_group_info_impl(&mls, group_id_b64, key_handle)
}

#[tauri::command]
pub fn mls_rejoin_group(
    state: tauri::State<MlsStateHandle>,
    group_info_b64: String,
    key_handle: String,
) -> Result<MlsRejoinOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    rejoin_group_impl(&mut mls, group_info_b64, key_handle)
}

#[tauri::command]
pub fn mls_delete_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    delete_group_impl(&mut mls, group_id_b64)
}

#[tauri::command]
pub fn mls_send_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    plaintext_b64: String,
) -> Result<MlsSendOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    send_message_impl(&mut mls, group_id_b64, key_handle, plaintext_b64)
}

#[tauri::command]
pub fn mls_process_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    message_b64: String,
) -> Result<MlsProcessedMessage, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    process_message_impl(&mut mls, group_id_b64, message_b64)
}

#[tauri::command]
pub fn mls_remove_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    key_handle: String,
    leaf_indices: Vec<u32>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    remove_members_impl(&mut mls, group_id_b64, key_handle, leaf_indices)
}

#[tauri::command]
pub fn mls_get_members(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<Vec<MlsMemberInfo>, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    get_members_impl(&mls, group_id_b64)
}

#[tauri::command]
pub fn mls_get_group_info(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
) -> Result<MlsGroupInfo, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    get_group_info_impl(&mls, group_id_b64)
}

#[tauri::command]
pub fn mls_init_storage(
    state: tauri::State<MlsStateHandle>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let state_path = data_dir.join("mls_state.json");

    let mut mls = state.lock().map_err(|e| e.to_string())?;
    mls.state_path = Some(state_path.clone());

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
                    "MlsError: group {} is listed in state but its data is missing from storage -state may be corrupted",
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

#[tauri::command]
pub fn mls_clear_storage(state: tauri::State<MlsStateHandle>) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn mls_export_state(
    state: tauri::State<MlsStateHandle>,
    encryption_key_b64: String,
) -> Result<String, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    export_state_impl(&mls, encryption_key_b64)
}

#[tauri::command]
pub fn mls_import_state(
    state: tauri::State<MlsStateHandle>,
    encrypted_b64: String,
    encryption_key_b64: String,
) -> Result<(), String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    import_state_impl(&mut mls, encrypted_b64, encryption_key_b64)
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
        create_group_impl, delete_group_impl, merge_pending_commit_impl,
        export_group_info_impl, export_state_impl, generate_key_packages_impl,
        generate_key_packages_with_handle_impl, get_group_info_impl, get_members_impl,
        import_state_impl, join_group_impl, leave_group_impl, load_signing_key_impl,
        process_message_impl, rejoin_group_impl, remove_members_impl, send_message_impl,
        unload_signing_key_impl, MlsState,
    };
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use rand::RngCore;

    fn make_mls() -> MlsState {
        MlsState::default()
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
}
