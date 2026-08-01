use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::rngs::OsRng;
use rsa::{
    pkcs8::{EncodePrivateKey, EncodePublicKey},
    RsaPrivateKey,
};
use serde::{Deserialize, Serialize};

const ARGON2_MEM: u32 = 65536; // 64 MiB
const ARGON2_ITERS: u32 = 3;
const ARGON2_LANES: u32 = 1;
const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairEntry {
    key_id: String,
    public_key: String,  // Base64-encoded SPKI DER
    private_key: String, // Base64-encoded PKCS8 DER
}

#[tauri::command]
pub fn generate_key_pairs(count: u32) -> Result<Vec<KeyPairEntry>, String> {
    let mut rng = OsRng;
    let mut pairs = Vec::with_capacity(count as usize);

    for _ in 0..count {
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).map_err(|e| e.to_string())?;
        let pub_key = priv_key.to_public_key();

        let pub_der = pub_key.to_public_key_der().map_err(|e| e.to_string())?;
        let priv_der = priv_key.to_pkcs8_der().map_err(|e| e.to_string())?;

        let mut id = [0u8; 16];
        getrandom::getrandom(&mut id).map_err(|e| e.to_string())?;
        let key_id = id.iter().map(|b| format!("{:02x}", b)).collect();

        pairs.push(KeyPairEntry {
            key_id,
            public_key: B64.encode(pub_der.as_bytes()),
            private_key: B64.encode(priv_der.as_bytes()),
        });
    }

    Ok(pairs)
}

#[tauri::command]
pub fn generate_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).expect("OS Entropy failed!");
    key
}

/// Generates a master key wrapped under the password alone.
///
/// **Superseded by [`setup_master_key_dual`] for new setups.** A single password-derived wrapping
/// leaves the account one password reset away from losing everything it protects: the reset changes
/// a password the user has by definition forgotten, and nothing else opens the envelope. Kept for
/// the accounts already in that state, which have to be able to re-upload their existing wrapping.
#[tauri::command]
pub fn setup_master_key(
    password: String,
    user_entropy: Option<Vec<u8>>,
) -> Result<EncryptedMasterKey, String> {
    let mut master_key = [0u8; 32];
    getrandom::getrandom(&mut master_key).map_err(|e| e.to_string())?;
    mix_user_entropy(&mut master_key, user_entropy);
    wrap_master_key(&master_key, &password)
}

/// Both wrappings of one master key, produced together.
///
/// The pair is what makes a password reset survivable: the reset invalidates the password wrapping
/// only, and the client re-derives the key from the recovery code and re-wraps it. Nothing is lost.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DualWrappedMasterKey {
    pub password_wrapping: EncryptedMasterKey,
    pub recovery_code_wrapping: EncryptedMasterKey,
}

/// Generates a master key and wraps it under **both** the password and the recovery code.
///
/// Generated once and wrapped twice in a single call, so the two wrappings provably seal the same
/// bytes. Doing it in two calls would let a caller pair a wrapping of one key with a wrapping of
/// another - a mistake that surfaces only at the point of recovery, where it cannot be repaired.
///
/// The master key itself never crosses IPC.
#[tauri::command]
pub fn setup_master_key_dual(
    password: String,
    recovery_code: String,
    user_entropy: Option<Vec<u8>>,
) -> Result<DualWrappedMasterKey, String> {
    // Validated here rather than trusted: a code that fails to normalize would otherwise be wrapped
    // under its raw form and never open again.
    let code = normalize_recovery_code(&recovery_code)?;

    let mut master_key = [0u8; 32];
    getrandom::getrandom(&mut master_key).map_err(|e| e.to_string())?;
    mix_user_entropy(&mut master_key, user_entropy);

    Ok(DualWrappedMasterKey {
        // The password is wrapped exactly as given - never normalized.
        password_wrapping: wrap_master_key(&master_key, &password)?,
        // Independent salt and IV, minted inside `wrap_master_key`: reusing either across the two
        // wrappings would reveal that they seal identical plaintext.
        recovery_code_wrapping: wrap_master_key(&master_key, &code)?,
    })
}

