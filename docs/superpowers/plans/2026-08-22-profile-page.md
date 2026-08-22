# Profile Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the profile its own page, edited in place, and move every presentational field off the settings form onto it.

**Architecture:** A page shell over purely-controlled children, presenting two states, view and edit, across one seamless layout. "Edit in place" is what the person sees; it says nothing about how many components draw it, and an earlier draft of this line said "one page component" and produced a 547-line god template that four tasks then had to queue behind. The canvas renderer, the widget registry, the draft service and the properties panel already exist and are container-agnostic; this plan builds the page around them, converts the drag from list-index to cell-based with automatic spacers, and deletes the settings sections it replaces.

**Tech Stack:** Angular 21 signals, standalone components, Angular router, PrimeNG only where it earns it, ngx-translate, Tailwind token classes, Vitest through the Angular CLI.

**Spec:** `docs/superpowers/specs/2026-08-22-profile-page-design.md`
**Companion spec:** `docs/superpowers/specs/2026-08-22-profile-canvas-design.md` owns the canvas model, layout engine, registry and visibility rules. Sections 2b and 6 changed after the first plan; read them.

## Global Constraints

- Write like a person. No essays, no narrative rationale, no restating the code. Comments only for an invariant whose violation is silent, a `TODO(owner)`, or naming a non-obvious symbol.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- No Javadoc HTML in TSDoc: no `<p>`, `<b>`, `<i>`, `<br>`. Older files here have it; do not copy that.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports.
- `inject()` never constructor params. `input()` / `output()` / `model()` never decorators. `ChangeDetectionStrategy.OnPush` on every new component. Standalone, no NgModules. `@if` / `@for` / `@switch`, never structural directives.
- Never `readonly x = SOME_IMPORTED_CONST` as a class field. Use a getter.
- Tailwind token classes only, never raw hex.
- Every interactive element needs a visible focus state and an accessible name. Keyboard parity with every drag action is a requirement, not a nice-to-have.
- Tests: `bun run test`. Single spec: `bun run ng test --watch=false --include="**/name.spec.ts"`. Lint: `bun run lint`. Never bare `vitest`, never `npx ng`, never `bun run format`.
- Commits: conventional prefix, one line, lowercase, imperative. No body, no trailers, no emoji.
- Work directly on `main`. No worktrees, no branches, no `git stash`, `git checkout --`, `git reset --hard`, `git clean`, no force push. Other agents have live work in the tree; commit by explicit path and leave everything else alone.

## The Trap

`ProfileService.ownProfile` is `.set()` with a **fresh object** on every own-profile write: `updateProfile`, `uploadAvatar`, `uploadBanner`, `setSelfStatus`. Any effect keyed on that object re-runs on all of them.

An effect that calls `CanvasEditorService.begin()` on each re-run silently discards an unsaved canvas draft. This shipped once already in the settings editor and was caught in review. **On this page it is worse**, because avatar, banner and bio now live on the same screen as the canvas, so every write that triggers it happens beside the draft.

Key every effect on `profile.id`, never on the profile object. Task 3 carries the regression test and it must fail first.

## What Already Exists

Do not rebuild any of this. Read it before writing anything.

| Piece | Where | Role here |
| --- | --- | --- |
| `ProfileCanvasComponent` | `components/profile-canvas/` | Renders a canvas. Used by the page in both states. |
| `WIDGET_REGISTRY`, `definitionFor` | `components/profile-canvas/widget-registry.ts` | Nine widget types, their fields and footprints. |
| `CanvasEditorService` | `services/canvas-editor.service.ts` | The draft. Root-provided, survives navigation. |
| `ProfileCanvasStore` | `stores/profile-canvas.store.ts` | The saved canvas, keyed by profile id. |
| `WidgetPropertiesComponent` | `.../profile-settings/canvas-editor/` | Renders any widget's fields from its registry entry. Moves, unchanged. |
| `placePopout` | `components/profile-popout/place-popout.ts` | Anchors a card to an element with viewport flipping. Reuse for the widget editor. |
| `reflow`, `normalise`, `snapFootprint` | `models/profile-canvas.ts` | The layout engine. Task 1 adds `dropAt` beside them. |
| Crop dialogs | `.../profile-settings/profile-settings.component.html` | Avatar and banner cropping. Move wholesale. |

