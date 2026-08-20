# The scenes shell

Opening a scene today replaces the whole scenes layout with a bare channel. Nothing says which folder
the scene lives in, and the only way back is the titlebar arrow. This makes the scenes view a shell
that keeps its rail and hosts the scene beside it, and gives the scene a breadcrumb.

Extends `2026-08-20-scene-folder-tree-design.md`.

## Decisions

| Question | Answer |
|---|---|
| Layout | The rail stays; the scene opens in the content pane beside it |
| Location | A breadcrumb above the scene, every segment clickable |
| Folder links | Reopen the archive already filtered to that folder |
| Scenes opened from elsewhere | Still a plain channel view, unchanged |

## The navigation model grows two fields

```ts
| {
      type: 'scenes';
      guildId: string;
      mode: SceneBoardMode;
      /** The shelf the board or archive is filtered to. Null is every shelf. */
      folderId?: string | null;
      /** The scene open in the content pane. Null means show the board or archive. */
      sceneChannelId?: string | null;
  }
```

Both fields go into `PersistedNav` so the app reopens where it was left. Both are part of nav
history, so the titlebar arrows walk scene-to-scene inside the shell rather than jumping out of it.

`folderId` moving into navigation is what makes a folder linkable at all. Today it is component
state on the archive, so nothing outside that component can point at a shelf.

## The board becomes a shell

`SceneBoardComponent` already owns the header, the mode switch, the rail toggle and the dialog. It
gains one more job: deciding what fills the content pane.

```
┌ header: title · Playing/Archive · Folders · waiting · New scene ┐
├────────────┬──────────────────────────────────────────────────┤
│            │  sceneChannelId ?  breadcrumb + <app-channel>     │
│    rail    │  mode archive   ?  <app-scene-archive>            │
│            │  otherwise      ?  the board's own grouping       │
└────────────┴──────────────────────────────────────────────────┘
```

The rail is unchanged and keeps its own state. Selecting a scene sets `sceneChannelId`; selecting a
folder clears it and sets `folderId`.

### Why nesting the channel is safe

`channel.component` imports `SceneHeaderComponent` from `scenes/`, and nothing under `scenes/`
imports `channel.component`. So `scene-board -> channel -> scene-header` is one-way. The invariant
that keeps it that way: **`scene-header` and anything it pulls in must never import the board.**
That is worth a comment on the import, because violating it is silent until the bundler complains.

`main-page` renders either the scenes view or a channel, never both, so only one `ChannelComponent`
is ever mounted.

## The breadcrumb

A small component, `scene-breadcrumb`, above the hosted channel:

```
‹  Scenes  /  🏛️ Das Büro  /  Akt 1: Mäxus Kündigung  /  Das Büro
```

- `‹` and `Scenes` clear `sceneChannelId`, returning to whichever mode was last shown.
- A folder segment sets `folderId` to that folder and clears `sceneChannelId`, landing on the
  archive filtered to it.
- The last segment is the scene, not a link.
- The path comes from the scene's `folderId` walked up through `SceneTaxonomyService`. A scene with
  no folder shows `Scenes / Das Büro` with no folder segments.
- A folder the guild has since deleted is skipped rather than rendered as a dead segment.

## Not doing

- Changing how a scene opens from a notification, a link, or the channel list. Those still open the
  plain channel view. Giving that case its own back affordance is worth doing later, but it is a
  different entry point with a different answer.
- Hosting anything other than a scene channel in the shell.
- Making the rail resizable here. That belongs to the folder tree work and lands separately.

## Risks

**The board component becomes a layout shell as well as a board.** It already carries the header,
the mode switch, the dialog and two grouping strategies. If the shell logic pushes it past what one
file can hold clearly, the board's own grouping moves into its own component and the shell keeps the
layout. Decide that during implementation, not upfront.

**Nav history could trap you.** Every scene you open inside the shell is a history entry, so walking
back through ten scenes to leave the shell would be miserable. The breadcrumb's `Scenes` link is a
replace, not a push, so leaving is always one step.

**Persistence of a stale scene.** A `sceneChannelId` pointing at a channel that is gone must fall
back to the board rather than render an empty pane.
