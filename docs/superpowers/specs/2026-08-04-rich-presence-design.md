# Rich Presence (Discord-parity game activity) — Design

**Date:** 2026-08-04
**Status:** Proposed
**Repos:** `Alpine` (Tauri/Angular client), `Echo` (backend)

## Problem

We detect games and then throw the answer away.

`src-tauri/src/rich_presence.rs` exposes one command, `scan_game_process`, which reads a
67-line `resources/game_map.csv`, walks `sysinfo` processes, and returns the first matching
title. `rich-presence.service.ts` polls it every 15 s into a signal. The only consumer is
`main-page.component.ts:235` — a `console.log`. Nothing reaches the backend, nothing reaches
another user, and there is no notion of *when* the game started, so "in game since 23 minutes"
is not expressible at all.

The backend is further along than the client. `MemberPresenceState`
(`Guild.Application/Services/GuildHydrateService.cs:8`) already carries a nullable
`Activity` field, and `GuildLifecycleHandler` faithfully preserves it across heartbeats and
status changes (`:72`, `:153`) — but no code path ever *writes* it, no DTO ever emits it, and
no client ever reads it. `UserPrivacySettings.ShareActivity` (`Identity.Domain/Entities/UserPrivacySettings.cs`)
exists, defaults `true`, and is documented as gating "the activity half of presence
projections" — a half that does not exist yet.

So this is less a greenfield feature than a wiring job with one genuinely new piece: where the
rich (details/state/artwork/party) half of the data comes from.

## Where the data can come from

Three independent sources, in descending order of richness. They are not alternatives; the
final design merges all three behind one arbiter.

### A. Process detection — what we have, done properly

The mechanism is right, the inputs are wrong. Discord publishes its entire detectable-games
database at `GET https://discord.com/api/v9/applications/detectable`, unauthenticated. Verified
2026-08-04:

| | |
|---|---|
| HTTP | `200`, `application/json`, no auth |
| Size | 12.3 MB |
| Applications | 23,858 |
| Applications with executables | **10,445** (the rest are registered apps with no detection rule) |
| Executable entries | 11,218 — **11,144 `win32`**, 67 `darwin`, 7 `linux` |
| With `icon_hash` | 19,707 |

**Note on shape.** What follows is the *source* data as the bootstrap extraction saw it. Clients
never see this: `GET /api/v1/social/games/catalog` serves the parsed form — `rules[]` with
`isLauncher`/`isNegated` booleans, the `>` marker already stripped into a flag by the seeder. Do
not implement `>` parsing on the client; it is already done.

Entry shape:

```json
{
  "id": "356875221078245376",
  "name": "Overwatch",
  "aliases": [],
  "icon_hash": "d20f9f39f2eec584dcdbc7b206786124",
  "cover_image_hash": "843a3b07639f068fdacf40b9c3808c46",
  "executables": [{"name": "overwatch.exe", "os": "win32", "is_launcher": false}],
  "hook": true, "themes": ["Action", "Science fiction"],
  "third_party_skus": [{"distributor": "steam", "id": "2357570"}]
}
```

That is 10,445 games against our 67, for free. But the matching rules are where the current
implementation is not merely incomplete — it is wrong in a way that would report the wrong game.
Measured over the real dataset:

| Property | Count |
|---|---|
| Executable entries | 11,218 |
| **Path-qualified** (contain a directory component) | **9,297 — 83%** |
| Distinct basenames | 10,214 |
| **Basenames claimed by more than one game** | **412** |
| Negation entries (`>name`) | 9 |

Three rules follow, and none of them are optional:

- **Path-qualification is the norm, not an edge case.** `_retail_/wow.exe`,
  `win64/gmod.exe`, `tom clancy's rainbow six siege/rainbowsix.exe`,
  `dead by daylight/deadbydaylight.exe`. Matching `process.name()` alone
  (`rich_presence.rs:38`) cannot match 83% of the database. Matching must be a normalized
  full-path **suffix at a path-component boundary** — a plain string suffix would let
  `mygame.exe` match a rule for `game.exe`.
- **Basename-only matching actively reports the wrong game.** `game.exe` is registered by
  **192 different games**; `hl2.exe` by 34; `dosbox.exe` by 22. This is the difference between
  "we miss some games" and "we tell your friends you are playing something you have never
  installed."
- **An ambiguous basename must resolve to nothing, not to a guess.** This is the rule that
  actually protects against the 192-way `game.exe`: when more than one distinct game ties for the
  best-ranked match, the answer is `None`. Silence is correct; a coin-flip is not.
- **Negations narrow candidacy; they do not by themselves resolve a collision.** Garry's Mod,
  Team Fortress 2, Half-Life 2 and Left 4 Dead 2 all register `>hl2.exe`, and Minecraft registers
  `>java`/`>javaw.exe` so a running JVM does not announce Minecraft. An earlier draft of this
  section claimed the `>hl2.exe` rules were "precisely how the 34-way collision is resolved" —
  they are not. They remove four Source games from candidacy; the remaining ~30 still tie, and it
  is the ambiguity rule above that yields `None`. The outcome the spec wants holds, by a different
  mechanism than the one stated. Test the outcome, not the mechanism.
