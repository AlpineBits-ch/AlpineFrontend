# Threads on a message

Design for Discord-style inline threads in the Angular client: a thread started from a specific
message, a card under that message, and a thread side panel beside the parent channel.

Server contract: `threads-on-a-message-frontend-guide`. Everything below is client work.

## What ships

1. Start a thread from a message, from the hover toolbar or a right-click menu.
2. A card under the starter message showing the thread name, message count and last activity.
3. A resizable side panel that opens the thread beside the parent channel, parent still live.
4. Active threads nested under their parent channel in the sidebar.

## Decisions taken

| Question             | Answer                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| Where a thread opens | Right side panel, parent channel stays live. Not a main-view replacement.        |
| Entry points         | Hover toolbar button and a new right-click context menu.                         |
| Sidebar              | Active threads nested under the parent channel.                                  |
| Unread on the card   | No. Count and relative time only. Sidebar rows keep ordinary channel read state. |
| Extraction           | Its own commit with characterization tests first, then the feature on top.       |

## A. Wire additions

| File                                  | Addition                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `dtos/response/message.dto.ts`        | `threadId?: string \| null`; `MessageFlags.HasThread = 1 << 5`                              |
| `dtos/response/guild.dto.ts`          | `ChannelDto.starterMessageId?: string`                                                      |
| `services/guild.service.ts`           | `createThreadFromMessage(channelId, messageId, dto)`, `getChannel(id)`                      |
| `services/guild-websocket.service.ts` | `WsMessageThreadAttached`, `messageThreadAttachedObservable`, `guild.MessageThreadAttached` |

`CreateThreadDto` is reused unchanged. `tagIds` is ignored by this route.

`ThreadCreationService` wraps the create call and maps `409` to `of(err.error.threadId)`, so callers
see one success path returning a thread id. Only real failures reach a toast.

Threads already arrive in the guild payload alongside channels: `channel-list` filters them out with
`!c.parentChannelId`, and `forum-post-rows.component.ts` reads them straight off `guild.channels`.
So the card and the sidebar read `guild.channels` first and call `getChannel` only when the id is
not there yet, which is the window between a `ThreadCreated` event and the next guild refresh.

That lookup is a service, `ThreadRegistryService`, rather than the same three lines at each call
site. Whether a text-channel thread arrives in the payload the way a forum post does is unverified
against a live server, so exactly one file should absorb the answer either way.

## B. Phase 0, extraction

`channel.component` is 903 TS + 447 HTML and holds the message list, scroll machinery,
`createMessage` with its MLS send path, encryption resolution, read tracking and typing inline. The
thread panel needs all of that and none of the chrome around it, and a component that size cannot be
instantiated twice side by side as it stands.

New `channel/channel-conversation/channel-conversation.component.{ts,html,css}`.

- Inputs: `channel: ChannelDto`, `variant: 'main' | 'panel'`.
- `variant: 'panel'` drops the channel intro block and tightens padding.
- Public `jumpToMessage(id)`, called by the parent through a `viewChild`.

Moves into it: `messages`, `messageRows`, `hasMore`, `loadingMore`, `loadError`, the scroll block
including `afterEveryRender`, `createMessage` and `send`, `resolveEncryptionState`, `relinkDevice`,
`replyingTo`, `autoModError`, `typingText`, the read-tracking effect, the MLS and access banners,
the channel intro, jump-to-present, and the composer.

Stays in `channel.component`: header, search and its results overlay, forum tag bar and dialog,
scene header, follow dialog, panel toggles.

Scene handling straddles the cut. The turn prompt and the conclusion mark belong to the list, the
header does not. `sceneChannelId` becomes an exported helper both sides call rather than a second
copy.

The new component uses `ConversationScrollService`, already a component-provided `@Injectable()`,
instead of the inline scroll copy. That removes an existing duplication rather than adding one.

### Characterization first

`channel.component` has no component spec today, only `channel-utils.spec.ts`. The commit starts
with `channel.component.spec.ts` covering:

- optimistic send, then confirm
- send failure, `failMessage`
- auto-mod refusal, `removeMessage` plus the banner
- scroll to bottom on channel switch
- the read-tracking call on the newest settled message

Green against the current code, then the code moves and the spec is re-pointed at
`channel-conversation.component.spec.ts`. No behaviour change in this commit.

## C. Starting a thread

**Hover toolbar.** A `pi pi-comments` button between reply and pin, on a new `createThread` output.

