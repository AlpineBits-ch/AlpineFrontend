# Guild System Messages (Join/Leave) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Discord-style `GuildMemberJoin`/`GuildMemberLeave` system messages in the channel view (REST history + realtime), and let admins pick the guild's system channel from Overview settings.

**Architecture:** Extend `MessageType`/`MessageDto` to carry the new backend fields, fix a bug where the realtime handler hardcodes every incoming message to `type: Message`, add a small dedicated `SystemMessageComponent` for rendering (kept separate from the already-large `MessageComponent`), and add a `systemChannelId` picker to guild Overview settings. Also wires up the previously-missing `guild.MemberJoined` realtime event, replacing a documented stopgap.

**Tech Stack:** Angular 21 (standalone components, signals), `@ngx-translate/core`, PrimeNG 21, vitest + Angular `TestBed`.

## Global Constraints

- `MessageType` string values are case-sensitive and must match the backend exactly: `Message`, `Invite`, `GuildMemberJoin`, `GuildMemberLeave` (plus the existing `System`).
- Never send `systemChannelId: null` to the backend — omit the field entirely when unchanged (explicit clearing isn't supported server-side yet).
- The system-channel picker only lists channels where `type === ChannelType.Text` — this codebase has no `Announcement` channel type.
- No "None"/clear option in the system-channel picker.
- System-message variant copy uses the literal placeholder token `%USER%` (not ngx-translate's own `{{ }}` interpolation syntax) so the mention can be rendered as a real clickable element rather than plain interpolated text.
- Follow existing conventions: standalone components with `imports: [...]`, `input.required<T>()` / `input<T>()` for component inputs, `inject()` for DI, flat dotted-key i18n (`SECTION.SUBSECTION.KEY`), vitest specs colocated as `*.spec.ts`.
- Run tests with `ng test` (Angular's `@angular/build:unit-test` builder, vitest-backed) after every task.

---

### Task 1: Extend `MessageType` and `MessageDto`

**Files:**
- Modify: `src/app/enums/message-type.enum.ts`
- Modify: `src/app/dtos/response/message.dto.ts`
- Test: `src/app/enums/message-type.enum.spec.ts` (new)

**Interfaces:**
- Produces: `MessageType.Invite`, `MessageType.GuildMemberJoin`, `MessageType.GuildMemberLeave` (string enum members), `MessageDto.systemMessageVariant?: number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/enums/message-type.enum.spec.ts
import {describe, expect, it} from 'vitest';
import {MessageType} from './message-type.enum';

describe('MessageType', () => {
    it('defines the backend-provided system message types', () => {
        expect(MessageType.Message).toBe('Message');
        expect(MessageType.Invite).toBe('Invite');
        expect(MessageType.GuildMemberJoin).toBe('GuildMemberJoin');
        expect(MessageType.GuildMemberLeave).toBe('GuildMemberLeave');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ng test`
Expected: FAIL — `MessageType.Invite` (and `GuildMemberJoin`/`GuildMemberLeave`) is `undefined`.

- [ ] **Step 3: Implement**

```ts
// src/app/enums/message-type.enum.ts
export enum MessageType {
    Message = 'Message',
    System = 'System',
    Invite = 'Invite',
    GuildMemberJoin = 'GuildMemberJoin',
    GuildMemberLeave = 'GuildMemberLeave',
}
```

Add the new field to `MessageDto` (right after `embedsJson?: string;` at the end of the interface in `src/app/dtos/response/message.dto.ts`):

```ts
    embedsJson?: string;
    systemMessageVariant?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/enums/message-type.enum.ts src/app/enums/message-type.enum.spec.ts src/app/dtos/response/message.dto.ts
git commit -m "feat: add Invite/GuildMemberJoin/GuildMemberLeave message types"
```

---

### Task 2: Fix `guild.MessageCreated` hardcoded type + extract a tested mapper

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts`
- Test: `src/app/services/guild-websocket.service.spec.ts` (new)

**Interfaces:**
- Consumes: `MessageType` (Task 1), `MessageDto` (Task 1), `MessageEncryptionState.Plain`, `AttachmentDto` (already imported in this file).
- Produces: exported `GuildMessageCreatedPayload` interface and exported `mapGuildMessageCreatedPayload(data: GuildMessageCreatedPayload): MessageDto` function, both from `guild-websocket.service.ts`.

The current `guild.MessageCreated` handler (lines ~367–399) builds a `MessageDto` inline and hardcodes `type: MessageType.Message` regardless of what the server actually sent — this silently mis-renders every system message that arrives live. Extracting the mapping into a pure function makes the bug fixable and testable without needing a real SignalR connection.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/services/guild-websocket.service.spec.ts
import {describe, expect, it} from 'vitest';
import {GuildMessageCreatedPayload, mapGuildMessageCreatedPayload} from './guild-websocket.service';
import {MessageType} from '../enums/message-type.enum';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';

const BASE_PAYLOAD: GuildMessageCreatedPayload = {
    messageId: 'mesg_1',
    content: 'aGVsbG8=',
    authorId: 'user_1',
    conversationId: undefined,
    channelId: 'chan_1',
    attachments: [],
    inReplyTo: undefined,
    mentions: undefined,
    embedsJson: undefined,
    type: 'Message',
    systemMessageVariant: undefined,
};

describe('mapGuildMessageCreatedPayload', () => {
    it('maps an ordinary chat message with type Message', () => {
        const result = mapGuildMessageCreatedPayload(BASE_PAYLOAD);
        expect(result.type).toBe(MessageType.Message);
        expect(result.systemMessageVariant).toBeUndefined();
        expect(result.id).toBe('mesg_1');
        expect(result.encryptionState).toBe(MessageEncryptionState.Plain);
    });

    it('preserves type and systemMessageVariant for a GuildMemberJoin system message', () => {
        const payload: GuildMessageCreatedPayload = {
            ...BASE_PAYLOAD,
            type: 'GuildMemberJoin',
            systemMessageVariant: 4,
            authorId: 'user_2',
        };
        const result = mapGuildMessageCreatedPayload(payload);
        expect(result.type).toBe(MessageType.GuildMemberJoin);
        expect(result.systemMessageVariant).toBe(4);
        expect(result.authorId).toBe('user_2');
    });

    it('defaults mentions to an empty array when the payload omits them', () => {
        const result = mapGuildMessageCreatedPayload(BASE_PAYLOAD);
        expect(result.mentions).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ng test`
Expected: FAIL — `mapGuildMessageCreatedPayload` is not exported from `guild-websocket.service.ts`.

- [ ] **Step 3: Implement**

In `src/app/services/guild-websocket.service.ts`, add near the top of the file (after the existing `Ws*` interfaces, before the `@Injectable` class):

```ts
export interface GuildMessageCreatedPayload {
    messageId: string;
    content: string;
    authorId: string;
    conversationId: string | undefined;
    channelId: string;
    attachments: AttachmentDto[];
    inReplyTo: string | undefined;
    mentions: string[] | undefined;
    embedsJson: string | undefined;
    type: string;
    systemMessageVariant: number | undefined;
}

export function mapGuildMessageCreatedPayload(data: GuildMessageCreatedPayload): MessageDto {
    return {
        id: data.messageId,
        content: data.content,
        authorId: data.authorId,
        conversationId: data.conversationId,
        channelId: data.channelId,
        createdAt: new Date(),
        updatedAt: new Date(),
        isPending: false,
        isFailed: false,
        attachments: data.attachments,
        inReplyTo: data.inReplyTo,
        mentions: data.mentions ?? [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: data.type as MessageType,
        embedsJson: data.embedsJson,
        systemMessageVariant: data.systemMessageVariant,
    };
}
```

Then replace the body of the `guild.MessageCreated` handler in `setupListeners()` to use it. Change the handler's parameter type to `GuildMessageCreatedPayload` and replace the inline object construction:

```ts
        this.realtime.on('guild.MessageCreated', async (data: GuildMessageCreatedPayload) => {
            console.log('Guild MessageCreated:', data);
            const message = mapGuildMessageCreatedPayload(data);
            this.messageObservable.next(message);

            const ownId = this.profileService.ownProfile()?.userId;
            const mentions = data.mentions ?? [];
            if (ownId && mentions.includes(ownId)) {
                let body: string;
                try {
                    const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                    body = new TextDecoder().decode(bytes);
                } catch {
                    body = data.content;
                }
                const sender = await firstValueFrom(
                    this.profileService.getByUserId(data.authorId).pipe(
                        timeout(5_000),
                        catchError(() => of(null)),
                    )
                );
                await this.notificationService.createNotification({
                    title: `${sender?.userName ?? 'Someone'} mentioned you`,
                    message: body,
                    profile: sender ?? undefined,
                    sound: NotificationSound.NewMessage,
                    category: 'mention',
                    extra: {channelId: data.channelId},
                });
            }
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild-websocket.service.ts src/app/services/guild-websocket.service.spec.ts
git commit -m "fix: stop hardcoding MessageType.Message on incoming guild.MessageCreated events"
```

---

### Task 3: Wire up `guild.MemberJoined`

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts`
- Modify: `src/app/features/guild/components/guild-member-list/guild-member-list.component.ts`

**Interfaces:**
- Produces: `WsMemberJoined { guildId: string; userId: string }`, `GuildWebsocketService.memberJoinedObservable: Subject<WsMemberJoined>`.

This event is confirmed genuinely missing (not stale) — `guild-websocket.service.ts` has no `guild.MemberJoined` registration today (only `MemberBanned`/`MemberKicked`/`MemberMuted`/`MemberUnmuted`/`MemberLeft`). It directly replaces the TODO in `guild-member-list.component.ts` for real member joins. The bot-install roster-refresh stopgap (`BotInstallDialogService.installedIntoGuild`) is left as-is, since bot installs aren't confirmed to also fire `guild.MemberJoined` (see the plan's spec doc, "Open questions").

No dedicated unit test: this is a one-line `Subject.next()` pass-through, identical in shape to the ~15 other untested `realtime.on(...)` registrations already in this file (e.g. `guild.MemberLeft`), and `GuildWebsocketService`/`GuildMemberListComponent` have no existing test harness (both require mocking a live SignalR `HubConnectionBuilder`, which no spec in this codebase currently does). Verified via `ng test` (compile correctness) and manual verification (see plan doc).

- [ ] **Step 1: Add the interface, observable, and listener registration**

In `src/app/services/guild-websocket.service.ts`, add near the other `WsMember*` interfaces:

```ts
export interface WsMemberJoined {
    guildId: string;
    userId: string;
}
```

Add the observable next to `memberLeftObservable`:

```ts
    public memberLeftObservable = new Subject<WsMemberLeft>();
    public memberJoinedObservable = new Subject<WsMemberJoined>();
```

Register the listener in `setupListeners()`, next to `guild.MemberLeft`:

```ts
        this.realtime.on('guild.MemberLeft', (d: WsMemberLeft) => this.memberLeftObservable.next(d));
        this.realtime.on('guild.MemberJoined', (d: WsMemberJoined) => this.memberJoinedObservable.next(d));
```

- [ ] **Step 2: Run `ng test` to confirm the build still compiles**

Run: `ng test`
Expected: PASS (no new tests, but confirms no compile errors from the new exports)

- [ ] **Step 3: Subscribe in `GuildMemberListComponent`**

In `src/app/features/guild/components/guild-member-list/guild-member-list.component.ts`, add `WsMemberJoined` to the existing import from `guild-websocket.service`:

```ts
import {
    GuildWebsocketService,
    WsMemberBanned,
    WsMemberJoined,
    WsMemberKicked,
    WsMemberLeft,
    WsMemberMuted,
    WsMemberUnmuted,
    WsPresenceChanged,
} from '../../../../services/guild-websocket.service';
```

In the constructor, add a new subscription right after the existing `presenceChangedObservable` subscription and before the bot-install stopgap, and update the stopgap's comment to clarify its narrower remaining scope:

```ts
        this.guildWsService.presenceChangedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsPresenceChanged) => {
                if (e.guildId !== this.guild().id) return;
                this.rows.update(list => list.map(m => m.userId === e.userId ? {...m, status: e.status} : m));
            });
        this.guildWsService.memberJoinedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberJoined) => {
                if (e.guildId !== this.guild().id) return;
                this.reset();
                this.fetchPage(this.guild().id);
            });
        // Stopgap so open member lists refresh after a bot install specifically -
        // guild.MemberJoined (subscribed above) isn't confirmed to also fire for bot
        // installs, so this stays until that's verified. See BotInstallDialogService.
        this.botInstallDialogService.installedIntoGuild.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(guildId => {
                if (guildId !== this.guild().id) return;
                this.reset();
                this.fetchPage(this.guild().id);
            });
