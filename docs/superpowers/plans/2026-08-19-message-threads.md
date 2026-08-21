# Threads on a message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a thread from a specific message, show a card under that message, and open the thread in a side panel beside the still-live parent channel.

**Architecture:** A `ThreadRegistryService` becomes the one place a thread channel is looked up, seeded from the guild payload and topped up by HTTP when an id is not there yet. `channel.component` is first split so its message list, composer and MLS send path live in a reusable `app-channel-conversation`, which the thread side panel then instantiates a second time. Entry points, the card and the sidebar rows all read the registry.

**Tech Stack:** Angular 21 signals, standalone components, PrimeNG, Tailwind tokens, ngx-translate, Vitest through the Angular CLI.

**Spec:** `docs/superpowers/specs/2026-08-19-message-threads-design.md`

## Global Constraints

- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports: `import {Component, inject} from '@angular/core';`
- `bun run lint` and `bun run format` are the authority. Format only the files you touched, never the bare `bun run format` script.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- No narrative comments. One line for a silent invariant, `TODO`/`FIXME` with an owner, or a short line naming a non-obvious symbol. Nothing else.
- `inject()`, never constructor parameters. `input()`/`output()`/`model()`, never decorators.
- `ChangeDetectionStrategy.OnPush` on every new component.
- Control flow blocks (`@if`, `@for`, `@switch`), not structural directives.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field in a spec. Use a getter.
- Tests: `bun run test`. Single spec: `bun run ng test --watch=false --include="**/name.spec.ts"`. Never bare `vitest`, never `npx ng`.
- Baseline is green. Do not reduce the passing count.
- Commits: conventional prefix, one line, lowercase, imperative. No body unless it carries what the diff cannot.
- Push straight to `main`. No PRs.
- i18n keys are flat and dot-separated. `src/assets/i18n/locales` is a git submodule and needs its own commit.

---

### Task 1: Wire additions and the thread registry

**Files:**

- Modify: `src/app/dtos/response/message.dto.ts`
- Modify: `src/app/dtos/response/guild.dto.ts:33-61`
- Modify: `src/app/services/guild.service.ts:767-779`
- Modify: `src/app/services/guild-websocket.service.ts` (interfaces near `:484`, subject near `:958`, handler near `:1229`)
- Create: `src/app/services/thread-registry.service.ts`
- Test: `src/app/services/thread-registry.service.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `MessageDto.threadId?: string | null`
  - `MessageFlags.HasThread` (`1 << 5`)
  - `ChannelDto.starterMessageId?: string`
  - `GuildService.createThreadFromMessage(channelId: string, messageId: string, dto: CreateThreadDto): Observable<ChannelDto>`
  - `GuildService.getChannel(channelId: string): Observable<ChannelDto>`
  - `WsMessageThreadAttached {channelId: string; guildId: string; messageId: string; threadId: string; name: string}`
  - `GuildWebsocketService.messageThreadAttachedObservable: Subject<WsMessageThreadAttached>`
  - `ThreadRegistryService.thread(threadId: string): ChannelDto | null`
  - `ThreadRegistryService.threadsFor(parentId: string): ChannelDto[]`
  - `ThreadRegistryService.ensureThread(threadId: string): void`
  - `ThreadRegistryService.ensureParent(parentId: string): void`
  - `ThreadRegistryService.upsert(channel: ChannelDto): void`
  - `ThreadRegistryService.createFromMessage(channelId: string, messageId: string, dto: CreateThreadDto): Observable<string>`

Why a registry rather than reading `guild.channels` at each call site: forum posts demonstrably arrive in the guild payload (`forum-post-rows.component.ts` reads them straight off `ws.guild.channels`, and `channel-list.component.ts:124` filters them out of the top level with `!c.parentChannelId`), but whether a text-channel thread does is unverified against a live server. The registry reads the payload first and falls back to HTTP, so the card, the panel and the sidebar all behave the same either way and only one file has to change if the payload turns out not to carry them.

- [ ] **Step 1: Add the two DTO fields**

In `src/app/dtos/response/message.dto.ts`, extend the flags const and the message interface:

```ts
/** Discord-compatible message bitfield. */
export const MessageFlags = {
  /** Bit 2: a person removed this message's previews, for everyone who can see it. */
  SuppressEmbeds: 1 << 2,
  /** Bit 5: derived server-side from threadId, so the two can never disagree. */
  HasThread: 1 << 5,
} as const;
```

and inside `MessageDto`, beside `flags`:

```ts
    /** The thread started from this message, or null. */
    threadId?: string | null;
```

In `src/app/dtos/response/guild.dto.ts`, inside the thread-only block of `ChannelDto` (after `parentChannelId`, around line 51):

```ts
    /** The message this thread was started from. Absent on forum posts and plain threads. */
    starterMessageId?: string;
```

- [ ] **Step 2: Add the two service methods**

In `src/app/services/guild.service.ts`, in the Threads block that starts at line 767:

```ts
    /** Started from a specific message. A 409 means the message already has one; the body is `{threadId}`. */
    createThreadFromMessage(channelId: string, messageId: string, dto: CreateThreadDto): Observable<ChannelDto> {
        return this.http.post<ChannelDto>(`${this.base}/channels/${channelId}/messages/${messageId}/threads`, dto);
    }

    getChannel(channelId: string): Observable<ChannelDto> {
        return this.http.get<ChannelDto>(`${this.base}/channels/${channelId}`);
    }
```

- [ ] **Step 3: Add the realtime event**

In `src/app/services/guild-websocket.service.ts`, after `WsThreadUpdated`:

```ts
/** Redraw the one message named here. Separate from ThreadCreated, which only says a thread exists. */
export interface WsMessageThreadAttached {
  channelId: string;
  guildId: string;
  messageId: string;
  threadId: string;
  name: string;
}
```

Beside `threadUpdatedObservable` (line 959):

```ts
    public messageThreadAttachedObservable = new Subject<WsMessageThreadAttached>();
```

Beside the `guild.ThreadUpdated` registration (line 1230):

```ts
this.realtime.on('guild.MessageThreadAttached', (d: WsMessageThreadAttached) =>
  this.messageThreadAttachedObservable.next(d),
);
```

- [ ] **Step 4: Write the failing registry spec**

Create `src/app/services/thread-registry.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';

import {ThreadRegistryService} from './thread-registry.service';
import {ApiConfigService} from './api-config.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';

const BASE = 'https://api.test.example';
const GUILD_BASE = `${BASE}/api/v1/guild`;

function channelFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'chan_thread',
    createdAt: new Date('2026-08-19T00:00:00Z'),
    updatedAt: new Date('2026-08-19T00:00:00Z'),
    name: 'about that message',
    description: '',
    type: ChannelType.Thread,
    guildId: 'g1',
    isAgeRestricted: false,
    isPrivate: false,
    categoryId: undefined,
    permissions: [],
    position: 0,
    slowModeSeconds: 0,
    parentChannelId: 'chan_parent',
    ...overrides,
  };
}

function setup(guildChannels: ChannelDto[] = []) {
  TestBed.resetTestingModule();
  const nav = {
    workspace: () => ({type: 'server' as const, guild: {id: 'g1', channels: guildChannels}}),
  };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
      {
        provide: GuildWebsocketService,
        useValue: {
          threadCreatedObservable: new Subject<any>(),
          threadUpdatedObservable: new Subject<any>(),
          messageThreadAttachedObservable: new Subject<any>(),
        },
      },
      {provide: NavigationService, useValue: nav},
    ],
  });
  return {
    service: TestBed.inject(ThreadRegistryService),
    http: TestBed.inject(HttpTestingController),
    ws: TestBed.inject(GuildWebsocketService) as any,
  };
}

