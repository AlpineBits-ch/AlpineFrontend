/**
 * Characterization of the send path and read tracking, written against the pre-extraction
 * component so the move into `app-channel-conversation` has a net under it.
 *
 * The template is overridden away: every child component in it drags its own DI chain, and none of
 * them is what this file is about.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of, Subject, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {ChannelComponent} from './channel.component';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../../../services/api-config.service';
import {MessageStore} from '../../../../stores/message.store';
import {MessagingService} from '../../../../services/messaging.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {MlsService} from '../../../../services/mls.service';
import {MlsSyncService} from '../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../services/mls-join-request.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {PersonaService} from '../../../../services/persona.service';
import {ProfileService} from '../../../../services/profile.service';
import {TypingService} from '../../../../services/typing.service';
import {SceneService} from '../../../../services/scene.service';
import {ForumService} from '../../../../services/forum.service';
import {ForumStateService} from '../../../../services/forum-state.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../services/toast.service';
import {BotCommandService} from '../../../../services/bot-command.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageType} from '../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';

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

function messageFixture(overrides: Partial<MessageDto> = {}): MessageDto {
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

function storeStub(entities: MessageDto[] = []) {
    return {
        entities: signal(entities),
        channelMeta: signal<Record<string, unknown>>({}),
        channelSearchEntries: signal<Record<string, unknown>>({}),
        loadForChannel: vi.fn(),
        loadMoreForChannel: vi.fn(),
        clearChannelError: vi.fn(),
        addMessage: vi.fn(),
        confirmMessage: vi.fn(),
        failMessage: vi.fn(),
        removeMessage: vi.fn(),
        searchInChannel: vi.fn(),
        clearChannelSearch: vi.fn(),
    };
}

async function setup(sendResult: 'ok' | 'fail' | 'automod' = 'ok', entities: MessageDto[] = []) {
    TestBed.resetTestingModule();
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;

    const store = storeStub(entities);
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
        threadUpdatedObservable: new Subject<unknown>(),
        updateLastReadMessageByChannel: vi.fn(async () => {}),
        invokeStartTyping: vi.fn(),
    };
    const readState = {markChannelRead: vi.fn()};
    const guild = {id: 'g1', name: 'G', roles: [], channels: [], features: '', ownerId: 'owner'};

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
            {provide: GuildReadStateService, useValue: readState},
            {provide: GuildService, useValue: {getOwnMember: () => of(null)}},
            {
                provide: NavigationService,
                useValue: {workspace: signal({type: 'server' as const, guild})},
            },
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
            {
                provide: MlsService,
                useValue: {
                    getKnownGeneration: async () => null,
                    getEncryptionFloor: async () => null,
                    getActiveGroupId: async () => null,
                    keyHandle: () => null,
                    getGroupId: async () => null,
                    cacheMessage: async () => {},
                    getOrCreateDeviceIdentifier: async () => 'dev1',
                },
            },
            {provide: MlsSyncService, useValue: {refreshState: async () => ({encrypted: false})}},
            {provide: MlsJoinRequestService, useValue: {statusOf: () => null, relink: async () => {}}},
            {provide: OwnMemberRevisionService, useValue: {revision: signal(0)}},
            {provide: PersonaService, useValue: {entry: () => null, identity: () => null}},
            {
                provide: ProfileService,
                useValue: {ownProfile: () => ({userId: 'u1'}), getCachedByUserId: () => null},
            },
            {provide: TypingService, useValue: {state: signal(new Map())}},
        ],
    })
        .overrideComponent(ChannelComponent, {set: {template: '', imports: [], styles: []}})
        .compileComponents();

    const fixture: ComponentFixture<ChannelComponent> = TestBed.createComponent(ChannelComponent);
    fixture.componentRef.setInput('channel', channelFixture());
    fixture.detectChanges();
    await fixture.whenStable();

    return {fixture, component: fixture.componentInstance, store, messaging, guildWs, readState};
}

/** Two microtask turns: the send is a promise chain wrapped in `from(...)`. */
async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('ChannelComponent send path', () => {
    it('adds an optimistic message before the request settles', async () => {
        const {component, store} = await setup();

        component.createMessage(sendPayload());

        expect(store.addMessage).toHaveBeenCalledOnce();
        const optimistic = store.addMessage.mock.calls[0][0] as MessageDto;
        expect(optimistic.isPending).toBe(true);
        expect(optimistic.channelId).toBe('chan1');
        expect(atob(optimistic.content)).toBe('hello');
    });

    it('confirms the optimistic message with the server copy', async () => {
        const {component, store} = await setup('ok');

        component.createMessage(sendPayload());
        await settle();

        expect(store.confirmMessage).toHaveBeenCalled();
        expect(store.failMessage).not.toHaveBeenCalled();
    });

    it('marks the message failed when the send errors', async () => {
        const {component, store} = await setup('fail');

        component.createMessage(sendPayload());
        await settle();

        expect(store.failMessage).toHaveBeenCalled();
        expect(store.removeMessage).not.toHaveBeenCalled();
    });

    it('removes the message and raises the banner on an auto-mod refusal', async () => {
        const {component, store} = await setup('automod');

        component.createMessage(sendPayload());
        await settle();

        expect(store.removeMessage).toHaveBeenCalled();
        expect((component as unknown as {autoModError: () => string | null}).autoModError()).toBe(
            'blocked_word',
        );
    });
});

describe('ChannelComponent read tracking', () => {
    it('reports the newest settled message as read', async () => {
        const {guildWs, readState} = await setup('ok', [
            messageFixture({id: 'mesg_old', createdAt: new Date('2026-08-19T00:00:00Z')}),
            messageFixture({id: 'mesg_new', createdAt: new Date('2026-08-19T01:00:00Z')}),
        ]);

        expect(guildWs.updateLastReadMessageByChannel).toHaveBeenCalledWith('mesg_new', 'chan1');
        expect(readState.markChannelRead).toHaveBeenCalledWith('chan1');
    });

    it('does not report a pending message as read', async () => {
        const {guildWs} = await setup('ok', [messageFixture({id: 'mesg_pending', isPending: true})]);

        expect(guildWs.updateLastReadMessageByChannel).not.toHaveBeenCalled();
    });
});
