# Handoff — Forum Triple-Pane (and what comes after)

**Date:** 2026-07-30
**Branch:** `feat/forum-triple-pane` (6 commits, forked from `main` at `a7d399c`)
**Status:** Tasks 1-3 of 5 implemented. **Task 3 is committed but NOT reviewed and has open
issues.** Tasks 4-5 not started.

Read this before touching anything. The scratch ledger at
`.superpowers/sdd/2026-07-30-forum-triple-pane/` is git-ignored and may be gone; this file is the
durable record.

---

## 1. What this branch is doing

Making the forum a Discord-style three-pane layout: channel sidebar | post list | post content.
Today, opening a post *replaces* the post list, so you lose your place.

**Design:** `docs/superpowers/specs/2026-07-30-forum-triple-pane-design.md`
**Plan:** `docs/superpowers/plans/2026-07-30-forum-triple-pane.md`

Decisions already taken with the human, do not relitigate:

- The pane is **forum-specific**, not a general master→detail slot.
- With **no post open the list stays full-width**; it narrows to a pane only once a post opens.
  This keeps Gallery layout meaningful and leaves forum browsing unchanged.
- The post list was **split into its own component** rather than given a `compact` flag on
  `ForumChannelComponent`.

## 2. Commits so far

```
2be9728 refactor: split the forum post list into its own component   <- Task 3, UNREVIEWED
ad0ac33 fix: track the active forum and first-load state             <- Task 2 fix round
49fb2e5 feat: hold volatile forum post-list state in its own service <- Task 2
6e6889a docs: correct single-spec test invocation in forum plan
3bbe1a8 feat: add forumParentOf helper                               <- Task 1
a14dcad docs: forum triple-pane design and implementation plan
```

| Task | State |
|---|---|
| 1 · `forumParentOf` in `channel-utils.ts` | Done, reviewed clean |
| 2 · `ForumPostListService` | Done, reviewed clean after one fix round |
| 3 · Split out `ForumPostListComponent` | **Committed, never reviewed, 5 open concerns** |
| 4 · Use `forumParentOf` in `channel.component.ts` | Not started |
| 5 · Render the pane in `main-page` | Not started |

## 3. Pick up here

### 3a. Finish Task 3 first — it is not done

**(i) Filters now persist across navigation; this contradicts documented intent.**
The original `forum-channel.component.ts:159-161` reset tag/archived filters on opening a forum,
with the comment: *"Filters belong to the forum you were looking at, not the one you just opened -
carrying them across would silently hide posts in the new forum."* State now lives per forum in the
service, so they persist, and `resetFilters` is dead code (nothing calls it).

The implementer left it deliberately and argued the case: the only place to call it is the
cold-open branch, where it no-ops for a never-opened forum and is actively wrong for the one case
it *would* fire — a forum whose first fetch failed while filtered, where silently dropping the
filter changes the user's query behind their back. Distinguishing "user navigated back" from "the
other mount point took over" needs the service's `activeForumId`, which is private.

**Decision needed from the human.** If filters should reset, expose the active forum id from
`ForumPostListService` and call `resetFilters` on a genuine cold open — that change belongs in the
service file, not the component.

**(ii) The manual pass never happened, and it is Task 3's only verification.**
Repo convention is no component-template tests, so the plan made a manual pass the sole check on
the wiring. The agent could not do it: the app redirects to `/authentication` and it correctly
refused to enter credentials. **Nothing has been observed running.** A human must exercise:
posts load · infinite scroll pages · tag filter and archived toggle refetch · sort switches ·
layout toggles list↔gallery · creating a post opens it · pin/lock/archive apply optimistically
**and toast on failure** · a post created elsewhere still appears live.

That last one is the highest-risk: see 3b.

**(iii) An unverified layout change.** The agent added `host: {class: 'flex flex-col flex-1 min-h-0'}`
to `ForumPostListComponent`, not in the plan, reasoning the host would otherwise be auto-height and
the scroll container would grow past the viewport. Sound, but never seen rendered.

**(iv) Task 3 still needs a code review.** Every other task on this branch got one; this one was
committed as the session ended.

### 3b. The trap waiting in Task 5

