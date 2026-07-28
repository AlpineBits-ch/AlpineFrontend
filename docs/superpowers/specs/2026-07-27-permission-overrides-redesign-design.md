# Permission Overrides Redesign + Create-Modal Enter-to-Submit

## Problem

Channel and category "Advanced permissions" pages currently render every role
(roles tab) or every overridden member (members tab) as a fully expanded
permission-editor card, stacked vertically. With more than a couple of roles
this becomes a very long scroll of repeated permission lists - bad UX.

Discord instead uses a master-detail layout: a compact list of roles/members
on the left, and a single detail panel on the right showing only the
currently selected entry's permissions.

Separately: the create-channel and create-category modals don't submit on
Enter in the name field - only clicking the Create button works.

## Goals

- Redesign the Roles and Members tabs of both `channel-permissions` and
  `category-permissions` into a Discord-style master-detail layout, styled
  with the project's existing dark theme tokens.
- Fix Enter-to-submit in `create-channel-modal` and `create-category-modal`.

## Non-goals

- Merging the Roles/Members tabs into a single combined list (kept as
  separate tabs - members are lazy-loaded on tab switch today, and merging
  would require eagerly loading members whenever the permissions page opens).
- Changing the permission grouping/labels inside `permission-override-editor`
  (General / Messages / Attachments & Embeds / Voice / Threads / Moderation)
  - that part already matches Discord's grouped-list pattern and is unchanged.
- Adding inline per-row delete in the sidebar (Discord doesn't have this
  either; deletion happens via the Delete button in the detail panel for the
  selected row).
- New automated tests - no existing `.spec.ts` coverage exists for any
  sibling component in this feature area (only one `.spec.ts` exists in the
  whole `guild` feature), so this stays consistent with that and is verified
  manually via the dev server instead.

## Design

### Shared component: `permission-overrides-panel`

New component at
`src/app/features/guild/shared/permission-overrides-panel/`, presentational,
used by all 4 call sites (channel-roles, channel-members, category-roles,
category-members).

```ts
export interface OverrideEntry {
  id: string;
  name: string;
  color?: string;        // role color dot
  avatarUrl?: string | null; // member avatar
  hasOverride: boolean;  // an override row already exists on the server
  dirty: boolean;        // local unsaved changes
  saving: boolean;
  pinned?: boolean;      // @everyone - always in `entries`, never in `addable`
  override: PermOverride;
}
```

Inputs:
- `entries: OverrideEntry[]` - rows shown in the sidebar today (has an
  override, is dirty/draft, or is pinned).
- `addable: OverrideEntry[]` - remaining candidates offered in the "+"
  popover.
- `kind: 'role' | 'member'` - toggles dot-vs-avatar rendering and copy
  ("No roles in this server" / member empty state).
- `loading` (default false) - spinner state for the Members tab while
  members load.

Outputs (all carry the entry id):
- `add(id)` - user picked an addable entry from the popover.
- `change({id, override})` - the embedded `permission-override-editor`
  emitted a change for the selected entry.
- `save(id)`
- `delete(id)`

Internal state: `selectedId` signal. Auto-selects the first entry whenever
`entries` transitions from empty to non-empty (e.g. on load), and keeps the
current selection across updates when the id is still present, else falls
back to the first entry.

Structure:
- Left column (~180px): "ROLES" / "MEMBERS" label + "+" icon button (opens a
  `p-popover`, same pattern as `self-profile-popover`) listing `addable`
  entries; clicking one emits `add(id)` and closes the popover. Below that,
  the scrollable list of `entries` as compact rows (dot/avatar + truncated
  name), highlighted when selected, `thin-scrollbar` class per project
  convention.
- Right column (flex-1): detail panel for the selected entry - header with
  dot/avatar + name + Delete button (if `hasOverride`) + Save button (if
  `dirty`), then the existing `<app-permission-override-editor>` unchanged,
  scrollable if needed.
- Empty state: centered placeholder text when nothing is selected or the
  list is empty.

### Parent components

`channel-permissions.component.ts` / `category-permissions.component.ts`
keep their existing `RoleOverride[]` / `MemberOverride[]` state and all
save/delete API calls (`guildService.upsert*/delete*`) untouched - only the
template changes, swapping the stacked-cards markup for
`<app-permission-overrides-panel>` per tab. Each gets two small computed
signals mapping existing state to `OverrideEntry[]`:

- `entries`: rows where `perm !== null || dirty`, plus (roles only) the
  `@everyone` role forced in with `pinned: true` even if it has no override.
- `addable`: rows where `perm === null && !dirty`, excluding `@everyone` for
  roles (it's always pinned, never addable).

The panel's outputs wire to the existing handler methods (adjusted to take
an id instead of a full row where needed):
- `add` → existing "add member override" logic (`onXChange(id, emptyOverride)`),
  now used for roles too.
- `change` → existing `onRoleOverrideChange` / `onMemberOverrideChange`.
- `save` → existing `saveRoleOverride` / `saveMemberOverride`.
- `delete` → existing `deleteRoleOverride` / `deleteMemberOverride`.

Also removing the two unused `addRoleDialog` / `addMemberDialog` signals in
`channel-permissions.component.ts` - dead code, not referenced in the
template.

### Enter-to-submit fix

`create-channel-modal.component.html` and `create-category-modal.component.html`:
add `(keydown.enter)="submit()"` on the name `<input>`. `submit()` already
guards on empty/creating state, so this is a minimal, safe addition - no
`<form>` wrapper needed.

## Testing

Manual verification via the dev server: open a channel's and a category's
Advanced Permissions page, exercise the Roles and Members tabs (select,
add via popover, edit permissions, save, delete), and confirm Enter submits
both create-channel and create-category modals.