/// Which kind of credential a side of a re-wrap is, so normalisation is never guessed.
///
/// The previous version inferred it from the shape of the string, which is how a mobile-generated
/// code containing a symbol this client did not know silently derived the wrong key. The caller
/// always knows which it holds; making it say so removes the guess entirely.
#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    Password,
    RecoveryCode,
}

impl CredentialKind {
    /// Normalises a recovery code, and leaves a password exactly as the user typed it.
    fn prepare(self, credential: &str) -> Result<String, String> {
        match self {
            CredentialKind::Password => Ok(credential.to_string()),
            CredentialKind::RecoveryCode => normalize_recovery_code(credential),
        }
    }
}

/// Unwraps with one credential and re-wraps under another, with the key never crossing IPC.
///
/// Two directions use this. The password-reset repair unwraps from the recovery code - the only
/// credential a reset leaves intact - and re-wraps under the new password. The retrofit goes the
/// other way, unwrapping with the password to add a recovery-code wrapping to an account that never
/// had one. Both sides are therefore explicitly typed: an earlier version normalized only the
/// `from` side, so the retrofit wrapped under a *dashed* code that no later unwrap could reproduce.
///
/// The master key is unchanged either way, so every blob sealed under it stays readable - which is
/// the whole reason for re-wrapping rather than re-keying.
#[tauri::command]
pub fn rewrap_master_key(
    encrypted: EncryptedMasterKey,
    from_credential: String,
    from_kind: CredentialKind,
    to_credential: String,
    to_kind: CredentialKind,
) -> Result<EncryptedMasterKey, String> {
    let from = from_kind.prepare(&from_credential)?;
    let to = to_kind.prepare(&to_credential)?;

    let master_key = decrypt_master_key(encrypted, from)?;
    if master_key.len() != 32 {
        return Err("Unwrapped master key is not 32 bytes".to_string());
    }
    wrap_master_key(&master_key, &to)
}

/// Alphabet for recovery codes: digits and uppercase letters minus the characters people reliably
/// confuse when reading a code aloud or copying it off a screen - `0`/`O` and `1`/`I`/`L`.
///
/// A misread code is a code that does not work, and this one gets used exactly once, under stress,
/// after a password reset. That is the worst possible moment to discover an ambiguous glyph.
const RECOVERY_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RECOVERY_GROUPS: usize = 8;
const RECOVERY_GROUP_LEN: usize = 4;

/// Largest multiple of the alphabet size that fits in a byte: 31 × 8 = 248.
///
/// Bytes at or above this are discarded rather than folded, which is what makes the draw uniform.
/// Taking `b % 31` over the whole 0-255 range would make the first eight symbols very slightly
/// likelier than the rest.
const RECOVERY_REJECT_AT: u8 = 248;

