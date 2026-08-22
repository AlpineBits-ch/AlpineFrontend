# First-run flow

A brand-new account that picks Venta Chat walks ten screens across three unrelated modal containers
before it sees the app. Nothing carries between them: no shared frame, no progress, no way to tell
how much is left. Almost none of it needs a human. This collapses it to two screens, and to one
screen for an Isle-only account.

## The shape today

`resolveAccountGates()` hands the screen to the picker, `pickerCompleted` restarts the launch
sequence, and `runDeviceLaunch()` then fires two more dialogs in turn.

| #   | Container                    | Step             | Needs a human?               |
| --- | ---------------------------- | ---------------- | ---------------------------- |
| 1   | `account-onboarding`         | `pick`           | yes                          |
| 2   | `account-onboarding`         | `done`           | no, says nothing             |
| 3   | `device-registration-modal`  | `input`          | no, derivable                |
| 4   | `device-registration-modal`  | `processing`     | no                           |
| 5   | `device-registration-modal`  | `done`           | no, 1.6s forced dwell        |
| 6   | `key-setup-dialog`           | `password`       | no, held from the sign-up    |
| 7   | `entropy-modal`              | mouse collection | no, decorative               |
| 8   | `key-setup-dialog`           | `recovery-code`  | yes                          |
| 9   | `key-setup-dialog`           | `confirm-code`   | yes, but retyping six words  |
| 10  | `key-setup-dialog`           | `processing`/`done` | no, 1.6s forced dwell     |

Two steps survive. The picker, because only the user knows the answer, and the recovery code,
because it is shown once, is never retrievable, and an account that skipped it loses everything a
password reset touches.

### Why the entropy step can go

`setup_master_key_dual` mints the key with `getrandom::getrandom`, the OS CSPRNG, then XORs the
collected bytes on top. `mix_user_entropy` in `crates/venta-crypto/src/crypto.rs:365` says it
plainly: "the OS bytes stand on their own if the entropy is empty or predictable." `user_entropy`
is already `Option<Vec<u8>>` and already defaulted to `[]` by the TypeScript signature. Passing
nothing changes no security property.

## Decisions

| Question                          | Answer                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| Recovery-code confirmation        | Retype one named word, not all six                                  |
| How far the held password reaches | Registration only; every other entry gets a `password` step         |
| Where the password lives          | A service field, cleared on completion and on route to `/authentication` |
| Structure                         | One component owning first-run, not three patched in place          |
| Device name                       | `hostname()` when the shell has one, else the existing UA-derived label |
| Rename                            | In scope, client-only, via the existing `POST /api/v1/devices`      |
| Backend work                      | None                                                                |

## Architecture

### One takeover, steps computed from what is owed

`FirstRunComponent` replaces all four surfaces. It keeps `account-onboarding`'s shell verbatim:
`fixed inset-0 z-[1200] bg-app-bg`, a `shrink-0 h-titlebar` strip carrying `data-tauri-drag-region`
so the window stays movable under an opaque overlay, and safe-area padding.

Steps are a computed list, not a fixed sequence:

```
type FirstRunStep = 'pick' | 'password' | 'recovery-code';
```

The progress rail sizes to that list, so "2 of 2" is true on every path rather than describing a
wizard the user is not in.

| Entering via                          | pick | password | recovery-code | Screens |
| ------------------------------------- | ---- | -------- | ------------- | ------- |
| Register, first launch, picks Chat    | yes  | no       | yes           | 2       |
| Register, first launch, picks Isle    | yes  | no       | no            | 1       |
| Second device, QR, MFA                | no   | yes      | yes           | 2       |
| Isle account opens its first DM       | no   | yes      | yes           | 2       |
| Silent setup failed                   | no   | yes      | yes           | 2       |

### Composition

Four components collapse into one flow, which is exactly how a god object gets built. It does not
become one file. The split follows `onboarding-gate`, which is a 172-line shell plus a 140-line
`onboarding-prompt-step` that owns no state of its own.