Being deleted: `canvas-editor.component.*` (the settings shell, superseded by the page) and the first four sections of `profile-settings.component.html`.

## Dependency Order

```
Wave A (parallel):   T1 dropAt + spacer   T2 route and shell
Wave B:              T3 page, view state   (needs T2)
Wave C:              T4 edit state         (needs T3)
Wave D:              T5 widget editor      (needs T4)
Wave E:              T6 visitor preview    (needs T5)
Wave F:              T7 cell drag          (needs T1 + T5)
Wave G:              T8 migrate and delete (needs everything)
```

T5, T6 and T7 all modify `profile-page.component.{ts,html}`, so they are serial. An earlier draft of
this plan put T5 and T6 in one parallel wave, which would have had two agents writing the same two
files. Only T1 and T2 are genuinely disjoint.

T8 is last and atomic: nothing is deleted from settings until the page can do all of it.

---

### Task 1: `dropAt` and the spacer widget

**Files:**
- Modify: `src/app/models/profile-canvas.ts`
- Modify: `src/app/models/profile-canvas.spec.ts`
- Create: `src/app/components/profile-canvas/widgets/spacer-widget.component.ts`
- Modify: `src/app/components/profile-canvas/widget-registry.ts`
- Modify: `src/app/components/profile-canvas/widget-registry.spec.ts`
- Modify: `src/assets/i18n/locales/en.json`

**Interfaces:**
- Consumes: `CanvasWidgetDto`, `reflow`, `normalise`, `FOOTPRINTS`, `CANVAS_COLUMNS`.
- Produces: `SPACER_TYPE`, `MAX_SPACERS`, `dropAt(widgets, id, target, columns)`, `isSpacer(widget)`, `trimTrailingSpacers(widgets)`, and a `spacer` registry entry.

Read spec section 2b of the canvas design first. It defines the whole mechanic.

- [ ] **Step 1: Write the failing tests**

Add to `profile-canvas.spec.ts`, reusing the `widget()` factory already in that file. The expected
values below were derived by running the algorithm; they are correct, do not adjust them to match
whatever your implementation happens to produce.

The shared fixture is one `4x1` marquee at row 0 and a `2x1` photo being dragged to cell `(2, 2)`.
Six cells are empty before that target: all four of row 1, and cells 0 and 1 of row 2.

