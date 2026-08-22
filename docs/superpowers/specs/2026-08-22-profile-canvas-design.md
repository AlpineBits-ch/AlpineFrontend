# Profile canvas

A profile is six fields: two images, a bio, an accent colour, a font and a list of connections. Every
account comes out looking the same because the shape of the form is the shape of the person. This
replaces the fixed layout with a grid the owner arranges out of typed widgets.

## The shape today

`ProfileDto` carries everything a person can say about themselves. `profile-header` draws the banner,
avatar, name and bio; `profile-modal` adds member-since, connections and three tabs. Nothing else on
a profile is authored.

| Field         | Rendered by                              | Authored in                  |
| ------------- | ---------------------------------------- | ---------------------------- |
| `avatarUrl`   | `profile-header`, `app-avatar`           | profile settings, multipart  |
| `bannerUrl`   | `profile-header`                         | profile settings, multipart  |
| `bio`         | `profile-header`, `profile-popout`       | profile settings, PATCH      |
| `accentColor` | `profile-font.model.ts` `userNameStyle`  | profile settings, PATCH      |
| `font`        | `profile-font.model.ts` `userNameStyle`  | profile settings, PATCH      |
| `connections` | `profile-modal` left column              | nothing, no producer wired   |

The pattern this feature needs already exists in the repo. `features/guild/personas/persona-infobox.ts`
keeps a template, a set of values and a renderer separate, and treats the stored JSON as opaque
outside that one module. That is a widget system holding a single widget type. The canvas generalises
it and points it at the account.

## Decisions

| Question                        | Answer                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- |
| Scope                           | One global canvas per account. Personas keep their own character pages     |
| Layout freedom                  | Snap grid. No free placement, no overlap, no rotation                      |
| Widget cap                      | 20 per canvas, enforced client and server                                  |
| Identity strip                  | Fixed above the grid, never a widget, never restylable                     |
| User CSS                        | None. Backdrop, accent and the existing `ProfileFont` are the whole surface |
| Where the canvas lives          | Its own endpoint, never embedded in `ProfileDto`                           |
| Where canvas state lives        | `ProfileCanvasStore`. The unsaved editor arrangement is device state       |
| `config` shape                  | Opaque JSON outside the widget's own component, like the infobox           |
| Hidden widgets                  | Absent from the payload, and the server re-packs before it serialises      |
| Image upload                    | New endpoint under social, not `FileService`                               |
| Backend work                    | Yes. Four endpoints in a separate repo, see section 8                      |

## Scope

Phase 1, specified here in full:

- The document model, the layout engine and the reflow rule
- The renderer, the widget registry, and the editor in profile settings
- Nine widgets that need no new server capability beyond storing the canvas: Quote, Currently,
  Marquee, Photo, Gallery, Infobox, Local Time, Open To, Mutuals

The canvas Infobox holds its own label and value rows. It does not call `renderInfobox`: that takes a
category template and a values blob as two JSON strings, which is the right shape for a character
sheet driven by a guild's template and the wrong one for a widget somebody fills in by hand. The
pattern carries over, not the function.
- The canvas endpoints and the image endpoint

Out of phase 1, but the extension points are specified so they do not force a rewrite:

- Guestbook, Ask Me, Knock, Pinned Message. All four need a moderation and reporting path first
- Now Playing, On Repeat, Game Shelf, Voice Note, Isle Spot, Around. All need a producer that does
  not exist yet, and `connections` still has no writer

Out entirely: per-guild canvases, canvas templates, sharing a canvas, and any widget that runs code
the owner supplied.

## 1. The document

`src/app/dtos/response/profile-canvas.dto.ts`.