- **`is_launcher`.** Dead by Daylight registers `deadbydaylight.exe` as a launcher and
  `deadbydaylight-win64-shipping.exe` as the game. Reporting the launcher means the presence
  says "playing" while the user sits in a store front-end. Non-launcher matches win, and on an
  otherwise-equal tie the more path-specific rule wins.

The `darwin`/`linux` numbers are the honest ceiling here: this database is a Windows artifact.
Auto-detection on macOS and Linux will find almost nothing from it (see *What we cannot do*).

### B. The Discord RPC pipe — "hijacking the SDK"

This is the interesting one, and yes, it works. Every Discord game integration —
`discord-rpc`, the Discord Game SDK, `discord-rich-presence` (Rust), `pypresence` — talks to
the local Discord client over a **local IPC socket with a trivial framing protocol**. There is
no authentication, no signature, no attestation. Whoever owns the socket receives the presence.

Confirmed against the OpenAsar `arrpc` implementation (`src/transports/ipc.js`), which is a
production reimplementation of exactly this:

- **Transport:** Windows named pipe `\\?\pipe\discord-ipc-{0..9}`; Unix domain socket at
  `$XDG_RUNTIME_DIR/discord-ipc-{0..9}` falling back to `$TMPDIR`, `/tmp`.
- **Framing:** `u32 LE opcode` ‖ `u32 LE payload_length` ‖ UTF-8 JSON.
- **Opcodes:** `0 HANDSHAKE`, `1 FRAME`, `2 CLOSE`, `3 PING`, `4 PONG`.
- **Handshake:** client sends `{"v": 1, "client_id": "<application id>"}`. Server validates
  `v == 1` and a non-empty `client_id`, else closes with `INVALID_VERSION` / `INVALID_CLIENTID`.
- **A `READY` dispatch must follow a successful handshake.** Missing from the first draft of this
  section and found during implementation: `discord-rpc` sends *nothing at all* — no
  `SET_ACTIVITY`, not even a ping — until it has seen a `DISPATCH`/`READY`. Without it the server
  accepts the handshake and both sides then sit silent forever, which is indistinguishable from a
  working server that no game happens to be using. `arrpc` sends it too.
- **Payload:** the game then sends `FRAME`s, the relevant one being
  `{"cmd":"SET_ACTIVITY","nonce":"…","args":{"pid":1234,"activity":{…}}}` where `activity`
  carries `details`, `state`, `timestamps{start,end}`, `assets{large_image,large_text,small_image,small_text}`,
  `party{id,size:[cur,max]}`, `buttons`, `instance`.
- The server **must reply** with a `FRAME` `{"cmd":"SET_ACTIVITY","data":{…},"evt":null,"nonce":"<same>"}`.
  The C++ `discord-rpc` library and several others treat a missing response as a dead
  connection and enter a reconnect loop.

If Venta binds `discord-ipc-0` before Discord does, every RPC-integrating game on the machine
reports its full rich presence to us instead. No cooperation from game developers, no
per-game work.

**The unavoidable catch: exactly one process owns pipe 0.** Client libraries scan `0..9` and
stop at the *first* socket that accepts a handshake. So binding pipe 3 while Discord holds 0
gains us nothing — the game never gets that far. Two operating modes fall out:

- **Exclusive.** Bind 0 at Venta startup. Works when Discord is not running or starts after us;
  when it does start it takes pipe 1 and *its* rich presence silently stops working. Hostile to
  users who run both.
- **Proxy (recommended).** Bind 0. For each inbound game connection, open our own client
  connection to the real Discord on the next available pipe and relay frames verbatim in both
  directions while snooping `SET_ACTIVITY`. Both Discord and Venta show the presence and the
  user notices nothing. Costs a reconnect/teardown state machine and a fallback to exclusive
  mode when no downstream Discord is found.

Discord also exposes an HTTP/WebSocket RPC transport on ports **6463–6472**
(`ws://127.0.0.1:646x/?v=1&client_id=…`, `Origin`-checked) used by browser-hosted games and a
few launchers. Same protocol at the JSON layer, no pipe contention. Lower value, cheap to add
after the pipe server exists.

**Artwork.** RPC activities reference art by *asset key*, resolved against the game's own
Discord application. All three endpoints are public and unauthenticated (verified 2026-08-04
against Overwatch, `356875221078245376`):

| Endpoint | Result |
|---|---|
| `GET /api/v9/applications/{id}/rpc` | `200`, 3.7 KB — `name`, `icon`, `description`, `cover_image` |
| `GET /api/v9/oauth2/applications/{id}/assets` | `200`, JSON array of `{id, type, name}` (`[]` for Overwatch — it registers none) |
| `cdn.discordapp.com/app-icons/{id}/{hash}.png` | `200`, `image/png`, 10 KB |