`ForumPostListComponent` calls `postList.setActiveForum(forum().id)` on mount and
`setActiveForum(null)` on destroy. **Only the active forum live-reloads on a new post**; others are
marked stale.

Task 5 introduces a second mount point. When the full-width instance is destroyed and the compact
one created for the same forum, **if Angular runs the destroy after the new mount, it clears the
claim the new instance just made — and newly created posts silently stop appearing live.**

There is only one mount point today, so nothing currently exercises this. Task 5 must either verify
the ordering empirically or make the clear conditional ("only clear if I am still the active one"),
which needs a getter on the service. **Do not assume the ordering is safe.**

### 3c. Then Tasks 4 and 5

Both are specified in full in the plan. Task 4 is a two-line swap; re-confirm afterwards that
behaviour is unchanged (a prior review noted the helper's guard order is flipped versus the inline
version it replaces, and proved them equivalent — worth re-checking once actually swapped).

## 4. Gotchas that cost time already

- **Test runner.** Full suite is `./node_modules/.bin/ng test --watch=false`. One file is
  `./node_modules/.bin/ng test --watch=false --include=<path>`. **Never** run bare `npx vitest run`
  — without a path it reports ~50 spurious failed *files*; with a path it works only for specs that
  import nothing from Angular. `npx ng` does not resolve; use `./node_modules/.bin/ng`.
- **Baseline.** 58 files / 703 tests green as of `ad0ac33`, on a clean tree.
- **i18n is a git submodule** (`src/assets/i18n/locales`). Commit inside it, then bump the parent
  pointer, then **push the submodule before the parent** or the pointer references commits nobody
  else can resolve. Flat dot-separated keys; `en`/`de`/`fr` maintained in parallel.
- **Two vacuous tests shipped in an earlier round of Task 2** and were caught only because an agent
  checked: a conjured empty state compares `toEqual` the default, so an "ignores unknown forum"
  test passed whether or not the behaviour existed. When writing tests here, verify by mutation —
  delete the behaviour and confirm the test actually fails.

## 5. Known-deferred items (not blockers)

- `ForumPostListComponent` is doing a lot — permissions, emoji resolution, create dialog, toolbar,
  list. A faithful move of what was there, not new sprawl, but if the pane ever needs a different
  toolbar it wants splitting again.
- `nowTick` runs a 60s interval per mounted instance; two live instances means two timers.
- `isMedia` now exists in both forum components — two lines that must not diverge.
- No tests cover `patchPost`, `revertPost`, `removePost`, `clearTagFilter`, `resetFilters`, or the
  `forumTagDeleted` handler. `applyThreadUpdate`'s field-by-field extraction is unpinned — a
  wholesale spread would still pass.
- `fetch`'s error path has no generation check, so a stale error can clear a newer request's
  spinner for the same forum. Ported verbatim from the component and reviewed as acceptable;
  a clean follow-up, not a bug to fix mid-branch.

---

## 6. What is already finished and merged

The **household modules foundation** is on `main` (merged, 685 tests green at merge):
five new `ChannelType` values, `channel-types.ts` as the single metadata table, an allowlist
router that can never render a structured-row channel as a message view, eleven new permission
bits with module-tagged groups, module-aware permission editors, and the create-channel picker.

Its design and plan: `docs/superpowers/specs/2026-07-30-household-modules-foundation-design.md`
and `docs/superpowers/plans/2026-07-30-household-modules-foundation.md`.

**It delivers no working household feature** — a shopping list is an inert placeholder. That is
intended: the eight modules are eight follow-up specs built on that foundation.

## 7. Next project after this branch

**Household Lists** (§3 of the backend's *Household modules — frontend integration guide*).
Decisions already taken with the human, carry them into its spec:

- Layout: flat list, free-text sections as sticky group headers, checked items collapsed into a
  "Done (N)" section at the bottom with a Clear button.
- Scope: the whole `ListItem` model in the first cut — text, quantity, note, section, assignee,
  check/uncheck, edit, delete, drag-reorder, clear-done, and the `sourcePantryItemId`
  "added by the pantry" badge.
- **Desktop-first**, matching the existing forum/channel density.
- The shared "household channel shell" should be extracted once there are two real module
  implementations to generalise from — not invented up front.

Follow the same flow used throughout: brainstorm → spec → plan → subagent-driven execution with a
review after each task.
