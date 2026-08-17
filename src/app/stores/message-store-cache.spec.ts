import {TestBed} from '@angular/core/testing';
import {Observable, Subject, of} from 'rxjs';
import {MessageStore, reconcile} from './message.store';
import {MessagingService} from '../services/messaging.service';
import {MlsService} from '../services/mls.service';
import {MlsSyncService} from '../services/mls-sync.service';
import {MlsHealthService} from '../services/mls-health.service';
import {MessagingWebsocketService} from '../services/messaging-websocket.service';
import {GuildWebsocketService} from '../services/guild-websocket.service';
import {ProfileService} from '../services/profile.service';
import {MessageCacheService, messageContextKey} from '../services/cache/message-cache.service';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {MessageDto} from '../dtos/response/message.dto';

const CONVERSATION = 'conv-1';
const CHANNEL = 'chan-1';

function convMsg(id: string, overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id,
        content: '',
        authorId: 'user-2',
        conversationId: CONVERSATION,
        channelId: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        type: MessageType.Message,
        ...overrides,
    } as MessageDto;
}

function chanMsg(id: string, overrides: Partial<MessageDto> = {}): MessageDto {
    return convMsg(id, {conversationId: undefined, channelId: CHANNEL, ...overrides});
}

/** `reconcile` in isolation, imported from the store rather than redefined here, so the suite cannot pass against a copy. */
describe('message cache reconciliation', () => {
    it('drops a cached message the server no longer returns', () => {
        expect(reconcile([convMsg('deleted'), convMsg('kept')], [convMsg('kept')]).map(m => m.id)).toEqual([
            'kept',
        ]);
    });

    it('prefers the server copy of a message present in both', () => {
        const server = {...convMsg('m1'), content: 'edited'} as MessageDto;
        const merged = reconcile([{...convMsg('m1'), content: 'stale'} as MessageDto], [server]);

        expect(merged).toHaveLength(1);
        expect(merged[0].content).toBe('edited');
    });

    it('keeps nothing at all when the server returns an empty page', () => {
        expect(reconcile([convMsg('a'), convMsg('b')], [])).toEqual([]);
    });

    it('is the identity when there is nothing cached', () => {
        expect(reconcile([], [convMsg('a')]).map(m => m.id)).toEqual(['a']);
    });

    it('never widens to "everything the store holds for this conversation"', () => {
        // This function only sees what it is given; the real guarantee is the caller passing the cache-painted ids, never the full entity set.
        const paintedFromCacheOnly = [convMsg('cached-stale')];
        const settled = reconcile(paintedFromCacheOnly, [convMsg('server-item')]);
        expect(settled.map(m => m.id)).toEqual(['server-item']);
    });
});

function setup(cached: {conversation?: MessageDto[]; channel?: MessageDto[]} = {}) {
    const mls = {
        getCachedMessage: vi.fn(async () => null),
        cacheMessage: vi.fn(async () => undefined),
        getKnownGeneration: vi.fn(async () => 1),
        getGroupId: vi.fn(async () => 'group'),
        getEncryptionFloor: vi.fn<(contextId: string) => Promise<number | null>>(async () => null),
    };
    const sync = {
        decryptMessage: vi.fn(async () => null),
        replayedMessages: new Subject(),
    };

    const conversationMessages$ = new Subject<MessageDto[]>();
    const channelMessages$ = new Subject<MessageDto[]>();
    const messaging = {
        getMessagesForConversation: vi.fn<
            (id: string, offset: number, size: number) => Observable<MessageDto[]>
        >(() => conversationMessages$),
        getMessagesForChannel: vi.fn<(id: string, offset: number, size: number) => Observable<MessageDto[]>>(
            () => channelMessages$,
        ),
    };

    const messageCache = {
        recall: vi.fn(async (key: string) => {
            if (key === messageContextKey({conversationId: CONVERSATION})) return cached.conversation ?? [];
            if (key === messageContextKey({channelId: CHANNEL})) return cached.channel ?? [];
            return [];
        }),
        remember: vi.fn(async () => undefined),
        forget: vi.fn(async () => undefined),
    };

    const wsMessage$ = new Subject<MessageDto>();
    const guildMessage$ = new Subject<MessageDto>();

    TestBed.configureTestingModule({
        providers: [
            {provide: MessagingService, useValue: messaging},
            {provide: MlsService, useValue: mls},
            {provide: MlsSyncService, useValue: sync},
            MlsHealthService,
            {provide: MessageCacheService, useValue: messageCache},
            {
                provide: MessagingWebsocketService,
                useValue: {
                    messageObservable: wsMessage$,
                    messageUpdatedObservable: new Subject(),
                    messageDeletedObservable: new Subject(),
                    conversationRemovedObservable: new Subject(),
                    conversationMemberRemovedObservable: new Subject(),
                    reactionAddedObservable: new Subject(),
                    reactionRemovedObservable: new Subject(),
                    messagePinnedObservable: new Subject(),
                    messageUnpinnedObservable: new Subject(),
                },
            },
            {
                provide: GuildWebsocketService,
                useValue: {
                    messageObservable: guildMessage$,
                    reactionAddedObservable: new Subject(),
                    reactionRemovedObservable: new Subject(),
                    messagePinnedObservable: new Subject(),
                    messageUnpinnedObservable: new Subject(),
                    messageUpdatedObservable: new Subject(),
                    messagesBulkDeletedObservable: new Subject(),
                    ephemeralMessageObservable: new Subject(),
                },
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'user-1'})}},
        ],
    });

    return {
        store: TestBed.inject(MessageStore),
        messaging,
        messageCache,
        conversationMessages$,
        channelMessages$,
        wsMessage$,
        guildMessage$,
    };
}

