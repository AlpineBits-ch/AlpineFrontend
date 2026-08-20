# Channel permissions: UX spec

Status: approved, not started. Owner: Dominic. Date: 2026-08-20.

Covers both repos. Alpine is the client, Echo is the server (`C:\Users\Domin\RiderProjects\Echo`).

## Problem

The server resolves a channel permission through four layers:

1. Role union plus the member's own guild-level allow/deny mask.
2. Category overwrites, in tiers: @everyone deny then allow, held roles deny then allow, member last.
3. Channel overwrites, the same three tiers again on top of the category result.
4. Implication expansion. `ExpandDeniedPermissions` closes a deny over its reverse closure, so denying `ViewChannel` also removes `SendMessages`, `Connect`, `EditOwnMessages`, `DeleteOwnMessages`, `ManageOwnThreads`, `ManagePermissions`, `ManageChannel` and `SendMessagesInThreads`.

The client shows layer 3, one subject at a time, one channel at a time. The tri-state control records an intent and never shows the result, so a saved override routinely behaves differently from what the toggles say.

## What already exists

Worth stating, because two items on the original gap list turned out to be already solved server-side:

- `SetPermissionOverwriteDto` **does** carry `AllowModulePermissions` and `DenyModulePermissions` (both nullable, omitted means carry over from the row being replaced). The client's `OverridePermissionsDto` TSDoc claiming otherwise is stale. This is client work, not server work.
- `ProfileService.getCachedByUserId` and `resolveByUserId` already give a cache-first read. `fetchByUserId`, which the permission pages call, bypasses the cache on purpose. The members-tab request storm is a client bug, not a missing endpoint.
- `GET /api/v1/channels/{channelId}/viewers` ships and answers "who holds ViewChannel here", resolved properly. Only the channel invite panel calls it.
- `ChannelPrivacyService` keeps `Channel.IsPrivate` and the @everyone `ViewChannel` deny in agreement, in both directions.

## Global constraints

- Angular 21, standalone components, `inject()`, `input()`/`output()`/`model()`, `ChangeDetectionStrategy.OnPush` on every new component.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- i18n keys are flat and dot-separated. `src/assets/i18n/locales` is a git submodule and new strings need their own commit there.
- Client tests run through the Angular CLI: `bun run ng test --watch=false --include="**/name.spec.ts"`. Never bare `vitest`.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field. Use a getter.
- Echo tests are NUnit under `Guild.Tests`, `[TestFixture]` per endpoint or service, seeded through `TestGuildContext` and `PermissionTestFactory.Create(cache, context)`.
- Permission bit positions are a storage format. Add at a free bit, never move or alias one.
- Core and module masks are separate 64-bit spaces and are never OR'd together.

## Server contract

Two new endpoints. Everything else in this spec is client work against routes that already exist.

### 1. Effective permissions with provenance

```
GET /api/v1/channels/{channelId}/effective-permissions?roleId={roleId}
GET /api/v1/channels/{channelId}/effective-permissions?memberId={memberId}
```

Exactly one of `roleId` or `memberId` is required. Both or neither is a 400.

Gate: `Permissions.ManagePermissions` on the guild, the same audience that may write an overwrite. No MFA gate: this is a read.

Response `EffectivePermissionsDto`:

```json
{
  "channelId": "chan_123",
  "subjectKind": "Role",
  "subjectId": "role_456",
  "permissions": "ViewChannel, ReadMessageHistory",
  "modulePermissions": "None",
  "sources": [
    {"permission": "ViewChannel",  "granted": true,  "decidedBy": "CategoryRoleAllow", "categoryId": "cat_1", "roleId": "role_456"},
    {"permission": "SendMessages", "granted": false, "decidedBy": "ChannelEveryoneDeny", "categoryId": null,  "roleId": "role_every"},
    {"permission": "AttachFiles",  "granted": false, "decidedBy": "Implied",            "categoryId": null,  "roleId": null}
  ]
}
```

`sources` carries one entry per permission in `CHANNEL_PERM_GROUPS`, always, whether granted or not. `decidedBy` is the last layer that wrote that bit:

| Value | Meaning |
|---|---|
| `Base` | Came from the role union, no overwrite touched it |
| `MemberGuildAllow` / `MemberGuildDeny` | The member's guild-level mask |
| `CategoryEveryoneAllow` / `CategoryEveryoneDeny` | |
| `CategoryRoleAllow` / `CategoryRoleDeny` | |
| `CategoryMemberAllow` / `CategoryMemberDeny` | |
| `ChannelEveryoneAllow` / `ChannelEveryoneDeny` | |
| `ChannelRoleAllow` / `ChannelRoleDeny` | |
| `ChannelMemberAllow` / `ChannelMemberDeny` | |
| `Implied` | Removed by the reverse closure of some other deny, not named by any overwrite |
| `Superadmin` | Subject holds Superadmin, everything short-circuits |
| `Muted` | Member is timed out or has not accepted onboarding, cut back to `MuteRetainedPermissions` |

