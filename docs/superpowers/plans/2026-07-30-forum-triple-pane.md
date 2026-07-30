# Forum Triple-Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a forum's post list visible as a middle pane while reading a post, Discord-style, by first splitting the post list out of `ForumChannelComponent` into its own component backed by shared state.

**Architecture:** Volatile per-forum list state (posts, cursor, filters) moves from the component into a new root `ForumPostListService`, so the full-width list and the narrow pane are two mount points over one state and switching between them never refetches. `ForumChannelComponent` shrinks to a channel header wrapping `<app-forum-post-list>`. `main-page` renders a second instance in `compact` mode, in the slot the wiki and events panels already share.

**Tech Stack:** Angular 21 (signals, standalone, `@if`/`@for`, `OnPush`), PrimeNG 21, Tailwind v4, TypeScript 5.9, Vitest 4, ngx-translate 17.

## Global Constraints

- **Design doc:** `docs/superpowers/specs/2026-07-30-forum-triple-pane-design.md`. Read it first.
- **Tasks 1-4 are a behaviour-preserving refactor.** The only intended visible change is the toolbar moving from inside the channel header to a row beneath it. Anything else that looks different is a bug.
- **Mobile behaviour must not change at all.** The pane is `hidden lg:flex`; below `lg` the post still replaces the list and `(back)` still returns to it.
- **Tests:** Vitest via the Angular builder. `.spec.ts` for services and pure helpers only - no component-template tests.
  - Single pure-helper file: `npx vitest run <path>`.
  - Full suite: `./node_modules/.bin/ng test --watch=false`. Baseline is **57 files / 685 tests, all passing** - any failure is yours.
  - **Never** run bare `npx vitest run` with no path: it bypasses the Angular builder and reports ~50 spurious file failures.
  - `npx ng` does not resolve in this repo. Use `./node_modules/.bin/ng`.
- **Build:** `./node_modules/.bin/ng build --configuration development`.
- **Tailwind tokens:** `bg-app-bg`, `bg-card`, `border-border-subtle`, `text-text-muted` etc. Font sizes in rem. Match each file's surrounding conventions rather than modernising untouched lines.
- **Angular style:** `input.required<T>()` / `input(default)` / `output<T>()` / `computed()`; `protected` for template-only members, `private` for injected services; `ChangeDetectionStrategy.OnPush` where the existing component already uses it.
- **i18n:** `src/assets/i18n/locales` is a git submodule (flat dot-separated keys, three locales maintained in parallel, commit inside the submodule then bump the parent pointer). Reuse existing `FORUM.*` keys wherever possible - this plan should need very few new ones.

---

### Task 1: `forumParentOf` helper

**Files:**
- Modify: `src/app/features/guild/components/channel/channel-utils.ts`
- Test: `src/app/features/guild/components/channel/channel-utils.spec.ts`

**Interfaces:**
- Consumes: `ChannelDto`, `ChannelType`, `isForumLike` from `dtos/response/guild.dto`.
- Produces: `forumParentOf(channel: ChannelDto, channels: readonly ChannelDto[]): ChannelDto | null` — used by Task 4 (`channel.component.ts`) and Task 5 (`main-page.component.ts`).

- [ ] **Step 1: Write the failing test**

Append to `src/app/features/guild/components/channel/channel-utils.spec.ts` (keep its existing imports; add what you need):

