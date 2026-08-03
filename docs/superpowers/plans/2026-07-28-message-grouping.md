# Consecutive Message Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render consecutive same-author messages (within a 20s window, no reply) in a compact form - no avatar/name/timestamp header, just the body - in both guild channels and DMs.

**Architecture:** A single pure function (`isGroupedWithPrevious`) decides grouping from message data alone (author, timestamp, reply target). Each list component (`ChannelComponent`, `ConversationComponent`) derives a `messageRows` computed from its existing `messages` computed, pairing each message with its grouping flag, and passes that flag into the shared `MessageComponent` via a new `isGrouped` input, which conditionally hides its avatar/header block and tightens spacing.

**Tech Stack:** Angular 21 (signals, `input()`, new `@if`/`@for` control flow), Vitest (`*.spec.ts`, run via `ng test`).

## Global Constraints

- Grouping window: exactly 20,000ms, measured as `current.createdAt - previous.createdAt`, evaluated purely from data (no timers).
- A message with `inReplyTo` set is never grouped into the previous message.
- A message immediately following a system message (`GuildMemberJoin`/`GuildMemberLeave`) is never grouped.
- Grouped rows reveal their timestamp on hover in the avatar's gutter space; ungrouped rows are unchanged from today.
- No changes to `SystemMessageComponent` or system-message rendering.
- Full spec: `docs/superpowers/specs/2026-07-28-message-grouping-design.md`.

---

### Task 1: Grouping rule helper + unit tests

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message-utils.ts`
- Create: `src/app/features/messaging/components/conversation/message-utils.spec.ts`

**Interfaces:**
- Produces: `isGroupedWithPrevious(current: MessageDto, previous: MessageDto | undefined): boolean`, exported from `message-utils.ts`. This is what Tasks 3 and 4 import and call.

- [ ] **Step 1: Write the failing tests**

Create `src/app/features/messaging/components/conversation/message-utils.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {isGroupedWithPrevious} from './message-utils';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageType} from '../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';

function makeMessage(overrides: Partial<MessageDto>): MessageDto {
    return {
        id: 'm1',
        createdAt: new Date('2026-07-28T10:00:00.000Z'),
        updatedAt: new Date('2026-07-28T10:00:00.000Z'),
        content: '',
        channelId: 'c1',
        conversationId: undefined,
        authorId: 'author-a',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.Message,
        ...overrides,
    };
}

