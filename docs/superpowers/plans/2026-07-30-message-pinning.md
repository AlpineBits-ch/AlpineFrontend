# Message Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pin/unpin messages in guild channels and DMs, see a pinned badge on pinned messages, and browse a per-channel/per-conversation "Pinned Messages" panel - backed by the already-live pinning endpoints described in the backend integration guide.

**Architecture:** `MessageDto` gains `isPinned`/`pinnedAt`/`pinnedById`. `MessagingService` gains `pinMessage`/`unpinMessage`/`getPinnedMessages`. Both websocket services gain `guild.MessagePinned`/`Unpinned` and `conversation.MessagePinned`/`Unpinned` listeners feeding two new `MessageStore` methods (`applyPinned`/`applyUnpinned`), mirroring the existing reaction-sync pattern exactly. The pin/unpin *action* lives in `MessageComponent` (toggle button in the hover toolbar + mobile long-press sheet), gated by the existing `Permissions.PinMessages` bit for guild channels (DMs are ungated, per spec - "any conversation member"). A new `PinnedMessagesPanelComponent`, modeled directly on the existing `ThreadPanelComponent`, is toggled from a header button in both `ChannelComponent` and `ConversationComponent`.

**Tech Stack:** Angular 21 (signals, `input()`, new `@if`/`@for` control flow), `@ngrx/signals` (`MessageStore`), Vitest (`*.spec.ts`, run via `ng test`), PrimeNG (`Button`).

## Global Constraints