```ts
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {forumParentOf} from './channel-utils';

function chan(over: Partial<ChannelDto> & {id: string; type: ChannelType}): ChannelDto {
    return {
        createdAt: new Date(), updatedAt: new Date(), name: over.id, description: '',
        guildId: 'g1', isAgeRestricted: false, isPrivate: false, categoryId: undefined,
        permissions: [], position: 0, parentChannelId: undefined, ...over,
    } as ChannelDto;
}

describe('forumParentOf', () => {
    const forum = chan({id: 'f1', type: ChannelType.Forum});
    const media = chan({id: 'm1', type: ChannelType.Media});
    const text = chan({id: 't1', type: ChannelType.Text});
    const all = [forum, media, text];

    it('resolves a thread whose parent is a Forum', () => {
        const post = chan({id: 'p1', type: ChannelType.Thread, parentChannelId: 'f1'});
        expect(forumParentOf(post, all)).toBe(forum);
    });

    it('resolves a thread whose parent is a Media channel', () => {
        const post = chan({id: 'p2', type: ChannelType.Thread, parentChannelId: 'm1'});
        expect(forumParentOf(post, all)).toBe(media);
    });

    it('returns null for a thread whose parent is a Text channel', () => {
        const post = chan({id: 'p3', type: ChannelType.Thread, parentChannelId: 't1'});
        expect(forumParentOf(post, all)).toBeNull();
    });

    it('returns null for a channel that is not a Thread', () => {
        expect(forumParentOf(text, all)).toBeNull();
        expect(forumParentOf(forum, all)).toBeNull();
    });

    it('returns null when parentChannelId is absent', () => {
        const orphan = chan({id: 'p4', type: ChannelType.Thread});
        expect(forumParentOf(orphan, all)).toBeNull();
    });

    // A post can arrive before its parent is in the cached channel list; that must be a
    // null, not a crash, or the whole main view fails to render.
    it('returns null for a dangling parentChannelId', () => {
        const post = chan({id: 'p5', type: ChannelType.Thread, parentChannelId: 'gone'});
        expect(forumParentOf(post, all)).toBeNull();
    });

    it('returns null against an empty channel list', () => {
        const post = chan({id: 'p6', type: ChannelType.Thread, parentChannelId: 'f1'});
        expect(forumParentOf(post, [])).toBeNull();
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/app/features/guild/components/channel/channel-utils.spec.ts`
Expected: FAIL — `forumParentOf` is not exported.

- [ ] **Step 3: Implement**

Append to `src/app/features/guild/components/channel/channel-utils.ts`:

```ts
/**
 * The forum a post belongs to, or null if this channel isn't a forum post.
 *
 * A forum post is an ordinary Thread whose parent happens to be a Forum or Media
 * channel, so "is this a post?" and "which forum?" are the same lookup. A dangling
 * parentChannelId - the parent not yet in the cached channel list - is a null rather
 * than a throw, because both callers run during render of the main view.
 */
export function forumParentOf(
    channel: ChannelDto,
    channels: readonly ChannelDto[],
): ChannelDto | null {
    if (channel.type !== ChannelType.Thread) return null;
    const parentId = channel.parentChannelId;
    if (!parentId) return null;
    return channels.find(c => c.id === parentId && isForumLike(c.type)) ?? null;
}
```

Add `ChannelType` and `isForumLike` to the file's existing import from `dtos/response/guild.dto` (it may currently import only some of these).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/app/features/guild/components/channel/channel-utils.spec.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel/channel-utils.ts src/app/features/guild/components/channel/channel-utils.spec.ts
git commit -m "feat: add forumParentOf helper"
```

---

### Task 2: `ForumPostListService`

**Files:**
- Create: `src/app/services/forum-post-list.service.ts`
- Test: `src/app/services/forum-post-list.service.spec.ts`
- Modify: `src/app/services/forum-state.service.ts` (class comment only)

**Interfaces:**
- Consumes: `ForumService.getPosts`, `GuildWebsocketService` (`threadCreatedObservable`, `threadUpdatedObservable`, `forumTagDeletedObservable`), `ForumStateService.sortFor`, `ToastService`, `TranslateService`.
- Produces the API Task 3 consumes:
  - `stateFor(forumId: string): ForumPostListState` — never null; returns an empty default for an unknown forum
  - `reload(forumId: string): void`
  - `loadMore(forumId: string): void`
  - `toggleTagFilter(forumId, tagId)` / `clearTagFilter(forumId)` / `toggleArchived(forumId)` — each resets the cursor and reloads
  - `patchPost(forumId, postId, patch: Partial<ForumPost>)`
  - `revertPost(forumId, original: ForumPost)`
  - `removePost(forumId, postId)`
  - `resetFilters(forumId)` — clears tag/archived filters without fetching

```ts
export interface ForumPostListState {
    posts: ForumPost[];
    loading: boolean;
    loadingMore: boolean;
    nextCursor: string | null;
    selectedTagIds: string[];
    showArchived: boolean;
}
```

**Source of the logic:** every behaviour here already exists in `forum-channel.component.ts` — `reload` (207-214), `loadMore` (216-229), `fetch` (237-264), the filter mutators (267-292), `patchPost`/`revert` (392-399), `applyThreadUpdate` (406-422), and the three realtime subscriptions (172-199). **Move them, preserving their comments and their semantics** (including the stale-response guard in `fetch` and the de-dupe in `loadMore`); do not redesign them. `PAGE_SIZE = 25` moves too.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/forum-post-list.service.spec.ts`. `src/app/services/forum-state.service.spec.ts` is the direct precedent — it stubs `GuildWebsocketService` with plain `Subject`s and drives HTTP through `HttpTestingController`. Follow it:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';

