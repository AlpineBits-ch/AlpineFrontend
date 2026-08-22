# Profile Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed six-field profile with a four-column grid the owner arranges out of typed widgets, shipping the layout engine, nine widgets, the editor and the read surfaces.

**Architecture:** A pure layout module (`profile-canvas.ts`) owns reflow and validation with no Angular in it, so the whole grid is testable without a DOM. A registry maps a type string to a component and a declarative field list, which is what keeps the renderer and the editor closed to change as widgets are added. The saved document lives in `ProfileCanvasStore`; the unsaved arrangement lives in `CanvasEditorService` because a second window would legitimately show a different draft.

**Tech Stack:** Angular 21 signals, standalone components, NgRx `signalStore`, ngx-translate, Tailwind token classes, Vitest through the Angular CLI.

**Spec:** `docs/superpowers/specs/2026-08-22-profile-canvas-design.md`

## Global Constraints

- Write like a person. No essays, no narrative rationale, no restating the code. Comments only for a silently-violated invariant, a `TODO(owner)`, or naming a non-obvious symbol.
- No em dashes (`—`) anywhere: code, comments, UI copy, commit messages.
- No Javadoc HTML in TSDoc: no `<p>`, `<b>`, `<i>`, `<br>`. Older files in this repo have it; do not copy that.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports: `import {Component, inject} from '@angular/core';`
- `inject()` never constructor params. `input()` / `output()` / `model()` never decorators. `ChangeDetectionStrategy.OnPush` on every new component. Standalone, no NgModules. `@if` / `@for` / `@switch`, never structural directives.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field. Use a getter. Under Vite it reads `undefined` in full-suite runs and passes solo.
- Tests: `bun run test`. Single spec: `bun run ng test --watch=false --include="**/name.spec.ts"`. Lint: `bun run lint`. Never bare `vitest`, never `npx ng`.
- `bun run format` rewrites the whole repo. Format only the files you touched: `bun run prettier --write <paths>`.
- Baseline is green. Do not reduce the passing count.
- i18n: `src/assets/i18n/locales` are ordinary tracked files. Flat dot-separated keys. English only; `de.json` and `fr.json` lag on purpose.
- Commits: conventional prefix, one line, lowercase, imperative. No body, no co-author trailers, no emoji.
- Commit by explicit path, never `git add -A`. Other agents have in-flight work on `main`.
- Work directly on `main`. No worktrees, no feature branches, no `git checkout -b`.
- No destructive git, ever: no `git stash`, `git checkout --`, `git reset --hard`, `git clean`, no force push. The working tree holds other people's live work.
- Unrelated build or test breakage you did not cause is another agent's in-flight work. Do not fix it, do not revert it, say so and carry on.

## Design Bar

UI and UX are the deliverable here, not a finish applied at the end. Clean, extensible code serves that, in that order.

- **A sparse canvas must look deliberate.** No dashed placeholder cells, no "add a widget here" ghosts on someone else's profile, and the grid height follows its content rather than reserving four rows. If five widgets read as unfinished, the feature becomes homework.
- **PrimeNG where it earns its place, hand-rolled otherwise.** Use it for the controls that are genuinely hard: `p-select` with a filter for the time zone list, `p-colorpicker` for the accent, `p-confirmdialog` for discarding a dirty draft. Do not reach for `p-button` where a plain button with token classes is lighter, and do not use `p-dataview` or `p-orderlist` for the widget list: they fight the drag behaviour this needs. That split is the existing house pattern, not a new rule.
- **Hand-rolled reusable pieces are welcome.** If a piece is used twice, lift it. `place-popout.ts` and `guild-roster.ts` are the precedent for pulling logic out of a component and testing it alone.
- **No god objects.** `CanvasEditorService` mutates the draft and nothing else: it does not fetch, does not save, does not upload, does not know about toasts. `ProfileCanvasStore` owns the saved document and does not know what a widget means. The registry knows types; the renderer knows the grid. If a file starts needing a table of contents, it is doing too much.
- **Every widget is a leaf.** A widget component reads its own config and renders. It never reaches into the store, the editor, or a sibling widget.
- **Keyboard parity is not optional.** Anything reachable by drag is reachable by keyboard. This is the only way to author a profile.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/app/dtos/response/profile-canvas.dto.ts` | Wire types. No logic. |
| `src/app/models/profile-canvas.ts` | Reflow, normalise, footprint snapping, config parsing. Pure. |
| `src/app/services/profile-canvas-api.service.ts` | HTTP only. |
| `src/app/stores/profile-canvas.store.ts` | The saved document, keyed by profile id. |
| `src/app/services/canvas-editor.service.ts` | The unsaved draft. Device state. |
| `src/app/components/profile-canvas/widget-registry.ts` | Type to component, footprints, editor fields. |
| `src/app/components/profile-canvas/canvas-backdrop.ts` | Backdrop and accent to safe style values. Pure. |
| `src/app/components/profile-canvas/profile-canvas.component.ts` | The grid. |
| `src/app/components/profile-canvas/widgets/*.component.ts` | One per type. Owns its own config guard. |
| `.../profile-settings/canvas-editor/canvas-editor.component.ts` | Editor shell: insert, remove, reorder, save. |
| `.../profile-settings/canvas-editor/widget-properties.component.ts` | One panel, driven by `fields`. |

## Dependency Order

```
Wave A (parallel):            T1  T2
Wave B (needs T2):            T3  T9        (T4 needs T1 + T2)
Wave C (needs T4):            T5  T6  T7  T8
Wave D (needs T4 + T9):       T10 -> T11
Wave E (needs T3 + T4):       T12  T13
Wave F:                       T14 (needs T4 + T9 + T10)   T15 (needs T3)
```

T15 is independent of everything after T3 and can be pulled forward if the backend event lands early.

- **T1** locale keys and **T2** the pure model touch disjoint files.
- **T4** establishes the widget contract end to end and every later widget task depends on it.
- **T5**, **T6**, **T7**, **T8** each add widget components plus one registry entry each. They touch the same registry file, so land them one at a time or expect a trivial merge in `WIDGET_REGISTRY`.
- **T11** needs T10's editor shell to hang the panel off.

---

### Task 1: Translation keys

**Files:**

- Modify: `src/assets/i18n/locales/en.json`

**Interfaces:**

- Consumes: nothing.
- Produces: every key later UI tasks render. Exact names below, do not invent variants.

- [ ] **Step 1: Add the canvas keys to `en.json`**

Insert beside the existing `PROFILE.*` block. Keep the file's flat dot-separated style and its existing indentation.

```json
  "PROFILE.CANVAS.TAB": "Canvas",
  "PROFILE.CANVAS.EMPTY": "Nothing here yet",
  "PROFILE.CANVAS.WIDGET.QUOTE": "Quote",
  "PROFILE.CANVAS.WIDGET.MARQUEE": "Marquee",
  "PROFILE.CANVAS.WIDGET.LOCAL_TIME": "Local time",
  "PROFILE.CANVAS.WIDGET.OPEN_TO": "Open to",
  "PROFILE.CANVAS.WIDGET.MUTUALS": "Mutuals",
  "PROFILE.CANVAS.WIDGET.CURRENTLY": "Currently",
  "PROFILE.CANVAS.WIDGET.INFOBOX": "Infobox",
  "PROFILE.CANVAS.WIDGET.PHOTO": "Photo",
  "PROFILE.CANVAS.WIDGET.GALLERY": "Gallery",
  "PROFILE.CANVAS.LOCAL_TIME_LABEL": "their time",
  "PROFILE.CANVAS.MUTUALS_COUNT": "{{count}} mutual",
  "PROFILE.CANVAS.MUTUALS_COUNT_ONE": "1 mutual",
  "PROFILE.CANVAS.EDITOR.TITLE": "Canvas",
  "PROFILE.CANVAS.EDITOR.SUBTITLE": "Arrange what people see on your profile",
  "PROFILE.CANVAS.EDITOR.ADD": "Add a widget",
  "PROFILE.CANVAS.EDITOR.REMOVE": "Remove",
  "PROFILE.CANVAS.EDITOR.MOVE_UP": "Move earlier",
  "PROFILE.CANVAS.EDITOR.MOVE_DOWN": "Move later",
  "PROFILE.CANVAS.EDITOR.SAVE": "Save canvas",
  "PROFILE.CANVAS.EDITOR.DISCARD": "Discard changes",
  "PROFILE.CANVAS.EDITOR.SAVED": "Canvas saved",
  "PROFILE.CANVAS.EDITOR.SAVE_FAILED": "The canvas could not be saved",
  "PROFILE.CANVAS.EDITOR.FULL": "You have reached the limit of 20 widgets",
  "PROFILE.CANVAS.EDITOR.TYPE_FULL": "You already have as many of these as you can add",
  "PROFILE.CANVAS.EDITOR.SIZE": "Size",
  "PROFILE.CANVAS.EDITOR.VISIBILITY": "Who can see this",
  "PROFILE.CANVAS.EDITOR.VISIBILITY_EVERYONE": "Everyone",
  "PROFILE.CANVAS.EDITOR.VISIBILITY_FRIENDS": "Friends",
  "PROFILE.CANVAS.EDITOR.VISIBILITY_MUTUALS": "People I share a server with",
  "PROFILE.CANVAS.EDITOR.CARD": "Show in the hover preview",
  "PROFILE.CANVAS.EDITOR.CARD_FULL": "Only two widgets can show in the hover preview",
  "PROFILE.CANVAS.EDITOR.ADD_ROW": "Add a row",
  "PROFILE.CANVAS.EDITOR.REMOVE_ROW": "Remove this row",
  "PROFILE.CANVAS.EDITOR.UPLOAD": "Choose an image",
  "PROFILE.CANVAS.EDITOR.UPLOAD_FAILED": "The image could not be uploaded",
  "PROFILE.CANVAS.FIELD.QUOTE_TEXT": "Quote",
  "PROFILE.CANVAS.FIELD.QUOTE_ATTRIBUTION": "Who said it",
  "PROFILE.CANVAS.FIELD.MARQUEE_TEXT": "Scrolling text",
  "PROFILE.CANVAS.FIELD.TIME_ZONE": "Time zone",
  "PROFILE.CANVAS.FIELD.OPEN_TO_ITEMS": "Things you are open to",
  "PROFILE.CANVAS.FIELD.OPEN_TO_LABEL": "Label",
  "PROFILE.CANVAS.FIELD.OPEN_TO_STATE": "Open",
  "PROFILE.CANVAS.FIELD.CURRENTLY_ROWS": "Rows",
  "PROFILE.CANVAS.FIELD.CURRENTLY_VERB": "Verb",
  "PROFILE.CANVAS.FIELD.CURRENTLY_TEXT": "What",
  "PROFILE.CANVAS.FIELD.INFOBOX_TITLE": "Title",
  "PROFILE.CANVAS.FIELD.INFOBOX_ROWS": "Rows",
  "PROFILE.CANVAS.FIELD.INFOBOX_LABEL": "Label",
  "PROFILE.CANVAS.FIELD.INFOBOX_VALUE": "Value",
  "PROFILE.CANVAS.FIELD.PHOTO_IMAGE": "Image",
  "PROFILE.CANVAS.FIELD.PHOTO_ALT": "Describe the image",
  "PROFILE.CANVAS.FIELD.PHOTO_CAPTION": "Caption",
  "PROFILE.CANVAS.FIELD.GALLERY_ITEMS": "Images"
```

`PROFILE.CANVAS.MUTUALS_COUNT_ONE` is the repo's hand-rolled singular convention. Read it with the `_ONE` suffix when the count is exactly 1; ngx-translate has no plural support here.

- [ ] **Step 2: Verify the file still parses**

Run: `bun run prettier --check src/assets/i18n/locales/en.json`
Expected: passes, or run `bun run prettier --write src/assets/i18n/locales/en.json` and re-check.

- [ ] **Step 3: Commit**

```bash
git add src/assets/i18n/locales/en.json
git commit -m "i18n: add profile canvas keys"
```

---

### Task 2: Wire types and the layout engine

**Files:**

- Create: `src/app/dtos/response/profile-canvas.dto.ts`
- Create: `src/app/models/profile-canvas.ts`
- Test: `src/app/models/profile-canvas.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `ProfileCanvasDto`, `CanvasWidgetDto`, `CanvasVisibility`, `CanvasTheme`, `CanvasBackdrop`, `Footprint`, `CANVAS_COLUMNS`, `MAX_WIDGETS`, `FOOTPRINTS`, `emptyCanvas(profileId)`, `reflow(widgets, columns)`, `snapFootprint(w, h)`, `normalise(canvas, columns?)`, `parseConfig(config, guard)`.

- [ ] **Step 1: Write the DTO file**

Create `src/app/dtos/response/profile-canvas.dto.ts`:

```ts
/** ISO 8601. The server writes it; nothing on the client parses it except a cache buster. */
export type IsoDate = string;

export type CanvasVisibility = 'everyone' | 'friends' | 'mutuals';

export interface CanvasBackdrop {
    kind: 'gradient' | 'image';
    /** Gradient stops. Ignored when kind is 'image'. */
    from?: string;
    to?: string;
    /** Canvas image id. Ignored when kind is 'gradient'. */
    imageId?: string;
}

export interface CanvasTheme {
    /** Widget accent. Null falls back to the profile's accentColor, then the brand. */
    accent: string | null;
    backdrop: CanvasBackdrop | null;
}

export interface CanvasWidgetDto {
    id: string;
    /** Not a union: an unknown type draws nothing rather than breaking the canvas. */
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    visibility: CanvasVisibility;
    /** Drawn in the popout's one column preview. At most two per canvas. */
    card: boolean;
    /** Opaque outside the widget component that owns this type. */
    config: unknown;
}

export interface ProfileCanvasDto {
    profileId: string;
    updatedAt: IsoDate;
    version: number;
    theme: CanvasTheme;
    widgets: CanvasWidgetDto[];
}

/** What PUT sends. The server owns profileId, updatedAt and version. */
export interface CanvasWriteDto {
    theme: CanvasTheme;
    widgets: CanvasWidgetDto[];
}

export interface CanvasImageDto {
    imageId: string;
    url: string;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/app/models/profile-canvas.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {
    CANVAS_COLUMNS,
    MAX_WIDGETS,
    emptyCanvas,
    normalise,
    parseConfig,
    reflow,
    snapFootprint,
} from './profile-canvas';

function widget(id: string, over: Partial<CanvasWidgetDto> = {}): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
        ...over,
    };
}

function canvas(widgets: CanvasWidgetDto[]): ProfileCanvasDto {
    return {
        profileId: 'p1',
        updatedAt: '2026-08-22T00:00:00Z',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets,
    };
}