**Right-click menu.** New `message-context-menu` using PrimeNG `ContextMenu` and `MenuItem[]`, the
pattern `guild-member-list` already uses. Items, all wired to handlers `MessageComponent` has:
Reply, Create Thread (reads "Go to Thread" once `threadId` is set), Copy Text, Pin/Unpin, Edit,
Delete, Report. A menu with a single item would read as broken, so it ships with the full set.

Both entry points are hidden unless every one of these holds:

- channel type is `Text`
- the Threads module is on for the guild
- the caller has `Permissions.CreateThreads`
- the channel is not encrypted
- the message is real: not pending, failed, ephemeral, a bot-command placeholder, or a system message

Encryption hides rather than disables. A thread off an encrypted channel would be created
unencrypted, so the affordance must not be there at all. `channel-conversation` already resolves
encryption state, so it passes `canCreateThread` into `app-message` the way `canPinMessages` is
passed today.

**Dialog.** `create-thread-dialog`. Name prefilled from the first few words of the decoded starter
content, blank when undecryptable. Optional first reply goes in `content`. Success opens the panel
on the new thread. `409` opens the existing thread with no toast.

## D. The card

New `message-thread-card`, rendered in `message.component` after content and attachments, before the
reaction bar. An elbow connector rising into the avatar gutter, then a rounded row: thread name in
the accent colour, `N messages`, a relative last-activity stamp, and a chevron on hover.

Resolution: `guild.channels` by `threadId`, else a `getChannel` fetch memoised per thread id so ten
cards for one thread do not make ten requests. A `threadId` that resolves to nothing renders no card
and reports nothing. The guide calls that expected, not a bug.

The card carries `messageCount` and `lastActivityAt` only. No unread state.

`MessageThreadAttached` patches `threadId` and the name onto the one message it names.

## E. The side panel

New `channel/thread-side-panel/`.

- Header: comments icon, thread name, a back line naming the parent channel, close X.
- Body: the starter message once at the top as a quoted, non-interactive row, a divider, then
  `<app-channel-conversation [channel]="thread" variant="panel">`.

The starter quote is worth its fetch. The server does not copy the starter into the thread, so
without it the panel opens on a reply to something invisible. Read from `MessageStore` when it is
already there, else `MessagingService.getMessageById`.

State lives on `NavigationService` as `threadPanel = signal<ChannelDto | null>(null)` with
`openThread()`, because the sidebar rows are a sibling of the channel view and open it too. It
clears on any channel or view change. Opening it closes the threads and pinned panels, and they
close it.

Width resizable, default 25rem, clamped 20rem to 40rem, persisted to localStorage. Escape closes.
Below `sm` it takes the pane instead of sitting beside, matching what the header already does there.

An archived thread gets a notice strip and keeps its composer. The server is the authority and the
client has no unarchive route today.

## F. Sidebar nesting

`forum-post-rows.util.ts` already selects exactly right: same parent, not archived, ranked
mention then unread then visited, capped at 8, sorted by `lastActivityAt ?? createdAt`. Nothing
about it is forum-specific except the names.

- Rename to `nested-thread-rows.util.ts`, `selectNestedThreads(parentId, ...)`.
- Rename `ForumVisitedPostsService` to match, keyed by parent id as it already is.
- Add `app-thread-rows` beside `app-forum-post-rows` in `channel-list-items.component.html`, under
  a Text channel when the Threads module is on.

Rows carry ordinary channel read state, as every other sidebar row does. The card stays clean, the
sidebar behaves like the sidebar.

## G. i18n

New flat `THREAD.*` keys in the locales submodule, its own commit: `CREATE`, `GO_TO`,
`DIALOG_TITLE`, `NAME_PLACEHOLDER`, `FIRST_MESSAGE_PLACEHOLDER`, `MESSAGE_COUNT`, `STARTED_BY`,
`ARCHIVED_NOTICE`, `PANEL_PARENT`, plus the context-menu labels. `MESSAGE.*` and `COMMON.*` cover
the rest of the menu.

## H. Testing

Phase 0 characterization as above, then:

- `409` folds to the existing thread id, no toast
- card resolves from `guild.channels`, fetches when absent, renders nothing on a dead id
- `MessageThreadAttached` patches the named message and no other
- `selectNestedThreads` against a Text parent
- entry points hidden in an encrypted channel, and without `CreateThreads`

Adding spec files reshuffles Vitest worker batching. An unrelated failure appearing after this lands
is usually that, not this.

## I. Out of scope

Thread member lists, auto-archive UI, unarchive, thread-specific notification settings, the mobile
Flutter client, and the bots `THREAD_CREATE` shape.
