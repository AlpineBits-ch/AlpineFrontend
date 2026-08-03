# Account onboarding and deferred key setup

Venta is two products in one binary: proximity voice for The Isle, and an encrypted
chat/community client. A new account is currently walked through master-key setup at
first launch regardless of which of the two it came for, which is a recovery-code
ceremony imposed on someone who may only ever want to talk to dinosaurs.

This adds a one-time onboarding step that asks which of the two the account is for, and
defers master-key setup for accounts that only picked Isle until they actually reach for
something social.

## The key insight

The master key is **not a capability gate**. Nothing in messaging, guilds, or calls
consults it. Its only consumers are:

- `backup.service.ts` — writes the encrypted device backup
- `logout-dialog.component.ts` — refuses a clean sign-out without one
- `master-key-recovery-dialog` / `master-key-state.service.ts` — repair after a password reset

MLS signing keys, which *are* what encrypt messages, come from device registration and the
OS keychain and are established independently in `runMlsLaunch`.

So an account with no master key can already send and read messages perfectly well. What
it cannot do is survive a logout or reinstall with its history intact.

Two consequences shape this design:

1. Deferring key setup is safe. Nothing breaks, no feature silently degrades.
2. The deferred prompt is about **durability, not access**. Its copy must say so. A dialog
   claiming "you need this to chat" would be false, and the user would find that out.

## Scope

**In:** the onboarding picker, its persistence, the launch-sequence branch, the deferred
gate and its call sites, a settings re-entry point.

**Out:** any change to how the app looks or what it offers. The guild rail, DM rail, friends
list and every other surface render identically for both picks. Nothing is hidden, greyed,
or overlaid with an upsell. An Isle-only account is a normal account that has not written a
master key yet.

## Backend (`RiderProjects/Echo`, Identity context)

Two columns on `ApplicationUser`:

```csharp
// Identity.Domain/Enums/UserInterests.cs
[Flags]
public enum UserInterests { None = 0, Isle = 1, Social = 2 }

// Identity.Domain/Aggregates/ApplicationUser.cs
public DateTimeOffset? OnboardedAt { get; set; }
public UserInterests Interests { get; set; } = UserInterests.None;
```

On the aggregate rather than `UserPreferences.Data` or `JsonSettings`, because the client
already reads `GET /api/v1/users/self` during its launch sequence and `ApplicationUserDto`
is a Facet over `ApplicationUser`. Both fields ride the existing response with no new round
trip and no DTO plumbing. Parsing a JSON blob to decide whether to show a blocking dialog is
the wrong shape for something on the launch path.

`ApplicationUser.Create` leaves both at their defaults; that is what arms the gate.
`ApplicationUser.CreateBot` stamps `OnboardedAt` so bot accounts never trip it.

### `PUT /api/v1/users/self/onboarding`

```json
{ "interests": ["isle", "social"] }
```

- 400 on an empty set. Picking nothing is not a state the client can render.
- Sets `Interests` on every call.
- Sets `OnboardedAt` only when it is null, so re-running the picker from settings updates the
  choice without falsifying when the account was first onboarded.
- Returns `{ onboardedAt, interests }`.

Deliberately a PUT and deliberately re-runnable: an Isle-only account that later completes
key setup PUTs `interests + ['social']` so its stated intent and its actual state stop
disagreeing. The client drives that, not the server. Coupling it into `UploadMasterKey` and
`PUT backup/recovery-key` would mean two write paths quietly editing a third field, and those
routes have enough invariants already.

### Migration `AddUserOnboarding`

**Must backfill.** Every existing row gets `OnboardedAt = CreatedAt` and
`Interests = Isle | Social`.

This is the one step in the plan that cannot be recovered from in production: ship it without
the backfill and every current user is met with a full-screen onboarding wall on next launch.
It gets a dedicated test.

### Tests (`Identity.Tests/Controllers/UserControllerTests.cs`)

- Empty interest set is rejected with 400
- First PUT stamps `Interests` and `OnboardedAt`
- Second PUT changes `Interests` and preserves the original `OnboardedAt`
- `GET self` exposes both fields
- A row created before the migration reads back non-null `OnboardedAt`

## Frontend (`WebstormProjects/Alpine`)

### DTO

