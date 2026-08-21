# Scene archive

Design for a structured archive of finished scenes: an Archive mode on the scene board, guild-owned
folders, a curated tag vocabulary, a detail sheet, and reading a concluded scene from its first post.

Comes from roleplay feedback: "a more structured archival feature would be greatly appreciated, a lot
of rpers like to go back and read through their old chats", asking for tags and folders. The reporter
also meant something narrower and more urgent, which Phase 0 covers.

Spans two repos. Guild and Messaging work is `RiderProjects\Echo`; everything from section C down is
this client. The backend half needs mirroring into `Echo/docs/specs` as a frontend guide once the
wire shapes are real.

## What ships

1. Concluded scenes stop disappearing on reload.
2. A `Playing | Archive` switch in the scene board header.
3. `SceneFolder`: guild-owned, nested two deep, a scene has at most one.
4. `SceneTag`: a curated guild vocabulary, applied by any member, `ForumTag` in every respect but scope.
5. A detail sheet per archived scene, with cast, figures, dates, conclusion note, tags and folder.
6. Read from the start: open a concluded scene anchored at its first message and read forward.

## Decisions taken

| Question                | Answer                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the archive lives | A mode on the scene board, not a new guild view. One route, one mental model.                                                                         |
| What a folder is        | New `SceneFolder` entity mirroring `WikiCategory`, plus icon and colour. Not channel categories: arc structure and channel layout are different jobs. |
| Folder depth            | Two. Deeper needs a rail with its own scrollbar, which is where this stops being a rail.                                                              |
| A scene's folders       | At most one. Tags carry every cross-cutting case.                                                                                                     |
| What a tag is           | New `SceneTag` entity mirroring `ForumTag`, scoped to the guild rather than to a channel.                                                             |
| Who creates tags        | `ManageScenes`. Who applies them: any member who can see the scene, unless the tag is `Moderated`.                                                    |
| Who files a scene       | `ManageScenes`. Structure is the GM's, description is everyone's. Assumption, not a stated requirement.                                               |
| What Archive lists      | Concluded scenes and channel-archived scenes. Folders and tags apply at any status, so a running arc can already be filed.                            |
| Reading                 | A detail sheet plus read-from-start. Full chronicle rendering and export stay reserved for roleplay-guilds.md section 7.                              |
| Searching               | Scene name only. Message search inside scenes is section 7's boundary and excludes MLS channels.                                                      |

## Phase 0, the reported bug, ships alone

`roleplay-api.service.ts:62` calls `GET /guilds/{id}/scenes` with no query params. The server defaults
`includeConcluded = false` and `includeArchived = false` (`SceneEndpoint.cs:161`) and filters on both
(`:265-266`). `sceneConcludedObservable` patches the row in place rather than dropping it
(`scene.service.ts:83`), so a scene concluded in front of you stays on the board until reload and is
gone after. `SCENE.BOARD.ENDED` in `scene-board.component.ts:151` can never populate from a cold load.

Phase 0 is `listScenes(guildId, params)` plus the header switch. It closes the complaint on its own
and does not depend on anything below.

## A. Guild: data model

```
SceneFolder                          // scfd_
    GuildId, Name, Position
    ParentFolderId?                  // depth 2, a grandchild is rejected by the validator
    Icon?, Color?

SceneTag                             // sctg_
    GuildId, Name, Color, Position, Moderated
    EmojiId? | EmojiName?            // mutually exclusive, ForumTag.Update's rule copied

SceneTagAssignment                   // composite PK (SceneChannelId, TagId), cascade both sides
    SceneChannelId, TagId, CreatedAt

SceneState
    + FolderId?                      // FK SetNull. Deleting a folder never deletes a scene.
    + ConcludedAt?
```

`ConcludedAt` is new because `SceneState` carries only `UpdatedAt`, and a later edit to a concluded
scene's note moves it. Rows concluded before the migration hold null and the client falls back to
`UpdatedAt` for the end date.

Indexes: `SceneFolder(GuildId, Position)`, `SceneState(GuildId, FolderId)`, `SceneTagAssignment(TagId)`.

Caps: 40 tags per guild, 5 per scene (`ForumPostTag.MaxTagsPerPost`), tag name 20
(`ForumTag.MaxNameLength`), folder name 32, folder depth 2.

Migration adds two tables, two columns and three indexes. No enum changes.

## A2. Guild: the list query