```ts
export interface ProfileCanvasDto {
    profileId: string;
    updatedAt: Date;
    /** Bumped when the reflow rules change, so an old arrangement is re-packed on read. */
    version: number;
    theme: CanvasTheme;
    widgets: CanvasWidgetDto[];
}

export interface CanvasTheme {
    /** Widget accent. Falls back to the profile's `accentColor`, then the brand. */
    accent: string | null;
    backdrop: CanvasBackdrop | null;
}

export interface CanvasWidgetDto {
    id: string;
    type: string;
    /** Grid cells, never pixels. */
    x: number;
    y: number;
    w: number;
    h: number;
    visibility: CanvasVisibility;
    /** Shown in the popout's one column preview. At most two per canvas. */
    card: boolean;
    /** Opaque outside the widget component that owns this type. */
    config: unknown;
}

export type CanvasVisibility = 'everyone' | 'friends' | 'mutuals';
```

`type` is a plain string rather than a union. A client that meets a type it does not know draws
nothing and leaves the cell empty, which is what makes shipping a widget to one platform ahead of
another survivable. Mobile and web will lag, the same way they lag on inline attachments.

## 2. Layout

Four columns at full width. Five footprints, and nothing else validates:

| `w` x `h` | Used by                                        |
| --------- | ---------------------------------------------- |
| 1 x 1     | Local Time, small Photo                        |
| 2 x 1     | Quote, Mutuals, Open To                        |
| 2 x 2     | Currently, Infobox, Gallery at narrow          |
| 4 x 1     | Marquee, Gallery strip                         |
| 4 x 2     | large Photo                                    |

Cells are square. Every footprint is a multiple of one cell, so a skeleton is exactly the size of the
thing it stands in for and nothing has to be measured before it can be drawn.

### Reflow is a pure function

`src/app/models/profile-canvas.ts`, tested without a DOM the way `place-popout.ts` is.

```ts
export const CANVAS_COLUMNS = 4;
export const MAX_WIDGETS = 20;

export function reflow(widgets: CanvasWidgetDto[], columns: number): CanvasWidgetDto[];
export function normalise(canvas: ProfileCanvasDto): ProfileCanvasDto;
export function parseConfig<T>(config: unknown, guard: (v: unknown) => v is T): T | null;
```

`reflow` sorts row-major by `(y, x)`, clamps each `w` to `columns`, then greedily packs into the
first cell with room. Array order after `reflow` is therefore reading order, which is what lets the
editor treat a reorder as an array move and leave `x` and `y` to be derived. Reading order is preserved, so a narrower window never scrambles the
arrangement: the owner arranges once, at four columns, and every other width is derived.

| Surface                  | Columns |
| ------------------------ | ------- |
| Profile modal, full page | 4       |
| Modal at narrow width    | 2       |
| Popout, phone            | 1       |

`normalise` is the single gate everything passes through on read and on write. It drops widgets past
`MAX_WIDGETS`, snaps an unknown footprint to the nearest legal one rather than dropping the widget,
coerces a non-object `config` to `{}`, and runs `reflow`.
Both the renderer and the editor call it, so a canvas that arrived from a newer client, a stripped
canvas, and a canvas mid-drag are all the same kind of object.

## 2b. Spacers, and dropping a widget where you want it

The packer above has one expressive cost: it fills every gap, so you cannot place deliberate
whitespace. Drop a 1x1 below a 2x2 and it is pulled up beside it instead. For a feature about
self-expression, "I want breathing room here" is a reasonable thing to want to say.

A `spacer` widget closes that. It renders nothing and occupies cells, so the packer flows around it.
The grid stays packed and gapless by construction, which is what keeps narrow reflow trivially
correct, and the person still gets to choose where the air is.

Spacers are inserted automatically, not by hand. The editor's drag targets a CELL, not a list
position, and dropping a widget past the end of the current content inserts exactly enough spacers to
put it where it was dropped.

```
drop a 2x1 at cell (2, 2) on a canvas holding one 4x1:

  before            after
  [ AAAA ]          [ AAAA ]
                    [ .. .. ]     <- two 1x1 spacers, then
                    [ .. BB ]     <- one more, then the dropped widget
```