describe('snapFootprint', () => {
    it('keeps a legal footprint', () => {
        expect(snapFootprint(2, 2)).toEqual({w: 2, h: 2});
    });

    it('snaps an unknown footprint down to the largest that fits inside it', () => {
        expect(snapFootprint(3, 2)).toEqual({w: 2, h: 2});
    });

    it('falls back to the smallest footprint when nothing fits', () => {
        expect(snapFootprint(0, 0)).toEqual({w: 1, h: 1});
    });

    it('rejects a non-integer size', () => {
        expect(snapFootprint(2.5, 1)).toEqual({w: 2, h: 1});
    });
});

describe('reflow', () => {
    it('packs two 2x1 widgets into one row of four columns', () => {
        const out = reflow([widget('a'), widget('b')], 4);
        expect(out.map(v => [v.x, v.y])).toEqual([
            [0, 0],
            [2, 0],
        ]);
    });

    it('wraps to the next row when the current one is full', () => {
        const out = reflow([widget('a'), widget('b'), widget('c')], 4);
        expect(out[2].x).toBe(0);
        expect(out[2].y).toBe(1);
    });

    it('clamps a widget wider than the grid', () => {
        const out = reflow([widget('a', {w: 4})], 2);
        expect(out[0].w).toBe(2);
    });

    it('preserves reading order when it repacks', () => {
        const input = [widget('b', {y: 1}), widget('a', {y: 0})];
        expect(reflow(input, 4).map(v => v.id)).toEqual(['a', 'b']);
    });

    it('fills a gap beside a tall widget rather than leaving a hole', () => {
        const out = reflow([widget('tall', {w: 2, h: 2}), widget('short', {w: 2, h: 1})], 4);
        expect(out[1]).toMatchObject({x: 2, y: 0});
    });

    it('is stable: reflowing its own output changes nothing', () => {
        const once = reflow([widget('a'), widget('b'), widget('c')], 4);
        expect(reflow(once, 4)).toEqual(once);
    });
});

describe('normalise', () => {
    it('drops widgets past the cap', () => {
        const many = Array.from({length: MAX_WIDGETS + 5}, (_, i) => widget(`w${i}`, {w: 1}));
        expect(normalise(canvas(many)).widgets).toHaveLength(MAX_WIDGETS);
    });

    it('coerces a non-object config to an empty object', () => {
        expect(normalise(canvas([widget('a', {config: 'nonsense'})])).widgets[0].config).toEqual({});
    });

    it('snaps an illegal footprint instead of dropping the widget', () => {
        const out = normalise(canvas([widget('a', {w: 3, h: 2})]));
        expect(out.widgets).toHaveLength(1);
        expect(out.widgets[0]).toMatchObject({w: 2, h: 2});
    });

    it('keeps a widget whose type it does not know', () => {
        expect(normalise(canvas([widget('a', {type: 'from-the-future'})])).widgets).toHaveLength(1);
    });

    it('drops a widget with no id', () => {
        expect(normalise(canvas([widget('')])).widgets).toHaveLength(0);
    });

    it('leaves at most two card widgets', () => {
        const cards = [widget('a', {card: true}), widget('b', {card: true}), widget('c', {card: true})];
        expect(normalise(canvas(cards)).widgets.filter(v => v.card)).toHaveLength(2);
    });

    it('defaults to four columns', () => {
        expect(normalise(canvas([widget('a', {w: 4})])).widgets[0].w).toBe(CANVAS_COLUMNS);
    });
});

describe('parseConfig', () => {
    const isQuote = (v: unknown): v is {text: string} =>
        !!v && typeof v === 'object' && typeof (v as {text?: unknown}).text === 'string';

    it('returns the config when the guard passes', () => {
        expect(parseConfig({text: 'hi'}, isQuote)).toEqual({text: 'hi'});
    });

    it('returns null when the guard fails', () => {
        expect(parseConfig({text: 42}, isQuote)).toBeNull();
    });

    it('returns null for a nullish config', () => {
        expect(parseConfig(undefined, isQuote)).toBeNull();
    });
});

describe('emptyCanvas', () => {
    it('is a valid canvas with no widgets', () => {
        const out = emptyCanvas('p9');
        expect(out.profileId).toBe('p9');
        expect(out.widgets).toEqual([]);
        expect(normalise(out)).toEqual(out);
    });
});
```

- [ ] **Step 2b: Run the tests to verify they fail**

Run: `bun run ng test --watch=false --include="**/profile-canvas.spec.ts"`
Expected: FAIL, cannot resolve `./profile-canvas`.

- [ ] **Step 3: Write the layout engine**

Create `src/app/models/profile-canvas.ts`:

```ts
import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';

export const CANVAS_COLUMNS = 4;
export const MAX_WIDGETS = 20;
export const MAX_CARD_WIDGETS = 2;

export interface Footprint {
    w: number;
    h: number;
}

/** The only shapes that validate. Ordered small to large; snapFootprint relies on that. */
export const FOOTPRINTS: readonly Footprint[] = [
    {w: 1, h: 1},
    {w: 2, h: 1},
    {w: 2, h: 2},
    {w: 4, h: 1},
    {w: 4, h: 2},
];

export function emptyCanvas(profileId: string): ProfileCanvasDto {
    return {
        profileId,
        updatedAt: '',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets: [],
    };
}

/** The largest legal footprint that fits inside the requested one, or the smallest if none does. */
export function snapFootprint(w: number, h: number): Footprint {
    const width = Math.floor(w);
    const height = Math.floor(h);
    let best: Footprint = FOOTPRINTS[0];
    for (const candidate of FOOTPRINTS) {
        if (candidate.w <= width && candidate.h <= height) best = candidate;
    }
    return {...best};
}

function byReadingOrder(a: CanvasWidgetDto, b: CanvasWidgetDto): number {
    return a.y - b.y || a.x - b.x;
}

function fits(taken: Set<string>, x: number, y: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            if (taken.has(`${x + dx},${y + dy}`)) return false;
        }
    }
    return true;
}

/**
 * Packs widgets into `columns`, first free cell wins. Array order out is reading order, which is
 * what lets the editor move an array element and leave x and y to be derived.
 */
export function reflow(widgets: CanvasWidgetDto[], columns: number): CanvasWidgetDto[] {
    const taken = new Set<string>();
    const placed: CanvasWidgetDto[] = [];

    for (const widget of [...widgets].sort(byReadingOrder)) {
        const w = Math.min(widget.w, columns);
        const h = widget.h;

        let x = 0;
        let y = 0;
        // Bounded: every row past the widget count is empty, so this always terminates.
        for (y = 0; ; y++) {
            const free = [...Array(columns - w + 1).keys()].find(candidate =>
                fits(taken, candidate, y, w, h),
            );
            if (free !== undefined) {
                x = free;
                break;
            }
        }

        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) taken.add(`${x + dx},${y + dy}`);
        }
        placed.push({...widget, x, y, w});
    }

    return placed;
}

/** The one gate every canvas passes through, on read and on write. */
export function normalise(canvas: ProfileCanvasDto, columns = CANVAS_COLUMNS): ProfileCanvasDto {
    let cardsLeft = MAX_CARD_WIDGETS;

    const widgets = canvas.widgets
        .filter(widget => !!widget?.id && typeof widget.type === 'string' && widget.type.length > 0)
        .slice(0, MAX_WIDGETS)
        .map(widget => {
            const footprint = snapFootprint(widget.w, widget.h);
            const card = widget.card && cardsLeft > 0;
            if (card) cardsLeft--;
            return {
                ...widget,
                ...footprint,
                card,
                config: widget.config && typeof widget.config === 'object' ? widget.config : {},
            };
        });

    return {...canvas, widgets: reflow(widgets, columns)};
}

