# Consecutive Message Grouping (Compact Messages) - Design

## Background

Every rendered chat message (in both guild channels and DMs) currently shows its own avatar,
author name, and timestamp, even when several messages arrive back-to-back from the same
person - unlike Discord's familiar "compact follow-up" pattern. `MessageComponent`
(`src/app/features/messaging/components/conversation/message/message.component.ts`) is the
single shared row renderer used by both `ChannelComponent` (guild) and `ConversationComponent`
(DM); there is currently no grouping/consecutive-message logic anywhere in the codebase.

## Goals

- When a message's author matches the immediately preceding message's author, and the two are
  close enough in time, render the later message in a compact form: no avatar, no
  name/timestamp header row, just the message body - visually attached under the previous
  message.
- The compact/grouped state is purely a function of message data (author, timestamp, reply
  target), not a live timer, so it behaves identically for freshly-arrived realtime messages
  and for history loaded from scrollback/REST.
- Compact rows reveal their timestamp on hover, in the space the avatar would otherwise
  occupy (matches the Discord pattern this request is modeled on).
- Applies identically to guild channel messages and DM/conversation messages.

## Non-goals

- No changes to `SystemMessageComponent` (join/leave) - those are already a separate,
  always-standalone rendering path and are excluded from grouping consideration entirely.
- No live/rolling timers. The 20s window is evaluated once per message from `createdAt`
  timestamps, not re-evaluated on a clock while the view is open.
- No change to grouping behavior on message edit - grouping is keyed off `createdAt`, so
  editing a message's content later does not change its grouped/ungrouped state.
- No visual grouping across a reply: a message with `inReplyTo` set always renders in full,
  regardless of author/timing, and (as the *next* message after it) does not get grouped into
  by a following same-author message either - only the two directly-adjacent same-author,
  non-reply cases matter, so no boundary case is left ambiguous.

## Grouping rule

**`src/app/features/messaging/components/conversation/message-utils.ts`** gains:

```ts
const GROUPING_WINDOW_MS = 20_000;

export function isGroupedWithPrevious(current: MessageDto, previous: MessageDto | undefined): boolean {
    if (!previous) return false;
    if (previous.authorId !== current.authorId) return false;
    if (current.inReplyTo) return false;
    if (isSystemMessageType(previous.type)) return false;
    const gap = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime();
    return gap >= 0 && gap <= GROUPING_WINDOW_MS;
}
```

`isSystemMessageType` checks `type === MessageType.GuildMemberJoin || type === MessageType.GuildMemberLeave`
(reuses/extends the same check `channel.component.html` already makes to pick
`app-system-message` vs `app-message`). Pure function, no `MessageComponent`/list-component
dependencies - directly unit-testable.

## List component wiring

**`src/app/features/guild/components/channel/channel.component.ts`** and
**`src/app/features/messaging/components/conversation/conversation.component.ts`** each already
expose a `messages = computed(...)` (sorted `MessageDto[]`). Each gains a second computed built
on top of it:

```ts
protected messageRows = computed(() => {
    const msgs = this.messages();
    return msgs.map((message, i) => ({
        message,
        isGrouped: isGroupedWithPrevious(message, msgs[i - 1]),
    }));
});
```

Both templates' `@for (msg of messages(); track msg.id)` loops change to
`@for (row of messageRows(); track row.message.id)`, referencing `row.message` where `msg` was
used before, and passing the new flag: `<app-message [isGrouped]="row.isGrouped" ... />`. The
existing system-message branch (`channel.component.html`) keys off `row.message.type` exactly
as it keys off `msg.type` today - unaffected by grouping.

## `MessageComponent` changes

**`message.component.ts`**
- New `public isGrouped = input<boolean>(false);`.

**`message.component.html`**
- Wrap the avatar block (lines 9-11) and the name/badge/timestamp header row (lines 35-68) in
  `@if (!isGrouped()) { ... }`.
- When `isGrouped()` is true, render a narrow gutter in place of the avatar
  (same width as `app-avatar` so content stays aligned) containing just a timestamp span:
  `hidden group-hover:block text-[10px] text-white/25`, using the row's existing `group` class
  (`message.component.html:7` already has `group` on the row for hover-toolbar purposes) so no
  new hover-state plumbing is needed.
- Row padding (`message.component.html:7`, currently `px-4 py-1.5`) tightens vertically when
  grouped, e.g. `[class.py-1.5]="!isGrouped()"` / `[class.py-0.5]="isGrouped()"`, so grouped
  rows sit visually closer together, matching Discord's compact spacing.

Everything else in `MessageComponent` (reply reference, content body, attachments, embeds,
reactions, hover toolbar) is unaffected - a grouped message still renders its full body, just
without its own avatar/name/timestamp header.

## Testing

- Unit tests for `isGroupedWithPrevious` in `message-utils.ts`: same author within window ->
  true; different author -> false; same author but >20s gap -> false; `inReplyTo` set -> false;
  previous is a system message type -> false; no previous message -> false.
- Manual verification in the running app: send several quick messages in a row in both a DM and
  a guild channel and confirm only the first shows avatar/name/timestamp, confirm a message from
  a different user in between breaks the grouping, confirm waiting >20s before sending again
  starts a new full block, and confirm hovering a compact row reveals its timestamp.

## Open questions / follow-ups (not blocking this spec)

- None identified.