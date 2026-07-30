# Forum Triple-Pane Layout - Design

## Background

Today, opening a forum post replaces the post list: `ForumChannelComponent.openPost()` calls
`navService.openChannel(post)`, which sets `mainView` to that post's channel, and the forum view
unmounts. Reading a second post means going back and finding your place again.

Discord's forum keeps three columns - channel sidebar, post list, post content - so moving between
posts costs one click and never loses the list. This document covers that change.

**Requested scope, verbatim:** "on discord you get a tripple view. left the channel navigation,
center the post navigation and to the right the actual post channel."

**Decisions already taken** (asked and answered before this document):

- The post list pane is **forum-specific**, not a general "master → detail" slot. A generic
  middle-pane abstraction on a single example would be speculative.
- When a forum channel is selected but **no post is open, the list stays full-width**. It narrows
  to a pane only once a post opens. This preserves Gallery layout, whose
  `repeat(auto-fill, minmax(15rem, 1fr))` grid is pointless in a 20rem column, and means existing
  forum browsing is completely unchanged.
- The post list is **split into its own component now**, rather than giving `ForumChannelComponent`
  a second shape via a `compact` flag.

## Current architecture (relevant pieces)

- **`ForumChannelComponent`** (`forum-channel.component.ts`, 423 lines) owns nearly everything:
  the post list signal, keyset pagination (`nextCursor`, `PAGE_SIZE = 25`), tag/archived filters,
  sort, layout, the create-post dialog, optimistic post actions (pin/lock/archive with revert),
  three realtime subscriptions (`threadCreated`, `threadUpdated`, `forumTagDeleted`), permission
  computeds, guild-emoji URLs for tag chips, and a 60s `nowTick` for relative timestamps.
  Genuinely "channel view" concerns are only: the header shell, the `back` output, `isMedia`, and
  the hamburger.
- **`ForumStateService`** caches per-forum **tags, config, layout and sort**. Its class comment is
  explicit that this is a deliberate boundary: *"Posts are deliberately not cached here - they're
  paginated, filtered and volatile, so the forum view owns that list."*
- **`main-page.component.html:30-39`** has a second-sidebar slot, currently holding the wiki panel
  or the events panel. `navigation.service.ts:137-141` documents that these two are mutually
  exclusive *because* they share that slot.
- **`navService.openChannel()`** sets `mainView` and does **not** clear the wiki/events panels -
  so an ordinary channel can currently be viewed with the wiki panel open.
- **`channel.component.ts:125-129`** already computes a post's parent forum (`parentForum`): a
  `Thread` whose `parentChannelId` resolves to a forum-like channel in the same guild.

## Design

### 1. Where the volatile list state lives

The two mount points - full-width list, and the narrow pane - are different component instances.
Only one is mounted at a time, so component-owned state would be **refetched on every transition**:
clicking a post would unmount the full list, mount the pane, and show a spinner where the list the
user was just reading should be. That flicker is the whole reason the state has to move somewhere
shared.

`ForumStateService` is the obvious candidate and the wrong one: its documented contract is
near-static, cacheable data, and posts are none of those things. Rather than overturn that comment,
this design honours it and gives the volatile state its own home:

**New `ForumPostListService`** (`src/app/services/forum-post-list.service.ts`), root-provided,
keyed by forum id:

```ts
interface ForumPostListState {
    posts: ForumPost[];
    loading: boolean;
    loadingMore: boolean;
    nextCursor: string | null;
    selectedTagIds: string[];
    showArchived: boolean;
}
```

It owns: `stateFor(forumId)`, `reload(forumId)`, `loadMore(forumId)`, the filter mutators
(`toggleTagFilter`, `clearTagFilter`, `toggleArchived`), the optimistic post mutators
(`patchPost`, `revertPost`, `applyThreadUpdate`, `removePost`), and the three realtime
subscriptions - registered **once** in its constructor and dispatched by `forumId`, replacing
three per-component subscriptions. `ForumStateService`'s class comment is updated to point here.

Sort and layout stay in `ForumStateService` - they are per-user view preferences, already there,
and unaffected.

### 2. `ForumPostListComponent`

New `app-forum-post-list` under `components/forum-channel/`. Inputs:

```ts
forum = input.required<ChannelDto>();
compact = input(false);
```

