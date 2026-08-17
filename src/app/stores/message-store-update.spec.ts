import {TestBed} from '@angular/core/testing';
import {Observable, of} from 'rxjs';
import {MessageStore} from './message.store';
import {MessagingService} from '../services/messaging.service';
import {MlsReplayedMessage, MlsService} from '../services/mls.service';
import {MlsSyncService} from '../services/mls-sync.service';
import {MlsHealthService} from '../services/mls-health.service';
import {MessageUpdatedEvent, MessagingWebsocketService} from '../services/messaging-websocket.service';
import {GuildWebsocketService} from '../services/guild-websocket.service';
import {ProfileService} from '../services/profile.service';
import {MessageCacheService} from '../services/cache/message-cache.service';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {MessageDto} from '../dtos/response/message.dto';
import {Subject} from 'rxjs';

const CONTEXT = 'conv-1';
const GROUP = 'Z3JvdXA=';

function encryptedMessage(overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'msg-1',
        content: 'b3JpZ2luYWw=',
        authorId: 'user-2',
        conversationId: CONTEXT,
        channelId: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Encrypted,
        mlsGeneration: 1,
        type: MessageType.Message,
        ...overrides,
    } as MessageDto;
}

function setup() {
    const mls = {
        getCachedMessage: vi.fn<(
            contextId: string, generation: number | null, messageId: string, author?: string,
        ) => Promise<string | null>>(async () => null),
        cacheMessage: vi.fn<(
            contextId: string, generation: number | null, messageId: string, plaintextB64: string,
            author?: string,
        ) => Promise<void>>(async () => undefined),
        getKnownGeneration: vi.fn(async () => 1),
        getGroupId: vi.fn(async () => GROUP),
        // Null unless a test says otherwise.
        getEncryptionFloor: vi.fn<(contextId: string) => Promise<number | null>>(async () => null),
    };
    const sync = {
        decryptMessage: vi.fn<(
            contextId: string, isChannel: boolean, groupId: string, ciphertextB64: string,
            messageId: string, expectedSenderUserId?: string,
        ) => Promise<string | null>>(async () => null),
        replayedMessages: new Subject<{ contextId: string; messages: MlsReplayedMessage[] }>(),
    };

    const messaging = {
        getMessagesForConversation: vi.fn<(id: string, offset: number, size: number) =>
            Observable<MessageDto[]>>(() => of([])),
    };

    // Just enough for the store to construct without the real IndexedDB chain behind `MessageCacheService`.
    const messageCache = {
        recall: vi.fn(async () => []),
        remember: vi.fn(async () => undefined),
        forget: vi.fn(async () => undefined),
    };

    // Handed back so a test can push a channel edit or bulk delete through the real socket wiring.
    const guildMessageUpdated = new Subject<MessageUpdatedEvent>();
    const guildMessagesBulkDeleted = new Subject<{
        guildId: string; channelId: string; messageIds: string[]; actorUserId: string;
    }>();

    TestBed.configureTestingModule({
        providers: [
            {provide: MessagingService, useValue: messaging},
            {provide: MlsService, useValue: mls},
            {provide: MlsSyncService, useValue: sync},
            {provide: MessageCacheService, useValue: messageCache},
            MlsHealthService,
            {
                provide: MessagingWebsocketService, useValue: {
                    messageObservable: new Subject(), messageUpdatedObservable: new Subject(),
                    messageDeletedObservable: new Subject(), conversationRemovedObservable: new Subject(),
                    conversationMemberRemovedObservable: new Subject(), reactionAddedObservable: new Subject(),
                    reactionRemovedObservable: new Subject(), messagePinnedObservable: new Subject(),
                    messageUnpinnedObservable: new Subject(),
                },
            },
            {
                provide: GuildWebsocketService, useValue: {
                    messageObservable: new Subject(), reactionAddedObservable: new Subject(),
                    reactionRemovedObservable: new Subject(), messagePinnedObservable: new Subject(),
                    messageUnpinnedObservable: new Subject(), messageUpdatedObservable: guildMessageUpdated,
                    messagesBulkDeletedObservable: guildMessagesBulkDeleted,
                    ephemeralMessageObservable: new Subject(),
                },
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'user-1'})}},
        ],
    });

    return {
        store: TestBed.inject(MessageStore),
        mls,
        sync,
        messaging,
        guildMessageUpdated,
        guildMessagesBulkDeleted,
        health: TestBed.inject(MlsHealthService),
    };
}

/**
 * Contract §L.9: message content rendered in an encrypted context MUST come from the decryptor.
 * `MessageUpdated` carries a plain server string, so writing it unchecked puts words into an E2EE conversation with no group keys involved.
 */