The algorithm, in `profile-canvas.ts` beside `reflow`:

```ts
export function dropAt(
    widgets: CanvasWidgetDto[],
    id: string,
    target: {x: number; y: number},
    columns: number,
): CanvasWidgetDto[];
```

1. Lift the dragged widget out of the array.
2. Reflow the rest, which gives every remaining widget a real position.
3. Walk reading order to `target`, counting unoccupied cells.
4. Emit spacers covering exactly those cells, merging runs within a row into the largest legal
   footprint so three empty cells become a 2x1 and a 1x1 rather than three separate widgets.
5. Splice the spacers, then the dragged widget, into the array at that point.
6. Reflow, which is now a no-op because the arrangement is already gapless.

Four rules that fall out of it:

| Rule | Why |
| --- | --- |
| Spacers do not count toward `MAX_WIDGETS` | A person who wants air should not spend their widget budget on it. They get their own cap of 20 so the payload stays bounded. |
| Spacers render only at 4 columns | They are a four-column layout device. At 2 columns and at 1 they are dropped, because a column of empty rows is dead scroll, not composition. |
| Trailing spacers are trimmed on save | Whitespace after the last real widget is invisible. Interior spacers are kept, because those were the point. |
| A spacer has no visibility and no config | It is layout, not content. It is not selectable in the properties panel, and it carries no `card` flag. |

One good side effect. Section 7 requires the server to re-pack after stripping a widget the viewer
may not see, because a hole in the grid would otherwise leak that something was removed. Once gaps
are a thing people create on purpose, a hole no longer implies a hidden widget. The re-pack rule
stays, because it is still the cheaper guarantee, but it is no longer the only thing standing between
a hidden widget and an observer.

Spacers also appear in the insert menu as a normal widget type, for someone who would rather place
air explicitly than drag for it.

## 3. The widget registry

`src/app/components/profile-canvas/widget-registry.ts` maps a type to what the renderer needs and
nothing more.

```ts
export interface WidgetDefinition {
    type: string;
    component: Type<unknown>;
    /** Footprints the editor offers. First is the default on insert. */
    footprints: readonly Footprint[];
    /** Label and icon keys for the editor's insert menu. */
    labelKey: string;
    icon: string;
    /** What the properties panel draws for this type. One panel serves every widget. */
    fields: readonly WidgetField[];
    /** Answers whether the owner may add another of these. Photo and Quote allow many. */
    max: number;
}

export const WIDGET_REGISTRY: readonly WidgetDefinition[] = [...];
```

`WidgetField` is a small tagged union (`text`, `textarea`, `rows`, `image`, `images`, `timezone`).
Declaring the fields rather than writing a form per type is what keeps the editor to one properties
panel instead of nine.

Adding a widget type is one entry here, one component, and three locale keys. No change to the
renderer, the editor, the store or the DTO. That is the property worth protecting: phases 2 and 3 add
ten widgets, and each one has to be a leaf.

Every widget component takes the same two inputs and owns its own config parsing:

```ts
readonly widget = input.required<CanvasWidgetDto>();
readonly owner = input.required<ProfileDto>();
```

The component parses `config` through `parseConfig` with its own type guard, and renders nothing when
the guard fails. A malformed config is a blank cell, never a thrown error: a wrong shape read inside
a computed aborts change detection app-wide and presents as an unrelated styling bug.

## 4. Rendering

`src/app/components/profile-canvas/profile-canvas.component.ts`. Takes a canvas, a column count and
the owner's profile; draws a CSS grid and one `@switch` over the registry. OnPush, signals, no
lifecycle hooks.

```
components/profile-canvas/
    profile-canvas.component.ts        the grid
    widget-registry.ts
    widgets/quote-widget.component.ts
    widgets/currently-widget.component.ts
    widgets/marquee-widget.component.ts
    widgets/photo-widget.component.ts
    widgets/gallery-widget.component.ts
    widgets/infobox-widget.component.ts
    widgets/local-time-widget.component.ts
    widgets/open-to-widget.component.ts
    widgets/mutuals-widget.component.ts
```

