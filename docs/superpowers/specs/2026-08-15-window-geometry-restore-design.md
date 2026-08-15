# Window geometry restore

Remember the main window's size, the display it was on, and whether it was
maximized or fullscreen. Restore all three on the next launch, and never let a
damaged state file cost the user a window they can reach.

This replaces `tauri-plugin-window-state` outright: the vendored copy, its
`[patch.crates-io]` entry, the Rust dependency, the `@tauri-apps/plugin-window-state`
npm dependency, and the `window-state:default` capability all go.

## Why not keep the plugin

The vendored copy already carries one patch (the maximized bit read at close time
is false for a window minimized *from* maximized on Windows). Four further defects
are structural rather than incidental, and none can be fixed inside its schema:

1. **No monitor identity.** `restore_state` loops `available_monitors()` and calls
   `set_position` once per monitor whose rect intersects the saved rect - no break,
   no record of which display the window actually lived on. Change the monitor
   arrangement and the saved coordinates mean nothing.
2. **Physical pixels only.** A 1200x800 window on a 150% display saves as
   1800x1200. Restored on a 100% display it is 1800x1200 - half again as large as
   the user chose.
3. **Fullscreen poisons the windowed geometry.** `is_maximized()` is false in
   fullscreen, so `update_state` writes the fullscreen bounds into `width`/`height`
   /`x`/`y`. Leaving fullscreen after a restart drops the window at monitor bounds.
4. **No validation, non-atomic write.** `load_saved_window_states(...).unwrap_or_default()`
   discards every window's state on one bad byte, and `std::fs::write` truncates
   before writing, so a crash mid-write leaves a zero-length file.

Fixing 1 and 2 requires storing data the plugin's `WindowState` has no field for.
Owning the module is cheaper than carrying a fork that diverges on every point.

## Module layout

`src-tauri/src/window_state/`:

| File | Responsibility | Depends on `tauri` |
|---|---|---|
| `model.rs` | Persisted schema, semantic validation | no |
| `placement.rs` | Saved state + monitor list -> final physical rect | no |
| `store.rs` | Atomic load/save, corruption quarantine | no |
| `mod.rs` | Adapter: `resolve`, `apply`, `attach`, `flush` | yes |

The first three are pure functions over plain structs. They hold essentially all
the logic and all the failure modes, and they are unit-testable without a window,
a display, or a running app. `mod.rs` is a thin adapter over them.

## Schema

File: `window-geometry.json` in `app_config_dir()`.

```json
{
  "version": 1,
  "windows": {
    "echo": {
      "size":   { "width": 1200.0, "height": 800.0 },
      "offset": { "x": 120.0, "y": 60.0 },
      "monitor": {
        "name": "\\\\.\\DISPLAY1",
        "position": { "x": 0, "y": 0 },
        "size": { "width": 3840, "height": 2160 },
        "scale": 1.5
      },
      "mode": "windowed"
    }
  }
}
```

`size` and `offset` are **logical** pixels; `offset` is measured from the origin
of `monitor`'s work area. The `monitor` block is **physical** and serves only as
an identity fingerprint. `mode` is one of `windowed`, `maximized`, `fullscreen`.

A new filename means the old `.window-state.json` is ignored rather than migrated.
It records neither monitor identity nor logical units, so any import would be a
guess dressed as a memory. Existing users get one geometry reset.

### Logical units, monitor-relative offset

