# Scene folder tree

Folders stop being an archive-only filing cabinet and become the way a guild organises its scenes,
on both the playing screen and the archive. Extends `2026-08-20-scene-archive-design.md`.

## What changes

1. A scene can be filed from the moment it is created, not only once it has ended.
2. The rail renders as a real tree: collapsible shelves, scene rows nested under their folder.
3. The playing screen can show the same rail, and groups the board by folder when it does.
4. Right-clicking a folder offers **New scene here**.

## Decisions

| Question | Answer |
|---|---|
| Scenes in the tree | Leaf rows under their folder |
| Which scenes | All of them, running and finished |
| Depth | Two levels, as the server already caps it |
| Rail treatment | Shelves: root folders are coloured uppercase headers |
| Shelf default | Closed on first visit, then remembered per guild |
| Playing screen | Toggleable rail, remembered |
| Board grouping with the rail on | Your move pinned, folder sections below |
| Recent block | Waiting on you first, then most recently active |

## Architecture

### The rail is one component with two hosts

`SceneFolderRailComponent` keeps its name and gains scene leaves. It owns no data: both hosts hand
it a tree, a map of leaves per folder, and a recent list. That is what lets the board and the
archive show the same rail over completely different queries.

```
                      SceneFolderRailComponent
                      tree, scenesByFolder, recent
                       ▲                      ▲
        board leaves   │                      │   archive leaves
   SceneService.scenes()                 SceneArchiveService.peek()
   in memory, live only                  paged, per folder, lazy
```

The board already holds the guild's whole live board in memory, so its leaves and counts are a
computation with no request. The archive is a paged history, so a shelf reads its own scenes when
it is first opened.

### New module: `scene-leaf.ts`

Sits beside `scene-status.ts`, which already owns `isWaitingOnMe` and `compareScenes`.

```ts
export interface SceneLeaf {
    channelId: string;
    name: string;
    status: SceneStatus;
    mine: boolean;
}

export function sceneLeaf(scene: SceneListItemDto, speakable: ReadonlySet<string>): SceneLeaf;
export function leavesByFolder(scenes, speakable): Record<string, SceneLeaf[]>;
export function recentScenes(scenes, speakable, now, limit): SceneLeaf[];
```

`recentScenes` sorts waiting-on-you first, then by `updatedAt` descending, and caps at 5.

### Archive: the query stops meaning "finished"

`SceneArchiveService.params()` drops the hardcoded `archivedOnly: true`. `ArchiveFilter` gains
`status: ArchiveStatus`, a new `'all' | 'running' | 'finished'` union exported beside it. It is part
of `archiveKey` and defaults to `all`:

| status | params |
|---|---|
| `all` | `includeConcluded: true, includeArchived: true` |
| `running` | neither flag |
| `finished` | `archivedOnly: true` |

