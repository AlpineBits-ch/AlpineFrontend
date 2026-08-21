# Scene Folder Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn scene folders from an archive-only filing cabinet into the way a guild organises every scene, running or finished, on both the playing screen and the archive.

**Architecture:** One rail component owning no data, fed by two hosts: the board computes leaves from the guild scenes it already holds in memory, the archive reads a shelf lazily through the existing paged cache. Pure helpers (`scene-leaf.ts`) and a small persistence service sit under both.

**Tech Stack:** Angular 21 signals, standalone components, PrimeNG `ContextMenu`, ngx-translate, Vitest through the Angular CLI.

**Spec:** `docs/superpowers/specs/2026-08-20-scene-folder-tree-design.md`

## Global Constraints

- Write like a person. No essays, no narrative rationale, no restating the code. Comments only for a silently-violated invariant, a `TODO(owner)`, or naming a non-obvious symbol.
- No em dashes (`—`) anywhere: code, comments, UI copy, commit messages.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports: `import {Component, inject} from '@angular/core';`
- `inject()` never constructor params. `input()` / `output()` / `model()` never decorators. `ChangeDetectionStrategy.OnPush` on every new component. Standalone, no NgModules. `@if` / `@for` / `@switch`, never structural directives.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field. Use a getter.
- Tests: `bun run test`. Single spec: `bun run ng test --watch=false --include="**/name.spec.ts"`. Lint: `bun run lint`. Never bare `vitest`, never `npx ng`.
- `bun run format` rewrites the whole repo. Format only the files you touched: `bun run prettier --write <paths>`.
- Baseline is green. Do not reduce the passing count.
- Commits: conventional prefix, one line, lowercase, imperative. No body unless it carries what the diff cannot. No co-author trailers, no emoji.
- Push straight to `main`. Never `git stash`, `git checkout --`, or `git reset --hard`: the working tree holds live in-progress work.

## Dependency Order

```
Wave A (independent, run in parallel):  T1  T2  T3  T4  T5  T7
Wave B (needs T1 T2 T3 T5):             T6
Wave C (needs T6):                      T8, then T10;  T9 needs T7
```