Asset images then live at `cdn.discordapp.com/app-assets/{app_id}/{asset_id}.png`. Activities
may also carry `mp:external/…` keys, which are arbitrary proxied URLs.

### C. OS media session — music, done better than Discord

Discord's Spotify presence is a *server-side* account link; it is not reproducible by reading
anything on the machine. But the OS already exposes what is playing:

- **Windows:** `GlobalSystemMediaTransportControlsSessionManager` (WinRT) — title, artist,
  album, position, thumbnail, for any app that registers SMTC (Spotify, browsers, foobar).
- **Linux:** MPRIS over D-Bus — same data, better specified.
- **macOS:** `MediaRemote` is a private framework; Apple hardened it in recent releases. Treat
  as not available.

This is strictly better than Discord's approach on Windows/Linux (it covers *any* player, not
just linked Spotify accounts) and needs no OAuth. It also raises the privacy stakes — see
*Privacy*.

---

## Data model

One shape, shared across bus, Redis, REST and SignalR. Deliberately Discord-compatible so the
Discord-compat bot gateway (`Bots.Application/Gateway`) can project it later without a second
model.

```csharp
// Social.Contracts/Dtos/ActivityDto.cs
public sealed record ActivityDto
{
    public required string Type { get; init; }   // Playing|Streaming|Listening|Watching|Competing|Custom
    public required string Name { get; init; }   // "Counter-Strike 2"
    public string? Details { get; init; }        // "Competitive — Mirage"
    public string? State { get; init; }          // "In Queue (4 of 5)"
    public string? ApplicationId { get; init; }  // Discord snowflake, when known
    public long? StartedAt { get; init; }        // unix ms, UTC, server-authoritative
    public long? EndsAt { get; init; }
    public ActivityAssetsDto? Assets { get; init; } // resolved URLs, not raw keys
    public ActivityPartyDto? Party { get; init; }   // Id, Size, Max
    public required string Source { get; init; }    // ProcessScan|Rpc|Media|Manual|Native
}
```

`MemberPresenceState` gains `IReadOnlyList<ActivityDto>? Activities` **alongside** the existing
`string? Activity`, which stays untouched. The presence hash has a 300 s TTL
(`GuildHydrateService.cs:32`), so a rolling deploy where old and new pods disagree about the
shape self-heals in five minutes; changing `Activity`'s type in place would instead throw on
deserialize for every entry written by the other version.

Cap the list at 3 activities, mirroring Discord.

### The one thing that is easy to get wrong

**`StartedAt` must be sticky, and the server owns it.**

`GuildLifecycleHandler.RefreshPresenceAsync` runs on every heartbeat and rewrites the whole
presence record. If the client re-sends `startedAt` each tick, or the server stamps
`UtcNow` on write, the elapsed timer resets every ~30 s and permanently reads "for a few
seconds". The rule:

1. On write, compare the incoming activity's identity key `(Type, Name, ApplicationId)` against
   what is already stored.
2. **Same key → keep the stored `StartedAt` verbatim.** Ignore whatever the client sent.
3. **Different key or nothing stored →** take the client's `StartedAt` if it is present, not in
   the future, and not more than 24 h in the past; otherwise stamp server `UtcNow`.

Clients get an absolute epoch-ms UTC value and compute elapsed themselves. Never send a
duration — it is stale the moment it is serialized, and it makes reconnect-resume impossible.

---

## Backend spec (Echo)

> **Status: §1–§6 built 2026-08-04.** Social suite 373/373 green, Guild presence tests 44/44 green
> (Guild's 50 Testcontainers failures are a Docker-not-running environment issue and are identical
> on a clean tree). **The `AddGameCatalog` migration is generated but not applied.**
>
> Three things landed differently from what is written below, all tightenings:
>
> - **The write path is stricter than "rename known applications."** The final rule is that a
>   displayed name is either *vouched for* or *user-authored*: an application id that does not
>   resolve drops the activity outright, and a missing application id is only accepted from
>   `Manual` and `Media`. Renaming alone would have left "no id at all, arbitrary name" wide open,
>   which is the same hole by a different route.
> - **`Assets` is stripped unconditionally** rather than passed through. Until artwork has a
>   source, an asset URL is an attacker-chosen URL that every viewer's client would fetch.
> - **Clearing activity is never throttled.** Someone who quits a game a second after launching it
>   must not stay visible as playing until the window expires.
>
> **The per-application opt-out is now built too** (Identity `UserHiddenActivity` +
> `PUT /api/v1/identity/privacy-settings/hidden-activities`), so per-game toggles have a real
> backend. It keys on an application id *or* a name — the name fallback exists because the media
> session, manual statuses and pre-catalog process detection produce no application id, and
> suppressing only what has one would leave the entries a user most wants hidden unsuppressable.
> It rides inside `UserPrivacySettingsSummary`, so every service gets it through the privacy cache
> it already reads, and a change bumps `Version` and fires `UserPrivacySettingsChangedEvent` to
> evict those caches.
>
> **Three defects found and fixed in a second review pass**, all in code written earlier the same
> day:
>
> - **Activity could fabricate presence.** `Handle(UserActivityChanged)` defaulted an absent
>   presence entry to `Online`, so an activity write from a user who was not connected invented
>   presence for them — and, worse, resurrected someone who had chosen `Hidden` as `Online` the
>   moment their entry aged out of the 300 s TTL. Members with no live presence are now skipped.
> - **The start-time merge aliased the bus message.** Merging inside the per-guild loop mutated the
>   very objects the next guild's merge then read, so the result depended on guild ordering. The
>   merge now happens once and returns copies.
> - **Clears were completely unthrottled.** Exempting them from the 15 s window was right;
>   exempting them from *any* limit made an unbounded fan-out amplifier. They now have their own
>   2-second floor.
>
> A fourth, in the test harness rather than the product: `RedisTestFactory` never stubbed
> `HashGetAsync`, so `GetPresenceStateForMemberAsync` returned null in **every** Guild test and no
> presence-preservation branch had ever actually been exercised.