import {ForumPostListService} from './forum-post-list.service';
import {ApiConfigService} from './api-config.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ForumStateService} from './forum-state.service';
import {ForumPost, ForumSortOrder} from '../dtos/response/forum.dto';

const base = 'https://api.test.example/api/v1/guild';

function postFixture(overrides: Partial<ForumPost> = {}): ForumPost {
    return {
        id: 'p1', name: 'A post', guildId: 'g1', parentChannelId: 'f1',
        tagIds: [], isPinned: false, isLocked: false, isArchived: false,
        messageCount: 0, createdAt: '2026-07-30T00:00:00Z',
        lastActivityAt: '2026-07-30T00:00:00Z',
        ...overrides,
    } as ForumPost;
}

/** Only the observables the service subscribes to; nothing else is touched. */
function wsStub() {
    return {
        threadCreatedObservable: new Subject<any>(),
        threadUpdatedObservable: new Subject<any>(),
        forumTagDeletedObservable: new Subject<any>(),
    };
}

function setup() {
    const ws = wsStub();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: GuildWebsocketService, useValue: ws},
            {provide: ForumStateService, useValue: {sortFor: () => ForumSortOrder.LatestActivity}},
        ],
    });
    return {
        service: TestBed.inject(ForumPostListService),
        ctrl: TestBed.inject(HttpTestingController),
        ws,
    };
}

/** Flushes the one in-flight posts request for a forum. */
function flushPosts(ctrl: HttpTestingController, posts: ForumPost[], nextCursor: string | null = null) {
    const req = ctrl.expectOne(r => r.url === `${base}/channels/f1/posts` || r.url.includes('/posts'));
    req.flush({posts, nextCursor});
    return req;
}
```

Then these tests, written out in full against that harness:

1. **`returns an empty default state for a forum never loaded`** — `stateFor('never-opened')` gives `posts: []`, `loading: false`, `loadingMore: false`, `nextCursor: null`, `selectedTagIds: []`, `showArchived: false`, and issues no HTTP request (`ctrl.verify()` in `afterEach` proves it).
2. **`keeps state isolated per forum id`** — `reload('f1')` and `reload('f2')`, flush different posts to each, assert each `stateFor` sees only its own.
3. **`resets the cursor when a tag filter changes`** — `reload('f1')`, flush with `nextCursor: 'c1'`; then `toggleTagFilter('f1', 'tag1')` and assert the resulting request carries **no** `cursor` param and does carry `tagIds=tag1`.
4. **`de-dupes by id when a loadMore response overlaps`** — flush page 1 as `[p1, p2]` with `nextCursor: 'c1'`, call `loadMore('f1')`, flush page 2 as `[p2, p3]`; assert final ids are exactly `['p1','p2','p3']`.
5. **`ignores a threadUpdated event for a forum with no loaded state`** — emit `{parentChannelId: 'never-opened', channelId: 'x', isPinned: true}` on `ws.threadUpdatedObservable`; assert `stateFor('never-opened')` is still the empty default and no request was made.
6. **`drops an archived post when showArchived is false`** — load `[p1]`, emit `threadUpdated` with `{parentChannelId:'f1', channelId:'p1', isArchived:true}`, assert `posts` is empty.
7. **`keeps an archived post when showArchived is true`** — same, but call `toggleArchived('f1')` first (flushing its refetch), and assert `p1` survives with `isArchived: true`.
8. **`does not apply a stale response to a forum that has since reloaded`** — call `reload('f1')`, then `reload('f1')` again, then flush the **first** request with `[p1]` and the second with `[p2]`; assert only `p2` is present. This pins the request-generation guard.

Exercise the service only through its public API — never reach into private signals.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/app/services/forum-post-list.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/app/services/forum-post-list.service.ts`, root-provided, holding
`private readonly stateByForum = signal<Record<string, ForumPostListState>>({})`.

