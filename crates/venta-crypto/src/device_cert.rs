//! Device-certificate verification (contract §H.2, as corrected by §L.2).
//!
//! A device certificate is an Ed25519 signature by an account's **identity key** over a statement
//! naming one of that account's devices and the public key that device holds. The private half of
//! the identity key is wrapped under the recovery key and never leaves the owner's own clients, so
//! the server cannot mint one. That is the entire value of the object: it lets a peer decide, with
//! none of the owner's devices online and without trusting the server, that a key really belongs to
//! the account the directory says it does.
//!
//! ## Why this module exists
//!
//! Alpine seals payment handles to device public keys fetched from a **server-provided** directory.
//! Encryption alone does not survive a hostile directory: an operator who can change what the
//! directory returns for Ben's device has Anna's client seal to a key the operator holds, and no
//! amount of AES-GCM notices. Until now nothing in this client checked a signature over those bytes
//! - `hasValidCertificate` was the server's word about the server.
//!
//! ## The binding is the point
//!
//! The signed payload is reconstructed here from **the key the caller says it is about to seal
//! to**, and from nothing else. Verifying a signature over a certificate's own self-reported fields
//! answers "did somebody sign this?" rather than "does this vouch for the key in front of me", and
//! because certificates are public a server simply replays a genuine one beside a key it
//! substituted. That was finding C4, found at full enforcement with 100% coverage on mobile. Here
//! there is no second copy of the key to be fooled by: [`DeviceCertificateClaim::public_key_b64`]
//! is both the bytes the payload is built from and the bytes the caller will seal to, and if the
//! wire happened to carry the certificate's declared subject separately the caller passes it as
//! [`DeviceCertificateClaim::certificate_subject_key_b64`] and a difference is refused before any
//! signature is looked at.
//!
//! ## Ported, not invented
//!
//! The payload construction mirrors venta-mobile's `device_cert_payload` in
//! `packages/venta_mls/rust/src/mls.rs` byte for byte - same label, same length framing, same field
//! order, same raw-bytes-not-base64 encoding of the key, same 300-second skew allowance. A
//! divergence here is not a bug in Alpine, it is two clients that cannot verify each other. The
//! cross-client fixture in `testdata/device-cert/v1/` is signed by mobile's compiled engine and is
//! what holds that claim up.
//!
//! What is deliberately **not** here is an issuer. Alpine has no caller that mints a certificate,
//! and `crypto::mls`'s module header states the rule this follows: an unreachable signing surface
//! is worse than an absent one. The test module carries mobile's issuer verbatim, because the tests
//! need one and a test-only signer cannot be reached by the app.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use openmls::prelude::{OpenMlsCrypto, OpenMlsProvider, SignatureScheme};
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::mls::format_fingerprint;

/// Contract §H.2/§K.1, exact and ASCII. A change to this string is a new certificate version, not
/// an edit: every certificate in the field was signed under the old one.
const DEVICE_CERT_LABEL: &str = "venta.device-cert.v1";

/// Tolerance for an issuer whose clock runs ahead of the verifier's. Mirrors mobile's
/// `CERT_CLOCK_SKEW_SECONDS`; small on purpose, because it exists for drift and not for pre-dating.
const CERT_CLOCK_SKEW_SECONDS: i64 = 300;

/// Ed25519 public keys are 32 bytes and Ed25519 signatures are 64. Checked rather than left to the
/// backend, so "truncated in transit" reports as malformed instead of as a forgery.
const ED25519_PUBLIC_KEY_LEN: usize = 32;
const ED25519_SIGNATURE_LEN: usize = 64;

/// `label || len(f0) || f0 || len(f1) || f1 || ...`, lengths as 4-byte big-endian.
///
/// The length prefixes are not decoration. Plain concatenation is ambiguous - `("ab", "c")` and
/// `("a", "bc")` produce identical bytes - so an attacker who can move a byte from one field into
/// the next can make one signature vouch for two different statements.
fn tagged_payload(label: &str, fields: &[&[u8]]) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(label.len() + fields.iter().map(|f| f.len() + 4).sum::<usize>());
    out.extend_from_slice(label.as_bytes());
    for field in fields {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

/// `venta.device-cert.v1 || userId || deviceId || publicKey || issuedAt || expiresAt`.
///
/// Two things about this shape are load-bearing and were both breaking changes on mobile:
///
/// 1. **`userId` is in the payload.** `deviceId` is client-chosen and unique only *per user*, so
///    without the account a certificate for user A's device 7 is a structurally valid certificate
///    for user B's device 7 (§L.2).
/// 2. **The public key is signed as raw bytes, not as the base64 string it travels as.** §K.1 chose
///    the string "so neither side has to agree on a decoding", which is what produced C4: it
///    invited the verifier to compare strings the certificate itself supplied. Raw bytes have
///    exactly one representation, and there is nothing to compare because the bytes come from the
///    caller.
fn device_cert_payload(
    user_id: &str,
    device_id: &str,
    public_key: &[u8],
    issued_at: i64,
    expires_at: i64,
) -> Vec<u8> {
    tagged_payload(
        DEVICE_CERT_LABEL,
        &[
            user_id.as_bytes(),
            device_id.as_bytes(),
            public_key,
            &issued_at.to_be_bytes(),
            &expires_at.to_be_bytes(),
        ],
    )
}

/// One device, as the recipients directory described it, plus the key the caller intends to use.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCertificateClaim {
    pub user_id: String,
    pub device_id: String,

    /// **The key that is about to be sealed to**, base64. The signed payload is reconstructed from
    /// these bytes, which is what makes a certificate covering some other key fail rather than
    /// pass. Never substitute the certificate's own account of the key here.
    pub public_key_b64: String,

    /// The certificate, base64: the raw Ed25519 signature over the payload above. `None` or empty
    /// is the ordinary state of a device registered before certificates existed.
    #[serde(default)]
    pub certificate_b64: Option<String>,

    /// Epoch **seconds**, because that is what the payload signs.
    ///
    /// The payments recipients endpoint serves these as ISO-8601 strings while
    /// `GET /users/{u}/devices/{d}/certificate` serves them as epoch seconds. The caller converts;
    /// handing this an ISO string would make every signature fail to reproduce.
    pub issued_at: i64,
    pub expires_at: i64,

    /// Which generation of the account identity key signed this, per the directory.
    pub identity_key_version: i32,

    /// The key the certificate is *served as* covering, when the wire carries it separately from
    /// the key being used - the MLS leaf path, where the leaf's credential holds one copy and the
    /// certificate DTO another.
    ///
    /// On the payments path they are one field and this is `None`, which is correct: there is only
    /// one key and it is the one the payload is built from. Supplying it where it exists turns a
    /// substitution into the specific verdict [`DeviceCertificateVerdict::KeyMismatch`] instead of
    /// the undifferentiated [`DeviceCertificateVerdict::BadSignature`], which is worth having
    /// because the two want different words in front of a user.
    #[serde(default)]
    pub certificate_subject_key_b64: Option<String>,

    /// The device id the certificate is served as covering, where that too arrives separately.
    #[serde(default)]
    pub certificate_subject_device_id: Option<String>,
}