Three surfaces mount it:

| Surface          | Columns | Widgets drawn                                       |
| ---------------- | ------- | --------------------------------------------------- |
| `profile-modal`  | 4 or 2  | All of them, in a new Canvas tab, first and default  |
| `profile-popout` | 1       | Only widgets with `card: true`, at most two          |
| Editor preview   | 4       | All of them, from the draft rather than the store    |

The modal's existing Activity, Mutual Friends and Mutual Servers tabs are untouched. Canvas becomes
the first tab and the default when the canvas has any widgets; an empty canvas falls back to Activity
so a profile that has never been arranged does not open on a blank panel.

### The popout budget

A popout opens on hover in a member list, so it must not become a fan-out. It does not fetch the
canvas: it reads whatever `ProfileCanvasStore` already holds for that profile and draws at most two
card widgets, and draws none when the store is cold. The modal is what triggers the fetch. A person
who has never opened someone's full profile sees the popout exactly as it is today, which is the
correct trade: the popout is a hover preview, not a destination.

Live widgets fetch their own data on mount, so mounting two in a popout costs two widgets of work and
not twenty.

## 5. Where the state goes

Applying the three tests in `CLAUDE.md` per field, because they do not all land in the same place.

| State                          | Test                                                        | Home                         |
| ------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| The saved canvas               | A row with an id, read by popout, modal and settings         | `ProfileCanvasStore`         |
| The draft being arranged       | A second window would legitimately show something different  | `CanvasEditorService`        |
| Which widget is selected       | Dies with the editor view                                    | The editor component         |
| Now Playing track (phase 3)    | Arrives faster than 1/s, stops mattering a second later      | A plain signal on a service  |

`src/app/stores/profile-canvas.store.ts`, an NgRx `signalStore` with `withEntities<ProfileCanvasDto>`
keyed on `profileId` and `withOptimisticEntities` for the save. The store never holds the draft: the
editor writes to `CanvasEditorService`, and only a successful save patches the store.

`ProfileService` keeps identity. It is on the boot path of nearly every component spec in the tree and
already carries a circuit breaker, a coalescing window and a negative cache to survive first paint;
hanging a canvas off every profile read would put that whole payload behind machinery built for
avatars. The two are fetched separately and joined at the component.

## 6. The editor

`src/app/features/settings/settings-modal/pages/profile-settings/canvas-editor/`.

Profile settings already owns bio, accent, font, avatar and banner. The canvas editor is a new section
below them, not a separate page: everything about how you look stays in one place.

- A 4 column preview of the draft, rendered by the same `profile-canvas` component the modal uses.
- Click a widget to select it. The properties panel beside it holds that widget's own fields plus
  footprint and visibility.
- Drag to reorder. Drop targets are cell boundaries, and the draft is re-packed through `reflow` on
  every drop, so an illegal arrangement is not representable.
- An insert menu built from the registry, disabled per type at `max` and entirely at `MAX_WIDGETS`.
- Save is explicit. Closing settings with a dirty draft does not prompt and does not discard: the
  draft lives in a root-provided service, so reopening settings returns to it exactly as it was. The
  only thing that asks first is Discard, which is the one action that loses work.

Keyboard reorder is required, not optional: move selection with the arrow keys, move the selected
widget with the arrow keys held with a modifier. A drag-only editor is unusable without a mouse and
this is the only way to author a profile.

## 7. Visibility

Each widget carries `visibility`. The rule is the one `ProfileDto` already documents for
`mutualFriends`: a widget the viewer may not see is **absent from the payload entirely**, not null
and not an empty config.

The consequence the server has to honour: after stripping, it re-packs with the same row-major rule
before it serialises. Without that a hidden widget leaks its own existence as a hole in the grid, and
a 2 x 2 gap in the middle of a canvas is a strictly worse leak than the widget would have been. The
client runs `normalise` on read anyway, so the two agree.