Requirements the tests above pin down:
- `stateFor` returns a shared frozen-ish default object for unknown ids rather than creating an entry (creating on read would make "has this forum been opened?" untrue).
- The three realtime subscriptions register **once**, in the constructor, and dispatch on `e.parentChannelId` (thread events) / `e.channelId` (tag deletion). Each ignores a forum with no entry in `stateByForum`, mirroring `ForumStateService.replaceTags`'s documented reason for doing the same.
- `fetch` keeps the stale-response guard: capture `forumId` before the request and drop the response if that forum's state has since been replaced by a different request generation. Since the service is keyed by forum, use a per-forum request counter rather than the component's old `this.channel().id !== forumId` check.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/app/services/forum-post-list.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Update the `ForumStateService` comment**

Its class comment (lines 6-14) currently ends: *"Posts are deliberately not cached here - they're paginated, filtered and volatile, so the forum view owns that list."* The second half is now wrong. Replace that sentence with a pointer:

```
 * Posts are deliberately not cached here - they're paginated, filtered and volatile.
 * That state lives in ForumPostListService, which the full-width list and the narrow
 * post-list pane share so switching between them doesn't refetch.
```

- [ ] **Step 6: Full suite, then commit**

Run: `./node_modules/.bin/ng test --watch=false` — expected 57 files / 685 tests plus your new ones, all passing.

```bash
git add src/app/services/forum-post-list.service.ts src/app/services/forum-post-list.service.spec.ts src/app/services/forum-state.service.ts
git commit -m "feat: hold volatile forum post-list state in its own service"
```

---

### Task 3: Split out `ForumPostListComponent`

**Files:**
- Create: `src/app/features/guild/components/forum-channel/forum-post-list.component.ts`
- Create: `src/app/features/guild/components/forum-channel/forum-post-list.component.html`
- Modify: `src/app/features/guild/components/forum-channel/forum-channel.component.ts`
- Modify: `src/app/features/guild/components/forum-channel/forum-channel.component.html`

**Interfaces:**
- Consumes: `ForumPostListService` (Task 2), `ForumStateService`, `ForumPostCardComponent`, `ForumTagChipComponent`, `ForumTagPickerComponent`.
- Produces: `<app-forum-post-list [forum]="…" [compact]="…"/>`, selector `app-forum-post-list`, inputs `forum = input.required<ChannelDto>()` and `compact = input(false)`. Task 5 mounts the compact instance.

**This is a behaviour-preserving move.** Move members and markup verbatim; do not rewrite logic. The one intended visible change is the toolbar's position (see Step 3).

- [ ] **Step 1: Create the component class**

`forum-post-list.component.ts`, `OnPush`, with the two inputs above. **Move** these from `forum-channel.component.ts`, keeping their comments:

- create-dialog state and methods: `showCreateDialog`, `createName`, `createContent`, `createTagIds`, `creating`, `createTagError`, `openCreateDialog()`, `createPost()`, `maxTags`
- `nowTick` + its interval and the `ngOnDestroy` that clears it
- computeds: `tags`, `config`, `layout`, `sortOrder`, `requireTag`, `emojiUrls`, `emojiUrlFor`, `sortMenuItems`
- permissions: `ownMember`, `permissions`, `isOwner`, `can`, `canCreatePost`, `canModerate`, `canUseModeratedTags`
- `openPost()`, `onPostAction()`
- filter/sort/layout handlers — now delegating to `ForumPostListService` / `ForumStateService` instead of local signals
- `onScroll()` — delegating to the service's `loadMore`
- the `effect` that calls `forumState.loadFor` / `emojiStore.ensureLoaded`, and the one fetching `ownMember`

Post-list reads become service reads, e.g.
`protected posts = computed(() => this.postList.stateFor(this.forum().id).posts);`
and likewise `loading`, `loadingMore`, `nextCursor`, `selectedTagIds`, `showArchived`.

