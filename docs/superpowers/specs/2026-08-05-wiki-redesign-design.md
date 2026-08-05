# Wiki Redesign

**Date:** 2026-08-05
**Status:** Approved design, pending implementation plan

## Why

The wiki works but nobody enjoys using it. Three things are wrong, in descending order of how
much they hurt:

1. **It expands sideways.** `app-wiki-panel` injects a 224px third sidebar between the channel
   list and the main pane (`main-page.component.html:37`), and then every wiki view clamps its
   content to `max-w-3xl mx-auto`. On a wide window that reads as: server rail → channel list →
   wiki tree → a 768px article → a large dead gutter. Four columns before a word of text.
   Below the `lg` breakpoint the tree is `hidden lg:flex`, so it disappears entirely and takes
   all navigation with it.

2. **Editing is a mode swap with four bars of chrome.** `wikiView` flips to `'editor'` and
   replaces the whole view. Above the text sit a header, the title input, a meta row
   (category / parent / pinned / tags, which wraps), and a 20-button always-visible toolbar.
   Read view pads `py-8`, the editor pads `py-4`, so the article physically jumps when you press
   Edit. Markdown mode is a toggle that swaps the toolbar for a bare textarea.

3. **The wiki-shaped features are absent.** No search of any kind. No table of contents. No
   breadcrumbs, despite a parent/child page hierarchy being stored. No internal page links and no
   backlinks — in a wiki. No autosave, so navigating away mid-edit loses the work. History renders
   whole revisions instead of a diff. `authorId` and `lastEditorId` are in the DTO and never shown.
   The nine wiki permissions in `permissions.enum.ts:44-53` are defined and completely ignored —
   every member sees Edit and Delete.

## Scope

In scope: the client-side wiki feature end to end — layout, editor, search, linking, history,
attribution, permissions, i18n.

Out of scope: any server change. Two limitations below are called out as server asks rather than
worked around.

## Architecture

### Component tree

```
app-wiki (guildId)                      three-column grid, owns resize + collapse state
├── wiki-nav                            page/category tree           (was wiki-sidebar)
├── <main>
│   ├── wiki-breadcrumbs                slim sticky bar + actions
│   ├── wiki-home                       landing view
│   ├── wiki-article                    read AND edit, one TipTap instance
│   └── wiki-history                    revisions + diff
├── wiki-context-rail                   TOC, properties, backlinks, attribution
└── wiki-search-palette                 ⌘K overlay
```

Deleted: `wiki-panel/`. Its header collapses into the nav's own header.

### Supporting modules

Each is a single-purpose file with no Angular dependency unless noted, so each can be tested
directly:

| File | Responsibility |
|---|---|
| `wiki-toc.ts` | Heading extraction + stable slug ids from a ProseMirror doc |
| `wiki-links.ts` | `wiki:` href parse/format, backlink extraction, broken-link detection |
| `wiki-diff.ts` | Line-level LCS diff → `{type: 'add' \| 'del' \| 'ctx', text}[]` |
| `wiki-search.ts` | Scoring and ranking; pure functions over summaries + cached content |
| `wiki-drafts.service.ts` | localStorage draft read/write/clear (Angular, thin) |
| `wiki-content-cache.service.ts` | Session cache of page content; shared by search and backlinks |
| `editor/wiki-suggest.plugin.ts` | One ProseMirror plugin driving both `/` and `[[` triggers |
| `editor/wiki-extensions.ts` | The TipTap extension list, including link protocol config |

## Design

### 1. Layout

`app-wiki` becomes a CSS grid: `[nav] [article 1fr] [rail]`. The article clamps to `max-w-[68ch]`
**inside its own column** while the rail absorbs the surplus width — that is what removes the dead
gutter, rather than letting text run to an unreadable measure.

- Nav: 260px default, drag-resizable 200–420px, width persisted to
  `localStorage['wiki-nav-width']`. Collapsible to zero with a floating reveal button.
