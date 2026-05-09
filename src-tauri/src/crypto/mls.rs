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
    /// Ed25519 private key (base64) — store encrypted under the master key.
    pub signing_private_key: String,
    pub key_packages: Vec<KeyPackageResult>,
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

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

pub struct MlsState {
    provider: OpenMlsRustCrypto,
    groups: HashMap<Vec<u8>, MlsGroup>,
}

impl Default for MlsState {
    fn default() -> Self {
        Self {
            provider: OpenMlsRustCrypto::default(),
            groups: HashMap::new(),
        }
    }
}

pub type MlsStateHandle = Mutex<MlsState>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn build_signer(pub_b64: &str, priv_b64: &str) -> Result<SignatureKeyPair, String> {
    let pub_bytes = B64.decode(pub_b64).map_err(|e| e.to_string())?;
    let priv_bytes = B64.decode(priv_b64).map_err(|e| e.to_string())?;
    Ok(SignatureKeyPair::from_raw(
        SignatureScheme::ED25519,
        priv_bytes,
        pub_bytes,
    ))
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

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Generate fresh MLS key packages for this client.
///
/// Store `signingPrivateKey` and each `initPrivateKey` encrypted under the
/// master key; upload each `keyPackage` and `signingPublicKey` to the server.
#[tauri::command]
pub fn generate_mls_key_packages(
    state: tauri::State<MlsStateHandle>,
    identity: String,
    count: u32,
) -> Result<MlsKeyPackageBatch, String> {
    let mls = state.lock().map_err(|e| e.to_string())?;
    let provider = &mls.provider;

    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
        .map_err(|e| e.to_string())?;

    let credential = BasicCredential::new(identity.into_bytes());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };

    let mut key_packages = Vec::with_capacity(count as usize);
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

    Ok(MlsKeyPackageBatch {
        signing_public_key: B64.encode(signer.public()),
        signing_private_key: B64.encode(signer.private()),
        key_packages,
    })
}

/// Create a new MLS group with a specific group ID.
#[tauri::command]
pub fn mls_create_group(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    identity: String,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    let signer = build_signer(&signing_public_key_b64, &signing_private_key_b64)?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let group_id = GroupId::from_slice(&group_id_bytes);

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
        .map_err(|e| e.to_string())?
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
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    key_packages_b64: Vec<String>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = build_signer(&signing_public_key_b64, &signing_private_key_b64)?;

    // Deserialize and validate each key package using the shared provider.
    // We hold an immutable borrow of provider here, then drop it before the
    // mutable split borrow below.
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
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<_, _>>()?
    };

    let MlsState { provider, groups } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "group not found".to_string())?;

    let (commit_msg, welcome_msg, _group_info) = group
        .add_members(provider, &signer, &key_packages)
        .map_err(|e| e.to_string())?;

    group
        .merge_pending_commit(provider)
        .map_err(|e| e.to_string())?;

    let commit_bytes = commit_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;
    let welcome_bytes = welcome_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    Ok(MlsCommitOut {
        commit: B64.encode(&commit_bytes),
        welcome: Some(B64.encode(&welcome_bytes)),
    })
}

/// Join a group from a Welcome message produced by `mls_add_members`.
#[tauri::command]
pub fn mls_join_group(
    state: tauri::State<MlsStateHandle>,
    welcome_b64: String,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
) -> Result<MlsGroupInfo, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;

    let welcome_bytes = B64.decode(&welcome_b64).map_err(|e| e.to_string())?;
    let welcome_msg_in =
        MlsMessageIn::tls_deserialize_exact_bytes(&welcome_bytes).map_err(|e| e.to_string())?;
    let welcome = match welcome_msg_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err("message is not a Welcome".to_string()),
    };

    // Validate signer bytes are well-formed (not strictly needed for join, but
    // keeps the API consistent).
    let _signer = build_signer(&signing_public_key_b64, &signing_private_key_b64)?;

    let group = {
        let MlsState { provider, .. } = &*mls;
        let staged =
            StagedWelcome::new_from_welcome(provider, &join_config(), welcome, None)
                .map_err(|e| e.to_string())?;
        staged.into_group(provider).map_err(|e| e.to_string())?
    };

    let info = build_group_info(&group);
    let group_id_bytes = group.group_id().as_slice().to_vec();
    mls.groups.insert(group_id_bytes, group);
    Ok(info)
}

/// Encrypt and send an application message to the group.
///
/// Returns a base64 TLS-serialized ciphertext to broadcast to the group.
#[tauri::command]
pub fn mls_send_message(
    state: tauri::State<MlsStateHandle>,
    group_id_b64: String,
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    plaintext_b64: String,
) -> Result<String, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let plaintext = B64.decode(&plaintext_b64).map_err(|e| e.to_string())?;
    let signer = build_signer(&signing_public_key_b64, &signing_private_key_b64)?;

    let MlsState { provider, groups } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "group not found".to_string())?;

    let msg_out = group
        .create_message(provider, &signer, &plaintext)
        .map_err(|e| e.to_string())?;

    let msg_bytes = msg_out
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    Ok(B64.encode(&msg_bytes))
}

/// Process an incoming MLS message (application data, commit, or proposal).
///
/// Commits are merged immediately. Proposals are stored pending a commit.
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

    let MlsState { provider, groups } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "group not found".to_string())?;

    let processed = group
        .process_message(provider, protocol_msg)
        .map_err(|e| e.to_string())?;

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
    signing_public_key_b64: String,
    signing_private_key_b64: String,
    leaf_indices: Vec<u32>,
) -> Result<MlsCommitOut, String> {
    let mut mls = state.lock().map_err(|e| e.to_string())?;
    let group_id_bytes = B64.decode(&group_id_b64).map_err(|e| e.to_string())?;
    let signer = build_signer(&signing_public_key_b64, &signing_private_key_b64)?;
    let members: Vec<LeafNodeIndex> =
        leaf_indices.iter().map(|i| LeafNodeIndex::new(*i)).collect();

    let MlsState { provider, groups } = &mut *mls;
    let group = groups
        .get_mut(&group_id_bytes)
        .ok_or_else(|| "group not found".to_string())?;

    let (commit_msg, welcome_opt, _group_info) = group
        .remove_members(provider, &signer, &members)
        .map_err(|e| e.to_string())?;

    group
        .merge_pending_commit(provider)
        .map_err(|e| e.to_string())?;

    let commit_bytes = commit_msg
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    let welcome = welcome_opt
        .map(|w| {
            w.tls_serialize_detached()
                .map(|b| B64.encode(&b))
                .map_err(|e| e.to_string())
        })
        .transpose()?;

    Ok(MlsCommitOut {
        commit: B64.encode(&commit_bytes),
        welcome,
    })
}

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
        .ok_or_else(|| "group not found".to_string())?;

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
        .ok_or_else(|| "group not found".to_string())?;

    Ok(build_group_info(group))
}