`BuildListQuery` stays extracted, because the translation harness on it is what proves the new
predicates compile to SQL rather than to a client-side evaluation EF InMemory would not catch.

New parameters on `GET /guilds/{guildId}/scenes`:

| Parameter  | Meaning                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `folderId` | One folder. `unfiled` is a reserved value meaning `FolderId == null`.                                                    |
| `tagIds`   | Comma separated, AND. A scene must carry all of them.                                                                    |
| `q`        | Case-insensitive contains on the channel name. Never message content.                                                    |
| `sort`     | `board` (default: unchanged, clocked scenes first by soonest deadline, then by `UpdatedAt` descending), `name`, `ended`. |
| `offset`   | Archive paging. The live board never sends it.                                                                           |

`sort=ended` orders by `ConcludedAt` descending with `UpdatedAt` as the fallback for pre-migration
rows. The projection gains `FolderId`, `ConcludedAt` and `CreatedAt`.

Tag ids for a page come from one batched query keyed on the page's channel ids, in the shape the
existing `cast.ResolveAsync` call already uses. Not a join: a join against `SceneTagAssignment`
multiplies rows and breaks `Take(take + 1)`, which is how `truncated` is computed.

## A3. Guild: routes

Conventions from `ForumTagEndpoint`, the `PersonaGate` three-check order, gated on
`GuildFeatures.Scenes`.

| Verb   | Route                                                   | Permission                                                      |
| ------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/v1/guilds/{guildId}/scene-folders`                | membership                                                      |
| POST   | `/api/v1/guilds/{guildId}/scene-folders`                | `ManageScenes`                                                  |
| PATCH  | `/api/v1/scene-folders/{folderId}`                      | `ManageScenes`                                                  |
| DELETE | `/api/v1/scene-folders/{folderId}`                      | `ManageScenes`                                                  |
| PATCH  | `/api/v1/guilds/{guildId}/scene-folders/reorder`        | `ManageScenes`                                                  |
| GET    | `/api/v1/guilds/{guildId}/scene-tags`                   | membership                                                      |
| POST   | `/api/v1/guilds/{guildId}/scene-tags`                   | `ManageScenes`                                                  |
| PATCH  | `/api/v1/scene-tags/{tagId}`                            | `ManageScenes`                                                  |
| DELETE | `/api/v1/scene-tags/{tagId}`                            | `ManageScenes`                                                  |
| PUT    | `/api/v1/guilds/{guildId}/scenes/{sceneChannelId}/tags` | `ViewChannel`, refused when any tag in the delta is `Moderated` |

Filing rides the existing scene PATCH: `UpdateSceneDto.folderId`, under `ManageScenes`. Sending null
unfiles.

Deleting a folder reparents its children to root and unfiles its scenes.

Refusals answer `{error, message}` in the shape section 5.2 already uses. New codes:
`scene_folder_depth_exceeded`, `scene_folder_not_found`, `scene_folder_cycle`, `scene_tag_limit`,
`scene_tag_moderated`, `scene_tag_name_taken`.

## A4. Guild: realtime

One event, `guild.SceneTaxonomyChanged`, carrying the guild's whole folder and tag set. Both are
bounded and small, and a full replace has no rename, reorder or delete edge case to get wrong. Six
granular events would each need their own ordering story for no benefit at this size.

A scene's own filing rides `guild.SceneUpdated`, which gains `folderId` and `tagIds`.

No new `ModulePermissions` bit.

## B. Messaging: an anchorless oldest page

`GET /api/v1/messaging/channels/{channelId}/messages` already accepts `before`, `after` and `around`
(`MessagingController.cs:100`), backed by `GetMessagePageByCursorAsync` on both the Scylla and EF Core
repositories. The client has never sent any of them.

Every cursor form needs a real anchor that exists in the context: both implementations resolve the
anchor first and return empty when it is missing (`EfCoreMessageRepository.cs:110-112`,
`ScyllaMessageRepository.cs:104-105`). So there is no way to ask for the beginning of a channel
today, and read-from-start has nothing to anchor on.

Addition: `MessagePageQuery` accepts a null `AnchorMessageId` when `Direction == After`, meaning the
oldest page. In EF Core that is `RelativePageAsync` without the filter predicate, ordered ascending.
In Scylla it is a forward read from the partition's first clustering position. The controller maps a
new `oldest=true` query parameter onto it. Both paths keep the existing ordinal ordering rule at
`EfCoreMessageRepository.cs:128-134`, which exists so a client paging one backend and then the other
never sees two orders.

That is a smaller change than deriving an offset from `SceneState.PostCount`, which counts scene posts
and drifts from the channel's message count.

There is no anchor to use instead. `SceneEndpoint.cs:79` builds the scene channel with
`CreateChannelParams` carrying no `StarterMessageId`, unlike a thread started from a message, so a
scene has no known first message id until somebody posts one.

## C. Client: wire additions

| File                                  | Addition                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dtos/response/scene.dto.ts`          | `SceneFolderDto`, `SceneTagDto`, `SceneTaxonomyDto`; `folderId`, `tagIds`, `concludedAt`, `createdAt` on `SceneListItemDto`; `folderId` and `tagIds` on `SceneDto` and `SceneUpdatedDto` |
| `dtos/request/scene.dto.ts`           | `folderId` on `UpdateSceneDto`; `CreateSceneFolderDto`, `UpdateSceneFolderDto`, `CreateSceneTagDto`, `UpdateSceneTagDto`, `SetSceneTagsDto`; `SceneListParams`                           |
| `services/roleplay-api.service.ts`    | `listScenes(guildId, params)`; folder and tag CRUD; `setSceneTags`                                                                                                                       |
| `services/scene-taxonomy.service.ts`  | New. Folders and tags per guild in the `ensureGuild` shape                                                                                                                               |
| `services/guild-websocket.service.ts` | `WsSceneTaxonomyChanged`, `sceneTaxonomyChangedObservable`, `guild.SceneTaxonomyChanged`                                                                                                 |
| `services/messaging.service.ts`       | `before`, `after`, `around`, `oldest` on `getMessagesForChannel`                                                                                                                         |

