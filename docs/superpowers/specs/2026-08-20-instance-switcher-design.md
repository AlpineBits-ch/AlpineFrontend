# Login instance switcher

The sign-in field offers "username or email" and accepts neither reliably. Any `@` in it is read as
a server address, so an email address re-points the whole client at a host that was never a Venta
instance. The instance becomes an explicit control, and the identity field becomes an identity
field.

## The defect

`ApiConfigService.applyLoginInput` splits the input on its last `@` and treats the tail as a
hostname. Typing `ada@fastmail.com`:

1. username becomes `ada`, base URL becomes `https://fastmail.com`
2. the URL is written to `server_url`, scoped and unscoped, and pushed into the OAuth issuer
3. the password grant goes to `fastmail.com/connect/token` and fails
4. the wrong host stays persisted for the slot

`ConnectController.cs:318` already resolves an identity as `FindByNameAsync(input) ?? FindByEmailAsync(input)`.
Email sign-in works server-side today. Only the client's parsing breaks it. No backend change.

## Decisions

| Question | Answer |
|---|---|
| Where the control lives | A row above the tab strip, outside the tab body |
| Scope | One `serverDomain` for the whole card: sign-in, register, QR |
| A typed `user@host` | Sent whole as the identity; the host is only ever a post-failure hint |
| Recents | Distinct hosts of the account slots on this machine, home pinned |
| When the choice applies | Immediately on pick, not at submit |
| Word for the host | Instance |
| Which hosts offer it | Desktop only, as a `PlatformCapabilities` flag |
| Controls | `p-select`, `p-button`, `pInputText`, all already in the preset |

## Architecture

### One server, applied eagerly

Today the card holds two independent server states and two config fetches:

```
 sign-in tab            register + QR tab
 loginServerConfig      serverConfig
 debounced off the      fetched off serverDomain,
 username field         applied at submit only
```

Both collapse into `serverDomain` plus one `serverConfig`. `loginEnabled` and `registerEnabled`
read the same response.

`setServer` is called the moment the picker changes, rather than at register submit and on QR mode
entry. That is what removes `openPasswordReset`'s workaround, which currently has to call
`applyLoginInput` itself so the reset request reaches the right host.

`serverDomain` seeds from `ApiConfigService.baseUrl()`, which needs a `urlToDomain` inverse of the
existing `domainToUrl`. During Add Account the slot-scoped key misses and the read falls back to the
unscoped `server_url`, already documented as the login screen's last-server-used.

### New component: `instance-picker`

`features/login/instance-picker/instance-picker.component.ts`. Standalone, OnPush, no HTTP.

```ts
readonly domain = model.required<string>();
readonly recents = input<readonly string[]>([]);
readonly state = input<'idle' | 'loading' | 'error'>('idle');
```

The parent probes `/api/v1/configuration` on every domain change and renders the unreachable
message beneath the picker, exactly as the register tab does now. Keeping the network out of the
picker is what lets its spec run without an HTTP harness.

It is a `p-select`, not a hand-rolled menu. The preset already styles `select` for exactly this
("the closed control matches `inputtext`; the open panel matches `menu`"), and the `#selectedItem`,
`#item` and `#footer` templates carry the icon, the state spinner and the add row. `size="small"`
keeps it lighter than the credential fields below, which it must not compete with. **Add an
instance** sits in the panel footer rather than beside the control, so the resting card is one
control with no label: the value names itself. Taking it swaps the select for a `pInputText` with
confirm and cancel `p-button`s.

`options` always contains the selected domain, even when it is not a recent. A `p-select` whose
value is absent from its options renders blank.

### Desktop only

`PlatformCapabilities.instanceSelection`, read straight by the template the way the other
capabilities are. A web build is served by one instance and talks to that origin; sending
credentials elsewhere is a cross-origin request that instance never allowed. The desktop app has no
origin of its own, so choosing is the only way it learns where to go.

That moves the register-disabled hint out from under the picker into the register tab body, where
it still shows on a host with no picker.

### Recents come from account slots

`AccountSlot` already carries `serverUrl` and `lastUsedAt`, and `Login` already calls
`accounts.list()` for the "Back to" rows. Recents are a computed over that list: distinct hosts,
newest `lastUsedAt` first, capped at three, with the home host pinned first and de-duplicated. No
new storage.

An instance you typed but never signed into is not remembered. That is the intended reading of
"instances you have used".

### The identity passes through whole

`applyLoginInput` is deleted. `AuthService.login` sends its input verbatim as `username`.
`ApiConfigService.serverLabel` goes with it; the account switcher has its own and is untouched.

### The hint is the only guess

In `login()`'s `catchError`, after the MFA, restricted, and 403-unverified branches have returned:
if the input carries a domain and that domain is not the selected instance, probe it once. If it
answers, show an inline row offering the switch. Taking it applies the instance and retries once;
a second failure shows the plain error and no further hint.

This is strictly less traffic than today, which probes an arbitrary typed domain on a 500ms
debounce while the user types.

## Copy

`LOGIN.BRAND.DESCRIPTION` already says "Spin up a server, drop into a channel", where server means a
guild. The host is called an **instance** so one word does not carry both meanings.

New keys under `LOGIN.INSTANCE.*`: `LABEL`, `HOME`, `ADD`, `ADD_PLACEHOLDER`, `UNREACHABLE`,
`SUGGEST`, `SUGGEST_ACTION`. `LOGIN.SERVER.LOGIN_DISABLED` and `REGISTER_DISABLED` stay.

`LOGIN.LOGIN.USERNAME` becomes "Username or email". The identity placeholder is hardcoded in the
template today and becomes `LOGIN.LOGIN.IDENTITY_PLACEHOLDER`.

## Registration stops handing back a handle

`register()` writes `username@domain` into the sign-in field for a self-hosted server, so the bare
username would not reach the wrong one. With an explicit picker that is redundant, and leaving it
in place keeps teaching the syntax being removed. It writes the bare username and leaves
`serverDomain` on the instance just registered against.

## Tests

`applyLoginInput` is deleted rather than moved, so pinning it first would only mean deleting the
pins in the same change. What `api-config.service.spec.ts` pins instead is the behaviour its four
callers actually depended on and that survives: `setServer`, the scoped and unscoped `server_url`
writes, the startup precedence between them, `reset` leaving other slots alone, and the new
`urlToDomain`.

- `instance-picker.component.spec.ts`: home pinned, de-duplicated and capped; the selected domain
  always present; the add flow and `normalizeDomain`.
- `instance-suggestion.spec.ts`: the probe offers only when the domain answers, says nothing about a
  bare username or the already-selected instance, offers once, and applies the instance before
  retrying.
- `auth.service.spec.ts` stubbed `applyLoginInput` and now asserts an email identity reaches the
  grant whole.

Three new spec files reshuffle Vitest's batching, so an unrelated failure afterwards is likely that
rather than this change.