### 1. Contract — `Social.Contracts`

- `ActivityDto`, `ActivityAssetsDto`, `ActivityPartyDto` (above).
- `UserActivityChanged : { string UserId, IReadOnlyList<ActivityDto> Activities }` — bus event,
  sibling of the existing `UserStatusChanged`.

### 2. Write path — `Social.Application/Controllers/ProfileController.cs`

New endpoint next to the existing `PATCH me/status` (`:36`):

```
PUT /social/profiles/me/activity     body: { activities: ActivityDto[] }   → 204
```

- Auth required; `userId` from `ClaimTypes.NameIdentifier`, as the neighbours do.
- **Validate hard.** This payload originates from a local IPC socket any process on the user's
  machine can write to (§B). Reject/clamp: `Name` ≤ 128 chars, `Details`/`State`/asset text
  ≤ 128, at most 3 activities, `Type` must parse to the enum, `ApplicationId` must be a numeric
  snowflake, strip C0/C1 control characters and bidi overrides. Rate-limit to **1 write / 15 s
  per user** (Discord's own RPC limit) via the existing rate-limit infrastructure.
- **Do not trust a client-supplied game name for a known application.** If `ApplicationId` is
  present, resolve `Name` from our mirror of the detectable DB and *overwrite* whatever the
  client sent. Without this, any local process can put arbitrary text — slurs, phishing bait —
  under a user's name in every server they are in. This is the single most important
  server-side check in the feature.
- Publishes `UserActivityChanged`. Do **not** call `SaveChangesAsync` — Wolverine's middleware
  commits (project convention).

Activity is deliberately *not* persisted to Postgres. It is ephemeral, high-churn, and Redis
already owns presence.

### 3. Fan-out — `Guild.Application/Bus/Events/Realtime/GuildLifecycleHandler.cs`

Add `Handle(UserActivityChanged, …)`, modelled directly on the existing
`Handle(UserStatusChanged, …)` (`:133`): load the user's `GuildMember` rows, merge the new
activities into each member's `MemberPresenceState` (preserving `Status`, applying the sticky
`StartedAt` rule), then reuse `BroadcastPresenceChangesAsync`.

`BroadcastPresenceChangesAsync` already does two things we need for free:

- **Blocks.** `BlockCache` filtering (`:103`, `:111`) means no activity flows between a blocked
  pair in either direction, with no new code.
- **Self/other split.** The send is already forked so the subject sees their own truth and
  third parties see the projection — exactly the seam the privacy rule needs.

The `guild.PresenceChanged` payload gains `Activities`. Existing clients ignore an unknown
field, so this is additive.

### 4. Projection — `Guild.Application/Services/PresenceProjection.cs`

Extend the class that already exists for precisely this purpose:

```csharp
public static IReadOnlyList<ActivityDto> ProjectActivitiesFor(
    IReadOnlyList<ActivityDto>? activities,
    OnlineStatus status,
    bool viewerIsSubject,
    bool shareActivity,
    IReadOnlySet<string>? hiddenApplicationIds)
```

Rules, all enforced **server-side** — a client-side toggle is not a privacy control:

- `viewerIsSubject` → return everything, unfiltered. The user must see their own state or the
  settings UI cannot render.
- `shareActivity == false` (`UserPrivacySettings.ShareActivity`) → empty.
- `status == Hidden` → empty for third parties. Appearing offline while broadcasting
  "Playing Counter-Strike 2" defeats the entire setting, and is the same class of leak the
  existing class docblock was written to close.
- `ApplicationId ∈ hiddenApplicationIds` → drop that entry (per-game opt-out, Discord's
  "Registered Games" list).

`ShareActivity` is read through the per-service `PrivacySettingsCache` that already exists in
`Guild.Application/Services/PrivacySettingsCache.cs`.

### 5. Read path

- `GuildController` member projection (`:133-158`) already hydrates `MemberDto.Status` from the
  presence map. Add `MemberDto.Activities` through `ProjectActivitiesFor` at the same site.
- Whatever the DM/friends surface reads (`Social.Application/Services/ProfileProjectionService.cs`)
  gets the same treatment, so activity appears in the friends list and DM sidebar, not just in
  guilds.