| File                                | Holds                                              |
| ----------------------------------- | -------------------------------------------------- |
| `first-run.component.ts`            | Shell, drag region, progress rail, which step shows |
| `first-run-pick-step.component.ts`  | The two interest cards                              |
| `first-run-password-step.component.ts` | One password field and its error                 |
| `first-run-code-step.component.ts`  | The code, copy, and the one-word check              |
| `first-run.service.ts`              | What is owed, and the run's lifecycle               |
| `signup-password-holder.ts`         | One field, three clear triggers                     |
| `device-registration.service.ts`    | Register, retry once, name                          |
| `master-key-setup.service.ts`       | Generate, dual-wrap, upload                         |

Two rules make it extendable rather than merely split:

Step components are purely controlled. They take `input()`, emit `output()`, and hold no step
state. Adding a fourth step later is a new component and one entry in the owed list, with nothing
in the shell to rewrite.

No network or crypto call lives in a component. `key-setup-dialog` currently holds
`verifyPassword`, `generateRecoveryCode`, `setupDualWrapped`, `putRecoveryKey` and
`normalizeRecoveryCode` inline across 208 lines. That is what has to move into
`MasterKeySetupService`, or the new shell inherits all of it and is worse than what it replaced.

### `FirstRunService`

Owns `owedSteps()`, derived from three reads that already exist:

- `OnboardingService.needsOnboarding()` decides `pick`
- `SignupPasswordHolder.has()` decides `password`
- `user.encryptedMasterKey` absent, plus `OnboardingService.wantsSocial()`, decides `recovery-code`

`has()` and `take()` are separate for a reason: `owedSteps()` is a computed and must not consume
the password as a side effect of being read. Only the setup call takes it.

It exposes a promise per run, not one for the lifetime of the app: `require()` can reopen it long
after first launch. `main-page` awaits the launch one and continues, which retires
`OnboardingService.pickerCompleted` and the suspend-and-resume dance around it. That Subject exists
only because the launch sequence stops mid-way at the picker with nothing left to restart it; a
single owner that returns control removes the reason for it.

`SocialKeyGateService` keeps `isSatisfied()` and `require()`, which are consumed by `backup.service`,
`logout-dialog` and `master-key-recovery`. Its `dialogVisible` and `dismissible` signals move to
`FirstRunService`, so `require()` opens the same component with `password` and `recovery-code` owed
and `pick` skipped.

### The carried password

`SignupPasswordHolder` holds a plain string field. Not a signal: nothing should reactively read a
password, and a signal invites an effect that does.

It is written in `email-verification-dialog.component.ts:137`, inside `onVerified`, beside the
auto-login that already holds the plaintext to call `authService.login(credentials.loginId,
credentials.password)`. That is the only place in the app where a freshly registered account has
both its password and a route to `/overview`.

Cleared on: successful setup, first-run abandonment, and any navigation to `/authentication`. Never
written to disk, never to a store, never to a slot.

An absent password is not an error state. It is the ordinary condition for QR sign-in, an MFA leg,
a second device, and a silent setup that failed, and it produces one branch: the `password` step is
owed.

### Headless device registration

`DeviceRegistrationService` takes `device-registration-modal`'s logic unchanged, including the
two-attempt retry that calls `deleteDeviceIdentifier()` and registers again on first failure.

`main-page`'s `showDeviceRegistration` signal, its `onDeviceRegistered` handler and the
`outcome.needsRegistration` wiring in `runDeviceLaunch()` collapse into a call on the service.

### Auto-naming, and hostname

`describeCurrentDevice()` in `services/device-description.ts` already produces a label and is
already called by the registration modal at `:55`, which then throws the name away and uses the
typed one. Going headless is mostly deleting that discard.

`OsInfo` gains one method:

```
abstract hostname(): Promise<string | null>;
```

- `TauriOsInfo`: lazy `import('@tauri-apps/plugin-os')`, then `hostname()`. Lazy, matching
  `appName()` and `appVersion()`, so the web bundle pulls no Tauri plugin.
- `WebOsInfo`: returns null. A browser has no hostname to give.
- `FakeOsInfo`: constructor argument, plus a `hostnameError` field matching the existing
  `nameError` and `versionError` pattern, so a rejected IPC round trip is one line in a spec.