```ts
describe('dropAt', () => {
    function base(): CanvasWidgetDto[] {
        return [
            widget('mar', {type: 'marquee', x: 0, y: 0, w: 4, h: 1}),
            widget('pho', {type: 'photo', x: 0, y: 1, w: 2, h: 1}),
        ];
    }

    it('places a widget exactly where it was dropped', () => {
        const out = dropAt(base(), 'pho', {x: 2, y: 2}, 4);
        expect(out.find(v => v.id === 'pho')).toMatchObject({x: 2, y: 2});
    });

    it('merges the empty cells before it into the fewest legal spacers', () => {
        const spacers = dropAt(base(), 'pho', {x: 2, y: 2}, 4).filter(isSpacer);
        expect(spacers).toHaveLength(2);
        expect(spacers[0]).toMatchObject({x: 0, y: 1, w: 4, h: 1});
        expect(spacers[1]).toMatchObject({x: 0, y: 2, w: 2, h: 1});
    });

    it('covers exactly the empty cells, no more and no fewer', () => {
        const spacers = dropAt(base(), 'pho', {x: 2, y: 2}, 4).filter(isSpacer);
        expect(spacers.reduce((n, s) => n + s.w * s.h, 0)).toBe(6);
    });

    it('adds no spacers when the target is the next free cell', () => {
        const out = dropAt(base(), 'pho', {x: 0, y: 1}, 4);
        expect(out.filter(isSpacer)).toHaveLength(0);
    });

    it('leaves a gapless arrangement, so reflow changes nothing', () => {
        const out = dropAt(base(), 'pho', {x: 2, y: 2}, 4);
        expect(reflow(out, 4)).toEqual(out);
    });

    it('does not move the widgets it did not drag', () => {
        const out = dropAt(base(), 'pho', {x: 2, y: 2}, 4);
        expect(out.find(v => v.id === 'mar')).toMatchObject({x: 0, y: 0, w: 4, h: 1});
    });

    it('clamps rather than emitting hundreds of spacers for a far drop', () => {
        const out = dropAt(base(), 'pho', {x: 0, y: 400}, 4);
        expect(out.filter(isSpacer).length).toBeLessThanOrEqual(MAX_SPACERS);
    });

    it('is a no-op when the widget is dropped on its own cell', () => {
        const start = reflow(base(), 4);
        const pho = start.find(v => v.id === 'pho')!;
        expect(dropAt(start, 'pho', {x: pho.x, y: pho.y}, 4)).toEqual(start);
    });
});

describe('trimTrailingSpacers', () => {
    it('drops spacers after the last real widget', () => {
        const out = trimTrailingSpacers([
            widget('a', {type: 'quote'}),
            widget('s', {type: SPACER_TYPE}),
        ]);
        expect(out.map(v => v.id)).toEqual(['a']);
    });

    it('keeps spacers between real widgets', () => {
        const out = trimTrailingSpacers([
            widget('a', {type: 'quote'}),
            widget('s', {type: SPACER_TYPE}),
            widget('b', {type: 'quote'}),
        ]);
        expect(out.map(v => v.id)).toEqual(['a', 's', 'b']);
    });

    it('empties a canvas of nothing but spacers', () => {
        expect(trimTrailingSpacers([widget('s', {type: SPACER_TYPE})])).toEqual([]);
    });
});
```

Every one must fail before the implementation exists. If `widget()` does not accept a `type`
override, widen it rather than writing a second factory.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun run ng test --watch=false --include="**/profile-canvas.spec.ts"`
Expected: the new cases fail, the existing 23 pass.

- [ ] **Step 3: Implement**

In `profile-canvas.ts`:

```ts
export const SPACER_TYPE = 'spacer';
export const MAX_SPACERS = 20;

