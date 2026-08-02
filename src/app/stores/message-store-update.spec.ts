import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {MessageStore} from './message.store';
import {MessagingService} from '../services/messaging.service';
import {MlsService} from '../services/mls.service';
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
        getCachedMessage: vi.fn(async () => null),
        cacheMessage: vi.fn(async () => undefined),
        getKnownGeneration: vi.fn(async () => 1),
        getGroupId: vi.fn(async () => GROUP),
    };
    const sync = {
        decryptMessage: vi.fn<(
            contextId: string, isChannel: boolean, groupId: string, ciphertextB64: string,
            messageId: string, expectedSenderUserId?: string,
        ) => Promise<string | null>>(async () => null),
    };

    TestBed.configureTestingModule({
        providers: [
            {provide: MessagingService, useValue: {}},
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

    return {store: TestBed.inject(MessageStore), mls, sync, health: TestBed.inject(MlsHealthService)};
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
});