### 6. Game catalog — seeded once, served by us  ✅ **built**

**Decision: no recurring job, and nothing at runtime calls `discord.com`.** The catalog was
extracted once into a committed artifact and is served from our own database from then on. This
is both the legally cleanest posture (a single factual extraction, no ongoing access, no
account, no accepted terms) and the operationally correct one — a runtime dependency on a
competitor's infrastructure is an outage they control.

Shipped in `Social.*`:

| Piece | Location |
|---|---|
| Bootstrap generator (manual, one-time) | `Social.Infrastructure/Seed/build-seed.mjs` |
| Committed artifact, 0.85 MiB gzipped, embedded resource | `Social.Infrastructure/Seed/game-catalog.seed.json.gz` |
| Entities | `Social.Domain/Aggregate/GameApplication.cs`, `GameExecutable.cs`, `GameCatalogState.cs` |
| Migration | `Social.Infrastructure/Migrations/*_AddGameCatalog.cs` — **not yet applied** |
| Idempotent seeder, Postgres advisory lock | `Social.Infrastructure/Seed/GameCatalogSeeder.cs` |
| Background loader | `Social.Application/Services/GameCatalogSeedService.cs` |
| Client endpoint | `Social.Application/Endpoints/GameCatalogEndpoint.cs` |
| App-id → canonical name (the anti-spoofing control) | `Social.Application/Services/GameCatalogLookup.cs` |

```
GET /api/v1/social/games/catalog[?os=win32]   → { version, gameCount, games[] }, ETag + 304, gzip
```

Note the path. The gateway rewrites `/api/v1/social/{**catch-all}` → `/api/v1/{**catch-all}`
(`Echo/Proxy/ProxyConfig.cs:18-23`), so the route declared in the service is the *internal* one
and the client must call the `social`-prefixed public path. There is a scarred comment at
`ProxyConfig.cs:45-53` about a previous incident where exactly this assumption passed every
in-process test and 404'd through the gateway.

Three properties worth keeping when this is touched again:

- **The seeder never modifies a row it did not write.** `Community` and `Manual` entries survive
  a reseed untouched, including a reseed that drops the application entirely. That is the
  mechanism by which the catalog stops being a copy of its bootstrap.
- **The ETag is derived from the data, not the seed version** — a community entry changes the
  catalog without moving the seed version, and an ETag that missed that would go stale in
  exactly the case a client most needs to notice. It is also per-platform.
- **The client downloads the rules and matches locally.** Asking the server "is this process a
  game" would be a request per scan per user and would hand us a live feed of every executable
  running on every user's machine — precisely what a presence feature should avoid collecting.

### 7. Artwork — deferred, and not from Discord  ⏸️

Explicitly out of scope for now, by product decision, with the hook kept open.

The reason it is not simply "proxy their CDN" is that cover art belongs to the **game
publishers**, not to Discord — Discord shows it under arrangements we are not party to.
Re-serving it as a commercial competitor stacks a publisher-copyright exposure on top of a
bandwidth-and-terms exposure with Discord, for one feature.

The bridge is already stored: **`GameApplication.SteamAppId`, populated for 18,317 of 23,858
catalogued applications** (and 10,163 of the 10,445 that carry executables). Steam and IGDB both
key on it, and `Social.Application.csproj` already carries an unused `IGDB` package reference.
When artwork lands it resolves through that, and `Unfurl.*` — which already fetches, validates
and caches remote media for link previews — serves the bytes. No re-fetch of anything is needed
to get there, which is why the store SKUs were kept generously in the artifact.

Until then `ActivityAssets` is null and the client renders a deliberate fallback rather than a
broken image.

### 8. Optional — bot gateway parity

`Bots.Application/Gateway` currently dispatches no presence at all. Once activities exist,
`PRESENCE_UPDATE` becomes a straightforward projection of the same model, gated by the same
`ProjectActivitiesFor`. Not in the critical path.

---

## Frontend spec (Alpine)

### Rust — replace `src-tauri/src/rich_presence.rs` with a `presence/` module

**`presence/detect.rs`** — process scanning.

- Load the mirrored detectable DB (fetched by the Angular layer, handed down as a path).
- Replace `System::new_all()` + `refresh_all()` (`rich_presence.rs:34-35`). That collects CPU,
  memory, disk and network for every process on the machine every 15 s to read a list of names.
  Use `RefreshKind`/`ProcessRefreshKind` limited to `exe`/`cmd`.