A **role** subject has no member row, so base is that role unioned with @everyone, the member tiers are skipped, and `MemberGuild*` and `Muted` can never appear. This deliberately answers "what would a member whose only role is this one get", which is the question the UI asks.

Resolution must reuse `ApplyOverwrites`, not reimplement it. The trace is a sink threaded through the existing method so the two cannot drift.

This endpoint bypasses the `GuildPermissionsForUser` cache. It is admin tooling read at human speed, and a stale answer here is worse than a slow one.

### 2. Sync a channel's permissions with its category

```
POST /api/v1/channels/{channelId}/permissions/sync
```

No body. Response: `ChannelPermissionDto[]`, the channel's overwrites after the sync.

Gate: `ManagePermissions` on the guild, plus the MFA elevation check, same as writing an overwrite.

Semantics, in one transaction:

1. 404 if the channel has no `CategoryId`.
2. Clamp check: every mask about to be copied must pass `CanGrantPermissionsAsync` for the actor, core and module, allow and deny. Any failure is a 403 and nothing is written. Without this, copying a category row is an escalation path around the clamp the direct write already has.
3. Delete every `ChannelPermission` with `ChannelId == channelId`.
4. Insert a copy of every `ChannelPermission` with `CategoryId == categoryId && ChannelId == null`, carrying `RoleId`, `MemberId` and all four masks, with `ChannelId` set and `CategoryId` null.
5. `channelPrivacy.SyncFlagAsync(channelId)`.
6. One audit entry, `AuditActionType.ChannelPermissionChanged`, payload `{ChannelId, CategoryId, Synced = true}`.
7. Publish one `ChannelPermissionChanged` for the guild.

Sync is a one-shot copy, not a stored relationship. There is no "synced" column. The client derives sync state by comparing the two overwrite sets, which it already holds.

### Deliberately not built

- `?withProfiles=true` on the members list. The client fix below is sufficient and this would cross a service boundary.
- A divergence endpoint. The client holds both overwrite sets already.
- An audit-log filter by channel. Wanted for the "last changed by" line, but that line is cut from this spec rather than shipped against a guild-wide paged read that may not contain the entry.

## Client behaviour

### A. The permissions page

The channel Permissions page opens on two switches and a drawer.

**Private channel.** Moves here from the Overview page and is removed there. It writes through `updateChannel({isPrivate})` exactly as today. Copy: "Private channel" / "Hidden from everyone except the roles and members you add below."

Moving it matters because the server makes it rewrite the @everyone `ViewChannel` deny that the override editor on this same page renders. Two pages editing one row, neither mentioning the other, is the bug. After the toggle saves, the page re-reads the channel's overwrites so the editor is not stale.

**Synced with {category}.** Shown only when the channel has a category.

Sync state is derived: the channel's overwrite set matches the category's when, for every target present in either set, the same target exists in both and all four masks are equal. Targets are keyed on `roleId ?? memberId`.

- Synced: green row, "Permissions come from the category. Editing anything below turns this off."
- Not synced: amber row, "{n} of {m} overrides differ from the category", with `See the difference` and `Re-sync`.
- Toggling on calls `POST .../permissions/sync`, then re-reads the channel.
- Toggling off writes nothing. It expands the drawer. Divergence only becomes real when the user saves an edit.

**The difference panel** lists, per target: overrides only on the channel (would be removed), only on the category (would be added), and masks that differ (would be replaced). Rendered before the user commits, because a sync you cannot preview is a sync nobody dares press.

**Advanced permissions** is a collapsed disclosure with the override count, wrapping the existing roles/members panel unchanged.

### B. Inherit shows its value

In the override editor, the neutral button of each row keeps a ghosted tick or cross showing what inheriting resolves to for the selected subject, plus a chip naming the layer that decided it.

Source: `GET .../effective-permissions` for the selected subject, fetched once per (channel, subject) and cached until the subject's override is saved. While it is in flight the row renders exactly as today, with no ghost.

The chip's text comes from `decidedBy`, mapped through `PERM_SOURCE.*` keys. `Base` renders as "role default".

**Implication warnings.** The client mirrors the server's implication table as `IMPLIED_PERMISSIONS` in `permissions.enum.ts`. Setting a row to deny shows an inline warning naming every permission the reverse closure takes with it, and greys those rows with the chip "implied off". Setting a row to allow that is itself implied by a currently-denied holder shows nothing: the server's allow does not close, so neither does ours.