```

- [ ] **Step 4: Run `ng test` to confirm the build still compiles**

Run: `ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild-websocket.service.ts src/app/features/guild/components/guild-member-list/guild-member-list.component.ts
git commit -m "feat: wire up guild.MemberJoined to refresh the member list on real joins"
```

---

### Task 4: `GuildDto.systemChannelId` / `UpdateGuildDto.systemChannelId`

**Files:**
- Modify: `src/app/dtos/response/guild.dto.ts`
- Modify: `src/app/services/guild.service.ts`
- Test: `src/app/services/guild.service.spec.ts`

**Interfaces:**
- Produces: `GuildDto.systemChannelId: string | null`, `UpdateGuildDto.systemChannelId?: string`.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `src/app/services/guild.service.spec.ts` (it already has a `setup()` helper and `BASE` constant at the top — reuse them):

```ts
describe('GuildService systemChannelId', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('updateGuild PATCHes systemChannelId when provided', () => {
        const {service, ctrl} = setup();
        service.updateGuild('g1', {systemChannelId: 'chan_1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({systemChannelId: 'chan_1'});
        req.flush({});
    });

    it('updateGuild omits systemChannelId when not provided, leaving it unchanged', () => {
        const {service, ctrl} = setup();
        service.updateGuild('g1', {name: 'New Name'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'New Name'});
        expect(req.request.body.systemChannelId).toBeUndefined();
        req.flush({});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ng test`
Expected: FAIL — TypeScript error, `systemChannelId` does not exist on type `UpdateGuildDto`.

- [ ] **Step 3: Implement**

In `src/app/dtos/response/guild.dto.ts`, add to `GuildDto`:

```ts
export interface GuildDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    ownerId: string;
    categories: CategoryDto[];
    channels: ChannelDto[];
    roles: RoleDto[];
    bannerUrl?: string;
    systemChannelId: string | null;
}
```

In `src/app/services/guild.service.ts`, add to `UpdateGuildDto`:

```ts
export interface UpdateGuildDto {
    name?: string;
    description?: string;
    systemChannelId?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/dtos/response/guild.dto.ts src/app/services/guild.service.ts src/app/services/guild.service.spec.ts
git commit -m "feat: add systemChannelId to GuildDto and UpdateGuildDto"
```

---

### Task 5: `SystemMessageComponent`

**Files:**
- Create: `src/app/features/messaging/components/conversation/message/system-message/system-message.component.ts`
- Create: `src/app/features/messaging/components/conversation/message/system-message/system-message.component.html`
- Create: `src/app/features/messaging/components/conversation/message/system-message/system-message.component.css`
- Test: `src/app/features/messaging/components/conversation/message/system-message/system-message.component.spec.ts`

**Interfaces:**
- Consumes: `MessageDto`, `MessageType` (Task 1); `ProfileService.resolveByUserId(userId: string): void` and `.getCachedByUserId(userId: string): ProfileDto | undefined`; `ProfileDialogService.open(userId: string): void`; `UserNameStyleDirective` (`appUserNameStyle`).
- Produces: `app-system-message` selector, input `message = input.required<MessageDto>()`; public `variantKey`, `userProfile`, `userDisplayName` computed signals and `userToken` field (all public, for testability, matching `MessageComponent`'s own convention of exposing template-facing computeds as `public`).

- [ ] **Step 1: Write the failing test**

```ts
// system-message.component.spec.ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {SystemMessageComponent} from './system-message.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../../enums/message-encryption-state.enum';

const BASE = 'https://api.test.example';
const PROFILE_URL = `${BASE}/api/v1/social/profiles/by-user/user_1`;

function baseMessage(overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content: '',
        channelId: 'chan_1',
        conversationId: undefined,
        authorId: 'user_1',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.GuildMemberJoin,
        ...overrides,
    };
}

function setup(message: MessageDto) {
    TestBed.configureTestingModule({
        imports: [SystemMessageComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    TestBed.inject(TranslateService).setTranslation('en', {
        'MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0': '%USER% joined the server',
        'MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4': 'Glad you are here, %USER%',
        'MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0': '%USER% left the server',
    });

    const fixture: ComponentFixture<SystemMessageComponent> = TestBed.createComponent(SystemMessageComponent);
    fixture.componentRef.setInput('message', message);
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance, ctrl};
}

describe('SystemMessageComponent variant selection', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('picks the GUILD_MEMBER_JOIN key at the given variant index', () => {
        const {component, ctrl} = setup(baseMessage({systemMessageVariant: 4}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4');
    });

    it('picks the GUILD_MEMBER_LEAVE key when the message type is GuildMemberLeave', () => {
        const {component, ctrl} = setup(baseMessage({type: MessageType.GuildMemberLeave, systemMessageVariant: 0}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0');
    });

    it('defaults to variant 0 when systemMessageVariant is undefined', () => {
        const {component, ctrl} = setup(baseMessage({systemMessageVariant: undefined}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0');
    });

    it('clamps an out-of-range variant back to 0', () => {
        const {component, ctrl} = setup(baseMessage({systemMessageVariant: 42}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0');
    });
});

describe('SystemMessageComponent rendering', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('renders the joining user as a mention chip inside the translated sentence', () => {
        const {fixture, ctrl} = setup(baseMessage({systemMessageVariant: 0}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        fixture.detectChanges();

        const host: HTMLElement = fixture.nativeElement;
        const chip = host.querySelector('.mention-chip')!;
        expect(chip.textContent).toBe('Ada');
        expect(host.textContent).toContain('joined the server');
        expect(host.textContent).not.toContain('%USER%');
    });

    it('falls back to the raw userId when the profile has not resolved yet', () => {
        const {fixture, ctrl} = setup(baseMessage({systemMessageVariant: 0}));
        const req = ctrl.expectOne(PROFILE_URL);
        fixture.detectChanges();

        const chip = (fixture.nativeElement as HTMLElement).querySelector('.mention-chip')!;
        expect(chip.textContent).toBe('user_1');

        req.flush({userId: 'user_1', userName: 'Ada'});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ng test`
Expected: FAIL — `Cannot find module './system-message.component'`.

- [ ] **Step 3: Implement the component**

```ts
// system-message.component.ts
import {ChangeDetectionStrategy, Component, computed, effect, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDialogService} from '../../../../../../services/profile-dialog.service';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';

const JOIN_VARIANT_KEYS = Array.from({length: 10}, (_, i) => `MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.${i}`);
const LEAVE_VARIANT_KEYS = Array.from({length: 10}, (_, i) => `MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.${i}`);

@Component({
    selector: 'app-system-message',
    imports: [TranslateModule, UserNameStyleDirective],
    templateUrl: './system-message.component.html',
    styleUrl: './system-message.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemMessageComponent {
    public message = input.required<MessageDto>();
    public readonly userToken = '%USER%';
    public profileDialogSvc = inject(ProfileDialogService);
    private profileService = inject(ProfileService);

    constructor() {
        effect(() => this.profileService.resolveByUserId(this.message().authorId));
    }

    public readonly variantKey = computed(() => {
        const msg = this.message();
        const keys = msg.type === MessageType.GuildMemberLeave ? LEAVE_VARIANT_KEYS : JOIN_VARIANT_KEYS;
        const variant = msg.systemMessageVariant ?? 0;
        const index = variant >= 0 && variant < keys.length ? variant : 0;
        return keys[index];
    });

    public readonly userProfile = computed(() => this.profileService.getCachedByUserId(this.message().authorId));

    public readonly userDisplayName = computed(() => this.userProfile()?.userName ?? this.message().authorId);

    public openProfile(): void {
        this.profileDialogSvc.open(this.message().authorId);
    }
}
```

```html
<!-- system-message.component.html -->
@let text = (variantKey() | translate);
@let parts = text.split(userToken);
<div class="flex justify-center px-4 py-1">
    <span class="text-xs text-white/40 text-center">
        {{ parts[0] }}<span (click)="openProfile()"
              [appUserNameStyle]="userProfile()"
              class="mention-chip cursor-pointer">{{ userDisplayName() }}</span>{{ parts[1] }}
    </span>
</div>
```

```css
/* system-message.component.css */
.mention-chip {
    display: inline-flex;
    align-items: center;
    background: rgba(99, 102, 241, 0.18);
    color: rgb(129, 140, 248);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    line-height: 1.5;
    vertical-align: baseline;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/system-message/
git commit -m "feat: add SystemMessageComponent for guild join/leave messages"
```

---

### Task 6: Render system messages in the channel view

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: `app-system-message` / `SystemMessageComponent` (Task 5), `MessageType.GuildMemberJoin` / `.GuildMemberLeave` (Task 1).

No new test: `ChannelComponent` has no existing spec (it depends on `NavigationService`, `BotCommandService`, `GuildWebsocketService`'s live SignalR connection, and more — building a first-ever harness for it is out of scope for a one-line template branch). Verified via `ng test` (compile correctness) and the plan doc's manual verification steps.

- [ ] **Step 1: Expose `MessageType` to the template**

In `src/app/features/guild/components/channel/channel.component.ts`, add the import for `SystemMessageComponent`:

```ts
import {SystemMessageComponent} from '../../../messaging/components/conversation/message/system-message/system-message.component';
```

Add `SystemMessageComponent` to the `@Component` `imports` array:

```ts
    imports: [
        ComposerComponent, MessageComponent, SystemMessageComponent, Button,
        DatePipe, HighlightPipe, TypingDotsComponent, ThreadPanelComponent,
    ],
```

Expose `MessageType` next to the existing `ChannelType` exposure:

```ts
    protected readonly ChannelType = ChannelType;
    protected readonly MessageType = MessageType;
```

- [ ] **Step 2: Branch the message list on `msg.type`**

In `src/app/features/guild/components/channel/channel.component.html`, replace the messages loop body:

```html
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

- [ ] **Step 3: Run `ng test` to confirm the build still compiles**

Run: `ng test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/channel/channel.component.ts src/app/features/guild/components/channel/channel.component.html
git commit -m "feat: render guild join/leave messages via SystemMessageComponent"
```

---

### Task 7: i18n content for join/leave variants

**Files:**
- Modify: `src/assets/i18n/locales/en.json`
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`
- Test: `src/app/features/messaging/components/conversation/message/system-message/system-message-locale.spec.ts` (new)

**Interfaces:**
- Consumes: the key naming scheme from Task 5 (`MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0`–`.9`, `MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0`–`.9`).

- [ ] **Step 1: Write the failing test**

This is a plain data test (no Angular/TestBed needed) that guards against a typo'd key or a missing locale breaking the feature silently:

```ts
// system-message-locale.spec.ts
import {describe, expect, it} from 'vitest';
import en from '../../../../../../../assets/i18n/locales/en.json';
import de from '../../../../../../../assets/i18n/locales/de.json';
import fr from '../../../../../../../assets/i18n/locales/fr.json';

const LOCALES: Record<string, Record<string, string>> = {en, de, fr};
const TYPES = ['GUILD_MEMBER_JOIN', 'GUILD_MEMBER_LEAVE'];

describe('system message locale keys', () => {
    for (const [localeName, locale] of Object.entries(LOCALES)) {
        for (const type of TYPES) {
            for (let i = 0; i < 10; i++) {
                const key = `MESSAGE.SYSTEM.${type}.${i}`;
                it(`${localeName} defines ${key} with a %USER% placeholder`, () => {
                    expect(locale[key]).toBeTruthy();
                    expect(locale[key]).toContain('%USER%');
                });
            }
        }
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ng test`
Expected: FAIL — all 60 assertions fail (`undefined` is falsy) since the keys don't exist yet.

- [ ] **Step 3: Add the locale keys**

In `src/assets/i18n/locales/en.json`, insert after the `"GUILD_SETTINGS.OVERVIEW.CROP_ICON"` line (keep the trailing comma on the line above):

*(this is handled together with Task 8's `SYSTEM_CHANNEL` keys at the same anchor point — see Task 8, Step 1, if doing both tasks; if doing this task alone, insert just these two keys)*

In `src/assets/i18n/locales/en.json`, insert after the `"MESSAGE.ADD_REACTION"` line:

```json
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0": "%USER% joined the server",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.1": "%USER% just showed up",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.2": "Welcome, %USER%. Say hi!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.3": "%USER% joined. Everyone, look busy!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4": "%USER% slid into the server",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.5": "%USER% arrived",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.6": "Glad you're here, %USER%",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.7": "A wild %USER% appeared",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.8": "%USER% hopped into the server",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.9": "Everyone welcome %USER%!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0": "%USER% left the server",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.1": "%USER% wandered off",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.2": "%USER% has left the building",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.3": "%USER% is gone",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.4": "%USER% slipped away",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.5": "%USER% left. We'll miss you!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.6": "%USER% has left the party",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.7": "%USER% disappeared",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.8": "%USER% said goodbye",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.9": "%USER% is no longer with us",
```

In `src/assets/i18n/locales/de.json`, insert after the `"MESSAGE.ADD_REACTION"` line:

```json
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0": "%USER% ist dem Server beigetreten",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.1": "%USER% ist gerade aufgetaucht",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.2": "Willkommen, %USER%. Sag doch Hallo!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.3": "%USER% ist beigetreten. Alle mal beschäftigt aussehen!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4": "%USER% ist in den Server gerutscht",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.5": "%USER% ist angekommen",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.6": "Schön, dass du da bist, %USER%",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.7": "Ein wildes %USER% erscheint",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.8": "%USER% ist in den Server gehüpft",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.9": "Alle begrüßen %USER%!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0": "%USER% hat den Server verlassen",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.1": "%USER% ist einfach abgehauen",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.2": "%USER% hat das Gebäude verlassen",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.3": "%USER% ist weg",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.4": "%USER% hat sich davongeschlichen",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.5": "%USER% ist gegangen. Wir werden dich vermissen!",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.6": "%USER% hat die Party verlassen",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.7": "%USER% ist verschwunden",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.8": "%USER% hat sich verabschiedet",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.9": "%USER% ist nicht mehr bei uns",
```

In `src/assets/i18n/locales/fr.json`, insert after the `"MESSAGE.ADD_REACTION"` line:

```json
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0": "%USER% a rejoint le serveur",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.1": "%USER% vient de débarquer",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.2": "Bienvenue, %USER%. Dis bonjour !",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.3": "%USER% a rejoint le serveur. Tout le monde, ayez l'air occupé !",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4": "%USER% s'est glissé dans le serveur",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.5": "%USER% est arrivé",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.6": "Content de te voir, %USER%",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.7": "Un %USER% sauvage apparaît",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.8": "%USER% a bondi dans le serveur",
  "MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.9": "Tout le monde souhaite la bienvenue à %USER% !",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0": "%USER% a quitté le serveur",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.1": "%USER% s'est éclipsé",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.2": "%USER% a quitté les lieux",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.3": "%USER% n'est plus là",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.4": "%USER% s'est esquivé",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.5": "%USER% est parti. Tu vas nous manquer !",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.6": "%USER% a quitté la fête",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.7": "%USER% a disparu",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.8": "%USER% a dit au revoir",
  "MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.9": "%USER% ne fait plus partie du serveur",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/assets/i18n/locales/en.json src/assets/i18n/locales/de.json src/assets/i18n/locales/fr.json src/app/features/messaging/components/conversation/message/system-message/system-message-locale.spec.ts
git commit -m "feat: add join/leave system message copy for en/de/fr"
```

---

### Task 8: System channel picker in Overview settings

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.html`
- Modify: `src/assets/i18n/locales/en.json`
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`
- Test: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.spec.ts` (new)

**Interfaces:**
- Consumes: `GuildDto.systemChannelId`, `UpdateGuildDto.systemChannelId` (Task 4), `ChannelType.Text` (existing).
- Produces: `OverviewSettingsComponent.systemChannelId: WritableSignal<string | null>`, `.channelOptions: Signal<{label: string; value: string}[]>`.

- [ ] **Step 1: Add the locale keys**

In `src/assets/i18n/locales/en.json`, insert after the `"GUILD_SETTINGS.OVERVIEW.CROP_ICON"` line:

```json
  "GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL": "System Messages Channel",
  "GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL_HINT": "Join and leave messages are posted here.",
```

In `src/assets/i18n/locales/de.json`, insert after the `"GUILD_SETTINGS.OVERVIEW.CROP_ICON"` line:

```json
  "GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL": "System-Nachrichten-Kanal",
  "GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL_HINT": "Beitritts- und Austrittsnachrichten werden hier gepostet.",
```

In `src/assets/i18n/locales/fr.json`, insert after the `"GUILD_SETTINGS.OVERVIEW.CROP_ICON"` line:

```json
  "GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL": "Canal des messages système",
  "GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL_HINT": "Les messages d'arrivée et de départ sont publiés ici.",
```

- [ ] **Step 2: Write the failing test**

```ts
// overview-settings.component.spec.ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OverviewSettingsComponent} from './overview-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';

const BASE = 'https://api.test.example/api/v1/guild';

function guildFixture(overrides: Partial<GuildDto> = {}): GuildDto {
    return {
        id: 'g1',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'Test Guild',
        description: '',
        ownerId: 'owner_1',
        categories: [],
        channels: [
            {
                id: 'chan_1', createdAt: new Date(), updatedAt: new Date(), name: 'general',
                description: '', type: ChannelType.Text, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 0,
                slowModeSeconds: 0, parentChannelId: undefined,
            },
            {
                id: 'chan_2', createdAt: new Date(), updatedAt: new Date(), name: 'voice',
                description: '', type: ChannelType.Voice, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 1,
                slowModeSeconds: 0, parentChannelId: undefined,
            },
        ],
        roles: [],
        systemChannelId: 'chan_1',
        ...overrides,
    };
}

function setup(guild: GuildDto) {
    TestBed.configureTestingModule({
        imports: [OverviewSettingsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<OverviewSettingsComponent> = TestBed.createComponent(OverviewSettingsComponent);
    fixture.componentRef.setInput('guild', guild);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component, ctrl};
}

describe('OverviewSettingsComponent system channel picker', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('only offers Text channels as options', () => {
        const {component} = setup(guildFixture());
        expect(component.channelOptions()).toEqual([{label: 'general', value: 'chan_1'}]);
    });

    it('initializes systemChannelId from the guild input', () => {
        const {component} = setup(guildFixture());
        expect(component.systemChannelId()).toBe('chan_1');
    });

    it('is not dirty until a field changes', () => {
        const {component} = setup(guildFixture());
        expect(component.dirty()).toBe(false);
    });

    it('marks dirty when systemChannelId changes and includes it in the save payload', () => {
        const {component, ctrl} = setup(guildFixture());
        component.systemChannelId.set('chan_3');
        component.onFieldChange();
        expect(component.dirty()).toBe(true);

        component.save();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'Test Guild', description: '', systemChannelId: 'chan_3'});
        req.flush(guildFixture({systemChannelId: 'chan_3'}));
    });

    it('omits systemChannelId from the save payload when unchanged', () => {
        const {component, ctrl} = setup(guildFixture());
        component.name.set('Renamed');
        component.onFieldChange();

        component.save();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'Renamed', description: ''});
        expect(req.request.body.systemChannelId).toBeUndefined();
        req.flush(guildFixture({name: 'Renamed'}));
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `ng test`
Expected: FAIL — `component.channelOptions` / `component.systemChannelId` are not functions (don't exist yet), and `GuildDto`'s fixture won't compile against `save()`'s current PATCH body shape once run.

- [ ] **Step 4: Implement**

In `overview-settings.component.ts`, add imports:

```ts
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {Select} from 'primeng/select';
```

Add `Select` to the `@Component` `imports` array:

```ts
    imports: [FormsModule, Button, InputText, Textarea, Dialog, Select, ImageCropperComponent, TranslateModule],
```

Add the new signal next to `description`:

```ts
    description = signal('');
    systemChannelId = signal<string | null>(null);
```

Add the `channelOptions` computed (near the top of the class body, alongside the other signals):

```ts
    channelOptions = computed(() =>
        this.guild().channels
            .filter(c => c.type === ChannelType.Text)
            .map(c => ({label: c.name, value: c.id}))
    );
```

(add `computed` to the `@angular/core` import if not already present)

Update `ngOnInit()` to initialize it:

```ts
    ngOnInit(): void {
        this.name.set(this.guild().name);
        this.description.set(this.guild().description ?? '');
        this.systemChannelId.set(this.guild().systemChannelId);
        if (this.previewObjectUrl) {
```

Update `onFieldChange()`'s dirty check:

```ts
    onFieldChange(): void {
        const g = this.guild();
        this.dirty.set(
            this.name() !== g.name
            || this.description() !== (g.description ?? '')
            || this.systemChannelId() !== g.systemChannelId
        );
    }
```

Update `save()`'s `doUpdate` to conditionally include `systemChannelId` (never sending `null`):

```ts
        const doUpdate = (g: GuildDto) => {
            const dto: UpdateGuildDto = {name: this.name(), description: this.description()};
            if (this.systemChannelId() !== g.systemChannelId && this.systemChannelId()) {
                dto.systemChannelId = this.systemChannelId()!;
            }
            this.guildService.updateGuild(g.id, dto).subscribe({
                next: updated => {
                    this.guildService.guildUpdated$.next(updated);
                    this.guildUpdated.emit(updated);
                    this.dirty.set(false);
                    this.saving.set(false);
                },
                error: () => this.saving.set(false),
            });
        };
```

In `overview-settings.component.html`, insert a new field block between the Description block and the `<!-- Save -->` comment:

```html
    <div class="border-t border-white/[0.10]"></div>

    <!-- System Channel -->
    <div>
        <label class="block text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">
            {{ 'GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL' | translate }}
        </label>
        <p-select (ngModelChange)="systemChannelId.set($event); onFieldChange()"
                  [ngModel]="systemChannelId()"
                  [options]="channelOptions()"
                  [style]="{minWidth: '220px'}"
                  optionLabel="label"
                  optionValue="value"/>
        <p class="text-[11px] text-white/25 mt-1.5">{{ 'GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL_HINT' | translate }}</p>
    </div>

```

- [ ] **Step 5: Run test to verify it passes**

Run: `ng test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/overview-settings/ src/assets/i18n/locales/en.json src/assets/i18n/locales/de.json src/assets/i18n/locales/fr.json
git commit -m "feat: add system messages channel picker to guild Overview settings"
```

---

## Manual Verification (after all tasks)

1. `ng serve`, open a guild with a system channel configured, join it from a second account, and confirm the join message renders live as a centered gray line with a clickable colored username.
2. Reload the channel (forces a REST history fetch) and confirm the same message renders identically from `GET .../channels/{id}/messages`.
3. Open guild Settings → Overview, change the System Messages Channel, save, and confirm it persists after a reload of `GET /guilds/{id}`.
4. Confirm a channel of type Voice never appears in the System Messages Channel dropdown.
