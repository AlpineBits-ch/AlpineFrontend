use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;

const ARGON2_MEM: u32 = 65536; // 64 MiB
const ARGON2_ITERS: u32 = 3;
const ARGON2_LANES: u32 = 1;
const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMasterKey {
    cipher_text: String,
    salt: String,
    iv: String,
    argon2_iterations: u32,
    argon2_memory: u32,
    argon2_parallelism: u32,
    version: u32,
}

#[tauri::command]
pub fn generate_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).expect("OS Entropy failed!");
    key
}

#[tauri::command]
pub fn setup_master_key(
    password: String,
    user_entropy: Option<Vec<u8>>,
) -> Result<EncryptedMasterKey, String> {
    let mut master_key = [0u8; 32];
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];

    getrandom::getrandom(&mut master_key).map_err(|e| e.to_string())?;
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    getrandom::getrandom(&mut iv).map_err(|e| e.to_string())?;

    // XOR user-collected mouse entropy into the master key for extra unpredictability
    if let Some(entropy) = user_entropy {
        for (i, byte) in entropy.iter().enumerate() {
            master_key[i % 32] ^= byte;
        }
    }

    // Derive wrap key: Argon2id(password, salt) → 32 bytes
    let params = Params::new(ARGON2_MEM, ARGON2_ITERS, ARGON2_LANES, Some(32))
        .map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut wrap_key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut wrap_key)
        .map_err(|e| e.to_string())?;

    // Encrypt: AES-256-GCM(wrap_key, iv, master_key) → ciphertext
    let cipher = Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&iv);
    let ciphertext = cipher
        .encrypt(nonce, master_key.as_ref())
        .map_err(|e| e.to_string())?;

    Ok(EncryptedMasterKey {
        cipher_text: B64.encode(ciphertext),
        salt: B64.encode(salt),
        iv: B64.encode(iv),
        argon2_iterations: ARGON2_ITERS,
        argon2_memory: ARGON2_MEM,
        argon2_parallelism: ARGON2_LANES,
        version: SCHEMA_VERSION,
    })
}