Visibility is per widget and has no bearing on the canvas as a whole. There is no "hide my canvas"
switch: a canvas with no visible widgets renders as no canvas, which is the same thing.

## 8. Backend

Separate repo, `RiderProjects\Echo`. Four endpoints, all under Social, following `MutualsEndpoint`.

```
GET    /api/v1/social/profiles/{profileId}/canvas
PUT    /api/v1/social/profiles/me/canvas
POST   /api/v1/social/profiles/me/canvas/images
DELETE /api/v1/social/profiles/me/canvas/images/{imageId}
```

`GET` applies the visibility gate per widget using the same `CanView(setting, relation)` the profile
projection uses, re-packs, and answers the whole document. A profile with no canvas answers `200` with
an empty `widgets` array rather than `404`, so the client has one shape to handle.

`PUT` replaces the document. The server validates the cap, the footprint whitelist and the type
against its own registry, and rejects the whole document rather than silently dropping a widget: a
partial save that looks successful is worse than a failure the editor can show.

Images do not go through `FileService`. `POST /api/v1/messaging/attachments` is scoped to messaging
and access-controlled per conversation, and a profile image is world-readable by construction. The
canvas image endpoint answers `{imageId, url}`, caps total images per canvas rather than per widget,
and the `DELETE` is what the editor calls when a Photo or Gallery widget is removed.

`ProfileCanvasDto.version` starts at 1. The server writes the current version on save and the client
re-packs anything lower on read.

## 9. i18n

Flat dot-separated keys in `src/assets/i18n/locales/en.json`, English only. `de.json` and `fr.json`
lag on purpose.

`PROFILE.CANVAS.*` for the surfaces, `PROFILE.CANVAS.WIDGET.*` for the registry labels, and
`PROFILE.CANVAS.EDITOR.*` for the editor. Existing `PROFILE.*` keys are reused where they already say
the right thing.

## 10. Testing

| Unit                                    | Covered by                                                      |
| --------------------------------------- | --------------------------------------------------------------- |
| `reflow`, `normalise`, `parseConfig`     | `profile-canvas.spec.ts`, pure, no TestBed                       |
| Registry completeness                    | Every entry resolves a component and three locale keys           |
| Each widget's config guard               | A malformed config renders empty and throws nothing              |
| `ProfileCanvasStore`                     | Load, optimistic save, rollback on failure                       |
| Modal tab selection                      | Canvas tab is default with widgets, Activity without             |
| Popout                                   | Draws nothing when the store is cold, never issues a fetch       |

`profile-modal.component.spec.ts` and `profile-popout.component.spec.ts` exist and must stay green;
both gain cases rather than being rewritten.

## 11. Risks

**The editor is the feature.** The renderer is a grid and nine small components, and it is the part
that will look finished first. If drag, keyboard reorder and the properties panel are not good,
nobody arranges anything and the widgets do not matter. Budget accordingly.

**Sparse must not read as unfinished.** A canvas of five widgets and a lot of space has to look as
deliberate as one that fills the grid. If it reads as a half-done chore, the feature becomes homework
and the people it was built for quietly stop opening it. This is a visual design constraint on the
grid, not a feature: no dashed placeholder cells, no "add a widget here" ghosts on someone else's
profile, and the grid height follows the content rather than reserving four rows.

**Phase 2 is a moderation product before it is a feature.** Guestbook and Ask Me put text other people
wrote on your profile, reachable from every member list in the app. Delete, block, disable, rate limit
and per-entry reporting all have to exist before the first entry is written. Phase 1 needs none of
that: everything on a phase 1 canvas was uploaded or typed by the owner, so it is already covered by
the existing `ReportDialogService` with `kind: 'User'` from `profile-actions`. Phase 2 is what needs a
new subject kind, and that is the work item, not the widgets.