/// A fresh recovery code, in eight groups of four.
///
/// 32 characters over a 31-symbol alphabet is ~158.5 bits. The Argon2id pass over it defends a weak
/// *password*; nothing needs to defend this.
///
/// **Rejection sampled, not masked and not modulo.** Masking needs a power-of-two alphabet, which
/// is why the other client briefly added `*` as a 32nd symbol - punctuation in a string a human
/// copies off paper under stress, and a character this client's validator rejected outright.
/// Discarding 8 bytes in 256 costs nothing here and removes the bias without touching the alphabet.
#[tauri::command]
pub fn generate_recovery_code() -> Result<String, String> {
    let total = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
    let mut chars: Vec<char> = Vec::with_capacity(total);

    // Drawn in blocks rather than one byte at a time: the expected number of discards over 32
    // characters is about one, so a single oversized block almost always suffices.
    while chars.len() < total {
        let mut block = vec![0u8; total];
        getrandom::getrandom(&mut block).map_err(|e| e.to_string())?;

        for byte in block {
            if chars.len() == total {
                break;
            }
            if byte >= RECOVERY_REJECT_AT {
                continue;
            }
            chars.push(RECOVERY_ALPHABET[(byte % RECOVERY_ALPHABET.len() as u8) as usize] as char);
        }
    }

    Ok(chars
        .chunks(RECOVERY_GROUP_LEN)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-"))
}

/// Folds a typed recovery code back to the form it was generated in, and rejects anything that is
/// not one.
///
/// Strips whitespace and grouping dashes, then upper-cases: case and grouping are presentation,
/// not secret material, and without this a user who types their code in lower case or without the
/// dashes derives a different key and is told their correct code is wrong.
///
/// <b>Total - it never falls back to the raw input.</b> The previous version returned the input
/// unchanged when validation failed, which meant an invalid or foreign code did not produce "that
/// code isn't valid"; it produced a *different key, silently*, during the one operation the code
/// exists for. That turned a recoverable typo into unrecoverable data loss with no diagnostic.
///
/// Deliberately never applied to a password - passwords are case-sensitive and may contain
/// anything. Callers know which credential they are holding.
fn normalize_recovery_code(input: &str) -> Result<String, String> {
    let normalized: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(|c| c.to_uppercase())
        .collect();

    if normalized.len() != RECOVERY_GROUPS * RECOVERY_GROUP_LEN {
        return Err(format!(
            "InvalidRecoveryCode: expected {} characters, got {}",
            RECOVERY_GROUPS * RECOVERY_GROUP_LEN,
            normalized.len()
        ));
    }
    if let Some(bad) = normalized.chars().find(|c| !RECOVERY_ALPHABET.contains(&(*c as u8))) {
        return Err(format!(
            "InvalidRecoveryCode: '{}' is not a recovery-code character",
            bad
        ));
    }

    Ok(normalized)
}

/// Normalises a typed recovery code, or explains why it is not one.
///
/// Exposed so the UI can validate as the user types, and so the TypeScript layer never has to keep
/// a second copy of these rules that could drift from this one.
#[tauri::command]
pub fn normalize_recovery_code_checked(code: String) -> Result<String, String> {
    normalize_recovery_code(&code)
}

fn mix_user_entropy(master_key: &mut [u8; 32], user_entropy: Option<Vec<u8>>) {
    // XOR user-collected mouse entropy into the master key for extra unpredictability. XOR can only
    // add uncertainty: the OS bytes stand on their own if the entropy is empty or predictable.
    if let Some(entropy) = user_entropy {
        for (i, byte) in entropy.iter().enumerate() {
            master_key[i % 32] ^= byte;
        }
    }
}

/// Seals `master_key` under Argon2id(`credential`), with a fresh salt and IV each time.
fn wrap_master_key(master_key: &[u8], credential: &str) -> Result<EncryptedMasterKey, String> {
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    getrandom::getrandom(&mut iv).map_err(|e| e.to_string())?;

    let params =
        Params::new(ARGON2_MEM, ARGON2_ITERS, ARGON2_LANES, Some(32)).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut wrap_key = [0u8; 32];
    argon2
        .hash_password_into(credential.as_bytes(), &salt, &mut wrap_key)
        .map_err(|e| e.to_string())?;

    let cipher = Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), master_key)
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

/// Unwraps the master key with a credential - either the account password or the recovery code.
///
/// The parameters come from the envelope, never from the constants above, so a wrapping written by
/// an older build stays openable.
#[tauri::command]
pub fn decrypt_master_key(
    encrypted: EncryptedMasterKey,
    password: String,
) -> Result<Vec<u8>, String> {
    let ciphertext = B64
        .decode(&encrypted.cipher_text)
        .map_err(|e| e.to_string())?;
    let salt = B64.decode(&encrypted.salt).map_err(|e| e.to_string())?;
    let iv_bytes = B64.decode(&encrypted.iv).map_err(|e| e.to_string())?;

    let params = Params::new(
        encrypted.argon2_memory,
        encrypted.argon2_iterations,
        encrypted.argon2_parallelism,
        Some(32),
    )
    .map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut wrap_key = [0u8; 32];
    // Used exactly as given. Normalising here would mean guessing whether this is a password or a
    // recovery code, and guessing wrong in either direction derives the wrong key silently -
    // callers normalise the recovery code themselves, because only they know which they hold.
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut wrap_key)
        .map_err(|e| e.to_string())?;

    let cipher = Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&iv_bytes);
    let master_key = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Decryption failed: invalid password or corrupted data".to_string())?;

    Ok(master_key)
}