Resolution order for the name, in a new async helper beside `describeCurrentDevice`:

1. `os.hostname()`, trimmed, if non-empty
2. `describeCurrentDevice().deviceName`, which is "Venta Desktop on Windows" or "Chrome on macOS"

`describeCurrentDevice()` itself stays synchronous and I/O-free, and stays the only place a
`DeviceType` is decided. That is load-bearing: the backend picks a push transport off `DeviceType`,
and its doc comment records what went wrong the last time a caller computed its own. The new helper
returns a name and nothing else.

A rejected or null `hostname()` is not an error. It falls through to step 2.

#### Tauri capability

`tauri-plugin-os`'s `os:default` set grants `allow-arch`, `allow-exe-extension`, `allow-family`,
`allow-locale`, `allow-os-type`, `allow-platform` and `allow-version`. Its own description says
"All information except the host name are available."

`src-tauri/capabilities/default.json` gains `"os:allow-hostname"`. That capability covers
`["*", "echo"]`, so the main window is enough; `desktop.json` needs no change.

### Overlap and failure

Device registration starts when `pick` renders, not when it is answered. Neither registration nor
key generation depends on the picker's answer, only on finishing before the code screen. Today they
run strictly after it, which is where most of the waiting comes from.

On the `recovery-code` step, `setupDualWrapped` and `putRecoveryKey` run in the background while the
user reads and copies. The one-word confirmation is then a local string compare, and the button out
is instant.

Failure paths, none of which dead-end:

- Registration fails after both attempts: the existing "This device cannot be added to new
  conversations" strip covers it. First-run continues.
- `setupDualWrapped` or `putRecoveryKey` fails: the error surfaces on the `recovery-code` step with
  a retry, reusing `describeSetupFailure` from `key-setup-dialog`, which distinguishes an engine
  fault from a server refusal.
- No password held when `recovery-code` is reached: `password` becomes owed and is shown first.

### Rename

No backend change. `MlsDeviceEndpoint.cs:130` already applies a new name on re-registration, and its
comment states the intent: "The name and type are cheap to keep current; a renamed handset should
not need a second endpoint to say so."

A body carrying only the two fields is a clean rename:

```
POST /api/v1/identity/devices
{ "clientDeviceId": "...", "deviceName": "..." }
```

Why nothing else is disturbed:

- `rotated` requires `incomingKey.Length > 0` (`MlsDeviceEndpoint.cs:79`). An absent
  `identityPublicKey` means no rotation, no key-package purge, and no password challenge.
- `DeviceCertificate.Validate(null, ...)` returns null; `DeviceCertificate.cs:21` reads "absent is
  allowed; invalid is not".
- `ApplyCertificate` returns early on an absent certificate (`:276`), `ApplyCapabilities` on absent
  capabilities (`:287`). Neither is overwritten.
- `CreateMLSDeviceDto` declares no validation attributes, so a partial body binds.
- The existing-device branch never writes `DeviceType`, so its enum default is inert.

Client work is `DeviceService.renameDevice(clientDeviceId, deviceName)` and an inline edit in
Settings, Devices.

## What gets deleted

- `features/onboarding/account-onboarding.component.{ts,html}`
- `features/device-registration/device-registration-modal/` (component, template, css, spec)
- `features/key-setup/key-setup-dialog/` (component, template, css), its crypto and network calls
  moving to `master-key-setup.service.ts` rather than into the new shell
- `features/key-setup/entropy-modal/` (component, template, css)
- `OnboardingService.visible`, `show()`, `pickerCompleted`, and the `pickerAnswered` Subject
- `MainPageComponent.showDeviceRegistration` and `onDeviceRegistered`
- `AccountGateBlock`'s `'onboarding'` member becomes `'first-run'` in `launch-hydration.ts`, along
  with the branch in `revealAfterAccountGateBlock` that keys on the old string

`master-key-recovery-dialog` stays. It answers a different question: an account whose envelope will
not open, which is not a first run.

## i18n

