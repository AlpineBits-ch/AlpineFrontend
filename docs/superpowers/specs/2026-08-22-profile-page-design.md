# Profile page

Your profile becomes a page you visit and edit on the thing itself. Everything about how you look
moves off the settings form: banner, avatar, bio, accent, font and the canvas.
Settings keeps account and security.

Companion to `2026-08-22-profile-canvas-design.md`, which owns the canvas model, the layout engine,
the widget registry and the visibility rules. This one owns the page, its editing model and the
migration.

## Why

`profile-settings.component.html` is 720 lines and ten sections. Five of them describe how you look
and five describe your account. The canvas editor landed as an eleventh and read as bolted on,
because a drag-and-drop arranging surface is not a settings field. Neither, really, is cropping a
banner.

Editing your profile through a form also fights the premise. A profile is meant to be a room you
arrange; arranging it through a scrolling list of labelled inputs is the business card model wearing
a different hat.

## Decisions

| Question | Answer |
| --- | --- |
| What moves | Banner, avatar, bio, accent, font, canvas |
| What stays in settings | Account, Connections, Sessions, Change Password, Danger Zone |
| Edit model | Always editable. Autosave, undo with Ctrl+Z, no Edit or Save button |
| Widget editing | Anchored to the selected tile, not a side panel |
| Second representation | None. The grid is the only list of widgets |
| Visitor preview | Me / Friend / Mutual / Stranger, always available |
| Route | `/profile`, reachable from the self-profile menu |
| Backend | None beyond what the canvas spec already needs |

## 1. The page

`src/app/features/profile/profile-page/`.

There is one state. The page is your workshop, always. Banner and avatar carry their change
affordance, the bio is a field where it already sits, the grid is draggable, and nothing reflows into
a form because there is no other layout to reflow into.

An earlier draft of this spec had an explicit mode: view, then Edit, then Save or Cancel. The reason
for it was that you need some way to see your own profile as a visitor sees it. The viewer preview
answers that better, so the mode was buying nothing except a click and a boundary to explain.
"View as Stranger" shows you something an edit mode never could: what a stranger is actually allowed
to see.

**Nothing is ever explicitly saved.** Changes autosave, and Ctrl+Z undoes them. See section 3b.

The identity strip stays fixed relative to the canvas. It is the anti-impersonation guarantee from
the canvas spec and it is not arrangeable.

## 1b. The composition

The first build stacked a 240px banner, an overlapping avatar, the name, the bio, an appearance bar,
and then the canvas last and unframed. That is the Discord shape this feature exists to leave. The
pitch was that a profile is a room rather than a business card, and what got built was a business
card with a grid stapled underneath.

Nothing here changes the app's visual language. The palette is the existing `@theme` tokens, the
chrome is Inter, PrimeNG stays themed by its preset. What changes is what the page gives its space to.

**The canvas is the page.** Everything above it is a masthead, not a hero.

- The banner compresses. It is a backdrop, not the subject, and 240px of it before you reach anything
  is a decorative wall between a person and their room.
- The avatar and name sit on one line with the bio under them, so identity reads as a caption to the
  room rather than a title card above it.
- A hairline under that block separates the person from the things they arranged. One rule, no
  heading, no label. The change of content is the section break.
- The canvas gets a max width and stays centred. At four columns on a wide monitor an unconstrained
  grid stretches each cell into a letterbox, and every widget was designed against a square cell.

**The name renders in the profile's own font.** There is a directive for it,
`[appUserNameStyle]`, and six surfaces already apply it: the guild member list, message authors,
system messages, the profile header, the composer's mention suggestions, and guild member settings.
Every place in this app that draws a username honours the font and accent that person chose.

Except the profile page, which uses it zero times and draws the name in the app's own face. The one
page that exists to be about how someone looks is the one surface ignoring the lever they already
had. Bind the directive; do not call `userNameStyle()` directly.