// ---------------------------------------------------------------------------
// Master-key wrapping tests
// ---------------------------------------------------------------------------
//
// The property under test throughout is the one contract §C.1.1 exists for: a password reset must
// not destroy the master key. That holds only if the two wrappings seal the *same* bytes and the
// recovery code can produce a new password wrapping without changing them.

#[cfg(test)]
mod master_key_tests {
    use super::{
        decrypt_master_key, generate_recovery_code, normalize_recovery_code, rewrap_master_key,
        setup_master_key, setup_master_key_dual, CredentialKind, EncryptedMasterKey,
        RECOVERY_ALPHABET, RECOVERY_REJECT_AT,
    };

    const CODE: &str = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH";

    fn clone_of(key: &EncryptedMasterKey) -> EncryptedMasterKey {
        serde_json::from_str(&serde_json::to_string(key).expect("ser")).expect("de")
    }

    #[test]
    fn both_wrappings_open_to_the_same_master_key() {
        let dual = setup_master_key_dual("hunter2".into(), CODE.into(), None).expect("setup");

        let from_password =
            decrypt_master_key(dual.password_wrapping, "hunter2".into()).expect("password unwrap");
        let from_code = decrypt_master_key(
            dual.recovery_code_wrapping,
            normalize_recovery_code(CODE).expect("normalize"),
        )
        .expect("recovery code unwrap");

        // The whole design rests on this. Two wrappings of *different* keys would look correct
        // right up until the day someone actually needed the recovery path.
        assert_eq!(from_password, from_code);
        assert_eq!(from_password.len(), 32);
    }

    #[test]
    fn the_two_wrappings_do_not_reuse_salt_or_iv() {
        let dual = setup_master_key_dual("hunter2".into(), CODE.into(), None).expect("setup");

        // Same plaintext under two keys is fine; a shared salt or IV would leak that the two
        // wrappings seal identical bytes.
        assert_ne!(dual.password_wrapping.salt, dual.recovery_code_wrapping.salt);
        assert_ne!(dual.password_wrapping.iv, dual.recovery_code_wrapping.iv);
        assert_ne!(
            dual.password_wrapping.cipher_text,
            dual.recovery_code_wrapping.cipher_text
        );
    }

    #[test]
    fn a_password_reset_is_survivable() {
        let code = generate_recovery_code().expect("code");
        let dual = setup_master_key_dual("old-password".into(), code.clone(), None).expect("setup");
        let original =
            decrypt_master_key(dual.password_wrapping, "old-password".into()).expect("unwrap");

        // The reset invalidated the password wrapping; the recovery code is all that is left.
        let rewrapped = rewrap_master_key(
            dual.recovery_code_wrapping,
            code,
            CredentialKind::RecoveryCode,
            "brand-new-password".into(),
            CredentialKind::Password,
        )
        .expect("rewrap");

        let recovered = decrypt_master_key(rewrapped, "brand-new-password".into())
            .expect("the new password must open the re-wrapped envelope");

        // Re-wrapped, not re-keyed: every backup blob sealed under this key stays readable, which
        // is the entire reason the repair works this way.
        assert_eq!(recovered, original);
    }