- Match on normalized full path: lowercase, `\` → `/`, strip `64`/`.x64` variants, then suffix-
  compare against DB entries (which may themselves contain a directory component). Honour the
  `>` negation prefix and `is_launcher` de-prioritization.
- **Debounce both edges.** Require two consecutive sightings before reporting (installers and
  updaters share executable names), and hold the activity for ~30 s after the process vanishes
  (a crash-and-relaunch or a loading-screen respawn should not flap the presence). Stamp
  `started_at` at first *confirmed* sighting, and never restamp while the match persists.

**`presence/ipc.rs`** — the RPC server (§B).

- Bind `\\?\pipe\discord-ipc-{n}` (Windows) / `$XDG_RUNTIME_DIR/discord-ipc-{n}` (Unix).
- Implement the framing and opcode handling exactly as specified in §B, including the
  `SET_ACTIVITY` response frame echoing the nonce.
- Modes `Proxy` (default) and `Exclusive`, selected in settings; proxy relays to a downstream
  real-Discord pipe when one is found.
- **Treat every byte as hostile.** Cap frame length (reject > 64 KB before allocating — the
  length prefix is attacker-controlled), cap concurrent connections, per-connection rate limit,
  validate `client_id` is a snowflake, and enforce the same string caps the server does so we
  are not relying on a single layer.

**`presence/media.rs`** — SMTC (Windows) / MPRIS (Linux), behind a settings toggle, default off.

**`presence/mod.rs`** — the arbiter. Merges the three sources by priority
(`Rpc > Native(Isle) > ProcessScan > Media`), deduplicates by `(type, name)`, and emits a Tauri
event `presence://changed` **only on actual change**. One source of truth; the Angular layer
never polls.

Note that Isle is ours (`IsleBridge.Sdk` exists in Echo) — it should emit first-class native
presence through the bridge rather than being detected by process name like a stranger's game.

### Angular

**`services/rich-presence.service.ts`** — rewrite.

- Replace `setInterval` polling (`:18`) with a `listen('presence://changed')` subscription;
  keep a slow poll purely as a fallback if the event channel fails.
- Debounce and coalesce outbound `PUT /social/profiles/me/activity` to at most one per 15 s.
- Clear activity on logout, on window close, and when the privacy toggle flips off — the
  300 s Redis TTL is a backstop, not a mechanism.
- Guard on `isTauri()` and `!platform.isMobile` as today (`:16`).

**`models/activity.model.ts`** — mirror of `ActivityDto`. `GuildMemberDto` (`dtos/response/member.dto.ts`)
gains `activities?: ActivityDto[]`, optional exactly as `roleMembers?` was added.

**`services/guild-websocket.service.ts`** — `WsPresenceChanged` (`:364`) gains `activities`;
the `guild.PresenceChanged` handler (`:860`) forwards them to the profile/presence store
alongside `setOnlineStatus`.

**Elapsed rendering** — two traps:

1. **One shared ticker, not one per row.** A 200-member list with a per-component
   `setInterval` is 200 timers. Use a single service-level signal that ticks every second under
   a minute of elapsed time and every 30 s after — nothing beyond a minute needs 1 Hz.
2. **Clock skew.** Compute a `serverNow − clientNow` offset once from the realtime connection
   and apply it to every `startedAt`. Without it, a user with a misconfigured clock renders
   "for 3 hours" on a game they launched a minute ago.

**UI surfaces**

- Member list row: subtitle under the name, small game icon.
- User popout / profile modal: the full card — large asset image with small-asset overlay,
  application name, `details`, `state`, party size, elapsed.
- DM/friends list and the self panel bottom-left.
- New settings page under `settings-modal/pages/` — "Activity Privacy": global
  `ShareActivity` toggle, per-game list with individual toggles, and a separate
  **"Discord-compatible game integration"** switch (default **off**) whose helper text states
  plainly that it may take over the local Discord RPC socket.

---

## What we can do

- **~10,445 games auto-detected by executable**, versus 67 today, refreshed server-side without
  an app release.
- **Full rich presence — details, state, party size, artwork, timestamps — for every game that
  already ships a Discord integration**, with zero cooperation from the game developer. This is
  the whole point of §B and it genuinely works.
- **"Playing for 23 minutes"**, correctly, across reconnects and heartbeats, because
  `StartedAt` is server-owned and sticky.
- **Coexistence with Discord** via the proxy mode, so users do not have to choose.
- **Music presence on Windows and Linux for any player**, which is broader than Discord's
  Spotify-account-link approach.
- **First-class native presence for Isle**, via the bridge SDK we already own.
- Privacy and blocking correct on day one, because the fan-out path already enforces both.

## Field findings — 2026-08-05, first run against a real machine

Two failures reported from an actual session. Both were real, and neither was where the tests
were looking.

### 1. Microsoft Store games were undetectable  ✅ **fixed**

Reported as "`flightsimulator.exe` is in the game list but detection returns null". The running
process was in fact `FlightSimulator2024.exe` — MSFS **2024**, a different catalog entry from the
2020 one that carries the bare `flightsimulator.exe` rule.

The 2024 rule is `limitless/flightsimulator2024.exe`, and the binary actually lives at
`C:\Program Files\WindowsApps\Microsoft.Limitless_1.8.10.0_x64__8wekyb3d8bbwe\FlightSimulator2024.exe`.
Store titles install to `WindowsApps\<Publisher>.<Package>_<version>_<arch>__<publisherhash>`, so
component-for-component the rule's `limitless` and the path's
`microsoft.limitless_1.8.10.0_x64__8wekyb3d8bbwe` are simply different strings. **Every Store game
whose rule carries a directory was undetectable, and 83% of rules carry one.**