- Pin endpoint: `POST https://api.venta.gg/api/v1/messaging/messaging/{messageId}/pin` - no body.
- Unpin endpoint: `DELETE https://api.venta.gg/api/v1/messaging/messaging/{messageId}/pin` - no body.
- List endpoint: `GET https://api.venta.gg/api/v1/messaging/messaging/pins?channelId={id}` or `?conversationId={id}` - returns up to 50 messages, most-recently-pinned first.
- Guild channels: pin/unpin requires `Permissions.PinMessages` (already defined, `1n << 6n`, already in `PERM_GROUPS`'s "Messages" group - no enum changes needed this plan).
- DMs: any conversation member may pin/unpin - no client-side permission gate.
- Realtime events: `guild.MessagePinned` / `guild.MessageUnpinned` (guild channels), `conversation.MessagePinned` / `conversation.MessageUnpinned` (DMs). These update `isPinned` in place; a full refetch is never required to reflect a pin/unpin from another user.
- No per-channel pin cap enforced client-side (server returns at most 50 from the list endpoint but doesn't block pinning past that - match that permissiveness, don't invent a client-side cap).
- No "X pinned a message" system message - out of scope for this pass.
- Full spec: see the "Message pinning - frontend integration guide" section of the conversation this plan originated from (not a repo file - inline in the planning session).

---

### Task 1: `MessageDto` pin fields + `MessagingService` pin/unpin/list methods

**Files:**
- Modify: `src/app/dtos/response/message.dto.ts`
- Modify: `src/app/services/messaging.service.ts`
- Create: `src/app/services/messaging.service.spec.ts`

**Interfaces:**
- Produces: `MessageDto.isPinned?: boolean`, `MessageDto.pinnedAt?: string`, `MessageDto.pinnedById?: string` - consumed by Task 2 (store), Task 3 (badge + toggle), Task 5 (panel).
- Produces: `PinMessageResponse` interface, exported from `message.dto.ts`.
- Produces: `MessagingService.pinMessage(messageId: string): Observable<PinMessageResponse>`, `unpinMessage(messageId: string): Observable<PinMessageResponse>`, `getPinnedMessages(params: {channelId?: string; conversationId?: string}): Observable<MessageDto[]>` - consumed by Task 3 (toggle) and Task 5 (panel).

- [ ] **Step 1: Add pin fields to `MessageDto` and the `PinMessageResponse` type**

In `src/app/dtos/response/message.dto.ts`, add to the `MessageDto` interface (after `systemMessageVariant?: number;`):

```ts
    isPinned?: boolean;
    pinnedAt?: string;
    pinnedById?: string;
```

At the bottom of the file, add:

```ts
export interface PinMessageResponse {
    success: boolean;
    channelId?: string;
    conversationId?: string;
    authorId?: string;
    pinnedById?: string;
    pinnedAt?: string;
}
```

- [ ] **Step 2: Write the failing service tests**

Create `src/app/services/messaging.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {MessagingService} from './messaging.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(MessagingService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('MessagingService pinning', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('pinMessage POSTs to /messaging/messaging/{messageId}/pin with no body', () => {
        const {service, ctrl} = setup();
        service.pinMessage('m1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/m1/pin`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toBeNull();
        req.flush({success: true, pinnedById: 'u1', pinnedAt: '2026-07-30T00:00:00Z'});
    });

    it('unpinMessage DELETEs /messaging/messaging/{messageId}/pin', () => {
        const {service, ctrl} = setup();
        service.unpinMessage('m1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/m1/pin`);
        expect(req.request.method).toBe('DELETE');
        req.flush({success: true});
    });

    it('getPinnedMessages GETs pins filtered by channelId', () => {
        const {service, ctrl} = setup();
        service.getPinnedMessages({channelId: 'c1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/pins?channelId=c1`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('getPinnedMessages GETs pins filtered by conversationId', () => {
        const {service, ctrl} = setup();
        service.getPinnedMessages({conversationId: 'conv1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/pins?conversationId=conv1`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx ng test --include='**/messaging.service.spec.ts'`
Expected: FAIL - `pinMessage`/`unpinMessage`/`getPinnedMessages` don't exist on `MessagingService`.

- [ ] **Step 4: Implement the service methods**

In `src/app/services/messaging.service.ts`, add the import and methods:

```ts
import {MessageDto, PinMessageResponse} from "../dtos/response/message.dto";
```

(merge into the existing `import {MessageDto} from "../dtos/response/message.dto";` line instead of duplicating it)

At the end of the class, before the closing brace:

```ts
    public pinMessage(messageId: string): Observable<PinMessageResponse> {
        return this.httpClient.post<PinMessageResponse>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/pin`, null);
    }

    public unpinMessage(messageId: string): Observable<PinMessageResponse> {
        return this.httpClient.delete<PinMessageResponse>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/pin`);
    }

    public getPinnedMessages(params: { channelId?: string; conversationId?: string }): Observable<MessageDto[]> {
        const query = params.channelId ? `channelId=${params.channelId}` : `conversationId=${params.conversationId}`;
        return this.httpClient.get<MessageDto[]>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/pins?${query}`);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx ng test --include='**/messaging.service.spec.ts'`
Expected: PASS, all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/message.dto.ts src/app/services/messaging.service.ts src/app/services/messaging.service.spec.ts
git commit -m "feat: add message pin/unpin/list-pins service methods"
```

---

### Task 2: Realtime pin/unpin events + `MessageStore` sync

**Files:**
- Modify: `src/app/services/messaging-websocket.service.ts`
- Modify: `src/app/services/guild-websocket.service.ts`
- Modify: `src/app/stores/message.store.ts`

**Interfaces:**
- Consumes: `MessageDto` pin fields from Task 1.
- Produces: `MessagePinnedEvent`/`MessageUnpinnedEvent` interfaces (exported from `messaging-websocket.service.ts`, re-used by `guild-websocket.service.ts` the same way `ReactionEvent` already is), `MessagingWebsocketService.messagePinnedObservable`/`messageUnpinnedObservable`, `GuildWebsocketService.messagePinnedObservable`/`messageUnpinnedObservable`, `MessageStore.applyPinned(event)`/`applyUnpinned(event)` - consumed by Task 5 (panel refresh) and exercised end-to-end in Task 3's manual verification.

- [ ] **Step 1: Add event interfaces + observables to `MessagingWebsocketService`**

In `src/app/services/messaging-websocket.service.ts`, add near the existing `ReactionEvent` interface:

```ts
export interface MessagePinnedEvent {
    messageId: string;
    conversationId?: string;
    channelId?: string;
    authorId: string;
    pinnedById: string;
    pinnedAt: string;
}

export interface MessageUnpinnedEvent {
    messageId: string;
    conversationId?: string;
    channelId?: string;
    authorId: string;
    unpinnedById: string;
}
```

Add to the class body, next to `reactionAddedObservable`/`reactionRemovedObservable`:

```ts
    public messagePinnedObservable = new Subject<MessagePinnedEvent>()
    public messageUnpinnedObservable = new Subject<MessageUnpinnedEvent>()
```

In `setupListeners()`, next to the existing `conversation.ReactionCreated`/`ReactionRemoved` handlers:

```ts
        this.realtime.on('conversation.MessagePinned', (data: MessagePinnedEvent) => {
            this.messagePinnedObservable.next(data);
        });

        this.realtime.on('conversation.MessageUnpinned', (data: MessageUnpinnedEvent) => {
            this.messageUnpinnedObservable.next(data);
        });
```

- [ ] **Step 2: Add the same wiring to `GuildWebsocketService`**

In `src/app/services/guild-websocket.service.ts`, add the import:

```ts
import {MessagePinnedEvent, MessageUnpinnedEvent, ReactionEvent} from "./messaging-websocket.service";
```

(merge into the existing `import {ReactionEvent} from "./messaging-websocket.service";` line)

Add to the class body, next to `reactionAddedObservable`/`reactionRemovedObservable`:

```ts
    public messagePinnedObservable = new Subject<MessagePinnedEvent>();
    public messageUnpinnedObservable = new Subject<MessageUnpinnedEvent>();
```

In `setupListeners()`, next to the existing `guild.ReactionCreated`/`ReactionRemoved` handlers:

```ts
        this.realtime.on('guild.MessagePinned', (d: MessagePinnedEvent) => this.messagePinnedObservable.next(d));
        this.realtime.on('guild.MessageUnpinned', (d: MessageUnpinnedEvent) => this.messageUnpinnedObservable.next(d));
```

- [ ] **Step 3: Add `applyPinned`/`applyUnpinned` to `MessageStore`**

In `src/app/stores/message.store.ts`, add to the import from `messaging-websocket.service`:

```ts
import {
    MessageDeletedEvent,
    MessagePinnedEvent,
    MessageUnpinnedEvent,
    MessageUpdatedEvent,
    MessagingWebsocketService,
    ReactionEvent
} from '../services/messaging-websocket.service';
```

In `withMethods`, next to `applyReactionRemoved`, add:

```ts
        applyPinned(event: MessagePinnedEvent): void {
            patchState(store, updateEntity({
                id: event.messageId,
                changes: {isPinned: true, pinnedAt: event.pinnedAt, pinnedById: event.pinnedById},
            }));
        },

        applyUnpinned(event: MessageUnpinnedEvent): void {
            patchState(store, updateEntity({
                id: event.messageId,
                changes: {isPinned: false, pinnedAt: undefined, pinnedById: undefined},
            }));
        },
```

In `withHooks({onInit})`, next to the existing reaction subscriptions:

```ts
            wsService.messagePinnedObservable.subscribe(event => store.applyPinned(event));
            wsService.messageUnpinnedObservable.subscribe(event => store.applyUnpinned(event));
            guildWsService.messagePinnedObservable.subscribe(event => store.applyPinned(event));
            guildWsService.messageUnpinnedObservable.subscribe(event => store.applyUnpinned(event));
```

- [ ] **Step 4: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully - confirms the re-exported `MessagePinnedEvent`/`MessageUnpinnedEvent` types line up between the two websocket services and the store.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/messaging-websocket.service.ts src/app/services/guild-websocket.service.ts src/app/stores/message.store.ts
git commit -m "feat: sync message pin/unpin state from realtime events"
```

---

### Task 3: Pin/unpin action on `MessageComponent` (badge + toggle + hover toolbar + mobile sheet)

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.html`

**Interfaces:**
- Consumes: `MessagingService.pinMessage`/`unpinMessage` (Task 1), `MessageStore.applyPinned`/`applyUnpinned` (Task 2).
- Produces: `MessageComponent.canPinMessages: InputSignal<boolean>` - consumed by Task 4 (`ChannelComponent` binds this).

- [ ] **Step 1: Add `canPinMessages` input and `canPin`/`togglePin` logic to `MessageComponent`**

In `src/app/features/messaging/components/conversation/message/message.component.ts`, add to the imports:

```ts
import {PinMessageResponse} from '../../../../../dtos/response/message.dto';
```

(merge into the existing `MessageAttachment, MessageDto, MessageEmbed` import line from `message.dto`)

Add the input next to `isGrouped`:

```ts
    public isGrouped = input<boolean>(false);
    public canPinMessages = input<boolean>(false);
```

Add near `isOwn`:

```ts
    readonly canPin = computed(() => !this.message().conversationId ? this.canPinMessages() : true);
```

(A DM message always has `conversationId` set and no `channelId` - see `createPlainMessage` in `conversation.component.ts`. A guild message always has `channelId` set and no `conversationId` - see `createMessage` in `channel.component.ts`. So `!conversationId` reliably means "this is a guild channel message", where the `PinMessages` permission gate applies; DMs stay ungated per spec.)

Add the toggle method near `toggleReaction`:

```ts
    togglePin(): void {
        const msg = this.message();
        if (msg.isPending || msg.isFailed) return;
        if (msg.isPinned) {
            this.messageStore.applyUnpinned({messageId: msg.id, authorId: msg.authorId, unpinnedById: this.profileService.ownProfile()?.userId ?? ''});
            this.messagingService.unpinMessage(msg.id).subscribe({
                error: () => this.messageStore.applyPinned({
                    messageId: msg.id,
                    authorId: msg.authorId,
                    pinnedById: msg.pinnedById ?? '',
                    pinnedAt: msg.pinnedAt ?? new Date().toISOString(),
                }),
            });
        } else {
            const own = this.profileService.ownProfile()?.userId ?? '';
            const optimisticAt = new Date().toISOString();
            this.messageStore.applyPinned({messageId: msg.id, authorId: msg.authorId, pinnedById: own, pinnedAt: optimisticAt});
            this.messagingService.pinMessage(msg.id).subscribe({
                next: (res: PinMessageResponse) => {
                    if (res.pinnedAt && res.pinnedById) {
                        this.messageStore.applyPinned({messageId: msg.id, authorId: msg.authorId, pinnedById: res.pinnedById, pinnedAt: res.pinnedAt});
                    }
                },
                error: () => this.messageStore.applyUnpinned({messageId: msg.id, authorId: msg.authorId, unpinnedById: own}),
            });
        }
    }
```

- [ ] **Step 2: Wire the pin badge and hover-toolbar pin button into the template**

In `src/app/features/messaging/components/conversation/message/message.component.html`, extend the header-visibility condition (currently line 43) to also force the header row for pinned messages, and add the pin badge next to the encryption indicator:

Before:
```html
        @if (!isGrouped() || message().isPending || message().isFailed || message().encryptionState === 'Encrypted') {
            <div class="flex items-center gap-2 mb-1">
```
... (unchanged content, including the `@if (message().encryptionState === 'Encrypted')` block) ...
```html
                @if (message().isFailed) {
                    <span class="text-[11px] text-rose-400 flex items-center gap-1">
          <i class="pi pi-exclamation-circle"></i> {{ message().isBotCommandPlaceholder ? "Didn't respond" : 'Failed to send' }}
        </span>
                }
            </div>
        }
```

After:
```html
        @if (!isGrouped() || message().isPending || message().isFailed || message().encryptionState === 'Encrypted' || message().isPinned) {
            <div class="flex items-center gap-2 mb-1">
```
... (unchanged content) ...
```html
                @if (message().isFailed) {
                    <span class="text-[11px] text-rose-400 flex items-center gap-1">
          <i class="pi pi-exclamation-circle"></i> {{ message().isBotCommandPlaceholder ? "Didn't respond" : 'Failed to send' }}
        </span>
                }
                @if (message().isPinned) {
                    <span class="flex items-center gap-1 text-[11px] text-white/35" title="Pinned message">
                        <i class="pi pi-thumbtack text-[10px]"></i>
                    </span>
                }
            </div>
        }
```

Wire the toolbar's new output (currently line 80-87):

Before:
```html
        @if (!message().isPending && !message().isFailed && !isEditing()) {
            <app-message-hover-toolbar
                    (delete)="confirmDelete()"
                    (edit)="startEdit()"
                    (emojiToggled)="toggleReaction($event)"
                    (reply)="reply.emit(message())"
                    [isOwn]="isOwn()"/>
        }
```

After:
```html
        @if (!message().isPending && !message().isFailed && !isEditing()) {
            <app-message-hover-toolbar
                    (delete)="confirmDelete()"
                    (edit)="startEdit()"
                    (emojiToggled)="toggleReaction($event)"
                    (pinToggled)="togglePin()"
                    (reply)="reply.emit(message())"
                    [canPin]="canPin()"
                    [isOwn]="isOwn()"
                    [isPinned]="!!message().isPinned"/>
        }
```

Add a pin/unpin entry to the mobile long-press sheet, right after the Reply button (currently line 312-317):

Before:
```html
            <button (click)="onLongPressReply()"
                    class="flex items-center gap-3 w-full px-3 py-3 rounded-xl text-white/80 hover:bg-white/[0.07]
               text-sm text-left bg-transparent border-0 cursor-pointer transition-colors">
                <i class="pi pi-reply text-base text-white/50"></i>
                Reply
            </button>

            @if (isOwn() && !message().isPending && !message().isFailed) {
```

After:
```html
            <button (click)="onLongPressReply()"
                    class="flex items-center gap-3 w-full px-3 py-3 rounded-xl text-white/80 hover:bg-white/[0.07]
               text-sm text-left bg-transparent border-0 cursor-pointer transition-colors">
                <i class="pi pi-reply text-base text-white/50"></i>
                Reply
            </button>

            @if (canPin()) {
                <button (click)="longPressMenu.set(false); togglePin()"
                        class="flex items-center gap-3 w-full px-3 py-3 rounded-xl text-white/80 hover:bg-white/[0.07]
               text-sm text-left bg-transparent border-0 cursor-pointer transition-colors">
                    <i class="pi pi-thumbtack text-base text-white/50"></i>
                    {{ message().isPinned ? 'Unpin' : 'Pin' }} Message
                </button>
            }

            @if (isOwn() && !message().isPending && !message().isFailed) {
```

- [ ] **Step 3: Add the pin button + inputs/outputs to `MessageHoverToolbarComponent`**

In `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts`:

```ts
export class MessageHoverToolbarComponent {
    isOwn = input.required<boolean>();
    canPin = input<boolean>(false);
    isPinned = input<boolean>(false);

    reply = output<void>();
    edit = output<void>();
    delete = output<void>();
    emojiToggled = output<string>();
    pinToggled = output<void>();

    readonly quickReactions = ['👍', '❤️', '😂'];
}
```

In `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.html`, add the pin button between the reply button and the `isOwn()` edit/delete block (currently lines 18-23):

Before:
```html
    <button (click)="reply.emit()"
            class="w-6 h-6 rounded flex items-center justify-center text-white/35 hover:text-white/75
           hover:bg-white/[0.07] cursor-pointer border-0 bg-transparent transition-colors"
            title="Reply">
        <i class="pi pi-reply -scale-x-100 text-[10px]"></i></button>

    @if (isOwn()) {
```

After:
```html
    <button (click)="reply.emit()"
            class="w-6 h-6 rounded flex items-center justify-center text-white/35 hover:text-white/75
           hover:bg-white/[0.07] cursor-pointer border-0 bg-transparent transition-colors"
            title="Reply">
        <i class="pi pi-reply -scale-x-100 text-[10px]"></i></button>

    @if (canPin()) {
        <button (click)="pinToggled.emit()"
                [class.text-brand-dim]="isPinned()"
                class="w-6 h-6 rounded flex items-center justify-center text-white/35 hover:text-white/75
               hover:bg-white/[0.07] cursor-pointer border-0 bg-transparent transition-colors"
                [title]="isPinned() ? 'Unpin message' : 'Pin message'">
            <i class="pi pi-thumbtack text-[10px]"></i>
        </button>
    }

    @if (isOwn()) {
```

- [ ] **Step 4: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully with no template errors.

- [ ] **Step 5: Manual verification**

Run the app (`npm start` or the project's usual `run` workflow):
1. In a DM, hover a message and click the new pin icon - the message should immediately show a small thumbtack badge next to its timestamp, with no permission check (DMs are ungated).
2. Click it again - the badge disappears.
3. On a second device/account in the same DM, confirm the pin/unpin appears live via the realtime handlers from Task 2 without a refresh.
4. In a guild channel where your account lacks `PinMessages`, confirm the pin button is absent from the hover toolbar (requires Task 4 to be wired first - if not yet done, the button will always show since `canPinMessages` defaults to `false` only for guild messages, meaning it should currently be *hidden* for all guild messages until Task 4 wires the real value; verify this default-hidden behavior for now).

- [ ] **Step 6: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/message.component.ts src/app/features/messaging/components/conversation/message/message.component.html src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.html
git commit -m "feat: add pin/unpin action and pinned badge to messages"
```

---

### Task 4: Guild permission plumbing (`ChannelComponent` → `canPinMessages`)

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: `MessageComponent.canPinMessages` input (Task 3).
- Produces: `ChannelComponent.canPinMessages: Signal<boolean>` - template-only, no other task depends on it.

- [ ] **Step 1: Compute own-member permissions in `ChannelComponent`**

In `src/app/features/guild/components/channel/channel.component.ts`, add imports:

```ts
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
```

Add fields next to `private messageStore = inject(MessageStore);`:

```ts
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    protected canPinMessages = computed(() => {
        const member = this.ownMember();
        if (!member) return false;
        const permissionString = member.roleMembers.reduce((curr, m) => {
            if (!m.role.permissions) return curr;
            return curr === '' ? m.role.permissions : `${curr},${m.role.permissions}`;
        }, member.permissions ?? '');
        const perms = parsePermissions(permissionString);
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.PinMessages);
    });
```

In the constructor, next to the existing `this.messageStore.loadForChannel(this.channel().id);` effect:

```ts
        effect(() => {
            this.guildService.getOwnMember(this.guildId()).subscribe(m => this.ownMember.set(m));
        });
```

Add the `GuildService` inject next to the existing `private messagingService = inject(MessagingService);`:

```ts
    private guildService = inject(GuildService);
```

And its import:

```ts
import {GuildService} from '../../../../services/guild.service';
```

- [ ] **Step 2: Bind `canPinMessages` on `<app-message>`**

In `src/app/features/guild/components/channel/channel.component.html`, extend the `<app-message>` binding (currently lines 211-217):

Before:
```html
                                <app-message (jumpTo)="jumpToMessage($event)"
                                             (reply)="onReply($event)"
                                             [guildBots]="botCommandService.currentGuildBots()"
                                             [guildChannels]="guildChannels()"
                                             [guildRoles]="guildRoles()"
                                             [isGrouped]="row.isGrouped"
                                             [message]="row.message"></app-message>
```

After:
```html
                                <app-message (jumpTo)="jumpToMessage($event)"
                                             (reply)="onReply($event)"
                                             [canPinMessages]="canPinMessages()"
                                             [guildBots]="botCommandService.currentGuildBots()"
                                             [guildChannels]="guildChannels()"
                                             [guildRoles]="guildRoles()"
                                             [isGrouped]="row.isGrouped"
                                             [message]="row.message"></app-message>
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Manual verification**

1. As a member with `PinMessages` granted (or a Superadmin/owner account), open a guild text channel and confirm the pin icon now appears in the hover toolbar and works (pins/unpins, badge shows).
2. As a member without `PinMessages`, confirm the pin icon is absent from the hover toolbar and the mobile long-press sheet.
3. Confirm DM pinning (Task 3's verification) is unaffected by this change.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel/channel.component.ts src/app/features/guild/components/channel/channel.component.html
git commit -m "feat: gate guild-channel message pinning behind PinMessages permission"
```

---

### Task 5: `PinnedMessagesPanelComponent`

**Files:**
- Create: `src/app/features/messaging/components/pinned-messages-panel/pinned-messages-panel.component.ts`
- Create: `src/app/features/messaging/components/pinned-messages-panel/pinned-messages-panel.component.html`

**Interfaces:**
- Consumes: `MessagingService.getPinnedMessages` (Task 1), `MessagingWebsocketService.messagePinnedObservable`/`messageUnpinnedObservable`, `GuildWebsocketService.messagePinnedObservable`/`messageUnpinnedObservable` (Task 2).
- Produces: `PinnedMessagesPanelComponent` with `channelId = input<string>()`, `conversationId = input<string>()` (exactly one is set by the caller), `messageSelected = output<string>()` (emits a message id) - consumed by Task 6 and Task 7.

- [ ] **Step 1: Implement the component**

Create `src/app/features/messaging/components/pinned-messages-panel/pinned-messages-panel.component.ts`:

```ts
import {Component, DestroyRef, effect, inject, input, output, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {Button} from 'primeng/button';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessagingService} from '../../../../services/messaging.service';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';

function decodeContent(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

@Component({
    selector: 'app-pinned-messages-panel',
    imports: [Button, DatePipe],
    templateUrl: './pinned-messages-panel.component.html',
})
export class PinnedMessagesPanelComponent {
    channelId = input<string>();
    conversationId = input<string>();
    messageSelected = output<string>();

    pins = signal<MessageDto[]>([]);
    loading = signal(true);

    private messagingService = inject(MessagingService);
    private messagingWs = inject(MessagingWebsocketService);
    private guildWs = inject(GuildWebsocketService);
    protected profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);

    constructor() {
        effect(() => {
            this.channelId();
            this.conversationId();
            this.load();
        });

        this.messagingWs.messagePinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.conversationId === this.conversationId()) this.load();
            });
        this.messagingWs.messageUnpinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.conversationId === this.conversationId()) this.load();
            });
        this.guildWs.messagePinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.channelId === this.channelId()) this.load();
            });
        this.guildWs.messageUnpinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.channelId === this.channelId()) this.load();
            });
    }

    load(): void {
        const channelId = this.channelId();
        const conversationId = this.conversationId();
        if (!channelId && !conversationId) return;
        this.loading.set(true);
        this.messagingService.getPinnedMessages({channelId, conversationId}).subscribe({
            next: pins => {
                this.pins.set(pins);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load pinned messages', err);
            },
        });
    }

    snippet(msg: MessageDto): string {
        return decodeContent(msg.content).slice(0, 120);
    }
}
```

- [ ] **Step 2: Implement the template**

Create `src/app/features/messaging/components/pinned-messages-panel/pinned-messages-panel.component.html`:

```html
<div class="flex items-center justify-between px-3 py-2 border-b border-white/[0.08]">
    <span class="text-xs font-semibold text-white/50 uppercase tracking-widest">Pinned Messages</span>