### The signature: the grid appears while you move something

At rest the canvas is widgets on the app ground, and there is nothing to see but what the person put
there. While a tile is being dragged, the cell lattice shows through beneath it: faint brand-tinted
guides on the four column grid and its rows.

It is the snap target made visible. A person moving a tile can see the slots it will land in, which
is the moment that information is worth anything.

Removing the edit mode moved this. An earlier draft tied the lattice to entering edit mode, which no
longer exists, and leaving it on permanently would be the failure the always-editable model has to
avoid: a page wearing its machinery at all times, so it reads as a grid editor rather than as
somebody's room. Tying it to the drag keeps the page quiet at rest and honest while arranging.

This is the one bold thing on the page. Everything around it stays quiet: no gradients, no glow, no
animation elsewhere. It fades in as a drag begins and out as it ends, and under
`prefers-reduced-motion` it is simply present or absent with no transition.

## 2. Editing a widget

Click a tile. It gains a selected border and a compact editor anchors beside it, carrying that
widget's declared fields plus footprint, visibility, the hover-card toggle and delete.

Anchored rather than a side panel, deliberately: a panel on the far right makes the eye travel away
from the thing being changed, and it steals width from the canvas, so the grid you are arranging is
not the width it will actually be. Anchoring keeps the canvas at true proportions while you work.

The panel body is `WidgetPropertiesComponent`, unchanged. It already renders any widget from the
declared `fields` on its registry entry, so nothing about it is coupled to where it is drawn.

Placement follows `place-popout.ts`, the existing helper for anchoring a card to an element with
viewport flipping. Do not write a second one.

One case the helper does not cover: a widget in the rightmost column has no room on its right. The
editor flips to the left of the tile, and when the tile is too tall for the viewport the editor
scrolls internally rather than pushing the page.

## 3. Preview as someone else

A segmented control offers Me, Friend, Mutual and Stranger. Selecting one redraws the
canvas as that viewer would see it, applying each widget's own `visibility`.

Widgets that viewer cannot see **dim rather than disappear**, so the distinction between "hidden from
them" and "not there" stays visible. A line under the grid states how many are hidden.

This is a pure client computed over data already loaded. It asks nothing of the server, because the
owner is allowed to see all of their own widgets by definition.

Per-widget visibility is otherwise a control nobody can verify. This is the thing that makes it
checkable, and it is the reason to build it rather than a flourish.

## 3b. Autosave and undo

With no Save button, two things have to be true: a change must reliably reach the server, and a
mistake must be cheap to reverse. Neither is optional, and the second is what makes the first safe.

### Autosave

`src/app/features/discovery/listing-editor/listing-editor.component.ts` already does this in this
codebase and was hardened this week. Match it rather than inventing a second approach.

What to take from it:

- A `saveStatus` of `saved` / `unsaved` / `saving` / `error`, shown to the person. Silence is not a
  status: somebody who cannot tell whether their work is safe will not trust the page.
- A `Subject` with `debounceTime`, so a burst of edits is one write.
- **A flush on destroy.** The debounce never fires for the last edit before navigating away, and Back
  is this page's primary exit. Without the flush, the most common way to leave is also the way to
  lose your most recent change. That file carries a comment saying exactly this, which is what a
  comment about a silently-violated invariant is for.

Text fields coalesce: typing a bio is one save, not one per keystroke. A structural change to the
canvas, a drop or a delete or a resize, writes on its own.

`ProfileCanvasStore.save` already writes optimistically and guards per profile with an owning
`requestId`, so a slow save cannot clobber a newer one and the realtime listener cannot clobber a
save in flight. Autosave inherits all of that. Do not add a second guard.

### Undo

Ctrl+Z, and Ctrl+Shift+Z to redo. Both also reachable as buttons, because a keyboard-only affordance
for the only way to reverse a mistake is not an affordance for most people.