```ts
export enum UserInterest { Isle = 'isle', Social = 'social' }

// UserDto
onboardedAt?: string | null;
interests?: UserInterest[];
```

Both optional: a self-hosted server on a build predating this feature sends neither, and the
client must read that as "already onboarded" rather than gating every user of an older server
behind a picker whose submit endpoint 404s.

### `OnboardingService`

Owns the picker's visibility and the PUT. `submit(interests)` writes, then patches
`userService.self` so the launch sequence and the gate agree without a refetch.

### `SocialKeyGateService`

```ts
/** Sync, no I/O. True when the caller may proceed. */
isSatisfied(): boolean
/** Opens key setup if needed. Resolves true if the caller may proceed. */
require(): Promise<boolean>
```

`isSatisfied()` reads `userService.self()?.encryptedMasterKey != null`, and **fails open when
`self()` is null**. Self is loaded during launch before any of this UI is reachable, and
blocking a send on an unloaded signal is a worse failure than a missed prompt.

The service owns the single `KeySetupDialogComponent` instance's visibility, so the launch-time
path and the deferred path drive one dialog rather than two competing ones. On success it PUTs
`interests + ['social']`.

Cancelling is a clean no-op: nothing is sent, nothing is created, nothing is half-done.

### Launch sequence (`main-page.component.ts::checkMasterKey`)

One branch inserted, one made conditional:

```ts
if (!user.emailVerifiedAt)  → emailVerification.show()        // unchanged
if (!user.onboardedAt)      → onboarding.show()               // new
if (!user.encryptedMasterKey) {
    if (wantsSocial) socialGate.promptNow()                   // as today
    else return                                                // new: defer
}
void this.checkMasterKeyHealth()                              // unchanged
```

Ordering is load-bearing: onboarding sits after email verification (an unverified account
should not be asked what it wants before it exists) and before key setup (the answer decides
whether key setup happens at all).

An account that picks Chat gets exactly today's behaviour, dialog and all. That path does not
change.

### Gate call sites

Gate on the **action**, not the surface. Browsing the DM panel, opening a guild, reading a
channel list and viewing profiles all stay free.

| Action | Where |
|---|---|
| Send a message (DM, channel, forum) | `composer.component.ts::send()` |
| Create a guild | `create-guild-modal.component.ts::submit()` |
| Join a guild via invite | `invite-dialog.component.ts::join()` |
| Send a friend request | `friendship-modal.component.ts::sendRequest()` |
| Accept a friend request | `friendship-modal.component.ts::accept()` |

**Voice calls are deliberately absent.** `call-session.service.ts` and
`call-webrtc.service.ts` contain no reference to MLS or the master key, so 1:1 and guild voice
work without one. Gating them would be a restriction invented by this feature rather than one
the system has.

The composer gates at the top of `send()`, before the editor is cleared, so a cancelled prompt
leaves the typed message in place. On success it re-enters `send()` and the message goes. The
sync `isSatisfied()` fast path means the overwhelmingly common case adds one boolean read and
no promise.

### Key setup dialog

Gains `dismissible` and a `dismissed` output. The "Not now" affordance renders only on the
`password` step: once a recovery code has been generated and shown, backing out leaves the
account in a state where the user believes they have a code that was never stored.

### Settings re-entry

A row showing the current pick, editable. Ticking Venta Chat there runs key setup immediately.

## Copy

The social card tagline is "Servers, DMs and voice, end to end encrypted." One i18n key,
`ACCOUNT_ONBOARDING.SOCIAL_TAGLINE`, trivially swapped.

The deferred prompt leads with the actual stake, not a false capability claim:

> Set up encryption to keep your messages. Without it, signing out or reinstalling loses your
> message history for good.

Strings live in the locales git submodule and land in their own commit ahead of the code.

## Testing

- `onboarding.service.spec.ts` — PUT shape, self patched on success, error leaves state untouched
- `social-key-gate.service.spec.ts` — satisfied when a key exists; fails open on null self;
  `require()` resolves false on dismiss and true on completion; interests PUT on completion
- `composer.component.spec.ts` — a blocked send preserves the editor content and emits nothing;
  an allowed send behaves exactly as before
- `main-page` launch branch — onboarding shown when `onboardedAt` is null; key setup skipped for
  an Isle-only account with no key; key setup shown for a social account with no key
