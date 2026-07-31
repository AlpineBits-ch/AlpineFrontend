# Handoff — Forum Triple-Pane (and what comes after)

**Date:** 2026-07-30, updated 2026-07-31
**Branch:** `feat/forum-triple-pane` (9 commits, forked from `main` at `a7d399c`)
**Status:** All five tasks implemented and committed. **Nothing has been exercised in a running
app** — that is the one thing still owed. See §3.

Read this before touching anything. The scratch ledger at
`.superpowers/sdd/2026-07-30-forum-triple-pane/` is git-ignored and may be gone; this file is the
durable record.

---

## 1. What this branch is doing

Making the forum a Discord-style three-pane layout: channel sidebar | post list | post content.
Before it, opening a post *replaced* the post list, so you lost your place.

**Design:** `docs/superpowers/specs/2026-07-30-forum-triple-pane-design.md`
**Plan:** `docs/superpowers/plans/2026-07-30-forum-triple-pane.md`

Decisions already taken with the human, do not relitigate:

- The pane is **forum-specific**, not a general master→detail slot.
- With **no post open the list stays full-width**; it narrows to a pane only once a post opens.
  This keeps Gallery layout meaningful and leaves forum browsing unchanged.
- The post list was **split into its own component** rather than given a `compact` flag on
  `ForumChannelComponent`.
- **Filters persist per forum** and are never reset on reopening one (decided 2026-07-31, see §2).

## 2. Commits

```
cbd8693 feat: keep the forum post list beside an open post      <- Task 5
95cf9b0 refactor: read the parent forum through forumParentOf   <- Task 4
e0e4259 fix: identify the active-forum claim by token           <- Task 3 fixes
3689353 docs: handoff notes for the forum triple-pane branch
2be9728 refactor: split the forum post list into its own component   <- Task 3
ad0ac33 fix: track the active forum and first-load state
49fb2e5 feat: hold volatile forum post-list state in its own service <- Task 2
6e6889a docs: correct single-spec test invocation in forum plan
3bbe1a8 feat: add forumParentOf helper                          <- Task 1
a14dcad docs: forum triple-pane design and implementation plan
```

All five tasks are done. What changed on 2026-07-31, beyond Tasks 4 and 5 as planned:

- **Filters.** The human chose to keep them persistent. The old view cleared them on open only
  because they lived in the component and would otherwise follow you into the next forum; keyed by
  forum id they cannot leak that way, so a forum you return to is the one you left. `resetFilters`
  was dead code and is gone; the reasoning now sits on the filters section of the service.
- **The Task 5 trap was real and is closed.** `setActiveForum` returns a claim token and
  `releaseActiveForum(token)` drops the claim only if it is still live. An id comparison could not
  have worked — both mount points name the *same* forum id, so only identity separates the outgoing
  instance from the incoming one. Pinned by
  `keeps the forum live when the outgoing mount point is destroyed after the incoming one`, verified
  by mutation: removing the guard fails that test and only that test.
- **The pane's open-post highlight was never wired up.** Task 3 computed `openPostId` and nothing
  read it, and `ForumPostCardComponent` had no input to receive it. It now takes `active` and draws
  a ring — a ring rather than a background or border because the card already sets both, and the
  winner would have been Tailwind's output order rather than intent. The three `ring-*` utilities
  were confirmed present in the built `styles.css`, since they are only ever named in a class
  binding.

## 3. Pick up here

**The manual pass, and only the manual pass.** Repo convention is no component-template tests, so
this was always the sole verification of the wiring, and it still has not happened — an agent
cannot do it, because the app redirects to `/authentication` and entering credentials is not its
call. Automated state is green: **59 files / 720 tests**, and
`ng build --configuration development` succeeds.

Exercise, in a running app:

1. **Forum, no post open:** full-width list, Gallery still a real multi-column grid. Unchanged from
   before this branch.
2. **Open a post:** the list narrows to a left pane with **no loading spinner**, the post fills the
   rest, the open row carries a brand ring, and the layout toggle is absent from the pane. Clicking
   another post swaps the right pane and keeps the left.
3. **The list itself:** infinite scroll pages, tag filter and archived toggle refetch, sort
   switches, layout toggles list↔gallery, creating a post opens it, pin/lock/archive apply
   optimistically **and toast on failure**.
4. **A post created elsewhere still appears live** — including right after opening a post, which is
   the path the claim-token fix exists for.
5. **Below `lg`:** the pane disappears, the post takes the screen, the back arrow returns to the
   forum. Exactly as before.
6. **Wiki panel, then a forum post:** the wiki panel closes. Wiki panel, then a plain text channel:
   it stays.

Two things in Task 3 were reasoned about but never *seen*, and this pass is where they get
confirmed: the `host: {class: 'flex flex-col flex-1 min-h-0'}` on `ForumPostListComponent` (added
outside the plan, so the scroll container cannot grow past the viewport), and the toolbar's move
from inside the channel header to a row beneath it, which is the branch's one intended visual
change.

## 4. Gotchas that cost time already

- **Test runner.** Full suite is `./node_modules/.bin/ng test --watch=false`. One file is
  `./node_modules/.bin/ng test --watch=false --include=<path>`. **Never** run bare `npx vitest run`
  — without a path it reports ~50 spurious failed *files*; with a path it works only for specs that
  import nothing from Angular. `npx ng` does not resolve; use `./node_modules/.bin/ng`.
- **Baseline.** 59 files / 720 tests green as of `cbd8693`, on a clean tree.
- **i18n is a git submodule** (`src/assets/i18n/locales`). Commit inside it, then bump the parent
  pointer, then **push the submodule before the parent** or the pointer references commits nobody
  else can resolve. Flat dot-separated keys; `en`/`de`/`fr` maintained in parallel.
- **Two vacuous tests shipped in an earlier round of Task 2** and were caught only because an agent
  checked: a conjured empty state compares `toEqual` the default, so an "ignores unknown forum"
  test passed whether or not the behaviour existed. When writing tests here, verify by mutation —
  delete the behaviour and confirm the test actually fails.
- **Commit messages via the Bash tool need a heredoc**, not PowerShell's `@'…'@`, which lands a
  literal `@` as the subject line.

## 5. Known-deferred items (not blockers)

- `ForumPostListComponent` is doing a lot — permissions, emoji resolution, create dialog, toolbar,
  list. A faithful move of what was there, not new sprawl, but if the pane ever needs a different
  toolbar it wants splitting again.
- `nowTick` runs a 60s interval per mounted instance. The two mount points are mutually exclusive
  in practice — the pane renders only when a *post* is open, the full-width list only when a
  *forum* is — so there is one timer at a time, but nothing enforces that.
- `isMedia` now exists in both forum components — two lines that must not diverge.
- No tests cover `patchPost`, `revertPost`, `removePost`, `clearTagFilter`, or the
  `forumTagDeleted` handler. `applyThreadUpdate`'s field-by-field extraction is unpinned — a
  wholesale spread would still pass.
- `fetch`'s error path has no generation check, so a stale error can clear a newer request's
  spinner for the same forum. Ported verbatim from the component and reviewed as acceptable;
  a clean follow-up, not a bug to fix mid-branch.
- The pane is `w-80` against the wiki panel's `w-56`, matching that panel's classes otherwise.
  Whether 20rem is the right width is a judgement only the manual pass can make.

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
