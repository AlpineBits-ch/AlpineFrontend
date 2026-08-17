# Cross-client MLS golden vectors, v1

Contract §F. `venta_mls/rust/Cargo.toml` pins `openmls 0.8.1` with the comment *"Bump both together
or neither"*. This directory turns that comment into an assertion.

Each client's Rust engine produces one fixture, and **both** are checked into **both** repos byte
for byte. Each repo asserts that its own engine consumes the *other's* output, so a ciphersuite,
protocol version or TLS-codec drift fails a test here instead of surfacing as *"my friend texts me
from desktop and I cannot read it on mobile"*.

| File | Produced by | Consumed by |
|---|---|---|
| `fixture.json` | Alpine (`producedBy: "alpine"`) | venta-mobile — and by Alpine, as a control |
| `fixture-venta-mobile.json` | venta-mobile | Alpine — and by mobile, as a control |

**Both directions must pass.** One direction alone proves only that an engine can read itself; the
control exists so that a failure can be attributed to a stale fixture rather than to the other
engine having drifted.

## Shape

| Field | Meaning |
|---|---|
| `producedBy` | `alpine` or `venta-mobile` - which engine wrote it |
| `ciphersuite`, `openmls` | what it was produced under; a consumer that differs should fail loudly |
| `groupIdB64` | the group the commit and message belong to |
| `bob.keyPackageB64` | a KeyPackage, for the `inspect`/`validate` path |
| `bob.signingPublicKey` / `signingPrivateKey` | Bob's Ed25519 pair, base64 |
| `bob.engine` | Bob's `PersistedMlsState` **before** joining - holds the private half of his key package, without which the Welcome cannot be opened by anyone |
| `welcomeB64` | Welcome addressed to Bob (Alice's add-Bob commit, epoch 1) |
| `commitB64` | Alice's add-Charlie commit, applicable by Bob once he has joined (epoch 2) |
| `applicationMessageB64` | Alice's application message at epoch 2 |
| `applicationPlaintextB64` | what it must decrypt to |

All base64 is **standard with padding**, matching `base64::engine::general_purpose::STANDARD` in
both engines.

## Consuming it

Restore `bob.engine` into a fresh provider store, load `bob`'s signing key, join from
`welcomeB64` (expect 2 members), apply `commitB64` (expect 1 added member), then decrypt
`applicationMessageB64` and compare against `applicationPlaintextB64`.

Alpine's side is `consume_golden_fixture` in `src-tauri/src/crypto/mls.rs`, driven by
`this_engine_consumes_its_own_golden_vectors` and
`this_engine_consumes_venta_mobiles_golden_vectors`.

## Regenerating

Only when the format changes. A fixture regenerated on every run would have each engine consuming
bytes it had just produced, which proves nothing - the value is entirely in the bytes being old and
from somewhere else.

```
cd src-tauri
cargo test --lib -- --ignored generate_golden_fixture
```

Then copy the file into the other repo unchanged and run its consumer test. Regenerating one side
means re-copying it to the other; a fixture that exists in only one repo is not a cross-check.
