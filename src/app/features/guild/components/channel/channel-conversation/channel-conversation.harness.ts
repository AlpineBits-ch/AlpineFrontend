/**
 * Fixtures and TestBed wiring shared by the ChannelConversationComponent specs. Not a spec itself:
 * no top-level describe or it, so Vitest leaves it alone.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {Provider, signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of, Subject, throwError} from 'rxjs';
import {vi} from 'vitest';

import {ChannelConversationComponent} from './channel-conversation.component';
import {ChannelEncryptionService} from './channel-encryption.service';
import {ChannelSendService} from './channel-send.service';
import {MessageScrollService} from '../../../../../shared/conversation/message-scroll.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {MessageStore} from '../../../../../stores/message.store';
import {MessagingService} from '../../../../../services/messaging.service';
import {GuildWebsocketService} from '../../../../../services/guild-websocket.service';
import {GuildService} from '../../../../../services/guild.service';
import {GuildReadStateService} from '../../../../../services/guild-read-state.service';
import {MlsService} from '../../../../../services/mls.service';
import {MlsSyncService} from '../../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../../services/mls-join-request.service';
import {OwnMemberRevisionService} from '../../../../../services/own-member-revision.service';
import {PersonaService} from '../../../../../services/persona.service';
import {ProfileService} from '../../../../../services/profile.service';
import {TypingService} from '../../../../../services/typing.service';
import {SceneService} from '../../../../../services/scene.service';
import {ForumService} from '../../../../../services/forum.service';
import {ForumStateService} from '../../../../../services/forum-state.service';
import {GuildEmojiStore} from '../../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../../services/toast.service';
import {BotCommandService} from '../../../../../services/bot-command.service';
import {NavigationService} from '../../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {GuildPersonaDto, PersonaApprovalState, PersonaScope} from '../../../../../dtos/response/persona.dto';
import {MessageType} from '../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';

export const BASE = 'https://api.test.example';

export function channelFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
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

export function messageFixture(overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date('2026-08-19T00:00:00Z'),
        updatedAt: new Date('2026-08-19T00:00:00Z'),
        content: btoa('hello'),
        channelId: 'chan1',
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
        ...overrides,
    };
}

export function personaFixture(overrides: Partial<GuildPersonaDto> = {}): GuildPersonaDto {
    return {
        persona: {
            id: 'pers_1',
            scope: PersonaScope.Guild,
            name: 'Vera',
            avatarUrl: 'https://cdn.test/vera.png',
            isRetired: false,
            createdAt: '2026-08-19T00:00:00Z',
        },
        personaId: 'pers_1',
        guildId: 'g1',
        approvalState: PersonaApprovalState.Approved,
        canSpeak: true,
        ...overrides,
    };
}

/** The MLS surface the send path and the encryption resolver touch. Plain channel by default. */
export function mlsStub(overrides: Record<string, unknown> = {}) {
    return {
        getKnownGeneration: vi.fn(async () => null as number | null),
        getEncryptionFloor: vi.fn(async () => null as number | null),
        getActiveGroupId: vi.fn(async () => null as string | null),
        keyHandle: vi.fn(() => null as string | null),
        getGroupId: vi.fn(async () => null as string | null),
        sendMessage: vi.fn(() => of({ciphertext: 'ciphertext', epoch: 7})),
        cacheMessage: vi.fn(async () => {}),
        getOrCreateDeviceIdentifier: vi.fn(async () => 'dev1'),
        ...overrides,
    };
}

export function mlsSyncStub(overrides: Record<string, unknown> = {}) {
    return {
        refreshState: vi.fn(async () => ({encrypted: false})),
        ...overrides,
    };
}