    #[test]
    fn the_retrofit_direction_produces_a_usable_recovery_code() {
        // Password -> recovery code, for accounts that predate dual wrapping. This direction was
        // broken: only the `from` side was normalized, so the new wrapping was sealed under the
        // *dashed* code while every later unwrap normalized first. The retrofitted code opened
        // nothing, and the user was told they were now protected.
        let existing = setup_master_key("pw".into(), None).expect("setup");
        let original = decrypt_master_key(clone_of(&existing), "pw".into()).expect("unwrap");

        let code = generate_recovery_code().expect("code");
        let recovery_wrapping = rewrap_master_key(
            existing,
            "pw".into(),
            CredentialKind::Password,
            code.clone(),
            CredentialKind::RecoveryCode,
        )
        .expect("retrofit");

        let recovered = decrypt_master_key(
            recovery_wrapping,
            normalize_recovery_code(&code).expect("normalize"),
        )
        .expect("the retrofitted code must open its wrapping");

        assert_eq!(recovered, original);
    }

    #[test]
    fn the_wrong_recovery_code_cannot_rewrap() {
        let dual = setup_master_key_dual("pw".into(), generate_recovery_code().expect("code"), None)
            .expect("setup");

        assert!(rewrap_master_key(
            dual.recovery_code_wrapping,
            generate_recovery_code().expect("other code"),
            CredentialKind::RecoveryCode,
            "new-pw".into(),
            CredentialKind::Password,
        )
        .is_err());
    }

    // ─── Normalisation ────────────────────────────────────────────────────────

    #[test]
    fn every_way_a_human_retypes_a_code_derives_the_same_key() {
        let code = generate_recovery_code().expect("code");
        let dual = setup_master_key_dual("pw".into(), code.clone(), None).expect("setup");
        let bare = code.replace('-', "");

        // Off a piece of paper, in whatever shape it comes out. A correct code that derived the
        // wrong key would tell the user their only surviving credential is wrong, at the one moment
        // they cannot afford to believe it.
        let variants = [
            code.clone(),
            bare.clone(),
            bare.to_lowercase(),
            code.to_lowercase(),
            code.replace('-', " "),
            format!("  {}  ", code),
        ];

        for variant in variants {
            let normalized = normalize_recovery_code(&variant)
                .unwrap_or_else(|e| panic!("'{variant}' must normalize: {e}"));
            decrypt_master_key(clone_of(&dual.recovery_code_wrapping), normalized)
                .unwrap_or_else(|e| panic!("'{variant}' must open the wrapping: {e}"));
        }
    }

    #[test]
    fn an_invalid_code_is_an_error_not_a_different_key() {
        // The defect this replaces: validation failed, the raw input was passed through, and the
        // KDF produced a *different key, silently*. That turned a recoverable typo into
        // unrecoverable data loss with no diagnostic anywhere.
        for bad in ["", "too-short", "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHHH"] {
            assert!(
                normalize_recovery_code(bad).is_err(),
                "'{bad}' must be rejected outright"
            );
        }
    }

    #[test]
    fn a_code_from_outside_the_alphabet_is_rejected_by_name() {
        // Exactly the cross-client failure: the other client briefly emitted `*` as a 32nd symbol.
        // About one character in 32 of such a code was `*`, so most of them hit this path - and the
        // old fallback answered by deriving the wrong key rather than saying anything at all.
        let err = normalize_recovery_code("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHH*")
            .expect_err("must be rejected");
        assert!(err.starts_with("InvalidRecoveryCode"), "error was: {err}");
        assert!(
            err.contains('*'),
            "the error must name the offending character: {err}"
        );

        for ambiguous in ['I', 'L', 'O', '0', '1'] {
            assert!(!RECOVERY_ALPHABET.contains(&(ambiguous as u8)));
        }
    }

    #[test]
    fn a_password_is_never_normalized() {
        // Passwords are case-sensitive and may contain anything; folding one would silently change
        // which key it derives.
        let password = "Correct Horse-Battery Staple";
        let dual =
            setup_master_key_dual(password.into(), generate_recovery_code().expect("c"), None)
                .expect("setup");

        decrypt_master_key(clone_of(&dual.password_wrapping), password.into())
            .expect("the exact password must work");
        assert!(
            decrypt_master_key(dual.password_wrapping, password.to_lowercase()).is_err(),
            "a case-folded password must not open the wrapping"
        );
    }

    // ─── Generation ───────────────────────────────────────────────────────────