describe('ThreadRegistryService', () => {
  it('resolves a thread already in the guild payload without a request', () => {
    const {service, http} = setup([channelFixture()]);

    expect(service.thread('chan_thread')?.name).toBe('about that message');
    service.ensureThread('chan_thread');
    http.verify();
  });

  it('fetches a thread the payload does not carry, once', () => {
    const {service, http} = setup();

    service.ensureThread('chan_thread');
    service.ensureThread('chan_thread');

    http.expectOne(`${GUILD_BASE}/channels/chan_thread`).flush(channelFixture());
    expect(service.thread('chan_thread')?.name).toBe('about that message');
    http.verify();
  });

  it('leaves a thread unresolved when the fetch 404s, and does not retry', () => {
    const {service, http} = setup();

    service.ensureThread('gone');
    http.expectOne(`${GUILD_BASE}/channels/gone`).flush(null, {status: 404, statusText: 'Not Found'});

    expect(service.thread('gone')).toBeNull();
    service.ensureThread('gone');
    http.verify();
  });

  it('folds a 409 on create into the thread id the server names', () => {
    const {service, http} = setup();
    let threadId: string | null = null;

    service.createFromMessage('chan_parent', 'mesg_1', {name: 'about'}).subscribe(id => (threadId = id));

    http
      .expectOne(`${GUILD_BASE}/channels/chan_parent/messages/mesg_1/threads`)
      .flush({threadId: 'chan_existing'}, {status: 409, statusText: 'Conflict'});

    expect(threadId).toBe('chan_existing');
  });

  it('merges payload threads with fetched ones when listing a parent', () => {
    const {service, http} = setup([channelFixture({id: 'chan_a', name: 'a'})]);

    service.ensureParent('chan_parent');
    http
      .expectOne(`${GUILD_BASE}/channels/chan_parent/threads`)
      .flush([channelFixture({id: 'chan_b', name: 'b'})]);

    expect(
      service
        .threadsFor('chan_parent')
        .map(t => t.id)
        .sort(),
    ).toEqual(['chan_a', 'chan_b']);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `bun run ng test --watch=false --include="**/thread-registry.service.spec.ts"`
Expected: FAIL, `thread-registry.service` cannot be resolved.

- [ ] **Step 6: Write the registry**

Create `src/app/services/thread-registry.service.ts`:

```ts
import {computed, inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, map, Observable, of, throwError} from 'rxjs';
import {ChannelDto} from '../dtos/response/guild.dto';
import {CreateThreadDto} from '../dtos/request/create-thread.dto';
import {GuildService} from './guild.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';

/**
 * The one place a thread channel is looked up. The guild payload carries forum posts and may or
 * may not carry text-channel threads, so anything missing is fetched once and kept here.
 */
@Injectable({providedIn: 'root'})
export class ThreadRegistryService {
  private readonly guildService = inject(GuildService);
  private readonly ws = inject(GuildWebsocketService);
  private readonly navService = inject(NavigationService);

  /** Fetched threads, by id. The guild payload is read live and never copied in here. */
  private readonly fetched = signal<Record<string, ChannelDto>>({});
  /** Ids already asked for, including ones that 404ed, so a dead pointer is not retried on every redraw. */
  private readonly asked = new Set<string>();
  private readonly askedParents = new Set<string>();

  private readonly payloadThreads = computed(() => {
    const ws = this.navService.workspace();
    if (ws.type !== 'server') return [] as ChannelDto[];
    return ws.guild.channels.filter(c => !!c.parentChannelId);
  });

  constructor() {
    this.ws.threadCreatedObservable.subscribe(e => this.ensureThread(e.channelId));
    this.ws.messageThreadAttachedObservable.subscribe(e => this.ensureThread(e.threadId));
    this.ws.threadUpdatedObservable.subscribe(e => {
      const held = this.fetched()[e.channelId];
      if (!held) return;
      // Full current state, not a patch: each present field replaces.
      this.upsert({
        ...held,
        name: e.name ?? held.name,
        isPinned: e.isPinned ?? held.isPinned,
        isLocked: e.isLocked ?? held.isLocked,
        isArchived: e.isArchived ?? held.isArchived,
        tagIds: e.tagIds ?? held.tagIds,
      });
    });
  }

  thread(threadId: string): ChannelDto | null {
    return this.payloadThreads().find(c => c.id === threadId) ?? this.fetched()[threadId] ?? null;
  }

  threadsFor(parentId: string): ChannelDto[] {
    const byId = new Map<string, ChannelDto>();
    for (const c of this.payloadThreads()) if (c.parentChannelId === parentId) byId.set(c.id, c);
    for (const c of Object.values(this.fetched())) if (c.parentChannelId === parentId) byId.set(c.id, c);
    return [...byId.values()];
  }

  ensureThread(threadId: string): void {
    if (!threadId || this.asked.has(threadId) || this.thread(threadId)) return;
    this.asked.add(threadId);
    this.guildService.getChannel(threadId).subscribe({
      next: channel => this.upsert(channel),
      // A threadId resolving to nothing is expected, not a fault: the thread was deleted, or
      // a create failed after the message had already been stamped.
      error: () => {},
    });
  }

  ensureParent(parentId: string): void {
    if (!parentId || this.askedParents.has(parentId)) return;
    this.askedParents.add(parentId);
    this.guildService.getThreads(parentId).subscribe({
      next: threads => threads.forEach(t => this.upsert(t)),
      error: () => {},
    });
  }

  upsert(channel: ChannelDto): void {
    this.asked.add(channel.id);
    this.fetched.update(map => ({...map, [channel.id]: channel}));
  }

  /** Answers the thread id either way: a 409 means someone else pressed the button first. */
  createFromMessage(channelId: string, messageId: string, dto: CreateThreadDto): Observable<string> {
    return this.guildService.createThreadFromMessage(channelId, messageId, dto).pipe(
      map(thread => {
        this.upsert(thread);
        return thread.id;
      }),
      catchError((err: HttpErrorResponse) => {
        const existing = (err.error as {threadId?: string} | null)?.threadId;
        if (err.status === 409 && existing) {
          this.ensureThread(existing);
          return of(existing);
        }
        return throwError(() => err);
      }),
    );
  }
}
```

- [ ] **Step 7: Run the spec until green**

Run: `bun run ng test --watch=false --include="**/thread-registry.service.spec.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 8: Lint, format and commit**

```bash
bun run lint
bun run prettier --write src/app/services/thread-registry.service.ts src/app/services/thread-registry.service.spec.ts src/app/services/guild.service.ts src/app/services/guild-websocket.service.ts src/app/dtos/response/message.dto.ts src/app/dtos/response/guild.dto.ts
git add src/app/services/thread-registry.service.ts src/app/services/thread-registry.service.spec.ts src/app/services/guild.service.ts src/app/services/guild-websocket.service.ts src/app/dtos/response/message.dto.ts src/app/dtos/response/guild.dto.ts
git commit -m "feat(threads): add message-thread wire shapes and a thread registry"
```

---

### Task 2: Characterization spec for channel.component

Nothing in `src/app` changes in this task. Its whole purpose is a net that catches the extraction in Task 3.

**Files:**

- Test: `src/app/features/guild/components/channel/channel.component.spec.ts` (create)

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: a spec file whose `describe` blocks Task 3 re-points at the extracted component.

- [ ] **Step 1: Write the spec against today's component**

Create `src/app/features/guild/components/channel/channel.component.spec.ts`. It drives `createMessage` directly rather than through the composer, because the composer's own behaviour is already covered by `composer.component.spec.ts` and dragging it in would make this spec about two things.

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of, Subject, throwError} from 'rxjs';

import {ChannelComponent} from './channel.component';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../../../services/api-config.service';
import {MessageStore} from '../../../../stores/message.store';
import {MessagingService} from '../../../../services/messaging.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {GuildService} from '../../../../services/guild.service';
import {MlsService} from '../../../../services/mls.service';
import {MlsSyncService} from '../../../../services/mls-sync.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

const BASE = 'https://api.test.example';

function channelFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'chan1',
    createdAt: new Date('2026-08-19T00:00:00Z'),
    updatedAt: new Date('2026-08-19T00:00:00Z'),
    name: 'general',
    description: '',
    type: ChannelType.Text,
    guildId: 'g1',
    isAgeRestricted: false,
    isPrivate: false,
    categoryId: undefined,
    permissions: [],
    position: 0,
    slowModeSeconds: 0,
    parentChannelId: undefined,
    ...overrides,
  };
}

function sendPayload(overrides: Record<string, unknown> = {}) {
  return {
    content: 'hello',
    attachments: [] as string[],
    inReplyTo: undefined,
    mentions: [] as string[],
    roleMentions: [] as string[],
    personaMentions: [] as string[],
    mentionsEveryone: false,
    mentionsHere: false,
    ...overrides,
  };
}
```

The setup helper stubs the services the component injects. Only the ones this spec asserts on are real spies; the rest answer with something inert so construction succeeds.

```ts
function storeStub() {
  return {
    entities: () => [],
    channelMeta: () => ({}),
    channelSearchEntries: () => ({}),
    loadForChannel: vi.fn(),
    addMessage: vi.fn(),
    confirmMessage: vi.fn(),
    failMessage: vi.fn(),
    removeMessage: vi.fn(),
    searchInChannel: vi.fn(),
    clearChannelSearch: vi.fn(),
  };
}

async function setup(sendResult: 'ok' | 'fail' | 'automod' = 'ok') {
  TestBed.resetTestingModule();
  const store = storeStub();
  const messaging = {
    messageSentObservable: new Subject<any>(),
    createMessageForChannel: vi.fn(() => {
      if (sendResult === 'ok') return of({id: 'mesg_real', encryptionState: 0});
      if (sendResult === 'automod') {
        return throwError(() => ({
          status: 403,
          error: {error: 'automod_blocked', reason: 'blocked_word'},
        }));
      }
      return throwError(() => ({status: 500, error: null}));
    }),
  };
  const guildWs = {
    threadCreatedObservable: new Subject<any>(),
    threadUpdatedObservable: new Subject<any>(),
    messageThreadAttachedObservable: new Subject<any>(),
    updateLastReadMessageByChannel: vi.fn(async () => {}),
  };

  await TestBed.configureTestingModule({
    imports: [ChannelComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({defaultLanguage: 'en'}),
      provideFakePlatform(),
      MessageService,
      {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
      {provide: MessageStore, useValue: store},
      {provide: MessagingService, useValue: messaging},
      {provide: GuildWebsocketService, useValue: guildWs},
      {provide: GuildService, useValue: {getOwnMember: () => of(null)}},
      {
        provide: MlsService,
        useValue: {
          getEncryptionFloor: async () => null,
          getActiveGroupId: async () => null,
          getKnownGeneration: async () => null,
          cacheMessage: async () => {},
        },
      },
      {provide: MlsSyncService, useValue: {refreshState: async () => ({encrypted: false})}},
    ],
  }).compileComponents();

  const fixture: ComponentFixture<ChannelComponent> = TestBed.createComponent(ChannelComponent);
  fixture.componentRef.setInput('channel', channelFixture());
  fixture.detectChanges();
  await fixture.whenStable();
  return {fixture, component: fixture.componentInstance, store, messaging, guildWs};
}
```

The behaviours themselves. Adjust the `MessagingService` method name in `storeStub`'s sibling to whichever one `channel.component`'s private `send` actually calls; read `channel.component.ts:724-800` and match it exactly rather than guessing.

```ts
describe('ChannelComponent send path', () => {
  it('adds an optimistic message before the request settles', async () => {
    const {component, store} = await setup();

    component.createMessage(sendPayload());

    expect(store.addMessage).toHaveBeenCalledOnce();
    const optimistic = store.addMessage.mock.calls[0][0];
    expect(optimistic.isPending).toBe(true);
    expect(optimistic.channelId).toBe('chan1');
    expect(atob(optimistic.content)).toBe('hello');
  });

  it('confirms the optimistic message with the server copy', async () => {
    const {component, store} = await setup('ok');

    component.createMessage(sendPayload());
    await Promise.resolve();
    await Promise.resolve();

    expect(store.confirmMessage).toHaveBeenCalled();
    expect(store.failMessage).not.toHaveBeenCalled();
  });

  it('marks the message failed when the send errors', async () => {
    const {component, store} = await setup('fail');

    component.createMessage(sendPayload());
    await Promise.resolve();
    await Promise.resolve();

    expect(store.failMessage).toHaveBeenCalled();
    expect(store.removeMessage).not.toHaveBeenCalled();
  });

  it('removes the message and raises the banner on an auto-mod refusal', async () => {
    const {fixture, component, store} = await setup('automod');

    component.createMessage(sendPayload());
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(store.removeMessage).toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('COMPOSER.AUTOMOD_BLOCKED_WORD');
  });
});
```

- [ ] **Step 2: Run it and make it green against the current code**

Run: `bun run ng test --watch=false --include="**/channel.component.spec.ts"`

Expected: PASS. If a test fails, the stub is wrong, not the component. Fix the stub. This spec must describe what the code does today, not what you wish it did. If a behaviour genuinely cannot be reached without dragging in half the app, drop that test and say so in the commit rather than weakening an assertion until it passes.

- [ ] **Step 3: Run the full suite and record the baseline**

Run: `bun run test`
Write the passing count down. Task 3 must not reduce it.

- [ ] **Step 4: Commit**

```bash
bun run prettier --write src/app/features/guild/components/channel/channel.component.spec.ts
git add src/app/features/guild/components/channel/channel.component.spec.ts
git commit -m "test(channel): characterize the send path before extracting it"
```

---

### Task 3: Extract app-channel-conversation

No behaviour change. The spec from Task 2 is the gate.

**Files:**

- Create: `src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.ts`
- Create: `src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.html`
- Create: `src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.css`
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`
- Modify: `src/app/features/guild/components/channel/channel-utils.ts` (add `sceneChannelIdFor`)
- Move: `src/app/features/guild/components/channel/channel.component.spec.ts` to `channel-conversation/channel-conversation.component.spec.ts`

**Interfaces:**

- Consumes: nothing from Tasks 1 and 2 beyond the spec being green.
- Produces:
  - `ChannelConversationComponent`, selector `app-channel-conversation`
  - `input.required<ChannelDto>() channel`
  - `input<'main' | 'panel'>('main') variant`
  - public `jumpToMessage(messageId: string): void`
  - public `createMessage(event): void` (kept public so the moved spec can drive it)
  - `sceneChannelIdFor(channelId: string, rows: readonly SceneRow[]): string | null` in `channel-utils.ts`

- [ ] **Step 1: Create the component shell and move the template**

Move out of `channel.component.html` into `channel-conversation.component.html`, in order, the whole block from the load-error state (`@else if (loadError(); as errCode)`) through the messages scroll container, the absolutely-positioned overlay stack, and the `<footer>` with its banners and composer. What stays behind in `channel.component.html`: the outer flex wrapper, the header, the scene header, the forum tag bar, the search results pane, the two side panels, and the dialogs.

Where the moved block used to be, `channel.component.html` now has:

```html
<app-channel-conversation #conversation [channel]="channel()" class="flex-1 min-h-0 flex flex-col" />
```

kept inside the same `@if`/`@else` that used to guard the message list, so the search pane still replaces it.

`variant` gates the channel intro block only:

```html
@if (variant() === 'main') {
<!-- Channel start; only show when all history is loaded -->
... }
```

- [ ] **Step 2: Move the members**

Move these out of `ChannelComponent` and into `ChannelConversationComponent` verbatim, changing nothing but the import paths:

`messages`, `messageRows`, `hasMore`, `loadingMore`, `loadError`, `replyingTo`, `autoModError`, `encryptionState`, `isLockedOut`, `relinkStatus`, `typingText`, `canUsePersonas`, `canRollDice`, `resolvePersonaLocally`, `sceneTurn`, `concludedScene`, `passing`, `passTurn`, `canPinMessages`, `canDeleteAnyMessage`, `threadPermissions`, `ownMember`, the `@ViewChild` scroll refs and every field under the "Scroll state" heading, `contentObserver`, `onContentLoad`, `onScroll`, `measureScroll`, `scrollToBottom`, `jumpToMessage`, `jumpToPresent`, `isViewingOlder`, `retryLoad`, `onReply`, `onCancelReply`, `onTyping`, `createMessage`, `send`, `resolveEncryptionState`, `relinkDevice`, `ngAfterViewInit`, and the constructor effects for `loadForChannel`, encryption resolution, own-member refresh, scroll reset, composer focus, and read tracking.

Keep in `ChannelComponent`: `guildId`, `guildRoles`, `guildChannels`, `hasThreads`, `hasScenes`, `canManageScenes`, `scene`, `sceneSide`, the whole forum-post block, search (`searchQuery`, `isSearchActive`, `isSearching`, `msgResults`, `attResults`, `searchEntry`, `searchSubject`, `onSearchInput`, `clearSearch`), `showThreadPanel`, `showPinnedPanel`, `showFollowDialog`, `showTagDialog`, and the effect that resets those on channel change.

Both need the scene channel. Add to `channel-utils.ts`:

```ts
/** The scene this channel is, or the scene whose companion thread it is. */
export function sceneChannelIdFor(
  channelId: string,
  rows: readonly {channelId: string; oocThreadId?: string | null}[],
): string | null {
  if (rows.some(row => row.channelId === channelId)) return channelId;
  return rows.find(row => row.oocThreadId === channelId)?.channelId ?? null;
}
```

and have both components call it instead of holding a private copy.

- [ ] **Step 3: Swap the inline scroll code for ConversationScrollService**

`ConversationScrollService` is already `@Injectable()` without `providedIn`, so it is per-component-instance. Add it to the new component's `providers` and delete the inline duplicates of `isNearBottom`, `savedScrollHeight`, `restoreScroll`, `pendingScrollToBottom`, `contentObserver` and the `SCROLL_*` constants. Read `conversation.component.ts` for how it wires `attach()`, `onConversationSwitch()` and the `afterEveryRender` block, and mirror that.

Two instances of the component means two instances of the service, which is exactly what a side panel needs. If any part of the service turns out to assume a single scroll container per page, stop and say so rather than working around it.

- [ ] **Step 4: Point the parent at the child for jump-to-message**

In `channel.component.ts`:

```ts
    private readonly conversation = viewChild.required<ChannelConversationComponent>('conversation');

    protected jumpToMessage(messageId: string): void {
        this.conversation().jumpToMessage(messageId);
    }
```

- [ ] **Step 5: Move the spec and run it**

```bash
git mv src/app/features/guild/components/channel/channel.component.spec.ts src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.spec.ts
```

Change the import and the two type references from `ChannelComponent` to `ChannelConversationComponent`. Change nothing else. The assertions must pass unaltered; if one needs rewording to pass, the extraction changed behaviour and needs fixing, not the test.

Run: `bun run ng test --watch=false --include="**/channel-conversation.component.spec.ts"`
Expected: PASS, same tests as Task 2.

- [ ] **Step 6: Build and run the whole suite**

```bash
bun run ng build --configuration development
bun run test
```

Expected: build clean, passing count at or above the Task 2 baseline.

- [ ] **Step 7: Commit**

```bash
bun run lint
bun run prettier --write "src/app/features/guild/components/channel/**"
git add src/app/features/guild/components/channel
git commit -m "refactor(channel): extract the message list and composer into app-channel-conversation"
```

---

### Task 4: i18n keys

**Files:**

- Modify: `src/assets/i18n/locales/en.json`
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`

`src/assets/i18n/locales` is a git submodule. This is a commit inside that repo, then a pointer bump in the outer one.

**Interfaces:**

- Produces: the `THREAD.*` keys every later task translates against.

- [ ] **Step 1: Add the keys to en.json**

Flat, dot-separated, placed beside the existing `FORUM.*` block:

```json
  "THREAD.CREATE": "Create Thread",
  "THREAD.GO_TO": "Go to Thread",
  "THREAD.DIALOG_TITLE": "Create Thread",
  "THREAD.NAME_LABEL": "Thread name",
  "THREAD.NAME_PLACEHOLDER": "Name this thread",
  "THREAD.FIRST_MESSAGE_PLACEHOLDER": "Say something (optional)",
  "THREAD.MESSAGE_COUNT": "{{count}} messages",
  "THREAD.MESSAGE_COUNT_ONE": "1 message",
  "THREAD.STARTED_FROM": "Started from a message in #{{channel}}",
  "THREAD.ARCHIVED_NOTICE": "This thread is archived.",
  "THREAD.PANEL_PARENT": "Back to #{{channel}}",
  "THREAD.CREATE_ERROR": "Could not create the thread",
  "MESSAGE.COPY_TEXT": "Copy Text",
```

- [ ] **Step 2: Add the same keys to de.json and fr.json**

Translate them. Do not leave English strings sitting in the other two files: a missing key falls back visibly, a wrong-language one does not.

German:

```json
  "THREAD.CREATE": "Thread erstellen",
  "THREAD.GO_TO": "Zum Thread",
  "THREAD.DIALOG_TITLE": "Thread erstellen",
  "THREAD.NAME_LABEL": "Thread-Name",
  "THREAD.NAME_PLACEHOLDER": "Diesen Thread benennen",
  "THREAD.FIRST_MESSAGE_PLACEHOLDER": "Sag etwas (optional)",
  "THREAD.MESSAGE_COUNT": "{{count}} Nachrichten",
  "THREAD.MESSAGE_COUNT_ONE": "1 Nachricht",
  "THREAD.STARTED_FROM": "Gestartet aus einer Nachricht in #{{channel}}",
  "THREAD.ARCHIVED_NOTICE": "Dieser Thread ist archiviert.",
  "THREAD.PANEL_PARENT": "Zurück zu #{{channel}}",
  "THREAD.CREATE_ERROR": "Thread konnte nicht erstellt werden",
  "MESSAGE.COPY_TEXT": "Text kopieren",
```

French:

```json
  "THREAD.CREATE": "Créer un fil",
  "THREAD.GO_TO": "Aller au fil",
  "THREAD.DIALOG_TITLE": "Créer un fil",
  "THREAD.NAME_LABEL": "Nom du fil",
  "THREAD.NAME_PLACEHOLDER": "Nommez ce fil",
  "THREAD.FIRST_MESSAGE_PLACEHOLDER": "Dites quelque chose (facultatif)",
  "THREAD.MESSAGE_COUNT": "{{count}} messages",
  "THREAD.MESSAGE_COUNT_ONE": "1 message",
  "THREAD.STARTED_FROM": "Démarré depuis un message dans #{{channel}}",
  "THREAD.ARCHIVED_NOTICE": "Ce fil est archivé.",
  "THREAD.PANEL_PARENT": "Retour à #{{channel}}",
  "THREAD.CREATE_ERROR": "Impossible de créer le fil",
  "MESSAGE.COPY_TEXT": "Copier le texte",
```

- [ ] **Step 3: Commit in the submodule, then bump the pointer**

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat: add thread strings"
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for thread strings"
```

- [ ] **Step 4: Check the key linter**

Run: `bun run ng test --watch=false --include="**/i18n-keys.spec.ts"`
Expected: PASS. That spec checks the three files agree.

---

### Task 5: The thread side panel

**Files:**

- Create: `src/app/features/guild/components/channel/thread-side-panel/thread-side-panel.component.ts`
- Create: `src/app/features/guild/components/channel/thread-side-panel/thread-side-panel.component.html`
- Modify: `src/app/features/main-page/navigation.service.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html:404-415`
- Test: `src/app/features/guild/components/channel/thread-side-panel/thread-side-panel.component.spec.ts`

**Interfaces:**

- Consumes: `ChannelConversationComponent` (Task 3), `ThreadRegistryService` (Task 1), `THREAD.*` keys (Task 4).
- Produces:
  - `NavigationService.threadPanel: Signal<ChannelDto | null>`
  - `NavigationService.openThread(thread: ChannelDto): void`
  - `NavigationService.closeThread(): void`
  - `ThreadSidePanelComponent`, selector `app-thread-side-panel`, `input.required<ChannelDto>() thread`

- [ ] **Step 1: Add the panel state to NavigationService**

Beside `eventsPanelGuildId` (line 52):

```ts
    /** The thread open beside the main view, not a view of its own. Cleared by any navigation. */
    readonly threadPanel = signal<ChannelDto | null>(null);
```

and after `openChannel` (line 217):

```ts
    openThread(thread: ChannelDto): void {
        this.threadPanel.set(thread);
        this.mobileNavOpen.set(false);
    }

    closeThread(): void {
        this.threadPanel.set(null);
    }
```

Clear it wherever the main view is set: add `this.threadPanel.set(null);` to `openChannel`, `selectDMs`, `selectServer`, and `applySnapshot`. A thread panel surviving a channel change is the bug this prevents.

- [ ] **Step 2: Write the failing panel spec**

Create `thread-side-panel.component.spec.ts`. It asserts the two things worth locking down: the starter message is fetched when the store does not hold it, and an archived thread shows its notice.

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';

import {ThreadSidePanelComponent} from './thread-side-panel.component';
import {ChannelConversationComponent} from '../channel-conversation/channel-conversation.component';
import {MessagingService} from '../../../../../services/messaging.service';
import {MessageStore} from '../../../../../stores/message.store';
import {ChannelDto, ChannelType} from '../../../../../dtos/response/guild.dto';

function threadFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'chan_thread',
    createdAt: new Date('2026-08-19T00:00:00Z'),
    updatedAt: new Date('2026-08-19T00:00:00Z'),
    name: 'about that message',
    description: '',
    type: ChannelType.Thread,
    guildId: 'g1',
    isAgeRestricted: false,
    isPrivate: false,
    categoryId: undefined,
    permissions: [],
    position: 0,
    slowModeSeconds: 0,
    parentChannelId: 'chan_parent',
    starterMessageId: 'mesg_starter',
    ...overrides,
  };
}

async function setup(thread: ChannelDto, held: unknown[] = []) {
  TestBed.resetTestingModule();
  const messaging = {getMessageById: vi.fn(() => of({id: 'mesg_starter', content: btoa('hi')}))};
  await TestBed.configureTestingModule({
    imports: [ThreadSidePanelComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({defaultLanguage: 'en'}),
      MessageService,
      {provide: MessagingService, useValue: messaging},
      {provide: MessageStore, useValue: {entities: () => held}},
    ],
  })
    .overrideComponent(ThreadSidePanelComponent, {
      remove: {imports: [ChannelConversationComponent]},
      add: {imports: []},
    })
    .compileComponents();

  const fixture: ComponentFixture<ThreadSidePanelComponent> =
    TestBed.createComponent(ThreadSidePanelComponent);
  fixture.componentRef.setInput('thread', thread);
  fixture.detectChanges();
  await fixture.whenStable();
  return {fixture, messaging};
}

describe('ThreadSidePanelComponent', () => {
  it('fetches the starter message when the store does not hold it', async () => {
    const {messaging} = await setup(threadFixture());

    expect(messaging.getMessageById).toHaveBeenCalledOnce();
  });

  it('does not fetch a starter message the store already holds', async () => {
    const {messaging} = await setup(threadFixture(), [{id: 'mesg_starter', content: btoa('hi')}]);

    expect(messaging.getMessageById).not.toHaveBeenCalled();
  });

  it('shows the archived notice on an archived thread', async () => {
    const {fixture} = await setup(threadFixture({isArchived: true}));

    expect(fixture.nativeElement.textContent).toContain('THREAD.ARCHIVED_NOTICE');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun run ng test --watch=false --include="**/thread-side-panel.component.spec.ts"`
Expected: FAIL, the component does not exist.

- [ ] **Step 4: Write the component**

```ts
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageStore} from '../../../../../stores/message.store';
import {MessagingService} from '../../../../../services/messaging.service';
import {NavigationService} from '../../../../main-page/navigation.service';
import {ChannelConversationComponent} from '../channel-conversation/channel-conversation.component';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';

@Component({
  selector: 'app-thread-side-panel',
  imports: [ChannelConversationComponent, AppAvatarComponent, TranslateModule],
  templateUrl: './thread-side-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThreadSidePanelComponent {
  readonly thread = input.required<ChannelDto>();

  protected readonly navService = inject(NavigationService);
  private readonly messageStore = inject(MessageStore);
  private readonly messaging = inject(MessagingService);

  private readonly fetchedStarter = signal<MessageDto | null>(null);

  /** The starter stays in the parent channel, so the panel draws it once at the top or opens on a reply to nothing. */
  protected readonly starter = computed(() => {
    const id = this.thread().starterMessageId;
    if (!id) return null;
    const held = this.messageStore.entities().find(m => m.id === id);
    return held ?? this.fetchedStarter();
  });

  protected readonly parentName = computed(() => {
    const ws = this.navService.workspace();
    if (ws.type !== 'server') return '';
    return ws.guild.channels.find(c => c.id === this.thread().parentChannelId)?.name ?? '';
  });

  constructor() {
    effect(() => {
      const thread = this.thread();
      const id = thread.starterMessageId;
      untracked(() => this.fetchedStarter.set(null));
      if (!id) return;
      if (untracked(() => this.messageStore.entities().some(m => m.id === id))) return;

      untracked(() => {
        this.messaging.getMessageById({channelId: thread.parentChannelId!, messageId: id}).subscribe({
          next: message => this.fetchedStarter.set(message),
          // A starter that has been deleted leaves the panel without its quote, which is survivable.
          error: () => {},
        });
      });
    });
  }
}
```

Check `MessagingService.getMessageById`'s parameter object shape at `messaging.service.ts:102` and match it exactly.

The template:

```html
<div class="flex flex-col h-full bg-app-bg overflow-hidden">
  <header class="app-header flex items-center gap-2 px-3 border-b border-white/[0.08] shrink-0">
    <i class="pi pi-comments text-text-muted text-xs shrink-0"></i>
    <div class="flex flex-col min-w-0 leading-tight">
      <span class="text-sm font-semibold text-text-primary truncate">{{ thread().name }}</span>
      <button
        (click)="navService.closeThread()"
        class="text-[0.6875rem] text-text-muted hover:text-text-secondary text-left truncate border-0 bg-transparent p-0 cursor-pointer"
      >
        {{ 'THREAD.PANEL_PARENT' | translate: {channel: parentName()} }}
      </button>
    </div>
    <button
      (click)="navService.closeThread()"
      class="ml-auto shrink-0 w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/[0.07] border-0 bg-transparent cursor-pointer"
    >
      <i class="pi pi-times text-[0.625rem]"></i>
    </button>
  </header>

  @if (starter(); as message) {
  <div class="px-3 py-2 border-b border-white/[0.06] shrink-0 bg-white/[0.02]">
    <p class="text-[0.6875rem] text-text-muted m-0 mb-1">
      {{ 'THREAD.STARTED_FROM' | translate: {channel: parentName()} }}
    </p>
    <div class="flex items-start gap-2 min-w-0">
      <app-avatar [size]="20" [userId]="message.authorId" />
      <p class="text-xs text-text-secondary m-0 line-clamp-3 min-w-0">{{ starterText() }}</p>
    </div>
  </div>
  } @if (thread().isArchived) {
  <div class="px-3 py-2 border-b border-white/[0.06] shrink-0 flex items-center gap-2">
    <i class="pi pi-inbox text-connecting text-[0.75rem]"></i>
    <span class="text-xs text-text-muted">{{ 'THREAD.ARCHIVED_NOTICE' | translate }}</span>
  </div>
  }

  <app-channel-conversation [channel]="thread()" class="flex-1 min-h-0 flex flex-col" variant="panel" />
</div>
```

`starterText()` decodes the base64 body. Reuse whatever `message.component` uses for that rather than writing a third decoder; check `helpers/message-content.helper.ts` first, and if nothing fits, add the one-liner there.

Check `<app-avatar>`'s actual input names in `components/avatar/avatar.component.ts` before wiring it. Do not inline initials.

- [ ] **Step 5: Run the spec until green**

Run: `bun run ng test --watch=false --include="**/thread-side-panel.component.spec.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 6: Mount it in channel.component**

In `channel.component.html`, beside the two existing panels at line 404:

```html
@if (navService.threadPanel(); as openThread) {
<app-thread-side-panel
  [thread]="openThread"
  [style.width.rem]="panelWidth()"
  class="shrink-0 border-l border-white/[0.08] hidden sm:flex flex-col"
/>
}
```

Make the three panels mutually exclusive: opening the thread panel closes `showThreadPanel` and `showPinnedPanel`, and each of those calls `navService.closeThread()`. Do that with an effect in `channel.component.ts` rather than by editing four click handlers:

```ts
effect(() => {
  if (this.navService.threadPanel()) {
    untracked(() => {
      this.showThreadPanel.set(false);
      this.showPinnedPanel.set(false);
    });
  }
});
```

and in the two toggle handlers, call `this.navService.closeThread()` when turning one on.

- [ ] **Step 7: Add the resize handle**

Width lives in `channel.component.ts` as a signal seeded from localStorage:

```ts
const THREAD_PANEL_WIDTH_KEY = 'alpine.threadPanel.width';
const THREAD_PANEL_MIN_REM = 20;
const THREAD_PANEL_MAX_REM = 40;
```

```ts
    protected readonly panelWidth = signal(readPanelWidth());

    protected onPanelResize(deltaPx: number): void {
        const rem = deltaPx / parseFloat(getComputedStyle(document.documentElement).fontSize);
        const next = Math.min(THREAD_PANEL_MAX_REM, Math.max(THREAD_PANEL_MIN_REM, this.panelWidth() - rem));
        this.panelWidth.set(next);
        try {
            localStorage.setItem(THREAD_PANEL_WIDTH_KEY, String(next));
        } catch {
            // A full quota must not break the panel.
        }
    }
```

```ts
function readPanelWidth(): number {
  const raw = Number(localStorage.getItem(THREAD_PANEL_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return 25;
  return Math.min(THREAD_PANEL_MAX_REM, Math.max(THREAD_PANEL_MIN_REM, raw));
}
```

The handle itself is a 4px `cursor-col-resize` div on the panel's left edge with `pointerdown`/`pointermove`/`pointerup` listeners. Below `sm` the panel is `hidden sm:flex` in the markup above and instead takes the pane; add a second block for that breakpoint that renders it `flex sm:hidden w-full` and hides the main column.

- [ ] **Step 8: Escape closes the panel**

In `thread-side-panel.component.ts`:

```ts
    @HostListener('document:keydown.escape')
    protected onEscape(): void {
        this.navService.closeThread();
    }
```

- [ ] **Step 9: Verify and commit**

```bash
bun run ng build --configuration development
bun run test
bun run lint
bun run prettier --write "src/app/features/guild/components/channel/**" src/app/features/main-page/navigation.service.ts
git add src/app/features/guild/components/channel src/app/features/main-page/navigation.service.ts
git commit -m "feat(threads): open a thread in a resizable side panel beside its channel"
```

---

### Task 6: Create a thread from the hover toolbar

**Files:**

- Create: `src/app/features/guild/components/channel/create-thread-dialog/create-thread-dialog.component.ts`
- Create: `src/app/features/guild/components/channel/create-thread-dialog/create-thread-dialog.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts:130-150`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html:160-176`
- Modify: `src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.ts` and `.html`
- Test: `src/app/features/guild/components/channel/create-thread-dialog/create-thread-dialog.component.spec.ts`

**Interfaces:**

- Consumes: `ThreadRegistryService.createFromMessage` (Task 1), `NavigationService.openThread` (Task 5), `THREAD.*` (Task 4).
- Produces:
  - `MessageHoverToolbarComponent`: `input<boolean>(false) canCreateThread`, `input<string | null>(null) threadId`, `output<void> createThread`
  - `MessageComponent`: `input<boolean>(false) canCreateThread`, `output<MessageDto> createThread`
  - `CreateThreadDialogComponent`, selector `app-create-thread-dialog`, `model<boolean> visible`, `input<MessageDto | null> starter`, `input.required<string> channelId`, `output<string> created` (the thread id)

- [ ] **Step 1: Add the toolbar button**

In `message-hover-toolbar.component.ts`:

```ts
    readonly canCreateThread = input<boolean>(false);
    readonly threadId = input<string | null>(null);

    createThread = output<void>();
```

In the template, between the reply button and the pin block:

```html
@if (canCreateThread()) {
<button
  (click)="createThread.emit()"
  class="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/[0.07] cursor-pointer border-0 bg-transparent transition-colors"
  [title]="(threadId() ? 'THREAD.GO_TO' : 'THREAD.CREATE') | translate"
>
  <i class="pi pi-comments text-[10px]"></i>
</button>
}
```

- [ ] **Step 2: Pass it through MessageComponent**

In `message.component.ts`, beside `canPinMessages`:

```ts
    public readonly canCreateThread = input<boolean>(false);
    public createThread = output<MessageDto>();
```

The button is offered only on a real, persisted message:

```ts
    /** A thread needs something the server can point at, so nothing optimistic or synthetic qualifies. */
    protected readonly canOfferThread = computed(() => {
        const message = this.message();
        if (!this.canCreateThread()) return false;
        if (message.isPending || message.isFailed || message.isEphemeral) return false;
        if (message.isBotCommandPlaceholder) return false;
        return message.type === MessageType.Message || message.type === MessageType.DiceRoll;
    });
```

Wire it in `message.component.html` on the existing `<app-message-hover-toolbar>`:

```html
[canCreateThread]="canOfferThread()" [threadId]="message().threadId ?? null"
(createThread)="createThread.emit(message())"
```

- [ ] **Step 3: Decide the gate in channel-conversation**

In `channel-conversation.component.ts`:

```ts
    /** Hidden, not disabled: a thread off an encrypted channel would be created in the clear. */
    protected readonly canCreateThreads = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return false;
        if (!guildHasFeature(ws.guild, GuildFeature.Threads)) return false;
        if (this.channel().type !== ChannelType.Text) return false;
        if (this.encryptionState() !== 'plain') return false;
        const perms = this.threadPermissions();
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.CreateThreads);
    });
```

and on `<app-message>` in its template:

```html
[canCreateThread]="canCreateThreads()" (createThread)="onCreateThread($event)"
```

`onCreateThread` opens the panel when the message already has a thread, and the dialog when it does not:

```ts
    protected onCreateThread(message: MessageDto): void {
        const existing = message.threadId;
        if (existing) {
            this.openThreadById(existing);
            return;
        }
        this.threadStarter.set(message);
        this.showCreateThread.set(true);
    }

    /** The registry resolves from the guild payload when it can, so the panel usually opens without a round trip. */
    protected openThreadById(threadId: string): void {
        const held = this.threadRegistry.thread(threadId);
        if (held) {
            this.navService.openThread(held);
            return;
        }
        this.guildService.getChannel(threadId).subscribe({
            next: thread => {
                this.threadRegistry.upsert(thread);
                this.navService.openThread(thread);
            },
            error: err => this.toastService.httpError(this.translate.instant('THREAD.CREATE_ERROR'), err),
        });
    }
```

- [ ] **Step 4: Write the failing dialog spec**

Create `create-thread-dialog.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of, throwError} from 'rxjs';

import {CreateThreadDialogComponent} from './create-thread-dialog.component';
import {ThreadRegistryService} from '../../../../../services/thread-registry.service';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';

function starterFixture(content: string): MessageDto {
  return {
    id: 'mesg_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    content: btoa(content),
    channelId: 'chan_parent',
    conversationId: undefined,
    authorId: 'u1',
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
  };
}

async function setup(result: 'ok' | '409' | 'error' = 'ok') {
  TestBed.resetTestingModule();
  const registry = {
    createFromMessage: vi.fn(() => {
      if (result === 'error') return throwError(() => ({status: 500}));
      return of(result === '409' ? 'chan_existing' : 'chan_new');
    }),
  };
  await TestBed.configureTestingModule({
    imports: [CreateThreadDialogComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({defaultLanguage: 'en'}),
      MessageService,
      {provide: ThreadRegistryService, useValue: registry},
    ],
  }).compileComponents();

  const fixture: ComponentFixture<CreateThreadDialogComponent> =
    TestBed.createComponent(CreateThreadDialogComponent);
  fixture.componentRef.setInput('channelId', 'chan_parent');
  return {fixture, component: fixture.componentInstance as any, registry};
}

describe('CreateThreadDialogComponent', () => {
  it('prefills the name from the first few words of the starter', async () => {
    const {fixture, component} = await setup();

    fixture.componentRef.setInput(
      'starter',
      starterFixture('the deployment broke again and nobody knows why'),
    );
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    expect(component.name()).toBe('the deployment broke again and');
  });

  it('leaves the name blank when the starter cannot be read', async () => {
    const {fixture, component} = await setup();
    const undecryptable = {...starterFixture(''), undecryptable: true};

    fixture.componentRef.setInput('starter', undecryptable);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    expect(component.name()).toBe('');
  });

  it('emits the existing thread id on a 409 without a toast', async () => {
    const {fixture, component, registry} = await setup('409');
    let emitted: string | null = null;
    component.created.subscribe((id: string) => (emitted = id));

    fixture.componentRef.setInput('starter', starterFixture('hello'));
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    component.submit();

    expect(registry.createFromMessage).toHaveBeenCalledOnce();
    expect(emitted).toBe('chan_existing');
  });

  it('refuses to submit an empty name', async () => {
    const {fixture, component, registry} = await setup();

    fixture.componentRef.setInput('starter', starterFixture(''));
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    component.name.set('   ');
    component.submit();

    expect(registry.createFromMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `bun run ng test --watch=false --include="**/create-thread-dialog.component.spec.ts"`
Expected: FAIL, the component does not exist.

- [ ] **Step 6: Write the dialog**

```ts
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {ThreadRegistryService} from '../../../../../services/thread-registry.service';
import {ToastService} from '../../../../../services/toast.service';

/** How much of the starter is offered as the thread's name. */
const NAME_WORDS = 5;
const NAME_MAX = 90;

@Component({
  selector: 'app-create-thread-dialog',
  imports: [Dialog, Button, InputText, FormsModule, PrimeTemplate, TranslateModule],
  templateUrl: './create-thread-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateThreadDialogComponent {
  readonly visible = model(false);
  readonly channelId = input.required<string>();
  readonly starter = input<MessageDto | null>(null);

  readonly created = output<string>();

  readonly name = signal('');
  readonly firstMessage = signal('');
  readonly submitting = signal(false);

  private readonly registry = inject(ThreadRegistryService);
  private readonly toastService = inject(ToastService);
  private readonly translate = inject(TranslateService);

  constructor() {
    effect(() => {
      if (!this.visible()) return;
      const starter = this.starter();
      untracked(() => {
        this.name.set(starter ? suggestName(starter) : '');
        this.firstMessage.set('');
      });
    });
  }

  submit(): void {
    const name = this.name().trim();
    const starter = this.starter();
    if (!name || !starter || this.submitting()) return;

    this.submitting.set(true);
    const content = this.firstMessage().trim();
    this.registry
      .createFromMessage(this.channelId(), starter.id, content ? {name, content} : {name})
      .subscribe({
        next: threadId => {
          this.submitting.set(false);
          this.visible.set(false);
          this.created.emit(threadId);
        },
        error: err => {
          this.submitting.set(false);
          this.toastService.httpError(this.translate.instant('THREAD.CREATE_ERROR'), err);
        },
      });
  }
}

/** Ciphertext this device cannot read has no words to borrow, so the field opens blank. */
function suggestName(message: MessageDto): string {
  if (message.undecryptable) return '';
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(message.content), c => c.charCodeAt(0)));
  } catch {
    return '';
  }
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, NAME_WORDS);
  return words.join(' ').slice(0, NAME_MAX);
}
```

The template is a `p-dialog` in the shape `thread-panel.component.html` already uses: header `THREAD.DIALOG_TITLE`, an `input pInputText` bound to `name` with `(keydown.enter)="submit()"`, a `textarea` bound to `firstMessage`, and a footer with a text Cancel and a primary Create carrying `[loading]="submitting()"` and `[disabled]="!name().trim()"`.

- [ ] **Step 7: Run the spec until green**

Run: `bun run ng test --watch=false --include="**/create-thread-dialog.component.spec.ts"`
Expected: PASS, 4 tests.

- [ ] **Step 8: Mount the dialog in channel-conversation**

At the end of `channel-conversation.component.html`:

```html
<app-create-thread-dialog
  (created)="openThreadById($event)"
  [(visible)]="showCreateThread"
  [channelId]="channel().id"
  [starter]="threadStarter()"
/>
```

- [ ] **Step 9: Verify and commit**

```bash
bun run ng build --configuration development
bun run test
bun run lint
bun run prettier --write "src/app/features/guild/components/channel/**" "src/app/features/messaging/components/conversation/message/**"
git add src/app/features/guild/components/channel src/app/features/messaging/components/conversation/message
git commit -m "feat(threads): start a thread from a message in the hover toolbar"
```

---

### Task 7: Right-click context menu on a message

**Files:**

- Create: `src/app/features/messaging/components/conversation/message/context-menu/message-context-menu.component.ts`
- Create: `src/app/features/messaging/components/conversation/message/context-menu/message-context-menu.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`
- Test: `src/app/features/messaging/components/conversation/message/context-menu/message-context-menu.component.spec.ts`

**Interfaces:**

- Consumes: `MessageComponent`'s existing handlers (`reply`, `startEdit`, `confirmDelete`, `togglePin`, `reportMessage`) and `canOfferThread` from Task 6.
- Produces: `MessageContextMenuComponent`, selector `app-message-context-menu`, with `open(event: MouseEvent, items: MenuItem[]): void`.

The component is a thin wrapper over PrimeNG `ContextMenu` so `message.component` does not gain a `@ViewChild` plus template ref plus model-building all at once. The pattern to copy is `guild-member-list.component.ts:375-380`.

- [ ] **Step 1: Write the failing spec**

The menu's only real logic is which items it offers, so the spec tests the item builder as a plain function.

Create `message-context-menu.component.spec.ts`:

```ts
import {buildMessageMenuItems, MessageMenuAbilities} from './message-context-menu.component';

function abilities(overrides: Partial<MessageMenuAbilities> = {}): MessageMenuAbilities {
  return {
    isOwn: false,
    canPin: false,
    isPinned: false,
    canCreateThread: false,
    threadId: null,
    label: (key: string) => key,
    onReply: () => {},
    onCreateThread: () => {},
    onCopyText: () => {},
    onTogglePin: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onReport: () => {},
    ...overrides,
  };
}

describe('buildMessageMenuItems', () => {
  it('offers Create Thread when the caller may start one', () => {
    const labels = buildMessageMenuItems(abilities({canCreateThread: true})).map(i => i.label);

    expect(labels).toContain('THREAD.CREATE');
  });

  it('offers Go to Thread instead once the message has one', () => {
    const labels = buildMessageMenuItems(abilities({canCreateThread: true, threadId: 'chan_t'})).map(
      i => i.label,
    );

    expect(labels).toContain('THREAD.GO_TO');
    expect(labels).not.toContain('THREAD.CREATE');
  });

  it('offers Go to Thread even when the caller may not create one', () => {
    const labels = buildMessageMenuItems(abilities({threadId: 'chan_t'})).map(i => i.label);

    expect(labels).toContain('THREAD.GO_TO');
  });

  it('never offers edit or delete on someone else s message', () => {
    const labels = buildMessageMenuItems(abilities({isOwn: false})).map(i => i.label);

    expect(labels).not.toContain('COMMON.EDIT');
    expect(labels).not.toContain('COMMON.DELETE');
  });

  it('never offers report on your own message', () => {
    const labels = buildMessageMenuItems(abilities({isOwn: true})).map(i => i.label);

    expect(labels).not.toContain('REPORT.TITLE_MESSAGE');
  });
});
```

Check `COMMON.EDIT`, `COMMON.DELETE` and `MESSAGE.COPY_TEXT` exist in `en.json` before using them; add any that do not to Task 4's key list and to all three locale files.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run ng test --watch=false --include="**/message-context-menu.component.spec.ts"`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the component and the builder**

```ts
import {ChangeDetectionStrategy, Component, viewChild} from '@angular/core';
import {MenuItem} from 'primeng/api';
import {ContextMenu} from 'primeng/contextmenu';

export interface MessageMenuAbilities {
  isOwn: boolean;
  canPin: boolean;
  isPinned: boolean;
  canCreateThread: boolean;
  threadId: string | null;
  label: (key: string) => string;
  onReply: () => void;
  onCreateThread: () => void;
  onCopyText: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReport: () => void;
}

/** A message already carrying a thread offers the way in even to someone who could not have started it. */
export function buildMessageMenuItems(a: MessageMenuAbilities): MenuItem[] {
  const items: MenuItem[] = [{label: a.label('MESSAGE.REPLY'), icon: 'pi pi-reply', command: a.onReply}];

  if (a.threadId) {
    items.push({label: a.label('THREAD.GO_TO'), icon: 'pi pi-comments', command: a.onCreateThread});
  } else if (a.canCreateThread) {
    items.push({label: a.label('THREAD.CREATE'), icon: 'pi pi-comments', command: a.onCreateThread});
  }

  items.push({label: a.label('MESSAGE.COPY_TEXT'), icon: 'pi pi-copy', command: a.onCopyText});

  if (a.canPin) {
    items.push({
      label: a.label(a.isPinned ? 'MESSAGE.UNPIN' : 'MESSAGE.PIN'),
      icon: 'pi pi-thumbtack',
      command: a.onTogglePin,
    });
  }

  if (a.isOwn) {
    items.push({separator: true});
    items.push({label: a.label('COMMON.EDIT'), icon: 'pi pi-pencil', command: a.onEdit});
    items.push({label: a.label('COMMON.DELETE'), icon: 'pi pi-trash', command: a.onDelete});
  } else {
    items.push({separator: true});
    items.push({label: a.label('REPORT.TITLE_MESSAGE'), icon: 'pi pi-flag', command: a.onReport});
  }

  return items;
}

@Component({
  selector: 'app-message-context-menu',
  imports: [ContextMenu],
  templateUrl: './message-context-menu.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageContextMenuComponent {
  private readonly menu = viewChild.required<ContextMenu>('menu');

  open(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault();
    this.menu().model = items;
    this.menu().show(event);
  }
}
```

Template: `<p-contextmenu #menu [model]="[]" appendTo="body" />`.

Check the PrimeNG import path for `ContextMenu` against how `guild-member-list.component.ts` imports it; PrimeNG 17+ and 19 differ here and the member list is the version that works in this repo.

- [ ] **Step 4: Run the spec until green**

Run: `bun run ng test --watch=false --include="**/message-context-menu.component.spec.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into MessageComponent**

Add the menu to `message.component.ts` imports, a `viewChild.required<MessageContextMenuComponent>('contextMenu')`, and:

```ts
    protected onContextMenu(event: MouseEvent): void {
        this.contextMenu().open(
            event,
            buildMessageMenuItems({
                isOwn: this.isOwn(),
                canPin: this.canPin(),
                isPinned: !!this.message().isPinned,
                canCreateThread: this.canOfferThread(),
                threadId: this.message().threadId ?? null,
                label: key => this.translate.instant(key),
                onReply: () => this.reply.emit(this.message()),
                onCreateThread: () => this.createThread.emit(this.message()),
                onCopyText: () => void navigator.clipboard.writeText(this.plainText()),
                onTogglePin: () => this.togglePin(),
                onEdit: () => this.startEdit(),
                onDelete: () => this.confirmDelete(),
                onReport: () => this.reportMessage(),
            }),
        );
    }
```

`plainText()` is the decoded body; reuse whatever the component already decodes for rendering rather than adding a second decoder.

In `message.component.html`, put `(contextmenu)="onContextMenu($event)"` on the message row's outermost element and add `<app-message-context-menu #contextMenu />` at the end of the template.

- [ ] **Step 6: Verify and commit**

```bash
bun run ng build --configuration development
bun run test
bun run lint
bun run prettier --write "src/app/features/messaging/components/conversation/message/**"
git add src/app/features/messaging/components/conversation/message
git commit -m "feat(messages): add a right-click context menu with create thread"
```

---

### Task 8: The thread card under the message

**Files:**

- Create: `src/app/features/messaging/components/conversation/message/thread-card/message-thread-card.component.ts`
- Create: `src/app/features/messaging/components/conversation/message/thread-card/message-thread-card.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html:455` (immediately before the reaction bar)
- Modify: `src/app/stores/message.store.ts`
- Test: `src/app/features/messaging/components/conversation/message/thread-card/message-thread-card.component.spec.ts`

**Interfaces:**

- Consumes: `ThreadRegistryService` (Task 1), `NavigationService.openThread` (Task 5).
- Produces: `MessageThreadCardComponent`, selector `app-message-thread-card`, `input.required<string>() threadId`.

- [ ] **Step 1: Write the failing card spec**

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';

import {MessageThreadCardComponent} from './message-thread-card.component';
import {ThreadRegistryService} from '../../../../../../services/thread-registry.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';

function threadFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'chan_thread',
    createdAt: new Date('2026-08-19T00:00:00Z'),
    updatedAt: new Date('2026-08-19T00:00:00Z'),
    name: 'about that message',
    description: '',
    type: ChannelType.Thread,
    guildId: 'g1',
    isAgeRestricted: false,
    isPrivate: false,
    categoryId: undefined,
    permissions: [],
    position: 0,
    slowModeSeconds: 0,
    parentChannelId: 'chan_parent',
    messageCount: 3,
    ...overrides,
  };
}

async function setup(thread: ChannelDto | null) {
  TestBed.resetTestingModule();
  const registry = {thread: vi.fn(() => thread), ensureThread: vi.fn()};
  const nav = {openThread: vi.fn()};
  await TestBed.configureTestingModule({
    imports: [MessageThreadCardComponent],
    providers: [
      provideTranslateService({defaultLanguage: 'en'}),
      {provide: ThreadRegistryService, useValue: registry},
      {provide: NavigationService, useValue: nav},
    ],
  }).compileComponents();

  const fixture: ComponentFixture<MessageThreadCardComponent> =
    TestBed.createComponent(MessageThreadCardComponent);
  fixture.componentRef.setInput('threadId', 'chan_thread');
  fixture.detectChanges();
  return {fixture, registry, nav};
}

describe('MessageThreadCardComponent', () => {
  it('renders the thread name and count when the registry resolves it', async () => {
    const {fixture} = await setup(threadFixture());

    expect(fixture.nativeElement.textContent).toContain('about that message');
  });

  it('renders nothing for a threadId that resolves to nothing', async () => {
    const {fixture} = await setup(null);

    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('asks the registry to resolve an id it does not hold', async () => {
    const {registry} = await setup(null);

    expect(registry.ensureThread).toHaveBeenCalledWith('chan_thread');
  });

  it('opens the panel when clicked', async () => {
    const {fixture, nav} = await setup(threadFixture());

    fixture.nativeElement.querySelector('button').click();

    expect(nav.openThread).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run ng test --watch=false --include="**/message-thread-card.component.spec.ts"`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the card**

```ts
import {ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ThreadRegistryService} from '../../../../../../services/thread-registry.service';
import {NavigationService} from '../../../../../main-page/navigation.service';

@Component({
  selector: 'app-message-thread-card',
  imports: [TranslateModule],
  templateUrl: './message-thread-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageThreadCardComponent {
  readonly threadId = input.required<string>();

  private readonly registry = inject(ThreadRegistryService);
  private readonly navService = inject(NavigationService);

  protected readonly thread = computed(() => this.registry.thread(this.threadId()));

  protected readonly messageCount = computed(() => this.thread()?.messageCount ?? 0);

  /** A thread that has never been posted in has no lastActivityAt; createdAt is what it was born with. */
  protected readonly lastActivity = computed(() => {
    const thread = this.thread();
    if (!thread) return null;
    const raw = thread.lastActivityAt ?? thread.createdAt;
    const time = new Date(raw).getTime();
    return Number.isNaN(time) ? null : time;
  });

  constructor() {
    effect(() => {
      const id = this.threadId();
      untracked(() => this.registry.ensureThread(id));
    });
  }

  protected open(): void {
    const thread = this.thread();
    if (thread) this.navService.openThread(thread);
  }
}
```

Template, with the elbow connector drawn as a border rather than an SVG so it inherits the theme token:

```html
@if (thread(); as openThread) {
<div class="flex items-stretch gap-0 mt-1 ml-[1.375rem]">
  <div class="w-5 shrink-0 border-l-2 border-b-2 border-white/[0.10] rounded-bl-lg -mt-1 mb-3"></div>
  <button
    (click)="open()"
    class="group flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] cursor-pointer transition-colors text-left"
  >
    <i class="pi pi-comments text-brand-dim text-[0.6875rem] shrink-0"></i>
    <span class="text-[0.8125rem] font-semibold text-brand-dim truncate">{{ openThread.name }}</span>
    <span class="text-[0.6875rem] text-text-muted shrink-0">
      {{ (messageCount() === 1 ? 'THREAD.MESSAGE_COUNT_ONE' : 'THREAD.MESSAGE_COUNT') | translate: {count:
      messageCount()} }}
    </span>
    <i
      class="pi pi-chevron-right text-text-muted text-[0.5625rem] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
    ></i>
  </button>
</div>
}
```

Check `text-brand-dim` exists in the theme tokens; `message-hover-toolbar.component.html` already uses it, so it does.

The relative time goes beside the count using whichever relative-time pipe the repo already has. Search for one before adding anything; if none exists, drop the stamp rather than introducing a date library.

- [ ] **Step 4: Run the spec until green**

Run: `bun run ng test --watch=false --include="**/message-thread-card.component.spec.ts"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Render it in the message**

In `message.component.html`, immediately before the reaction bar block at line 455:

```html
@if (message().threadId; as threadId) {
<app-message-thread-card [threadId]="threadId" />
}
```

- [ ] **Step 6: Patch the message on MessageThreadAttached**

The store is what the message list reads, so the event lands there rather than in a component. In `message.store.ts`, add:

```ts
    /** Only the named message changes. The event exists because a client showing the parent has to redraw one row. */
    attachThread(messageId: string, threadId: string): void {
        this.updateMessage(messageId, message => ({
            ...message,
            threadId,
            flags: (message.flags ?? 0) | MessageFlags.HasThread,
        }));
    }
```

matching whatever the store's existing update helper is actually called; read `message.store.ts` and use it rather than adding a second one.

Subscribe in `channel-conversation.component.ts`:

```ts
this.guildWs.messageThreadAttachedObservable.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(e => {
  if (e.channelId !== untracked(() => this.channel().id)) return;
  this.messageStore.attachThread(e.messageId, e.threadId);
});
```

- [ ] **Step 7: Add a store spec for the patch**

In `src/app/stores/message-store-update.spec.ts`, add:

```ts
it('attaches a thread to exactly the message named', () => {
  const store = setupStore([messageFixture({id: 'm1'}), messageFixture({id: 'm2'})]);

  store.attachThread('m1', 'chan_t');

  expect(store.entities().find(m => m.id === 'm1')?.threadId).toBe('chan_t');
  expect(store.entities().find(m => m.id === 'm2')?.threadId).toBeUndefined();
});
```

matching that file's existing setup helper name and fixture rather than inventing new ones.

- [ ] **Step 8: Verify and commit**

```bash
bun run ng build --configuration development
bun run test
bun run lint
bun run prettier --write "src/app/features/messaging/components/conversation/message/**" src/app/stores/message.store.ts src/app/stores/message-store-update.spec.ts
git add src/app/features/messaging/components/conversation/message src/app/stores src/app/features/guild/components/channel
git commit -m "feat(threads): show a thread card under the starter message"
```

---

### Task 9: Nested thread rows in the sidebar

**Files:**

- Rename: `src/app/features/guild/components/channel-list/components/forum-post-rows/forum-post-rows.util.ts` to `nested-thread-rows.util.ts`
- Rename: `.../forum-post-rows.util.spec.ts` to `nested-thread-rows.util.spec.ts`
- Rename: `src/app/services/forum-visited-posts.service.ts` to `visited-threads.service.ts`
- Create: `src/app/features/guild/components/channel-list/components/thread-rows/thread-rows.component.ts`
- Create: `src/app/features/guild/components/channel-list/components/thread-rows/thread-rows.component.html`
- Modify: `src/app/features/guild/components/channel-list/components/channel-list-items/channel-list-items.component.html:27`
- Modify: `src/app/features/guild/components/channel-list/components/channel-list-items/channel-list-items.component.ts`
- Modify: `src/app/features/main-page/navigation.service.ts` (record a panel open as a visit)
- Modify: `src/app/features/guild/components/channel-list/components/forum-post-rows/forum-post-rows.component.ts` (follow the renames)

**Interfaces:**

- Consumes: `ThreadRegistryService` (Task 1), `NavigationService.openThread` (Task 5).
- Produces:
  - `selectNestedThreads(parentId: string, allThreads: readonly ChannelDto[], visitedIds: readonly string[], readStateOf: (id: string) => ChannelReadState): ChannelDto[]`
  - `VisitedThreadsService.threadsFor(parentId: string): readonly string[]`
  - `VisitedThreadsService.record(parentId: string, threadId: string): void` (now public)
  - `ThreadRowsComponent`, selector `app-thread-rows`, `input.required<ChannelDto>() parent`

A discovery worth knowing before you start: `ForumVisitedPostsService` records a visit by watching `mainView` for a channel whose parent is a forum. A thread opened in the side panel never changes `mainView`, so that effect will never fire for it. Making `record` public and calling it from `openThread` is the whole fix, and without it the nested rows only ever show unread threads.

- [ ] **Step 1: Rename the util and its spec, keeping behaviour identical**

```bash
git mv src/app/features/guild/components/channel-list/components/forum-post-rows/forum-post-rows.util.ts src/app/features/guild/components/channel-list/components/forum-post-rows/nested-thread-rows.util.ts
git mv src/app/features/guild/components/channel-list/components/forum-post-rows/forum-post-rows.util.spec.ts src/app/features/guild/components/channel-list/components/forum-post-rows/nested-thread-rows.util.spec.ts
```

Rename `selectNestedPosts` to `selectNestedThreads`, `MAX_NESTED_POST_ROWS` to `MAX_NESTED_THREAD_ROWS`, and the `forumId`/`post` parameter names to `parentId`/`thread`. Change no logic. Update the two importers.

- [ ] **Step 2: Run the renamed spec unchanged**

Run: `bun run ng test --watch=false --include="**/nested-thread-rows.util.spec.ts"`
Expected: PASS, exactly the tests that were there before.

- [ ] **Step 3: Add the failing test for a Text parent**

In `nested-thread-rows.util.spec.ts`:

```ts
it('nests threads under a text channel the same way it nests posts under a forum', () => {
  const threads = [
    threadFixture({id: 't1', parentChannelId: 'chan_text'}),
    threadFixture({id: 't2', parentChannelId: 'other'}),
    threadFixture({id: 't3', parentChannelId: 'chan_text', isArchived: true}),
  ];

  const rows = selectNestedThreads('chan_text', threads, ['t1'], () => unreadState(false));

  expect(rows.map(t => t.id)).toEqual(['t1']);
});
```

using that file's existing fixture and read-state helpers rather than new ones.

- [ ] **Step 4: Run it**

Run: `bun run ng test --watch=false --include="**/nested-thread-rows.util.spec.ts"`
Expected: PASS. The util is parent-type agnostic already, so this test documents that rather than driving a change. If it fails, the util was more forum-specific than it looked and needs the type check removing.

- [ ] **Step 5: Rename the visited service and make record public**

```bash
git mv src/app/services/forum-visited-posts.service.ts src/app/services/visited-threads.service.ts
```

Rename the class to `VisitedThreadsService`, `postsFor` to `threadsFor`, `VISITED_POSTS_PER_FORUM` to `VISITED_THREADS_PER_PARENT`, and change `record` from `private` to public. Leave the storage key string alone so nobody loses their rows on upgrade. Keep the existing forum effect exactly as it is. Update every importer.

- [ ] **Step 6: Record a panel open as a visit**

In `NavigationService.openThread`:

```ts
    openThread(thread: ChannelDto): void {
        this.threadPanel.set(thread);
        this.mobileNavOpen.set(false);
        const parentId = thread.parentChannelId;
        // The panel never changes mainView, so the effect that records forum visits cannot see this one.
        if (parentId) this.injector.get(VisitedThreadsService).record(parentId, thread.id);
    }
```

Resolve it through the existing `injector` field rather than injecting it, for the same reason `ConversationStore` is resolved that way: a direct inject drags the realtime connection into every consumer of `NavigationService`.

- [ ] **Step 7: Write the rows component**

```ts
import {ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked} from '@angular/core';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {VisitedThreadsService} from '../../../../../../services/visited-threads.service';
import {ThreadRegistryService} from '../../../../../../services/thread-registry.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {selectNestedThreads} from '../forum-post-rows/nested-thread-rows.util';

/** The threads hanging beneath a text channel: the ones you were just in, and the ones with something waiting. */
@Component({
  selector: 'app-thread-rows',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {class: 'contents'},
  templateUrl: './thread-rows.component.html',
})
export class ThreadRowsComponent {
  readonly parent = input.required<ChannelDto>();

  private readonly navService = inject(NavigationService);
  private readonly readStateService = inject(GuildReadStateService);
  private readonly visitedService = inject(VisitedThreadsService);
  private readonly registry = inject(ThreadRegistryService);

  protected readonly threads = computed(() =>
    selectNestedThreads(
      this.parent().id,
      this.registry.threadsFor(this.parent().id),
      this.visitedService.threadsFor(this.parent().id),
      id => this.readStateService.getChannelState(id),
    ),
  );

  constructor() {
    effect(() => {
      const parentId = this.parent().id;
      untracked(() => this.registry.ensureParent(parentId));
    });
  }

  protected stateOf(threadId: string) {
    return this.readStateService.getChannelState(threadId);
  }

  protected isOpen(threadId: string): boolean {
    return this.navService.threadPanel()?.id === threadId;
  }

  protected open(thread: ChannelDto): void {
    this.navService.openThread(thread);
  }
}
```

Copy `forum-post-rows.component.html` verbatim for the template and change only the binding names. Same `.chan-nest` guide line, same badges. Two sidebar row styles for the same idea would be the visible half of a bug.

- [ ] **Step 8: Mount it**

In `channel-list-items.component.html`, inside the `@else` branch after `<app-text-channel-item>` and beside the forum block:

```html
@if (channel.type === ChannelType.Text && hasThreads()) {
<app-thread-rows [parent]="channel" />
}
```

`hasThreads()` is a computed on `channel-list-items.component.ts` reading `guildHasFeature(guild, GuildFeature.Threads)`, matching how `channel.component.ts:140` does it.

- [ ] **Step 9: Verify and commit**

```bash
bun run ng build --configuration development
bun run test
bun run lint
bun run prettier --write "src/app/features/guild/components/channel-list/**" src/app/services/visited-threads.service.ts src/app/features/main-page/navigation.service.ts
git add -A
git commit -m "feat(threads): nest a channel's active threads under it in the sidebar"
```

---

### Task 10: Verification pass

**Files:** none created. This task either finds problems or ends the work.

- [ ] **Step 1: Full suite and build**

```bash
bun run test
bun run ng build --configuration development
bun run lint
```

Expected: passing count at or above the Task 2 baseline, clean build, clean lint.

- [ ] **Step 2: Grep for the things house style forbids**

```bash
grep -rn "—" src/app/features/guild/components/channel src/app/features/messaging/components/conversation/message src/app/services/thread-registry.service.ts
```

Expected: no output. An em dash anywhere in the new code is a defect.

- [ ] **Step 3: Check every new string is translated**

```bash
bun run ng test --watch=false --include="**/i18n-keys.spec.ts"
```

Expected: PASS.

- [ ] **Step 4: Say what is unverified**

These cannot be checked without a live server, and the report must name them rather than imply they work:

- whether text-channel threads arrive in the guild payload, and so whether the sidebar rows populate without `ensureParent` doing the work
- the `409` path, which needs two clients pressing the button at once
- `guild.MessageThreadAttached` actually firing with the documented field names
- `GET /channels/{threadId}` returning `messageCount` and `lastActivityAt` on a text-channel thread rather than only on a forum post

- [ ] **Step 5: Push**

```bash
git push origin main
```

---

## Self-review notes

Spec sections against tasks: A maps to Task 1, B to Tasks 2 and 3, C to Tasks 6 and 7, D to Task 8, E to Task 5, F to Task 9, G to Task 4, H spread across every task's spec step, I is out of scope by construction.

Two places this plan knowingly departs from the spec, both from things found while planning:

1. The spec says the card and the sidebar read `guild.channels` and fall back to a fetch. That logic is a service (`ThreadRegistryService`, Task 1) rather than repeated at three call sites, because whether the payload carries text-channel threads is unverified and one file should absorb the answer.
2. The spec says rename `ForumVisitedPostsService`. The rename alone leaves nested rows broken for panel-opened threads, since its recording effect watches `mainView`. Task 9 makes `record` public and calls it from `openThread`.