`concludedAt` and `createdAt` move out of the local-only block at the bottom of `SceneDto`, since the
server starts sending both.

## D. Client: the archive surface

New `features/guild/scenes/scene-archive/`:

| Component                         | Job                                            |
| --------------------------------- | ---------------------------------------------- |
| `scene-archive.component`         | The mode: rail, tag row, card list, paging     |
| `scene-folder-rail.component`     | ALL, the folder tree, Unfiled, with counts     |
| `scene-archive-card.component`    | One finished scene                             |
| `scene-detail-sheet.component`    | The right-side sheet                           |
| `scene-taxonomy-editor.component` | Folder and tag management, `ManageScenes` only |

The archive is a sibling of `scene-board`, not a mode inside it. The board's grouping computed at
`scene-board.component.ts:122` is the live "is it my move" answer and is not asked to also be an
archive query.

`forum-tag-chip.component.ts` already handles the `#000000` means no colour rule, sizes, selected and
removable states, and guild emoji. Its input widens from the `ForumTag` DTO to a structural
`{name, color, emojiName?, emojiId?}` and it moves to a shared location. Rebuilding it is exactly the
duplication CLAUDE.md forbids. `forum-tag-picker.component.ts` gets the same treatment for the
apply-tags popover.

`scene.service.ts` keeps `byGuild` for the board and gains a second cache keyed by archive filter, so
archive paging never disturbs the live board's rows.

UX rules:

- The rail always shows ALL and Unfiled with counts, folders in `Position` order, two levels, and never
  a scrollbar of its own.
- The tag row is wrapping chips. Click to filter, multi-select ANDs, and a clear-all appears only once
  a filter is on.
- Filing is drag a card onto a folder, plus a right-click menu doing the same thing. Drag alone is not
  reachable from a keyboard, and the message context menu is the pattern to copy.
- A card is quieter than a live board row: no `turn-clock-ring`, the existing `board-ended-mark` glyph,
  and `sceneTally` for the figures line.
- The detail sheet is a right-side sheet, not a modal, so browsing survives opening one.
- The empty archive gets the same invitation the board's empty state already has, not a shrug.

## E. Client: read from the start

The heaviest part, and the only one with no existing pattern to copy.

Today `channel-conversation.jumpToMessage` (`:652`) only scrolls to a node already in the DOM, and
`message.store.loadMoreForChannel` (`:664`) grows one window backwards from the newest message using
an offset. `ConversationMeta` is `{offset, hasMore, loadingMore}`: one edge, one direction.

Reading forward from the beginning needs a window with two edges.

1. `ConversationMeta` gains `hasNewer` and an `anchored` flag. A window is anchored when it was seeded
   by a cursor rather than by the newest page. `offset` stays meaningful only for unanchored windows.