describe('MessageStore.applyRemoteUpdate', () => {
    it('never renders server-supplied text in an encrypted context', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage());
        sync.decryptMessage.mockResolvedValue(null);

        await store.applyRemoteUpdate({
            messageId: 'msg-1',
            content: 'SSBhbSB0aGUgc2VydmVy',
            authorId: 'user-2',
            conversationId: CONTEXT,
            channelId: undefined,
        });

        const stored = store.entityMap()['msg-1'];
        expect(stored.content).not.toBe('SSBhbSB0aGUgc2VydmVy');
        expect(stored.undecryptable).toBe(true);
    });

    it('renders an edit that actually decrypts', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage());
        sync.decryptMessage.mockResolvedValue('ZWRpdGVk');

        await store.applyRemoteUpdate({
            messageId: 'msg-1',
            content: 'Y2lwaGVydGV4dA==',
            authorId: 'user-2',
            conversationId: CONTEXT,
            channelId: undefined,
        });

        expect(store.entityMap()['msg-1'].content).toBe('ZWRpdGVk');
        expect(store.entityMap()['msg-1'].undecryptable).toBe(false);
    });

    it('binds the edit to the original author, not the event', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage({authorId: 'user-2'}));
        sync.decryptMessage.mockResolvedValue('ZWRpdGVk');

        await store.applyRemoteUpdate({
            messageId: 'msg-1',
            content: 'Y2lwaGVydGV4dA==',
            // The decryptor must be told to expect the STORED author, so a credential mismatch is caught.
            authorId: 'mallory',
            conversationId: CONTEXT,
            channelId: undefined,
        });

        expect(sync.decryptMessage.mock.calls[0]![5]).toBe('user-2');
    });

    it('applies a plaintext edit unchanged', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage({
            encryptionState: MessageEncryptionState.Plain, content: 'hello',
        }));

        await store.applyRemoteUpdate({
            messageId: 'msg-1',
            content: 'edited',
            authorId: 'user-2',
            conversationId: CONTEXT,
            channelId: undefined,
        });

        expect(store.entityMap()['msg-1'].content).toBe('edited');
        expect(sync.decryptMessage).not.toHaveBeenCalled();
    });

    /** A channel edit must go through the same decrypt the conversation path applies, or §L.9 reopens on the guild socket. */
    it('routes a channel edit from the guild socket through the same decryptor', async () => {
        const {store, sync, guildMessageUpdated} = setup();
        store.addMessage(encryptedMessage({conversationId: undefined, channelId: 'chan-1'}));
        sync.decryptMessage.mockResolvedValue(null);

        guildMessageUpdated.next({
            messageId: 'msg-1',
            content: 'SSBhbSB0aGUgc2VydmVy',
            authorId: 'user-2',
            conversationId: undefined,
            channelId: 'chan-1',
        });
        await Promise.resolve();
        await Promise.resolve();

        const stored = store.entityMap()['msg-1'];
        expect(stored.content).not.toBe('SSBhbSB0aGUgc2VydmVy');
        expect(stored.undecryptable).toBe(true);
        // The channel route, not the conversation one: the context kind decides the group and endpoint.
        expect(sync.decryptMessage.mock.calls[0]![1]).toBe(true);
    });

    it('removes every id in a bulk delete, in one update', () => {
        const {store, guildMessagesBulkDeleted} = setup();
        store.addMessage(encryptedMessage({id: 'msg-1'}));
        store.addMessage(encryptedMessage({id: 'msg-2'}));
        store.addMessage(encryptedMessage({id: 'msg-3'}));

        guildMessagesBulkDeleted.next({
            guildId: 'guil-1', channelId: 'chan-1',
            messageIds: ['msg-1', 'msg-3'], actorUserId: 'user-9',
        });

        expect(store.entityMap()['msg-1']).toBeUndefined();
        expect(store.entityMap()['msg-3']).toBeUndefined();
        expect(store.entityMap()['msg-2']).toBeDefined();
    });

    it('ignores an edit for a message it has never seen', async () => {
        const {store} = setup();

        await store.applyRemoteUpdate({
            messageId: 'unknown', content: 'x', authorId: 'user-2',
            conversationId: CONTEXT, channelId: undefined,
        });

        // Nothing to judge it against, so there is no safe way to render it.
        expect(store.entityMap()['unknown']).toBeUndefined();
    });

    it('refuses rather than rendering when no group is held', async () => {
        const {store, mls, sync} = setup();
        store.addMessage(encryptedMessage());
        mls.getGroupId.mockResolvedValue(null as unknown as string);

        await store.applyRemoteUpdate({
            messageId: 'msg-1', content: 'SSBhbSB0aGUgc2VydmVy', authorId: 'user-2',
            conversationId: CONTEXT, channelId: undefined,
        });

        expect(store.entityMap()['msg-1'].undecryptable).toBe(true);
        expect(sync.decryptMessage).not.toHaveBeenCalled();
    });

    /** A preview arrives as `MessageUpdated` on a message nobody edited; the body must not be re-decrypted, because MLS decrypts a given ciphertext exactly once. */
    it('attaches a preview without re-decrypting the body', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage({content: 'cGxhaW50ZXh0'}));

        await store.applyRemoteUpdate({
            messageId: 'msg-1',
            content: 'Y2lwaGVydGV4dA==',
            authorId: 'user-2',
            conversationId: CONTEXT,
            channelId: undefined,
            embedsJson: '[{"type":"link","title":"Example"}]',
            isAuthorEdit: false,
        });

        const stored = store.entityMap()['msg-1'];
        expect(stored.embedsJson).toBe('[{"type":"link","title":"Example"}]');
        expect(stored.content).toBe('cGxhaW50ZXh0');
        expect(stored.undecryptable).toBeFalsy();
        expect(sync.decryptMessage).not.toHaveBeenCalled();
    });

    it('applies a suppression to a plaintext message without calling it an edit', async () => {
        const {store} = setup();
        store.addMessage(encryptedMessage({
            encryptionState: MessageEncryptionState.Plain,
            content: 'hello',
            embedsJson: '[{"type":"link"}]',
        }));

        await store.applyRemoteUpdate({
            messageId: 'msg-1', content: 'hello', authorId: 'user-2',
            conversationId: CONTEXT, channelId: undefined,
            embedsJson: null, flags: 4, isAuthorEdit: false,
        });

        const stored = store.entityMap()['msg-1'];
        expect(stored.flags).toBe(4);
        expect(stored.embedsJson).toBeUndefined();
        // Nobody edited anything, so nothing may end up labelled "(edited)".
        expect(stored.editedAt).toBeFalsy();
    });

    it('still records the flags on an edit it refuses to render', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage());
        sync.decryptMessage.mockResolvedValue(null);

        await store.applyRemoteUpdate({
            messageId: 'msg-1', content: 'SSBhbSB0aGUgc2VydmVy', authorId: 'user-2',
            conversationId: CONTEXT, channelId: undefined,
            flags: 4, isAuthorEdit: true,
        });

        expect(store.entityMap()['msg-1'].undecryptable).toBe(true);
        expect(store.entityMap()['msg-1'].flags).toBe(4);
    });

    it('carries editedAt through a real author edit', async () => {
        const {store} = setup();
        store.addMessage(encryptedMessage({encryptionState: MessageEncryptionState.Plain}));

        await store.applyRemoteUpdate({
            messageId: 'msg-1', content: 'edited', authorId: 'user-2',
            conversationId: CONTEXT, channelId: undefined,
            editedAt: '2026-08-04T10:00:00Z', isAuthorEdit: true,
        });

        expect(store.entityMap()['msg-1'].editedAt).toBe('2026-08-04T10:00:00Z');
    });

    it('sets and clears the suppress bit without disturbing the rest of the flags', () => {
        const {store} = setup();
        store.addMessage(encryptedMessage({flags: 1}));

        store.applyEmbedSuppression('msg-1', true);
        expect(store.entityMap()['msg-1'].flags).toBe(1 | 4);

        store.applyEmbedSuppression('msg-1', false);
        expect(store.entityMap()['msg-1'].flags).toBe(1);
    });

    it('keys the cached edit on the context and generation, not the server id alone', async () => {
        const {store, mls, sync} = setup();
        store.addMessage(encryptedMessage());
        sync.decryptMessage.mockResolvedValue('ZWRpdGVk');

        await store.applyRemoteUpdate({
            messageId: 'msg-1', content: 'Y2lwaGVydGV4dA==', authorId: 'user-2',
            conversationId: CONTEXT, channelId: undefined,
        });

        expect(mls.cacheMessage).toHaveBeenCalledWith(CONTEXT, 1, 'msg-1', 'ZWRpdGVk', 'user-2');
    });
});