`store_package_matches` in `detect.rs` lets a Store package folder satisfy a rule naming that
package, matching either the full name (`microsoft.limitless`) or its final dotted segment
(`limitless`) — but never the publisher alone, which would let one publisher's rule reach another's
package.

**That fix alone was not enough, and the reason matters.** `Win32_Process.ExecutablePath` reports the
WindowsApps path, but `WindowsApps\Microsoft.Limitless_…` is a **junction**, and `sysinfo` — which is
what the scanner actually uses — resolves it. What the matcher really sees is:

```
D:\XboxGames\Microsoft Flight Simulator 2024\Content\FlightSimulator2024.exe
```

Not one directory in that path is `limitless`, and the junction is gone before we get there. The
lesson: *check what the code sees, not what a different tool reports.* The first diagnosis was made
from PowerShell output and was confidently wrong.

The general problem is that a rule's directory records where Discord saw a game installed, which is
frequently not where it is — redirected Store packages, second drives, custom Steam libraries.

**The considered-and-rejected fix** was to fall back to a unique basename. Measured over this
catalog: 9,716 of 10,142 basenames are claimed by exactly one game, but among them are `java.exe`,
`start.exe`, `main.exe`, `run.exe` and `update.exe`. That fallback would announce a game every time a
JVM or an updater ran — reintroducing by the back door the exact false positive the negation rules
exist to prevent.

**What shipped instead is `collect_by_name`**, which requires **two independent pieces of evidence to
agree**: the executable is one this game is known to use, *and* the game's own name appears as a
directory on the path. Steam (`steamapps/common/<Game Name>/`), Epic, GOG and the Xbox app all lay
out directories that way, so this is the common case. Names are compared on letters and digits only
(`Half-Life 2` ≡ `Half Life 2`), and anything under four characters is not treated as evidence at
all. It runs only when both earlier passes found nothing, and negations still suppress it.

Verified on the live machine: a scan of 516 real processes returns Microsoft Flight Simulator 2024,
and a bare `java.exe` still returns nothing.

### 2. Third-party RPC applications are structurally invisible  ⚠️ **open — needs a decision**

Volanta (a flight tracker that publishes rich presence, and the thing that actually puts MSFS on
Discord) never appears. The RPC server is not at fault — probing the live `discord-ipc-0` that Venta
owns gives a correct handshake, `READY`, and an accepted `SET_ACTIVITY`. Three separate facts
combine:

- Volanta's Discord application id is `1293582351376584824`, and it is **not in our catalog** — not
  among the 10,445 apps with executables *nor* the other 13,413. Our seed came from the
  *detectable-games* list; Volanta is not a game.
- Volanta sends **no `name`** in `SET_ACTIVITY` (confirmed by reading its bundle: it sends `state`,
  `details`, `largeImageKey`, `largeImageText`). Discord resolves the display name from its
  *application registry* — a superset of the detectable-games list that we did not clone.
- `ActivityWriteGuard` therefore drops it: an application id that does not resolve is not vouched
  for, so the activity never reaches anyone.

This is a design gap, not a bug: the spec equated "resolvable application id" with "in the
detectable-games catalog", and Discord's RPC ecosystem is much larger than that. Every music player,
tracker and non-game integration is invisible for the same reason.

**Note what the current guard actually guarantees**, because it is narrower than the backend section
implies: a local process can already claim a *real* game's client id and be vouched for under that
name. The control does not prevent lying about what you are playing — it constrains display names to
a fixed ~23,858-entry vocabulary, which does stop arbitrary text ("CLICK HERE FOR FREE NITRO")
appearing under a user's name.

Three options, none of them free:

1. **Accept a client-supplied name for RPC activities with an unresolved id**, marked unverified and
   capped short. Unblocks the whole ecosystem; gives up the bounded-vocabulary property.
2. **Curate non-game application ids into the catalog.** Keeps the guarantee exactly as written and
   fits the "clone once, diverge from there" decision — the schema already holds apps without
   executables. Volanta works only once someone adds it.
3. **Resolve the name locally from the connecting process** (the payload carries the client's pid;
   `Volanta.exe` → "Volanta"). Truthful and needs no Discord call, but it is still an unverifiable
   string by the time it reaches the server, so it needs option 1's server change anyway.

Recommendation: **2 for now, 1 later if the curation burden proves real.** Option 1 loosens an
access-control property that was deliberately chosen, so it should be an explicit decision rather
than a side effect of fixing a bug.

### 3. The catalog ETag never reached the client  ✅ **fixed**

`ETag` was missing from the gateway's `WithExposedHeaders`, so `response.headers.get('ETag')`
returned null, nothing was cached as a validator, and every launch re-downloaded the full ~2.2 MB
catalog instead of receiving a 304. Silent — the feature worked, just expensively. The tell was the
cached catalog on disk with no `game-catalog.etag` beside it. **Needs a gateway redeploy to take
effect.**

