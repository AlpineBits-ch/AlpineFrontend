# Channel icons

Design for giving a guild channel its own icon and icon colour, replacing the icon its type would
otherwise pick. Defaults stay uniform: a channel that sets nothing renders exactly as it does today.

Spans two repos. Sections A to D are `RiderProjects\Echo`; E onwards is this client.

## What ships

1. `Channel.Icon` and `Channel.IconColor`, nullable, set through the existing channel PATCH.
2. Lucide as the icon family for the channel icon slot, replacing PrimeIcons there only.
3. One catalog module that is the sole source of both the picker's contents and the icon registry.
4. `<app-channel-icon>`, collapsing fourteen hand-rolled icon sites into one component.
5. An Appearance block in channel settings: icon picker, colour swatches, live preview.
6. A tint that respects the row's existing hover, active, joined and unread states.

## Decisions taken

| Question | Answer |
|---|---|
| Icon family | Lucide (ISC). PrimeIcons stays for the rest of the app until a separate sweep. |
| How wide the Lucide migration goes now | The channel icon slot only: `CHANNEL_META`, the `channelIcon` call sites, the voice row, the picker. The remaining ~1150 `pi pi-*` chrome usages are Phase B and out of scope here. |
| Why not migrate everything now | 1167 usages across 246 files and 160 distinct glyphs with no 1:1 name mapping. The clash being avoided is *within the icon slot*; chrome icons never land there. |
| Where a custom icon shows | Everywhere the channel's icon shows: sidebar row, mention autocomplete, wiki share dialog, household and forum view headers. |
| Colour input | A fixed palette of swatches plus a Default chip. Stored as `#RRGGBB`, so a later free-form picker is not a wire change. |
| Where it is set | Channel settings, Overview page. Not at creation time. |
| What the server validates | Shape only: an icon-name pattern and a hex pattern. Not catalog membership, not palette membership. |
| What an unknown icon name does | Falls back to the type's default icon. Never renders raw, never throws. |
| How a value is cleared | `""` on the PATCH. `null` or an absent field leaves the value alone. |
| Emoji | Untouched. What users send is Twemoji plus `GuildEmojiDto` uploads, a separate pipeline from the icon font. |

## Why the clear sentinel

`UpdateChannelDto` is a PATCH that behaves as a full replace: `Name` is required, `Description`
overwrites. Applying that rule to the icon fields would mean the Flutter and web clients, which will
not send them for some time, silently wipe every custom icon on any channel edit.

`IsPrivate` in that same DTO already documents the alternative, and it is the one adopted here:

```
null or absent  ->  leave the stored value alone
""              ->  reset to the type default
"volume-2"      ->  set it
```

With System.Text.Json a missing property and an explicit `null` both deserialise to `null`, so this
needs no `JsonElement` handling.

## A. Guild: data model

```
Channel                              // existing, two new columns
    Icon      : string?   <= 48      // Lucide name, kebab-case. null = type default
    IconColor : string?   == 7       // #RRGGBB. null = the uniform default colour
```

Both nullable, no backfill, no index. Migration `AddChannelIcon` in `Guild.Infrastructure/Migrations`.

`ChannelDto` is a `[Facet(typeof(Channel), ...)]` projection, so both properties reach the wire with
no DTO edit.

## B. Guild: validation

`ChannelValidator`, each rule applying only when the value is neither null nor empty:

| Field | Rule |
|---|---|
| `Icon` | `^[a-z0-9-]{1,48}$` |
| `IconColor` | `^#[0-9a-fA-F]{6}$` |

The server enforces shape, not inventory. It has no business knowing Lucide's catalog, and a palette
that lives in server validation would make every future swatch change a deployment. The client
registry is the real gate: a name it cannot resolve falls back to the type default.

The hex pattern matches the one the role editor already uses (`roles-settings.component.ts`).

## C. Guild: the aggregate

`Channel.UpdateChannelParams` gains `Icon` and `IconColor` carrying **absolute** values. The sentinel
is resolved by the endpoint, not the aggregate: wire semantics stay at the wire.

`Update()` assigns both, then validates as it already does.

## D. Guild: the endpoint

`PATCH /api/v1/channels/{channelId}` (`ChannelEndpoint.cs:176`), already gated on
`Permissions.ManageChannel`. It resolves each field:

```
dto.Icon is null  ->  channel.Icon        // untouched
dto.Icon == ""    ->  null                // cleared
otherwise         ->  dto.Icon
```

**A bundled fix.** The endpoint's 200 response hand-builds a `ChannelDto` carrying eight fields.
`Description`, `CategoryId`, `Position` and `SlowModeSeconds` are already dropped there today, and
the settings modal emits that response straight into its `channelUpdated` output. Without the icon
fields present, saving an icon would blank it from the sidebar until the next refetch. The icon
fields go in, and so do the four already-missing ones: same one-line defect, on the path this
feature depends on.

No realtime change. `guild.ChannelUpdated` carries `{ChannelId, GuildId}` only and the client
refetches (`channel-list.component.ts:418`).

`UpsertChannelFromSyncCommand` is left alone: an imported channel gets type defaults.

## E. Client: the catalog

`lucide-angular@1.0.0` (ISC, peer range `13.x - 21.x`).