/**
 * Contract §L.9: server-supplied encryption state MUST NOT be able to downgrade a context.
 * On the create and history paths the local check is the monotonic encryption floor, never the per-message `encryptionState`.
 */
describe('MessageStore history decryption', () => {
    function plainMessage(overrides: Partial<MessageDto> = {}): MessageDto {
        return encryptedMessage({
            encryptionState: MessageEncryptionState.Plain,
            content: 'SSBhbSB0aGUgc2VydmVy',
            ...overrides,
        });
    }

    /** `loadForConversation` is fire-and-forget; let the decrypt chain settle. */
    async function settle(): Promise<void> {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    it('refuses a Plain message in a context this device has encrypted', async () => {
        const {store, mls, messaging, health} = setup();
        mls.getEncryptionFloor.mockResolvedValue(2);
        messaging.getMessagesForConversation.mockReturnValue(of([plainMessage()]));

        store.loadForConversation(CONTEXT);
        await settle();

        // `undecryptable` suppresses the body; the raw field is left alone for a later successful decrypt.
        const stored = store.entityMap()['msg-1'];
        expect(stored.undecryptable).toBe(true);
        expect(health.healthOf(CONTEXT)?.reason).toBe('downgraded');
    });

    it('renders a Plain message normally in a context that was never encrypted', async () => {
        const {store, mls, messaging} = setup();
        mls.getEncryptionFloor.mockResolvedValue(null);
        messaging.getMessagesForConversation.mockReturnValue(
            of([plainMessage({content: 'aGVsbG8='})]));

        store.loadForConversation(CONTEXT);
        await settle();

        expect(store.entityMap()['msg-1'].undecryptable).toBeFalsy();
        expect(store.entityMap()['msg-1'].content).toBe('aGVsbG8=');
    });

    it('looks the cache up on context and generation, not on the server id alone', async () => {
        const {store, mls, messaging} = setup();
        messaging.getMessagesForConversation.mockReturnValue(of([encryptedMessage()]));

        store.loadForConversation(CONTEXT);
        await settle();

        expect(mls.getCachedMessage).toHaveBeenCalledWith(CONTEXT, 1, 'msg-1', 'user-2');
    });
});

/**
 * `drain_pending_messages` removes each buffered entry as it decrypts it, and MLS decrypts from the wire exactly once.
 * A replay with no subscriber is therefore a message lost permanently, so `replayedMessages` must always be consumed.
 */
describe('MessageStore replayed messages', () => {
    it('renders a replayed message that had been marked undecryptable', async () => {
        const {store, sync, mls} = setup();
        store.addMessage(encryptedMessage({undecryptable: true}));

        await store.applyReplayedMessages(CONTEXT, [
            {messageId: 'msg-1', plaintext: 'cmVwbGF5ZWQ=', senderIdentity: 'user-2', epoch: 4},
        ]);

        expect(store.entityMap()['msg-1'].content).toBe('cmVwbGF5ZWQ=');
        expect(store.entityMap()['msg-1'].undecryptable).toBe(false);
        // Cached too: the drain has already consumed the only chance to decrypt these bytes.
        expect(mls.cacheMessage).toHaveBeenCalledWith(
            CONTEXT, 1, 'msg-1', 'cmVwbGF5ZWQ=', 'user-2');
        expect(sync.replayedMessages).toBeTruthy();
    });

    it('is wired to the sync service, which had no subscriber at all', async () => {
        const {store, sync} = setup();
        store.addMessage(encryptedMessage({undecryptable: true}));

        sync.replayedMessages.next({
            contextId: CONTEXT,
            messages: [
                {messageId: 'msg-1', plaintext: 'cmVwbGF5ZWQ=', senderIdentity: 'user-2', epoch: 4},
            ],
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(store.entityMap()['msg-1'].content).toBe('cmVwbGF5ZWQ=');
    });

    it('refuses a replay whose signer is not the author the server named', async () => {
        const {store, mls, health} = setup();
        store.addMessage(encryptedMessage({authorId: 'user-2', undecryptable: true}));

        await store.applyReplayedMessages(CONTEXT, [
            {messageId: 'msg-1', plaintext: 'aW5qZWN0ZWQ=', senderIdentity: 'mallory', epoch: 4},
        ]);

        // The replay path never re-enters `decryptMessage`, so the credential-to-author binding must be here.
        expect(store.entityMap()['msg-1'].content).toBe('b3JpZ2luYWw=');
        expect(mls.cacheMessage).not.toHaveBeenCalled();
        expect(health.healthOf(CONTEXT)?.reason).toBe('decrypt-failed');
    });

    it('caches a replay for a message the store has not loaded yet', async () => {
        const {store, mls} = setup();

        await store.applyReplayedMessages(CONTEXT, [
            {messageId: 'not-loaded', plaintext: 'cmVwbGF5ZWQ=', senderIdentity: 'user-2', epoch: 4},
        ]);

        // Paging back to it later must find the plaintext: there is no second chance to decrypt.
        expect(mls.cacheMessage).toHaveBeenCalledWith(
            CONTEXT, 1, 'not-loaded', 'cmVwbGF5ZWQ=', 'user-2');
    });
});