It renders the **toolbar** (tag filter chips, archived toggle, sort menu, layout toggle), the post
rows/cards, the infinite-scroll container, and the create-post dialog. It reads all list state from
`ForumPostListService` and all tag/config/sort/layout from `ForumStateService`. It keeps the
permission computeds, the emoji-URL map and the `nowTick` interval, since those exist to render
post cards.

The toolbar moves here from the channel header. This is a deliberate consequence of the split: the
controls and the state they drive belong together, and a header that reaches into another
component's state is what makes a "compact flag" version unmaintainable. The full-width view's
toolbar therefore becomes a row beneath the channel header rather than controls right-aligned
inside it - a small, visible change to a shipped surface, called out here so it isn't a surprise in
review.

In `compact` mode it additionally:
- forces `ForumLayout.List` for rendering **without writing to `ForumStateService`**, so the user's
  stored Gallery preference survives and returns in the full-width view
- hides the layout toggle (there is nothing to choose between)
- collapses the toolbar to icon-only controls
- highlights the currently-open post's row

### 3. `ForumChannelComponent` after the split

Reduced to the channel header - icon, name, description, mobile hamburger, `back` output, `isMedia`
- plus `<app-forum-post-list [forum]="channel()"/>`. Everything else moves out. This is a pure
refactor: no behaviour change beyond the toolbar's position noted above.

### 4. Detecting an open post

`channel.component.ts`'s `parentForum` logic is extracted to a pure helper in
`channel-utils.ts`:

```ts
export function forumParentOf(
    channel: ChannelDto,
    channels: readonly ChannelDto[],
): ChannelDto | null;
```

Returns the parent forum when `channel` is a `Thread` whose `parentChannelId` names a forum-like
channel in `channels`; `null` otherwise. `channel.component.ts` is refactored to call it, so the
logic exists once and is unit-tested rather than duplicated into `main-page`.

### 5. The pane

`main-page.component.html` gains a third occupant of the existing second-sidebar slot:

```html
@if (openPostForum(); as forum) {
    <div class="hidden lg:flex shrink-0 h-full w-80 border-r border-border-subtle">
        <app-forum-post-list [compact]="true" [forum]="forum"/>
    </div>
}
```

where `openPostForum()` is a computed applying `forumParentOf` to the current channel view.

**Precedence.** The slot already enforces mutual exclusion between wiki and events panels. Opening
a forum post closes both - added to `openChannel` **only for forum posts**, so an ordinary channel
opened with the wiki panel up keeps behaving as it does today.

**Mobile is untouched.** The pane is `hidden lg:flex`, so below `lg` nothing renders and the
existing behaviour stands exactly: the post replaces the list, and `(back)` returns to it.

## Testing

Per repo convention - `.spec.ts` for services and pure helpers, no component-template tests:

- `channel-utils.spec.ts` (exists): `forumParentOf` resolves a thread under a `Forum` parent and
  under a `Media` parent; returns `null` for a thread whose parent is a `Text` channel, for a
  non-thread channel, for a missing `parentChannelId`, and for a `parentChannelId` naming a channel
  absent from the list (a dangling reference must not throw).
- `forum-post-list.service.spec.ts` (new): filter changes reset the cursor; `loadMore` de-dupes by
  id against the existing list; a `threadUpdated` for a forum with no loaded state is ignored;
  an archived post is dropped from the list when `showArchived` is false and kept when it is true;
  state is isolated per forum id.

## Risks

- **The refactor is larger than the feature.** Roughly 380 of `ForumChannelComponent`'s 423 lines
  move. The mitigation is ordering: land the split as a behaviour-preserving refactor first, verify
  the forum still works, and only then add the pane. If the split goes wrong it is visible
  immediately, on a surface that already has users, rather than tangled with new layout code.
- **Realtime subscriptions move from per-component to a root service.** Per-component subscriptions
  died with the component; service-level ones live for the session and must filter by `forumId`,
  and must not accumulate state for forums nobody opened. `ForumStateService.replaceTags` already
  establishes the pattern - ignore events for a forum with no loaded entry - and the new service
  follows it.
- **Toolbar relocation is a visible change** to an existing surface. Deliberate, and the only
  behavioural difference in an otherwise pure refactor.