- **T1** i18n keys, **T2** `scene-leaf.ts`, **T3** `SceneRailStateService`, **T4** `SceneArchiveService`, **T5** rail characterization tests, **T7** folder picker extraction: touch disjoint files.
- **T6** rewrites the rail and needs T1's keys, T2's leaf model, T3's state service, and T5's tests green first.
- **T8** (archive) then **T10** (board, consumes the archive's new output). **T9** (dialog) needs T7's picker.

---

### Task 1: Translation keys

**Files:**

- Modify: `src/assets/i18n/locales/en.json`
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`

**Interfaces:**

- Consumes: nothing.
- Produces: the keys every later UI task renders. Exact key names below; do not invent variants.

`src/assets/i18n/locales` is a git submodule. Its changes need their own commit inside it, then the parent repo records the new pointer.

- [ ] **Step 1: Confirm the submodule is on a branch, not detached**

```bash
cd src/assets/i18n/locales && git status --short --branch | head -1
```

If it prints `## HEAD (no branch)`, run `git checkout main` before editing. Nothing else in this task works from a detached HEAD.

- [ ] **Step 2: Add the new keys to `en.json`**

Insert beside the existing `SCENE.ARCHIVE.*` block (around line 3970). Keep the file's flat dot-separated style.

```json
  "SCENE.ARCHIVE.RECENT": "Recent",
  "SCENE.ARCHIVE.NEW_SCENE_HERE": "New scene here",
  "SCENE.ARCHIVE.SHOW_ALL_IN_FOLDER": "Show all {{count}}",
  "SCENE.ARCHIVE.EXPAND_FOLDER": "Open this folder",
  "SCENE.ARCHIVE.COLLAPSE_FOLDER": "Close this folder",
  "SCENE.ARCHIVE.SHOW_FOLDERS": "Folders",
  "SCENE.ARCHIVE.STATUS_ALL": "All",
  "SCENE.ARCHIVE.STATUS_RUNNING": "Running",
  "SCENE.ARCHIVE.STATUS_FINISHED": "Finished",
  "SCENE.BOARD.FOLDER_UNFILED": "Not in a folder",
  "SCENE.TOAST.CREATED_NOT_FILED": "The scene was created, but it could not be filed"
```

- [ ] **Step 3: Rewrite the archive's empty copy**

`SCENE.ARCHIVE.EMPTY_BODY` currently says scenes land here when they end, which stops being true in Task 4. Replace that one value:

```json
  "SCENE.ARCHIVE.EMPTY_BODY": "Every scene in this server lives here, running or finished. Give them folders for the arcs they belong to and tags for everything that cuts across, and a long campaign stays readable.",
```

- [ ] **Step 4: Mirror all twelve keys into `de.json` and `fr.json`**

German:

```json
  "SCENE.ARCHIVE.RECENT": "Zuletzt",
  "SCENE.ARCHIVE.NEW_SCENE_HERE": "Neue Szene hier",
  "SCENE.ARCHIVE.SHOW_ALL_IN_FOLDER": "Alle {{count}} anzeigen",
  "SCENE.ARCHIVE.EXPAND_FOLDER": "Diesen Ordner öffnen",
  "SCENE.ARCHIVE.COLLAPSE_FOLDER": "Diesen Ordner schließen",
  "SCENE.ARCHIVE.SHOW_FOLDERS": "Ordner",
  "SCENE.ARCHIVE.STATUS_ALL": "Alle",
  "SCENE.ARCHIVE.STATUS_RUNNING": "Laufend",
  "SCENE.ARCHIVE.STATUS_FINISHED": "Beendet",
  "SCENE.BOARD.FOLDER_UNFILED": "In keinem Ordner",
  "SCENE.TOAST.CREATED_NOT_FILED": "Die Szene wurde erstellt, konnte aber nicht abgelegt werden",
  "SCENE.ARCHIVE.EMPTY_BODY": "Jede Szene dieses Servers liegt hier, laufend oder beendet. Gib ihnen Ordner für die Handlungsbögen, zu denen sie gehören, und Tags für alles, was quer dazu läuft, dann bleibt auch eine lange Kampagne lesbar."
```

French:

```json
  "SCENE.ARCHIVE.RECENT": "Récent",
  "SCENE.ARCHIVE.NEW_SCENE_HERE": "Nouvelle scène ici",
  "SCENE.ARCHIVE.SHOW_ALL_IN_FOLDER": "Afficher les {{count}}",
  "SCENE.ARCHIVE.EXPAND_FOLDER": "Ouvrir ce dossier",
  "SCENE.ARCHIVE.COLLAPSE_FOLDER": "Fermer ce dossier",
  "SCENE.ARCHIVE.SHOW_FOLDERS": "Dossiers",
  "SCENE.ARCHIVE.STATUS_ALL": "Toutes",
  "SCENE.ARCHIVE.STATUS_RUNNING": "En cours",
  "SCENE.ARCHIVE.STATUS_FINISHED": "Terminées",
  "SCENE.BOARD.FOLDER_UNFILED": "Dans aucun dossier",
  "SCENE.TOAST.CREATED_NOT_FILED": "La scène a été créée, mais elle n'a pas pu être classée",
  "SCENE.ARCHIVE.EMPTY_BODY": "Toutes les scènes de ce serveur vivent ici, en cours ou terminées. Donnez-leur des dossiers pour les arcs auxquels elles appartiennent et des tags pour tout ce qui les traverse, et une longue campagne reste lisible."
```

- [ ] **Step 5: Verify all three files still parse**

```bash
cd src/assets/i18n/locales && node -e "for (const f of ['en','de','fr']) { JSON.parse(require('fs').readFileSync(f + '.json', 'utf8')); console.log(f, 'ok'); }"
```

Expected: `en ok`, `de ok`, `fr ok`.

- [ ] **Step 6: Verify every new key exists in all three locales**

```bash
cd src/assets/i18n/locales && node -e "
const fs = require('fs');
const keys = ['SCENE.ARCHIVE.RECENT','SCENE.ARCHIVE.NEW_SCENE_HERE','SCENE.ARCHIVE.SHOW_ALL_IN_FOLDER','SCENE.ARCHIVE.EXPAND_FOLDER','SCENE.ARCHIVE.COLLAPSE_FOLDER','SCENE.ARCHIVE.SHOW_FOLDERS','SCENE.ARCHIVE.STATUS_ALL','SCENE.ARCHIVE.STATUS_RUNNING','SCENE.ARCHIVE.STATUS_FINISHED','SCENE.BOARD.FOLDER_UNFILED','SCENE.TOAST.CREATED_NOT_FILED'];
for (const f of ['en','de','fr']) {
  const j = JSON.parse(fs.readFileSync(f + '.json','utf8'));
  const missing = keys.filter(k => !(k in j));
  console.log(f, missing.length ? 'MISSING ' + missing.join(', ') : 'complete');
}"
```

Expected: `en complete`, `de complete`, `fr complete`.

- [ ] **Step 7: Commit inside the submodule, then record the pointer**

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat(scenes): add folder tree strings"
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for the scene folder tree"
```

---

### Task 2: `scene-leaf.ts`

**Files:**

- Create: `src/app/features/guild/scenes/scene-leaf.ts`
- Test: `src/app/features/guild/scenes/scene-leaf.spec.ts`

**Interfaces:**

- Consumes: `isWaitingOnMe(scene, speakable)` from `./scene-status`.
- Produces:
  - `interface SceneLeaf {channelId: string; name: string; status: SceneStatus; mine: boolean}`
  - `const RECENT_LIMIT = 5`
  - `sceneLeaf(scene: SceneListItemDto, speakable: ReadonlySet<string>): SceneLeaf`
  - `leavesByFolder(scenes: readonly SceneListItemDto[], speakable: ReadonlySet<string>): Record<string, SceneLeaf[]>`
  - `recentScenes(scenes: readonly SceneListItemDto[], speakable: ReadonlySet<string>, limit?: number): SceneLeaf[]`

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/scenes/scene-leaf.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';

import {leavesByFolder, RECENT_LIMIT, recentScenes, sceneLeaf} from './scene-leaf';
import {SceneListItemDto, SceneStatus} from '../../../dtos/response/scene.dto';

function scene(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
  return {
    channelId: 'ch_1',
    name: 'The Ford at Dawn',
    status: SceneStatus.Active,
    ...over,
  };
}

const NOBODY: ReadonlySet<string> = new Set();

describe('sceneLeaf', () => {
  it('marks a scene waiting on a character the reader speaks as', () => {
    const leaf = sceneLeaf(scene({currentTurnPersonaId: 'p1'}), new Set(['p1']));

    expect(leaf.mine).toBe(true);
    expect(leaf.channelId).toBe('ch_1');
    expect(leaf.name).toBe('The Ford at Dawn');
  });

  it('does not mark a scene on somebody else', () => {
    expect(sceneLeaf(scene({currentTurnPersonaId: 'p9'}), new Set(['p1'])).mine).toBe(false);
  });
});

describe('leavesByFolder', () => {
  it('groups scenes under the folder they are filed on', () => {
    const grouped = leavesByFolder(
      [
        scene({channelId: 'a', folderId: 'f1'}),
        scene({channelId: 'b', folderId: 'f2'}),
        scene({channelId: 'c', folderId: 'f1'}),
      ],
      NOBODY,
    );

    expect(grouped['f1'].map(l => l.channelId)).toEqual(['a', 'c']);
    expect(grouped['f2'].map(l => l.channelId)).toEqual(['b']);
  });

  it('leaves an unfiled scene out entirely', () => {
    const grouped = leavesByFolder(
      [scene({channelId: 'a'}), scene({channelId: 'b', folderId: null})],
      NOBODY,
    );

    expect(Object.keys(grouped)).toEqual([]);
  });
});

describe('recentScenes', () => {
  it('puts a scene waiting on you above a newer one that is not', () => {
    const rows = recentScenes(
      [
        scene({channelId: 'newer', updatedAt: '2026-08-20T12:00:00Z'}),
        scene({channelId: 'mine', updatedAt: '2026-01-01T00:00:00Z', currentTurnPersonaId: 'p1'}),
      ],
      new Set(['p1']),
    );

    expect(rows.map(r => r.channelId)).toEqual(['mine', 'newer']);
  });

  it('orders everything else by what moved last', () => {
    const rows = recentScenes(
      [
        scene({channelId: 'old', updatedAt: '2026-01-01T00:00:00Z'}),
        scene({channelId: 'new', updatedAt: '2026-08-20T12:00:00Z'}),
        scene({channelId: 'mid', updatedAt: '2026-05-01T00:00:00Z'}),
      ],
      NOBODY,
    );

    expect(rows.map(r => r.channelId)).toEqual(['new', 'mid', 'old']);
  });

  it('falls back to when the scene was created', () => {
    const rows = recentScenes(
      [
        scene({channelId: 'created-later', createdAt: '2026-08-01T00:00:00Z'}),
        scene({channelId: 'created-earlier', createdAt: '2026-02-01T00:00:00Z'}),
      ],
      NOBODY,
    );

    expect(rows.map(r => r.channelId)).toEqual(['created-later', 'created-earlier']);
  });

  it('sinks a scene with no usable timestamp rather than throwing', () => {
    const rows = recentScenes(
      [
        scene({channelId: 'undated', updatedAt: 'not a date'}),
        scene({channelId: 'dated', updatedAt: '2026-08-20T12:00:00Z'}),
      ],
      NOBODY,
    );

    expect(rows.map(r => r.channelId)).toEqual(['dated', 'undated']);
  });

  it('stops at the limit', () => {
    const many = Array.from({length: 12}, (_, i) =>
      scene({channelId: `ch_${i}`, updatedAt: `2026-08-0${(i % 9) + 1}T00:00:00Z`}),
    );

    expect(recentScenes(many, NOBODY)).toHaveLength(RECENT_LIMIT);
    expect(recentScenes(many, NOBODY, 2)).toHaveLength(2);
  });

  it('does not reorder the array it was handed', () => {
    const input = [
      scene({channelId: 'a', updatedAt: '2026-01-01T00:00:00Z'}),
      scene({channelId: 'b', updatedAt: '2026-08-01T00:00:00Z'}),
    ];

    recentScenes(input, NOBODY);

    expect(input.map(s => s.channelId)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run ng test --watch=false --include="**/scene-leaf.spec.ts"
```

Expected: FAIL, cannot resolve `./scene-leaf`.

- [ ] **Step 3: Write the implementation**

Create `src/app/features/guild/scenes/scene-leaf.ts`:

```ts
import {SceneListItemDto, SceneStatus} from '../../../dtos/response/scene.dto';
import {isWaitingOnMe} from './scene-status';

/** A scene as the folder rail draws it. Small on purpose: the rail redraws on the board's clock. */
export interface SceneLeaf {
  channelId: string;
  name: string;
  status: SceneStatus;
  /** The scene is on a character this reader may speak as. */
  mine: boolean;
}

/** Rows the Recent block shows before it stops. */
export const RECENT_LIMIT = 5;

export function sceneLeaf(scene: SceneListItemDto, speakable: ReadonlySet<string>): SceneLeaf {
  return {
    channelId: scene.channelId,
    name: scene.name,
    status: scene.status,
    mine: isWaitingOnMe(scene, speakable),
  };
}

/** Scenes filed on each folder, keyed by folder id. An unfiled scene is not in any group. */
export function leavesByFolder(
  scenes: readonly SceneListItemDto[],
  speakable: ReadonlySet<string>,
): Record<string, SceneLeaf[]> {
  const grouped: Record<string, SceneLeaf[]> = {};
  for (const scene of scenes) {
    if (!scene.folderId) continue;
    (grouped[scene.folderId] ??= []).push(sceneLeaf(scene, speakable));
  }
  return grouped;
}

/** Waiting on you first, then whatever moved last. */
export function recentScenes(
  scenes: readonly SceneListItemDto[],
  speakable: ReadonlySet<string>,
  limit = RECENT_LIMIT,
): SceneLeaf[] {
  return [...scenes]
    .sort((a, b) => {
      const mine = Number(isWaitingOnMe(b, speakable)) - Number(isWaitingOnMe(a, speakable));
      return mine || movedAt(b) - movedAt(a);
    })
    .slice(0, limit)
    .map(scene => sceneLeaf(scene, speakable));
}

function movedAt(scene: SceneListItemDto): number {
  const stamp = scene.updatedAt ?? scene.createdAt;
  const parsed = stamp ? new Date(stamp).getTime() : 0;
  return Number.isNaN(parsed) ? 0 : parsed;
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run ng test --watch=false --include="**/scene-leaf.spec.ts"
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Lint and format, then commit**

```bash
bun run prettier --write src/app/features/guild/scenes/scene-leaf.ts src/app/features/guild/scenes/scene-leaf.spec.ts
bun run lint
git add src/app/features/guild/scenes/scene-leaf.ts src/app/features/guild/scenes/scene-leaf.spec.ts
git commit -m "feat(scenes): add the folder rail's scene leaf model"
```

---

### Task 3: `SceneRailStateService`

**Files:**

- Create: `src/app/services/scene-rail-state.service.ts`
- Test: `src/app/services/scene-rail-state.service.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `expanded(guildId: string | null | undefined): readonly string[]`
  - `isExpanded(guildId: string | null | undefined, folderId: string): boolean`
  - `toggle(guildId: string, folderId: string): void`
  - `railVisible(guildId: string | null | undefined): boolean`
  - `setRailVisible(guildId: string, visible: boolean): void`

- [ ] **Step 1: Check how the codebase scopes local storage under multi-account**

```bash
grep -rn "localStorage.setItem" src/app/services/*.ts | head -12
```

Read two of the hits. If they prefix keys with an account or device id, follow that. If they use plain namespaced keys, use `venta.scene-rail` as written below. Note which you found in the commit message only if you deviated.

- [ ] **Step 2: Write the failing test**

Create `src/app/services/scene-rail-state.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {SCENE_RAIL_STORAGE_KEY, SceneRailStateService} from './scene-rail-state.service';

function service(): SceneRailStateService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return TestBed.inject(SceneRailStateService);
}

describe('SceneRailStateService', () => {
  beforeEach(() => localStorage.clear());

  it('starts with every shelf closed', () => {
    expect(service().expanded('g1')).toEqual([]);
  });

  it('opens and closes a shelf', () => {
    const state = service();

    state.toggle('g1', 'f1');
    expect(state.isExpanded('g1', 'f1')).toBe(true);

    state.toggle('g1', 'f1');
    expect(state.isExpanded('g1', 'f1')).toBe(false);
  });

  it('keeps guilds apart', () => {
    const state = service();

    state.toggle('g1', 'f1');

    expect(state.expanded('g1')).toEqual(['f1']);
    expect(state.expanded('g2')).toEqual([]);
  });

  it('survives a restart', () => {
    service().toggle('g1', 'f1');

    expect(service().isExpanded('g1', 'f1')).toBe(true);
  });

  it('hides the rail until it is asked for, then remembers', () => {
    const state = service();

    expect(state.railVisible('g1')).toBe(false);
    state.setRailVisible('g1', true);

    expect(service().railVisible('g1')).toBe(true);
  });

  it('answers for a missing guild id without throwing', () => {
    const state = service();

    expect(state.expanded(null)).toEqual([]);
    expect(state.railVisible(undefined)).toBe(false);
  });

  it('reads a corrupt blob as nothing remembered', () => {
    localStorage.setItem(SCENE_RAIL_STORAGE_KEY, '{not json');

    expect(service().expanded('g1')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
bun run ng test --watch=false --include="**/scene-rail-state.service.spec.ts"
```

Expected: FAIL, cannot resolve `./scene-rail-state.service`.

- [ ] **Step 4: Write the implementation**

Create `src/app/services/scene-rail-state.service.ts`:

```ts
import {Injectable, signal} from '@angular/core';

export const SCENE_RAIL_STORAGE_KEY = 'venta.scene-rail';

const EMPTY: readonly string[] = [];

interface RailState {
  /** Open shelves, per guild. */
  expanded: Record<string, string[]>;
  /** Whether the playing screen shows the rail, per guild. */
  visible: Record<string, boolean>;
}

/** What the folder rail remembers between visits: which shelves are open, and whether it is shown. */
@Injectable({providedIn: 'root'})
export class SceneRailStateService {
  private readonly state = signal<RailState>(read());

  expanded(guildId: string | null | undefined): readonly string[] {
    if (!guildId) return EMPTY;
    return this.state().expanded[guildId] ?? EMPTY;
  }

  isExpanded(guildId: string | null | undefined, folderId: string): boolean {
    return this.expanded(guildId).includes(folderId);
  }

  toggle(guildId: string, folderId: string): void {
    this.state.update(state => {
      const open = state.expanded[guildId] ?? [];
      const next = open.includes(folderId) ? open.filter(id => id !== folderId) : [...open, folderId];
      return {...state, expanded: {...state.expanded, [guildId]: next}};
    });
    this.persist();
  }

  railVisible(guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    return !!this.state().visible[guildId];
  }

  setRailVisible(guildId: string, visible: boolean): void {
    this.state.update(state => ({...state, visible: {...state.visible, [guildId]: visible}}));
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(SCENE_RAIL_STORAGE_KEY, JSON.stringify(this.state()));
    } catch {
      // A full or unavailable store costs the memory of which shelves were open, nothing more.
    }
  }
}

function read(): RailState {
  const empty: RailState = {expanded: {}, visible: {}};
  try {
    const raw = localStorage.getItem(SCENE_RAIL_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<RailState>;
    return {expanded: parsed.expanded ?? {}, visible: parsed.visible ?? {}};
  } catch {
    return empty;
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
bun run ng test --watch=false --include="**/scene-rail-state.service.spec.ts"
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Lint, format, commit**

```bash
bun run prettier --write src/app/services/scene-rail-state.service.ts src/app/services/scene-rail-state.service.spec.ts
bun run lint
git add src/app/services/scene-rail-state.service.ts src/app/services/scene-rail-state.service.spec.ts
git commit -m "feat(scenes): remember which shelves are open"
```

---

### Task 4: `SceneArchiveService` stops meaning "finished"

**Files:**

- Modify: `src/app/services/scene-archive.service.ts`
- Test: `src/app/services/scene-archive.service.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type ArchiveStatus = 'all' | 'running' | 'finished'`
  - `ArchiveFilter` gains `status?: ArchiveStatus`, defaulting to `'all'`
  - `peek(guildId: string, folderId: string | null, status?: ArchiveStatus): void`
  - `peeked(guildId: string, folderId: string | null, status?: ArchiveStatus): readonly SceneListItemDto[]`
  - `peekLoading(guildId: string, folderId: string | null, status?: ArchiveStatus): boolean`

- [ ] **Step 1: Update the one existing test that pins the old behaviour**

In `src/app/services/scene-archive.service.spec.ts`, the first test asserts the archive asks only for scenes that ended. That is exactly what this task changes. Replace it:

```ts
it('asks for every scene by default, newest first', () => {
  const {service, calls} = setup();

  service.apply(BASE);

  expect(calls[0]).toMatchObject({includeConcluded: true, includeArchived: true, sort: 'ended', offset: 0});
  expect(calls[0].archivedOnly).toBeUndefined();
});
```

- [ ] **Step 2: Add the new tests**

Append inside the existing `describe('SceneArchiveService', ...)` block:

```ts
it('asks only for finished scenes when the filter says so', () => {
  const {service, calls} = setup();

  service.apply({...BASE, status: 'finished'});

  expect(calls[0]).toMatchObject({archivedOnly: true, includeConcluded: true, includeArchived: true});
});

it('asks for the live board alone when the filter says running', () => {
  const {service, calls} = setup();

  service.apply({...BASE, status: 'running'});

  expect(calls[0].archivedOnly).toBeUndefined();
  expect(calls[0].includeConcluded).toBeUndefined();
  expect(calls[0].includeArchived).toBeUndefined();
});

it('caches each status apart', () => {
  expect(archiveKey({...BASE, status: 'running'})).not.toBe(archiveKey({...BASE, status: 'finished'}));
});

it('treats an absent status as all', () => {
  expect(archiveKey(BASE)).toBe(archiveKey({...BASE, status: 'all'}));
});

it('reads a shelf without moving the selection', () => {
  const {service, calls, responses} = setup();

  service.apply(BASE);
  service.peek('g1', 'f1');
  responses[1].next(page(2, {folderId: 'f1'}));

  expect(calls[1]).toMatchObject({folderId: 'f1'});
  expect(service.peeked('g1', 'f1')).toHaveLength(2);
  // The selection is still every shelf, not the one that was peeked.
  expect(service.current()?.folderId).toBeNull();
});

it('does not re-read a shelf it already holds', () => {
  const {service, calls, responses} = setup();

  service.peek('g1', 'f1');
  responses[0].next(page(1, {folderId: 'f1'}));
  service.peek('g1', 'f1');

  expect(calls).toHaveLength(1);
});

it('shares one request between a peeked shelf and the same shelf selected', () => {
  const {service, calls, responses} = setup();

  service.peek('g1', 'f1');
  responses[0].next(page(3, {folderId: 'f1'}));
  service.apply({...BASE, folderId: 'f1'});

  expect(calls).toHaveLength(1);
  expect(service.scenes()).toHaveLength(3);
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
bun run ng test --watch=false --include="**/scene-archive.service.spec.ts"
```

Expected: FAIL. `peek` is not a function, and the default-params test fails on `archivedOnly: true` still being sent.

- [ ] **Step 4: Add the status type and thread it through the key**

In `src/app/services/scene-archive.service.ts`, above `ArchiveFilter`:

```ts
/** Which slice of a guild's scenes the archive is showing. */
export type ArchiveStatus = 'all' | 'running' | 'finished';
```

Add the field to `ArchiveFilter`, after `sort`:

```ts
    /** Defaults to `all`: the archive holds running scenes now, not only finished ones. */
    status?: ArchiveStatus;
```

Beside `DEFAULT_SORT`:

```ts
const DEFAULT_STATUS: ArchiveStatus = 'all';
const EMPTY_ROWS: readonly SceneListItemDto[] = [];
```

In `archiveKey`, insert the status between sort and tags:

```ts
export function archiveKey(filter: ArchiveFilter): string {
  return [
    filter.guildId,
    filter.folderId ?? '*',
    filter.sort ?? DEFAULT_SORT,
    filter.status ?? DEFAULT_STATUS,
    [...filter.tagIds].sort().join('+'),
    filter.q,
  ].join('|');
}
```

- [ ] **Step 5: Rewrite `params` to answer the status**

Replace the body of the private `params` method:

```ts
    private params(filter: ArchiveFilter, offset: number): SceneListParams {
        return {
            ...statusFlags(filter.status ?? DEFAULT_STATUS),
            sort: filter.sort ?? DEFAULT_SORT,
            limit: PAGE_SIZE,
            offset,
            folderId: filter.folderId ?? undefined,
            tagIds: filter.tagIds.length ? filter.tagIds : undefined,
            q: filter.q || undefined,
        };
    }
```

And at the bottom of the file, above `export {UNFILED};`:

```ts
/** `running` sends no flags at all: the live board is what the route returns by default. */
function statusFlags(status: ArchiveStatus): Partial<SceneListParams> {
  if (status === 'running') return {};
  const both = {includeConcluded: true, includeArchived: true};
  return status === 'finished' ? {...both, archivedOnly: true} : both;
}
```

- [ ] **Step 6: Add the shelf reads**

After the existing `drop` method:

```ts
    /** Reads a shelf's scenes into the cache without moving the selection. */
    peek(guildId: string, folderId: string | null, status: ArchiveStatus = DEFAULT_STATUS): void {
        const filter = shelfFilter(guildId, folderId, status);
        const key = archiveKey(filter);
        if (this.pages()[key] || this.loadingKeys()[key]) return;
        this.read(filter, 0);
    }

    peeked(
        guildId: string,
        folderId: string | null,
        status: ArchiveStatus = DEFAULT_STATUS,
    ): readonly SceneListItemDto[] {
        return this.pages()[archiveKey(shelfFilter(guildId, folderId, status))] ?? EMPTY_ROWS;
    }

    peekLoading(
        guildId: string,
        folderId: string | null,
        status: ArchiveStatus = DEFAULT_STATUS,
    ): boolean {
        return !!this.loadingKeys()[archiveKey(shelfFilter(guildId, folderId, status))];
    }
```

And beside `statusFlags`:

```ts
/** No tags and no query, so a shelf and the same shelf selected unfiltered are one cache entry. */
function shelfFilter(guildId: string, folderId: string | null, status: ArchiveStatus): ArchiveFilter {
  return {guildId, folderId, tagIds: [], q: '', sort: DEFAULT_SORT, status};
}
```

- [ ] **Step 7: Run the tests**

```bash
bun run ng test --watch=false --include="**/scene-archive.service.spec.ts"
```

Expected: PASS, the original suite plus 7 new tests.

- [ ] **Step 8: Lint, format, commit**

```bash
bun run prettier --write src/app/services/scene-archive.service.ts src/app/services/scene-archive.service.spec.ts
bun run lint
git add src/app/services/scene-archive.service.ts src/app/services/scene-archive.service.spec.ts
git commit -m "feat(scenes): let the archive hold running scenes and read one shelf"
```

---

### Task 5: Rail characterization tests

`SceneFolderRailComponent` has no spec and Task 6 restructures it. CLAUDE.md requires the tests first, green against the current code, so the refactor has evidence it changed nothing.

**Files:**

- Create: `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.spec.ts`

**Interfaces:**

- Consumes: `SceneFolderRailComponent` exactly as it stands today.
- Produces: a green suite that Task 6 must keep green.

- [ ] **Step 1: Write the characterization spec**

Create `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.spec.ts`:

```ts
/**
 * Characterization of the rail's reordering. Written against the two-level rail before the tree
 * rewrite, so a green run after it is evidence the folder maths survived.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';

import {SceneFolderRailComponent} from './scene-folder-rail.component';
import {folderTree} from './folder-tree';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

function folder(id: string, parentFolderId: string | null = null, position = 0): SceneFolderDto {
  return {id, guildId: 'g1', name: id.toUpperCase(), position, parentFolderId};
}

/** Two roots with two children under the first, which is every shape the reorder code branches on. */
const FOLDERS = [folder('a', null, 0), folder('b', null, 1), folder('a1', 'a', 0), folder('a2', 'a', 1)];

function setup(): {fixture: ComponentFixture<SceneFolderRailComponent>; component: SceneFolderRailComponent} {
  TestBed.configureTestingModule({
    imports: [SceneFolderRailComponent],
    providers: [provideTranslateService()],
  });
  const fixture = TestBed.createComponent(SceneFolderRailComponent);
  fixture.componentRef.setInput('tree', folderTree(FOLDERS, {}));
  fixture.componentRef.setInput('canManage', true);
  fixture.detectChanges();
  return {fixture, component: fixture.componentInstance};
}

/** Reaches past `protected` on purpose: these are the methods under characterization. */
function reach(component: SceneFolderRailComponent): Record<string, (...args: never[]) => unknown> {
  return component as unknown as Record<string, (...args: never[]) => unknown>;
}

describe('SceneFolderRailComponent reordering', () => {
  let component: SceneFolderRailComponent;
  let emitted: string[][];

  beforeEach(() => {
    component = setup().component;
    emitted = [];
    component.reordered.subscribe(ids => emitted.push(ids));
  });

  it('emits every folder depth first when a root moves down', () => {
    reach(component)['nudge'](component.tree()[0] as never, 1 as never);

    expect(emitted[0]).toEqual(['b', 'a', 'a1', 'a2']);
  });

  it('emits every folder depth first when a child moves down', () => {
    reach(component)['nudge'](component.tree()[0].children[0] as never, 1 as never);

    expect(emitted[0]).toEqual(['a', 'a2', 'a1', 'b']);
  });

  it('says nothing when a nudge would leave the group', () => {
    reach(component)['nudge'](component.tree()[0] as never, -1 as never);

    expect(emitted).toEqual([]);
  });

  it('finds a root among the roots and a child among its siblings', () => {
    expect(reach(component)['siblingsOf']('a' as never)).toMatchObject({parentId: null});
    expect(reach(component)['siblingsOf']('a1' as never)).toMatchObject({parentId: 'a'});
    expect(reach(component)['siblingsOf']('nope' as never)).toBeNull();
  });
});

describe('SceneFolderRailComponent menu', () => {
  it('offers no menu to a reader who cannot manage scenes', () => {
    TestBed.configureTestingModule({
      imports: [SceneFolderRailComponent],
      providers: [provideTranslateService()],
    });
    const fixture = TestBed.createComponent(SceneFolderRailComponent);
    fixture.componentRef.setInput('tree', folderTree(FOLDERS, {}));
    fixture.componentRef.setInput('canManage', false);
    fixture.detectChanges();

    const event = new MouseEvent('contextmenu');
    reach(fixture.componentInstance)['openMenu'](
      event as never,
      fixture.componentInstance.tree()[0] as never,
    );

    expect((fixture.componentInstance as unknown as {menuItems: () => unknown[]}).menuItems()).toEqual([]);
  });

  it('builds a menu for a folder that can be managed', () => {
    const {component} = setup();

    reach(component)['openMenu'](new MouseEvent('contextmenu') as never, component.tree()[0] as never);

    const labels = (component as unknown as {menuItems: () => {label?: string}[]}).menuItems();
    expect(labels.length).toBeGreaterThan(4);
  });
});
```

- [ ] **Step 2: Run it against the current component**

```bash
bun run ng test --watch=false --include="**/scene-folder-rail.component.spec.ts"
```

Expected: PASS, 6 tests. If any fail, the characterization is wrong, not the component. Fix the test to describe what actually happens, then move on. Do not change the component in this task.

- [ ] **Step 3: Run the full suite and record the baseline**

```bash
bun run test 2>&1 | tail -20
```

Write down the passing count. Task 6 must not reduce it.

- [ ] **Step 4: Lint, format, commit**

```bash
bun run prettier --write src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.spec.ts
bun run lint
git add src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.spec.ts
git commit -m "test(scenes): pin the folder rail's reordering before the tree rewrite"
```

---

### Task 6: The rail becomes a tree

**Files:**

- Modify: `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.ts`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.html`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.css`
- Test: `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.spec.ts`

**Interfaces:**

- Consumes: `SceneLeaf` from `../scene-leaf` (Task 2), the keys from Task 1, the green suite from Task 5.
- Produces, on `SceneFolderRailComponent`, in addition to everything it has today:
  - `scenesByFolder = input<Readonly<Record<string, readonly SceneLeaf[]>>>({})`
  - `recent = input<readonly SceneLeaf[]>([])`
  - `expandedIds = input<readonly string[]>([])`
  - `loadingFolderIds = input<readonly string[]>([])`
  - `leafCap = input(12)`
  - `toggled = output<string>()`
  - `openScene = output<string>()`
  - `createScene = output<string | null>()`
  - `showAll = output<string>()`

Everything already on the component (`tree`, `selected`, `canManage`, `picked`, `createFolder`, `renameFolder`, `deleteFolder`, `reordered`, `filed`) keeps its exact name and shape.

- [ ] **Step 1: Write the failing tests**

Append to `scene-folder-rail.component.spec.ts`. Keep the existing `setup`, `folder`, `FOLDERS`, and `reach` helpers and use them.

```ts
describe('SceneFolderRailComponent tree', () => {
  it('says nothing about a shelf nobody has opened', () => {
    const {fixture} = setup();
    fixture.componentRef.setInput('scenesByFolder', {
      a: [{channelId: 'ch_1', name: 'The Ford at Dawn', status: SceneStatus.Active, mine: false}],
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('The Ford at Dawn');
  });

  it('draws the scenes of a shelf once it is open', () => {
    const {fixture} = setup();
    fixture.componentRef.setInput('scenesByFolder', {
      a: [{channelId: 'ch_1', name: 'The Ford at Dawn', status: SceneStatus.Active, mine: false}],
    });
    fixture.componentRef.setInput('expandedIds', ['a']);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('The Ford at Dawn');
  });

  it('draws the recent block above everything', () => {
    const {fixture} = setup();
    fixture.componentRef.setInput('recent', [
      {channelId: 'ch_9', name: 'Nightwatch', status: SceneStatus.Active, mine: true},
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Nightwatch');
  });

  it('reports a shelf being opened rather than opening it itself', () => {
    const {fixture, component} = setup();
    const toggles: string[] = [];
    component.toggled.subscribe(id => toggles.push(id));

    reach(component)['toggle']('a' as never);

    expect(toggles).toEqual(['a']);
    // The rail does not hold the state: the host does, and hands it back through expandedIds.
    expect(fixture.componentInstance.expandedIds()).toEqual([]);
  });

  it('offers new scene here at the top of a folder menu', () => {
    const {component} = setup();

    reach(component)['openMenu'](new MouseEvent('contextmenu') as never, component.tree()[0] as never);

    const items = (component as unknown as {menuItems: () => {label?: string}[]}).menuItems();
    expect(items[0].label).toBe('SCENE.ARCHIVE.NEW_SCENE_HERE');
  });

  it('names the folder when new scene here is chosen', () => {
    const {component} = setup();
    const asked: (string | null)[] = [];
    component.createScene.subscribe(id => asked.push(id));

    reach(component)['openMenu'](new MouseEvent('contextmenu') as never, component.tree()[0] as never);
    const items = (component as unknown as {menuItems: () => {command?: () => void}[]}).menuItems();
    items[0].command?.();

    expect(asked).toEqual(['a']);
  });

  it('stops a shelf at the leaf cap and offers the rest', () => {
    const {fixture, component} = setup();
    const many = Array.from({length: 20}, (_, i) => ({
      channelId: `ch_${i}`,
      name: `Scene ${i}`,
      status: SceneStatus.Active,
      mine: false,
    }));
    fixture.componentRef.setInput('scenesByFolder', {a: many});
    fixture.componentRef.setInput('expandedIds', ['a']);
    fixture.componentRef.setInput('leafCap', 3);
    fixture.detectChanges();

    expect(reach(component)['leavesOf']('a' as never)).toHaveLength(3);
    expect(reach(component)['overflowOf']('a' as never)).toBe(17);
    expect(fixture.nativeElement.textContent).not.toContain('Scene 19');
  });

  it('reports a leaf click as a scene to open', () => {
    const {component} = setup();
    const opened: string[] = [];
    component.openScene.subscribe(id => opened.push(id));

    reach(component)['open']('ch_1' as never);

    expect(opened).toEqual(['ch_1']);
  });
});
```

Add `SceneStatus` to the spec's imports:

```ts
import {SceneFolderDto, SceneStatus} from '../../../../dtos/response/scene.dto';
```

- [ ] **Step 2: Run and watch the new block fail**

```bash
bun run ng test --watch=false --include="**/scene-folder-rail.component.spec.ts"
```

Expected: the Task 5 describes still PASS, the new describe FAILs on missing inputs and methods.

- [ ] **Step 3: Add the new surface to the component**

In `scene-folder-rail.component.ts`, add to the imports:

```ts
import {SceneLeaf} from '../scene-leaf';
import {sceneStatusMeta} from '../scene-status';
```

Add the inputs beside the existing ones:

```ts
    /** Scenes filed on each folder, by folder id. A shelf with no entry simply has none loaded. */
    readonly scenesByFolder = input<Readonly<Record<string, readonly SceneLeaf[]>>>({});
    readonly recent = input<readonly SceneLeaf[]>([]);
    /** Open shelves. The rail does not own this: the host remembers it. */
    readonly expandedIds = input<readonly string[]>([]);
    readonly loadingFolderIds = input<readonly string[]>([]);
    /** A shelf is not a list. Past this it offers the folder instead. */
    readonly leafCap = input(12);
```

And the outputs:

```ts
    readonly toggled = output<string>();
    readonly openScene = output<string>();
    /** The folder a new scene should be filed on, or null for none. */
    readonly createScene = output<string | null>();
    readonly showAll = output<string>();
```

Add the protected helpers, after the existing `openMenu`:

```ts
    protected isOpen(folderId: string): boolean {
        return this.expandedIds().includes(folderId);
    }

    protected isLoading(folderId: string): boolean {
        return this.loadingFolderIds().includes(folderId);
    }

    protected leavesOf(folderId: string): readonly SceneLeaf[] {
        return (this.scenesByFolder()[folderId] ?? []).slice(0, this.leafCap());
    }

    protected overflowOf(folderId: string): number {
        return Math.max(0, (this.scenesByFolder()[folderId] ?? []).length - this.leafCap());
    }

    protected hasContents(node: FolderNode): boolean {
        return node.children.length > 0 || (this.scenesByFolder()[node.folder.id] ?? []).length > 0;
    }

    protected toggle(folderId: string): void {
        this.toggled.emit(folderId);
    }

    protected open(channelId: string): void {
        this.openScene.emit(channelId);
    }

    protected dotClass(leaf: SceneLeaf): string {
        return DOT_COLOUR[leaf.status];
    }
```

`sceneStatusMeta().chipClass` is not usable here: it carries a background as well as a colour, and
the dot paints itself from `currentColor`. Add the map above the component instead:

```ts
/** Only the colour half of the status table: the dot is a colour, not a chip. */
const DOT_COLOUR: Readonly<Record<SceneStatus, string>> = {
  [SceneStatus.Open]: 'text-text-muted',
  [SceneStatus.Active]: 'text-online',
  [SceneStatus.Paused]: 'text-connecting',
  [SceneStatus.Concluded]: 'text-text-faint',
};
```

with `import {SceneStatus} from '../../../../dtos/response/scene.dto';`. Drop the `sceneStatusMeta`
import from Step 3: nothing uses it.

Narrow the existing TODO at the top of the class. The board now passes real counts, so only the
archive is still waiting on the route:

```ts
// TODO(dominic): the archive can only count a shelf it has opened, until the taxonomy route
// carries counts. The board's are exact.
```

- [ ] **Step 4: Put "New scene here" at the top of the menu**

In `openMenu`, insert as the first entry of the array passed to `this.menuItems.set([...])`, before the existing `NEW_FOLDER_HERE` item:

```ts
            {
                label: this.translate.instant('SCENE.ARCHIVE.NEW_SCENE_HERE'),
                icon: 'pi pi-sparkles',
                command: () => this.createScene.emit(node.folder.id),
            },
            {separator: true},
```

- [ ] **Step 5: Rewrite the template**

Replace the whole of `scene-folder-rail.component.html`:

```html
@if (recent().length) {
<span class="rail-label">{{ 'SCENE.ARCHIVE.RECENT' | translate }}</span>

@for (leaf of recent(); track leaf.channelId) {
<button (click)="open(leaf.channelId)" class="rail-row rail-leaf" type="button">
  <span [class]="'rail-dot ' + dotClass(leaf)"></span>
  <span class="rail-name">{{ leaf.name }}</span>
  @if (leaf.mine) {
  <span class="rail-mine">{{ 'SCENE.RAIL.YOUR_MOVE' | translate }}</span>
  }
</button>
}

<div class="rail-rule"></div>
}

<button
  (click)="picked.emit(null)"
  [class.is-selected]="selected() === null"
  class="rail-row rail-row-all"
  type="button"
>
  <span class="rail-name">{{ 'SCENE.ARCHIVE.ALL' | translate }}</span>
</button>

@for (node of tree(); track node.folder.id) {
<ng-container *ngTemplateOutlet="shelf; context: {$implicit: node, depth: 0}"></ng-container>
}

<button
  (click)="picked.emit(UNFILED)"
  (dragleave)="onDragLeave()"
  (dragover)="onDragOver($event, null)"
  (drop)="onDrop($event, null)"
  [class.is-drop-target]="dragOver() === UNFILED"
  [class.is-selected]="selected() === UNFILED"
  class="rail-row rail-row-unfiled"
  type="button"
>
  <span class="rail-name">{{ 'SCENE.ARCHIVE.UNFILED' | translate }}</span>
</button>

@if (canManage()) {
<button (click)="createFolder.emit(null)" class="rail-add" type="button">
  <i class="pi pi-plus text-[0.5rem]"></i>
  {{ 'SCENE.ARCHIVE.NEW_FOLDER' | translate }}
</button>
}

<p-context-menu #folderMenu [model]="menuItems()" appendTo="body" />

<ng-template #shelf let-node let-depth="depth">
  <div [class.is-open]="isOpen(node.folder.id)" [class.rail-shelf-root]="depth === 0" class="rail-shelf">
    <div
      (contextmenu)="openMenu($event, node)"
      (dragend)="onDragEnd()"
      (dragleave)="onDragLeave()"
      (dragover)="onDragOver($event, node.folder.id)"
      (dragstart)="onFolderDragStart($event, node)"
      (drop)="onDrop($event, node.folder.id)"
      [attr.draggable]="canManage() ? true : null"
      [class.is-drop-target]="dragOver() === node.folder.id"
      [class.is-reorder-after]="reorderOver()?.id === node.folder.id && reorderOver()?.after"
      [class.is-reorder-before]="reorderOver()?.id === node.folder.id && !reorderOver()?.after"
      [class.is-selected]="selected() === node.folder.id"
      [style.--rail-accent]="node.folder.color"
      [style.--rail-depth]="depth"
      class="rail-row rail-head"
    >
      <button
        (click)="toggle(node.folder.id)"
        [attr.aria-expanded]="isOpen(node.folder.id)"
        [attr.aria-label]="(isOpen(node.folder.id) ? 'SCENE.ARCHIVE.COLLAPSE_FOLDER' : 'SCENE.ARCHIVE.EXPAND_FOLDER') | translate"
        [class.is-hidden]="!hasContents(node)"
        class="rail-chevron"
        type="button"
      >
        <i
          [class]="isOpen(node.folder.id) ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
          class="text-[0.4375rem]"
        ></i>
      </button>

      <button
        (click)="picked.emit(node.folder.id)"
        (keydown)="onRowKeydown($event, node)"
        class="rail-pick"
        type="button"
      >
        @if (node.folder.icon) {
        <span class="rail-icon">{{ node.folder.icon }}</span>
        }
        <span class="rail-name">{{ node.folder.name }}</span>
      </button>

      @if (node.count) {
      <span class="rail-count">{{ node.count }}</span>
      } @if (canManage()) {
      <button
        (click)="openMenu($event, node)"
        [attr.aria-label]="'SCENE.ARCHIVE.FOLDER_ACTIONS' | translate"
        class="rail-menu"
        type="button"
      >
        <i class="pi pi-ellipsis-h text-[0.5625rem]"></i>
      </button>
      }
    </div>

    @if (isOpen(node.folder.id)) {
    <div class="rail-body">
      @for (child of node.children; track child.folder.id) {
      <ng-container *ngTemplateOutlet="shelf; context: {$implicit: child, depth: depth + 1}"></ng-container>
      } @for (leaf of leavesOf(node.folder.id); track leaf.channelId) {
      <button (click)="open(leaf.channelId)" class="rail-row rail-leaf" type="button">
        <span [class]="'rail-dot ' + dotClass(leaf)"></span>
        <span class="rail-name">{{ leaf.name }}</span>
        @if (leaf.mine) {
        <span class="rail-mine">{{ 'SCENE.RAIL.YOUR_MOVE' | translate }}</span>
        }
      </button>
      } @if (overflowOf(node.folder.id); as rest) {
      <button (click)="showAll.emit(node.folder.id)" class="rail-row rail-leaf rail-more" type="button">
        {{ 'SCENE.ARCHIVE.SHOW_ALL_IN_FOLDER' | translate: {count: rest + leafCap()} }}
      </button>
      } @if (isLoading(node.folder.id)) {
      <div class="rail-leaf-skeleton"></div>
      <div class="rail-leaf-skeleton"></div>
      }
    </div>
    }
  </div>
</ng-template>
```

- [ ] **Step 6: Restyle the rail as shelves**

In `scene-folder-rail.component.css`, delete the `.rail-row-child` rule (nothing renders it now) and append:

```css
.rail-shelf {
  border-radius: 0.625rem;
  overflow: hidden;
  margin-bottom: 0.1875rem;
}

.rail-shelf.is-open {
  margin-bottom: 0.5rem;
}

/* A root folder is a labelled shelf, which is what makes two levels read as two levels. */
.rail-shelf-root > .rail-head {
  border-left: 2px solid var(--rail-accent, transparent);
  border-radius: 0;
  background: rgba(255, 255, 255, 0.035);
  font-size: 0.59375rem;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

.rail-shelf-root.is-open > .rail-head {
  background: rgba(255, 255, 255, 0.055);
  color: var(--color-text-primary);
}

.rail-shelf-root > .rail-head .rail-name {
  font-size: inherit;
}

.rail-body {
  padding: 0.1875rem 0 0.125rem 0.375rem;
}

.rail-chevron {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 0.75rem;
  height: 0.75rem;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--color-text-faint);
  cursor: pointer;
}

/* Held rather than removed: a folder gaining a scene must not shift every name beside it. */
.rail-chevron.is-hidden {
  visibility: hidden;
}

.rail-count {
  flex-shrink: 0;
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--color-text-faint);
}

.rail-leaf {
  gap: 0.4375rem;
  font-size: 0.78125rem;
}

.rail-dot {
  flex-shrink: 0;
  width: 0.3125rem;
  height: 0.3125rem;
  border-radius: 50%;
  background: currentColor;
}

.rail-mine {
  flex-shrink: 0;
  font-size: 0.53125rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-connecting);
}

.rail-more {
  color: var(--color-text-faint);
  font-size: 0.6875rem;
}

.rail-label {
  display: block;
  padding: 0 0.5rem;
  margin: 0.125rem 0 0.3125rem;
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.rail-rule {
  height: 1px;
  margin: 0.5rem 0.5rem;
  background: rgba(255, 255, 255, 0.07);
}

.rail-leaf-skeleton {
  height: 1.25rem;
  margin: 0.125rem 0.5rem;
  border-radius: 0.375rem;
  background: rgba(255, 255, 255, 0.03);
  animation: rail-pulse 1.4s ease-in-out infinite;
}

@keyframes rail-pulse {
  50% {
    opacity: 0.45;
  }
}
```

- [ ] **Step 7: Run the rail spec, both describes**

```bash
bun run ng test --watch=false --include="**/scene-folder-rail.component.spec.ts"
```

Expected: PASS, the 6 characterization tests from Task 5 plus 8 new ones. If a Task 5 test now fails, the refactor broke the reorder maths. Fix the component, never the characterization test.

- [ ] **Step 8: Run the full suite against the baseline**

```bash
bun run test 2>&1 | tail -20
```

Expected: at least the count recorded in Task 5, plus the new tests.

- [ ] **Step 9: Lint, format, commit**

```bash
bun run prettier --write src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.ts src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.html src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.css src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.spec.ts
bun run lint
git add src/app/features/guild/scenes/scene-archive/
git commit -m "feat(scenes): draw the folder rail as a tree with its scenes"
```

---

### Task 7: Extract the folder picker

`scene-detail-sheet.component` holds a searchable folder picker inline. Task 9 needs the same picker in the create dialog, so it moves out rather than getting a second implementation.

**Files:**

- Create: `src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.ts`
- Create: `src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.html`
- Create: `src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.css`
- Test: `src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.spec.ts`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.ts`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.html:86-142`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.css`

**Interfaces:**

- Consumes: `SceneTaxonomyService.folders(guildId)`.
- Produces:
  - `SceneFolderPickerComponent`, selector `app-scene-folder-picker`
  - `guildId = input.required<string>()`
  - `selected = input<string | null>(null)`
  - `picked = output<string | null>()` where null is unfiled

- [ ] **Step 1: Write the failing test**

Create `scene-folder-picker.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';

import {SceneFolderPickerComponent} from './scene-folder-picker.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

function folder(id: string, name: string, parentFolderId: string | null = null): SceneFolderDto {
  return {id, guildId: 'g1', name, position: 0, parentFolderId};
}

const FOLDERS = [folder('a', 'Act I'), folder('a1', 'Greyford', 'a'), folder('b', 'Act II')];

function setup(): {
  fixture: ComponentFixture<SceneFolderPickerComponent>;
  component: SceneFolderPickerComponent;
} {
  TestBed.configureTestingModule({
    imports: [SceneFolderPickerComponent],
    providers: [
      provideTranslateService(),
      {provide: SceneTaxonomyService, useValue: {folders: () => FOLDERS, ensureGuild: () => undefined}},
    ],
  });
  const fixture = TestBed.createComponent(SceneFolderPickerComponent);
  fixture.componentRef.setInput('guildId', 'g1');
  fixture.detectChanges();
  return {fixture, component: fixture.componentInstance};
}

function reach(component: SceneFolderPickerComponent): Record<string, (...args: never[]) => unknown> {
  return component as unknown as Record<string, (...args: never[]) => unknown>;
}

describe('SceneFolderPickerComponent', () => {
  it('lists every parent followed by its own children', () => {
    const {component} = setup();

    const rows = (
      component as unknown as {folderMatches: () => {folder: SceneFolderDto; child: boolean}[]}
    ).folderMatches();

    expect(rows.map(r => r.folder.id)).toEqual(['a', 'a1', 'b']);
    expect(rows[1].child).toBe(true);
  });

  it('searches on the parent name too', () => {
    const {component} = setup();

    reach(component)['folderQuery'];
    (component as unknown as {folderQuery: {set: (v: string) => void}}).folderQuery.set('Act I');
    const rows = (component as unknown as {folderMatches: () => {folder: SceneFolderDto}[]}).folderMatches();

    expect(rows.map(r => r.folder.id)).toEqual(['a', 'a1']);
  });

  it('reports the chosen folder', () => {
    const {component} = setup();
    const picks: (string | null)[] = [];
    component.picked.subscribe(id => picks.push(id));

    reach(component)['choose']('a1' as never);

    expect(picks).toEqual(['a1']);
  });

  it('reports unfiled as null', () => {
    const {component} = setup();
    const picks: (string | null)[] = [];
    component.picked.subscribe(id => picks.push(id));

    reach(component)['choose'](null as never);

    expect(picks).toEqual([null]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run ng test --watch=false --include="**/scene-folder-picker.component.spec.ts"
```

Expected: FAIL, cannot resolve `./scene-folder-picker.component`.

- [ ] **Step 3: Create the component**

`scene-folder-picker.component.ts`:

```ts
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';

import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

/** One folder as the picker lists it, carrying the nesting a flat list cannot show. */
interface FolderRow {
  folder: SceneFolderDto;
  child: boolean;
  parentName: string | null;
}

/** Choosing a shelf. The detail sheet files a finished scene with it; the dialog seeds a new one. */
@Component({
  selector: 'app-scene-folder-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslateModule],
  templateUrl: './scene-folder-picker.component.html',
  styleUrl: './scene-folder-picker.component.css',
  host: {class: 'flex flex-col gap-1.5'},
})
export class SceneFolderPickerComponent {
  readonly guildId = input.required<string>();
  readonly selected = input<string | null>(null);
  /** Null is unfiled. */
  readonly picked = output<string | null>();

  private readonly taxonomy = inject(SceneTaxonomyService);

  protected readonly folderQuery = signal('');

  constructor() {
    effect(() => {
      const guildId = this.guildId();
      untracked(() => this.taxonomy.ensureGuild(guildId));
    });
  }

  private readonly folders = computed(() => this.taxonomy.folders(this.guildId()));

  /** Every parent in order, each followed by its own children. */
  private readonly folderRows = computed<FolderRow[]>(() => {
    const all = this.folders();
    const rows: FolderRow[] = [];
    const placed = new Set<string>();

    for (const parent of all.filter(f => !f.parentFolderId)) {
      rows.push({folder: parent, child: false, parentName: null});
      placed.add(parent.id);
      for (const child of all.filter(f => f.parentFolderId === parent.id)) {
        rows.push({folder: child, child: true, parentName: parent.name});
        placed.add(child.id);
      }
    }

    // A folder whose parent is not in the local copy would otherwise drop out of the picker.
    for (const folder of all) {
      if (!placed.has(folder.id)) rows.push({folder, child: false, parentName: null});
    }
    return rows;
  });

  protected readonly folderMatches = computed(() => {
    const query = this.folderQuery().trim().toLowerCase();
    if (!query) return this.folderRows();
    return this.folderRows().filter(
      row => row.folder.name.toLowerCase().includes(query) || !!row.parentName?.toLowerCase().includes(query),
    );
  });

  protected readonly searching = computed(() => !!this.folderQuery().trim());

  protected choose(folderId: string | null): void {
    this.folderQuery.set('');
    this.picked.emit(folderId);
  }
}
```

`scene-folder-picker.component.html`:

```html
<label class="pick-search">
  <i aria-hidden="true" class="pi pi-search text-[0.625rem]"></i>
  <input
    (ngModelChange)="folderQuery.set($event)"
    [ngModel]="folderQuery()"
    [placeholder]="'SCENE.ARCHIVE.FOLDER_SEARCH' | translate"
    type="search"
  />
</label>

<div class="pick-rows thin-scrollbar">
  @if (!searching()) {
  <button (click)="choose(null)" [class.is-current]="selected() === null" class="pick-row" type="button">
    {{ 'SCENE.ARCHIVE.UNFILED' | translate }}
  </button>
  } @for (row of folderMatches(); track row.folder.id) {
  <button
    (click)="choose(row.folder.id)"
    [class.is-child]="row.child && !searching()"
    [class.is-current]="selected() === row.folder.id"
    class="pick-row"
    type="button"
  >
    @if (row.folder.icon) {
    <span>{{ row.folder.icon }}</span>
    } @if (row.parentName && searching()) {
    <span class="pick-parent">{{ row.parentName }} /</span>
    }
    <span class="truncate">{{ row.folder.name }}</span>
  </button>
  } @if (!folderMatches().length) {
  <span class="pick-empty">{{ 'SCENE.ARCHIVE.NO_FOLDER_MATCH' | translate }}</span>
  }
</div>
```

- [ ] **Step 4: Move the picker's CSS across**

Open `scene-detail-sheet.component.css`, find the `.sheet-pick-search`, `.sheet-pick-rows`, `.sheet-pick-row`, `.sheet-pick-parent` rules (and the `.is-current` / `.is-child` modifiers on them). Copy them into `scene-folder-picker.component.css`, renaming the `sheet-pick` prefix to `pick`:

- `.sheet-pick-search` becomes `.pick-search`
- `.sheet-pick-rows` becomes `.pick-rows`
- `.sheet-pick-row` becomes `.pick-row`
- `.sheet-pick-parent` becomes `.pick-parent`

Add one rule the sheet did not need:

```css
.pick-empty {
  padding: 0.25rem 0.5rem;
  font-size: 0.6875rem;
  color: var(--color-text-faint);
}
```

Delete the copied rules from `scene-detail-sheet.component.css`. Leave `.sheet-pick` (the toggle button) where it is: the sheet still owns that.

- [ ] **Step 5: Point the sheet at the new component**

In `scene-detail-sheet.component.html`, replace the block from `@if (picking()) {` through its closing brace (lines 101 to 142) with:

```html
@if (picking()) {
<app-scene-folder-picker
  (picked)="file($event)"
  [guildId]="guildId()"
  [selected]="folder()?.id ?? null"
  class="sheet-pick-list"
/>
}
```

In `scene-detail-sheet.component.ts`:

- Add `import {SceneFolderPickerComponent} from './scene-folder-picker.component';`
- Add `SceneFolderPickerComponent` to the component's `imports` array.
- Delete the now-unused `FolderRow` interface, the `folderQuery` signal, the `folderRows` computed, the `folderMatches` computed, and the `searchingFolders` computed.
- In `file()` and `togglePicking()`, delete the `this.folderQuery.set('')` lines.
- Remove any import that is now unused. `bun run lint` will name them.

- [ ] **Step 6: Run the picker spec and the whole suite**

```bash
bun run ng test --watch=false --include="**/scene-folder-picker.component.spec.ts"
bun run test 2>&1 | tail -20
```

Expected: the picker spec PASSes with 4 tests, and the full suite does not drop below the Task 5 baseline.

- [ ] **Step 7: Check the sheet still renders**

```bash
bun run ng build --configuration development
```

Expected: build succeeds with no template errors.

- [ ] **Step 8: Lint, format, commit**

```bash
bun run prettier --write src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.ts src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.html src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.css src/app/features/guild/scenes/scene-archive/scene-folder-picker.component.spec.ts src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.ts src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.html src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.css
bun run lint
git add src/app/features/guild/scenes/scene-archive/
git commit -m "refactor(scenes): lift the folder picker out of the detail sheet"
```

---

### Task 8: The archive feeds the tree

**Files:**

- Modify: `src/app/features/guild/scenes/scene-archive/scene-archive.component.ts`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-archive.component.html`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-archive.component.css`

**Interfaces:**

- Consumes: `ArchiveStatus`, `peek`, `peeked`, `peekLoading` (Task 4); `SceneRailStateService` (Task 3); `leavesByFolder`, `recentScenes`, `SceneLeaf` (Task 2); the rail's new inputs and outputs (Task 6).
- Produces: `createSceneIn = output<string | null>()` on `SceneArchiveComponent`, which Task 10 wires to the dialog.

- [ ] **Step 1: Add the status filter, the rail state, and the leaf plumbing**

In `scene-archive.component.ts`, add to the imports:

```ts
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {SceneService} from '../../../../services/scene.service';
import {ArchiveStatus} from '../../../../services/scene-archive.service';
import {leavesByFolder, recentScenes, SceneLeaf} from '../scene-leaf';
import {NavigationService} from '../../../main-page/navigation.service';
```

`SceneService` is already injected as `private readonly scenes`. Add the new output and state:

```ts
    /** The folder a new scene should open in, for the board to act on: the dialog lives there. */
    readonly createSceneIn = output<string | null>();

    private readonly railState = inject(SceneRailStateService);
    private readonly nav = inject(NavigationService);
    private readonly guilds = inject(GuildService);

    protected readonly status = signal<ArchiveStatus>('all');
```

Add `output` to the `@angular/core` import list and `GuildService` to the service imports.

Feed the status into the filter effect, beside the other fields:

```ts
effect(() => {
  const filter = {
    guildId: this.guildId(),
    folderId: this.folderId(),
    tagIds: this.tagIds(),
    q: this.settledQuery(),
    sort: this.sort(),
    status: this.status(),
  };
  untracked(() => this.archive.apply(filter));
});
```

- [ ] **Step 2: Read every open shelf**

Add an effect in the constructor, after the existing two:

```ts
// Every open shelf reads its own page. The service dedupes, so reopening one is free.
effect(() => {
  const guildId = this.guildId();
  const status = this.status();
  const open = this.railState.expanded(guildId);
  untracked(() => {
    for (const folderId of open) this.archive.peek(guildId, folderId, status);
  });
});
```

And the selectors the rail reads:

```ts
    protected readonly expandedIds = computed(() => this.railState.expanded(this.guildId()));

    protected readonly loadingFolderIds = computed(() =>
        this.expandedIds().filter(id => this.archive.peekLoading(this.guildId(), id, this.status())),
    );

    protected readonly scenesByFolder = computed((): Record<string, SceneLeaf[]> => {
        const guildId = this.guildId();
        const status = this.status();
        const speakable = this.scenes.speakableIds(guildId);
        const grouped: Record<string, SceneLeaf[]> = {};
        for (const folderId of this.expandedIds()) {
            grouped[folderId] = leavesByFolder(this.archive.peeked(guildId, folderId, status), speakable)[folderId] ?? [];
        }
        return grouped;
    });

    protected readonly recent = computed(() =>
        recentScenes(this.scenes.scenes(this.guildId()), this.scenes.speakableIds(this.guildId())),
    );
```

- [ ] **Step 3: Add the handlers**

```ts
    protected toggleShelf(folderId: string): void {
        this.railState.toggle(this.guildId(), folderId);
    }

    protected openScene(channelId: string): void {
        const channel = this.guilds.guilds().find(g => g.id === this.guildId())?.channels.find(c => c.id === channelId);
        if (!channel) {
            this.toast.error(this.translate.instant('SCENE.ARCHIVE.OPEN_ERROR'));
            return;
        }
        this.nav.openChannel(channel);
    }

    protected readonly statusItems = computed<MenuItem[]>(() =>
        (['all', 'running', 'finished'] as ArchiveStatus[]).map(value => ({
            label: this.translate.instant(STATUS_LABELS[value]),
            icon: this.status() === value ? 'pi pi-check' : 'pi pi-fw',
            command: () => this.status.set(value),
        })),
    );

    protected readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
```

Beside `SORT_LABELS` at the top of the file:

```ts
const STATUS_LABELS: Record<ArchiveStatus, string> = {
  all: 'SCENE.ARCHIVE.STATUS_ALL',
  running: 'SCENE.ARCHIVE.STATUS_RUNNING',
  finished: 'SCENE.ARCHIVE.STATUS_FINISHED',
};
```

Add the guild's scenes to the existing guild effect so `recent` has something to read:

```ts
effect(() => {
  const guildId = this.guildId();
  untracked(() => {
    this.taxonomy.ensureGuild(guildId);
    this.scenes.ensureGuild(guildId);
  });
});
```

- [ ] **Step 4: Wire the rail in the template**

In `scene-archive.component.html`, replace the `<app-scene-folder-rail ... />` element with:

```html
<app-scene-folder-rail
  (createFolder)="editing.set({folder: null, seedParentId: $event})"
  (createScene)="createSceneIn.emit($event)"
  (deleteFolder)="editing.set({folder: $event.folder, seedParentId: null})"
  (filed)="file($event.channelId, $event.folderId)"
  (openScene)="openScene($event)"
  (picked)="folderId.set($event)"
  (renameFolder)="editing.set({folder: $event.folder, seedParentId: null})"
  (reordered)="reorder($event)"
  (showAll)="folderId.set($event)"
  (toggled)="toggleShelf($event)"
  [canManage]="canManage()"
  [expandedIds]="expandedIds()"
  [loadingFolderIds]="loadingFolderIds()"
  [recent]="recent()"
  [scenesByFolder]="scenesByFolder()"
  [selected]="folderId()"
  [tree]="tree()"
/>
```

- [ ] **Step 5: Add the status control to the filter bar**

In the same file, immediately after the sort button:

```html
<button (click)="statusMenu.toggle($event)" class="archive-clear archive-sort" type="button">
  {{ statusLabel() | translate }}
  <i class="pi pi-chevron-down text-[0.5rem]"></i>
</button>
```

And beside the existing `<p-menu #sortMenu ... />`:

```html
<p-menu #statusMenu [model]="statusItems()" [popup]="true" appendTo="body" />
```

- [ ] **Step 6: Widen the rail for the shelves**

In `scene-archive.component.css`, find `.archive-rail` and raise its width by `0.75rem` (a shelf header carries a count that the old flat rows did not). If it reads `width: 11rem`, make it `11.75rem`.

- [ ] **Step 7: Build and run the suite**

```bash
bun run ng build --configuration development
bun run test 2>&1 | tail -20
```

Expected: build succeeds, suite at or above the Task 5 baseline.

- [ ] **Step 8: Lint, format, commit**

```bash
bun run prettier --write src/app/features/guild/scenes/scene-archive/scene-archive.component.ts src/app/features/guild/scenes/scene-archive/scene-archive.component.html src/app/features/guild/scenes/scene-archive/scene-archive.component.css
bun run lint
git add src/app/features/guild/scenes/scene-archive/
git commit -m "feat(scenes): show scenes and a status filter in the archive rail"
```

---

### Task 9: Creating a scene into a folder

**Files:**

- Modify: `src/app/features/guild/scenes/scene-dialog/scene-dialog.component.ts`
- Modify: `src/app/features/guild/scenes/scene-dialog/scene-dialog.component.html`
- Test: `src/app/features/guild/scenes/scene-dialog/scene-dialog.component.spec.ts`

**Interfaces:**

- Consumes: `SceneFolderPickerComponent` (Task 7), `SCENE.TOAST.CREATED_NOT_FILED` (Task 1).
- Produces: `seedFolderId = input<string | null>(null)` on `SceneDialogComponent`.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/scenes/scene-dialog/scene-dialog.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {SceneDialogComponent} from './scene-dialog.component';
import {SceneService} from '../../../../services/scene.service';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

function created(): SceneDto {
  return {
    channelId: 'ch_new',
    guildId: 'g1',
    name: 'The Ford at Dawn',
    status: SceneStatus.Open,
    turnOrder: ['p1'],
    participants: [],
  };
}

function channel(): ChannelDto {
  return {id: 'home', name: 'roleplay', type: ChannelType.Text, guildId: 'g1'} as ChannelDto;
}

function setup(fileResult: 'ok' | 'fail' = 'ok') {
  const scenes = {
    create: vi.fn(() => of(created())),
    update: vi.fn(() => (fileResult === 'ok' ? of(created()) : throwError(() => new Error('nope')))),
  };
  const toast = {success: vi.fn(), warn: vi.fn(), httpError: vi.fn()};
  const personas = {
    ensureCast: () => undefined,
    ensureGuildCast: () => undefined,
    guildCast: () => [],
    isGuildCastLoading: () => false,
    identity: () => null,
  };

  TestBed.configureTestingModule({
    imports: [SceneDialogComponent],
    providers: [
      provideTranslateService(),
      {provide: SceneService, useValue: scenes},
      {provide: PersonaService, useValue: personas},
      {provide: ToastService, useValue: toast},
    ],
  });

  const fixture: ComponentFixture<SceneDialogComponent> = TestBed.createComponent(SceneDialogComponent);
  fixture.componentRef.setInput('guildId', 'g1');
  fixture.componentRef.setInput('guildChannels', [channel()]);
  fixture.detectChanges();

  const component = fixture.componentInstance as unknown as {
    name: {set: (v: string) => void};
    order: {set: (v: string[]) => void};
    save: (start: boolean) => void;
  };
  component.name.set('The Ford at Dawn');
  component.order.set(['p1']);

  return {fixture, component, scenes, toast};
}

describe('SceneDialogComponent creating into a folder', () => {
  it('does not file when no folder was seeded', () => {
    const {component, scenes} = setup();

    component.save(false);

    expect(scenes.create).toHaveBeenCalledOnce();
    expect(scenes.update).not.toHaveBeenCalled();
  });

  it('files the scene it just created', () => {
    const {fixture, component, scenes} = setup();
    fixture.componentRef.setInput('seedFolderId', 'f1');

    component.save(false);

    expect(scenes.update).toHaveBeenCalledWith('g1', 'ch_new', {folderId: 'f1'});
  });

  it('reports a created scene even when filing it failed', () => {
    const {fixture, component, toast} = setup('fail');
    fixture.componentRef.setInput('seedFolderId', 'f1');

    component.save(false);

    // The scene exists. Calling this a failed create would send the GM to make a second one.
    expect(toast.warn).toHaveBeenCalled();
    expect(toast.httpError).not.toHaveBeenCalled();
  });

  it('closes after a create that could not be filed', () => {
    const {fixture, component} = setup('fail');
    fixture.componentRef.setInput('seedFolderId', 'f1');
    const closes: unknown[] = [];
    fixture.componentInstance.closed.subscribe(() => closes.push(1));

    component.save(false);

    expect(closes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run ng test --watch=false --include="**/scene-dialog.component.spec.ts"
```

Expected: FAIL. `seedFolderId` is not an input, and `update` is never called.

- [ ] **Step 3: Confirm `ToastService` has a `warn`**

```bash
grep -n "warn\|success\|error" src/app/services/toast.service.ts | head
```

If there is no `warn`, use whatever the service calls its non-fatal notice, and change the spec's `toast.warn` to match. Do not add a method to `ToastService` for this.

- [ ] **Step 4: Add the input and the picker**

In `scene-dialog.component.ts`, add imports:

```ts
import {catchError, of, switchMap, tap} from 'rxjs';
import {SceneFolderPickerComponent} from '../scene-archive/scene-folder-picker.component';
```

Add `SceneFolderPickerComponent` to the component's `imports` array, and the input beside the others:

```ts
    /** The shelf a new scene should land on. Only read when creating. */
    readonly seedFolderId = input<string | null>(null);
```

Add the working copy and the picker toggle:

```ts
    protected readonly folderId = signal<string | null>(null);
    protected readonly pickingFolder = signal(false);

    protected chooseFolder(folderId: string | null): void {
        this.folderId.set(folderId);
        this.pickingFolder.set(false);
    }

    protected readonly folderName = computed(
        () => this.taxonomy.folder(this.guildId(), this.folderId())?.name ?? null,
    );
```

Inject the taxonomy service beside the others:

```ts
    private readonly taxonomy = inject(SceneTaxonomyService);
```

with `import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';`.

Seed the working copy once, in the constructor:

```ts
effect(() => {
  const seed = this.seedFolderId();
  untracked(() => {
    if (!this.seededFolder) {
      this.seededFolder = true;
      this.folderId.set(seed);
    }
  });
});
```

with the private field `private seededFolder = false;` beside `private seeded = false;`.

- [ ] **Step 5: File the scene after creating it**

In `save()`, replace the `create` branch of the `work` assignment:

```ts
            : this.scenes
                  .create(this.guildId(), this.home() ?? '', {
                      name: this.name().trim(),
                      description: this.description().trim() || null,
                      oocName: this.oocName().trim() || null,
                      participantPersonaIds: this.order(),
                      turnOrder: this.order(),
                      turnLengthHours: this.deadlineHours(),
                      status: start ? SceneStatus.Active : SceneStatus.Open,
                  })
                  .pipe(switchMap(scene => this.fileNew(scene)));
```

And add the helper below `save()`:

```ts
    /**
     * Filing is a second call, so it can fail on its own. The scene still exists when it does, and
     * reporting that as a failed create sends the game master off to make a duplicate.
     */
    private fileNew(scene: SceneDto): Observable<SceneDto> {
        const folderId = this.folderId();
        if (!folderId) return of(scene);
        return this.scenes.update(this.guildId(), scene.channelId, {folderId}).pipe(
            catchError(() => {
                this.toast.warn(this.translate.instant('SCENE.TOAST.CREATED_NOT_FILED'));
                return of(scene);
            }),
        );
    }
```

Add `Observable` to the rxjs import. Delete `tap` from the import list if you did not use it.

- [ ] **Step 6: Show the folder in the dialog**

In `scene-dialog.component.html`, add above the actions row, inside the create branch only (guard it with `@if (!isEdit())`):

```html
@if (!isEdit()) {
<div class="dialog-field">
  <span class="dialog-label">{{ 'SCENE.ARCHIVE.FILE_INTO' | translate }}</span>
  <button (click)="pickingFolder.set(!pickingFolder())" class="dialog-folder" type="button">
    <span>{{ folderName() ?? ('SCENE.ARCHIVE.UNFILED' | translate) }}</span>
    <i class="pi pi-chevron-down text-[0.5rem]"></i>
  </button>

  @if (pickingFolder()) {
  <app-scene-folder-picker (picked)="chooseFolder($event)" [guildId]="guildId()" [selected]="folderId()" />
  }
</div>
}
```

Match `dialog-field` and `dialog-label` to whatever class names the surrounding fields in that template already use. Read the file before writing; do not invent class names. Add a `.dialog-folder` rule to `scene-dialog.component.css` mirroring the sheet's `.sheet-pick` button.

- [ ] **Step 7: Run the tests**

```bash
bun run ng test --watch=false --include="**/scene-dialog.component.spec.ts"
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Build, lint, format, commit**

```bash
bun run ng build --configuration development
bun run prettier --write src/app/features/guild/scenes/scene-dialog/
bun run lint
git add src/app/features/guild/scenes/scene-dialog/
git commit -m "feat(scenes): file a new scene on the folder it was created from"
```

---

### Task 10: The playing screen gets the rail

**Files:**

- Modify: `src/app/features/guild/scenes/scene-board/scene-board.component.ts`
- Modify: `src/app/features/guild/scenes/scene-board/scene-board.component.html`
- Modify: `src/app/features/guild/scenes/scene-board/scene-board.component.css`
- Test: `src/app/features/guild/scenes/scene-board/scene-board.component.spec.ts`

**Interfaces:**

- Consumes: everything from Tasks 2, 3, 6, 8, 9.
- Produces: nothing downstream.

`SceneGroup` gains two optional fields. Its existing `key`, `titleKey`, `tone`, `rows` are unchanged, so the template's current rendering keeps working.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/scenes/scene-board/scene-board.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it} from 'vitest';

import {SceneBoardComponent, SceneGroup} from './scene-board.component';
import {SceneService} from '../../../../services/scene.service';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {PersonaService} from '../../../../services/persona.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {SceneFolderDto, SceneListItemDto, SceneStatus} from '../../../../dtos/response/scene.dto';

function scene(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
  return {channelId: 'ch_1', name: 'Scene', status: SceneStatus.Active, ...over};
}

function folder(id: string, name: string, position = 0): SceneFolderDto {
  return {id, guildId: 'g1', name, position, parentFolderId: null};
}

const SCENES = [
  scene({channelId: 'mine', name: 'The Ford at Dawn', folderId: 'a', currentTurnPersonaId: 'p1'}),
  scene({channelId: 'other', name: 'Nightwatch', folderId: 'a'}),
  scene({channelId: 'second', name: 'The Burning Gate', folderId: 'b'}),
  scene({channelId: 'loose', name: 'Council of Crows'}),
];

function setup() {
  TestBed.configureTestingModule({
    imports: [SceneBoardComponent],
    providers: [
      provideTranslateService(),
      {
        provide: SceneService,
        useValue: {
          scenes: () => SCENES,
          speakableIds: () => new Set(['p1']),
          now: () => 0,
          isLoading: () => false,
          ensureGuild: () => undefined,
        },
      },
      {
        provide: SceneTaxonomyService,
        useValue: {
          folders: () => [folder('a', 'Act I', 0), folder('b', 'Act II', 1)],
          ensureGuild: () => undefined,
        },
      },
      {provide: PersonaService, useValue: {identity: () => null}},
      {
        provide: GuildService,
        useValue: {guilds: () => [{id: 'g1', channels: []}], getOwnMember: () => of(null)},
      },
      {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'u1'})}},
    ],
  });

  const fixture: ComponentFixture<SceneBoardComponent> = TestBed.createComponent(SceneBoardComponent);
  fixture.componentRef.setInput('guildId', 'g1');
  fixture.detectChanges();
  return {fixture, component: fixture.componentInstance as unknown as {groups: () => SceneGroup[]}};
}

describe('SceneBoardComponent grouping', () => {
  beforeEach(() => localStorage.clear());

  it('groups by status while the rail is hidden', () => {
    const {component} = setup();

    expect(component.groups().map(g => g.key)).toEqual(['yours', 'running']);
  });

  it('groups by folder once the rail is shown', () => {
    const {fixture, component} = setup();
    TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
    fixture.detectChanges();

    const keys = component.groups().map(g => g.key);
    expect(keys[0]).toBe('yours');
    expect(keys).toContain('folder:a');
    expect(keys).toContain('folder:b');
    expect(keys.at(-1)).toBe('unfiled');
  });

  it('does not repeat a pinned scene inside its folder section', () => {
    const {fixture, component} = setup();
    TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
    fixture.detectChanges();

    const actOne = component.groups().find(g => g.key === 'folder:a');
    expect(actOne?.rows.map(r => r.scene.channelId)).toEqual(['other']);
  });

  it('names the folder a pinned scene came from', () => {
    const {fixture, component} = setup();
    TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
    fixture.detectChanges();

    const yours = component.groups().find(g => g.key === 'yours');
    expect(yours?.rows[0].folderPath).toBe('Act I');
  });

  it('shows only the chosen folder when one is selected', () => {
    const {fixture, component} = setup();
    TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
    (fixture.componentInstance as unknown as {folderId: {set: (v: string | null) => void}}).folderId.set('b');
    fixture.detectChanges();

    const keys = component.groups().map(g => g.key);
    expect(keys).toEqual(['folder:b']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run ng test --watch=false --include="**/scene-board.component.spec.ts"
```

Expected: FAIL on the folder grouping and on `folderPath` not existing.

- [ ] **Step 3: Extend the row and group models**

In `scene-board.component.ts`:

```ts
export interface SceneRow {
  scene: SceneListItemDto;
  identity: PersonaIdentity | null;
  clock: ReturnType<typeof turnClock>;
  mine: boolean;
  /** Named only on a pinned row, which sits outside the folder section it belongs to. */
  folderPath?: string | null;
}

export interface SceneGroup {
  key: string;
  titleKey: string;
  tone: 'yours' | 'attention' | 'normal' | 'quiet';
  rows: SceneRow[];
  /** Set on a folder section: its own name, which no translation key can carry. */
  title?: string;
  accent?: string | null;
}
```

- [ ] **Step 4: Add the rail state, the folder selection, and the tree**

Add the imports:

```ts
import {SceneFolderRailComponent} from '../scene-archive/scene-folder-rail.component';
import {countByFolder, folderTree} from '../scene-archive/folder-tree';
import {leavesByFolder, recentScenes} from '../scene-leaf';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
```

Add `SceneFolderRailComponent` to the component's `imports` array. Then:

```ts
    private readonly railState = inject(SceneRailStateService);
    private readonly taxonomy = inject(SceneTaxonomyService);

    protected readonly folderId = signal<string | null>(null);
    protected readonly seedFolderId = signal<string | null>(null);

    protected readonly railVisible = computed(() => this.railState.railVisible(this.guildId()));

    protected readonly tree = computed(() =>
        folderTree(this.taxonomy.folders(this.guildId()), countByFolder(this.scenes.scenes(this.guildId()))),
    );

    protected readonly expandedIds = computed(() => this.railState.expanded(this.guildId()));

    protected readonly scenesByFolder = computed(() =>
        leavesByFolder(this.scenes.scenes(this.guildId()), this.scenes.speakableIds(this.guildId())),
    );

    protected readonly recent = computed(() =>
        recentScenes(this.scenes.scenes(this.guildId()), this.scenes.speakableIds(this.guildId())),
    );

    protected toggleRail(): void {
        this.railState.setRailVisible(this.guildId(), !this.railVisible());
    }

    protected toggleShelf(folderId: string): void {
        this.railState.toggle(this.guildId(), folderId);
    }

    protected openScene(channelId: string): void {
        const channel = this.guild()?.channels.find(c => c.id === channelId);
        if (!channel) {
            this.toast.error(this.translate.instant('SCENE.BOARD.OPEN_FAILED'));
            return;
        }
        this.nav.openChannel(channel);
    }

    protected createIn(folderId: string | null): void {
        this.seedFolderId.set(folderId);
        this.creating.set(true);
    }
```

Load the taxonomy in the existing guild effect, beside `ensureGuild`:

```ts
this.taxonomy.ensureGuild(guildId);
```

- [ ] **Step 5: Make the grouping conditional**

Replace the whole `groups` computed:

```ts
    protected readonly groups = computed((): SceneGroup[] => {
        const rows = this.rows();
        const yours = rows.filter(row => row.mine);
        const taken = new Set(yours.map(row => row.scene.channelId));

        const stalled = this.canManage()
            ? rows.filter(
                  row =>
                      !taken.has(row.scene.channelId) &&
                      row.scene.status === SceneStatus.Active &&
                      (row.scene.nudgeCount ?? 0) >= 2,
              )
            : [];
        stalled.forEach(row => taken.add(row.scene.channelId));

        return this.railVisible() && this.tree().length
            ? this.folderGroups(rows, yours, stalled, taken)
            : this.statusGroups(rows, yours, stalled, taken);
    });

    private statusGroups(
        rows: SceneRow[],
        yours: SceneRow[],
        stalled: SceneRow[],
        taken: Set<string>,
    ): SceneGroup[] {
        const of = (status: SceneStatus) =>
            rows.filter(row => !taken.has(row.scene.channelId) && row.scene.status === status);

        return [
            {key: 'yours', titleKey: 'SCENE.BOARD.YOUR_MOVE', tone: 'yours', rows: yours},
            {key: 'stalled', titleKey: 'SCENE.BOARD.STALLED', tone: 'attention', rows: stalled},
            {key: 'running', titleKey: 'SCENE.BOARD.RUNNING', tone: 'normal', rows: of(SceneStatus.Active)},
            {key: 'open', titleKey: 'SCENE.BOARD.OPENING', tone: 'normal', rows: of(SceneStatus.Open)},
            {key: 'paused', titleKey: 'SCENE.BOARD.PAUSED', tone: 'quiet', rows: of(SceneStatus.Paused)},
            // No concluded group: a finished scene belongs to the archive.
        ].filter(group => group.rows.length > 0) as SceneGroup[];
    }

    /** Your move and stalled keep the top. Everything else reads as the campaign it belongs to. */
    private folderGroups(
        rows: SceneRow[],
        yours: SceneRow[],
        stalled: SceneRow[],
        taken: Set<string>,
    ): SceneGroup[] {
        const chosen = this.folderId();
        const wanted = chosen ? this.subtreeOf(chosen) : null;
        const names = this.folderNames();
        const path = (row: SceneRow) => (row.scene.folderId ? (names.get(row.scene.folderId) ?? null) : null);

        const pinned: SceneGroup[] = chosen
            ? []
            : [
                  {
                      key: 'yours',
                      titleKey: 'SCENE.BOARD.YOUR_MOVE',
                      tone: 'yours',
                      rows: yours.map(row => ({...row, folderPath: path(row)})),
                  },
                  {
                      key: 'stalled',
                      titleKey: 'SCENE.BOARD.STALLED',
                      tone: 'attention',
                      rows: stalled.map(row => ({...row, folderPath: path(row)})),
                  },
              ];

        const sections: SceneGroup[] = [];
        for (const node of flattenTree(this.tree())) {
            if (wanted && !wanted.has(node.folder.id)) continue;
            sections.push({
                key: `folder:${node.folder.id}`,
                titleKey: '',
                title: node.folder.name,
                accent: node.folder.color,
                tone: 'normal',
                rows: rows.filter(
                    row => !taken.has(row.scene.channelId) && row.scene.folderId === node.folder.id,
                ),
            });
        }

        const unfiled: SceneGroup = {
            key: 'unfiled',
            titleKey: 'SCENE.BOARD.FOLDER_UNFILED',
            tone: 'quiet',
            rows: chosen ? [] : rows.filter(row => !taken.has(row.scene.channelId) && !row.scene.folderId),
        };

        return [...pinned, ...sections, unfiled].filter(group => group.rows.length > 0);
    }

    /** A folder and everything under it, which is what picking a shelf filters on. */
    private subtreeOf(folderId: string): Set<string> {
        const ids = new Set<string>();
        const walk = (nodes: FolderNode[]): boolean =>
            nodes.some(node => {
                if (node.folder.id === folderId) {
                    collect(node, ids);
                    return true;
                }
                return walk(node.children);
            });
        walk(this.tree());
        return ids;
    }

    private readonly folderNames = computed(() => {
        const names = new Map<string, string>();
        for (const node of flattenTree(this.tree())) names.set(node.folder.id, node.folder.name);
        return names;
    });
```

At the bottom of the file, beside any other module functions:

```ts
/** Every node depth first, parents before their children. */
function flattenTree(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap(node => [node, ...flattenTree(node.children)]);
}

function collect(node: FolderNode, into: Set<string>): void {
  into.add(node.folder.id);
  for (const child of node.children) collect(child, into);
}
```

Add `import {FolderNode} from '../scene-archive/folder-tree';` to the folder-tree import line.

- [ ] **Step 6: Add the rail and the toggle to the template**

In `scene-board.component.html`, add the toggle in the header, immediately after the mode buttons:

```html
@if (mode() === 'playing' && tree().length) {
<button
  (click)="toggleRail()"
  [attr.aria-pressed]="railVisible()"
  [class.is-on]="railVisible()"
  class="board-rail-toggle"
  type="button"
>
  <i class="pi pi-folder text-[0.5625rem]"></i>
  {{ 'SCENE.ARCHIVE.SHOW_FOLDERS' | translate }}
</button>
}
```

Wrap the playing branch's scroller in a flex row with the rail:

```html
} @else {
<div class="flex min-h-0 flex-1 overflow-hidden">
  @if (railVisible() && tree().length) {
  <aside class="board-rail thin-scrollbar">
    <app-scene-folder-rail
      (createScene)="createIn($event)"
      (openScene)="openScene($event)"
      (picked)="folderId.set($event)"
      (showAll)="folderId.set($event)"
      (toggled)="toggleShelf($event)"
      [canManage]="canManage()"
      [expandedIds]="expandedIds()"
      [recent]="recent()"
      [scenesByFolder]="scenesByFolder()"
      [selected]="folderId()"
      [tree]="tree()"
    />
  </aside>
  }

  <div class="min-h-0 flex-1 overflow-y-auto thin-scrollbar"></div>
</div>
```

and close the extra `</div>` at the end of that branch. Then swap the group heading so a folder section can show its own name:

```html
<h2 [class]="'board-group board-group-' + group.tone" [style.--group-accent]="group.accent">
  {{ group.title ?? (group.titleKey | translate) }}
  <span class="board-group-count">{{ group.rows.length }}</span>
</h2>
```

And name the arc on a pinned row, inside the `board-line` span, after the deadline:

```html
@if (row.folderPath; as arc) {
<span class="board-dot">·</span>
<span class="board-arc">{{ arc }}</span>
}
```

Finally, pass the seed to the dialog:

```html
@if (creating()) {
<app-scene-dialog
  (closed)="creating.set(false); seedFolderId.set(null)"
  [guildChannels]="textChannels()"
  [guildId]="guildId()"
  [seedFolderId]="seedFolderId()"
/>
}
```

And let the archive open it:

```html
<app-scene-archive (createSceneIn)="createIn($event)" [canManage]="canManage()" [guildId]="guildId()" />
```

- [ ] **Step 7: Style the board's rail**

Append to `scene-board.component.css`:

```css
.board-rail {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  flex-shrink: 0;
  width: 11.75rem;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  padding: 0.5625rem 0.4375rem;
  overflow-y: auto;
}

.board-rail-toggle {
  display: flex;
  align-items: center;
  gap: 0.3125rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: 0.4375rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.65625rem;
  font-weight: 600;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background-color var(--duration-base) var(--ease-brand),
    color var(--duration-base) var(--ease-brand);
}

.board-rail-toggle:hover {
  color: var(--color-text-secondary);
}

.board-rail-toggle.is-on {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text-primary);
}

/* A folder section wears its own colour, so the arcs stay apart when several are on screen. */
.board-group[style*='--group-accent'] {
  padding-left: 0.5rem;
  box-shadow: inset 2px 0 0 -1px var(--group-accent);
}

.board-arc {
  color: var(--color-text-faint);
}
```

- [ ] **Step 8: Run the board spec**

```bash
bun run ng test --watch=false --include="**/scene-board.component.spec.ts"
```

Expected: PASS, 5 tests.

- [ ] **Step 9: Build and run the whole suite**

```bash
bun run ng build --configuration development
bun run test 2>&1 | tail -20
```

Expected: build succeeds, suite at or above the Task 5 baseline plus every test added since.

- [ ] **Step 10: Lint, format, commit**

```bash
bun run prettier --write src/app/features/guild/scenes/scene-board/
bun run lint
git add src/app/features/guild/scenes/scene-board/
git commit -m "feat(scenes): give the playing board an optional folder rail"
```

---

## Verification

After Task 10, before reporting done:

- [ ] `bun run test` passes at or above the Task 5 baseline. Paste the count.
- [ ] `bun run lint` is clean.
- [ ] `bun run ng build --configuration development` succeeds.
- [ ] Say plainly what was not verified in a running app. None of these tasks drives the real client, so the visual result of Tasks 6, 8 and 10 is unverified until somebody looks at it.