/** Lets queued microtasks (cache recall, decrypt, promise chains) settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('MessageStore cache gap-fill - conversation', () => {
    it('paints the cached page before the network answers', async () => {
        const {store} = setup({conversation: [convMsg('cached-1')]});

        store.loadForConversation(CONVERSATION);
        await settle();

        expect(store.entityMap()['cached-1']).toBeTruthy();
    });

    it('never restores offset from the cache', async () => {
        const {store} = setup({
            conversation: [convMsg('a'), convMsg('b'), convMsg('c')],
        });

        store.loadForConversation(CONVERSATION);
        await settle();

        // The cache painted 3 messages, but nothing about that may advance the pagination cursor.
        expect(store.conversationMeta()[CONVERSATION]?.offset).toBe(0);
    });

    it(
        'drops a cache-painted message the server does not confirm, but keeps a live ' +
            'websocket arrival and a pending send',
        async () => {
            const {store, conversationMessages$, wsMessage$} = setup({
                conversation: [convMsg('stale'), convMsg('shared', {content: 'old'})],
            });

            store.loadForConversation(CONVERSATION);
            await settle();
            expect(store.entityMap()['stale']).toBeTruthy();
            expect(store.entityMap()['shared'].content).toBe('old');

            // A message arrives over the socket while the fetch is still in flight.
            wsMessage$.next(convMsg('live-ws'));
            // An optimistic send the user made locally.
            store.addMessage(convMsg('pending-send', {isPending: true}));

            conversationMessages$.next([convMsg('shared', {content: 'fresh'})]);
            conversationMessages$.complete();
            await settle();

            // Confirmed by the server: kept, with the server's copy winning.
            expect(store.entityMap()['shared'].content).toBe('fresh');
            // Never confirmed, and only ever painted from the cache: dropped.
            expect(store.entityMap()['stale']).toBeUndefined();
            // Arrived by a route other than the cache paint: never an eviction candidate.
            expect(store.entityMap()['live-ws']).toBeTruthy();
            expect(store.entityMap()['pending-send']).toBeTruthy();
        },
    );

    it('ignores a cache read that resolves after the network page already landed', async () => {
        const {store, messaging} = setup({conversation: [convMsg('should-not-appear')]});
        // Resolves synchronously, ahead of the cache promise chain, so `loadingMore` flips to false before the cache read's `.then` callbacks run.
        messaging.getMessagesForConversation.mockReturnValue(of([convMsg('from-server')]));

        store.loadForConversation(CONVERSATION);
        await settle();

        expect(store.entityMap()['from-server']).toBeTruthy();
        expect(store.entityMap()['should-not-appear']).toBeUndefined();
    });

    /** `upsertEntities` shallow-merges, so it may only be applied to the ids this load painted from the cache: applied to the whole server page it clobbers a live update that landed mid-fetch. */
    it(
        "keeps a live pin that lands mid-fetch instead of letting the server's pre-mutation " +
            'copy clobber it',
        async () => {
            const {store, conversationMessages$} = setup(); // Nothing cached: 'shared' is never painted.

            // Already in the store before the load starts - never painted from the cache.
            store.addMessage(convMsg('shared', {isPinned: false}));

            store.loadForConversation(CONVERSATION);
            await settle();

            // A pin lands over the socket while the HTTP request is still in flight.
            store.applyPinned({
                messageId: 'shared',
                authorId: 'user-2',
                pinnedById: 'user-9',
                pinnedAt: '2026-08-16T00:00:00Z',
                conversationId: CONVERSATION,
            });
            expect(store.entityMap()['shared'].isPinned).toBe(true);

            // The server's page reflects a read from before that pin.
            conversationMessages$.next([convMsg('shared', {isPinned: false})]);
            conversationMessages$.complete();
            await settle();

            expect(store.entityMap()['shared'].isPinned).toBe(true);
        },
    );

    it('persists the arrived page to the cache', async () => {
        const {store, conversationMessages$, messageCache} = setup();

        store.loadForConversation(CONVERSATION);
        const page = [convMsg('m1'), convMsg('m2')];
        conversationMessages$.next(page);
        conversationMessages$.complete();
        await settle();

        expect(messageCache.remember).toHaveBeenCalledWith(
            messageContextKey({conversationId: CONVERSATION}),
            page,
        );
    });
});