/// Everything the verifier needs that is a property of the *account*, not of one device.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCertificateExpectation {
    /// The account identity key to verify against, base64.
    ///
    /// This must be the key the caller has **pinned**, not one freshly fetched inside the same
    /// request that produced the certificate. A server that can choose both halves can vouch for
    /// anything it likes. Passing it in rather than fetching it here is deliberate: the pin lives
    /// in the TypeScript layer alongside `device-pin.store`, and this module refuses to have an
    /// opinion about which key is authentic.
    pub account_identity_public_key_b64: String,

    /// The identity-key generation the caller expects. A certificate under a superseded version is
    /// not merely old: the peer's pinning has moved and a human has to re-verify.
    pub expected_identity_key_version: i32,

    /// Lowercase-hex SHA-256 fingerprints from `GET api/v1/users/{userId}/revoked-certificates`.
    ///
    /// Compared case-insensitively. This list is served by the server, so it can only ever *add*
    /// safety: a hostile server omits an entry and the certificate verifies, which is why
    /// revocation is a backstop against a stolen device rather than a defence against the operator.
    #[serde(default)]
    pub revoked_certificate_fingerprints: Vec<String>,

    /// Verification time, epoch seconds. Passed in rather than read from the system clock so the
    /// caller decides what "now" means and so the window checks are testable without sleeping.
    pub now_unix: i64,
}

/// What a certificate turned out to be. Ordered roughly worst-first within each cause.
///
/// Deliberately not a bool. "Expired" means *ask them to open their app*; "key mismatch" means
/// *something is wrong, do not send money*. Collapsing the two loses the only distinction the user
/// actually needs to act on.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceCertificateVerdict {
    /// Signature verifies over the presented key, inside its window, not revoked, expected version.
    Valid,

    /// No certificate was presented. The ordinary state of a device registered before certificates
    /// and **not** by itself evidence of anything - see the note on `trusted`.
    Missing,

    /// Something did not decode or is the wrong length. A wire problem, not a verdict about intent.
    Malformed,

    /// The certificate is served as covering a **different public key** than the one presented.
    ///
    /// Always an attack and never a rollout artefact: certificates are public, so fetching a real
    /// one for the account and presenting it beside a substituted key is the cheapest forgery
    /// available to whoever serves the directory. Never fold this into `Missing` and tolerate it.
    KeyMismatch,

    /// The certificate is served as covering a different device id. Same reasoning as `KeyMismatch`.
    DeviceMismatch,

    /// Signed under a different generation of the account identity key than the caller expected.
    /// Checked *before* the signature, because verifying against a key we already know is the wrong
    /// generation is expected to fail and reporting that as forgery would be a false alarm.
    IdentityKeyVersionMismatch,

    /// The signature does not verify under the given account identity key. Either a forgery or an
    /// identity-key rotation the caller has not picked up; a human decides which.
    BadSignature,

    /// Genuinely signed, and on the account's revocation list.
    Revoked,

    /// Genuinely signed, and `expiresAt` is not after `issuedAt`, so it was never valid for any
    /// instant. An issuer bug rather than an attack, but not something to seal to.
    WindowInverted,

    /// Genuinely signed and past `expiresAt`.
    Expired,

    /// Genuinely signed and `issuedAt` is further ahead than clock drift explains. Accepting one
    /// would let a device that holds the identity key today mint a certificate that only becomes
    /// usable after it has been removed.
    NotYetValid,
}

/// The verdict plus the values a caller needs to show or to log.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCertificateVerification {
    pub user_id: String,
    pub device_id: String,
    pub verdict: DeviceCertificateVerdict,

    /// True only for [`DeviceCertificateVerdict::Valid`].
    ///
    /// A convenience, not the answer. Callers must branch on `verdict`: a UI that treats every
    /// `false` alike tells the owner of an expired certificate the same thing it tells the victim
    /// of a substituted key.
    pub trusted: bool,

    /// Why, in words, when there is more to say than the verdict name. Never shown raw to a user -
    /// it names encodings and lengths - but it is what makes a support log worth reading.
    pub detail: Option<String>,

    /// Eighty-bit fingerprint of the **presented** key, in the format `crypto::mls` already prints
    /// on the join-request review screens and `device-trust.ts` renders in the payments UI. The
    /// same key, so the same string: a user can compare it out of band against the device itself.
    pub fingerprint: Option<String>,

    /// Lowercase-hex SHA-256 of the raw certificate bytes - the same construction
    /// `RevokedDeviceCertificate.Fingerprint` uses server-side, so it can be matched against the
    /// revocation list without the client re-deriving the rule.
    pub certificate_fingerprint: Option<String>,
}

impl DeviceCertificateVerification {
    fn new(
        claim: &DeviceCertificateClaim,
        verdict: DeviceCertificateVerdict,
        detail: Option<String>,
        fingerprint: Option<String>,
        certificate_fingerprint: Option<String>,
    ) -> Self {
        Self {
            user_id: claim.user_id.clone(),
            device_id: claim.device_id.clone(),
            verdict,
            trusted: verdict == DeviceCertificateVerdict::Valid,
            detail,
            fingerprint,
            certificate_fingerprint,
        }
    }
}