The realtime subscriptions do **not** move here — Task 2 owns them now. Delete them from `forum-channel.component.ts` rather than duplicating.

Add the compact-mode members:

```ts
    /**
     * In the narrow pane a Gallery grid of 15rem cards is a one-column grid with wasted
     * gutters, so compact always renders as a list - without writing to ForumStateService,
     * so the user's stored Gallery preference survives and returns in the full-width view.
     */
    protected effectiveLayout = computed(() =>
        this.compact() ? ForumLayout.List : this.layout());

    /** The post currently open in the main view, highlighted in the pane. */
    protected openPostId = computed(() => {
        const view = this.navService.mainView();
        return view.type === 'channel' ? view.channel.id : null;
    });
```

Every template reference to `layout()` becomes `effectiveLayout()`.

- [ ] **Step 2: Move the markup**

`forum-channel.component.html` is 162 lines with clean section boundaries. Move to `forum-post-list.component.html`, in this order:
- the toolbar controls currently at **lines 20-53** (archived toggle, sort menu, layout toggle)
- the tag filter bar, **lines 56-76**
- the post list, **lines 77-129**
- the create-post dialog, **lines 130-162**

Wrap them in a root `<div class="flex flex-col h-full min-h-0">`. Guard the layout toggle with `@if (!compact()) { … }`.

- [ ] **Step 3: Slim `ForumChannelComponent`**

`forum-channel.component.html` keeps only its header (lines 1-19 plus the `</header>` at 54) and then renders the list:

```html
<div class="flex flex-col h-full bg-app-bg overflow-hidden">
    <header …>…icon, name, description, hamburger…</header>
    <app-forum-post-list [forum]="channel()"/>
</div>
```

The toolbar that used to sit right-aligned inside the header now appears as a row beneath it, inside the list component. That is the intended change.

`forum-channel.component.ts` keeps: `channel` input, `back` output, `isMedia`, `navService`, and the `ForumPostListComponent` import. Everything else goes. Remove imports left unused — the build will name them.

- [ ] **Step 4: Build and verify by hand**

Run: `./node_modules/.bin/ng build --configuration development` — must succeed with no unused-import errors.

Then run `./node_modules/.bin/ng serve` and check the forum still works end to end: posts load, infinite scroll pages, tag filters and archived toggle refetch, sort switches, layout toggles between list and gallery, creating a post opens it, and pin/lock/archive still apply optimistically. **This task has no automated coverage** — the service is tested but the wiring isn't, so this manual pass is the verification.

- [ ] **Step 5: Full suite, then commit**

Run: `./node_modules/.bin/ng test --watch=false` — must stay green.

```bash
git add src/app/features/guild/components/forum-channel/
git commit -m "refactor: split the forum post list into its own component"
```

---

### Task 4: Use `forumParentOf` in `channel.component.ts`

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.ts:125-129`

**Interfaces:**
- Consumes: `forumParentOf` (Task 1).
- Produces: nothing new. This removes the duplicate so the logic exists once.

- [ ] **Step 1: Replace the inline computed**

Currently:

```ts
    protected parentForum = computed(() => {
        const parentId = this.channel().parentChannelId;
        if (!parentId || this.channel().type !== ChannelType.Thread) return null;
        return this.guildChannels().find(c => c.id === parentId && isForumLike(c.type)) ?? null;
    });
```

Becomes:

```ts
    protected parentForum = computed(() => forumParentOf(this.channel(), this.guildChannels()));