The filter bar gains a three-way control for it. `SCENE.ARCHIVE.EMPTY_BODY` ("Scenes land here when
they end") is now wrong and gets rewritten.

### Archive: reading a shelf without selecting it

Two additions to `SceneArchiveService`, deliberately sharing the existing cache:

```ts
peek(guildId: string, folderId: string | null, status: ArchiveStatus): void
peeked(guildId: string, folderId: string | null, status: ArchiveStatus): readonly SceneListItemDto[]
```

Both build an `ArchiveFilter` with no tags and no query, so an opened shelf and an unfiltered
selection of the same folder are one cache entry and one request. `apply()` is untouched: it still
means "this is the selection".

A shelf shows at most 12 leaves and then a row that selects the folder. A shelf is not a list.

### Rail component surface

```ts
readonly tree = input.required<FolderNode[]>();
readonly scenesByFolder = input<Readonly<Record<string, readonly SceneLeaf[]>>>({});
readonly recent = input<readonly SceneLeaf[]>([]);
readonly loadingFolderIds = input<readonly string[]>([]);
readonly expandedIds = input<readonly string[]>([]);
readonly selected = input<string | null>(null);
readonly canManage = input(false);

readonly toggled = output<string>();          // a shelf was opened or closed
readonly openScene = output<string>();        // a leaf was clicked: channel id
readonly createScene = output<string | null>(); // "New scene here"
readonly showAll = output<string>();          // a shelf hit its leaf cap
// picked, createFolder, renameFolder, deleteFolder, reordered, filed: unchanged
```

The template's two hardcoded levels become one recursive `ng-template` carrying a depth. Two levels
render through one code path, and a third would need no template change if the server ever allows one.

Counts render only where they are known. The board knows them exactly, via the `countByFolder` and
`folderTree` helpers that already exist. The archive knows a shelf's count once that shelf has been
read, and shows nothing before. The `TODO(dominic)` about shelf counts stays, narrowed to the archive.

### Expansion and rail visibility: `SceneRailStateService`

New service, one `localStorage` key, signal backed:

```ts
expanded(guildId): readonly string[]
toggle(guildId, folderId): void
railVisible(guildId): boolean
setRailVisible(guildId, visible): void
```

Closed on first visit. Check how the other services scope `localStorage` under multi-account before
picking the key shape.

### Board: your move pinned, folders below

`SceneBoardComponent.groups()` becomes conditional. With the rail hidden, or when the guild has no
folders, it returns exactly what it returns today. With the rail shown it returns:

1. **Your move** (unchanged)
2. **Stalled**, when the caller manages scenes (unchanged, pinned for the same reason)
3. One section per folder, in tree order, sorted inside by `compareScenes`
4. **Unfiled**

A scene in the first two sections is not repeated in its folder section, and the section count
reflects that. Each pinned row names its folder path, so pinning does not cost you the context.

Selecting a folder in the rail filters the board to that folder and everything under it.

### Creating a scene into a folder

`CreateSceneDto` carries no `folderId`, so this is create then file:

```
create(guildId, home, dto) ─▶ switchMap ─▶ update(guildId, channelId, {folderId})
```

The second call failing must not read as a failed create. The scene exists; it is only unfiled. That
gets its own toast and its own comment.

`SceneDialogComponent` gains `seedFolderId = input<string | null>(null)` and shows the target
folder with a picker, so the GM can change their mind before saving. The picker is extracted out of
`scene-detail-sheet.component.html`, where it already exists as a searchable popover, into
`scene-folder-picker.component.ts`. Both hosts use it. Nothing gets a second implementation.

The archive does not own the dialog. It emits `createSceneIn(folderId)` and the board, which already
holds `SceneDialogComponent` and `textChannels()`, opens it.

## Menu

**New scene here** goes to the top of the folder context menu, above the folder actions, separated
from them. Gated on `ManageScenes` like every other item on it.

## Testing

`SceneFolderRailComponent` has no spec and its reorder maths is the risky part of this work, so
characterization tests come first and go green against the current component before the template
is touched.

| File | Covers |
|---|---|
| `scene-folder-rail.component.spec.ts` (new) | first: `flatten`, `nudge`, `siblingsOf` as they behave today. then: expansion, leaf clicks, `createScene` |
| `scene-leaf.spec.ts` (new) | recency ordering, the waiting-first rule, the cap, folder grouping |
| `scene-archive.service.spec.ts` | the status to params mapping, `peek` sharing a cache entry with `apply` |
| `folder-tree.spec.ts` | already covers count rollup; extend only if the recursive render needs it |
| `scene-dialog.component.spec.ts` (new) | create then file, and that a failed file still reports a created scene |

## Not doing

- Deeper than two levels. The server caps it, so it is a two-repo change.
- Server-side folder counts. The existing TODO already names this.
- A per-user "last visited" signal. Recent is derived from what the wire already carries.
- Moving folders between parents by drag. The editor's parent field still owns re-parenting.

## Risks

**The board's grouping is its whole point.** Folder sections push "is a game waiting on me" down the
page. Pinning your move and stalled above the folders is what keeps that answer first, and the rail
stays off by default so nobody gets the new grouping without asking for it.

**A shelf is not a list.** Twelve leaves and then a link. Without the cap one arc of a long campaign
turns the rail into the results pane.

**`archivedOnly` going away widens every archive query.** The status filter has to be in
`archiveKey`, or a cached page read under one status renders under another.