export function sendPayload(overrides: Record<string, unknown> = {}) {
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

/** The slice of the store's per-channel window the component reads. */
export interface WindowMeta {
    offset?: number;
    hasMore?: boolean;
    loadingMore?: boolean;
    anchored?: boolean;
    hasNewer?: boolean;
    error?: string | null;
}

export function storeStub(entities: MessageDto[] = [], channelMeta: Record<string, WindowMeta> = {}) {
    return {
        entities: signal(entities),
        channelMeta: signal<Record<string, WindowMeta>>(channelMeta),
        channelSearchEntries: signal<Record<string, unknown>>({}),
        loadForChannel: vi.fn(),
        loadMoreForChannel: vi.fn(),
        loadChannelOldest: vi.fn(),
        loadNewerForChannel: vi.fn(),
        clearChannelAnchor: vi.fn(),
        clearChannelError: vi.fn(),
        addMessage: vi.fn(),
        confirmMessage: vi.fn(),
        failMessage: vi.fn(),
        removeMessage: vi.fn(),
        attachThread: vi.fn(),
        searchInChannel: vi.fn(),
        clearChannelSearch: vi.fn(),
    };
}

export type StoreStub = ReturnType<typeof storeStub>;

export interface SetupOptions {
    /** Seeds the store stub's channelMeta; it stays writable, so a spec can drive it afterwards. */
    channelMeta?: Record<string, WindowMeta>;
    /** Appended after the defaults, so they win. */
    providers?: Provider[];
    channel?: ChannelDto;
}

export async function setup(
    sendResult: 'ok' | 'fail' | 'automod' = 'ok',
    entities: MessageDto[] = [],
    readFromStart: string | null = null,
    options: SetupOptions = {},
) {
    TestBed.resetTestingModule();
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;

    const store = storeStub(entities, options.channelMeta ?? {});
    const messaging = {
        messageSentObservable: new Subject<MessageDto>(),
        createMessage: vi.fn(() => {
            if (sendResult === 'ok') return of(messageFixture({id: 'mesg_real'}));
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
        threadCreatedObservable: new Subject<unknown>(),
        threadUpdatedObservable: new Subject<unknown>(),
        messageThreadAttachedObservable: new Subject<unknown>(),
        updateLastReadMessageByChannel: vi.fn(async () => {}),
        invokeStartTyping: vi.fn(),
    };
    const readState = {markChannelRead: vi.fn()};
    const guild = {id: 'g1', name: 'G', roles: [], channels: [], features: '', ownerId: 'owner'};
    const nav = {
        workspace: signal({type: 'server' as const, guild}),
        readFromStart: signal<string | null>(readFromStart),
    };

    await TestBed.configureTestingModule({
        imports: [ChannelConversationComponent],
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
            {provide: GuildReadStateService, useValue: readState},
            {provide: GuildService, useValue: {getOwnMember: () => of(null)}},
            {provide: NavigationService, useValue: nav},
            {provide: BotCommandService, useValue: {currentGuildBots: () => []}},
            {
                provide: SceneService,
                useValue: {
                    scenes: () => [],
                    scene: () => null,
                    speakableIds: () => [],
                    now: () => 0,
                    ensureGuild: vi.fn(),
                    refreshScene: vi.fn(),
                    notePost: vi.fn(),
                    advanceTurn: () => of(null),
                },
            },
            {provide: ForumStateService, useValue: {tagsFor: () => [], loadFor: vi.fn()}},
            {provide: ForumService, useValue: {setPostTags: () => of(null)}},
            {provide: GuildEmojiStore, useValue: {getEmojis: () => [], ensureLoaded: vi.fn()}},
            {provide: ToastService, useValue: {httpError: vi.fn()}},
            {provide: MlsService, useValue: mlsStub()},
            {provide: MlsSyncService, useValue: mlsSyncStub()},
            {provide: MlsJoinRequestService, useValue: {statusOf: () => null, relink: async () => {}}},
            {provide: OwnMemberRevisionService, useValue: {revision: signal(0)}},
            {provide: PersonaService, useValue: {entry: () => null, identity: () => null}},
            {
                provide: ProfileService,
                useValue: {ownProfile: () => ({userId: 'u1'}), getCachedByUserId: () => null},
            },
            {provide: TypingService, useValue: {state: signal(new Map())}},
            ...(options.providers ?? []),
        ],
    })
        .overrideComponent(ChannelConversationComponent, {set: {template: '', imports: [], styles: []}})
        .compileComponents();

    const fixture: ComponentFixture<ChannelConversationComponent> = TestBed.createComponent(
        ChannelConversationComponent,
    );
    fixture.componentRef.setInput('channel', options.channel ?? channelFixture());
    fixture.detectChanges();
    await fixture.whenStable();

    // Component-scoped, so they come off the element injector rather than the TestBed root.
    const encryption = fixture.debugElement.injector.get(ChannelEncryptionService);
    const sending = fixture.debugElement.injector.get(ChannelSendService);

    return {
        fixture,
        component: fixture.componentInstance,
        store,
        messaging,
        guildWs,
        readState,
        nav,
        encryption,
        sending,
    };
}

/** Drains the promise chain a send is wrapped in; the encrypted path awaits seven deep. */
export async function settle(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

export interface ScrollElementStub {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    scrollTo: ReturnType<typeof vi.fn>;
}

/** jsdom reports every geometry as 0, so the scroll specs hand the component this instead. */
export function scrollStub(geometry: Partial<Omit<ScrollElementStub, 'scrollTo'>> = {}): {
    nativeElement: ScrollElementStub;
} {
    return {
        nativeElement: {scrollTop: 0, scrollHeight: 0, clientHeight: 0, scrollTo: vi.fn(), ...geometry},
    };
}

/** The component's non-public scroll surface, which the scroll specs drive directly. */
export interface ScrollInnards {
    scrollRef: {nativeElement: ScrollElementStub};
    scroll: MessageScrollService;
    onScroll: () => void;
    jumpToPresent: () => void;
}

export function scrollInnards(component: ChannelConversationComponent): ScrollInnards {
    return component as unknown as ScrollInnards;
}

/** Hands the component's own scroll service a stub container, the way ngAfterViewInit hands it the real one. */
export function attachScroll(
    component: ChannelConversationComponent,
    geometry: Partial<Omit<ScrollElementStub, 'scrollTo'>> = {},
): ScrollElementStub {
    const inner = scrollInnards(component);
    inner.scrollRef = scrollStub(geometry);
    inner.scroll.attach(inner.scrollRef.nativeElement as unknown as HTMLDivElement);
    return inner.scrollRef.nativeElement;
}