This is what makes "remember the screen" mean anything. Absolute physical
coordinates stop describing a place the moment a monitor's resolution, scale, or
position in the desktop arrangement changes - and all three change routinely
(docking, a driver update, a second display plugged in to the left, which puts
the primary monitor's neighbours at negative x).

An offset from a *named* monitor's work area survives all of it. A 1200x800
window sitting 120x60 into a 150% 4K display reopens as 1200x800 logical, 120x60
into whatever that display now is - or into the primary display if it is gone.

### `mode` is one enum, not two booleans

Upstream stores `maximized` and `fullscreen` independently, so they can disagree,
and `restore_state` applies both. One enum makes the question the user actually
asked - was it fullscreen - a single unambiguous read.

The more important consequence: `size` and `offset` are *by definition* the last
plain-windowed geometry. Nothing writes them while maximized or fullscreen. That
is defect 3 fixed by construction rather than by guard clauses, and it is what
makes leaving fullscreen land somewhere sane.

## Monitor resolution

`resolve` walks these in order and stops at the first hit:

1. **Exact fingerprint** - name, position, size and scale all match. The common
   case: nothing about the display has changed.
2. **Name matches, geometry differs** - the same display at a new resolution or
   scale. Keep it; the clamp below re-fits the rect into its current work area.
3. **Geometry matches, name does not** - covers `name()` returning `None`, and
   drivers that renumber `\\.\DISPLAY*` across reboots.
4. **No match** - the remembered display is gone. Center on the primary monitor
   at the remembered logical size, clamped to its work area. `maximized` and
   `fullscreen` are still honored; only the position is forfeited.

Monitor names are not unique - two identical panels can both report `\\.\DISPLAY1`
on some drivers - so step 2 takes the *first* name match and lets the clamp
handle the rest. Guessing between duplicates is not better than being consistent.

### The clamp invariant

Applied last, on every path including the exact match:

- Size is clamped to `[min_inner_size, work_area]` - so a 4K-sized window cannot
  be restored onto a 1080p panel.
- At least 120x40 logical pixels of the window must fall inside some monitor's
  work area, and the window's top edge may not sit above the work area top. The
  main window is `decorations(false)` with a custom titlebar, so the drag handle
  is the top strip: a window whose top edge is off-screen cannot be moved back
  with the mouse.

Running this even when the fingerprint matched exactly is deliberate. It means no
state file, however it was produced, can open the window somewhere the user
cannot reach it. The validation layers below reject nonsense; this one bounds the
damage from anything they let through.

## Corruption resistance

Five layers, each catching what the one before it cannot.

1. **Atomic write.** Serialize to `window-geometry.json.tmp` in the same
   directory, flush and `sync_all`, then `rename` over the target. Rename within
   a directory is atomic on NTFS and on POSIX, so an interrupted write leaves
   either the old file or the new one - never the truncated file that
   `std::fs::write` currently risks. A stale `.tmp` from a previous crash is
   overwritten, never read.
2. **Quarantine, not delete.** A file that fails to parse is renamed to
   `window-geometry.json.corrupt` (replacing any previous one) and startup
   continues with defaults. Deleting it would destroy the only evidence of a bug
   that by definition reproduces rarely.
3. **Version gate.** A missing, non-numeric, or unrecognised `version` is treated
   as corrupt. In particular a *newer* version is not parsed on a best-effort
   basis: a downgraded client guessing at a future schema is how you get a window
   restored to coordinates that meant something else.
4. **Per-entry isolation.** `windows` deserializes as a map of raw JSON values,
   and each entry is parsed independently. One malformed window costs that window
   only. (Upstream's single `unwrap_or_default()` over the whole file is what
   makes one bad byte cost all of them.)
5. **Semantic validation.** An entry that parses is still rejected if it is not
   *sane*: non-finite or NaN floats, zero or negative width/height, magnitudes
   above 32767 logical px, `scale` outside `0.1..=10.0`, an unrecognised `mode`.
   This is the layer that catches a file which is valid JSON of the right shape
   and still describes an impossible window.

A sixth guard sits outside the file entirely. `MonitorInfo` is reported by the
OS, so it never passes through `is_sane`: a display reporting a scale factor of
0 divides through to infinity and reaches the cast to `i32` as NaN, and a NaN
scale makes `f64::clamp` panic outright on its `min <= max` assertion. Both
`resolve` and `commit` therefore fall back to a scale of 1.0 on anything
unbelievable, and an empty work area falls back to the display's full bounds.

A rejected entry is not an error - it is indistinguishable from having no saved
state, and produces the default geometry. `load()` is therefore infallible to its
caller: every failure degrades and logs. **There is no path on which a bad state
file prevents the window from opening.** That property is the point of the
feature and is asserted directly in the tests.

## Lifecycle

### Restore

`AppHandle::available_monitors()` and `primary_monitor()` work before any window
exists, so `main_window::build` resolves placement *first* and never has to move
a visible window. The window is built hidden (as today), then:

1. `set_position(PhysicalPosition)` - puts the window on the target monitor.
2. `set_size(PhysicalSize)` - physical values computed against *that* monitor's
   scale factor.
3. `set_position` again.
4. `maximize()` or `set_fullscreen(true)` per `mode`.
5. `show()` and `set_focus()`.

Physical setters are used throughout because the logical variants are resolved
against whichever monitor the window currently occupies, which is exactly the
thing being changed. Step 3 is not redundant: on Windows, moving a window across
a DPI boundary raises `WM_DPICHANGED`, which carries a suggested rect and can
nudge the window after the size is applied.

Because `main_window::build` is the single choke point on both the update-gated
desktop path (`lib.rs:460`) and the mobile path (`lib.rs:500`), showing and
focusing moves into it. The plugin's `on_window_ready` hook did this before -
which is why the window is built hidden at all - so `main_window.rs`'s module
doc, which currently documents plugin behaviour as the reason, is rewritten.

`splash` is simply never attached. The `with_denylist(&["splash"])` workaround
and the comment explaining it are deleted rather than ported.

### Save

State is held in memory and updated from the window's own event handler:
`Resized`, `Moved`, `ScaleFactorChanged`. A write is debounced 500ms past the
last event, and forced synchronously on `CloseRequested`. This is strictly better
than upstream's save-on-exit-only: a crash no longer costs the user their layout.

`Destroyed` flushes what is already in memory but deliberately does **not**
re-read the window. Teardown is a transition like any other, and a geometry
reported by a window being destroyed is not one the user chose - reading it there
would let the last moment of a session overwrite the whole session.

**Never trust a geometry reading taken mid-transition.** This is the general form
of the lesson already recorded in the vendored patch, and it drives the design:

- Events while `is_minimized()` are ignored outright. A minimized window reports
  meaningless geometry on Windows.
- `Moved`/`Resized` update a *pending* rect only. Nothing is committed to the
  persisted state until the debounce fires.
- At commit time the current mode is read fresh. The pending rect is accepted
  into `size`/`offset` only if the window is plain windowed right now; otherwise
  it is discarded and only `mode` and `monitor` are recorded.

That last rule is what the naive version gets wrong. On Windows, maximizing
raises `Moved` (from `WM_WINDOWPOSCHANGED`) *before* the `WM_SIZE` that sets the
maximized bit - so a `Moved` handler that checks `is_maximized()` still sees
false and records the maximized origin, and the `Resized` that follows correctly
declines to overwrite the windowed rect, leaving the bad origin in place. Waiting
for the transition to settle and only then asking what the window is removes the
whole class of ordering bug rather than one instance of it.

`monitor` is updated on every commit regardless of mode, so dragging a maximized
window to another display is remembered as "the app lives over here now". The
stored offset is left alone; the clamp invariant re-fits it at restore time.

## Testing

`model.rs`, `placement.rs` and `store.rs` are pure, so the table below is
ordinary unit testing - no display, no window, no app handle.

**Placement** - exact match; resolution changed; scale changed; monitor absent;
`name` is `None`; two monitors sharing a name; monitor at negative coordinates
(a display arranged to the left of primary); saved window larger than the target
work area; saved rect fully off-screen; saved rect with 5px on-screen; work area
smaller than `min_inner_size`.

**Corruption** - empty file; truncated JSON; `{}`; valid JSON with wrong types;
NaN and infinity; zero and negative sizes; `scale` of 0; `version: 999`; version
absent; one bad entry beside one good entry. Every case asserts the same thing:
a usable default geometry comes back and no error escapes.

**Store** - round-trip; no `.tmp` file survives a successful write; a pre-existing
stale `.tmp` does not affect the result; a corrupt input is renamed to `.corrupt`
and the original path is left free for a fresh write.

`mod.rs` gets no unit tests - it is adapter code whose behaviour is the platform's.
It is covered by manual verification instead, and these are the cases that matter
because each one is a bug the current implementation has:

1. Resize, quit, relaunch - same size.
2. Move to a second display, quit, relaunch - same display, same spot.
3. Maximize, quit, relaunch - maximized.
4. Fullscreen, quit, relaunch - fullscreen; then leave fullscreen and confirm the
   window returns to its pre-fullscreen rect rather than monitor bounds.
5. Maximize, minimize, quit, relaunch - still maximized (the vendored patch's case).
6. Quit on a second display, unplug it, relaunch - centered on primary at the
   remembered size.
7. Change display scale between quit and relaunch - same perceived size.
8. Kill the process (Task Manager) while the window is open - relaunch restores
   the geometry from the last debounced write, not a default.
9. Corrupt the state file by hand, relaunch - window opens at defaults, a
   `.corrupt` file appears beside it.

## Out of scope

- Importing the old `.window-state.json`. See the schema section.
- Multi-window persistence beyond `echo`. The schema is a map keyed by label and
  `attach` takes any window, so adding one later is a call site, not a redesign.
- `windows_notifications.rs:124` looks up the window label `"main"`, but the
  window is labelled `"echo"`, so that show/unminimize/focus block is dead code.
  A real bug, unrelated to this work, and left for its own change.