- Rail: 280px, hidden below `xl`. Its contents remain reachable: below that width the rail's
  sections (TOC, properties, backlinks, attribution) open as a popover from a single breadcrumb-bar
  button, rendering the same components. There is no second implementation of page properties.
- Below `lg`: nav becomes an overlay drawer opened from the breadcrumb bar. Navigation is never
  unreachable at any width, which is the current bug.

**Navigation service changes.** `wikiPanelGuildId` is removed along with `closeWikiPanel()`. The
restore path in `navigation.service.ts:97` keeps setting `mainView` to `wiki` for a
`server-wiki` snapshot, and drops the panel line at `:304`. The mutual exclusion between the wiki
panel and the events panel (`:186`, `:238`) is deleted — the wiki no longer competes for that slot,
so an events panel and a wiki main view can coexist. `navigation.service.spec.ts:126` ("moves the
wiki side panel with the entry it steps onto") is rewritten to assert `mainView` alone.

Note: another agent is working on the events panel concurrently. The events-panel lines in
`navigation.service.ts` are the likely conflict point and should be touched in a single small
commit, early, rather than bundled into a large one.

### 2. Read and edit are the same DOM

One `wiki-article` component holding one TipTap editor, with `setEditable()` toggled between modes.
Read mode is not a re-render through `marked` — it is the identical ProseMirror view, so there is
no layout shift left to fix. This is the mechanism, not a styling convention that can drift.

Two consequences follow and are deliberate:

- **The title moves into the document body** as the first editable line, styled as the page h1.
  It stays a separate DTO field; only its presentation moves. This lets the header shrink to a slim
  sticky bar holding breadcrumbs and actions, and removes the "title input" from the editor chrome.
- **Sanitisation shifts from DOMPurify to the TipTap schema.** The schema is a stricter whitelist
  than the `WIKI_PURIFY_CONFIG` allowlist: nodes and marks with no matching extension are dropped
  at parse time rather than filtered afterwards. The one gap a schema does not close is mark
  attributes, so `Link` is configured with an explicit protocol allowlist —
  `['http', 'https', 'mailto', 'wiki']` — closing `javascript:` hrefs. Verified: `LinkOptions`
  exposes `protocols` and `isAllowedUri` in the installed version.

`renderWikiMarkdown` (marked + DOMPurify) stays, used by the history revision preview. That path
renders arbitrary historical content in a compact preview where spinning up an editor is not worth
it.

### 3. Editor chrome appears only when asked for

The always-visible toolbar is deleted. Replaced by:

- **Bubble menu** on a non-empty text selection: bold, italic, underline, strike, inline code,
  link, H1–H3, quote. Positioned from `editor.view.coordsAtPos`.
- **Slash menu** on `/` in an empty paragraph: headings, bullet/numbered/task list, quote, code
  block, divider, table, image, page link. Arrow keys navigate, Enter selects, Esc closes.
- Markdown input rules (`##`, `-`, ` ``` `) already work today and stay.

Both are driven by one ProseMirror plugin that watches for a trigger character and emits
`{trigger, query, coords}`; the Angular components render from that signal. **No new dependencies** —
`@tiptap/pm` is already installed, while `@tiptap/suggestion` and `extension-bubble-menu` are not.
Writing the plugin directly also lets the menus render as Angular components rather than detached
DOM, which is what keeps them themeable with the rest of the app.

The markdown-source toggle is kept — it is genuinely useful — but moves into the overflow menu
rather than sitting in the primary chrome.

Category, parent, tags and pinned move out of the wrapping meta row into the right rail as page
properties, editable in both modes.

### 4. Internal links

`[[` opens a page picker. A selection inserts an ordinary **`Link` mark with a `wiki:<pageId>`
href** — not a custom node. This matters: the existing markdown serializer already round-trips link
marks, so `[Setup](wiki:abc123)` survives save/load with no custom `parseMarkdown`/`renderMarkdown`
implementation, and degrades to readable text anywhere the content is viewed outside the app.

- Clicks on `wiki:` hrefs are intercepted and routed in-app instead of opening a URL.
- A `pageId` absent from `wiki.pages` renders in the danger colour as a broken link.
- Backlinks are a regex sweep for `](wiki:...)` over cached page content.

### 5. Search and backlinks share one content cache

`getWiki` returns summaries without content by default, so search works in two tiers:

- **Tier 1 — titles and tags, zero requests.** Scored prefix > substring > subsequence over
  `wiki.pages`. Instant, always available, and covers the common case of "take me to that page".
- **Tier 2 — content.** `wiki-content-cache.service` fills opportunistically as pages are opened,
  and warms fully the first time something needs complete coverage: a content search, or the
  backlinks panel becoming visible. Not on wiki load. Entries are invalidated by the
  `wikiPageUpdated` / `wikiPageDeleted` websocket events already subscribed in
  `wiki-state.service.ts:27`.

The warm is **one request**, not N: the server now accepts
`GET /api/v1/guilds/{guildId}/wiki?includeContent=true`, returning each page's body alongside its
summary. See "Server changes" below.

### 6. Edit safety

**Drafts.** Debounced 800ms to `localStorage['wiki-draft:<guildId>:<pageId|new>']`, storing
`{title, content, categoryId, parentPageId, tags, isPinned, baseUpdatedAt, savedAt}`. Opening a page
whose draft diverges from server content shows an unobtrusive bar: *Unsaved changes from 3m ago —
Restore / Discard*. Cleared on successful save or explicit discard.

Publishing stays **explicit** (⌘S, or the Save action). Autosaving to the server would mint a
revision per keystroke, which is wrong for a wiki — the revision list is a curated history, not a
keylog. The status pill reflects this honestly: `Draft saved` → `Saving…` → `Saved`.

**Shortcuts.** ⌘S saves, Esc exits edit mode (prompting if dirty), ⌘K opens search, `e` enters edit
mode from read view.

**Diff.** `wiki-diff.ts` implements a line-level LCS — O(n·m) DP, which is ample for page-sized
input and avoids a dependency. History shows a revision selected against either its predecessor or
current, and Restore confirms by *showing the diff* rather than asking blind.

**Edit summary.** An optional "What changed?" field offered on save, stored on the revision that
save creates. `WikiRevision` has carried a `Summary` since the feature shipped and nothing could
ever set it, which is why the History view shows "No summary" against every revision in every
wiki. The server accepts it as of the change below. It is ignored when the content is unchanged,
because there is then no revision to attach it to — so the field is only offered when the body has
actually been edited.

### 7. Attribution and permissions

**Attribution.** Guild members fetched once per wiki session via `getMembers(guildId, 0, 200)` into
an id→member map; author and last editor render in the rail with the existing `app-avatar`. If the
fetch fails or a member is missing, the attribution row is omitted rather than showing a raw id.

**Permissions.** From `getOwnMember(guildId)` through `effectiveGuildPermissions`, gating on enum
values that already exist:

| Action | Permission |
|---|---|
| New page | `CreateWikiPages` |
| Edit | `EditAnyWikiPage`, or `EditOwnWikiPages` when `authorId` is self |
| Delete | `DeleteWikiPages` |
| Categories, drag-reorder | `ManageWikiStructure` |
| Restore revision | `ManageWikiRevisions` |

`Superadmin` satisfies all. Following the convention documented on `memberCanManageGuild`, a
not-yet-loaded member **fails closed** — a control is never briefly offered to someone who turns out
not to hold the permission. The permission signal is cleared before each fetch so a previous guild's
answer cannot leak across a switch (the same bug already guarded against at
`main-page.component.ts:250`).

### 8. i18n

`wiki-editor.component.ts` and `wiki-sidebar.component.ts` already import `TranslateModule` and use
zero translate pipes; every string is hardcoded English. All user-facing strings move to keys under
`WIKI.*`. Per project convention, locales are a git submodule and the strings land in a separate
commit from the code that references them.

### 9. Server changes

Both of the API gaps this design originally worked around are closed. Implemented in the Echo
repository (`C:\Users\Domin\RiderProjects\Echo`), commit `7ae3a50`, all in
`Guild.Application/Endpoints/WikiEndpoint.cs` and its DTOs, covered by seven new tests in
`Guild.Tests/Endpoints/WikiEndpointTests.cs`:

1. **`UpdateWikiPageDto.Summary`** — passed to the `WikiRevision` the update creates. Trimmed;
   blank becomes null. Ignored when the content is unchanged.
2. **`GET .../wiki?includeContent=true`** — populates `WikiPageSummaryDto.Content`, which is null
   on the default listing. Turns the content warm from N requests into one.
3. **Revision counts via a grouped count**, replacing `Include(p => p.Revisions)`. The Include
   materialised every revision of every page — each carrying a full copy of the page body at that
   point in time — purely to read `Count` on the loaded collection. A wiki with 50 pages and 10
   revisions each pulled 500 page-sized rows to produce 50 integers, on every wiki load, growing
   with edit history rather than with wiki size. This was pre-existing, not introduced here, but
   adding content to the same response without fixing it would have compounded it.

The client DTOs mirror this: `UpdateWikiPageDto` gains `summary?: string`,
`WikiPageSummaryDto` gains `content?: string`, and `WikiService.getWiki` takes an
`includeContent` flag.

## Data flow

```
WikiStateService  ─ owns wiki summaries, current view, selected page, websocket sync
   │
   ├─ WikiContentCache ─ pageId → content, warmed lazily, invalidated by WS events
   │     ├─→ search tier 2
   │     └─→ backlinks
   ├─ WikiDraftsService ─ localStorage, independent of server state
   └─ WikiPermissions   ─ own member → effective permissions, per guild
```

`WikiStateService` keeps its existing role and websocket subscriptions. The new services hang off
it rather than replacing it, so the concurrency handling already built (`suppressNextPageRefresh`,
`pendingRemoteUpdate`) is preserved intact.

## Error handling

- **Content warm fails:** it is one request, so it fails whole rather than partially. Search falls
  back to titles and tags with the reason stated and a retry offered; backlinks show "couldn't
  load". Silently returning title-only results while looking like a full-text search would be a
  lie about coverage.
- **Draft restore conflicts with a remote edit:** the existing `pendingRemoteUpdate` banner takes
  precedence; the draft bar is suppressed until the conflict is resolved, so two competing "your
  content is stale" messages can never stack.
- **Member/permission fetch fails:** fails closed, controls hidden. Preferred over showing an Edit
  button that will 403.
- **Broken `wiki:` link clicked:** inline toast, no navigation. The link stays visibly broken.
- **localStorage full or unavailable:** drafts degrade to off silently; the status pill omits the
  draft state rather than claiming a save that did not happen.

## Testing

Unit tests, on the pure modules where the logic actually lives:

- `wiki-diff.ts` — insertions, deletions, moves, identical input, empty on either side.
- `wiki-links.ts` — round-trip of `wiki:` hrefs through markdown, backlink extraction, broken-link
  detection, ids that look like URLs.
- `wiki-toc.ts` — slug stability, duplicate heading text, headings containing marks.
- `wiki-search.ts` — ranking order across prefix/substring/subsequence, tie-breaks, empty query.
- `wiki-drafts.service.ts` — write/read/clear, divergence detection, unavailable localStorage.
- `navigation.service.spec.ts` — rewritten wiki assertions.

Component behaviour verified in the running app: no layout shift between read and edit, nav
reachable at every width, permission gating with a low-permission member.

## Risks

- **Large diff in a shared tree.** Landing as several reviewable commits, with the
  `navigation.service.ts` change going first and small to minimise conflict with concurrent
  events-panel work.
- **TipTap as the read renderer** is the load-bearing change. If parity or performance disappoints,
  the fallback is rendering read mode through `renderWikiMarkdown` into an identically-padded
  container — this preserves no-jump but loses guaranteed WYSIWYG parity.
- **Drag-and-drop nesting** in the current sidebar (`nest-blink`, the 850ms nest timer, cycle
  detection in `wouldCreateCycle`) is being re-homed, not rewritten. Its behaviour must survive the
  move.