One module, `features/guild/channel-icon-catalog.ts`, holding an array of
`{name, icon, group}`. Both the picker's grouped contents and the `LUCIDE_ICONS` registry are
derived from that one array, so a catalog entry that is not registered cannot exist.

Around 200 icons in themed groups: General, Communication, Gaming, Media, Places, Objects, Nature,
Symbols. Every default in `CHANNEL_META` is also a catalog member.

Registry provision happens once in `app.config.ts`. Icons are imported by name, never
`import * as`, which would pull all ~1600.

## F. Client: the two lookups

`CHANNEL_META.icon` values move from PrimeIcons classes to Lucide names:

| Type | Was | Now |
|---|---|---|
| Text | `null` | `null` (keeps its literal `#`) |
| Voice | `pi pi-volume-up` | `volume-2` |
| Thread | `pi pi-comments` | `messages-square` |
| Forum | `pi pi-comments` | `messages-square` |
| Media | `pi pi-images` | `images` |
| Scene | `pi pi-bookmark` | `bookmark` |
| Announcement | `pi pi-megaphone` | `megaphone` |
| List | `pi pi-check-square` | `square-check` |
| Chores | `pi pi-sync` | `refresh-cw` |
| Ledger | `pi pi-wallet` | `wallet` |
| Pantry | `pi pi-box` | `package` |
| Decisions | `pi pi-flag` | `flag` |
| Meals | `pi pi-book` | `book-open` |
| Maintenance | `pi pi-wrench` | `wrench` |

Two functions:

- `channelIcon(type)` keeps its signature and returns a Lucide name.
- `channelIconFor(channel)` returns `resolve(channel.icon) ?? channelIcon(channel.type)`, where
  `resolve` yields the name only if the registry holds it.

## G. Client: the shared component

`<app-channel-icon [channel]="c">` owns the slot markup, the `#` fallback for Text, and the colour
binding. It replaces the fourteen `<i [class]="icon()">` sites, which is what makes "everywhere the
icon shows" one component rather than fourteen edits.

The voice row's hardcoded `pi pi-volume-up` and its in-flight `pi pi-spinner` swap move here too.

## H. Client: the tint

The existing rules in `src/styles.css` stay byte-identical. A tinted icon takes an additive class
and a custom property:

```css
.chan-icon-tinted {
    color: color-mix(in srgb, var(--chan-icon-tint) 78%, transparent);
}
.chan-row:hover .chan-icon-tinted,
.chan-row.is-active .chan-icon-tinted,
.chan-row.is-unread .chan-icon-tinted {
    color: var(--chan-icon-tint);
}
```

78% idle rather than the default's 32%: white at 32% over the sidebar is legible because white is
maximum luminance, and a saturated colour at the same alpha is close to invisible. A chosen colour
is a deliberate signal, so it sits brighter than chrome does.

A channel with no custom colour renders exactly as it does today. That is an acceptance criterion.

## I. Client: the editing surface

An Appearance block in `channel-overview`, wired into the existing `dirty()` and `save()` flow:

- **Icon**: a button showing the current icon, opening a popover with a search field, the grouped
  grid, and a Default entry that clears it.
- **Colour**: around twelve swatches plus a Default chip. Every swatch clears 3:1 against the
  sidebar surface at full strength.
- **Preview**: a mock sidebar row, so the pairing is visible before saving.

`UpdateChannelDto` on the client gains `icon?: string` and `iconColor?: string`. The client always
sends absolute values, `''` for none, so it never relies on the sentinel. The sentinel exists only
to protect clients that omit the fields.

While in that file: the type badge at the top runs a four-branch per-type ladder with hardcoded
`pi pi-megaphone` and `pi pi-volume-up` strings duplicating `CHANNEL_META`. It becomes the shared
component.

## J. Permission

The PATCH is gated on `Permissions.ManageChannel`. No gating was found inside the settings modal
itself, so how the modal is reached must be checked before any client-side gate is added. If one is
needed it must use the ownership-aware path: `unionMemberPermissions` answers "none" for a guild
owner, which would lock the owner out of their own channel's appearance.

## K. Tests

| Area | Test |
|---|---|
| `channel-types.spec.ts` | Icon assertions move to Lucide names. |
| Catalog | Every `CHANNEL_META.icon` resolves in the registry; catalog names are unique. |
| `channelIconFor` | Custom wins; an unknown name falls back to the type default; null falls back. |
| Tint | A channel with no custom colour is unchanged from today. |
| `ChannelValidator` | Both patterns, including that null and `""` pass. |
| Endpoint | `null` preserves the stored value, `""` clears it, a value sets it. |
| Endpoint | The 200 response carries the icon fields and the four restored ones. |

Guild.Tests failures without Docker are expected and pre-existing.

## Risks

- Two icon families coexist until the Phase B sweep. They occupy disjoint surfaces, so nothing
  clashes inside the icon slot, but it is a real interim state.
- `lucide-angular@1.0.0` is a fresh 1.0. It needs verifying under the zoneless config and the
  browser/WASM build, not only the desktop one.
- Bundle grows by ~200 icon path objects while `primeicons.woff2` is still shipped. Measure before
  and after.

## Out of scope

- Setting the icon at channel creation.
- Category icons.
- Phase B: the remaining ~1150 `pi pi-*` chrome usages and removing `primeicons.css`.