New keys under `FIRST_RUN.*` in `src/assets/i18n/locales`, in the same commit as the code.
`ACCOUNT_ONBOARDING.TITLE`, `SUBTITLE`, `ISLE_*`, `SOCIAL_*` and `CHANGE_LATER` carry over unchanged
and keep their keys. `ACCOUNT_ONBOARDING.DONE_*`, `GET_STARTED` and `SAVING` go with the screen they
belonged to.

`key-setup-dialog`'s copy is currently hardcoded English in the template rather than keyed. Moving
it is the moment to key it.

## Testing

`device-registration-modal` has the only spec among the four components being removed.
`key-setup-dialog`, `entropy-modal` and `account-onboarding` have none.

Per the working rules, characterization tests come first and go green against the current code
before anything moves. The behaviours that must be pinned:

1. The two-attempt registration retry: first failure deletes the device identifier and registers
   again, second failure surfaces an error and does not mint a third keypair.
2. Dual-wrap ordering: `setupDualWrapped` runs before `putRecoveryKey`, and `publicVerifier` is
   carried through by `toWrappingDto`. Echo hard-refuses the write without it.
3. `recoveryCode` and `confirmation` are cleared once setup lands.
4. A failed onboarding submit leaves the picker open and unpatched rather than closing into a state
   the launch sequence cannot read.
5. `needsOnboarding()` reads an absent `onboardedAt` as onboarded. A server predating the field
   otherwise gates every one of its users behind a picker whose route 404s.

New coverage after the move:

- `owedSteps()` for all five rows of the entry table
- `SignupPasswordHolder` clears on each of its three triggers
- Name resolution falls through on a null hostname, on an empty-string hostname, and on a rejected
  `hostname()`
- `renameDevice` sends only the two fields

Note the `vitest-base.config.ts` batching effect: adding spec files can surface an unrelated
failure elsewhere. A new failure in a component this work does not touch is usually that, not this.

## As built

Five things came out different, and the design above is the intent rather than the record.

`FirstRunService.open()` takes `{keyRequired?: boolean}`. Without it the design's own "Isle account
opens its first DM" row produces no steps at all, because `owedSteps` gates the key steps on
`wantsSocial(interests)` and an Isle-only account answers false. `require()` would then wait on a
run that never had anything to do. `open()` with no argument is what the launch sequence calls.

`FirstRunService.complete()` exists so the shell can end the run and resolve the promise.

The steps snapshot is taken with `interests: undefined` while `pick` is owed, so the rail reads
"of 2" and never resizes under the user. A pick that turns out to be Isle alone ends the run after
the submit rather than walking to a step it no longer owes.

The key steps are dropped entirely when `MasterKeyService.isAvailable()` is false, or a browser
build reaching `open()` sits on a ceremony it cannot finish.

Device registration is headless and unattended, so two things the modal used to provide had to be
rebuilt: a `deviceRegistrationFailed` banner with a retry, because nothing else reported the
failure once the modal was gone, and a shared-promise re-entry guard on `registerThisDevice()`,
because `register()` deletes the device identifier before its own retry and `runDeviceLaunch()` is
re-entered by both `relaunchOnSessionTakeover` and `retryUnlock()`. The modal had been an
accidental mutex.

## Known defects this does not fix

Found while extracting, all pre-existing, all now pinned by characterization tests:

The registration retry wraps the whole pipeline rather than `registerDevice` alone. A
`persistSigningKey` failure after the server accepted the registration deletes the identifier and
registers again under a new one, orphaning the accepted row with key packages sealed to a key
nothing holds. Every first failure burns a device identifier, including a plain network fault. A
rejected `deleteDeviceIdentifier()` silently cancels the retry, and only the second error
propagates.

`key-setup-dialog`'s failed write left the user holding a code the retry then replaced. That one is
fixed here by construction: `MasterKeySetupService` keeps the code when the write fails.

## Out of scope

- Changing what the picker asks or what `UserInterests` means
- `master-key-recovery-dialog`
- The email-verification dialog, other than the one write into `SignupPasswordHolder`
- Any backend change