describe('MessageStore cache gap-fill - channel', () => {
    it('paints the cached page before the network answers', async () => {
        const {store} = setup({channel: [chanMsg('cached-1')]});

        store.loadForChannel(CHANNEL);
        await settle();

        expect(store.entityMap()['cached-1']).toBeTruthy();
    });

    it('never restores offset from the cache', async () => {
        const {store} = setup({channel: [chanMsg('a'), chanMsg('b')]});

        store.loadForChannel(CHANNEL);
        await settle();

        expect(store.channelMeta()[CHANNEL]?.offset).toBe(0);
    });

    it(
        'drops a cache-painted message the server does not confirm, but keeps a live ' + 'websocket arrival',
        async () => {
            const {store, channelMessages$, guildMessage$} = setup({
                channel: [chanMsg('stale'), chanMsg('shared', {content: 'old'})],
            });

            store.loadForChannel(CHANNEL);
            await settle();
            expect(store.entityMap()['stale']).toBeTruthy();

            guildMessage$.next(chanMsg('live-ws'));

            channelMessages$.next([chanMsg('shared', {content: 'fresh'})]);
            channelMessages$.complete();
            await settle();

            expect(store.entityMap()['shared'].content).toBe('fresh');
            expect(store.entityMap()['stale']).toBeUndefined();
            expect(store.entityMap()['live-ws']).toBeTruthy();
        },
    );

    /** Same race as the conversation path's equivalent test - see the comment there. */
    it(
        "keeps a live reaction that lands mid-fetch instead of letting the server's " +
            'pre-mutation copy clobber it',
        async () => {
            const {store, channelMessages$} = setup(); // Nothing cached: 'shared' is never painted.

            store.addMessage(chanMsg('shared', {reactions: []}));

            store.loadForChannel(CHANNEL);
            await settle();

            // A reaction lands over the socket while the HTTP request is still in flight.
            store.applyReactionAdded({
                messageId: 'shared',
                userId: 'user-9',
                emoji: '👍',
                channelId: CHANNEL,
            });
            expect(store.entityMap()['shared'].reactions).toHaveLength(1);

            // The server's page reflects a read from before that reaction.
            channelMessages$.next([chanMsg('shared', {reactions: []})]);
            channelMessages$.complete();
            await settle();

            expect(store.entityMap()['shared'].reactions).toHaveLength(1);
        },
    );

    it('persists the arrived page to the cache', async () => {
        const {store, channelMessages$, messageCache} = setup();

        store.loadForChannel(CHANNEL);
        const page = [chanMsg('m1')];
        channelMessages$.next(page);
        channelMessages$.complete();
        await settle();

        expect(messageCache.remember).toHaveBeenCalledWith(messageContextKey({channelId: CHANNEL}), page);
    });
});