2. `loadChannelOldest(channelId)` seeds an anchored window from `oldest=true`. `loadNewerForChannel`
   pages forward with `after=<last id>`.
3. A realtime append must not be spliced into an anchored window. It is stored, but the window's
   `hasNewer` is what decides whether it is visible. Getting this wrong puts turn 47 in the middle of
   turn 3.
4. `channel-conversation` gains a scroll-down handler mirroring the existing `LOAD_MORE_THRESHOLD`
   block at `:645`. `jumpToPresent` (`:719`) already exists and becomes the escape hatch, and must
   drop the anchored window rather than scroll within it.
5. Leaving the channel clears the anchored window, so the next ordinary open is unanchored.

This touches the app's hottest path. `message-store-cache.spec.ts`, `message-store-update.spec.ts` and
`channel-conversation.component.spec.ts` exist; the anchored-window work starts by extending them to
pin the current single-edge behaviour before anything moves, per the characterization rule in
CLAUDE.md.

The offline cache (`messageCache.recall`) and the MLS decrypt step both sit in this path and are
unchanged, but an anchored window must not be seeded from cache: the cache holds the newest messages,
which is the opposite end.

## F. i18n

New `SCENE.ARCHIVE.*` keys for the mode switch, rail labels, empty states, the detail sheet, folder and
tag management, and the new refusal codes. `src/assets/i18n/locales` is a submodule, so they need their
own commit there first.

## G. Tests

| Area            | Test                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Guild domain    | Folder depth rejection, cycle rejection, tag caps, `Moderated` refusal                                |
| Guild query     | The new predicates through the existing `BuildListQuery` translation harness                          |
| Guild endpoints | Folder delete reparents and unfiles rather than cascading; `PUT tags` permission split                |
| Messaging       | Anchorless oldest page on both repositories, same order from each                                     |
| Client          | Archive filter composition, rail counts, unfiled bucket, tag AND semantics                            |
| Client          | Anchored window: seeded from oldest, pages forward, ignores a live append, cleared by jump-to-present |

## Not in scope

- Chronicle export to Markdown, EPUB or PDF. Reserved by roleplay-guilds.md section 7.
- Prose reading view with OOC stripped and grouping by persona. Same section.
- Message search inside scenes. Section 7's stated boundary, and MLS channels have no plaintext index.
- Per-user private folders. The archive is a shared artifact of the guild.
- A `CharacterSheets` or archive-specific `GuildFeatures` bit. `Scenes` covers it.

## Changed while building

Five things landed differently from the design above. Each is a deviation from what was approved,
kept because the repo already had a better answer.

- **One taxonomy read, not two.** `GET /guilds/{id}/scene-taxonomy` returns folders and tags
  together. They are always read together and `guild.SceneTaxonomyChanged` replaces both at once, so
  two routes only bought a second round trip.
- **`Optional<string>` for filing, not an empty-string sentinel.** `Guild.Application/Dtos/Optional`
  already exists for exactly the omit-versus-null distinction, and `UpdateSceneDto` already used it
  for `TurnDeadlineAt`. Unfiling is `{"folderId": null}`; omitting the key leaves it alone.
- **`archivedOnly` was missing from the design.** Archive mode needs concluded or channel-archived
  scenes and nothing else, and filtering that after the page is cut under-fills pages
  non-deterministically. It is a predicate on the query.
- **The archive got its own service.** `scene.service.ts` was already 448 lines, and a guild's live
  board and a filtered archive query are different questions, so `SceneArchiveService` holds the
  filter-keyed cache rather than growing the board's.
- **The window edge is a timestamp, not a set of ids.** Messages live in one flat entity map that
  every view filters, so an anchored window bounds what it draws with `windowEndAt`/`windowEndId` in
  the server's own `(created_at, id)` order. A live message is still stored, just not drawn.

## Unverified

- Whether `guild.SceneTaxonomyChanged` as a full-set replace is acceptable to the realtime fan-out at
  40 tags plus folders. It should be, at roughly the size of a channel list, but it has not been measured.
- The Scylla forward read from a partition's first clustering position is described from the EF Core
  twin and the comments in `ScyllaMessageRepository`, not from running it. Its parity tests need
  `ECHO_TEST_SCYLLA` and `ECHO_TEST_POSTGRES` set, and were among the skips locally.
- Nothing here has run against a live server. Both halves of each wire shape were written from this
  design rather than observed talking to each other.
