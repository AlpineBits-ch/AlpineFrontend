# Venta

A desktop chat and household client. Angular 21 in a Tauri 2 shell, with audio capture, WebRTC and
the MLS crypto living in Rust under `src-tauri/`.

If you have used Discord the shape is familiar: servers, channels, voice, DMs. The part that is not
familiar is that a server can also run household modules, so a channel might be a chore rota, a
shared ledger or a pantry rather than a message list.

## Run it

```bash
bun install
bun run tauri dev
```

That wants Rust, MSVC, meson and a few other things first. The full list, and the four ways this
build goes wrong, are in [docs/building.md](docs/building.md). Read it before you file a bug about
audio or about a release build behaving differently from `dev`, because both have a known cause.

```bash
bun run test                                  # Angular tests
bun run ng test --watch=false --include="**/one-file.spec.ts"
bun run lint
bun run ng build --configuration development
```

Always go through the Angular CLI via bun. Bare `vitest` and `npx ng` both fail here in ways that
look like your code is broken when it is not.

## How the app fits together

Four ideas carry most of it. If you understand these you can find your way around the rest.

### 1. One socket, and one place events arrive

There is a single SignalR connection to `/api/v1/ws/hub`, owned by `RealtimeConnectionService`. Every
domain shares it, which is why event names are prefixed: `guild.*`, `conversation.*`, `call.*`,
`presence.*`.

`services/realtime-events.ts` maps every event name to its payload type. You subscribe by name and
get the right type back:

```ts
private realtime = inject(RealtimeConnectionService);

this.realtime.stream('guild.ChoreCreated').subscribe(d => this.upsert(d.channelId, d.chore));
```

Whatever listens has to be on the `LISTENERS` array in `services/realtime-listeners.ts`. That array
is resolved once when the app starts. This matters more than it looks: an Angular service is not
constructed until something injects it, so a listener that is not on the list does not start
listening until a user happens to open the view that uses it, and every event before that is lost.

Components should not subscribe to events at all. State reacts to events, components read state. A
handful of older components still break this rule and are being cleaned up.

### 2. State goes in one of three places

Server state goes in a store. Device state goes in a service. View state stays in the component.
The full rule, including the case where the tests collide, is under "Where state goes" in
`CLAUDE.md`. It is short and it is worth reading before you add a signal anywhere.

The rough version: if another user's action can change it, it belongs in a store.

### 3. A store is assembled, not hand written

Stores live in `src/app/stores/` and are built from `@ngrx/signals` plus two local features in
`src/app/stores/foundation/`:

- `withKeyedIndex` gives you one entity map partitioned by a key such as a channel id, with loading
  state, error state, staleness and in flight coalescing per key.
- `withOptimisticEntities` gives you a write that applies immediately and returns both its undo and
  its settle.

Between them you get almost everything a server backed module needs without writing it. `pantry.store.ts`
and `list.store.ts` are the two worked examples. Read those before writing a third.

HTTP stays out of the store. Each module has a `*-api.service.ts` that does nothing but build
requests, and the store calls it.

A few older services still hold their own `signal<Record<string, T>>` state instead. They are being
moved. If you land in one, move it rather than adding to it.

### 4. Channel types are a table, not a switch

Adding a channel type means adding a row to `CHANNEL_META` in `features/guild/channel-types.ts` and
an entry in `features/guild/channel-views.ts`. The compiler makes you do the second once you have
done the first. No template edits, and nothing in `main-page.component.ts`.

`channelViewFor()` is an allowlist on purpose. A type with no row renders as unsupported rather than
falling through to a message view with a composer.

## Adding the usual things

**A realtime event.** Add the name and payload to `realtime-events.ts`. Handle it in the store that
owns that state. Make sure that store is on `LISTENERS`.

**A server backed module.** A `*-api.service.ts` for the HTTP, a store built on the two features, and
one line in `LISTENERS`. Copy the shape from Pantry or Lists.

**A channel type.** One row in `CHANNEL_META`, one entry in `CHANNEL_VIEW_COMPONENTS`, one component.

**A string.** `src/assets/i18n/locales`, flat dot separated keys. Prefer an existing key.

## Where things live

```
src/app/
  stores/        server state. foundation/ holds the two store features
  services/      device and session state, HTTP clients, the realtime connection
  features/      screens, grouped by area (guild, messaging, settings, login, call)
  dtos/          wire types, request/ and response/
  core/          small pure modules with tests. money, entitlements, error copy
  helpers/       small pure functions
  platform/      the desktop and web splits behind one interface
  theme/         the PrimeNG preset and Tailwind tokens
src-tauri/       the Rust shell. audio capture, screen capture, WebRTC publish, presence
crates/          venta-crypto, the MLS and device certificate code, shared with the web build
```

## Things that will catch you

Money is stored and passed as whole minor units and formatted only at display. See
`helpers/money.helper.ts`.

`bun run format` runs prettier over the entire repository, so it will rewrite files you never
touched. Format your own files instead: `bunx prettier --write path/to/file.ts`.

Adding a spec file changes how Vitest batches files across workers, which can make a test fail in a
file you did not touch. That is usually a known pre existing bug, not your change. `CLAUDE.md`
explains it under "Tests".

`bun run lint` currently exits non zero on a backlog of pre existing findings. Compare against the
baseline rather than expecting green.

## Further reading

`CLAUDE.md` holds the working rules: how to write, how to commit, the state rule, the testing traps.
It is the first thing to read after this file.

Server contracts, written from the client's side:

- [docs/api/household-modules-frontend-guide.md](docs/api/household-modules-frontend-guide.md), the
  chores, ledger, pantry, meals, maintenance and decisions endpoints
- [docs/api/inbox-frontend-guide.md](docs/api/inbox-frontend-guide.md)
- [docs/contracts/entitlements-client-requirements.md](docs/contracts/entitlements-client-requirements.md),
  what the client must enforce about plans and limits
- [docs/contracts/voice-client-notes.md](docs/contracts/voice-client-notes.md)
- [docs/contracts/web-push-frontend-guide.md](docs/contracts/web-push-frontend-guide.md)
- [docs/specs/channel-permissions-ux.md](docs/specs/channel-permissions-ux.md)

`docs/superpowers/` holds design notes and implementation plans for features that have already
shipped. They are kept for the reasoning, not as documentation, and some of them describe code that
has since changed. Treat the source as the truth and those as history.