/// Lowercase hex, matching `RevokedDeviceCertificate.Fingerprint` in Identity.Domain.
fn certificate_fingerprint(certificate: &[u8]) -> String {
    Sha256::digest(certificate)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Verifies one device certificate against a pinned account identity key.
///
/// ## Order of checks, and why it is this one
///
/// Structure first, then subject binding, then the identity-key generation, then the signature,
/// and only then anything the certificate *says about itself*. The window and the revocation state
/// are read from the payload the signature covers, so checking them after the signature means they
/// are read from authenticated data: an "expired" verdict here is a statement about a certificate
/// the account really issued, not about bytes an attacker chose. Mobile short-circuits the window
/// before the signature; the boolean it returns is the same either way, so this is a better verdict
/// rather than a wire divergence.
pub fn verify_device_certificate(
    crypto: &OpenMlsRustCrypto,
    claim: &DeviceCertificateClaim,
    expectation: &DeviceCertificateExpectation,
) -> DeviceCertificateVerification {
    use DeviceCertificateVerdict as V;

    let malformed = |detail: &str, fingerprint: Option<String>| {
        DeviceCertificateVerification::new(claim, V::Malformed, Some(detail.to_string()), fingerprint, None)
    };

    // The presented key, decoded first: its fingerprint is worth reporting even when everything
    // else about the device fails, because it is the string a user compares out of band.
    let public_key = match B64.decode(claim.public_key_b64.trim()) {
        Ok(bytes) => bytes,
        Err(e) => return malformed(&format!("device public key is not base64: {e}"), None),
    };
    if public_key.len() != ED25519_PUBLIC_KEY_LEN {
        return malformed(
            &format!(
                "device public key is {} bytes, expected {ED25519_PUBLIC_KEY_LEN}",
                public_key.len()
            ),
            None,
        );
    }
    let fingerprint = Some(format_fingerprint(&public_key));

    let Some(certificate_b64) = claim
        .certificate_b64
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return DeviceCertificateVerification::new(
            claim,
            V::Missing,
            Some("no certificate was presented for this device".to_string()),
            fingerprint,
            None,
        );
    };

    let certificate = match B64.decode(certificate_b64) {
        Ok(bytes) => bytes,
        Err(e) => return malformed(&format!("certificate is not base64: {e}"), fingerprint),
    };
    if certificate.len() != ED25519_SIGNATURE_LEN {
        return malformed(
            &format!(
                "certificate is {} bytes, expected an {ED25519_SIGNATURE_LEN}-byte Ed25519 signature",
                certificate.len()
            ),
            fingerprint,
        );
    }
    let cert_fingerprint = Some(certificate_fingerprint(&certificate));

    let account_key = match B64.decode(expectation.account_identity_public_key_b64.trim()) {
        Ok(bytes) => bytes,
        Err(e) => {
            return DeviceCertificateVerification::new(
                claim,
                V::Malformed,
                Some(format!("account identity key is not base64: {e}")),
                fingerprint,
                cert_fingerprint,
            )
        }
    };
    if account_key.len() != ED25519_PUBLIC_KEY_LEN {
        return DeviceCertificateVerification::new(
            claim,
            V::Malformed,
            Some(format!(
                "account identity key is {} bytes, expected {ED25519_PUBLIC_KEY_LEN}",
                account_key.len()
            )),
            fingerprint,
            cert_fingerprint,
        );
    }

    // Subject binding, before anything expensive and before anything forgiving. A certificate that
    // names another key says nothing about this one however good its signature is, and it must not
    // be reachable through a softer verdict.
    if let Some(subject_key_b64) = claim.certificate_subject_key_b64.as_deref() {
        let subject_key = match B64.decode(subject_key_b64.trim()) {
            Ok(bytes) => bytes,
            Err(e) => {
                return DeviceCertificateVerification::new(
                    claim,
                    V::Malformed,
                    Some(format!("certificate subject key is not base64: {e}")),
                    fingerprint,
                    cert_fingerprint,
                )
            }
        };
        // Compared as decoded bytes: two base64 spellings of the same key are the same key, and
        // leaving that as an open question is half of what §L.2 was written to close.
        if subject_key != public_key {
            return DeviceCertificateVerification::new(
                claim,
                V::KeyMismatch,
                Some(
                    "the certificate covers a different public key than the one presented"
                        .to_string(),
                ),
                fingerprint,
                cert_fingerprint,
            );
        }
    }
    if let Some(subject_device_id) = claim.certificate_subject_device_id.as_deref() {
        if subject_device_id != claim.device_id {
            return DeviceCertificateVerification::new(
                claim,
                V::DeviceMismatch,
                Some(format!(
                    "the certificate names device {subject_device_id}, presented for {}",
                    claim.device_id
                )),
                fingerprint,
                cert_fingerprint,
            );
        }
    }

    if claim.identity_key_version != expectation.expected_identity_key_version {
        return DeviceCertificateVerification::new(
            claim,
            V::IdentityKeyVersionMismatch,
            Some(format!(
                "signed under identity key version {}, expected {}",
                claim.identity_key_version, expectation.expected_identity_key_version
            )),
            fingerprint,
            cert_fingerprint,
        );
    }

    // Built from the caller's key, the caller's ids and the caller's window. Every one of those is
    // a field an attacker would have to change to move this certificate somewhere it does not
    // belong, and changing any of them changes these bytes.
    let payload = device_cert_payload(
        &claim.user_id,
        &claim.device_id,
        &public_key,
        claim.issued_at,
        claim.expires_at,
    );

    if crypto
        .crypto()
        .verify_signature(SignatureScheme::ED25519, &payload, &account_key, &certificate)
        .is_err()
    {
        return DeviceCertificateVerification::new(
            claim,
            V::BadSignature,
            Some(
                "the certificate does not verify under the pinned account identity key".to_string(),
            ),
            fingerprint,
            cert_fingerprint,
        );
    }

    // From here down the fields are authenticated: the signature covers them, so a failure is a
    // statement about a certificate the account really issued.

    let cert_fp = cert_fingerprint.as_deref().unwrap_or_default();
    if expectation
        .revoked_certificate_fingerprints
        .iter()
        .any(|f| f.trim().eq_ignore_ascii_case(cert_fp))
    {
        return DeviceCertificateVerification::new(
            claim,
            V::Revoked,
            Some("this certificate is on the account's revocation list".to_string()),
            fingerprint,
            cert_fingerprint,
        );
    }

    if claim.expires_at <= claim.issued_at {
        return DeviceCertificateVerification::new(
            claim,
            V::WindowInverted,
            Some(format!(
                "expiresAt {} is not after issuedAt {}",
                claim.expires_at, claim.issued_at
            )),
            fingerprint,
            cert_fingerprint,
        );
    }
    if claim.expires_at <= expectation.now_unix {
        return DeviceCertificateVerification::new(
            claim,
            V::Expired,
            Some(format!(
                "expired at {}, now {}",
                claim.expires_at, expectation.now_unix
            )),
            fingerprint,
            cert_fingerprint,
        );
    }
    if claim.issued_at > expectation.now_unix + CERT_CLOCK_SKEW_SECONDS {
        return DeviceCertificateVerification::new(
            claim,
            V::NotYetValid,
            Some(format!(
                "issued at {}, now {} (skew allowance {CERT_CLOCK_SKEW_SECONDS}s)",
                claim.issued_at, expectation.now_unix
            )),
            fingerprint,
            cert_fingerprint,
        );
    }

    DeviceCertificateVerification::new(claim, V::Valid, None, fingerprint, cert_fingerprint)
}

