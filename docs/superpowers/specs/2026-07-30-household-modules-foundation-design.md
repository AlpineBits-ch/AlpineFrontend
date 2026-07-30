# Household Modules: Foundation - Design

## Background

The backend has published a client spec (`Household modules - frontend integration guide`)
introducing eight modules that a shared household needs and a chat server does not: shopping
lists, a chore rota, a shared-expense ledger, a pantry, house decisions, who's home, quiet
hours, and time-boxed guest access.

Five of the eight are **new channel types** whose contents are structured rows rather than
messages (`List`, `Chores`, `Ledger`, `Pantry`, `Decisions`). The other three are guild-scoped
surfaces (home status, quiet hours, guest access).

Everything is gated on a `GuildFeatures` module, which this client already models: `kind` and
`features` landed with the guild-kind/features work, and `guild-features.ts` already declares
all eight household flag names with a comment noting they have "no endpoints, channel types or
permissions behind them" yet. This spec is what changes that comment.

**Scope of this document.** The full integration guide is eight independent subsystems and is
far too large for one spec or one plan. This document covers **only the shared foundation** that
every module needs. Each of the eight modules then gets its own spec and plan, building on what
lands here:

| Sub-project | Depends on this foundation for |
|---|---|
| Lists (§3 of the guide) | Channel type, routing, `AddListItems`/`CheckOffListItems`/`ManageLists` |
| Chores (§4) | Channel type, routing, `ManageChores`/`CompleteChores` |
| Pantry (§5) | Channel type, routing, `ManagePantry` |
| Ledger (§6) | Channel type, routing, `AddExpenses`/`ManageLedger` |
| Decisions (§7) | Channel type, routing, `CreateDecisions`/`VoteDecisions` |
| Home status (§8) | Member-list placement decision (below) |
| Quiet hours (§9) | Guild-settings page placement decision (below) |
| Guest access (§9) | `ManageGuests` |

**Status of the backend**: per the integration guide, the endpoints exist and are reachable
through the gateway at `https://api.venta.gg` under `/api/v1/guild/`. This foundation makes no
HTTP calls of its own, so it is independent of backend availability.

## Current architecture (relevant pieces)

- **Channel types**: `ChannelType` is a TypeScript string enum in
  `src/app/dtos/response/guild.dto.ts:3` with six values. `isForumLike()` sits beside it as the
  one existing type-family helper.
- **Channel routing**: `main-page.component.html:54-62` switches on `view.channel.type` -
  `Voice` -> `app-voice-channel`, forum-like -> `app-forum-channel`, **`@else` -> `app-channel`**
  (the message view, which owns the composer).
- **Sidebar rendering**: `channel-list-items.component.html:6` splits Voice from everything else;
  `text-channel-item.component.html:13-21` picks the leading icon with a four-branch `@if` ladder
  and renders an unread/mention badge from `GuildReadStateService`.
- **Create channel**: `create-channel-modal.component.html` renders a 2-column grid of up to five
  type cards, each already gated on its module (`canVoice()`, `canForum()`,
  `canAnnouncement()`), with `hasTypeChoice()` hiding the picker when only one type is available.
- **Permissions**: `src/app/enums/permissions.enum.ts` - a `bigint` bitmask with values through
  bit 38 (`ManageEvents`), plus `PERM_GROUPS` (label + permission keys) driving every permission
  editor. Wire format is comma-separated **names**, parsed by `parsePermissions()`, which
  `console.warn`s on any key it doesn't recognise.
- **Permission editors**: `permission-toggle` and `bot-install-consent` read the exported
  `PERM_GROUPS`. `permission-override-editor.component.ts:17` declares its **own local**
  `PERM_GROUPS` - the channel-scoped subset.
- **Module gating**: `guild-features.ts` provides `guildHasFeature(guild, feature)`,
  `parseGuildFeatures()` (unknown names survive round-trips), `HOUSEHOLD_MODULES`, and
  `GUILD_FEATURE_LABEL_KEY`. The existing convention, stated in `channel.component.ts:98`, is
  that a module being off makes its UI **absent, not disabled**.
- **Guild kind**: `create-guild-modal` already has a kind-selection step and passes `kind` to
  `GuildService.createGuild()`. Household guilds are seeded server-side, so no client work.
- **Tests**: `permissions.enum.spec.ts:57` asserts every key in `Permissions` appears in exactly
  one `PERM_GROUPS` entry - adding permissions without grouping them fails the suite.
- **i18n**: `src/assets/i18n/locales` is a git submodule of flat dot-separated keys; new strings
  need their own commit inside it.

## Design

### 1. Channel types

Append the five new values to `ChannelType`, at the end, matching the server's additive change:

```ts
export enum ChannelType {
    Text = 'Text', Voice = 'Voice', Thread = 'Thread',
    Forum = 'Forum', Media = 'Media', Announcement = 'Announcement',
    List = 'List', Chores = 'Chores', Ledger = 'Ledger',
    Pantry = 'Pantry', Decisions = 'Decisions',
}
```

### 2. `channel-types.ts` - one source of truth

New `src/app/features/guild/channel-types.ts`. Today the leading icon for a channel type is
chosen by an `@if` ladder in `text-channel-item.component.html` and independently again in
`create-channel-modal.component.html`; at eleven types those ladders stop being readable and
start drifting from each other. A single table replaces both:

```ts
export interface HouseholdChannelMeta {
    type: ChannelType;
    feature: GuildFeature;   // the module that gates it
    icon: string;            // PrimeIcons class
    labelKey: string;
    descKey: string;
}

export const HOUSEHOLD_CHANNEL_META: readonly HouseholdChannelMeta[];

export function isHouseholdChannel(type: ChannelType): boolean;
export function householdChannelMeta(type: ChannelType): HouseholdChannelMeta | null;
/** The module gating this channel type, or null for the chat types. */
export function householdFeatureFor(type: ChannelType): GuildFeature | null;
```

Icon assignments (all existing PrimeIcons):

| Type | Icon | Module |
|---|---|---|
| `List` | `pi pi-check-square` | `Lists` |
| `Chores` | `pi pi-sync` | `Chores` |
| `Ledger` | `pi pi-wallet` | `Ledger` |
| `Pantry` | `pi pi-box` | `Pantry` |
| `Decisions` | `pi pi-flag` | `Decisions` |

`text-channel-item.component.html` keeps `#` for `Text` and reads every other icon from this
table, collapsing its ladder to a single lookup.

### 3. Routing becomes an allowlist