    #[test]
    fn recovery_codes_are_unambiguous_and_grouped() {
        let code = generate_recovery_code().expect("code");
        let groups: Vec<&str> = code.split('-').collect();

        assert_eq!(groups.len(), 8);
        assert!(groups.iter().all(|g| g.len() == 4));
        assert!(code
            .bytes()
            .filter(|b| *b != b'-')
            .all(|b| RECOVERY_ALPHABET.contains(&b)));
    }

    #[test]
    fn generation_only_ever_emits_alphabet_characters() {
        // Rejection sampling has a loop in it, so a bug there surfaces as a short code or a stray
        // character rather than as a crash.
        for _ in 0..200 {
            let code = generate_recovery_code().expect("code");
            let bare: String = code.chars().filter(|c| *c != '-').collect();
            assert_eq!(bare.len(), 32);
            assert!(bare.bytes().all(|b| RECOVERY_ALPHABET.contains(&b)));
            normalize_recovery_code(&code).expect("a generated code must always normalize");
        }
    }

    #[test]
    fn the_rejection_threshold_is_a_whole_multiple_of_the_alphabet() {
        // 31 x 8 = 248. If these ever drift apart the draw silently becomes biased again, which is
        // the flaw that led the other client to add a 32nd symbol in the first place.
        assert_eq!(RECOVERY_REJECT_AT as usize % RECOVERY_ALPHABET.len(), 0);
        assert_eq!(RECOVERY_ALPHABET.len(), 31);
    }

    #[test]
    fn recovery_codes_do_not_repeat() {
        let first = generate_recovery_code().expect("code");
        let second = generate_recovery_code().expect("code");
        assert_ne!(first, second);
    }

    #[test]
    fn setup_refuses_an_empty_recovery_code() {
        // An empty code would produce a second wrapping anyone could open, which is worse than
        // having none at all: it would report the account as recoverable.
        assert!(setup_master_key_dual("pw".into(), "   ".into(), None).is_err());
    }

    #[test]
    fn the_single_wrapping_path_still_works_for_existing_accounts() {
        let wrapped = setup_master_key("pw".into(), None).expect("setup");
        assert_eq!(
            decrypt_master_key(wrapped, "pw".into())
                .expect("unwrap")
                .len(),
            32
        );
    }

    #[test]
    fn user_entropy_is_mixed_in_without_being_required() {
        let with = setup_master_key("pw".into(), Some(vec![1, 2, 3, 4])).expect("setup");
        let without = setup_master_key("pw".into(), None).expect("setup");
        assert_eq!(
            decrypt_master_key(with, "pw".into()).expect("unwrap").len(),
            32
        );
        assert_eq!(
            decrypt_master_key(without, "pw".into())
                .expect("unwrap")
                .len(),
            32
        );
    }

    #[test]
    fn declared_master_key_parameters_are_the_ones_actually_used() {
        let wrapped = setup_master_key("pw".into(), None).expect("setup");

        // Each perturbation changes the derived wrap key, so the unwrap must fail. If the reader
        // had been "simplified" to the module constants instead of the envelope header, editing
        // these would change nothing and every case below would still open.
        //
        // `t` and `p` are covered separately on purpose: `Params::new` takes
        // (m_cost, t_cost, p_cost, output_len), so a swapped pair would still read the header
        // while deriving a different key - a bug no "does it read the header" check would catch.
        let perturbations: [(&str, fn(&mut EncryptedMasterKey)); 3] = [
            ("memory", |k| k.argon2_memory += 1024),
            ("iterations", |k| k.argon2_iterations += 1),
            ("parallelism", |k| k.argon2_parallelism += 1),
        ];

        for (name, perturb) in perturbations {
            let mut tampered = clone_of(&wrapped);
            perturb(&mut tampered);
            assert!(
                decrypt_master_key(tampered, "pw".into()).is_err(),
                "changing {name} must change the derived key"
            );
        }

        // The unperturbed envelope still opens - so the failures above are the perturbation and
        // not something incidental about the fixture.
        assert!(decrypt_master_key(wrapped, "pw".into()).is_ok());
    }