- One history of the whole editable state: canvas arrangement, widget config, bio, accent, font.
- Text edits coalesce into one entry per field per pause, matching how they autosave. Undoing a bio
  should restore the bio you had, not the bio minus one character.
- Undo writes. An undone change autosaves like any other, or undo is a lie that survives until reload.
- Avatar and banner uploads are NOT undoable. They are file uploads with their own delete path, and a
  history entry that silently re-uploads a replaced image would be worse than no entry. Removal is
  already confirmed separately.
- The UI states what it will reverse. "Undo" alone is a guess; naming the action is the difference
  between confidence and a second mistake.

There is no undo anywhere else in this app, so there is no pattern to match and this is new ground.
Keep it to one history owned in one place.

## 4. What moves, field by field

| Field | Today | On the page |
| --- | --- | --- |
| Banner | Settings section, file input, crop dialog | Click the banner itself, same crop dialog |
| Avatar | Settings section, file input, crop dialog | Click the avatar itself, same crop dialog |
| Display name | Settings input, DISABLED, "coming soon" | Plain text. Not editable, see below |
| Bio | Settings textarea | Inline field where the bio is drawn |
| Accent | Settings swatch, picker and reset | Same controls, in an edit-mode bar |
| Font | Settings `p-select` with per-option preview | Same control, in an edit-mode bar |
| Canvas | Settings section, added then removed | The page |

### Move the controls, do not reinvent them

Every control here moves as it is. The crop dialogs are self-contained and there is no reason to
touch them, and the same goes for the rest:

- Font is a `p-select` whose `#item` template renders each option in that option's own font stack,
  with a live preview line under it reading a pangram in the selected face. Somebody built that and
  it is good. A bare `<select>` is a native control in a themed dark app and looks like a bug.
- Accent is a styled swatch with the colour picker and a reset, under a visible label.

The first build of this page ignored that and produced a cramped chip overlaid on the banner holding
a raw `<select>`, which was a visible regression against the settings page it replaces. The spec's
own risk section calls that out and the spec caused it anyway, by describing these two as "an
edit-mode control in the page header" instead of saying to move what exists.

The rule, for these and anything else that migrates: **open the settings markup, and match it.** If
the page needs a different arrangement, change the arrangement, not the control.

### Where they go

Not on the banner. Edit mode gets a bar directly under the identity strip holding the appearance
controls with their real labels, at the width they need. The banner carries only the change
affordance for the banner itself.

Controls that pin to a corner and do not wrap are how a control ends up off-screen and unreachable at
a narrow window, which is a defect rather than a cosmetic issue.

`profile-settings.component.html` loses its first four sections and keeps the last five. It should
end up under 400 lines.

## 5. Where the state goes

Unchanged from the canvas spec, and worth restating because the page changes what sits next to what.

| State | Home |
| --- | --- |
| The saved canvas | `ProfileCanvasStore` |
| The unsaved canvas draft | `CanvasEditorService` |
| The profile row | `ProfileService.ownProfile` |
| Unsaved bio, accent, font | Must survive navigation, like the canvas draft |
| Which widget is selected, which viewer is previewed | The page component |

### The trap this page makes worse

`ProfileService.ownProfile` is `.set()` with a fresh object on every own-profile write:
`updateProfile`, `uploadAvatar`, `uploadBanner`, `setSelfStatus`. An effect keyed on that object
re-runs on every one of them.

An effect that calls `CanvasEditorService.begin()` on each re-run silently discards an unsaved canvas
draft. That defect shipped once already in the settings editor and was caught in review. On this page
it is strictly more dangerous, because avatar, banner and bio now live on the same screen as the
canvas, so every write that triggers it happens beside the draft rather than in a different modal.

Key every effect on `profile.id`, never on the profile object. The plan must carry a test that fails
first: begin a draft, dirty it, then set a new profile object with the same id, and assert the draft
survives.

## 6. Getting there

