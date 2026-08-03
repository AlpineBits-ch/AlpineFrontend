# Forum Channel Navigator - Design

**Date:** 2026-07-31
**Status:** Implemented.

## Why

Two complaints about how forums read in the channel sidebar.

The forum glyph was `pi pi-align-left` - four flush-left text lines, the icon a compose toolbar
uses for text alignment. Nothing about it says *discussion*.

And a forum was a dead end in the navigator. Opening a post replaced the sidebar's sense of where
you were: the post you were reading had no representation there at all, so returning to it meant
going back into the forum and finding it again. Discord solves this by hanging the posts you care
about beneath their forum on a connecting line. That is what this builds.

## Decisions

Taken with the human, in order:

- **Which posts nest:** visited, mentioned, or unread. A post joins the list when you open it, when
  it names you, or when it has unread activity.
- **Eviction:** the 5 most recently visited per forum, newest wins, persisted. Mentioned and unread
  posts show regardless and are not counted against that cap.
- **Icon:** `pi pi-comments`, chosen against three alternatives rendered in a sidebar mock.
- **Tree:** elbow branches with a rounded turn on the last row, 2.5px, fading in over the first row.
- **Rollup:** the forum row reports the sum of its posts.

Three calls made rather than asked, all flagged and accepted: an 8-row total cap, forum-like
channels only (`Forum` and `Media` - text-channel threads keep their existing thread panel), and
leaving `Thread` on `pi-comments` alongside `Forum`.

## What made this cheap

Two things were already true and are the reason this needed no API work:

- **Forum posts already arrive client-side.** They come down in the guild payload as channels with
  `parentChannelId` set; the sidebar was filtering them out by hand. The whole list is in memory.
- **Read state is keyed by channel id, and a post is a channel.** `GuildReadStateService` was
  already tracking unread and mention counts for post ids without anything reading them, and
  `channel.component.ts` already calls `markChannelRead` when a post opens.

## Architecture

**`ForumVisitedPostsService`** (`src/app/services/forum-visited-posts.service.ts`) - root,
localStorage-backed, `forumId → postId[]` newest-first, capped at 5.

Recording happens in one effect on `navService.mainView()`, resolving the open channel through
`forumParentOf`. It is deliberately not at the call sites: there are four ways a post opens - the
full-width post list, the narrow pane, a sidebar row, and nav restored from localStorage on reload
- and the restore path runs no click handler at all. Watching the view catches every one.

Malformed storage reads as empty, per-entry, so one bad forum cannot discard the rest. Losing these
rows is cosmetic; throwing would take the sidebar with it.

**`forum-post-rows.util.ts`** - two pure functions, which is what makes this testable without a
component test:

- `selectNestedPosts` - filters a forum's non-archived children to visited ∪ unread ∪ mentioned,
  orders them mentioned → unread → visited then by `lastActivityAt` descending, and caps at 8.
  The ordering exists because of the cap: what gets cut should be the least interesting row, not
  whatever happened to sort last.
- `forumTreePath` - the SVG path data for `n` rows.

**`ForumPostRowsComponent`** - mounted from `channel-list-items.component.html` after any
forum-like row. Renders nothing when the selector returns nothing.

**Rollup** - `GuildReadStateService.aggregate(ids)` sums mentions and ORs unread.
`TextChannelItemComponent` computes its own children for forum-like types and aggregates over
`[own, ...children]`. Every other type passes an empty list, so `aggregate([own])` is identical to
the old `getChannelState(own)` and their behaviour is untouched.

## Two details that matter

**The tree is stroked SVG, not borders.** The first attempt drew the vertical and the horizontal as
two semi-transparent CSS borders. Where they met, the two alphas composited and the junction
rendered visibly brighter than the rest of the line; the corner was a hard right angle because two
borders meeting is not a path turning. It is now one `<g>` at a single opacity containing stroked
paths, so overlaps cannot double up, and the turn is a quadratic curve. The gradient fades the
trunk in over exactly the first row so it grows out of the forum above rather than starting on a
blunt end.

**`NESTED_ROW_HEIGHT` is load-bearing in two places.** It is the SVG's coordinate space *and* the
row height. If they drift the branches stop meeting their rows, so the template binds
`[style.height.px]` from the constant rather than restating it in CSS.

Each instance's gradient gets a unique id - SVG ids resolve document-wide, and two forums with
nested rows would otherwise share one gradient.

## Icon consistency

`CHANNEL_META` documents `channelIcon()` as the app's single icon lookup, but five places
hardcoded `pi-align-left` instead: the create-channel modal, channel settings, the forum header,
the forum empty state, and the mention suggestion overlay. Changing only the table would have left
the old glyph in all five, so they now call `channelIcon()`. `template-preview` and the suggestion
overlay keep a local fallback to `pi pi-hashtag`, since Text returns `null` by design and a newer
server may name a type this build has no entry for.

## Testing

29 tests across three specs: the selector and tree geometry, the visited store (LRU, persistence,
unparseable and partially-malformed storage), and the rollup. No component-template tests, per repo
convention.

The runner's global `localStorage` exists but has no methods, so the visited spec installs an
in-memory stand-in - without it the service's own try/catch swallows every read and persistence
could not be asserted at all.

**Not verified:** nothing here has been seen rendered. The suite and build are green, and the tree
geometry is pinned by assertions on the emitted path data, but the app redirects to
`/authentication` and no agent can complete that. The visual pass is outstanding: the icon in situ,
the tree's smoothness at 1 / 2 / 8 rows, the unread pill alignment, and that a post opened from a
sidebar row highlights and clears its own unread.