/// Verifies every device in one directory response.
///
/// Batched because that is the shape of the question: the payments UI reads a recipient list and
/// has to render a verdict per device before it can offer to seal to any of them, and one IPC hop
/// per housemate's phone would be a round trip per row for no gain. The provider is constructed
/// once here rather than per certificate.
pub fn verify_device_certificates(
    claims: &[DeviceCertificateClaim],
    expectation: &DeviceCertificateExpectation,
) -> Vec<DeviceCertificateVerification> {
    // Stateless: `verify_signature` touches only the crypto backend, never the storage provider.
    let crypto = OpenMlsRustCrypto::default();
    claims
        .iter()
        .map(|claim| verify_device_certificate(&crypto, claim, expectation))
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri command - a thin wrapper around the engine above
// ---------------------------------------------------------------------------

/// Verifies the device certificates in a recipients response.
///
/// Takes no `MlsState`, unlike every command in `crypto::mls`: verification is pure, and requiring
/// an unlocked MLS engine would make a payments screen fail closed for a reason that has nothing to
/// do with payments.
///
/// Infallible by design. Every way this can go wrong is a verdict about one device rather than an
/// error about the batch, because a `Result::Err` here would collapse "Ben's certificate is
/// malformed" into "the whole recipient list could not be checked" and invite a caller to fall back
/// to sealing unverified.
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn device_cert_verify(
    claims: Vec<DeviceCertificateClaim>,
    expectation: DeviceCertificateExpectation,
) -> Vec<DeviceCertificateVerification> {
    verify_device_certificates(&claims, &expectation)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Native-only: `mobile_fixture()` reads `testdata/device-cert/v1/` off disk, and `std::fs` on
// `wasm32-unknown-unknown` is a stub that returns `Unsupported`. Verification itself is pure and
// takes `now_unix` from its caller, so there is nothing target-dependent left to cover here.
#[cfg(not(target_arch = "wasm32"))]
#[cfg(test)]
mod tests {
    use super::*;
    use openmls_rust_crypto::OpenMlsRustCrypto;

    /// venta-mobile's `issue_device_certificate`, verbatim except that it takes the key as raw
    /// bytes because the tests already hold them that way.
    ///
    /// **Test-only, and it stays test-only.** Alpine has no caller that mints a certificate, and
    /// `crypto::mls`'s header states the rule: an unreachable signing surface is worse than an
    /// absent one. When Alpine does need to issue (contract §2a), this is the function to promote,
    /// not a new one to write.
    fn issue(
        crypto: &OpenMlsRustCrypto,
        account_private_key: &[u8],
        user_id: &str,
        device_id: &str,
        public_key: &[u8],
        issued_at: i64,
        expires_at: i64,
    ) -> String {
        let payload = device_cert_payload(user_id, device_id, public_key, issued_at, expires_at);
        let signature = crypto
            .crypto()
            .sign(SignatureScheme::ED25519, &payload, account_private_key)
            .expect("sign");
        B64.encode(signature)
    }

    struct Account {
        private: Vec<u8>,
        public_b64: String,
    }

    fn account(crypto: &OpenMlsRustCrypto) -> Account {
        let (private, public) = crypto
            .crypto()
            .signature_key_gen(SignatureScheme::ED25519)
            .expect("keygen");
        Account {
            private,
            public_b64: B64.encode(&public),
        }
    }

    const NOW: i64 = 1_780_000_000;
    const USER: &str = "usr_anna";
    const DEVICE: &str = "dev_bens_phone";

    /// A 32-byte key that is not a real curve point, which is fine: nothing here does point
    /// arithmetic on the *device* key. It is signed data.
    fn key(seed: u8) -> Vec<u8> {
        (0..32u8).map(|i| i.wrapping_mul(7).wrapping_add(seed)).collect()
    }

    fn claim(public_key: &[u8], certificate: Option<String>) -> DeviceCertificateClaim {
        DeviceCertificateClaim {
            user_id: USER.to_string(),
            device_id: DEVICE.to_string(),
            public_key_b64: B64.encode(public_key),
            certificate_b64: certificate,
            issued_at: NOW - 3_600,
            expires_at: NOW + 86_400,
            identity_key_version: 1,
            certificate_subject_key_b64: None,
            certificate_subject_device_id: None,
        }
    }

    fn expectation(account_public_key_b64: &str) -> DeviceCertificateExpectation {
        DeviceCertificateExpectation {
            account_identity_public_key_b64: account_public_key_b64.to_string(),
            expected_identity_key_version: 1,
            revoked_certificate_fingerprints: vec![],
            now_unix: NOW,
        }
    }

    fn verdict_of(
        claim: &DeviceCertificateClaim,
        expectation: &DeviceCertificateExpectation,
    ) -> DeviceCertificateVerdict {
        let crypto = OpenMlsRustCrypto::default();
        verify_device_certificate(&crypto, claim, expectation).verdict
    }

    /// Signs `claim` as it stands, so the certificate always matches the claim it is attached to.
    fn signed(crypto: &OpenMlsRustCrypto, acct: &Account, c: &mut DeviceCertificateClaim) {
        let public_key = B64.decode(&c.public_key_b64).expect("key");
        c.certificate_b64 = Some(issue(
            crypto,
            &acct.private,
            &c.user_id,
            &c.device_id,
            &public_key,
            c.issued_at,
            c.expires_at,
        ));
    }

    // ── The happy path ────────────────────────────────────────────────────────

    #[test]
    fn a_certificate_over_the_presented_key_verifies() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let result = verify_device_certificate(&crypto, &c, &expectation(&acct.public_b64));
        assert_eq!(result.verdict, DeviceCertificateVerdict::Valid);
        assert!(result.trusted);
        assert!(result.detail.is_none());
        assert_eq!(
            result.fingerprint.as_deref(),
            Some(format_fingerprint(&key(3)).as_str()),
            "the fingerprint must be the presented key's, in the format the MLS screens print"
        );
    }

    // ── The substitution this whole feature exists to stop ────────────────────

    /// The attack in one test. The certificate is genuine, unexpired, signed by the real account
    /// identity key, and about a **different** key than the one the caller is holding.
    #[test]
    fn a_genuine_certificate_over_another_key_does_not_vouch_for_this_one() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        // Ben's real device key, and the certificate his account really issued for it.
        let bens_key = key(3);
        let genuine = issue(
            &crypto,
            &acct.private,
            USER,
            DEVICE,
            &bens_key,
            NOW - 3_600,
            NOW + 86_400,
        );

        // The directory now returns the operator's key beside Ben's real certificate.
        let substituted = claim(&key(200), Some(genuine));
        assert_eq!(
            verdict_of(&substituted, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::BadSignature,
            "sealing to a key the certificate does not cover must never come back trusted"
        );
    }

    /// The same substitution on a wire that carries the certificate's declared subject separately -
    /// the MLS leaf path. There the mismatch is nameable, and it is refused before the signature is
    /// looked at at all.
    #[test]
    fn a_declared_subject_key_that_differs_is_refused_by_name() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        let mut c = claim(&key(200), None);
        c.certificate_subject_key_b64 = Some(B64.encode(key(3)));
        // Signed over the *presented* key, so the signature itself is impeccable. Only the binding
        // is wrong, which is exactly the case a signature check alone cannot see.
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::KeyMismatch
        );
    }

    #[test]
    fn a_differently_spelled_base64_of_the_same_key_is_the_same_key() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        // Standard base64 with padding on one side, the same bytes with surrounding whitespace on
        // the other. Decoded comparison must see through it.
        c.certificate_subject_key_b64 = Some(format!("  {}  ", B64.encode(key(3))));
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::Valid
        );
    }

    #[test]
    fn a_certificate_naming_another_device_is_refused_by_name() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        c.certificate_subject_device_id = Some("dev_someone_elses".to_string());
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::DeviceMismatch
        );
    }

    /// §L.2: `deviceId` is unique only per user, so the account has to be in the payload or a
    /// certificate for Anna's device 7 is a valid certificate for Ben's device 7.
    #[test]
    fn a_certificate_does_not_transfer_to_another_account_with_the_same_device_id() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        c.user_id = "usr_ben".to_string();
        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::BadSignature
        );
    }

    /// The window is signed, so moving it invalidates the signature rather than extending the
    /// certificate. This is what stops a 180-day statement from being made permanent on the wire.
    #[test]
    fn the_validity_window_cannot_be_extended_without_breaking_the_signature() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        for shifted in [c.issued_at + 1, c.issued_at - 1] {
            let mut moved = c.clone();
            moved.issued_at = shifted;
            assert_eq!(
                verdict_of(&moved, &expectation(&acct.public_b64)),
                DeviceCertificateVerdict::BadSignature
            );
        }
        let mut extended = c.clone();
        extended.expires_at += 1;
        assert_eq!(
            verdict_of(&extended, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::BadSignature
        );
    }

    // ── Tampering ─────────────────────────────────────────────────────────────

    #[test]
    fn one_flipped_bit_in_the_signature_fails() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let mut bytes = B64.decode(c.certificate_b64.as_ref().unwrap()).unwrap();
        // Every byte, not one convenient byte: a verifier that only looked at a prefix would pass a
        // single-position check.
        for i in 0..bytes.len() {
            let mut tampered = bytes.clone();
            tampered[i] ^= 0x01;
            let mut probe = c.clone();
            probe.certificate_b64 = Some(B64.encode(&tampered));
            assert_eq!(
                verdict_of(&probe, &expectation(&acct.public_b64)),
                DeviceCertificateVerdict::BadSignature,
                "flipping bit 0 of signature byte {i} must fail"
            );
        }
        bytes[0] ^= 0x01;
        assert_ne!(bytes, B64.decode(c.certificate_b64.as_ref().unwrap()).unwrap());
    }

    #[test]
    fn one_flipped_bit_in_the_payload_fails_with_the_signature_untouched() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let mut public_key = B64.decode(&c.public_key_b64).unwrap();
        for i in 0..public_key.len() {
            let mut tampered = public_key.clone();
            tampered[i] ^= 0x01;
            let mut probe = c.clone();
            probe.public_key_b64 = B64.encode(&tampered);
            assert_eq!(
                verdict_of(&probe, &expectation(&acct.public_b64)),
                DeviceCertificateVerdict::BadSignature,
                "flipping bit 0 of key byte {i} must fail"
            );
        }
        public_key[0] ^= 0x01;

        // And the device id, which is the other half of the subject.
        let mut renamed = c.clone();
        renamed.device_id = format!("{DEVICE}x");
        assert_eq!(
            verdict_of(&renamed, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::BadSignature
        );
    }

    /// A server holding no account identity private key can only sign with some other key. §H.8's
    /// headline obligation.
    #[test]
    fn a_certificate_signed_by_the_wrong_identity_key_fails() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let impostor = account(&crypto);

        let mut c = claim(&key(3), None);
        signed(&crypto, &impostor, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::BadSignature
        );
        // And the mirror: the impostor's key does verify its own certificate, so the test above is
        // about *which* key and not about the signing being broken.
        assert_eq!(
            verdict_of(&c, &expectation(&impostor.public_b64)),
            DeviceCertificateVerdict::Valid
        );
    }

    // ── The window ────────────────────────────────────────────────────────────

    #[test]
    fn an_expired_certificate_is_expired_and_not_merely_invalid() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        c.issued_at = NOW - 200_000;
        c.expires_at = NOW - 100;
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::Expired,
            "expired must be distinguishable from forged: it is the one case that means 'ask them \
             to open their app' rather than 'do not send money'"
        );
    }

    #[test]
    fn expiry_is_exclusive_at_the_boundary() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        let mut at_expiry = claim(&key(3), None);
        at_expiry.expires_at = NOW;
        signed(&crypto, &acct, &mut at_expiry);
        assert_eq!(
            verdict_of(&at_expiry, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::Expired,
            "expiresAt == now is expired; mobile's comparison is `expires_at <= now`"
        );

        let mut one_second_left = claim(&key(3), None);
        one_second_left.expires_at = NOW + 1;
        signed(&crypto, &acct, &mut one_second_left);
        assert_eq!(
            verdict_of(&one_second_left, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::Valid
        );
    }

    #[test]
    fn a_certificate_issued_beyond_the_skew_allowance_is_not_yet_valid() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        c.issued_at = NOW + 86_400;
        c.expires_at = c.issued_at + 86_400;
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::NotYetValid
        );
    }

    #[test]
    fn a_certificate_inside_the_skew_allowance_is_accepted() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        let mut inside = claim(&key(3), None);
        inside.issued_at = NOW + CERT_CLOCK_SKEW_SECONDS;
        inside.expires_at = inside.issued_at + 86_400;
        signed(&crypto, &acct, &mut inside);
        assert_eq!(
            verdict_of(&inside, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::Valid,
            "the allowance exists for clock drift and has to actually allow it"
        );

        let mut outside = inside.clone();
        outside.issued_at = NOW + CERT_CLOCK_SKEW_SECONDS + 1;
        outside.expires_at = outside.issued_at + 86_400;
        signed(&crypto, &acct, &mut outside);
        assert_eq!(
            verdict_of(&outside, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::NotYetValid
        );
    }

    #[test]
    fn an_inverted_window_is_refused_however_good_the_signature() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        c.issued_at = NOW + 86_400;
        c.expires_at = NOW - 86_400;
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::WindowInverted,
            "a window that was never open must not be reported as merely expired"
        );
    }

    #[test]
    fn a_zero_length_window_is_refused() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        c.issued_at = NOW;
        c.expires_at = NOW;
        signed(&crypto, &acct, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::WindowInverted
        );
    }

    // ── Revocation ────────────────────────────────────────────────────────────

    #[test]
    fn a_revoked_certificate_is_refused_and_named_as_revoked() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let raw = B64.decode(c.certificate_b64.as_ref().unwrap()).unwrap();
        let mut exp = expectation(&acct.public_b64);
        exp.revoked_certificate_fingerprints = vec![certificate_fingerprint(&raw)];

        let result = verify_device_certificate(&crypto, &c, &exp);
        assert_eq!(result.verdict, DeviceCertificateVerdict::Revoked);
        assert_eq!(
            result.certificate_fingerprint.as_deref(),
            Some(certificate_fingerprint(&raw).as_str())
        );
    }

    /// The server serves the list; a client that only matched the server's own casing would miss an
    /// entry for a formatting reason.
    #[test]
    fn revocation_fingerprints_match_regardless_of_case_or_padding() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let raw = B64.decode(c.certificate_b64.as_ref().unwrap()).unwrap();
        let mut exp = expectation(&acct.public_b64);
        exp.revoked_certificate_fingerprints =
            vec![format!("  {}  ", certificate_fingerprint(&raw).to_uppercase())];

        assert_eq!(verdict_of(&c, &exp), DeviceCertificateVerdict::Revoked);
    }

    /// The fingerprint is the one the server computes, so a client can match the list without
    /// re-deriving the rule. `RevokedDeviceCertificate.Fingerprint` is
    /// `Convert.ToHexString(SHA256.HashData(certificate)).ToLowerInvariant()`.
    #[test]
    fn the_certificate_fingerprint_is_lowercase_hex_sha256_of_the_raw_bytes() {
        let fp = certificate_fingerprint(b"");
        assert_eq!(
            fp, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "the empty-string SHA-256, lowercase hex, unseparated"
        );
        assert_eq!(fp.len(), 64);
    }

    #[test]
    fn an_unrelated_revocation_entry_does_not_refuse_this_certificate() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let mut exp = expectation(&acct.public_b64);
        exp.revoked_certificate_fingerprints = vec![certificate_fingerprint(b"somebody else")];
        assert_eq!(verdict_of(&c, &exp), DeviceCertificateVerdict::Valid);
    }

    // ── Identity-key version ──────────────────────────────────────────────────

    #[test]
    fn an_unexpected_identity_key_version_is_reported_as_such() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);
        c.identity_key_version = 2;

        let result = verify_device_certificate(&crypto, &c, &expectation(&acct.public_b64));
        assert_eq!(
            result.verdict,
            DeviceCertificateVerdict::IdentityKeyVersionMismatch,
            "a rotation the caller has not picked up must not read as a forgery"
        );
        assert!(result.detail.unwrap().contains("expected 1"));
    }

    /// The version is checked before the signature deliberately: verifying against a key we already
    /// know is the wrong generation is expected to fail, and calling that a forgery is a false
    /// alarm about a routine rotation.
    #[test]
    fn a_version_mismatch_is_reported_before_a_signature_failure() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let impostor = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &impostor, &mut c);
        c.identity_key_version = 7;

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::IdentityKeyVersionMismatch
        );
    }

    /// And the mirror: the version is not a substitute for verification. Matching versions with a
    /// forged signature is still a forgery.
    #[test]
    fn a_matching_version_does_not_excuse_a_bad_signature() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let impostor = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &impostor, &mut c);

        assert_eq!(
            verdict_of(&c, &expectation(&acct.public_b64)),
            DeviceCertificateVerdict::BadSignature
        );
    }

    // ── Malformed, truncated, empty ───────────────────────────────────────────

    #[test]
    fn an_absent_certificate_is_missing_rather_than_invalid() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        for absent in [None, Some(String::new()), Some("   ".to_string())] {
            let c = claim(&key(3), absent);
            let result = verify_device_certificate(&crypto, &c, &expectation(&acct.public_b64));
            assert_eq!(result.verdict, DeviceCertificateVerdict::Missing);
            assert!(!result.trusted);
            assert!(
                result.fingerprint.is_some(),
                "a device with no certificate still has a fingerprint to compare out of band"
            );
        }
    }

    #[test]
    fn a_truncated_certificate_is_malformed_rather_than_forged() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        let raw = B64.decode(c.certificate_b64.as_ref().unwrap()).unwrap();
        for len in [0usize, 1, 32, 63, 65] {
            let mut probe = c.clone();
            let mut truncated = raw.clone();
            truncated.resize(len, 0);
            probe.certificate_b64 = Some(B64.encode(&truncated));
            assert_eq!(
                verdict_of(&probe, &expectation(&acct.public_b64)),
                if len == 0 {
                    // Zero bytes encodes to the empty string, which is indistinguishable from
                    // "nothing was served" and is the more useful reading of it.
                    DeviceCertificateVerdict::Missing
                } else {
                    DeviceCertificateVerdict::Malformed
                },
                "a {len}-byte certificate"
            );
        }
    }

    #[test]
    fn certificate_bytes_that_are_not_base64_are_malformed() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let c = claim(&key(3), Some("not base64 !!!".to_string()));

        let result = verify_device_certificate(&crypto, &c, &expectation(&acct.public_b64));
        assert_eq!(result.verdict, DeviceCertificateVerdict::Malformed);
        assert!(result.detail.unwrap().contains("not base64"));
    }

    #[test]
    fn a_device_key_of_the_wrong_shape_is_malformed_and_never_sealed_to() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        for bad in ["", "@@@@", &B64.encode([0u8; 31]), &B64.encode([0u8; 33])] {
            let mut c = claim(&key(3), Some(B64.encode([0u8; 64])));
            c.public_key_b64 = bad.to_string();
            assert_eq!(
                verdict_of(&c, &expectation(&acct.public_b64)),
                DeviceCertificateVerdict::Malformed,
                "device key {bad:?}"
            );
        }
    }

    #[test]
    fn an_account_identity_key_of_the_wrong_shape_is_malformed() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);
        let mut c = claim(&key(3), None);
        signed(&crypto, &acct, &mut c);

        for bad in ["", "%%%%", &B64.encode([0u8; 31])] {
            let mut exp = expectation(&acct.public_b64);
            exp.account_identity_public_key_b64 = bad.to_string();
            assert_eq!(
                verdict_of(&c, &exp),
                DeviceCertificateVerdict::Malformed,
                "account key {bad:?}"
            );
        }
    }

    #[test]
    fn an_empty_batch_is_an_empty_result_and_not_an_error() {
        let result = verify_device_certificates(&[], &expectation(&B64.encode([0u8; 32])));
        assert!(result.is_empty());
    }

    #[test]
    fn a_batch_reports_one_verdict_per_device_in_order() {
        let crypto = OpenMlsRustCrypto::default();
        let acct = account(&crypto);

        let mut good = claim(&key(3), None);
        signed(&crypto, &acct, &mut good);
        good.device_id = "dev_good".to_string();
        signed(&crypto, &acct, &mut good);

        let mut expired = claim(&key(9), None);
        expired.device_id = "dev_expired".to_string();
        expired.issued_at = NOW - 200_000;
        expired.expires_at = NOW - 1;
        signed(&crypto, &acct, &mut expired);

        let missing = {
            let mut c = claim(&key(11), None);
            c.device_id = "dev_no_cert".to_string();
            c
        };

        let results = verify_device_certificates(
            &[good, expired, missing],
            &expectation(&acct.public_b64),
        );
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].device_id, "dev_good");
        assert_eq!(results[0].verdict, DeviceCertificateVerdict::Valid);
        assert_eq!(results[1].device_id, "dev_expired");
        assert_eq!(results[1].verdict, DeviceCertificateVerdict::Expired);
        assert_eq!(results[2].device_id, "dev_no_cert");
        assert_eq!(results[2].verdict, DeviceCertificateVerdict::Missing);
    }

    // ── The wire format ───────────────────────────────────────────────────────

    /// The signed bytes, spelled out from the contract rather than from the code that produces
    /// them. §K.1 fixes the framing and §L.2 fixes the field list; if either moves, this fails
    /// before any cross-client fixture has to.
    #[test]
    fn the_signed_payload_is_the_one_the_contract_names() {
        let payload = device_cert_payload("ab", "cd", &[0xAA, 0xBB], 1, -1);

        let mut expected = Vec::new();
        expected.extend_from_slice(b"venta.device-cert.v1");
        expected.extend_from_slice(&2u32.to_be_bytes());
        expected.extend_from_slice(b"ab");
        expected.extend_from_slice(&2u32.to_be_bytes());
        expected.extend_from_slice(b"cd");
        expected.extend_from_slice(&2u32.to_be_bytes());
        expected.extend_from_slice(&[0xAA, 0xBB]);
        expected.extend_from_slice(&8u32.to_be_bytes());
        expected.extend_from_slice(&1i64.to_be_bytes());
        expected.extend_from_slice(&8u32.to_be_bytes());
        expected.extend_from_slice(&(-1i64).to_be_bytes());

        assert_eq!(payload, expected);
    }

    /// The reason the lengths are prefixed. Without them `("ab","c")` and `("a","bc")` are the same
    /// bytes and one signature vouches for two different statements.
    #[test]
    fn field_boundaries_cannot_be_moved() {
        assert_ne!(
            device_cert_payload("ab", "c", &[1], 0, 0),
            device_cert_payload("a", "bc", &[1], 0, 0)
        );
    }

    // ── Cross-client vectors ──────────────────────────────────────────────────

    fn mobile_fixture() -> serde_json::Value {
        // Two levels: this crate is `crates/venta-crypto`, `testdata/` is at the repo root. It was
        // one while the engine lived in `src-tauri`; the fixture itself did not move.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("testdata")
            .join("device-cert")
            .join("v1")
            .join("fixture-venta-mobile.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("fixture is valid JSON")
    }

    fn from_fixture(
        f: &serde_json::Value,
        cert_field: &str,
        issued_field: &str,
        expires_field: &str,
    ) -> DeviceCertificateClaim {
        DeviceCertificateClaim {
            user_id: f["userId"].as_str().unwrap().to_string(),
            device_id: f["deviceId"].as_str().unwrap().to_string(),
            public_key_b64: f["deviceSignatureKeyB64"].as_str().unwrap().to_string(),
            certificate_b64: Some(f[cert_field].as_str().unwrap().to_string()),
            issued_at: f[issued_field].as_i64().unwrap(),
            expires_at: f[expires_field].as_i64().unwrap(),
            identity_key_version: 1,
            certificate_subject_key_b64: None,
            certificate_subject_device_id: None,
        }
    }

    /// **A real cross-client vector, not a fixture this file made up.**
    ///
    /// Every certificate in `testdata/device-cert/v1/fixture-venta-mobile.json` was signed by
    /// venta-mobile's compiled engine (`venta_mls.dll`, `issueDeviceCertificate` over the C ABI),
    /// which is the only production implementation of this format that exists. If Alpine's payload
    /// construction drifts from mobile's by one byte - a field reordered, a length dropped, the key
    /// signed as base64 again - none of these verify. That is the whole point of checking it in:
    /// two engines that cannot verify each other's certificates would each pass their own tests.
    #[test]
    fn this_engine_verifies_venta_mobiles_certificates() {
        let f = mobile_fixture();
        let account_key = f["accountIdentityPublicKeyB64"].as_str().unwrap();

        let good = from_fixture(&f, "certificateB64", "issuedAt", "expiresAt");
        let mut exp = expectation(account_key);
        // Inside the fixture's own window, which is fixed so the vector does not rot.
        exp.now_unix = good.issued_at + 60;

        assert_eq!(
            verdict_of(&good, &exp),
            DeviceCertificateVerdict::Valid,
            "a certificate minted by venta-mobile must verify here"
        );
    }

    #[test]
    fn venta_mobiles_certificate_for_another_key_does_not_vouch_for_this_one() {
        let f = mobile_fixture();
        let account_key = f["accountIdentityPublicKeyB64"].as_str().unwrap();

        // Mobile really signed this, for this account and this device id - over the *other* key.
        let mut substituted = from_fixture(&f, "certificateOverOtherKeyB64", "issuedAt", "expiresAt");
        let mut exp = expectation(account_key);
        exp.now_unix = substituted.issued_at + 60;

        assert_eq!(
            verdict_of(&substituted, &exp),
            DeviceCertificateVerdict::BadSignature,
            "the substitution attack, against certificates a real issuer produced"
        );

        // Presented beside the key it actually covers, the same bytes verify. Which is what makes
        // the assertion above about the binding and not about the certificate being broken.
        substituted.public_key_b64 = f["otherDeviceSignatureKeyB64"].as_str().unwrap().to_string();
        assert_eq!(verdict_of(&substituted, &exp), DeviceCertificateVerdict::Valid);
    }

    #[test]
    fn venta_mobiles_expired_and_future_certificates_land_in_the_right_verdicts() {
        let f = mobile_fixture();
        let account_key = f["accountIdentityPublicKeyB64"].as_str().unwrap();

        let good = from_fixture(&f, "certificateB64", "issuedAt", "expiresAt");
        let mut exp = expectation(account_key);
        exp.now_unix = good.issued_at + 60;

        let expired = from_fixture(
            &f,
            "certificateExpiredB64",
            "expiredIssuedAt",
            "expiredExpiresAt",
        );
        assert_eq!(verdict_of(&expired, &exp), DeviceCertificateVerdict::Expired);

        let future = from_fixture(
            &f,
            "certificateNotYetValidB64",
            "futureIssuedAt",
            "futureExpiresAt",
        );
        assert_eq!(verdict_of(&future, &exp), DeviceCertificateVerdict::NotYetValid);

        let inverted = from_fixture(
            &f,
            "certificateInvertedWindowB64",
            "invertedIssuedAt",
            "invertedExpiresAt",
        );
        assert_eq!(
            verdict_of(&inverted, &exp),
            DeviceCertificateVerdict::WindowInverted
        );
    }

    #[test]
    fn venta_mobiles_certificate_from_the_wrong_issuer_fails_against_the_pinned_key() {
        let f = mobile_fixture();
        let account_key = f["accountIdentityPublicKeyB64"].as_str().unwrap();
        let impostor_key = f["impostorIdentityPublicKeyB64"].as_str().unwrap();

        let forged = from_fixture(&f, "certificateWrongIssuerB64", "issuedAt", "expiresAt");
        let mut exp = expectation(account_key);
        exp.now_unix = forged.issued_at + 60;

        assert_eq!(verdict_of(&forged, &exp), DeviceCertificateVerdict::BadSignature);

        // It is a real certificate, just not this account's - which is exactly what a server that
        // holds no account identity private key can produce.
        let mut impostor_exp = expectation(impostor_key);
        impostor_exp.now_unix = exp.now_unix;
        assert_eq!(verdict_of(&forged, &impostor_exp), DeviceCertificateVerdict::Valid);
    }

    // ── Serialization across the IPC boundary ─────────────────────────────────

    #[test]
    fn verdicts_serialize_as_the_kebab_case_names_the_ui_switches_on() {
        let json = serde_json::to_string(&DeviceCertificateVerdict::KeyMismatch).unwrap();
        assert_eq!(json, "\"key-mismatch\"");
        assert_eq!(
            serde_json::to_string(&DeviceCertificateVerdict::IdentityKeyVersionMismatch).unwrap(),
            "\"identity-key-version-mismatch\""
        );
        assert_eq!(
            serde_json::to_string(&DeviceCertificateVerdict::NotYetValid).unwrap(),
            "\"not-yet-valid\""
        );
    }

    #[test]
    fn a_claim_deserializes_from_the_camel_case_the_frontend_sends() {
        let claim: DeviceCertificateClaim = serde_json::from_str(
            r#"{
                "userId": "usr_1",
                "deviceId": "dev_1",
                "publicKeyB64": "AAAA",
                "issuedAt": 1,
                "expiresAt": 2,
                "identityKeyVersion": 3
            }"#,
        )
        .expect("optional fields must be optional");
        assert_eq!(claim.user_id, "usr_1");
        assert!(claim.certificate_b64.is_none());
        assert!(claim.certificate_subject_key_b64.is_none());

        let expectation: DeviceCertificateExpectation = serde_json::from_str(
            r#"{
                "accountIdentityPublicKeyB64": "AAAA",
                "expectedIdentityKeyVersion": 1,
                "nowUnix": 10
            }"#,
        )
        .expect("the revocation list must default to empty");
        assert!(expectation.revoked_certificate_fingerprints.is_empty());
    }
}
