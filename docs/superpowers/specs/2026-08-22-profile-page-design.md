# Profile page

Your profile becomes a page you visit and edit on the thing itself. Everything about how you look
moves off the settings form: banner, avatar, name, pronouns, bio, accent, font and the canvas.
Settings keeps account and security.

Companion to `2026-08-22-profile-canvas-design.md`, which owns the canvas model, the layout engine,
the widget registry and the visibility rules. This one owns the page, the edit mode and the
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
| What moves | Banner, avatar, name, pronouns, bio, accent, font, canvas |
| What stays in settings | Account, Connections, Sessions, Change Password, Danger Zone |
| Edit model | Explicit mode. View, then Edit, then Save or Cancel |
| Widget editing | Anchored to the selected tile, not a side panel |
| Second representation | None. The grid is the only list of widgets |
| Visitor preview | Me / Friend / Mutual / Stranger, in edit mode |
| Route | `/profile`, reachable from the self-profile menu |
| Backend | None beyond what the canvas spec already needs |

## 1. The page

`src/app/features/profile/profile-page/`.

Two states, and the page is never ambiguous about which it is in.

**Viewing** renders exactly what another person sees: banner, avatar, name, pronouns, bio, then the
canvas at four columns through the same `ProfileCanvasComponent` every other surface uses. One Edit
button.

**Editing** turns the same layout into a workshop in place. Nothing reflows into a form. Banner and
avatar gain a change affordance, name, pronouns and bio become fields where they already sit, and the
grid becomes draggable. Save and Cancel replace Edit.

The identity strip stays fixed relative to the canvas in both states, the way the canvas spec
requires. It is the anti-impersonation guarantee and it is not arrangeable.

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

In edit mode a segmented control offers Me, Friend, Mutual and Stranger. Selecting one redraws the
canvas as that viewer would see it, applying each widget's own `visibility`.

Widgets that viewer cannot see **dim rather than disappear**, so the distinction between "hidden from
them" and "not there" stays visible. A line under the grid states how many are hidden.

This is a pure client computed over data already loaded. It asks nothing of the server, because the
owner is allowed to see all of their own widgets by definition.

Per-widget visibility is otherwise a control nobody can verify. This is the thing that makes it
checkable, and it is the reason to build it rather than a flourish.

## 4. What moves, field by field

| Field | Today | On the page |
| --- | --- | --- |
| Banner | Settings section, file input, crop dialog | Click the banner itself, same crop dialog |
| Avatar | Settings section, file input, crop dialog | Click the avatar itself, same crop dialog |
| Display name | Settings text input | Inline field where the name is drawn |
| Pronouns | Settings text input | Inline field under the name |
| Bio | Settings textarea | Inline field where the bio is drawn |
| Accent | Settings colour picker | Edit-mode control in the page header |
| Font | Settings select | Edit-mode control in the page header |
| Canvas | Settings section, added then removed | The page |

The crop dialogs move as they are. They are already self-contained and there is no reason to touch
them.

`profile-settings.component.html` loses its first four sections and keeps the last five. It should
end up under 400 lines.

## 5. Where the state goes

Unchanged from the canvas spec, and worth restating because the page changes what sits next to what.

| State | Home |
| --- | --- |
| The saved canvas | `ProfileCanvasStore` |
| The unsaved canvas draft | `CanvasEditorService` |
| The profile row | `ProfileService.ownProfile` |
| Unsaved name, pronouns, bio, accent, font | The page component, a signal per field |
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

The self-profile menu gains "Edit profile", pointing at `/profile`. The existing menu already opens
settings and the profile popout, so this sits beside them.

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