export function isSpacer(widget: CanvasWidgetDto): boolean {
    return widget.type === SPACER_TYPE;
}
```

`dropAt` follows the algorithm in spec section 2b: lift the dragged widget, reflow the rest, walk reading order to the target counting unoccupied cells, emit spacers merging same-row runs into the largest legal footprint, splice spacers then the widget, reflow.

The merge is the part worth getting right. A run of `n` consecutive empty cells in one row becomes the largest footprint that fits, repeatedly, so 3 becomes a 2x1 and a 1x1.

`trimTrailingSpacers` drops spacers after the last non-spacer. It is called on save, not on every edit, because a trailing spacer is how you keep dragging downward.

- [ ] **Step 4: Write the spacer component**

`spacer-widget.component.ts` renders nothing. It exists so the registry can resolve a component and so the grid draws an empty cell of the right size.

```ts
@Component({
    selector: 'app-spacer-widget',
    template: '',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpacerWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();
}
```

Two inputs it never reads, because the widget contract requires them and consistency across ten types is worth more than saving two lines.

- [ ] **Step 5: Register it**

```ts
{
    type: 'spacer',
    component: SpacerWidgetComponent,
    footprints: [{w: 1, h: 1}, {w: 2, h: 1}, {w: 2, h: 2}, {w: 4, h: 1}],
    labelKey: 'PROFILE.CANVAS.WIDGET.SPACER',
    icon: 'pi-stop',
    max: MAX_SPACERS,
    fields: [],
    defaultConfig: () => ({}),
},
```

Add `"PROFILE.CANVAS.WIDGET.SPACER": "Space"` to `en.json`.

- [ ] **Step 6: Exempt spacers from the widget cap**

`normalise` currently slices to `MAX_WIDGETS`. Spacers must not count. Split the cap: real widgets are capped at `MAX_WIDGETS`, spacers separately at `MAX_SPACERS`. Add a case asserting 20 real widgets plus 20 spacers all survive, and that the 21st of either is dropped.

- [ ] **Step 7: Drop spacers below four columns**

`normalise(canvas, columns)` removes every spacer when `columns < CANVAS_COLUMNS`. A column of empty rows on a phone is dead scrolling. Add a case.

- [ ] **Step 8: Extend the registry spec**

`widget-registry.spec.ts` asserts every field key appears in `defaultConfig()`. Spacer has no fields so it passes trivially; add a case asserting spacer declares no fields and is not selectable, so a later change cannot quietly give it a properties panel.

- [ ] **Step 9: Run, lint, format, commit**

```bash
bun run ng test --watch=false --include="**/profile-canvas.spec.ts"
bun run ng test --watch=false --include="**/widget-registry.spec.ts"
bun run lint
bun run prettier --write src/app/models/profile-canvas.ts src/app/models/profile-canvas.spec.ts src/app/components/profile-canvas/ src/assets/i18n/locales/en.json
git add src/app/models/profile-canvas.ts src/app/models/profile-canvas.spec.ts src/app/components/profile-canvas/ src/assets/i18n/locales/en.json
git commit -m "feat(profile): add spacers and drop-to-cell to the canvas"
```

---

### Task 2: Route and page shell

**Files:**
- Create: `src/app/features/profile/profile-page/profile-page.component.ts`
- Create: `src/app/features/profile/profile-page/profile-page.component.html`
- Create: `src/app/features/profile/profile-page/profile-page.component.spec.ts`
- Modify: the route table (find it: `grep -rn "path: '" src/app/app.routes.ts` or equivalent)
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.ts`

**Interfaces:**
- Consumes: `ProfileService.ownProfile`.
- Produces: route `/profile`, `ProfilePageComponent`.

- [ ] **Step 1: Find the route table and the menu handler**

```bash
grep -rn "Routes" src/app/*.ts src/app/**/*.routes.ts | head
grep -rn "openProfileSettings" src/app --include=*.ts
```

`self-profile-menu` already renders a row labelled `PROFILE_MENU.EDIT_PROFILE` that emits `editProfile`, and `quick-settings` answers it with `openProfileSettings()`. The label already promises this page. You are repointing one handler, not adding a menu entry.

- [ ] **Step 2: Write the failing spec**

The page renders the own profile's banner, avatar, name and canvas, and shows nothing but a loading state when `ownProfile()` is undefined. Write those two cases first.

- [ ] **Step 3: Build the shell**

`ProfilePageComponent`, OnPush, standalone. It reads `ProfileService.ownProfile` and renders nothing else yet. Keep it deliberately thin: Task 3 fills in the view state.

- [ ] **Step 4: Register the route and repoint the menu**

Add `/profile` to the route table beside the existing feature routes. Change `openProfileSettings()` to navigate there instead of opening the settings modal on the profile page.

- [ ] **Step 5: Run, lint, commit**

```bash
bun run ng test --watch=false --include="**/profile-page.component.spec.ts"
bun run ng build --configuration development
bun run lint
git commit -m "feat(profile): add the profile page route"
```

---

### Task 3: View state

**Files:**
- Modify: `profile-page.component.{ts,html,spec.ts}`

**Interfaces:**
- Consumes: `ProfileCanvasStore`, `ProfileCanvasComponent`, `ProfileService`.
- Produces: the read-only page.

- [ ] **Step 1: Write the failing tests, including the trap**

The important one first, and it must fail against a naive implementation:

```ts
it('keeps an unsaved draft when an unrelated profile write lands', () => {
    // begin a draft, insert a widget so it is dirty
    // ownProfile.set(a NEW object with the SAME id and a different bio)
    // expect the draft still holds the widget and dirty() is still true
});

it('re-begins the draft when the profile id actually changes', () => {
    // ownProfile.set(a profile with a DIFFERENT id)
    // expect the draft to have been reset
});
```

Build `ownProfile` as a writable signal in the spec so the effect can genuinely re-fire. The settings editor's version of this test could not fail because its double was created once.

- [ ] **Step 2: Run and watch the first one fail**

Implement the effect keyed on the whole profile object first, deliberately, watch the test fail, then key it on `profile.id`. Report both runs.

- [ ] **Step 3: Render the view**

Banner, avatar, name, bio, then `<app-profile-canvas [columns]="4">`. Call `ProfileCanvasStore.ensureLoaded(profile.id)` from the effect. The identity strip sits above the canvas and is not part of it.

- [ ] **Step 4: Run, lint, commit**

---

### Task 4: Edit state

**Files:**
- Modify: `profile-page.component.{ts,html,spec.ts}`

**Interfaces:**
- Consumes: `CanvasEditorService`, `ProfileService.updateProfile`, the existing crop dialogs.
- Produces: `editing` signal, per-field draft signals, Save and Cancel.

- [ ] **Step 1: Write the failing tests**

- Edit reveals the fields; Cancel restores what was there; Save calls both `updateProfile` and the canvas store's `save`.
- A dirty text field survives navigating away and back, the same way the canvas draft does. If it does not, the page is inconsistent with itself.
- Cancel with a dirty draft asks first. Leaving the page does not.

- [ ] **Step 2: Implement**

`editing = signal(false)`. In edit mode the banner and avatar gain a change affordance opening the existing crop dialogs unchanged, and bio becomes an inline field.

Save writes the profile fields through `ProfileService.updateProfile` and the canvas through `ProfileCanvasStore.save`, then calls `CanvasEditorService.begin(saved)` so the draft goes clean. Note this is exactly the write that triggers the trap: `updateProfile` replaces `ownProfile`, so the id-keyed effect must not re-begin.

Accent and font are edit-mode controls in the page header. `p-colorpicker` earns its place for accent; the font is a plain select.

- [ ] **Step 3: Run, lint, commit**

---

### Task 5: The anchored widget editor

**Files:**
- Create: `src/app/features/profile/profile-page/widget-editor-popover.component.{ts,html,spec.ts}`
- Move: `widget-properties.component.*` from `.../profile-settings/canvas-editor/` to `src/app/features/profile/profile-page/`
- Modify: `profile-page.component.{ts,html}`

**Interfaces:**
- Consumes: `placePopout` from `components/profile-popout/place-popout.ts`, `WidgetPropertiesComponent`, `CanvasEditorService`.
- Produces: the selection editor.

- [ ] **Step 1: Move the properties panel, unchanged**

`git mv` it. Its imports change, nothing else does. It already renders any widget from its registry `fields`, so it does not know or care that it is now in a popover. Run its spec and confirm it still passes before touching anything else.

- [ ] **Step 2: Write the failing tests**

- Clicking a tile selects it and shows the editor anchored to that tile.
- Clicking the tile again, or elsewhere, deselects and hides it.
- A tile in the rightmost column flips the editor to the left instead of overflowing.
- Escape closes the editor and keeps the selection.
- The editor is reachable and dismissible by keyboard alone.

- [ ] **Step 3: Implement**

Reuse `placePopout(anchor, card, viewport)`. Do not write a second placement helper; that function already handles flipping and clamping and is load bearing in the popout.

Reposition on scroll (capture phase, ignoring scroll originating inside the editor) and on resize, exactly as `profile-popout.component.ts` does. Read that file and follow it.

- [ ] **Step 4: Run, lint, commit**

---

### Task 6: Visitor preview

**Files:**
- Modify: `profile-page.component.{ts,html,spec.ts}`

**Interfaces:**
- Consumes: `CanvasVisibility`, the draft.
- Produces: `previewAs` signal, a filtered canvas computed.

- [ ] **Step 1: Write the failing tests**

- As Stranger, a widget set to Friends dims rather than disappears.
- The count line reports how many are hidden for that viewer.
- As Me, nothing dims and the count line is absent.
- Switching viewer does not mutate the draft. This is the one that matters: a preview that edits what it previews is a data-loss bug.

- [ ] **Step 2: Implement**

A segmented control offering Me, Friend, Mutual, Stranger. A computed derives, per widget, whether that viewer could see it. Dim with opacity and mark `aria-hidden` false but announce the state, so a screen reader user gets the same information as a sighted one.

Pure client-side over data already loaded. No request, because the owner may see all of their own widgets by definition.

- [ ] **Step 3: Run, lint, commit**

---

### Task 7: Cell drag with automatic spacers

**Files:**
- Modify: `profile-page.component.{ts,html,spec.ts}`
- Modify: `src/app/services/canvas-editor.service.ts` (add one method)
- Modify: `src/app/services/canvas-editor.service.spec.ts`

**Interfaces:**
- Consumes: `dropAt` from Task 1.
- Produces: `CanvasEditorService.dropAt(id, target)` and grid drag.

- [ ] **Step 1: Add the service method**

`dropAt(id: string, target: {x: number; y: number})` routes through the same private write funnel every other mutation uses, so the draft can never hold an arrangement the grid could not draw. Add its spec cases beside the existing ones.

- [ ] **Step 2: Write the failing tests for the grid drag**

- Dropping a tile on an occupied cell reorders.
- Dropping past the end inserts spacers and lands the tile where it was dropped.
- Dropping a tile on itself is a no-op.
- Arrow keys move the selection between tiles in reading order; arrow with a modifier moves the tile.
- `dragover` prevents default, or the drop never fires.

- [ ] **Step 3: Implement**

The drop target is a CELL, computed from the pointer position over the grid, not a list index. There is no list. Compute the cell from the grid's bounding rect and the column count.

Show a drop indicator on the target cell during a drag. A drag with no indicator is a guess.

- [ ] **Step 4: Run, lint, commit**

---

### Task 8: Migrate and delete

Atomic. Nothing is removed from settings until the page does all of it.

**Files:**
- Modify: `.../profile-settings/profile-settings.component.{ts,html}`
- Delete: `.../profile-settings/canvas-editor/canvas-editor.component.*`
- Create: `.../profile-settings/profile-settings.component.spec.ts`

- [ ] **Step 1: Write the settings page's first spec**

It has none, which is why its mount went untested last time. Cover: the five remaining sections render, and the four removed ones do not.

- [ ] **Step 2: Delete the four presentational sections**

Profile Overview, Avatar, Banner, Display. The crop dialogs move to the page in Task 4; confirm they are gone from here and present there, and that no dead handler is left behind in the component.

- [ ] **Step 3: Delete the settings canvas editor shell**

`canvas-editor.component.*` and its spec. Superseded by the page. Confirm nothing imports it: `grep -rn "canvas-editor.component" src/`.

- [ ] **Step 4: Prove nothing was lost**

Every field that existed before must be editable on the page. Walk the list from spec section 4 and check each one by hand. Report the walk.

- [ ] **Step 5: Full suite, then commit**

```bash
bun run test
bun run ng build --configuration development
bun run lint
```

The suite must be green and no lower than before this plan started.

---

## Backend

None. The canvas endpoints from the companion spec are unchanged, and nothing here adds a request. Spacers are ordinary widgets on the wire.
