import {TestBed} from '@angular/core/testing';
import {Observable, of} from 'rxjs';
import {MessageStore} from './message.store';
import {MessagingService} from '../services/messaging.service';
import {MlsReplayedMessage, MlsService} from '../services/mls.service';
import {MlsSyncService} from '../services/mls-sync.service';
import {MlsHealthService} from '../services/mls-health.service';
import {MessagingWebsocketService} from '../services/messaging-websocket.service';
import {GuildWebsocketService} from '../services/guild-websocket.service';
import {ProfileService} from '../services/profile.service';
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
        // Null unless a test says otherwise: most of these exercise contexts the server and this
        // device agree about.
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

    TestBed.configureTestingModule({
        providers: [
            {provide: MessagingService, useValue: messaging},
            {provide: MlsService, useValue: mls},
            {provide: MlsSyncService, useValue: sync},
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
                    messageUnpinnedObservable: new Subject(),
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
        health: TestBed.inject(MlsHealthService),
    };
}

/**
 * Contract §L.9: "Message content rendered in an encrypted context MUST come from the decryptor."
 *
 * The socket's `MessageUpdated` carries a plain server string. Writing it into the store unchecked
 * lets anyone who can emit that event put words into an end-to-end encrypted conversation,
 * attributed to the original author, with no group keys involved at all.
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
            // The event claims someone else edited it; the decryptor must still be told to expect
            // the stored author, so a mismatch against the signed credential is caught.
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
 * H2 - contract §L.9: "Server-supplied encryption state MUST NOT be able to downgrade a context."
 *
 * `applyRemoteUpdate` already decided from the *stored* encryption state, "the one field the server
 * cannot rewrite in flight". The create and history paths did not: they skipped the decryptor
 * whenever the per-message `encryptionState` said `Plain`, then rendered `content` verbatim under
 * `authorId`. The local equivalent of "stored state" on those paths is the monotonic encryption
 * floor.
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

        // `undecryptable` is what suppresses the body - `MessageComponent.content` refuses to
        // decode it and renders a placeholder instead. The raw field is left alone so a later
        // successful decrypt can still use it.
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
 * H4 - buffered early messages were decrypted and thrown away.
 *
 * `drain_pending_messages` *removes* each buffered entry, decrypts it, and returns only the
 * still-pending ones to the buffer. `MlsSyncService.replayedMessages` had zero subscribers
 * repo-wide, and MLS decrypts from the wire exactly once - so every message that arrived ahead of
 * its commit was lost permanently. Not calling the drain at all would have been strictly safer.
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
        // Cached too, or the plaintext would be lost again on the next reload - the drain has
        // already consumed the only chance to decrypt these bytes.
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

        // The replay path never goes back through `decryptMessage`, so this is the only place the
        // credential-to-author binding can be applied to it.
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