```

Add `forumParentOf` to the existing import from `./channel-utils` (the file already imports `classifyAutoModError` from there). Remove `isForumLike` — and `ChannelType`, **only if** nothing else in the file uses it; `ChannelType` is also exposed as `protected readonly ChannelType` for the template, so check before removing.

- [ ] **Step 2: Build**

Run: `./node_modules/.bin/ng build --configuration development` — must succeed.

- [ ] **Step 3: Full suite, then commit**

Run: `./node_modules/.bin/ng test --watch=false`

```bash
git add src/app/features/guild/components/channel/channel.component.ts
git commit -m "refactor: read the parent forum through forumParentOf"
```

---

### Task 5: Render the pane

**Files:**
- Modify: `src/app/features/main-page/main-page.component.ts`
- Modify: `src/app/features/main-page/main-page.component.html:30-39`
- Modify: `src/app/features/main-page/navigation.service.ts:124-128`

**Interfaces:**
- Consumes: `forumParentOf` (Task 1), `ForumPostListComponent` (Task 3).
- Produces: nothing further depends on this. Final task.

- [ ] **Step 1: Compute the open post's forum**

In `main-page.component.ts`, import `forumParentOf` from `../guild/components/channel/channel-utils` and `ForumPostListComponent` from `../guild/components/forum-channel/forum-post-list.component`; add the latter to the component's `imports` array. Then add:

```ts
    /**
     * The forum whose post list should sit beside the main view: non-null exactly when
     * the open channel is a forum post. Desktop only - below `lg` the pane is hidden and
     * the post keeps the whole screen, as it always has.
     */
    protected openPostForum = computed(() => {
        const view = this.navService.mainView();
        if (view.type !== 'channel') return null;
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return null;
        return forumParentOf(view.channel, ws.guild.channels);
    });
```

- [ ] **Step 2: Render it in the panel slot**

In `main-page.component.html`, after the events-panel block (line 37-39), add:

```html
        <!-- Forum post list (second sidebar, same slot as the wiki and events panels).
             Present only while a forum post is open, so browsing a forum keeps the full
             width and Gallery layout stays useful. -->
        @if (openPostForum(); as postForum) {
            <div class="hidden lg:flex shrink-0 h-full w-80 bg-sidebar border-r border-white/[0.10]">
                <app-forum-post-list [compact]="true" [forum]="postForum"/>
            </div>
        }
```

- [ ] **Step 3: Give the slot a precedence rule**

`openChannel` currently leaves the wiki/events panels alone. Three occupants can't share one slot, so opening a forum post must close them — and **only** a forum post, so an ordinary channel opened with the wiki panel up keeps behaving as it does today:

```ts
    openChannel(channel: ChannelDto): void {
        // A forum post brings its own post-list pane, which lives in the same slot as the
        // wiki and events panels - see main-page.component.html. Opening one closes those
        // two, exactly as openWiki closes the events panel. Ordinary channels don't, so
        // browsing text channels with the wiki panel open still works.
        if (channel.type === ChannelType.Thread) {
            this.wikiPanelGuildId.set(null);
            this.eventsPanelGuildId.set(null);
        }
        this.mainView.set({type: 'channel', channel});
        this.mobileNavOpen.set(false);
        this.saveNav();
    }
```

Import `ChannelType` in `navigation.service.ts` if it isn't already imported.

Note this keys on `Thread`, not on `forumParentOf`: `openChannel` has no channel list to resolve the parent against, and a non-forum thread closing those panels is harmless.

- [ ] **Step 4: Build**

Run: `./node_modules/.bin/ng build --configuration development`

- [ ] **Step 5: Manual verification**

Run `./node_modules/.bin/ng serve`. Confirm:
1. **Forum with no post open:** full-width list, Gallery layout still a real multi-column grid. Unchanged from before this branch.
2. **Open a post:** the list narrows to a left pane, the post fills the rest, and the pane shows **no loading spinner** — it shares state with the list you were just looking at. Clicking another post swaps the right pane and keeps the left.
3. **The open post's row is highlighted** in the pane, and the layout toggle is absent there.
4. **Narrow the window below `lg`:** the pane disappears, the post takes the screen, and the header's back arrow returns to the forum. Exactly as before.
5. **Open the wiki panel, then a forum post:** the wiki panel closes; only the post list pane shows. Open the wiki panel, then a plain text channel: the wiki panel stays, as it does today.

- [ ] **Step 6: Full suite, then commit**

Run: `./node_modules/.bin/ng test --watch=false`

```bash
git add src/app/features/main-page/
git commit -m "feat: keep the forum post list beside an open post"
```

---

## What this plan does not deliver

No change to how posts themselves render, and no general "master → detail" middle-pane abstraction — the pane is forum-specific by decision. Mobile is deliberately untouched. The household Lists module, which prompted this detour, follows in its own spec.