</div>

@if (loading()) {
    <p class="text-xs text-white/25 text-center py-4">Loading…</p>
} @else if (pins().length === 0) {
    <p class="text-xs text-white/25 text-center py-4">No pinned messages yet</p>
} @else {
    <div class="flex flex-col gap-1 p-1.5 overflow-y-auto">
        @for (msg of pins(); track msg.id) {
            <button (click)="messageSelected.emit(msg.id)"
                    class="flex flex-col gap-1 px-2.5 py-2 rounded-lg hover:bg-white/[0.04] text-left border-0 bg-transparent cursor-pointer">
                <div class="flex items-center gap-1.5 text-[10px] text-white/30">
                    <i class="pi pi-thumbtack text-[9px]"></i>
                    <span>Pinned {{ msg.pinnedAt | date: 'MMM d, y' }}</span>
                </div>
                <p class="text-xs text-white/65 m-0 leading-snug line-clamp-3">{{ snippet(msg) }}</p>
            </button>
        }
    </div>
}
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully (component isn't wired into any view yet, so this only confirms it compiles standalone).

- [ ] **Step 4: Commit**

```bash
git add src/app/features/messaging/components/pinned-messages-panel/
git commit -m "feat: add PinnedMessagesPanelComponent"
```

---

### Task 6: Wire the pinned panel into `ChannelComponent`

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: `PinnedMessagesPanelComponent` (Task 5).

- [ ] **Step 1: Add the toggle signal and import**

In `src/app/features/guild/components/channel/channel.component.ts`, add the import:

```ts
import {PinnedMessagesPanelComponent} from '../../../messaging/components/pinned-messages-panel/pinned-messages-panel.component';
```

Add `PinnedMessagesPanelComponent` to the `imports` array in the `@Component` decorator.

Add the signal next to `protected showThreadPanel = signal(false);`:

```ts
    protected showPinnedPanel = signal(false);
```

In the existing effect that resets panel state on channel switch (currently `this.channel().id; this.searchQuery.set(''); this.showThreadPanel.set(false);`), also reset the pinned panel:

Before:
```ts
        effect(() => {
            this.channel().id;
            this.searchQuery.set('');
            this.showThreadPanel.set(false);
        });
```

After:
```ts
        effect(() => {
            this.channel().id;
            this.searchQuery.set('');
            this.showThreadPanel.set(false);
            this.showPinnedPanel.set(false);
        });
```

- [ ] **Step 2: Add the header toggle button and render the panel**

In `src/app/features/guild/components/channel/channel.component.html`, add a pin toggle button next to the existing thread toggle (currently lines 36-39):

Before:
```html
            @if (channel().type === ChannelType.Text) {
                <p-button (onClick)="showThreadPanel.set(!showThreadPanel())" icon="pi pi-comments" [text]="true"
                          [title]="showThreadPanel() ? 'Hide threads' : 'Threads'" severity="secondary" size="small"/>
            }
            <p-button [text]="true" icon="pi pi-ellipsis-v" severity="secondary" size="small"/>
```

After:
```html
            @if (channel().type === ChannelType.Text) {
                <p-button (onClick)="showThreadPanel.set(!showThreadPanel())" icon="pi pi-comments" [text]="true"
                          [title]="showThreadPanel() ? 'Hide threads' : 'Threads'" severity="secondary" size="small"/>
            }
            <p-button (onClick)="showPinnedPanel.set(!showPinnedPanel())" [text]="true" icon="pi pi-thumbtack"
                      [title]="showPinnedPanel() ? 'Hide pinned messages' : 'Pinned messages'" severity="secondary" size="small"/>
            <p-button [text]="true" icon="pi pi-ellipsis-v" severity="secondary" size="small"/>
```

Render the panel next to the existing thread-panel render (currently the last lines of the file):

Before:
```html
    @if (showThreadPanel()) {
        <app-thread-panel (threadSelected)="navService.openChannel($event)" [parentChannelId]="channel().id"
                           class="w-64 shrink-0 border-l border-white/[0.08]"/>
    }
</div>
```

After:
```html
    @if (showThreadPanel()) {
        <app-thread-panel (threadSelected)="navService.openChannel($event)" [parentChannelId]="channel().id"
                           class="w-64 shrink-0 border-l border-white/[0.08]"/>
    }
    @if (showPinnedPanel()) {
        <app-pinned-messages-panel (messageSelected)="jumpToMessage($event)" [channelId]="channel().id"
                                    class="w-64 shrink-0 border-l border-white/[0.08]"/>
    }
</div>
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Manual verification**

1. Pin a couple of messages in a guild channel, then click the new pin icon in the header - the panel opens showing both, most-recent first.
2. Click a pinned entry - the underlying message list scrolls to and briefly highlights that message (via the existing `jumpToMessage`).
3. Unpin one from the hover toolbar - the panel updates live without re-opening it (confirms the realtime wiring from Task 2/5 works end-to-end).
4. Switch to a different channel and back - the panel closes (per the reset effect) and does not carry over pins from the previous channel.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel/channel.component.ts src/app/features/guild/components/channel/channel.component.html
git commit -m "feat: add pinned messages panel to guild channels"
```

---

### Task 7: Wire the pinned panel into `ConversationComponent` (DMs)

**Files:**
- Modify: `src/app/features/messaging/components/conversation/conversation.component.ts`
- Modify: `src/app/features/messaging/components/conversation/conversation.component.html`

**Interfaces:**
- Consumes: `PinnedMessagesPanelComponent` (Task 5).

- [ ] **Step 1: Add the toggle signal and import**

In `src/app/features/messaging/components/conversation/conversation.component.ts`, add the import:

```ts
import {PinnedMessagesPanelComponent} from '../pinned-messages-panel/pinned-messages-panel.component';
```

Add `PinnedMessagesPanelComponent` to the `imports` array in the `@Component` decorator.

Add the signal next to `protected replyingTo = signal<MessageDto | null>(null);`:

```ts
    protected showPinnedPanel = signal(false);
```

- [ ] **Step 2: Add the header toggle button and wrap the body in a flex row so the panel can sit alongside it**

In `src/app/features/messaging/components/conversation/conversation.component.html`, add a toggle button next to the existing header buttons (currently line 63):

Before:
```html
            <p-button [text]="true" icon="pi pi-ellipsis-v" severity="secondary" size="small"/>
        </div>
    </header>
```

After:
```html
            <p-button (onClick)="showPinnedPanel.set(!showPinnedPanel())" [text]="true" icon="pi pi-thumbtack"
                      [title]="showPinnedPanel() ? 'Hide pinned messages' : 'Pinned messages'" severity="secondary" size="small"/>
            <p-button [text]="true" icon="pi pi-ellipsis-v" severity="secondary" size="small"/>
        </div>
    </header>
```

The panel needs to render as a sibling *column* next to the message area (matching `ChannelComponent`'s layout), not stacked below the composer. That means wrapping everything between the header and the end of the file - the message area *and* the composer footer - in one new flex-row container, with the panel as its second child.

Change the opening of the body content (currently line 91, right after the header/call-panel block):

Before:
```html
    <div class="relative flex-1 min-h-0 flex flex-col">

    <!-- Search results panel -->
```

After:
```html
    <div class="flex-1 flex min-h-0">
    <div class="relative flex-1 min-h-0 flex flex-col">

    <!-- Search results panel -->
```

Change the very end of the file (currently the last 8 lines, the composer footer through the final closing `</div>`):

Before:
```html
    <!-- Composer -->
    <footer class="shrink-0">
        <app-composer (cancelReply)="onCancelReply()" (message)="createMessage($event)" (typing)="onTyping()"
                      [conversationMembers]="conversationMemberCandidates()"
                      [replyTo]="replyingTo()" autofocus
                      class="block"></app-composer>
    </footer>

</div>
```

After:
```html
    <!-- Composer -->
    <footer class="shrink-0">
        <app-composer (cancelReply)="onCancelReply()" (message)="createMessage($event)" (typing)="onTyping()"
                      [conversationMembers]="conversationMemberCandidates()"
                      [replyTo]="replyingTo()" autofocus
                      class="block"></app-composer>
    </footer>

    </div>
    @if (showPinnedPanel()) {
        <app-pinned-messages-panel (messageSelected)="jumpToMessage($event)" [conversationId]="conversation().id"
                                    class="w-64 shrink-0 border-l border-white/[0.08]"/>
    }
</div>
```

The net effect: the pre-existing `<div class="relative flex-1 min-h-0 flex flex-col">` (opened at old line 91) now closes right after `</footer>` - it already did, that div wrapped the search/messages/typing-indicator area only, and the composer `<footer>` was already a sibling *after* it and before the original final `</div>`. The new `<div class="flex-1 flex min-h-0">` wraps both of those siblings (the message-area div and the composer footer) so the pinned panel added after its closing tag sits beside them, not below.

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully with balanced `<div>` tags. This is the highest-risk step in this plan - if the build reports a template parse error, open the file and count `<div>`/`</div>` pairs from the root down; the new wrapper must close exactly once, immediately after `</footer>` and before the `@if (showPinnedPanel())` block.

- [ ] **Step 4: Manual verification**

1. In a DM, pin a message (Task 3's DM pin flow), open the new pinned-messages toggle in the header - panel shows it.
2. Confirm the layout: the panel renders as a right-side column next to the messages/composer, matching the guild-channel thread-panel/pinned-panel layout, not stacked below the composer.
3. Click a pinned entry - jumps to the message in the DM's message list.
4. Confirm starting a call, searching, and normal message sending in the DM still render correctly with the new wrapper div in place (regression check on the layout change).

- [ ] **Step 5: Commit**

```bash
git add src/app/features/messaging/components/conversation/conversation.component.ts src/app/features/messaging/components/conversation/conversation.component.html
git commit -m "feat: add pinned messages panel to DM conversations"
```