This is the load-bearing change. `main-page.component.html` currently ends its channel switch
with `@else { <app-channel/> }`, so **any** type it doesn't recognise renders the message view
and its composer. That is precisely the failure mode §10.1 of the guide warns about ("that's the
failure mode that produces a composer posting into a shopping list"), and it fires today for
every household channel the server sends, because household guilds are already seeded with them.

Invert it to an allowlist. The decision lives in a pure function in `channel-types.ts`, not in
the template, so it can be tested directly:

```ts
export type ChannelView = 'voice' | 'forum' | 'message' | 'unsupported';

/** Unknown and not-yet-implemented types both resolve to 'unsupported', never 'message'. */
export function channelViewFor(type: ChannelType): ChannelView;
```

| Type | View |
|---|---|
| `Voice` | `voice` -> `app-voice-channel` |
| `Forum`, `Media` | `forum` -> `app-forum-channel` |
| `Text`, `Announcement`, `Thread` | `message` -> `app-channel` |
| everything else | `unsupported` -> `app-unsupported-channel` |

`main-page.component.html` switches on `channelViewFor(view.channel.type)` rather than on the raw
type. The `unsupported` arm covers two distinct cases with the same treatment: a household type
whose module spec hasn't landed yet, and a genuinely unknown type from a newer server. Both are
inert by construction, which is the guide's stated requirement.

### 4. `app-unsupported-channel`

A new presentational component under
`src/app/features/guild/components/unsupported-channel/`. No inputs beyond the channel, no
outputs, no data fetching. Centred icon, the channel name, and a line explaining this channel
type isn't supported by this version of the app, with a hint to update. It follows the empty-state
language already used by `events-panel.component.html` (muted `text-[0.8125rem]` copy, centred,
generous vertical padding) so it reads as a deliberate state rather than a broken view.

For a household type it uses that type's icon and label from `HOUSEHOLD_CHANNEL_META`, so a
shopping-list channel opened before the Lists module ships still looks like a shopping list -
just not an interactive one. For a truly unknown type it falls back to a generic icon.

### 5. Unread badges are suppressed for household channels

`text-channel-item` renders a mention count and an unread weight from `GuildReadStateService`.
Household channels have no messages and no read state, so any badge they show can only ever be
wrong. The component skips both the badge and the unread font weight when
`isHouseholdChannel(channel().type)`.

### 6. Permissions

Eleven new values appended at bits 39-49, in the order the guide lists them:

```
ManageLists 39 · AddListItems 40 · CheckOffListItems 41
ManageChores 42 · CompleteChores 43
ManageLedger 44 · AddExpenses 45
ManagePantry 46
CreateDecisions 47 · VoteDecisions 48
ManageGuests 49
```

Bit positions are **client-internal only** - the wire format is names in both directions, so
these never have to agree with the server's numbering. They do have to stay stable once chosen,
since they are what `parsePermissions`/`stringifyPermissions` round-trip through.

`PermGroup` gains an optional feature field:

```ts
export interface PermGroup {
    label: string;
    perms: PermissionKey[];
    /** When set, this group only applies in a guild whose module is on. */
    feature?: GuildFeature;
}
```

Six new groups follow, one per module: Lists, Chores, Ledger, Pantry, Decisions, Guests. The
existing `permissions.enum.spec.ts` coverage assertion keeps this honest - all eleven keys must
be grouped or the suite fails.

**Consumers filter rather than disable.** `permission-toggle` - the editor behind both the roles
and members settings pages - hides a group whose `feature` is off for the guild in question.
§10.2 of the guide is explicit that a `403` here usually means "the guild doesn't have that
module", and that "your house doesn't do money" and "you're not allowed to see the money" must
not look the same. Hiding is also what the rest of this codebase already does for modules
(`channel.component.ts:98`).

`bot-install-consent` is deliberately **excluded** from this filtering. It enumerates the
permissions a bot has *requested*, and hiding a requested permission would understate what the
user is about to grant. A consent screen must show everything being asked for, module or no
module.

`permission-override-editor`'s local `PERM_GROUPS` gets the same eleven permissions, but gated on
**channel type** rather than guild features, because these resolve per channel: a `Ledger`
channel's override editor offers the ledger permissions and nothing else, and a `Text` channel
offers none of them. A channel-scoped overwrite granting control of one list must not read as
granting every list.

### 7. Create-channel picker

The picker splits into two labelled sections:

- **Chat** - Text, Voice, Forum, Media, Announcement (unchanged gating)
- **Household** - List, Chores, Ledger, Pantry, Decisions, each gated on its own module via
  `householdFeatureFor()`

Entries whose module is off don't render, so the Household section is absent entirely in a
Community guild and the modal looks exactly as it does today. `hasTypeChoice()` continues to hide
the whole picker when only one type is available. The name field's leading glyph reads from
`HOUSEHOLD_CHANNEL_META` rather than extending its own `@if` ladder.

### 8. Guild-scoped surface placement (decided, built later)

Recorded here so the module specs don't relitigate it:

- **Home status (§8)** renders as a distinct band in the existing right-hand
  `app-guild-member-list`, visually separated from connection presence, and is set from
  quick-settings. The guide is emphatic that "this is not connection presence" and that the two
  must stay visually distinct.
- **Quiet hours (§9)** and **guest access (§9)** become new pages in
  `guild-settings-modal/pages/`, alongside the existing modules and roles pages.

### Deliberately out of scope

- **No DTOs, services, stores or realtime subjects for any module.** Each module spec adds its
  own, following the `ScheduledEventService` + `ScheduledEventStore` pattern (typed subjects on
  `GuildWebsocketService`, a `signalStore` with `withEntities`, TTL-backed staleness). Adding
  ~25 WS subjects here, before any consumer exists, would be speculative.
- **No shared "household channel shell" component.** All five channel modules will want a common
  header + loading/error/empty scaffold, but it should be extracted from the first real
  implementation (Lists) rather than guessed at now.
- **No guild-creation work.** Household guilds are seeded server-side and the kind picker already
  exists.

## Testing

Per project convention (`.spec.ts` for stores, services and pure helpers; no component-template
tests):

- `channel-types.spec.ts`
  - every household `ChannelType` has exactly one metadata entry; `householdFeatureFor()` returns
    `null` for chat types and the right module for household types; `isHouseholdChannel()` agrees
    with the table.
  - `channelViewFor()` maps each of the eleven known types to its expected view, **and returns
    `'unsupported'` - never `'message'` - for a type outside the enum**. This is the one behaviour
    whose failure mode is silent and damaging (a composer posting into a shopping list), and
    routing through a pure function is what makes it testable without a template test.
- `permissions.enum.spec.ts` - extended so the existing "every key is grouped" assertion covers
  the new keys, plus a round-trip check that each new name survives
  `parsePermissions` -> `stringifyPermissions` without a warning.

## Risks

- **Bit-position drift.** If the server ever serializes permissions numerically instead of by
  name, positions 39-49 would need to match its numbering. `parsePermissions` already handles a
  numeric string, so this would surface as wrong permissions rather than a parse error. Mitigated
  only by the fact that every current payload uses names.
- **`403` ambiguity.** Module-off and permission-denied share a status code. The foundation makes
  hiding-by-feature possible; each module spec still has to check `features` before rendering
  rather than reacting to the response.

## i18n

New keys land as their own commit in the `src/assets/i18n/locales` submodule, flat and
dot-separated, following `GUILD_MODULE.*`:

- `CHANNEL_TYPE.LIST.LABEL` / `.DESC` and the four siblings
- `CHANNEL.UNSUPPORTED.TITLE` / `.BODY`
- Permission group labels for the six new groups