The entry point already exists and already has the right name. `self-profile-menu` renders a row
labelled `PROFILE_MENU.EDIT_PROFILE` which emits `editProfile`, and `quick-settings` currently
answers it with `openProfileSettings()`. It points at the wrong place, not at nothing.

So the whole navigation change is repointing that handler at `/profile`. No new menu entry, no new
string, and the label was already promising a thing the app did not have.

### And getting back out

`/profile` is a sibling of `overview` in the route table, and `overview` is the entire app shell. So
the page replaces the sidebar, the guild list and the channel list. The custom titlebar survives,
because it sits outside the router outlet, but that is a window control and not navigation.

The page therefore carries its own header with a back affordance to `/overview`. An earlier draft of
this spec described how to reach the page and never described leaving it,
and the first build was a dead end you could only escape by closing the window.

Back never prompts. Nothing is unsaved by the time you press it: autosave has already written, and
the flush on destroy catches the last edit the debounce did not. See section 3b.

Nesting the page inside the shell instead would keep the sidebar and give the exit for free, but
`MainPageComponent` has no router outlet of its own, so that is a larger change. Worth revisiting if
the takeover keeps feeling disorienting.

Opening someone else's profile is unchanged: the popout and the full modal, both untouched by this
spec.

A person viewing their own profile through the existing modal sees what everyone else sees. That
modal does not gain an edit affordance; the page is the one place editing happens, which is the
entire point.

## 7. Migration

Two things must not happen: a period where a field is editable in neither place, and a period where
it is editable in both and they disagree.

So the page lands complete, then the settings sections are deleted in the same commit that mounts it.
No feature flag, no transition window. The fields are small, the crop dialogs move wholesale, and
the canvas editor already exists.

`bun run test` must stay green across the move. `profile-settings.component.ts` has no spec today,
which is what made the mount untested last time. The page gets one.

## 8. Out of scope

Two fields this spec originally claimed were moving turn out not to be editable at all. Both were
written from reading the settings page's section headings rather than checking what each control
actually does. The page renders both as plain text.

- **Pronouns.** Earlier drafts listed them and the mockups showed them. They do not exist.
  `ProfileDto` has no `pronouns` field; the only `pronouns` in the codebase belongs to personas, the
  roleplay characters, which is where the idea was pattern-matched from.
- **Display name.** The settings control for it is `disabled` and captioned "coming soon", and
  `ProfileService.updateProfile` accepts only `{bio, accentColor, font}`. There is no write path.
  Moving a disabled input to a new page would just relocate a promise nobody can keep.

Both need a column, a DTO field and PATCH support, which is backend work this spec explicitly does
not take on. Each is worth doing as its own small piece. Rendering a field with no data source is
worse than not having it: it invites either silent data loss on save, or invented UI that blocks
save for a reason the user cannot act on.

What IS editable on this page, and all of it verified against a real write path: bio, accent colour
and font through `updateProfile`, plus avatar and banner through `uploadAvatar` and `uploadBanner`.
- Editing anyone else's profile, obviously.
- A public web view of a profile.
- Themes and backdrops. That is the canvas spec's phase for it, and it lands as an edit-mode control
  on this page once the page exists.
- Reordering the identity strip, ever.

## 9. Risks

**The page is the feature now, not just the editor.** A profile page that looks worse than the modal
it replaces is a regression even if every field works. It has to be worth visiting when you are not
editing.

**Anchored editors are fiddly.** A tile in the rightmost column, a tile near the viewport bottom, a
tile taller than the editor, a canvas that scrolls under a pinned editor. `place-popout.ts` handles
flipping and clamping and is already load bearing elsewhere, but this is the case that will produce
the bug reports.

**Inline fields are easy to lose.** A person who edits their bio and navigates away expects it kept
or expects to be asked. The canvas draft already survives navigation through a root-provided service;
the text fields must behave the same way or the page is inconsistent with itself.
