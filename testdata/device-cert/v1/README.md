# Cross-client device-certificate vectors, v1

Contract §H.2, as corrected by §L.2. The certificates in `fixture-venta-mobile.json` were **signed
by venta-mobile's compiled engine**, not by anything in this repo, and they are what holds up the
claim that Alpine's verifier is the exact inverse of the only production signer that exists.

Alpine has no issuer. `crypto::device_cert` verifies and does not sign, deliberately - the contract
work item that wires certificate issuance on this client (§2a of `mls-remaining-work.md`) has not
landed, and `crypto::mls`'s module header states the rule this follows: an unreachable signing
surface is worse than an absent one. So the signer these vectors have to agree with is mobile's, and
a fixture Alpine generated for itself would prove only that Alpine agrees with Alpine.

## What is in it

Every certificate is over the same account, device id and 32-byte device key unless the field name
says otherwise. `issuedAt`/`expiresAt` are epoch seconds, fixed rather than relative to the run, so
the vector does not rot and so a test can pin "now" wherever it needs it.

| Field                                        | What it is                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountIdentityPublicKeyB64`                | The Ed25519 account identity key that issued the certificates below                                                                                             |
| `impostorIdentityPublicKeyB64`               | An unrelated account identity key - what a server that holds no private half can sign with                                                                      |
| `deviceSignatureKeyB64`                      | The device public key the good certificate covers                                                                                                               |
| `otherDeviceSignatureKeyB64`                 | A different device key, for the substitution case                                                                                                               |
| `certificateB64`                             | Valid: right key, right account, window open at `issuedAt + 60`                                                                                                 |
| `certificateOverOtherKeyB64`                 | Genuinely signed, same account, same device id, **over `otherDeviceSignatureKeyB64`**. Presented beside `deviceSignatureKeyB64` this is the substitution attack |
| `certificateExpiredB64` + `expired*`         | Genuinely signed, window entirely in the past                                                                                                                   |
| `certificateNotYetValidB64` + `future*`      | Genuinely signed, issued far beyond any clock drift                                                                                                             |
| `certificateInvertedWindowB64` + `inverted*` | Genuinely signed with `expiresAt` before `issuedAt`                                                                                                             |
| `certificateWrongIssuerB64`                  | Signed by `impostorIdentityPublicKeyB64` over otherwise correct fields                                                                                          |

## Consuming it

`src-tauri/src/crypto/device_cert.rs`, the four tests named `*venta_mobile*`. If Alpine's payload
construction drifts from mobile's by one byte - a field reordered, a length prefix dropped, the
device key signed as its base64 string again rather than as raw bytes - `certificateB64` stops
verifying and those tests fail. Two engines that could not verify each other's certificates would
each keep passing their own unit tests, which is the failure this directory exists to catch.

## Regenerating

Only when the format changes, and then it must be regenerated **from venta-mobile**, never from
Alpine. The value is entirely in the bytes coming from the other engine.

The vectors were produced by calling the C ABI of mobile's already-built engine, so no edit to
venta-mobile is needed:

1. Build `venta_mobile/packages/venta_mls/rust` (`cargo build`), which produces `venta_mls.dll`.
2. Call `venta_mls_call("generateAccountIdentity", "{}")` for the two identity keys, then
   `venta_mls_call("issueDeviceCertificate", …)` once per row above, with `userId`, `deviceId`,
   `deviceSignatureKeyB64`, `issuedAt` and `expiresAt` as documented in that crate's `dispatch`.
3. Write the JSON here **without a byte-order mark** - `serde_json` rejects one.

If the payload construction itself changes, this becomes `v2` beside `v1` rather than replacing it:
certificates signed under the old construction are still in the field for up to 180 days.