describe('isGroupedWithPrevious', () => {
    it('returns false when there is no previous message', () => {
        const current = makeMessage({id: 'm1'});
        expect(isGroupedWithPrevious(current, undefined)).toBe(false);
    });

    it('returns true for the same author within the 20s window', () => {
        const previous = makeMessage({id: 'm1', createdAt: new Date('2026-07-28T10:00:00.000Z')});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:19.999Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(true);
    });

    it('returns false for the same author past the 20s window', () => {
        const previous = makeMessage({id: 'm1', createdAt: new Date('2026-07-28T10:00:00.000Z')});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:20.001Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false for a different author', () => {
        const previous = makeMessage({id: 'm1', authorId: 'author-a'});
        const current = makeMessage({id: 'm2', authorId: 'author-b', createdAt: new Date('2026-07-28T10:00:05.000Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false when the current message is a reply', () => {
        const previous = makeMessage({id: 'm1'});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:05.000Z'), inReplyTo: 'm0'});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false when the previous message is a system message', () => {
        const previous = makeMessage({id: 'm1', type: MessageType.GuildMemberJoin});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:05.000Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test --include='**/message-utils.spec.ts'`
Expected: FAIL - `isGroupedWithPrevious` is not exported from `message-utils.ts` (import error / undefined function).

- [ ] **Step 3: Implement the helper**

In `src/app/features/messaging/components/conversation/message-utils.ts`, add these imports at the top of the file and the two new exports at the bottom (existing `decodeContent`/`fileIcon` stay untouched):

```ts
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageType} from '../../../../enums/message-type.enum';
```

```ts
const GROUPING_WINDOW_MS = 20_000;

function isSystemMessageType(type: MessageType): boolean {
    return type === MessageType.GuildMemberJoin || type === MessageType.GuildMemberLeave;
}

export function isGroupedWithPrevious(current: MessageDto, previous: MessageDto | undefined): boolean {
    if (!previous) return false;
    if (previous.authorId !== current.authorId) return false;
    if (current.inReplyTo) return false;
    if (isSystemMessageType(previous.type)) return false;
    const gap = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime();
    return gap >= 0 && gap <= GROUPING_WINDOW_MS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test --include='**/message-utils.spec.ts'`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/messaging/components/conversation/message-utils.ts src/app/features/messaging/components/conversation/message-utils.spec.ts
git commit -m "feat: add isGroupedWithPrevious message grouping helper"
```

---

### Task 2: `MessageComponent` compact rendering

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`

**Interfaces:**
- Consumes: nothing new from other tasks (this task is self-contained; `isGrouped` defaults to `false` so behavior is unchanged until Tasks 3/4 wire it up).
- Produces: `MessageComponent.isGrouped: InputSignal<boolean>` - Tasks 3 and 4 bind `[isGrouped]` on `<app-message>` to this.

There is no existing spec file for this component (`message.component.spec.ts` does not exist and this plan does not add one - no other component in this codebase's message-rendering area has one either). Verification for this task is manual, done at the end of Task 3.

- [ ] **Step 1: Add the `isGrouped` input**

In `src/app/features/messaging/components/conversation/message.component.ts`, next to the other `input()` declarations (around line 74-77):

```ts
    public message = input.required<MessageDto>();
    public guildChannels = input<ChannelDto[]>([]);
    public guildRoles = input<RoleDto[]>([]);
    public guildBots = input<BotCommandDto[]>([]);
    public isGrouped = input<boolean>(false);
```

- [ ] **Step 2: Compact the row wrapper padding**

In `src/app/features/messaging/components/conversation/message/message.component.html`, change the root `div` (currently lines 1-7):

Before:
```html
<div #msgElement
     (touchend)="onTouchEnd()"
     (touchmove)="onTouchMove()"
     (touchstart)="onTouchStart()"
     [class.opacity-50]="message().isPending"
     [ngClass]="message().isFailed ? 'bg-rose-500/5' : ''"
     class="relative flex items-start gap-3 px-4 py-1.5 hover:bg-white/[0.02] rounded-lg transition-colors group">
```

After:
```html
<div #msgElement
     (touchend)="onTouchEnd()"
     (touchmove)="onTouchMove()"
     (touchstart)="onTouchStart()"
     [class.opacity-50]="message().isPending"
     [class.py-1.5]="!isGrouped()"
     [class.py-0.5]="isGrouped()"
     [ngClass]="message().isFailed ? 'bg-rose-500/5' : ''"
     class="relative flex items-start gap-3 px-4 hover:bg-white/[0.02] rounded-lg transition-colors group">
```

- [ ] **Step 3: Replace the avatar block with a grouped-aware gutter**

In the same file, replace the avatar block (currently lines 9-11):

Before:
```html
    <div (click)="profileDialogSvc.open(message().authorId)" class="cursor-pointer shrink-0 mt-0.5">
        <app-avatar [userId]="message().authorId"/>
    </div>
```

After:
```html
    @if (!isGrouped()) {
        <div (click)="profileDialogSvc.open(message().authorId)" class="cursor-pointer shrink-0 mt-0.5">
            <app-avatar [userId]="message().authorId"/>
        </div>
    } @else {
        <div class="shrink-0 w-8 flex items-start justify-center mt-0.5">
            <span class="hidden group-hover:block text-[10px] text-white/25 select-none">{{ message().createdAt | date: 'shortTime' }}</span>
        </div>
    }
```

(`w-8` = 2rem, matching the default `p-avatar` "normal" size used here, so grouped rows stay aligned with ungrouped ones. `group-hover` relies on the `group` class already present on the root row from Step 2.)

- [ ] **Step 4: Hide the name/timestamp header row when grouped**

In the same file, wrap the header row (currently lines 35-68, starting `<div class="flex items-center gap-2 mb-1">` and ending at its matching `</div>`):

Before:
```html
        <div class="flex items-center gap-2 mb-1">
            @if (botName(message().authorId); as bName) {
```
... (unchanged content in between) ...
```html
        </div>
```

After - wrap that whole block in `@if (!isGrouped())`:
```html
        @if (!isGrouped()) {
            <div class="flex items-center gap-2 mb-1">
                @if (botName(message().authorId); as bName) {
```
... (unchanged content in between, indentation may stay as-is) ...
```html
            </div>
        }
```

Do not change anything else in the file - the reply reference block, content body, attachments, embeds, reactions, and hover toolbar stay exactly as they are today.

- [ ] **Step 5: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully with no template errors (confirms the new `@if`/`@else` blocks are balanced and `isGrouped` resolves).

- [ ] **Step 6: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/message.component.ts src/app/features/messaging/components/conversation/message/message.component.html
git commit -m "feat: add compact rendering mode to MessageComponent"
```

---

### Task 3: Wire grouping into `ChannelComponent` (guild channels)

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: `isGroupedWithPrevious` from Task 1 (`src/app/features/messaging/components/conversation/message-utils.ts`), `isGrouped` input on `MessageComponent` from Task 2.
- Produces: `protected messageRows = computed(() => { message: MessageDto; isGrouped: boolean }[])` on `ChannelComponent` - template-only, no other task depends on it.

- [ ] **Step 1: Add the `messageRows` computed**

In `src/app/features/guild/components/channel/channel.component.ts`, add the import near the other relative imports (around line 20-22):

```ts
import {isGroupedWithPrevious} from '../../../messaging/components/conversation/message-utils';
```

Then, directly below the existing `messages` computed (around line 103-108), add:

```ts
    protected messageRows = computed(() => {
        const msgs = this.messages();
        return msgs.map((message, i) => ({
            message,
            isGrouped: isGroupedWithPrevious(message, msgs[i - 1]),
        }));
    });
```

- [ ] **Step 2: Update the template to use `messageRows`**

In `src/app/features/guild/components/channel/channel.component.html`, replace the messages loop (currently lines 202-218):

Before:
```html
                <!-- Messages list -->
                <div class="flex flex-col gap-0.5 pb-4">
                    @for (msg of messages(); track msg.id) {
                        <div [attr.data-message-id]="msg.id">
                            @if (msg.type === MessageType.GuildMemberJoin || msg.type === MessageType.GuildMemberLeave) {
                                <app-system-message [message]="msg"/>
                            } @else {
                                <app-message (jumpTo)="jumpToMessage($event)"
                                             (reply)="onReply($event)"
                                             [guildBots]="botCommandService.currentGuildBots()"
                                             [guildChannels]="guildChannels()"
                                             [guildRoles]="guildRoles()"
                                             [message]="msg"></app-message>
                            }
                        </div>
                    }
                </div>
```

After:
```html
                <!-- Messages list -->
                <div class="flex flex-col gap-0.5 pb-4">
                    @for (row of messageRows(); track row.message.id) {
                        <div [attr.data-message-id]="row.message.id">
                            @if (row.message.type === MessageType.GuildMemberJoin || row.message.type === MessageType.GuildMemberLeave) {
                                <app-system-message [message]="row.message"/>
                            } @else {
                                <app-message (jumpTo)="jumpToMessage($event)"
                                             (reply)="onReply($event)"
                                             [guildBots]="botCommandService.currentGuildBots()"
                                             [guildChannels]="guildChannels()"
                                             [guildRoles]="guildRoles()"
                                             [isGrouped]="row.isGrouped"
                                             [message]="row.message"></app-message>
                            }
                        </div>
                    }
                </div>
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Manual verification**

Run: `npm start` (or the project's usual `run` workflow), open a guild channel, and:
1. Send two messages quickly as the same user - confirm the second renders compact (no avatar/name/timestamp) and hovering it reveals a timestamp where the avatar would be.
2. Have a different user (or another account) post between two of your messages - confirm grouping breaks and the interleaved message shows its own full header.
3. Wait 21+ seconds between two messages from the same user - confirm the second renders full, not compact.
4. Confirm a `GuildMemberJoin`/`GuildMemberLeave` system message is unaffected, and the real message right after it still renders full (not grouped into the system line).

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel/channel.component.ts src/app/features/guild/components/channel/channel.component.html
git commit -m "feat: apply message grouping to guild channel messages"
```

---

### Task 4: Wire grouping into `ConversationComponent` (DMs)

**Files:**
- Modify: `src/app/features/messaging/components/conversation/conversation.component.ts`
- Modify: `src/app/features/messaging/components/conversation/conversation.component.html`

**Interfaces:**
- Consumes: `isGroupedWithPrevious` from Task 1 (same file, `./message-utils` - `conversation.component.ts` lives in the same directory), `isGrouped` input on `MessageComponent` from Task 2.
- Produces: `protected messageRows = computed(() => { message: MessageDto; isGrouped: boolean }[])` on `ConversationComponent` - template-only.

- [ ] **Step 1: Add the `messageRows` computed**

In `src/app/features/messaging/components/conversation/conversation.component.ts`, add the import near the other relative imports (around line 20-22):

```ts
import {isGroupedWithPrevious} from './message-utils';
```

Then, directly below the existing `messages` computed (around line 90-95), add:

```ts
    protected messageRows = computed(() => {
        const msgs = this.messages();
        return msgs.map((message, i) => ({
            message,
            isGrouped: isGroupedWithPrevious(message, msgs[i - 1]),
        }));
    });
```

- [ ] **Step 2: Update the template to use `messageRows`**

In `src/app/features/messaging/components/conversation/conversation.component.html`, replace the messages loop (currently lines 245-259):

Before:
```html
                <!-- Messages list -->
                <div class="flex flex-col gap-0.5 pb-4">
                    @for (msg of messages(); track msg.id) {
                        @if (msg.id === firstUnreadId()) {
                            <div class="unread-divider">
                                <span>New messages</span>
                            </div>
                        }
                        <div [attr.data-message-id]="msg.id" class="message-row">
                            <app-message (jumpTo)="jumpToMessage($event)"
                                         (reply)="onReply($event)"
                                         [message]="msg"></app-message>
                        </div>
                    }
                </div>
```

After:
```html
                <!-- Messages list -->
                <div class="flex flex-col gap-0.5 pb-4">
                    @for (row of messageRows(); track row.message.id) {
                        @if (row.message.id === firstUnreadId()) {
                            <div class="unread-divider">
                                <span>New messages</span>
                            </div>
                        }
                        <div [attr.data-message-id]="row.message.id" class="message-row">
                            <app-message (jumpTo)="jumpToMessage($event)"
                                         (reply)="onReply($event)"
                                         [isGrouped]="row.isGrouped"
                                         [message]="row.message"></app-message>
                        </div>
                    }
                </div>
```

Note: if `row.message.id === firstUnreadId()` is true, the unread divider still forces a visual break above that message, but `isGrouped` is computed independently and may still be `true` if the author/timing match - that's fine, the divider and the compact header are unrelated concerns and both can render together.

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Manual verification**

Run: `npm start`, open a DM, and repeat the same four checks as Task 3 Step 4 (rapid same-author messages compact + hover timestamp, interleaved different author breaks grouping, >20s gap breaks grouping). System-message check doesn't apply to DMs (no `SystemMessageComponent` usage in `ConversationComponent`).

- [ ] **Step 5: Commit**

```bash
git add src/app/features/messaging/components/conversation/conversation.component.ts src/app/features/messaging/components/conversation/conversation.component.html
git commit -m "feat: apply message grouping to DM conversation messages"
```