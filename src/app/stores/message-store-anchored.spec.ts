import {TestBed} from '@angular/core/testing';
import {Observable, Subject} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {MessageStore} from './message.store';
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

const CHANNEL = 'chan-1';
const PAGE_SIZE = 30;

/** Stamped rather than slept for: what is under test is ordering, not a clock. */
function chanMsg(id: string, minutesFromEpoch: number): MessageDto {
    return {
        id,
        content: '',
        authorId: 'user-2',
        conversationId: undefined,
        channelId: CHANNEL,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutesFromEpoch)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, minutesFromEpoch)),
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        type: MessageType.Message,
    } as unknown as MessageDto;
}

function pageOf(count: number, from = 0): MessageDto[] {
    return Array.from({length: count}, (_, i) => chanMsg(`msg-${from + i}`, from + i));
}

interface ChannelCall {
    offset: number;
    size: number;
    cursor?: {before?: string; after?: string; around?: string; oldest?: boolean};
}

function setup() {
    const calls: ChannelCall[] = [];
    const responses: Subject<MessageDto[]>[] = [];

    const messaging = {
        getMessagesForConversation: vi.fn<() => Observable<MessageDto[]>>(() => new Subject()),
        getMessagesForChannel: vi.fn(
            (_id: string, offset: number, size: number, cursor?: ChannelCall['cursor']) => {
                calls.push({offset, size, cursor});
                const subject = new Subject<MessageDto[]>();
                responses.push(subject);
                return subject;
            },
        ),
    };

    const wsMessage$ = new Subject<MessageDto>();
    const guildMessage$ = new Subject<MessageDto>();

    TestBed.configureTestingModule({
        providers: [
            {provide: MessagingService, useValue: messaging},
            {
                provide: MlsService,
                useValue: {
                    getCachedMessage: vi.fn(async () => null),
                    cacheMessage: vi.fn(async () => undefined),
                    getKnownGeneration: vi.fn(async () => 1),
                    getGroupId: vi.fn(async () => 'group'),
                    getEncryptionFloor: vi.fn(async () => null),
                },
            },
            {
                provide: MlsSyncService,
                useValue: {decryptMessage: vi.fn(async () => null), replayedMessages: new Subject()},
            },
            MlsHealthService,
            {
                provide: MessageCacheService,
                useValue: {
                    recall: vi.fn(async (key: string) =>
                        key === messageContextKey({channelId: CHANNEL}) ? [] : [],
                    ),
                    remember: vi.fn(async () => undefined),
                    forget: vi.fn(async () => undefined),
                },
            },
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

    return {store: TestBed.inject(MessageStore), calls, responses, guildMessage$};
}

/**
 * Lets the cache recall and decrypt promise chains settle. Generous on purpose: decryptMessages
 * awaits per message, so a full page needs far more ticks than a short one.
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 400; i++) await Promise.resolve();
}

describe('MessageStore channel paging, as it already behaves', () => {
    let harness: ReturnType<typeof setup>;

    beforeEach(() => {
        harness = setup();
    });

    it('seeds a window at the present, from offset zero', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();

        expect(harness.calls[0]).toMatchObject({offset: 0, size: PAGE_SIZE});
        expect(harness.store.channelMeta()[CHANNEL]).toMatchObject({loadingMore: true});
    });

    it('does not read the same channel twice', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();
        harness.store.loadForChannel(CHANNEL);

        expect(harness.calls).toHaveLength(1);
    });

    it('advances the offset by the page length as it grows backwards', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();
        harness.responses[0].next(pageOf(PAGE_SIZE));
        await settle();

        harness.store.loadMoreForChannel(CHANNEL);
        await settle();

        expect(harness.calls[1]).toMatchObject({offset: PAGE_SIZE});
    });

    it('stops offering more once a short page comes back', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();

        harness.responses[0].next(pageOf(3));
        await settle();

        expect(harness.store.channelMeta()[CHANNEL]).toMatchObject({hasMore: false, offset: 3});
    });

    it('will not page while a page is already in flight', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();
        harness.responses[0].next(pageOf(PAGE_SIZE));
        await settle();

        harness.store.loadMoreForChannel(CHANNEL);
        harness.store.loadMoreForChannel(CHANNEL);

        expect(harness.calls).toHaveLength(2);
    });

    it('keeps a live message in an ordinary window', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();
        harness.responses[0].next(pageOf(PAGE_SIZE));
        await settle();

        harness.guildMessage$.next(chanMsg('msg-live', 999));

        expect(harness.store.entityMap()['msg-live']).toBeTruthy();
    });

    it('records the status when the first read fails', async () => {
        harness.store.loadForChannel(CHANNEL);
        await settle();

        harness.responses[0].error({status: 503});
        await settle();

        expect(harness.store.channelMeta()[CHANNEL]).toMatchObject({error: 503, hasMore: false});
    });
});
