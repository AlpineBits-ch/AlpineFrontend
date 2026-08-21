# Venta

A desktop chat client. Angular 21 in a Tauri 2 shell, with audio capture, WebRTC and the MLS crypto
living in Rust under `src-tauri/`.

Servers with text and voice channels, direct messages, video and screen sharing, and a per-server
wiki. Conversations can be end-to-end encrypted with MLS.

## Run it

```bash
bun install
bun run tauri dev
```

You need Rust, MSVC, meson and a few other things first. The full list, and the ways this build goes
wrong, are in [docs/building.md](docs/building.md). Read that before filing a bug about audio or
about a release build behaving differently from `dev`. Both have known causes.

```bash
bun run test                                  # Angular tests
bun run ng test --watch=false --include="**/one-file.spec.ts"
bun run lint
bun run ng build --configuration development
```

Always go through the Angular CLI via bun. Bare `vitest` and `npx ng` both fail here, and they fail
in ways that look like a problem in your code.

## How the app fits together

Four things carry most of the architecture.

### Events arrive in one place

There is a single SignalR connection to `/api/v1/ws/hub`, owned by `RealtimeConnectionService`. Every
domain shares it, so event names are prefixed: `guild.*`, `conversation.*`, `call.*`, `presence.*`.

`services/realtime-events.ts` maps each event name to its payload type. Subscribe by name and the
type comes with it:

```ts
export class ChannelStore {
    private realtime = inject(RealtimeConnectionService);

    constructor() {
        this.realtime.stream('guild.ChannelCreated').subscribe(c => this.upsert(c.guildId, c));
    }
}
```

Anything that listens belongs on the `LISTENERS` array in `services/realtime-listeners.ts`, which is
resolved once at startup. This one matters more than it looks. Angular does not construct a service
until something injects it, so a listener left off that array stays asleep until a user opens the
view that happens to use it, and every event before that moment is gone.

Components read state. Stores react to events. A few older components still subscribe directly and
are being cleaned up.

### Where state lives

Server state goes in a store under `src/app/stores/`. Device and session state goes in a service.
View state stays in the component.

Two questions settle most cases:

- Does it arrive many times a second and stop mattering a moment later, like someone speaking or
  typing? Put it in a plain signal on a service. It never becomes entity state, however server-owned
  the row it decorates.
- Can another user's action change it, and could a second screen want to read it? Store.

Ask per field. One service often holds all three kinds: a voice channel's seats are server state, the
speaking flag hanging off a seat is transient, and which channel this window joined belongs to the
device.

### Stores are assembled from two features

Stores use `@ngrx/signals` plus two local features in `src/app/stores/foundation/`:

- `withKeyedIndex` gives you one entity map partitioned by a key such as a channel id, along with
  loading state, error state, staleness and in-flight coalescing for each key.
- `withOptimisticEntities` gives you a write that applies immediately and hands back both its undo
  and its settle.

Together they cover most of what a server-backed module needs. `pantry.store.ts` and `list.store.ts`
are the two worked examples. Read them before writing a third.

HTTP stays out of the store. Each module has a `*-api.service.ts` that only builds requests, and the
store calls it.

Some older services still keep their own `signal<Record<string, T>>` state. Those are being moved. If
you land in one, move it.

### Channel types live in a table

To add a channel type, add a row to `CHANNEL_META` in `features/guild/channel-types.ts` and an entry
in `features/guild/channel-views.ts`. The compiler makes you do the second once you have done the
first. No template edits, and nothing in `main-page.component.ts`.

`channelViewFor()` is an allowlist. A type with no row renders as unsupported, so a channel from a
newer server can never land in a message view with a composer attached.

## Adding the usual things

**A realtime event.** Add the name and payload to `realtime-events.ts`. Handle it in the store that
owns that state. Put that store on `LISTENERS`.

**A server-backed module.** A `*-api.service.ts` for the HTTP, a store built on the two features, and
one line in `LISTENERS`. Copy the shape from `pantry.store.ts` or `list.store.ts`.

**A channel type.** One row in `CHANNEL_META`, one entry in `CHANNEL_VIEW_COMPONENTS`, one component.

**A string.** `src/assets/i18n/locales`, flat dot-separated keys. Look for an existing key first.

## Where things live

```
src/app/
  stores/        server state. foundation/ holds the two store features
  services/      device and session state, HTTP clients, the realtime connection
  features/      screens, grouped by area: guild, messaging, settings, login, call
  dtos/          wire types, split into request/ and response/
  core/          small pure modules with tests. money, entitlements, error copy
  helpers/       small pure functions
  platform/      the desktop and web splits behind one interface
  theme/         the PrimeNG preset and Tailwind tokens
src-tauri/       the Rust shell. audio capture, screen capture, WebRTC publish, presence
crates/          venta-crypto. MLS and device certificates, shared with the web build
```

## Things that will catch you

Money is stored and passed as whole minor units, and formatted only at display. See
`helpers/money.helper.ts`.

`bun run format` runs prettier over the whole repository and will rewrite files you never touched.
Format your own: `bunx prettier --write path/to/file.ts`.

Adding a spec file changes how Vitest batches files across workers, which can turn a test red in a
file you never opened. Check whether your change actually touches that file before digging.

`bun run lint` exits non-zero on a backlog of existing findings. Compare your count against the
baseline.

Before putting `OnPush` on an older component, look for a plain field written from a `subscribe`,
`then`, `await` or `setTimeout` and read by the template. That is the case `OnPush` breaks, and it
breaks silently. Make the field a signal.