    // ─── Cross-client fixture (contract §C.1.2 point 4) ───────────────────────

    /// A recovery code and a wrapping produced by **venta-mobile**, checked in so this client can
    /// prove it opens them.
    ///
    /// The alphabet divergence that prompted this was invisible to every single-client test either
    /// side had: each generated codes its own validator accepted. Only bytes from the other
    /// implementation catch it, which is the same reason the MLS golden vectors exist.
    #[test]
    fn a_recovery_code_from_venta_mobile_opens_its_wrapping_here() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("testdata")
            .join("master-key")
            .join("v1")
            .join("fixture-venta-mobile.json");

        let Ok(raw) = std::fs::read(&path) else {
            // Pending venta-mobile publishing its side. Loud, but not a failure: the always-on
            // guard against the actual incident is
            // `a_code_from_outside_the_alphabet_is_rejected_by_name`, which pins the exact
            // divergence. This is a completeness gap, not an unguarded regression.
            eprintln!(
                "\n!!! PENDING CROSS-CLIENT COVERAGE !!!\n\
                 No venta-mobile master-key fixture at {}.\n\
                 Alpine's own is at ../testdata/master-key/v1/fixture.json (regenerate with\n\
                 `cargo test --lib -- --ignored generate_master_key_fixture`). Until mobile checks\n\
                 in its own, neither client has proved it can open the other's recovery code.\n",
                path.display()
            );
            return;
        };
        let fixture: serde_json::Value = serde_json::from_slice(&raw).expect("fixture json");

        assert_eq!(fixture["producedBy"].as_str(), Some("venta-mobile"));

        let code = fixture["recoveryCode"].as_str().expect("recoveryCode");
        let expected_master_key = fixture["masterKey"].as_str().expect("masterKey");

        // Their code must pass our validator - the exact step that used to fall through to raw
        // input and derive a different key.
        let normalized = normalize_recovery_code(code)
            .unwrap_or_else(|e| panic!("a venta-mobile recovery code must be valid here: {e}"));

        let wrapping: EncryptedMasterKey =
            serde_json::from_value(fixture["recoveryCodeWrapping"].clone()).expect("wrapping");
        let unwrapped = decrypt_master_key(wrapping, normalized)
            .expect("their recovery-code wrapping must open with their code");

        assert_eq!(
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &unwrapped),
            expected_master_key
        );

        // And the password half of the same envelope, so the fixture covers both wrappings.
        let password_wrapping: EncryptedMasterKey =
            serde_json::from_value(fixture["passwordWrapping"].clone()).expect("wrapping");
        let from_password = decrypt_master_key(
            password_wrapping,
            fixture["password"].as_str().expect("password").to_string(),
        )
        .expect("their password wrapping must open with their password");

        assert_eq!(from_password, unwrapped, "both wrappings must seal one key");
    }

    /// Regenerates `testdata/master-key/v1/fixture.json` for venta-mobile to consume.
    ///
    /// Ignored by default: the fixture is a checked-in artefact, and regenerating it on every run
    /// would have each client consuming only bytes it had just produced.
    #[test]
    #[ignore]
    fn generate_master_key_fixture() {
        let code = generate_recovery_code().expect("code");
        let password = "fixture-password";
        let dual = setup_master_key_dual(password.into(), code.clone(), None).expect("setup");
        let master_key = decrypt_master_key(clone_of(&dual.password_wrapping), password.into())
            .expect("unwrap");

        let fixture = serde_json::json!({
            "producedBy": "alpine",
            "alphabet": String::from_utf8_lossy(RECOVERY_ALPHABET),
            "password": password,
            "recoveryCode": code,
            "masterKey": base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD, &master_key),
            "passwordWrapping": dual.password_wrapping,
            "recoveryCodeWrapping": dual.recovery_code_wrapping,
        });

        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("testdata")
            .join("master-key")
            .join("v1");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("fixture.json"),
            serde_json::to_vec_pretty(&fixture).expect("serialize"),
        )
        .expect("write fixture");
    }
}