The mirror is a drift risk. Two defences: a client spec pinning the exact pairs, and a server test asserting the C# table matches the same list. Both reference the golden list in this spec.

Golden list, `holder implies implied`:

```
EditAnyMessage        -> EditOwnMessages
DeleteAnyMessage      -> DeleteOwnMessages
ManageAnyThread       -> ManageOwnThreads
Speak                 -> Connect
Stream                -> Connect
MuteMembers           -> Connect
DeafenMembers         -> Connect
MoveMembers           -> Connect
PinMessages           -> SendMessages
AttachFiles           -> SendMessages
EmbedLinks            -> SendMessages
AddReactions          -> SendMessages
CreateThreads         -> SendMessages
SendMessages          -> ViewChannel
SendMessagesInThreads -> ViewChannel
Connect               -> ViewChannel
EditOwnMessages       -> ViewChannel
DeleteOwnMessages     -> ViewChannel
ManageOwnThreads      -> ViewChannel
ManagePermissions     -> ViewChannel
ManageChannel         -> ViewChannel
```

Denying a permission removes everything that transitively implies it. Allowing grants exactly the bit named.

### C. Members tab

Replace the current load with paging and cache-first profiles:

- 50 rows a page through the existing `skip`/`take`, with a "Load more" row.
- A search box using `searchMembers`, debounced 250ms, replacing the paged list while it has a term.
- Display names from `getCachedByUserId`, with `resolveByUserId` fired for misses. Never `fetchByUserId`, which is documented as the deliberate cache bypass and is what makes the current page issue one request per member.
- The roles sidebar gets the same search box, filtering in memory.

### D. Module permissions become writable

`OverridePermissionsDto` grows `allowModulePermissions?: string` and `denyModulePermissions?: string`. The editor's module group becomes a live tri-state instead of a read-only summary. `PERM_OVERRIDE.MODULE_READONLY` is deleted.

Omitting the fields means "carry over" on the server, so both are sent only when the subject's module masks are non-zero or have been edited.

### E. View server as

A guild-level mode. Pick a role or a member, and the client re-renders the guild through the resolved permissions of that subject: channels without `ViewChannel` drop out of the list, channels without `SendMessages` render the composer disabled with a reason, voice channels without `Connect` render locked.

A persistent banner names the subject, counts visible channels, and exits. The mode is client-state only and never changes what the user may actually do: every affordance is disabled rather than removed, and no write path consults it.

Backed by one `effective-permissions` call per visible channel, issued lazily as the channel list renders, cached for the session of the mode.

The detail panel for one channel lists each permission with the layer that decided it, and clicking a line jumps to that override in the editor.

### F. Role-first channel matrix

A third tab on the role editor, beside the existing display and permission pages. Rows are channels grouped by category, columns are the permissions that apply to the channel's type, cells are the tri-state, editable in place.

Column sets by channel type:

- Text, Announcement, Forum, Media: View, Send, History, Threads, Manage
- Voice: View, Connect, Speak, Stream, Manage
- Household types: View, plus that type's module group

A cell that does not apply to the row's type renders as an em-space, not a control.

### G. Apply an override to many channels

From a role's override, a picker of channels grouped by category, with tri-state category checkboxes. Two modes: replace the target's existing override, or merge into it. A diff preview before applying, and channels whose result would be identical are skipped and counted.

Executed as one `PUT` per channel, concurrency 4, with a progress row and a per-channel failure list. No new endpoint.

### H. Presets

Four named starting points when adding an override, each writing the same masks the grid would:

| Preset | Allows | Denies |
|---|---|---|
| Read only | ViewChannel, ReadMessageHistory | SendMessages, CreateThreads, AddReactions |
| Hidden | none | ViewChannel |
| Talk, do not manage | ViewChannel, SendMessages, CreateThreads, ReadMessageHistory | PinMessages, ManageChannel |
| Listen only | ViewChannel, Connect | Speak, Stream |

A preset is a shortcut, not a stored concept. The result stays editable and nothing records which preset produced it. Voice presets are offered on voice channels, the rest on everything else.

## Sequencing

1. **Echo:** the two endpoints. Nothing in the client blocks on this except B, E and F.
2. **Alpine foundation:** merge the duplicated permission pages, fix the members tab, make module bits writable, then ship A and B.
3. **Alpine at scale:** E, F, G, H.

The dedup goes first because every later change would otherwise be written twice.

## Out of scope

- Permission templates saved per guild.
- Any change to how the server caches `GuildPermissionsForUser`.
- The owner permission blind spot in `unionMemberPermissions`. Tracked separately.
- Category-level sync of a whole category's channels in one action.