/** A config that fails its widget's guard renders as an empty cell, never as a thrown error. */
export function parseConfig<T>(config: unknown, guard: (value: unknown) => value is T): T | null {
    return guard(config) ? config : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run ng test --watch=false --include="**/profile-canvas.spec.ts"`
Expected: PASS, all cases.

- [ ] **Step 5: Lint and format**

```bash
bun run lint
bun run prettier --write src/app/models/profile-canvas.ts src/app/models/profile-canvas.spec.ts src/app/dtos/response/profile-canvas.dto.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/models/profile-canvas.ts src/app/models/profile-canvas.spec.ts src/app/dtos/response/profile-canvas.dto.ts
git commit -m "feat(profile): add the canvas layout engine"
```

---

### Task 3: API service and store

**Files:**

- Create: `src/app/services/profile-canvas-api.service.ts`
- Create: `src/app/stores/profile-canvas.store.ts`
- Test: `src/app/stores/profile-canvas.store.spec.ts`

**Interfaces:**

- Consumes: `ProfileCanvasDto`, `CanvasWriteDto`, `CanvasImageDto`, `normalise`, `emptyCanvas` from Task 2.
- Produces:
  - `ProfileCanvasApiService.get(profileId): Observable<ProfileCanvasDto>`, `.save(body: CanvasWriteDto): Observable<ProfileCanvasDto>`, `.uploadImage(file: File): Observable<CanvasImageDto>`, `.deleteImage(imageId: string): Observable<void>`, `.imageUrl(imageId: string): string`
  - `ProfileCanvasStore.canvasFor(profileId): ProfileCanvasDto | undefined` (cache read, never fetches), `.ensureLoaded(profileId): void`, `.save(canvas: ProfileCanvasDto): Observable<ProfileCanvasDto>`, `.saving: Signal<boolean>`

- [ ] **Step 1: Write the API service**

Create `src/app/services/profile-canvas-api.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {map, Observable} from 'rxjs';
import {
    CanvasImageDto,
    CanvasWriteDto,
    ProfileCanvasDto,
} from '../dtos/response/profile-canvas.dto';
import {ApiConfigService} from './api-config.service';

@Injectable({providedIn: 'root'})
export class ProfileCanvasApiService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    public get(profileId: string): Observable<ProfileCanvasDto> {
        return this.http.get<ProfileCanvasDto>(`${this.base()}/profiles/${profileId}/canvas`);
    }

    public save(body: CanvasWriteDto): Observable<ProfileCanvasDto> {
        return this.http.put<ProfileCanvasDto>(`${this.base()}/profiles/me/canvas`, body);
    }

    public uploadImage(file: File): Observable<CanvasImageDto> {
        const form = new FormData();
        form.append('file', file, file.name);
        return this.http.post<CanvasImageDto>(`${this.base()}/profiles/me/canvas/images`, form);
    }

    public deleteImage(imageId: string): Observable<void> {
        return this.http
            .delete(`${this.base()}/profiles/me/canvas/images/${imageId}`, {responseType: 'text'})
            .pipe(map(() => undefined));
    }

    /** Built from the configured base, not environment.apiUrl: self-hosted deployments exist. */
    public imageUrl(imageId: string): string {
        return `${this.base()}/canvas-images/${imageId}`;
    }

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/social`;
    }
}
```

- [ ] **Step 2: Write the failing store tests**

Create `src/app/stores/profile-canvas.store.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {Observable, Subject, throwError} from 'rxjs';
import {ProfileCanvasStore} from './profile-canvas.store';
import {ProfileCanvasApiService} from '../services/profile-canvas-api.service';
import {CanvasWriteDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';

function canvas(profileId: string, widgetCount = 1): ProfileCanvasDto {
    return {
        profileId,
        updatedAt: '2026-08-22T00:00:00Z',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets: Array.from({length: widgetCount}, (_, i) => ({
            id: `w${i}`,
            type: 'quote',
            x: 0,
            y: i,
            w: 2,
            h: 1,
            visibility: 'everyone' as const,
            card: false,
            config: {text: 'hi'},
        })),
    };
}

class FakeApi {
    gets: Subject<ProfileCanvasDto>[] = [];
    saves: Subject<ProfileCanvasDto>[] = [];
    saveFails = false;

    get(_profileId: string): Observable<ProfileCanvasDto> {
        const subject = new Subject<ProfileCanvasDto>();
        this.gets.push(subject);
        return subject.asObservable();
    }

    save(_body: CanvasWriteDto): Observable<ProfileCanvasDto> {
        if (this.saveFails) return throwError(() => new Error('nope'));
        const subject = new Subject<ProfileCanvasDto>();
        this.saves.push(subject);
        return subject.asObservable();
    }
}

function setup() {
    const api = new FakeApi();
    TestBed.configureTestingModule({
        providers: [{provide: ProfileCanvasApiService, useValue: api}],
    });
    return {api, store: TestBed.inject(ProfileCanvasStore)};
}

describe('ProfileCanvasStore', () => {
    it('answers undefined for a profile it has not loaded', () => {
        const {store} = setup();
        expect(store.canvasFor('p1')).toBeUndefined();
    });

    it('canvasFor never issues a request', () => {
        const {api, store} = setup();
        store.canvasFor('p1');
        expect(api.gets).toHaveLength(0);
    });

    it('ensureLoaded fetches once and caches the result', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1'));
        api.gets[0].complete();

        expect(store.canvasFor('p1')?.profileId).toBe('p1');
        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(1);
    });

    it('does not start a second fetch while one is in flight', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(1);
    });

    it('normalises what the server sent', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        const wide = canvas('p1');
        wide.widgets[0].w = 9;
        api.gets[0].next(wide);

        expect(store.canvasFor('p1')?.widgets[0].w).toBe(4);
    });

    it('leaves the cache alone when the fetch fails', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].error(new Error('boom'));
        expect(store.canvasFor('p1')).toBeUndefined();
    });

    it('applies a save optimistically and keeps the server answer', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        store.save(canvas('p1', 3)).subscribe();
        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);

        api.saves[0].next(canvas('p1', 3));
        api.saves[0].complete();
        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);
    });

    it('rolls the optimistic write back when the save fails', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        api.saveFails = true;
        store.save(canvas('p1', 3)).subscribe({error: () => undefined});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(1);
    });
});
```

- [ ] **Step 2b: Run the tests to verify they fail**

Run: `bun run ng test --watch=false --include="**/profile-canvas.store.spec.ts"`
Expected: FAIL, cannot resolve `./profile-canvas.store`.

- [ ] **Step 3: Write the store**

Create `src/app/stores/profile-canvas.store.ts`:

```ts
import {inject} from '@angular/core';
import {patchState, signalStore, withMethods, withState} from '@ngrx/signals';
import {catchError, Observable, tap, throwError} from 'rxjs';
import {ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {normalise} from '../models/profile-canvas';
import {ProfileCanvasApiService} from '../services/profile-canvas-api.service';

interface CanvasEntry {
    canvas: ProfileCanvasDto;
    loading: boolean;
    requestId: number;
}

interface ProfileCanvasState {
    byProfile: Record<string, CanvasEntry>;
    saving: boolean;
}

export const ProfileCanvasStore = signalStore(
    {providedIn: 'root'},
    withState<ProfileCanvasState>({byProfile: {}, saving: false}),

    withMethods((store, api = inject(ProfileCanvasApiService)) => {
        function put(profileId: string, entry: CanvasEntry): void {
            patchState(store, {byProfile: {...store.byProfile(), [profileId]: entry}});
        }

        return {
            /** Cache read. The popout relies on this never reaching the wire. */
            canvasFor(profileId: string): ProfileCanvasDto | undefined {
                return store.byProfile()[profileId]?.canvas;
            },

            ensureLoaded(profileId: string): void {
                const entry = store.byProfile()[profileId];
                if (entry?.loading || entry?.canvas) return;

                const requestId = (entry?.requestId ?? 0) + 1;
                put(profileId, {canvas: entry?.canvas as ProfileCanvasDto, loading: true, requestId});

                api.get(profileId).subscribe({
                    next: canvas => {
                        if (store.byProfile()[profileId]?.requestId !== requestId) return;
                        put(profileId, {canvas: normalise(canvas), loading: false, requestId});
                    },
                    error: () => {
                        if (store.byProfile()[profileId]?.requestId !== requestId) return;
                        const current = store.byProfile()[profileId];
                        put(profileId, {...current, loading: false});
                    },
                });
            },

            save(canvas: ProfileCanvasDto): Observable<ProfileCanvasDto> {
                const profileId = canvas.profileId;
                const previous = store.byProfile()[profileId];
                const requestId = (previous?.requestId ?? 0) + 1;

                put(profileId, {canvas: normalise(canvas), loading: false, requestId});
                patchState(store, {saving: true});

                return api.save({theme: canvas.theme, widgets: canvas.widgets}).pipe(
                    tap(saved => {
                        patchState(store, {saving: false});
                        put(profileId, {canvas: normalise(saved), loading: false, requestId});
                    }),
                    catchError((err: unknown) => {
                        patchState(store, {saving: false});
                        if (previous) put(profileId, previous);
                        return throwError(() => err);
                    }),
                );
            },
        };
    }),
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run ng test --watch=false --include="**/profile-canvas.store.spec.ts"`
Expected: PASS, all cases.

- [ ] **Step 5: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/services/profile-canvas-api.service.ts src/app/stores/profile-canvas.store.ts src/app/stores/profile-canvas.store.spec.ts
git add src/app/services/profile-canvas-api.service.ts src/app/stores/profile-canvas.store.ts src/app/stores/profile-canvas.store.spec.ts
git commit -m "feat(profile): add the canvas store and api service"
```

---

### Task 4: Registry, grid and the Quote widget

This is the vertical slice that fixes the widget contract. Every later widget task copies its shape.

**Files:**

- Create: `src/app/components/profile-canvas/widget-registry.ts`
- Create: `src/app/components/profile-canvas/profile-canvas.component.ts`
- Create: `src/app/components/profile-canvas/profile-canvas.component.html`
- Create: `src/app/components/profile-canvas/widgets/quote-widget.component.ts`
- Test: `src/app/components/profile-canvas/profile-canvas.component.spec.ts`

**Interfaces:**

- Consumes: `CanvasWidgetDto`, `Footprint`, `FOOTPRINTS`, `parseConfig`, `normalise` from Task 2. `PROFILE.CANVAS.*` keys from Task 1.
- Produces: `WidgetField`, `WidgetDefinition`, `WIDGET_REGISTRY`, `definitionFor(type): WidgetDefinition | undefined`, and `ProfileCanvasComponent` with inputs `canvas`, `columns`, `owner`.

- [ ] **Step 1: Write the registry**

Create `src/app/components/profile-canvas/widget-registry.ts`:

```ts
import {Type} from '@angular/core';
import {Footprint} from '../../models/profile-canvas';
import {QuoteWidgetComponent} from './widgets/quote-widget.component';

/** What the properties panel draws. One panel serves every widget type. */
export type WidgetField =
    | {kind: 'text'; key: string; labelKey: string; maxLength: number}
    | {kind: 'textarea'; key: string; labelKey: string; maxLength: number}
    | {kind: 'timezone'; key: string; labelKey: string}
    | {kind: 'image'; key: string; labelKey: string}
    | {kind: 'images'; key: string; labelKey: string; max: number}
    | {
          kind: 'rows';
          key: string;
          labelKey: string;
          max: number;
          columns: {key: string; labelKey: string; maxLength: number}[];
      };

export interface WidgetDefinition {
    type: string;
    component: Type<unknown>;
    /** Offered by the editor. The first is what an insert uses. */
    footprints: readonly Footprint[];
    labelKey: string;
    /** PrimeIcons class, without the `pi ` prefix. */
    icon: string;
    /** How many of this type one canvas may hold. */
    max: number;
    fields: readonly WidgetField[];
    /** What a freshly inserted widget of this type holds. */
    defaultConfig: () => unknown;
}

export const WIDGET_REGISTRY: readonly WidgetDefinition[] = [
    {
        type: 'quote',
        component: QuoteWidgetComponent,
        footprints: [
            {w: 2, h: 1},
            {w: 4, h: 1},
            {w: 2, h: 2},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.QUOTE',
        icon: 'pi-comment',
        max: 4,
        fields: [
            {kind: 'textarea', key: 'text', labelKey: 'PROFILE.CANVAS.FIELD.QUOTE_TEXT', maxLength: 240},
            {
                kind: 'text',
                key: 'attribution',
                labelKey: 'PROFILE.CANVAS.FIELD.QUOTE_ATTRIBUTION',
                maxLength: 80,
            },
        ],
        defaultConfig: () => ({text: '', attribution: ''}),
    },
];

export function definitionFor(type: string): WidgetDefinition | undefined {
    return WIDGET_REGISTRY.find(definition => definition.type === type);
}
```

- [ ] **Step 2: Write the Quote widget**

Create `src/app/components/profile-canvas/widgets/quote-widget.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {FONT_STACKS} from '../../../models/profile-font.model';
import {parseConfig} from '../../../models/profile-canvas';

interface QuoteConfig {
    text: string;
    attribution?: string;
}

function isQuoteConfig(value: unknown): value is QuoteConfig {
    return !!value && typeof value === 'object' && typeof (value as QuoteConfig).text === 'string';
}

@Component({
    selector: 'app-quote-widget',
    template: `
        @if (config(); as quote) {
            @if (quote.text) {
                <figure class="flex h-full flex-col justify-center gap-2 p-1">
                    <blockquote [style.font-family]="fontStack()" class="text-sm leading-snug text-text-primary">
                        {{ quote.text }}
                    </blockquote>
                    @if (quote.attribution) {
                        <figcaption class="text-xs text-text-muted">{{ quote.attribution }}</figcaption>
                    }
                </figure>
            }
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuoteWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isQuoteConfig));

    protected readonly fontStack = computed(() => FONT_STACKS[this.owner().font]);
}
```

- [ ] **Step 3: Write the grid component**

Create `src/app/components/profile-canvas/profile-canvas.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {NgComponentOutlet} from '@angular/common';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, normalise} from '../../models/profile-canvas';
import {definitionFor} from './widget-registry';

interface PlacedWidget {
    widget: CanvasWidgetDto;
    component: unknown;
}

/** Somebody's arranged profile. Read only: the editor renders this too, from its draft. */
@Component({
    selector: 'app-profile-canvas',
    imports: [NgComponentOutlet],
    templateUrl: './profile-canvas.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileCanvasComponent {
    readonly canvas = input.required<ProfileCanvasDto>();
    readonly owner = input.required<ProfileDto>();
    readonly columns = input<number>(CANVAS_COLUMNS);
    /** Draws only the two hover-preview widgets. The popout sets this. */
    readonly cardOnly = input(false);

    protected readonly placed = computed((): PlacedWidget[] => {
        const packed = normalise(this.canvas(), this.columns());
        const wanted = this.cardOnly() ? packed.widgets.filter(w => w.card) : packed.widgets;

        return wanted
            .map(widget => ({widget, component: definitionFor(widget.type)?.component ?? null}))
            .filter((entry): entry is PlacedWidget => entry.component !== null);
    });

    protected inputsFor(widget: CanvasWidgetDto): Record<string, unknown> {
        return {widget, owner: this.owner()};
    }
}
```

Create `src/app/components/profile-canvas/profile-canvas.component.html`:

```html
<div
    [style.grid-template-columns]="'repeat(' + columns() + ', minmax(0, 1fr))'"
    class="grid gap-2"
>
    @for (entry of placed(); track entry.widget.id) {
        <div
            [style.grid-column]="'span ' + entry.widget.w"
            [style.grid-row]="'span ' + entry.widget.h"
            class="min-w-0 overflow-hidden rounded-xl border border-border bg-card p-3"
        >
            <ng-container [ngComponentOutlet]="$any(entry.component)" [ngComponentOutletInputs]="inputsFor(entry.widget)" />
        </div>
    }
</div>
```

Cell squareness comes from the grid's implicit rows, set once on the container by whatever mounts it. Do not set `aspect-ratio` on the cell: a 4x1 cell would then be four cells tall.

- [ ] **Step 4: Write the component tests**

Create `src/app/components/profile-canvas/profile-canvas.component.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {ProfileCanvasComponent} from './profile-canvas.component';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../dtos/response/profile.dto';

function owner(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Nova',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

function widget(id: string, over: Partial<CanvasWidgetDto> = {}): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {text: 'a line'},
        ...over,
    };
}

function canvasOf(widgets: CanvasWidgetDto[]): ProfileCanvasDto {
    return {
        profileId: 'p1',
        updatedAt: '',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets,
    };
}

function render(canvas: ProfileCanvasDto, inputs: Record<string, unknown> = {}) {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(ProfileCanvasComponent);
    fixture.componentRef.setInput('canvas', canvas);
    fixture.componentRef.setInput('owner', owner());
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    return fixture;
}

describe('ProfileCanvasComponent', () => {
    it('draws a widget it knows', () => {
        const fixture = render(canvasOf([widget('a')]));
        expect(fixture.nativeElement.textContent).toContain('a line');
    });

    it('skips a type it does not know instead of throwing', () => {
        const fixture = render(canvasOf([widget('a', {type: 'from-the-future'})]));
        expect(fixture.nativeElement.querySelectorAll('[style*="grid-column"]')).toHaveLength(0);
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render(canvasOf([widget('a', {config: {text: 42}})]));
        expect(fixture.nativeElement.textContent).not.toContain('42');
    });

    it('cardOnly draws only the hover-preview widgets', () => {
        const fixture = render(
            canvasOf([widget('a', {card: true, config: {text: 'shown'}}), widget('b', {config: {text: 'hidden'}})]),
            {cardOnly: true, columns: 1},
        );
        expect(fixture.nativeElement.textContent).toContain('shown');
        expect(fixture.nativeElement.textContent).not.toContain('hidden');
    });
});
```

- [ ] **Step 5: Run the tests**

Run: `bun run ng test --watch=false --include="**/profile-canvas.component.spec.ts"`
Expected: PASS, all four cases.

- [ ] **Step 6: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/components/profile-canvas/
git add src/app/components/profile-canvas/
git commit -m "feat(profile): add the canvas grid, registry and quote widget"
```

---

### Task 5: Marquee and Local Time widgets

**Files:**

- Create: `src/app/components/profile-canvas/widgets/marquee-widget.component.ts`
- Create: `src/app/components/profile-canvas/widgets/local-time-widget.component.ts`
- Modify: `src/app/components/profile-canvas/widget-registry.ts`
- Test: `src/app/components/profile-canvas/widgets/local-time-widget.component.spec.ts`

**Interfaces:**

- Consumes: `parseConfig`, `WidgetDefinition`, `WIDGET_REGISTRY` from Tasks 2 and 4.
- Produces: `MarqueeWidgetComponent`, `LocalTimeWidgetComponent`, two more `WIDGET_REGISTRY` entries (`marquee`, `local-time`).

- [ ] **Step 1: Write the Marquee widget**

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface MarqueeConfig {
    text: string;
}

function isMarqueeConfig(value: unknown): value is MarqueeConfig {
    return !!value && typeof value === 'object' && typeof (value as MarqueeConfig).text === 'string';
}

@Component({
    selector: 'app-marquee-widget',
    template: `
        @if (config()?.text; as text) {
            <div class="flex h-full items-center overflow-hidden">
                <span class="marquee-track whitespace-nowrap text-sm text-brand-dim">{{ text }}</span>
            </div>
        }
    `,
    styles: `
        .marquee-track {
            padding-left: 100%;
            animation: canvas-marquee 15s linear infinite;
        }

        @keyframes canvas-marquee {
            to {
                transform: translateX(-100%);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .marquee-track {
                padding-left: 0;
                animation: none;
            }
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarqueeWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isMarqueeConfig));
}
```

- [ ] **Step 2: Write the failing Local Time test**

Create `src/app/components/profile-canvas/widgets/local-time-widget.component.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {LocalTimeWidgetComponent} from './local-time-widget.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

function owner(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'hex',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

function render(config: unknown) {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(LocalTimeWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'local-time',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        visibility: 'everyone',
        card: false,
        config,
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', owner());
    fixture.detectChanges();
    return fixture;
}

describe('LocalTimeWidgetComponent', () => {
    it('renders a time for a valid zone', () => {
        const fixture = render({timeZone: 'Europe/Zurich'});
        expect(fixture.nativeElement.textContent).toMatch(/\d{1,2}:\d{2}/);
    });

    it('renders nothing for a zone the platform rejects', () => {
        const fixture = render({timeZone: 'Not/AZone'});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render({});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/local-time-widget.component.spec.ts"`
Expected: FAIL, cannot resolve `./local-time-widget.component`.

- [ ] **Step 4: Write the Local Time widget**

```ts
import {ChangeDetectionStrategy, Component, computed, input, signal} from '@angular/core';
import {DestroyRef, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface LocalTimeConfig {
    timeZone: string;
}

function isLocalTimeConfig(value: unknown): value is LocalTimeConfig {
    return (
        !!value && typeof value === 'object' && typeof (value as LocalTimeConfig).timeZone === 'string'
    );
}

@Component({
    selector: 'app-local-time-widget',
    imports: [TranslateModule],
    template: `
        @if (time(); as shown) {
            <div class="flex h-full flex-col items-center justify-center">
                <span class="text-xl font-bold tabular-nums text-text-primary">{{ shown }}</span>
                <span class="text-xs text-text-muted">{{ 'PROFILE.CANVAS.LOCAL_TIME_LABEL' | translate }}</span>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalTimeWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    private readonly now = signal(Date.now());

    protected readonly time = computed(() => {
        const config = parseConfig(this.widget().config, isLocalTimeConfig);
        if (!config) return null;
        try {
            return new Intl.DateTimeFormat(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: config.timeZone,
            }).format(this.now());
        } catch {
            // Intl throws on an unknown zone, and a canvas must never take the page down.
            return null;
        }
    });

    constructor() {
        const timer = setInterval(() => this.now.set(Date.now()), 30_000);
        inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }
}
```

- [ ] **Step 5: Register both types**

Add to `WIDGET_REGISTRY` in `widget-registry.ts`, importing both components at the top:

```ts
    {
        type: 'marquee',
        component: MarqueeWidgetComponent,
        footprints: [
            {w: 4, h: 1},
            {w: 2, h: 1},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.MARQUEE',
        icon: 'pi-bolt',
        max: 1,
        fields: [
            {kind: 'text', key: 'text', labelKey: 'PROFILE.CANVAS.FIELD.MARQUEE_TEXT', maxLength: 120},
        ],
        defaultConfig: () => ({text: ''}),
    },
    {
        type: 'local-time',
        component: LocalTimeWidgetComponent,
        footprints: [{w: 1, h: 1}, {w: 2, h: 1}],
        labelKey: 'PROFILE.CANVAS.WIDGET.LOCAL_TIME',
        icon: 'pi-clock',
        max: 1,
        fields: [{kind: 'timezone', key: 'timeZone', labelKey: 'PROFILE.CANVAS.FIELD.TIME_ZONE'}],
        defaultConfig: () => ({timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}),
    },
```

- [ ] **Step 6: Run the tests**

Run: `bun run ng test --watch=false --include="**/local-time-widget.component.spec.ts"`
Expected: PASS, all three cases.

- [ ] **Step 7: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/components/profile-canvas/
git add src/app/components/profile-canvas/
git commit -m "feat(profile): add the marquee and local time widgets"
```

---

### Task 6: Open To and Mutuals widgets

**Files:**

- Create: `src/app/components/profile-canvas/widgets/open-to-widget.component.ts`
- Create: `src/app/components/profile-canvas/widgets/mutuals-widget.component.ts`
- Modify: `src/app/components/profile-canvas/widget-registry.ts`
- Test: `src/app/components/profile-canvas/widgets/mutuals-widget.component.spec.ts`

**Interfaces:**

- Consumes: `parseConfig` from Task 2, `AppAvatarComponent` (`<app-avatar [label] [userId] size="normal" />`), `ProfileDto.mutualFriends`.
- Produces: `OpenToWidgetComponent`, `MutualsWidgetComponent`, two more registry entries (`open-to`, `mutuals`).

- [ ] **Step 1: Write the Open To widget**

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface OpenToItem {
    label: string;
    state: 'yes' | 'no';
}

interface OpenToConfig {
    items: OpenToItem[];
}

function isOpenToConfig(value: unknown): value is OpenToConfig {
    const items = (value as OpenToConfig | null)?.items;
    return (
        Array.isArray(items) &&
        items.every(item => typeof item?.label === 'string' && (item.state === 'yes' || item.state === 'no'))
    );
}

@Component({
    selector: 'app-open-to-widget',
    template: `
        @if (config(); as open) {
            <div class="flex flex-wrap content-start gap-1.5">
                @for (item of open.items; track item.label) {
                    <span
                        [class.bg-online/15]="item.state === 'yes'"
                        [class.text-online]="item.state === 'yes'"
                        [class.bg-hover]="item.state === 'no'"
                        [class.text-text-muted]="item.state === 'no'"
                        [class.line-through]="item.state === 'no'"
                        class="rounded-full px-2 py-0.5 text-xs"
                    >
                        {{ item.label }}
                    </span>
                }
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpenToWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isOpenToConfig));
}
```

- [ ] **Step 2: Write the failing Mutuals test**

Create `src/app/components/profile-canvas/widgets/mutuals-widget.component.spec.ts`. Reuse the `owner()` and `render()` helpers from Task 5's spec, changing the component and adding a `mutualFriends` override:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {MutualsWidgetComponent} from './mutuals-widget.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {MutualFriendSummary, OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

function owner(mutualFriends?: MutualFriendSummary[]): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Nova',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
        mutualFriends,
    };
}

function render(profile: ProfileDto) {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(MutualsWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'mutuals',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', profile);
    fixture.detectChanges();
    return fixture;
}

describe('MutualsWidgetComponent', () => {
    it('draws a face per mutual, up to four', () => {
        const friends = Array.from({length: 6}, (_, i) => ({
            profileId: `p${i}`,
            userId: `u${i}`,
            userName: `friend${i}`,
        }));
        const fixture = render(owner(friends));
        expect(fixture.nativeElement.querySelectorAll('app-avatar')).toHaveLength(4);
    });

    it('renders nothing when the viewer may not see mutuals', () => {
        const fixture = render(owner(undefined));
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('renders nothing when there are no mutuals', () => {
        const fixture = render(owner([]));
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });
});
```

The second case is the important one. `mutualFriends` absent means the viewer is not permitted, and `profile.mutualFriends.length` throws for them, so every read must be optional.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/mutuals-widget.component.spec.ts"`
Expected: FAIL, cannot resolve `./mutuals-widget.component`.

- [ ] **Step 4: Write the Mutuals widget**

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {AppAvatarComponent} from '../../avatar/avatar.component';

const SHOWN = 4;

@Component({
    selector: 'app-mutuals-widget',
    imports: [TranslateModule, AppAvatarComponent],
    template: `
        @if (shown().length > 0) {
            <div class="flex h-full flex-col justify-center gap-2">
                <div class="flex items-center">
                    @for (friend of shown(); track friend.userId) {
                        <div class="-ml-2 first:ml-0 ring-2 ring-card rounded-full">
                            <app-avatar [label]="initialOf(friend.userName)" [userId]="friend.userId" size="normal" />
                        </div>
                    }
                    @if (extra() > 0) {
                        <span class="ml-2 text-xs text-text-muted">+{{ extra() }}</span>
                    }
                </div>
                <span class="text-xs text-text-muted">{{ countLabel() | translate: {count: total()} }}</span>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MutualsWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    /** Absent means the viewer may not see them, which is not the same as none. Both draw nothing. */
    protected readonly total = computed(() => this.owner().mutualFriends?.length ?? 0);

    protected readonly shown = computed(() => this.owner().mutualFriends?.slice(0, SHOWN) ?? []);

    protected readonly extra = computed(() => Math.max(0, this.total() - SHOWN));

    protected readonly countLabel = computed(() =>
        this.total() === 1 ? 'PROFILE.CANVAS.MUTUALS_COUNT_ONE' : 'PROFILE.CANVAS.MUTUALS_COUNT',
    );

    protected initialOf(name: string): string {
        return name.charAt(0).toUpperCase();
    }
}
```

- [ ] **Step 5: Register both types**

```ts
    {
        type: 'open-to',
        component: OpenToWidgetComponent,
        footprints: [{w: 2, h: 1}, {w: 2, h: 2}],
        labelKey: 'PROFILE.CANVAS.WIDGET.OPEN_TO',
        icon: 'pi-check-circle',
        max: 1,
        fields: [
            {
                kind: 'rows',
                key: 'items',
                labelKey: 'PROFILE.CANVAS.FIELD.OPEN_TO_ITEMS',
                max: 8,
                columns: [
                    {key: 'label', labelKey: 'PROFILE.CANVAS.FIELD.OPEN_TO_LABEL', maxLength: 32},
                    {key: 'state', labelKey: 'PROFILE.CANVAS.FIELD.OPEN_TO_STATE', maxLength: 3},
                ],
            },
        ],
        defaultConfig: () => ({items: []}),
    },
    {
        type: 'mutuals',
        component: MutualsWidgetComponent,
        footprints: [{w: 2, h: 1}],
        labelKey: 'PROFILE.CANVAS.WIDGET.MUTUALS',
        icon: 'pi-users',
        max: 1,
        fields: [],
        defaultConfig: () => ({}),
    },
```

- [ ] **Step 6: Run the tests, lint, format, commit**

```bash
bun run ng test --watch=false --include="**/mutuals-widget.component.spec.ts"
bun run lint
bun run prettier --write src/app/components/profile-canvas/
git add src/app/components/profile-canvas/
git commit -m "feat(profile): add the open to and mutuals widgets"
```

---

### Task 7: Currently and Infobox widgets

**Files:**

- Create: `src/app/components/profile-canvas/widgets/currently-widget.component.ts`
- Create: `src/app/components/profile-canvas/widgets/infobox-widget.component.ts`
- Modify: `src/app/components/profile-canvas/widget-registry.ts`
- Test: `src/app/components/profile-canvas/widgets/currently-widget.component.spec.ts`

**Interfaces:**

- Consumes: `parseConfig` from Task 2.
- Produces: `CurrentlyWidgetComponent`, `InfoboxWidgetComponent`, two more registry entries (`currently`, `infobox`).

These two hold their own rows. They do not call `renderInfobox` from `features/guild/personas/persona-infobox.ts`: that takes a category template and a values blob as two JSON strings, which is the wrong shape for a widget somebody fills in by hand.

- [ ] **Step 1: Write the failing Currently test**

Create `src/app/components/profile-canvas/widgets/currently-widget.component.spec.ts`, reusing the `owner()` helper shape from Task 6's spec:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {CurrentlyWidgetComponent} from './currently-widget.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

function owner(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'hex',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

function render(config: unknown) {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(CurrentlyWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'currently',
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        visibility: 'everyone',
        card: false,
        config,
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', owner());
    fixture.detectChanges();
    return fixture;
}

describe('CurrentlyWidgetComponent', () => {
    it('draws a row per entry', () => {
        const fixture = render({
            rows: [
                {verb: 'reading', text: 'Piranesi'},
                {verb: 'building', text: 'a raytracer'},
            ],
        });
        expect(fixture.nativeElement.textContent).toContain('Piranesi');
        expect(fixture.nativeElement.textContent).toContain('a raytracer');
    });

    it('skips a row with no text', () => {
        const fixture = render({rows: [{verb: 'reading', text: ''}]});
        expect(fixture.nativeElement.textContent).not.toContain('reading');
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render({rows: 'nope'});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/currently-widget.component.spec.ts"`
Expected: FAIL, cannot resolve `./currently-widget.component`.

- [ ] **Step 3: Write the Currently widget**

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface CurrentlyRow {
    verb: string;
    text: string;
}

interface CurrentlyConfig {
    rows: CurrentlyRow[];
}

function isCurrentlyConfig(value: unknown): value is CurrentlyConfig {
    const rows = (value as CurrentlyConfig | null)?.rows;
    return (
        Array.isArray(rows) &&
        rows.every(row => typeof row?.verb === 'string' && typeof row?.text === 'string')
    );
}

@Component({
    selector: 'app-currently-widget',
    template: `
        <div class="flex flex-col gap-2">
            @for (row of rows(); track row.verb + row.text) {
                <div class="flex items-center gap-2">
                    <span class="shrink-0 rounded-full bg-hover px-2 py-0.5 text-xs text-text-secondary">
                        {{ row.verb }}
                    </span>
                    <span class="min-w-0 truncate text-xs text-text-secondary">{{ row.text }}</span>
                </div>
            }
        </div>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurrentlyWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    /** An unanswered row reads as a blank, so it is left out rather than drawn empty. */
    protected readonly rows = computed(
        () =>
            parseConfig(this.widget().config, isCurrentlyConfig)?.rows.filter(row => row.text.trim()) ?? [],
    );
}
```

- [ ] **Step 4: Write the Infobox widget**

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface InfoboxRow {
    label: string;
    value: string;
}

interface InfoboxConfig {
    title?: string;
    rows: InfoboxRow[];
}

function isInfoboxConfig(value: unknown): value is InfoboxConfig {
    const rows = (value as InfoboxConfig | null)?.rows;
    return (
        Array.isArray(rows) &&
        rows.every(row => typeof row?.label === 'string' && typeof row?.value === 'string')
    );
}

@Component({
    selector: 'app-infobox-widget',
    template: `
        @if (config(); as box) {
            <div class="flex flex-col gap-2">
                @if (box.title) {
                    <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-text-muted">
                        {{ box.title }}
                    </span>
                }
                <div class="flex flex-col gap-1">
                    @for (row of rows(); track row.label) {
                        <div class="flex items-baseline justify-between gap-2 text-xs">
                            <span class="shrink-0 text-text-muted">{{ row.label }}</span>
                            <span class="min-w-0 truncate text-right text-text-secondary">{{ row.value }}</span>
                        </div>
                    }
                </div>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfoboxWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isInfoboxConfig));

    protected readonly rows = computed(() => this.config()?.rows.filter(row => row.value.trim()) ?? []);
}
```

- [ ] **Step 5: Register both types**

```ts
    {
        type: 'currently',
        component: CurrentlyWidgetComponent,
        footprints: [{w: 2, h: 2}, {w: 2, h: 1}],
        labelKey: 'PROFILE.CANVAS.WIDGET.CURRENTLY',
        icon: 'pi-bookmark',
        max: 1,
        fields: [
            {
                kind: 'rows',
                key: 'rows',
                labelKey: 'PROFILE.CANVAS.FIELD.CURRENTLY_ROWS',
                max: 6,
                columns: [
                    {key: 'verb', labelKey: 'PROFILE.CANVAS.FIELD.CURRENTLY_VERB', maxLength: 16},
                    {key: 'text', labelKey: 'PROFILE.CANVAS.FIELD.CURRENTLY_TEXT', maxLength: 64},
                ],
            },
        ],
        defaultConfig: () => ({rows: []}),
    },
    {
        type: 'infobox',
        component: InfoboxWidgetComponent,
        footprints: [{w: 2, h: 2}, {w: 2, h: 1}],
        labelKey: 'PROFILE.CANVAS.WIDGET.INFOBOX',
        icon: 'pi-list',
        max: 2,
        fields: [
            {kind: 'text', key: 'title', labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_TITLE', maxLength: 32},
            {
                kind: 'rows',
                key: 'rows',
                labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_ROWS',
                max: 10,
                columns: [
                    {key: 'label', labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_LABEL', maxLength: 24},
                    {key: 'value', labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_VALUE', maxLength: 64},
                ],
            },
        ],
        defaultConfig: () => ({title: '', rows: []}),
    },
```

- [ ] **Step 6: Run the tests, lint, format, commit**

```bash
bun run ng test --watch=false --include="**/currently-widget.component.spec.ts"
bun run lint
bun run prettier --write src/app/components/profile-canvas/
git add src/app/components/profile-canvas/
git commit -m "feat(profile): add the currently and infobox widgets"
```

---

### Task 8: Photo and Gallery widgets

**Files:**

- Create: `src/app/components/profile-canvas/widgets/photo-widget.component.ts`
- Create: `src/app/components/profile-canvas/widgets/gallery-widget.component.ts`
- Modify: `src/app/components/profile-canvas/widget-registry.ts`
- Test: `src/app/components/profile-canvas/widgets/photo-widget.component.spec.ts`

**Interfaces:**

- Consumes: `ProfileCanvasApiService.imageUrl(imageId)` from Task 3, `parseConfig` from Task 2, `BrokenImageService` (existing).
- Produces: `PhotoWidgetComponent`, `GalleryWidgetComponent`, two more registry entries (`photo`, `gallery`).

Images do not go through `FileService`. That uploads to `/api/v1/messaging/attachments`, which is access-controlled per conversation, and a profile image is world-readable by construction.

- [ ] **Step 1: Write the failing Photo test**

Create `src/app/components/profile-canvas/widgets/photo-widget.component.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {PhotoWidgetComponent} from './photo-widget.component';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

class FakeApi {
    imageUrl(imageId: string): string {
        return `https://cdn.test/${imageId}`;
    }
}

function owner(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Marrow',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

function render(config: unknown) {
    TestBed.configureTestingModule({
        providers: [{provide: ProfileCanvasApiService, useValue: new FakeApi()}],
    });
    const fixture = TestBed.createComponent(PhotoWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'photo',
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        visibility: 'everyone',
        card: false,
        config,
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', owner());
    fixture.detectChanges();
    return fixture;
}

describe('PhotoWidgetComponent', () => {
    it('builds the src from the image id', () => {
        const fixture = render({imageId: 'img1', alt: 'a hill'});
        const img: HTMLImageElement = fixture.nativeElement.querySelector('img');
        expect(img.getAttribute('src')).toBe('https://cdn.test/img1');
        expect(img.getAttribute('alt')).toBe('a hill');
    });

    it('renders nothing without an image id', () => {
        const fixture = render({alt: 'a hill'});
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('draws the caption when there is one', () => {
        const fixture = render({imageId: 'img1', alt: 'a hill', caption: 'Kyoto'});
        expect(fixture.nativeElement.textContent).toContain('Kyoto');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/photo-widget.component.spec.ts"`
Expected: FAIL, cannot resolve `./photo-widget.component`.

- [ ] **Step 3: Write the Photo widget**

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';

interface PhotoConfig {
    imageId: string;
    alt: string;
    caption?: string;
}

function isPhotoConfig(value: unknown): value is PhotoConfig {
    const config = value as PhotoConfig | null;
    return !!config && typeof config.imageId === 'string' && config.imageId.length > 0;
}

@Component({
    selector: 'app-photo-widget',
    template: `
        @if (config(); as photo) {
            <figure class="flex h-full flex-col gap-1.5">
                <img [alt]="photo.alt ?? ''" [src]="src()" class="min-h-0 w-full flex-1 rounded-lg object-cover" />
                @if (photo.caption) {
                    <figcaption class="shrink-0 truncate text-xs text-text-muted">{{ photo.caption }}</figcaption>
                }
            </figure>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    private api = inject(ProfileCanvasApiService);

    protected readonly config = computed(() => parseConfig(this.widget().config, isPhotoConfig));

    protected readonly src = computed(() => {
        const imageId = this.config()?.imageId;
        return imageId ? this.api.imageUrl(imageId) : '';
    });
}
```

- [ ] **Step 4: Write the Gallery widget**

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';

interface GalleryItem {
    imageId: string;
    alt: string;
}

interface GalleryConfig {
    items: GalleryItem[];
}

function isGalleryConfig(value: unknown): value is GalleryConfig {
    const items = (value as GalleryConfig | null)?.items;
    return Array.isArray(items) && items.every(item => typeof item?.imageId === 'string');
}

@Component({
    selector: 'app-gallery-widget',
    template: `
        @if (items().length > 0) {
            <div class="grid h-full grid-cols-4 gap-1">
                @for (item of items(); track item.imageId) {
                    <img
                        [alt]="item.alt ?? ''"
                        [src]="srcOf(item.imageId)"
                        class="aspect-square w-full rounded-md object-cover"
                    />
                }
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GalleryWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    private api = inject(ProfileCanvasApiService);

    protected readonly items = computed(
        () => parseConfig(this.widget().config, isGalleryConfig)?.items.filter(item => item.imageId) ?? [],
    );

    protected srcOf(imageId: string): string {
        return this.api.imageUrl(imageId);
    }
}
```

- [ ] **Step 5: Register both types**

```ts
    {
        type: 'photo',
        component: PhotoWidgetComponent,
        footprints: [{w: 1, h: 1}, {w: 2, h: 2}, {w: 4, h: 2}],
        labelKey: 'PROFILE.CANVAS.WIDGET.PHOTO',
        icon: 'pi-image',
        max: 6,
        fields: [
            {kind: 'image', key: 'imageId', labelKey: 'PROFILE.CANVAS.FIELD.PHOTO_IMAGE'},
            {kind: 'text', key: 'alt', labelKey: 'PROFILE.CANVAS.FIELD.PHOTO_ALT', maxLength: 120},
            {kind: 'text', key: 'caption', labelKey: 'PROFILE.CANVAS.FIELD.PHOTO_CAPTION', maxLength: 80},
        ],
        defaultConfig: () => ({imageId: '', alt: '', caption: ''}),
    },
    {
        type: 'gallery',
        component: GalleryWidgetComponent,
        footprints: [{w: 4, h: 1}, {w: 2, h: 2}],
        labelKey: 'PROFILE.CANVAS.WIDGET.GALLERY',
        icon: 'pi-images',
        max: 2,
        fields: [{kind: 'images', key: 'items', labelKey: 'PROFILE.CANVAS.FIELD.GALLERY_ITEMS', max: 8}],
        defaultConfig: () => ({items: []}),
    },
```

- [ ] **Step 6: Run the tests, lint, format, commit**

```bash
bun run ng test --watch=false --include="**/photo-widget.component.spec.ts"
bun run lint
bun run prettier --write src/app/components/profile-canvas/
git add src/app/components/profile-canvas/
git commit -m "feat(profile): add the photo and gallery widgets"
```

---

### Task 9: The editor draft service

The draft is device state, not store state: a second window of the same account would legitimately be mid-edit on something different.

**Files:**

- Create: `src/app/services/canvas-editor.service.ts`
- Test: `src/app/services/canvas-editor.service.spec.ts`

**Interfaces:**

- Consumes: `ProfileCanvasDto`, `CanvasWidgetDto`, `Footprint`, `normalise`, `MAX_WIDGETS`, `MAX_CARD_WIDGETS` from Task 2. `definitionFor` from Task 4.
- Produces: `CanvasEditorService` with `draft: Signal<ProfileCanvasDto | null>`, `dirty: Signal<boolean>`, `begin(canvas)`, `insert(type)`, `remove(id)`, `move(id, delta)`, `resize(id, footprint)`, `setVisibility(id, visibility)`, `setCard(id, card)`, `patchConfig(id, patch)`, `canInsert(type): boolean`, `discard()`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/canvas-editor.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {CanvasEditorService} from './canvas-editor.service';
import {ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {emptyCanvas, MAX_WIDGETS} from '../models/profile-canvas';

function service(): CanvasEditorService {
    TestBed.configureTestingModule({});
    return TestBed.inject(CanvasEditorService);
}

function started(canvas: ProfileCanvasDto = emptyCanvas('p1')): CanvasEditorService {
    const editor = service();
    editor.begin(canvas);
    return editor;
}

describe('CanvasEditorService', () => {
    let editor: CanvasEditorService;

    beforeEach(() => {
        editor = started();
    });

    it('starts clean', () => {
        expect(editor.dirty()).toBe(false);
        expect(editor.draft()?.widgets).toEqual([]);
    });

    it('insert adds a widget of that type with its default config', () => {
        editor.insert('quote');
        expect(editor.draft()?.widgets).toHaveLength(1);
        expect(editor.draft()?.widgets[0].type).toBe('quote');
        expect(editor.draft()?.widgets[0].config).toEqual({text: '', attribution: ''});
        expect(editor.dirty()).toBe(true);
    });

    it('insert uses the first footprint the registry offers', () => {
        editor.insert('quote');
        expect(editor.draft()?.widgets[0]).toMatchObject({w: 2, h: 1});
    });

    it('refuses a type the registry does not know', () => {
        editor.insert('from-the-future');
        expect(editor.draft()?.widgets).toHaveLength(0);
    });

    it('refuses to insert past the cap', () => {
        for (let i = 0; i < MAX_WIDGETS + 3; i++) editor.insert('photo');
        expect(editor.draft()?.widgets.length).toBeLessThanOrEqual(MAX_WIDGETS);
    });

    it('canInsert goes false once a type is at its max', () => {
        editor.insert('marquee');
        expect(editor.canInsert('marquee')).toBe(false);
        expect(editor.canInsert('quote')).toBe(true);
    });

    it('remove drops the widget', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.remove(id);
        expect(editor.draft()?.widgets).toHaveLength(0);
    });

    it('move reorders in reading order', () => {
        editor.insert('quote');
        editor.insert('photo');
        const second = editor.draft()!.widgets[1].id;

        editor.move(second, -1);
        expect(editor.draft()!.widgets[0].id).toBe(second);
    });

    it('move past either end does nothing', () => {
        editor.insert('quote');
        const only = editor.draft()!.widgets[0].id;
        editor.move(only, -1);
        editor.move(only, 1);
        expect(editor.draft()!.widgets[0].id).toBe(only);
    });

    it('resize snaps to a legal footprint', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.resize(id, {w: 4, h: 1});
        expect(editor.draft()!.widgets[0]).toMatchObject({w: 4, h: 1});
    });

    it('patchConfig merges rather than replacing', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.patchConfig(id, {text: 'hello'});
        expect(editor.draft()!.widgets[0].config).toEqual({text: 'hello', attribution: ''});
    });

    it('setCard refuses a third card widget', () => {
        editor.insert('quote');
        editor.insert('photo');
        editor.insert('infobox');
        const ids = editor.draft()!.widgets.map(w => w.id);
        editor.setCard(ids[0], true);
        editor.setCard(ids[1], true);
        editor.setCard(ids[2], true);

        expect(editor.draft()!.widgets.filter(w => w.card)).toHaveLength(2);
    });

    it('discard returns to the baseline and goes clean', () => {
        editor.insert('quote');
        editor.discard();
        expect(editor.draft()?.widgets).toEqual([]);
        expect(editor.dirty()).toBe(false);
    });

    it('begin replaces the baseline, so a saved canvas is clean again', () => {
        editor.insert('quote');
        editor.begin(editor.draft()!);
        expect(editor.dirty()).toBe(false);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/canvas-editor.service.spec.ts"`
Expected: FAIL, cannot resolve `./canvas-editor.service`.

- [ ] **Step 3: Write the service**

Create `src/app/services/canvas-editor.service.ts`:

```ts
import {computed, Injectable, signal} from '@angular/core';
import {CanvasVisibility, CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {definitionFor} from '../components/profile-canvas/widget-registry';
import {Footprint, MAX_CARD_WIDGETS, MAX_WIDGETS, normalise, snapFootprint} from '../models/profile-canvas';

/** Unique enough for a draft; the server assigns the real id on save. */
function draftId(): string {
    return `draft-${Math.random().toString(36).slice(2, 10)}`;
}

/** The arrangement being edited. Device state: a second window may be mid-edit on something else. */
@Injectable({providedIn: 'root'})
export class CanvasEditorService {
    private readonly baseline = signal<string>('');
    private readonly current = signal<ProfileCanvasDto | null>(null);

    readonly draft = this.current.asReadonly();

    readonly dirty = computed(() => {
        const canvas = this.current();
        return !!canvas && JSON.stringify(canvas.widgets) !== this.baseline();
    });

    begin(canvas: ProfileCanvasDto): void {
        const packed = normalise(canvas);
        this.current.set(packed);
        this.baseline.set(JSON.stringify(packed.widgets));
    }

    discard(): void {
        const canvas = this.current();
        if (!canvas) return;
        this.current.set({...canvas, widgets: JSON.parse(this.baseline()) as CanvasWidgetDto[]});
    }

    canInsert(type: string): boolean {
        const canvas = this.current();
        const definition = definitionFor(type);
        if (!canvas || !definition) return false;
        if (canvas.widgets.length >= MAX_WIDGETS) return false;
        return canvas.widgets.filter(widget => widget.type === type).length < definition.max;
    }

    insert(type: string): void {
        const canvas = this.current();
        const definition = definitionFor(type);
        if (!canvas || !definition || !this.canInsert(type)) return;

        const footprint = definition.footprints[0];
        const widget: CanvasWidgetDto = {
            id: draftId(),
            type,
            x: 0,
            // Placed last, then reflow derives the real coordinates.
            y: canvas.widgets.length + 1,
            w: footprint.w,
            h: footprint.h,
            visibility: 'everyone',
            card: false,
            config: definition.defaultConfig(),
        };
        this.write([...canvas.widgets, widget]);
    }

    remove(id: string): void {
        const canvas = this.current();
        if (!canvas) return;
        this.write(canvas.widgets.filter(widget => widget.id !== id));
    }

    /** Reading order is array order, so a move is an array move and reflow does the rest. */
    move(id: string, delta: number): void {
        const canvas = this.current();
        if (!canvas) return;

        const from = canvas.widgets.findIndex(widget => widget.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= canvas.widgets.length) return;

        const widgets = [...canvas.widgets];
        const [moved] = widgets.splice(from, 1);
        widgets.splice(to, 0, moved);
        this.write(widgets);
    }

    resize(id: string, footprint: Footprint): void {
        this.patch(id, () => snapFootprint(footprint.w, footprint.h));
    }

    setVisibility(id: string, visibility: CanvasVisibility): void {
        this.patch(id, () => ({visibility}));
    }

    setCard(id: string, card: boolean): void {
        const canvas = this.current();
        if (!canvas) return;

        const already = canvas.widgets.filter(widget => widget.card && widget.id !== id).length;
        if (card && already >= MAX_CARD_WIDGETS) return;
        this.patch(id, () => ({card}));
    }

    patchConfig(id: string, patch: Record<string, unknown>): void {
        this.patch(id, widget => ({
            config: {...(widget.config as Record<string, unknown>), ...patch},
        }));
    }

    private patch(id: string, change: (widget: CanvasWidgetDto) => Partial<CanvasWidgetDto>): void {
        const canvas = this.current();
        if (!canvas) return;
        this.write(
            canvas.widgets.map(widget => (widget.id === id ? {...widget, ...change(widget)} : widget)),
        );
    }

    /** Every mutation lands here, so the draft is never an arrangement the grid could not draw. */
    private write(widgets: CanvasWidgetDto[]): void {
        const canvas = this.current();
        if (!canvas) return;
        this.current.set(normalise({...canvas, widgets: widgets.slice(0, MAX_WIDGETS)}));
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run ng test --watch=false --include="**/canvas-editor.service.spec.ts"`
Expected: PASS, all cases.

- [ ] **Step 5: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/services/canvas-editor.service.ts src/app/services/canvas-editor.service.spec.ts
git add src/app/services/canvas-editor.service.ts src/app/services/canvas-editor.service.spec.ts
git commit -m "feat(profile): add the canvas editor draft service"
```

---

### Task 10: Editor shell in profile settings

**Files:**

- Create: `src/app/features/settings/settings-modal/pages/profile-settings/canvas-editor/canvas-editor.component.ts`
- Create: `src/app/features/settings/settings-modal/pages/profile-settings/canvas-editor/canvas-editor.component.html`
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html`
- Test: `.../canvas-editor/canvas-editor.component.spec.ts`

**Interfaces:**

- Consumes: `CanvasEditorService` (Task 9), `ProfileCanvasStore` (Task 3), `ProfileCanvasComponent` (Task 4), `WIDGET_REGISTRY` (Task 4), `ProfileService.ownProfile` (existing).
- Produces: `CanvasEditorComponent`, selector `app-canvas-editor`, no inputs. It reads the own profile itself.

- [ ] **Step 1: Write the failing test**

Create `.../canvas-editor/canvas-editor.component.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {of} from 'rxjs';
import {provideTranslateService} from '@ngx-translate/core';
import {CanvasEditorComponent} from './canvas-editor.component';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasStore} from '../../../../../../stores/profile-canvas.store';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileCanvasApiService} from '../../../../../../services/profile-canvas-api.service';
import {emptyCanvas} from '../../../../../../models/profile-canvas';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../../../../dtos/response/profile.dto';
import {signal} from '@angular/core';

function profile(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Nova',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

class FakeCanvasApi {
    imageUrl(id: string): string {
        return `https://cdn.test/${id}`;
    }
}

function setup() {
    const saved: unknown[] = [];
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            {provide: ProfileService, useValue: {ownProfile: signal(profile())}},
            {provide: ProfileCanvasApiService, useValue: new FakeCanvasApi()},
            {
                provide: ProfileCanvasStore,
                useValue: {
                    canvasFor: () => emptyCanvas('p1'),
                    ensureLoaded: () => undefined,
                    saving: signal(false),
                    save: (canvas: unknown) => {
                        saved.push(canvas);
                        return of(canvas);
                    },
                },
            },
        ],
    });
    const fixture = TestBed.createComponent(CanvasEditorComponent);
    fixture.detectChanges();
    return {fixture, saved, editor: TestBed.inject(CanvasEditorService)};
}

describe('CanvasEditorComponent', () => {
    it('offers every registered widget type in the insert menu', () => {
        const {fixture} = setup();
        const buttons = fixture.nativeElement.querySelectorAll('[data-testid="insert-widget"]');
        expect(buttons.length).toBeGreaterThanOrEqual(9);
    });

    it('inserting a widget marks the editor dirty', () => {
        const {fixture, editor} = setup();
        editor.insert('quote');
        fixture.detectChanges();
        expect(editor.dirty()).toBe(true);
    });

    it('save hands the draft to the store', () => {
        const {fixture, saved, editor} = setup();
        editor.insert('quote');
        fixture.detectChanges();

        fixture.nativeElement.querySelector('[data-testid="save-canvas"]').click();
        expect(saved).toHaveLength(1);
    });

    it('save is disabled while the draft is clean', () => {
        const {fixture} = setup();
        const save: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="save-canvas"]');
        expect(save.disabled).toBe(true);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/canvas-editor.component.spec.ts"`
Expected: FAIL, cannot resolve `./canvas-editor.component`.

- [ ] **Step 3: Write the editor component**

Create `canvas-editor.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {ProfileService} from '../../../../../../services/profile.service';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasStore} from '../../../../../../stores/profile-canvas.store';
import {ProfileCanvasComponent} from '../../../../../../components/profile-canvas/profile-canvas.component';
import {
    definitionFor,
    WIDGET_REGISTRY,
    WidgetDefinition,
} from '../../../../../../components/profile-canvas/widget-registry';
import {emptyCanvas} from '../../../../../../models/profile-canvas';
import {WidgetPropertiesComponent} from './widget-properties.component';

@Component({
    selector: 'app-canvas-editor',
    imports: [TranslateModule, ProfileCanvasComponent, WidgetPropertiesComponent],
    templateUrl: './canvas-editor.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasEditorComponent {
    protected readonly editor = inject(CanvasEditorService);
    protected readonly store = inject(ProfileCanvasStore);
    protected readonly selectedId = signal<string | null>(null);
    protected readonly dragIndex = signal<number | null>(null);
    protected readonly overIndex = signal<number | null>(null);

    private profiles = inject(ProfileService);
    private toast = inject(MessageService);

    protected readonly owner = this.profiles.ownProfile;

    protected readonly selected = computed(
        () => this.editor.draft()?.widgets.find(widget => widget.id === this.selectedId()) ?? null,
    );

    protected get registry(): readonly WidgetDefinition[] {
        // A getter, not a field: an imported const read as a class field is undefined under Vite.
        return WIDGET_REGISTRY;
    }

    constructor() {
        effect(() => {
            const profile = this.owner();
            if (!profile) return;

            untracked(() => {
                this.store.ensureLoaded(profile.id);
                this.editor.begin(this.store.canvasFor(profile.id) ?? emptyCanvas(profile.id));
            });
        });
    }

    protected insert(type: string): void {
        this.editor.insert(type);
        const widgets = this.editor.draft()?.widgets ?? [];
        this.selectedId.set(widgets[widgets.length - 1]?.id ?? null);
    }

    protected labelFor(type: string): string {
        return definitionFor(type)?.labelKey ?? type;
    }

    protected onDragOver(event: DragEvent, index: number): void {
        // Without preventDefault the drop never fires: the default is "not a drop target".
        event.preventDefault();
        this.overIndex.set(index);
    }

    protected onDrop(event: DragEvent, index: number): void {
        event.preventDefault();
        const from = this.dragIndex();
        this.dragIndex.set(null);
        this.overIndex.set(null);
        if (from === null || from === index) return;

        const id = this.editor.draft()?.widgets[from]?.id;
        if (id) this.editor.move(id, index - from);
    }

    protected remove(id: string): void {
        this.editor.remove(id);
        if (this.selectedId() === id) this.selectedId.set(null);
    }

    protected save(): void {
        const draft = this.editor.draft();
        if (!draft || !this.editor.dirty()) return;

        this.store.save(draft).subscribe({
            next: saved => {
                this.editor.begin(saved);
                this.toast.add({severity: 'success', summary: 'PROFILE.CANVAS.EDITOR.SAVED'});
            },
            error: () =>
                this.toast.add({severity: 'error', summary: 'PROFILE.CANVAS.EDITOR.SAVE_FAILED'}),
        });
    }

    /** Arrow keys move the selection; with a modifier they move the widget. */
    protected onKeydown(event: KeyboardEvent, id: string): void {
        const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
            return;
        }

        event.preventDefault();
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            this.editor.move(id, delta);
            return;
        }

        const widgets = this.editor.draft()?.widgets ?? [];
        const next = widgets[widgets.findIndex(widget => widget.id === id) + delta];
        if (next) this.selectedId.set(next.id);
    }
}
```

Create `canvas-editor.component.html`:

```html
<section class="flex flex-col gap-4">
    <header class="flex flex-col gap-1">
        <h3 class="text-base font-semibold text-text-primary">{{ 'PROFILE.CANVAS.EDITOR.TITLE' | translate }}</h3>
        <p class="text-sm text-text-muted">{{ 'PROFILE.CANVAS.EDITOR.SUBTITLE' | translate }}</p>
    </header>

    <div class="flex flex-wrap gap-2">
        @for (definition of registry; track definition.type) {
            <button
                (click)="insert(definition.type)"
                [disabled]="!editor.canInsert(definition.type)"
                class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-hover px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="insert-widget"
                type="button"
            >
                <i [class]="'pi ' + definition.icon" class="text-xs"></i>
                {{ definition.labelKey | translate }}
            </button>
        }
    </div>

    @if (editor.draft(); as draft) {
        @if (owner(); as profile) {
            <div class="flex flex-col gap-4 lg:flex-row">
                <div class="min-w-0 flex-1">
                    <app-profile-canvas [canvas]="draft" [columns]="4" [owner]="profile" />

                    <ul class="mt-3 flex flex-col gap-1">
                        @for (widget of draft.widgets; track widget.id; let i = $index) {
                            <li
                                (dragend)="dragIndex.set(null)"
                                (dragover)="onDragOver($event, i)"
                                (dragstart)="dragIndex.set(i)"
                                (drop)="onDrop($event, i)"
                                [class.opacity-40]="dragIndex() === i"
                                [class.border-brand]="selectedId() === widget.id"
                                [class.border-border]="selectedId() !== widget.id"
                                class="flex items-center gap-2 rounded-lg border bg-card px-2 py-2 transition-colors"
                                draggable="true"
                            >
                                <i class="pi pi-bars cursor-grab text-xs text-text-faint"></i>

                                <button
                                    (click)="selectedId.set(widget.id)"
                                    (keydown)="onKeydown($event, widget.id)"
                                    class="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-text-primary"
                                    type="button"
                                >
                                    {{ labelFor(widget.type) | translate }}
                                </button>

                                <button
                                    (click)="editor.move(widget.id, -1)"
                                    [attr.aria-label]="'PROFILE.CANVAS.EDITOR.MOVE_UP' | translate"
                                    [disabled]="i === 0"
                                    class="cursor-pointer border-0 bg-transparent p-1 text-xs text-text-muted disabled:opacity-30"
                                    type="button"
                                >
                                    <i class="pi pi-chevron-up"></i>
                                </button>
                                <button
                                    (click)="editor.move(widget.id, 1)"
                                    [attr.aria-label]="'PROFILE.CANVAS.EDITOR.MOVE_DOWN' | translate"
                                    [disabled]="i === draft.widgets.length - 1"
                                    class="cursor-pointer border-0 bg-transparent p-1 text-xs text-text-muted disabled:opacity-30"
                                    type="button"
                                >
                                    <i class="pi pi-chevron-down"></i>
                                </button>
                                <button
                                    (click)="remove(widget.id)"
                                    [attr.aria-label]="'PROFILE.CANVAS.EDITOR.REMOVE' | translate"
                                    class="cursor-pointer border-0 bg-transparent p-1 text-xs text-offline"
                                    type="button"
                                >
                                    <i class="pi pi-trash"></i>
                                </button>
                            </li>
                        }
                    </ul>
                </div>

                @if (selected(); as widget) {
                    <app-widget-properties [widget]="widget" class="w-full shrink-0 lg:w-80" />
                }
            </div>
        }
    }

    <div class="flex items-center gap-2">
        <button
            (click)="save()"
            [disabled]="!editor.dirty() || store.saving()"
            class="cursor-pointer rounded-lg border-0 bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="save-canvas"
            type="button"
        >
            {{ 'PROFILE.CANVAS.EDITOR.SAVE' | translate }}
        </button>
        <button
            (click)="confirmDiscard()"
            [disabled]="!editor.dirty()"
            class="cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2 text-sm text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
            type="button"
        >
            {{ 'PROFILE.CANVAS.EDITOR.DISCARD' | translate }}
        </button>
    </div>
</section>
```

- [ ] **Step 3b: Confirm before discarding**

Discard is the only action here that loses work. Closing settings does not: `CanvasEditorService` is
`providedIn: 'root'`, so a dirty draft survives and reopening settings returns to it. Do not add a
prompt for that.

Add `ConfirmationService` to the component's `providers` and `ConfirmDialog` to its `imports`, then:

```ts
    private confirm = inject(ConfirmationService);

    protected confirmDiscard(): void {
        if (!this.editor.dirty()) return;
        this.confirm.confirm({
            header: 'PROFILE.CANVAS.EDITOR.DISCARD',
            message: 'PROFILE.CANVAS.EDITOR.DISCARD_CONFIRM',
            accept: () => {
                this.editor.discard();
                this.selectedId.set(null);
            },
        });
    }
```

Point the Discard button at `confirmDiscard()` rather than `editor.discard()`, and add
`<p-confirmdialog />` at the end of the template. Add the key to `en.json`:

```json
  "PROFILE.CANVAS.EDITOR.DISCARD_CONFIRM": "This throws away every change you have not saved."
```

- [ ] **Step 4: Mount it in profile settings**

In `profile-settings.component.ts`, add `CanvasEditorComponent` to the `imports` array. In `profile-settings.component.html`, add it below the existing appearance controls, before the closing element of the page:

```html
<app-canvas-editor />
```

- [ ] **Step 5: Run the tests**

Run: `bun run ng test --watch=false --include="**/canvas-editor.component.spec.ts"`
Expected: PASS, all four cases. Task 11 creates `widget-properties.component.ts`; write a minimal stub of it now so this task compiles, and fill it in next task:

```ts
import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../../../../dtos/response/profile-canvas.dto';

@Component({
    selector: 'app-widget-properties',
    template: '',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetPropertiesComponent {
    readonly widget = input.required<CanvasWidgetDto>();
}
```

- [ ] **Step 6: Lint, format, commit**

```bash
bun run lint
bun run prettier --write "src/app/features/settings/settings-modal/pages/profile-settings/**"
git add src/app/features/settings/settings-modal/pages/profile-settings/
git commit -m "feat(profile): add the canvas editor shell to profile settings"
```

---

### Task 11: The properties panel

One panel drives every widget type off `WidgetDefinition.fields`. Nine forms would be nine places to forget a `maxLength`.

**Files:**

- Modify: `.../profile-settings/canvas-editor/widget-properties.component.ts` (replaces the Task 10 stub)
- Create: `.../profile-settings/canvas-editor/widget-properties.component.html`
- Test: `.../profile-settings/canvas-editor/widget-properties.component.spec.ts`

**Interfaces:**

- Consumes: `WidgetField`, `definitionFor` (Task 4), `CanvasEditorService` (Task 9), `ProfileCanvasApiService.uploadImage` (Task 3).
- Produces: `WidgetPropertiesComponent`, selector `app-widget-properties`, input `widget: CanvasWidgetDto`.

- [ ] **Step 1: Write the failing test**

```ts
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {WidgetPropertiesComponent} from './widget-properties.component';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../../../../services/profile-canvas-api.service';
import {emptyCanvas} from '../../../../../../models/profile-canvas';

function setup(type: string) {
    TestBed.configureTestingModule({
        providers: [provideTranslateService(), {provide: ProfileCanvasApiService, useValue: {}}],
    });
    const editor = TestBed.inject(CanvasEditorService);
    editor.begin(emptyCanvas('p1'));
    editor.insert(type);

    const fixture = TestBed.createComponent(WidgetPropertiesComponent);
    fixture.componentRef.setInput('widget', editor.draft()!.widgets[0]);
    fixture.detectChanges();
    return {fixture, editor};
}

describe('WidgetPropertiesComponent', () => {
    it('draws one control per declared field', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="field"]')).toHaveLength(2);
    });

    it('typing into a text field patches the config', () => {
        const {fixture, editor} = setup('quote');
        const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
        input.value = 'a new line';
        input.dispatchEvent(new Event('input'));

        expect((editor.draft()!.widgets[0].config as {text: string}).text).toBe('a new line');
    });

    it('offers every footprint the registry allows for the type', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="footprint"]')).toHaveLength(3);
    });

    it('draws the three visibility choices', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="visibility"]')).toHaveLength(3);
    });

    it('draws no field controls for a widget that declares none', () => {
        const {fixture} = setup('mutuals');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="field"]')).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/widget-properties.component.spec.ts"`
Expected: FAIL, the stub renders nothing.

- [ ] **Step 3: Write the component**

Replace `widget-properties.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CanvasVisibility, CanvasWidgetDto} from '../../../../../../dtos/response/profile-canvas.dto';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../../../../services/profile-canvas-api.service';
import {definitionFor, WidgetField} from '../../../../../../components/profile-canvas/widget-registry';
import {Footprint} from '../../../../../../models/profile-canvas';

const VISIBILITIES: readonly CanvasVisibility[] = ['everyone', 'friends', 'mutuals'];

@Component({
    selector: 'app-widget-properties',
    imports: [TranslateModule],
    templateUrl: './widget-properties.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetPropertiesComponent {
    readonly widget = input.required<CanvasWidgetDto>();

    protected readonly uploadFailed = signal(false);

    private editorSvc = inject(CanvasEditorService);
    private api = inject(ProfileCanvasApiService);

    protected get visibilities(): readonly CanvasVisibility[] {
        return VISIBILITIES;
    }

    protected readonly fields = computed(() => definitionFor(this.widget().type)?.fields ?? []);

    protected readonly footprints = computed(() => definitionFor(this.widget().type)?.footprints ?? []);

    protected readonly config = computed(() => this.widget().config as Record<string, unknown>);

    protected valueOf(field: WidgetField): string {
        const value = this.config()[field.key];
        return typeof value === 'string' ? value : '';
    }

    protected rowsOf(field: WidgetField): Record<string, string>[] {
        const value = this.config()[field.key];
        return Array.isArray(value) ? (value as Record<string, string>[]) : [];
    }

    protected setText(field: WidgetField, event: Event): void {
        const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: value});
    }

    protected addRow(field: WidgetField): void {
        if (field.kind !== 'rows' || this.rowsOf(field).length >= field.max) return;
        const blank = Object.fromEntries(field.columns.map(column => [column.key, '']));
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: [...this.rowsOf(field), blank]});
    }

    protected removeRow(field: WidgetField, index: number): void {
        const rows = this.rowsOf(field).filter((_, i) => i !== index);
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: rows});
    }

    protected setCell(field: WidgetField, index: number, key: string, event: Event): void {
        const value = (event.target as HTMLInputElement).value;
        const rows = this.rowsOf(field).map((row, i) => (i === index ? {...row, [key]: value} : row));
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: rows});
    }

    protected upload(field: WidgetField, event: Event): void {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) return;

        this.uploadFailed.set(false);
        this.api.uploadImage(file).subscribe({
            next: image => {
                if (field.kind === 'images') {
                    const items = this.rowsOf(field);
                    this.editorSvc.patchConfig(this.widget().id, {
                        [field.key]: [...items, {imageId: image.imageId, alt: ''}],
                    });
                    return;
                }
                this.editorSvc.patchConfig(this.widget().id, {[field.key]: image.imageId});
            },
            error: () => this.uploadFailed.set(true),
        });
    }

    protected resize(footprint: Footprint): void {
        this.editorSvc.resize(this.widget().id, footprint);
    }

    protected setVisibility(visibility: CanvasVisibility): void {
        this.editorSvc.setVisibility(this.widget().id, visibility);
    }

    protected toggleCard(): void {
        this.editorSvc.setCard(this.widget().id, !this.widget().card);
    }

    protected visibilityKey(visibility: CanvasVisibility): string {
        return `PROFILE.CANVAS.EDITOR.VISIBILITY_${visibility.toUpperCase()}`;
    }
}
```

Create `widget-properties.component.html`:

```html
<div class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
    @for (field of fields(); track field.key) {
        <label class="flex flex-col gap-1.5" data-testid="field">
            <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-text-muted">
                {{ field.labelKey | translate }}
            </span>

            @switch (field.kind) {
                @case ('textarea') {
                    <textarea
                        (input)="setText(field, $event)"
                        [attr.maxlength]="$any(field).maxLength"
                        [value]="valueOf(field)"
                        class="thin-scrollbar min-h-20 rounded-lg border border-border bg-app-bg p-2 text-sm text-text-primary"
                    ></textarea>
                }
                @case ('rows') {
                    <div class="flex flex-col gap-2">
                        @for (row of rowsOf(field); track $index) {
                            <div class="flex items-center gap-1.5">
                                @for (column of $any(field).columns; track column.key) {
                                    <input
                                        (input)="setCell(field, $index, column.key, $event)"
                                        [attr.maxlength]="column.maxLength"
                                        [placeholder]="column.labelKey | translate"
                                        [value]="row[column.key] ?? ''"
                                        class="min-w-0 flex-1 rounded-lg border border-border bg-app-bg px-2 py-1.5 text-sm text-text-primary"
                                    />
                                }
                                <button
                                    (click)="removeRow(field, $index)"
                                    [attr.aria-label]="'PROFILE.CANVAS.EDITOR.REMOVE_ROW' | translate"
                                    class="cursor-pointer border-0 bg-transparent p-1 text-xs text-text-muted"
                                    type="button"
                                >
                                    <i class="pi pi-times"></i>
                                </button>
                            </div>
                        }
                        <button
                            (click)="addRow(field)"
                            class="cursor-pointer self-start rounded-lg border border-border bg-transparent px-2 py-1 text-xs text-text-secondary"
                            type="button"
                        >
                            {{ 'PROFILE.CANVAS.EDITOR.ADD_ROW' | translate }}
                        </button>
                    </div>
                }
                @case ('image') {
                    <input (change)="upload(field, $event)" accept="image/*" class="text-sm text-text-secondary" type="file" />
                }
                @case ('images') {
                    <input (change)="upload(field, $event)" accept="image/*" class="text-sm text-text-secondary" type="file" />
                }
                @default {
                    <input
                        (input)="setText(field, $event)"
                        [attr.maxlength]="$any(field).maxLength"
                        [value]="valueOf(field)"
                        class="rounded-lg border border-border bg-app-bg px-2 py-1.5 text-sm text-text-primary"
                        type="text"
                    />
                }
            }
        </label>
    }

    @if (uploadFailed()) {
        <p class="text-xs text-offline">{{ 'PROFILE.CANVAS.EDITOR.UPLOAD_FAILED' | translate }}</p>
    }

    <div class="flex flex-col gap-1.5">
        <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-text-muted">
            {{ 'PROFILE.CANVAS.EDITOR.SIZE' | translate }}
        </span>
        <div class="flex flex-wrap gap-1.5">
            @for (footprint of footprints(); track footprint.w + 'x' + footprint.h) {
                <button
                    (click)="resize(footprint)"
                    [class.border-brand]="widget().w === footprint.w && widget().h === footprint.h"
                    class="cursor-pointer rounded-lg border border-border bg-app-bg px-2 py-1 text-xs text-text-secondary"
                    data-testid="footprint"
                    type="button"
                >
                    {{ footprint.w }} &times; {{ footprint.h }}
                </button>
            }
        </div>
    </div>

    <div class="flex flex-col gap-1.5">
        <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-text-muted">
            {{ 'PROFILE.CANVAS.EDITOR.VISIBILITY' | translate }}
        </span>
        <div class="flex flex-wrap gap-1.5">
            @for (visibility of visibilities; track visibility) {
                <button
                    (click)="setVisibility(visibility)"
                    [class.border-brand]="widget().visibility === visibility"
                    class="cursor-pointer rounded-lg border border-border bg-app-bg px-2 py-1 text-xs text-text-secondary"
                    data-testid="visibility"
                    type="button"
                >
                    {{ visibilityKey(visibility) | translate }}
                </button>
            }
        </div>
    </div>

    <label class="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
        <input (change)="toggleCard()" [checked]="widget().card" type="checkbox" />
        {{ 'PROFILE.CANVAS.EDITOR.CARD' | translate }}
    </label>
</div>
```

- [ ] **Step 4: Run the tests**

Run: `bun run ng test --watch=false --include="**/widget-properties.component.spec.ts"`
Expected: PASS, all five cases.

- [ ] **Step 5: Lint, format, commit**

```bash
bun run lint
bun run prettier --write "src/app/features/settings/settings-modal/pages/profile-settings/**"
git add src/app/features/settings/settings-modal/pages/profile-settings/
git commit -m "feat(profile): add the canvas widget properties panel"
```

---

### Task 12: Canvas tab in the profile modal

**Files:**

- Modify: `src/app/components/profile-modal/profile-modal.component.ts`
- Modify: `src/app/components/profile-modal/profile-modal.component.html`
- Modify: `src/app/services/profile-popout.service.ts`
- Modify: `src/app/components/profile-modal/profile-modal.component.spec.ts`

**Interfaces:**

- Consumes: `ProfileCanvasStore` (Task 3), `ProfileCanvasComponent` (Task 4).
- Produces: `ProfileModalTab` gains `'canvas'`.

- [ ] **Step 1: Widen the tab union**

In `profile-popout.service.ts`, find `ProfileModalTab` and add `'canvas'`:

```ts
export type ProfileModalTab = 'canvas' | 'activity' | 'friends' | 'servers';
```

- [ ] **Step 2: Write the failing tests**

Append to `profile-modal.component.spec.ts`, following the file's existing setup helper:

```ts
    it('opens on the canvas tab when the subject has widgets', () => {
        // Arrange the store to answer a canvas with one widget for the subject, then open the modal.
        // Expect effectiveTab() to be 'canvas'.
    });

    it('falls back to activity when the canvas is empty', () => {
        // Arrange the store to answer an empty canvas, then open the modal.
        // Expect effectiveTab() to be 'activity'.
    });
```

Replace both comment bodies with real arrangement using the spec file's existing helpers. The store is provided as a fake exposing `canvasFor`, `ensureLoaded` and `saving`, the same shape Task 10's spec uses.

- [ ] **Step 3: Run to verify they fail**

Run: `bun run ng test --watch=false --include="**/profile-modal.component.spec.ts"`
Expected: FAIL on both new cases.

- [ ] **Step 4: Wire the tab**

In `profile-modal.component.ts`:

- Add `ProfileCanvasComponent` to `imports`.
- Add `private canvasStore = inject(ProfileCanvasStore);`
- Add:

```ts
    protected readonly canvas = computed(() => {
        const profile = this.profile();
        return profile ? this.canvasStore.canvasFor(profile.id) : undefined;
    });

    protected readonly showCanvasTab = computed(() => (this.canvas()?.widgets.length ?? 0) > 0);
```

- In the constructor effect, after `this.profile.set(cached)` and inside the `subscribe` callback, call `this.canvasStore.ensureLoaded(profile.id)`.
- Extend `effectiveTab` so a requested `'canvas'` falls back when there is nothing to show, and so the default lands on canvas:

```ts
    protected readonly effectiveTab = computed((): ProfileModalTab => {
        const tab = this.tab();
        if (tab === 'canvas' && !this.showCanvasTab()) return 'activity';
        if (tab === 'friends' && !this.showFriendsTab()) return 'activity';
        if (tab === 'servers' && !this.showServersTab()) return 'activity';
        return tab;
    });
```

- In the effect, when `target.tab` is the default `'activity'` and the canvas has widgets, set `'canvas'` instead. Do this after the canvas lands, not before: the store is cold on first open.

In `profile-modal.component.html`, add the tab button before the Activity button:

```html
@if (showCanvasTab()) {
    <button
        (click)="selectTab('canvas')"
        [class.border-white]="effectiveTab() === 'canvas'"
        [class.border-transparent]="effectiveTab() !== 'canvas'"
        [class.text-white]="effectiveTab() === 'canvas'"
        [class.text-text-muted]="effectiveTab() !== 'canvas'"
        class="cursor-pointer border-0 border-b-2 bg-transparent px-0 pb-2.5 text-sm font-semibold transition-colors hover:text-text-primary"
        type="button"
    >
        {{ 'PROFILE.CANVAS.TAB' | translate }}
    </button>
}
```

And a case in the `@switch`, before `@case ('activity')`:

```html
@case ('canvas') {
    @if (canvas(); as arranged) {
        @if (profile(); as subject) {
            <app-profile-canvas [canvas]="arranged" [columns]="2" [owner]="subject" />
        }
    }
}
```

Two columns, not four: the modal's right pane is 24rem wide.

- [ ] **Step 5: Run the tests**

Run: `bun run ng test --watch=false --include="**/profile-modal.component.spec.ts"`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 6: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/components/profile-modal/ src/app/services/profile-popout.service.ts
git add src/app/components/profile-modal/ src/app/services/profile-popout.service.ts
git commit -m "feat(profile): show the canvas in the profile modal"
```

---

### Task 13: Card widgets in the popout

The popout must not become a fan-out on hover. It reads what the store already holds and never fetches.

**Files:**

- Modify: `src/app/components/profile-popout/profile-popout.component.ts`
- Modify: `src/app/components/profile-popout/profile-popout.component.html`
- Modify: `src/app/components/profile-popout/profile-popout.component.spec.ts`

**Interfaces:**

- Consumes: `ProfileCanvasStore.canvasFor` (Task 3), `ProfileCanvasComponent` with `cardOnly` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `profile-popout.component.spec.ts`, using its existing setup helper and a fake store:

```ts
    it('draws card widgets the store already holds', () => {
        // Fake store answers a canvas with one card widget for the subject.
        // Expect app-profile-canvas to be present.
    });

    it('draws no canvas when the store is cold', () => {
        // Fake store answers undefined.
        // Expect app-profile-canvas to be absent.
    });

    it('never calls ensureLoaded', () => {
        // Spy on the fake store's ensureLoaded; open the popout.
        // Expect the spy not to have been called.
    });
```

Fill each body in against the spec file's existing helpers. The third case is the one that matters: it is the guard against a hover storm, and it is the reason this component reads the cache rather than asking for it.

- [ ] **Step 2: Run to verify they fail**

Run: `bun run ng test --watch=false --include="**/profile-popout.component.spec.ts"`
Expected: FAIL on all three new cases.

- [ ] **Step 3: Wire the card widgets**

In `profile-popout.component.ts`:

- Add `ProfileCanvasComponent` to `imports`.
- Add `private canvasStore = inject(ProfileCanvasStore);`
- Add:

```ts
    /**
     * Cache read only. A popout opens on hover in a member list, so a fetch here is a fan-out;
     * the modal is what warms this.
     */
    protected readonly cardCanvas = computed(() => {
        const profile = this.profile();
        const canvas = profile ? this.canvasStore.canvasFor(profile.id) : undefined;
        return canvas?.widgets.some(widget => widget.card) ? canvas : undefined;
    });
```

In `profile-popout.component.html`, add below the mutual line:

```html
@if (cardCanvas(); as arranged) {
    @if (profile(); as subject) {
        <div class="px-3 pb-3">
            <app-profile-canvas [canvas]="arranged" [cardOnly]="true" [columns]="1" [owner]="subject" />
        </div>
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun run ng test --watch=false --include="**/profile-popout.component.spec.ts"`
Expected: PASS, including the pre-existing placement cases.

- [ ] **Step 5: Run the whole suite**

Run: `bun run test`
Expected: green, and no fewer passing than the baseline before Task 1.

A new failure in a component you did not touch is usually Vitest re-batching files across workers after the new spec files, not your change. Check whether the failing spec declares `readonly x = SOME_IMPORTED_CONST` as a class field before assuming otherwise.

- [ ] **Step 6: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/components/profile-popout/
git add src/app/components/profile-popout/
git commit -m "feat(profile): show card widgets in the profile popout"
```

---

### Task 14: Canvas theme, backdrop and accent

`CanvasTheme` is in the DTO from Task 2 and nothing draws it yet. This closes that.

**Files:**

- Create: `src/app/components/profile-canvas/canvas-backdrop.ts`
- Modify: `src/app/components/profile-canvas/profile-canvas.component.ts`
- Modify: `src/app/components/profile-canvas/profile-canvas.component.html`
- Modify: `.../profile-settings/canvas-editor/canvas-editor.component.ts`
- Modify: `.../profile-settings/canvas-editor/canvas-editor.component.html`
- Modify: `src/app/services/canvas-editor.service.ts`
- Test: `src/app/components/profile-canvas/canvas-backdrop.spec.ts`

**Interfaces:**

- Consumes: `CanvasTheme`, `CanvasBackdrop` (Task 2), `ProfileCanvasApiService.imageUrl` (Task 3), `safeAccentColor` and `readableAccent` from `models/profile-font.model.ts`.
- Produces: `backdropStyle(backdrop, imageUrl): Record<string, string>`, `canvasAccent(theme, profile): string | null`, and `CanvasEditorService.setTheme(patch: Partial<CanvasTheme>)`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/components/profile-canvas/canvas-backdrop.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {backdropStyle, canvasAccent} from './canvas-backdrop';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../dtos/response/profile.dto';

function profile(accentColor: string | null): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Nova',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

describe('backdropStyle', () => {
    it('is empty for no backdrop', () => {
        expect(backdropStyle(null, () => '')).toEqual({});
    });

    it('builds a gradient from two stops', () => {
        const style = backdropStyle({kind: 'gradient', from: '#112233', to: '#445566'}, () => '');
        expect(style['background-image']).toContain('#112233');
        expect(style['background-image']).toContain('#445566');
    });

    it('ignores a gradient stop that is not a hex colour', () => {
        const style = backdropStyle({kind: 'gradient', from: 'url(javascript:alert(1))', to: '#445566'}, () => '');
        expect(style).toEqual({});
    });

    it('builds an image backdrop from the id', () => {
        const style = backdropStyle({kind: 'image', imageId: 'img1'}, id => `https://cdn.test/${id}`);
        expect(style['background-image']).toBe('url("https://cdn.test/img1")');
    });

    it('is empty for an image backdrop with no id', () => {
        expect(backdropStyle({kind: 'image'}, () => 'x')).toEqual({});
    });
});

describe('canvasAccent', () => {
    it('prefers the canvas accent', () => {
        expect(canvasAccent({accent: '#4b5bc4', backdrop: null}, profile('#ff0000'))).toBeTruthy();
    });

    it('falls back to the profile accent', () => {
        expect(canvasAccent({accent: null, backdrop: null}, profile('#ff0000'))).toBeTruthy();
    });

    it('is null when neither is set', () => {
        expect(canvasAccent({accent: null, backdrop: null}, profile(null))).toBeNull();
    });

    it('rejects a non-hex accent rather than passing it through', () => {
        expect(canvasAccent({accent: 'red; background: url(x)', backdrop: null}, profile(null))).toBeNull();
    });
});
```

The two rejection cases are the point. A backdrop and an accent are the only user-supplied values that reach a style attribute, so they are the only place a canvas could become an injection surface. `safeAccentColor` already enforces `^#[0-9a-fA-F]{6}$` and is the gate for both.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/canvas-backdrop.spec.ts"`
Expected: FAIL, cannot resolve `./canvas-backdrop`.

- [ ] **Step 3: Write the helpers**

Create `src/app/components/profile-canvas/canvas-backdrop.ts`:

```ts
import {CanvasBackdrop, CanvasTheme} from '../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {readableAccent, safeAccentColor} from '../../models/profile-font.model';

/** The only user-supplied values that reach a style attribute. Both go through safeAccentColor. */
export function backdropStyle(
    backdrop: CanvasBackdrop | null,
    imageUrl: (imageId: string) => string,
): Record<string, string> {
    if (!backdrop) return {};

    if (backdrop.kind === 'image') {
        if (!backdrop.imageId) return {};
        return {
            'background-image': `url("${imageUrl(backdrop.imageId)}")`,
            'background-size': 'cover',
            'background-position': 'center',
        };
    }

    const from = safeAccentColor(backdrop.from);
    const to = safeAccentColor(backdrop.to);
    if (!from || !to) return {};
    return {'background-image': `linear-gradient(140deg, ${from}, ${to})`};
}

/** The canvas accent, then the profile's, lifted until it reads on a dark surface. */
export function canvasAccent(theme: CanvasTheme, profile: ProfileDto): string | null {
    return readableAccent(theme.accent) ?? readableAccent(profile.accentColor);
}
```

`imageUrl` is passed in rather than injected so this module stays pure and testable without a TestBed.

- [ ] **Step 4: Draw it in the grid**

In `profile-canvas.component.ts`, add:

```ts
    private api = inject(ProfileCanvasApiService);

    protected readonly backdrop = computed(() =>
        backdropStyle(this.canvas().theme.backdrop, id => this.api.imageUrl(id)),
    );

    protected readonly accent = computed(() => canvasAccent(this.canvas().theme, this.owner()));
```

In `profile-canvas.component.html`, wrap the existing grid:

```html
<div [style]="backdrop()" [style.--canvas-accent]="accent()" class="rounded-xl">
    <!-- existing grid div, unchanged -->
</div>
```

Cells pick the accent up through their border: change the cell class from `border-border` to `border-[var(--canvas-accent,var(--color-border))]`. One token, no per-widget styling, and a canvas with no accent looks exactly as it does today.

- [ ] **Step 5: Add setTheme to the editor service**

In `canvas-editor.service.ts`:

```ts
    setTheme(patch: Partial<CanvasTheme>): void {
        const canvas = this.current();
        if (!canvas) return;
        this.current.set({...canvas, theme: {...canvas.theme, ...patch}});
    }
```

Change `dirty` to compare the theme too, since a theme-only change must enable Save:

```ts
    readonly dirty = computed(() => {
        const canvas = this.current();
        return !!canvas && JSON.stringify([canvas.widgets, canvas.theme]) !== this.baseline();
    });
```

Update `begin` and `discard` to stamp and restore `[widgets, theme]` rather than `widgets` alone. Add a case to `canvas-editor.service.spec.ts`:

```ts
    it('a theme change alone marks the editor dirty', () => {
        editor.setTheme({accent: '#4b5bc4'});
        expect(editor.dirty()).toBe(true);
    });
```

- [ ] **Step 6: Add the theme controls to the editor**

In `canvas-editor.component.html`, above the insert menu. `p-colorpicker` earns its place here; a hand-rolled colour picker does not.

```html
<div class="flex flex-wrap items-center gap-3">
    <label class="flex items-center gap-2 text-sm text-text-secondary">
        {{ 'PROFILE.CANVAS.EDITOR.ACCENT' | translate }}
        <p-colorpicker (ngModelChange)="editor.setTheme({accent: $event})" [ngModel]="draft.theme.accent ?? '#4b5bc4'" />
    </label>
    <button
        (click)="editor.setTheme({accent: null, backdrop: null})"
        class="cursor-pointer rounded-lg border border-border bg-transparent px-2 py-1 text-xs text-text-muted"
        type="button"
    >
        {{ 'PROFILE.CANVAS.EDITOR.THEME_RESET' | translate }}
    </button>
</div>
```

Add `ColorPickerModule` and `FormsModule` to the component's `imports`, and these keys to `en.json`:

```json
  "PROFILE.CANVAS.EDITOR.ACCENT": "Accent",
  "PROFILE.CANVAS.EDITOR.THEME_RESET": "Reset the look"
```

- [ ] **Step 7: Run the tests, lint, format, commit**

```bash
bun run ng test --watch=false --include="**/canvas-backdrop.spec.ts"
bun run ng test --watch=false --include="**/canvas-editor.service.spec.ts"
bun run lint
bun run prettier --write src/app/components/profile-canvas/ src/app/services/canvas-editor.service.ts src/assets/i18n/locales/en.json "src/app/features/settings/settings-modal/pages/profile-settings/**"
git add src/app/components/profile-canvas/ src/app/services/canvas-editor.service.ts src/assets/i18n/locales/en.json src/app/features/settings/settings-modal/pages/profile-settings/
git commit -m "feat(profile): draw the canvas backdrop and accent"
```

---

### Task 15: Realtime canvas updates

A canvas is a row another screen can be looking at while its owner rearranges it. One event, one listener in the store, and every open surface follows.

**Files:**

- Modify: `src/app/services/realtime-events.ts`
- Modify: `src/app/stores/profile-canvas.store.ts`
- Modify: `src/app/stores/profile-canvas.store.spec.ts`

**Interfaces:**

- Consumes: `RealtimeConnectionService.stream` (existing), `FakeRealtimeConnection` from `src/app/testing/fake-realtime-connection.ts`.
- Produces: `WsProfileCanvasUpdated`, and the `'social.ProfileCanvasUpdated'` entry in `RealtimeEventMap`.

Scope it to one event. There is no per-widget event: a canvas is saved whole, so a partial event would be a shape the server never produces. That is the "worth it" line here.

- [ ] **Step 1: Declare the event**

In `src/app/services/realtime-events.ts`, beside the other payload interfaces:

```ts
/** The whole document. The event object is the payload, so a field missing here is missing on the wire. */
export interface WsProfileCanvasUpdated {
    profileId: string;
    canvas: ProfileCanvasDto;
}
```

Import `ProfileCanvasDto` at the top, and add to `RealtimeEventMap`:

```ts
    'social.ProfileCanvasUpdated': WsProfileCanvasUpdated;
```

- [ ] **Step 2: Write the failing tests**

Add to `profile-canvas.store.spec.ts`. Extend `setup()` to provide the fake realtime connection:

```ts
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';

function setup() {
    const api = new FakeApi();
    const realtime = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: ProfileCanvasApiService, useValue: api},
            {provide: RealtimeConnectionService, useValue: realtime},
        ],
    });
    return {api, realtime, store: TestBed.inject(ProfileCanvasStore)};
}
```

Then the cases:

```ts
    it('applies a realtime update to a canvas it holds', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 3)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);
    });

    it('normalises what the event carried', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        const wide = canvas('p1', 1);
        wide.widgets[0].w = 9;
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: wide});

        expect(store.canvasFor('p1')?.widgets[0].w).toBe(4);
    });

    it('ignores an event for a profile it never loaded', () => {
        const {realtime, store} = setup();
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p9', canvas: canvas('p9', 2)});
        expect(store.canvasFor('p9')).toBeUndefined();
    });

    it('does not let an event clobber a save in flight', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        store.save(canvas('p1', 5)).subscribe();
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 2)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(5);
    });
});
```

The last case is the one that bites in practice. Your own save produces the event you are about to receive, and it arrives after the optimistic write, so an unguarded listener rolls your editor back to the pre-save state for a frame.

- [ ] **Step 3: Run to verify they fail**

Run: `bun run ng test --watch=false --include="**/profile-canvas.store.spec.ts"`
Expected: FAIL on all four new cases.

- [ ] **Step 4: Add the listener**

In `profile-canvas.store.ts`, add `withHooks` after `withMethods`:

```ts
    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('social.ProfileCanvasUpdated').subscribe((event: WsProfileCanvasUpdated) => {
                // Only a canvas already on screen. An event for an unknown profile is not a reason to cache one.
                const entry = store.byProfile()[event.profileId];
                if (!entry?.canvas) return;
                // Our own save is echoed back as this event, and it lands after the optimistic write.
                if (store.saving()) return;

                patchState(store, {
                    byProfile: {
                        ...store.byProfile(),
                        [event.profileId]: {...entry, canvas: normalise(event.canvas)},
                    },
                });
            });
        },
    }),
```

Import `withHooks` from `@ngrx/signals`, `RealtimeConnectionService`, and `WsProfileCanvasUpdated`.

- [ ] **Step 5: Run the tests**

Run: `bun run ng test --watch=false --include="**/profile-canvas.store.spec.ts"`
Expected: PASS, including the eight pre-existing cases.

- [ ] **Step 6: Run the whole suite**

Run: `bun run test`
Expected: green, no fewer passing than the baseline before Task 1.

- [ ] **Step 7: Lint, format, commit**

```bash
bun run lint
bun run prettier --write src/app/stores/profile-canvas.store.ts src/app/stores/profile-canvas.store.spec.ts src/app/services/realtime-events.ts
git add src/app/stores/profile-canvas.store.ts src/app/stores/profile-canvas.store.spec.ts src/app/services/realtime-events.ts
git commit -m "feat(profile): follow canvas updates over the socket"
```

---

## Backend

Not in this plan. It lives in `RiderProjects\Echo` and needs its own work item covering the four endpoints in section 8 of the spec, plus the realtime event Task 15 listens for:

```
GET    /api/v1/social/profiles/{profileId}/canvas
PUT    /api/v1/social/profiles/me/canvas
POST   /api/v1/social/profiles/me/canvas/images
DELETE /api/v1/social/profiles/me/canvas/images/{imageId}

social.ProfileCanvasUpdated   { profileId, canvas }
```

The event is published to whoever can see that profile, after the visibility gate, so each recipient gets the canvas as they are allowed to see it. Publishing one unfiltered payload to everybody would leak exactly what section 7 exists to prevent.

Until all of that exists:

- `GET .../canvas` 404s, so `ensureLoaded` records the failure and `canvasFor` stays undefined. Every read surface renders exactly as it does today.
- The editor works against an empty canvas and fails on save with the `PROFILE.CANVAS.EDITOR.SAVE_FAILED` toast.
- Task 15's listener never fires, and its tests pass regardless since they drive the fake connection directly.

That is a usable checkpoint. Stop there and confirm nothing regressed before the server side lands.