## What we cannot do (or should not)

- **No detection on mobile or web.** iOS and Android cannot enumerate processes or bind these
  sockets. Those clients are receive-only; they render other people's activity and never
  produce their own. Non-negotiable, platform-level.
- **macOS and Linux auto-detection is close to worthless from Discord's DB** — 67 and 7
  executable entries respectively against 11,144 for Windows. Meaningful coverage there needs
  our own list (bundle identifiers on macOS, `.desktop`/Flatpak IDs on Linux). Scope Phase 1 as
  Windows-only detection and say so.
- **We can only win pipe 0 if we start first.** If Discord is already running when Venta
  launches, RPC capture yields nothing that session. Proxy mode fixes coexistence, not
  ordering. There is no way around this — it is first-come-first-served in the OS.
- **No Spotify presence via Discord's account link.** That data never touches the user's
  machine. Local media session (§C) or our own Spotify OAuth are the two real options.
- **Join / Spectate / Ask-to-Join is deep water.** The secrets are Discord-account-scoped and
  the invite flow is theirs; the game expects Discord-shaped user objects back. Synthesizable,
  but it is a project of its own. Out of scope.
- **No Steam / Xbox / PSN rich data.** Those require the game's own integration with those
  SDKs; nothing is readable from outside. We get process-level detection only.
- **We should not hotlink Discord's CDN**, and should assume the detectable endpoint and asset
  API can change or start requiring auth without notice. Mitigation is the mirror-and-proxy in
  §6/§7 plus a server-side kill switch that degrades to name-only presence.
- **Anticheat is an untested risk.** We do not inject anything — we read a process list and
  own a named pipe, both ordinary user-space operations — but aggressive kernel anticheats
  (Vanguard in particular) are hostile to process enumeration from unsigned binaries. This
  needs a real test on a real machine before Phase 1 ships; treat it as a known unknown rather
  than a solved problem.

## Legal note — decided 2026-08-04

**Resolved: seed once, serve ourselves, diverge from there.** No runtime call to `discord.com`
from any service or client; the extraction was a single manual pull recorded in
`build-seed.mjs`, performed without a Discord account and without registering a developer
application (which would mean accepting their Developer Terms and converting a weak contractual
claim into a clean breach). Artwork is not taken from them at all.

The reasoning that led there is kept below because the risk profile is worth re-reading if the
runtime dependency is ever reintroduced.

## Legal reasoning, stated plainly

Reading Discord's public detectable database, resolving app metadata from their public
endpoints, and accepting connections from game clients that were built for their SDK are all
things OpenAsar's `arrpc` does in the open, and all involve unauthenticated public endpoints.
It is nonetheless *their* data and *their* protocol, used outside its intended context, and
their terms are not written with this in mind. The engineering mitigations (mirror everything,
proxy all art, keep a kill switch, seed our own database from theirs and diverge over time)
are the same ones that make the feature robust, so there is no tension between building it
carefully and building it defensibly. Worth a decision from you before Phase 2 rather than
after.

## Phasing

| Phase | Scope | Gets us |
|---|---|---|
| **0** | Contract, `PUT me/activity`, `UserActivityChanged`, projection + privacy, DTO/WS fields | Backend can carry activity end to end |
| **1** | Detectable-DB mirror + endpoint; Rust `detect.rs` rewrite; Angular wiring; member-list rendering + elapsed | "Playing X for N minutes" for ~10.4k games, Windows |
| **2** | `ipc.rs` RPC server (proxy mode), asset resolution, Unfurl image proxy, full popout card | Real rich presence — details/state/art/party |
| **3** | Media session, per-game settings page, WS/HTTP transport on 6463–6472, bot gateway `PRESENCE_UPDATE` | Parity and polish |

**Status 2026-08-04.** Phase 0 is complete. Phase 1 is complete on the backend (catalog served,
contract, fan-out, projection, per-application opt-out) and on the Angular client; the remaining
Phase 1 item is the **`detect.rs` rewrite** — process matching still uses the legacy 67-line CSV
via `scan_game_process`, so the 10,445-game catalog is served but not yet consumed. Phase 2's RPC
pipe server is **built** (`src-tauri/src/presence/`, proxy mode with automatic per-connection
fallback to exclusive, 73 tests) minus artwork, which is deferred by decision.

Two migrations are generated and **not applied**: `AddGameCatalog` (Social) and
`AddUserHiddenActivities` (Identity).

## Open questions

1. **Proxy or exclusive as the default** for pipe 0 — proxy is friendlier but is the larger
   piece of work in Phase 2.
2. **Per-guild activity visibility?** Discord has none (it is global plus per-application).
   Cheap to add now given the fan-out is already per-guild; expensive to retrofit.
3. **Does `Hidden` suppress activity, or does activity suppress itself independently?** This
   spec says `Hidden` implies no activity. Discord agrees. Confirm that is the intent.
4. **Retention of the per-game opt-out list.** `UserPrivacySettings` is explicit columns by
   deliberate design; a growing application-id set wants its own table.
