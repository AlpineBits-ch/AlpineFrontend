/**
 * The live-message path: what gets rendered, under whose name, and what may be silently dropped.
 *
 * <p>Everything here is about fields the **server** chooses. `handleMessageCreated` reads
 * `encryptionState`, `authorId`, `senderDeviceId` and `messageId` off the wire and used to act on
 * all four unconditionally - so a hostile or compromised server could downgrade a context to
 * cleartext, replay another conversation's plaintext, or make a message disappear from the live
 * view. §L.9 forbids the first two outright.</p>
 */
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {MessagingWebsocketService} from './messaging-websocket.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {NotificationService} from './notification.service';
import {ProfileService} from './profile.service';
import {ConversationService} from './conversation.service';
import {PrivacySettingsService} from './privacy-settings.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';

const CTX = 'conv-1';
const GROUP = 'Z3JvdXA=';
const OWN_DEVICE = 'device-a';
const OWN_USER = 'user-1';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        messageId: 'msg-1',
        content: 'SSBhbSB0aGUgc2VydmVy',
        authorId: 'user-2',
        conversationId: CTX,
        channelId: undefined,
        attachments: [],
        mentions: [],
        encryptionState: MessageEncryptionState.Encrypted,
        senderDeviceId: 'device-b',
        mlsGeneration: 1,
        ...overrides,
    };
}

function setup() {
    const handlers = new Map<string, (payload: never) => void>();
    const mls = {
        getOrCreateDeviceIdentifier: vi.fn(async () => OWN_DEVICE),
        getKnownGeneration: vi.fn(async () => 1 as number | null),
        getGroupId: vi.fn(async () => GROUP as string | null),
        getActiveGroupId: vi.fn(async () => GROUP as string | null),
        getCachedMessage: vi.fn<
            (
                contextId: string,
                generation: number | null,
                messageId: string,
                author?: string,
            ) => Promise<string | null>
        >(async () => null),
        cacheMessage: vi.fn(async () => undefined),
        getEncryptionFloor: vi.fn<(contextId: string) => Promise<number | null>>(async () => null),
        keyHandle: () => 'handle',
    };
    const sync = {
        decryptMessage: vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null),
        processPendingWelcomes: vi.fn(async () => undefined),
    };

    TestBed.configureTestingModule({
        providers: [
            MessagingWebsocketService,
            MlsHealthService,
            {provide: MlsService, useValue: mls},
            {provide: MlsSyncService, useValue: sync},
            {
                provide: ProfileService,
                useValue: {
                    ownProfile: () => ({userId: OWN_USER}),
                    getByUserId: () => of(null),
                },
            },
            {provide: NotificationService, useValue: {createNotification: vi.fn(async () => undefined)}},
            {provide: ConversationService, useValue: {}},
            // Only the typing gate is read here (T2-18). Stubbed rather than real so this spec does
            // not have to stand up ApiConfigService and the OAuth stack behind it.
            {provide: PrivacySettingsService, useValue: {sendTypingIndicators: () => true}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: vi.fn((event: string, handler: (payload: never) => void) => {
                        handlers.set(event, handler);
                    }),
                    start: vi.fn(async () => undefined),
                    connectionState: () => ConnectionState.Connected,
                },
            },
        ],
    });

    const service = TestBed.inject(MessagingWebsocketService);
    const emitted: MessageDto[] = [];
    service.messageObservable.subscribe(m => emitted.push(m));

    // `handleMessageCreated` is private and driven by a private subject; the alternative is
    // reaching through a `realtime.on` handler that this double never invokes.
    const handle = (data: Record<string, unknown>) =>
        (service as unknown as {handleMessageCreated(d: unknown): Promise<void>}).handleMessageCreated(data);

    return {service, mls, sync, emitted, handle, handlers, health: TestBed.inject(MlsHealthService)};
}

describe('MessagingWebsocketService live messages', () => {
    // ─── H2 / §L.9: server-supplied encryption state must not downgrade ───────

    it('refuses a Plain message in a context this device has encrypted', async () => {
        const {mls, emitted, handle, health} = setup();
        mls.getEncryptionFloor.mockResolvedValue(2);

        await handle(payload({encryptionState: MessageEncryptionState.Plain}));

        // Rendered as unverified, not as the named author's words. The decryptor is skipped for a
        // `Plain` message, so nothing else on this path would have questioned it.
        expect(emitted[0].undecryptable).toBe(true);
        expect(health.healthOf(CTX)?.reason).toBe('downgraded');
    });

    it('renders a Plain message normally where no floor exists', async () => {
        const {mls, emitted, handle} = setup();
        mls.getEncryptionFloor.mockResolvedValue(null);

        await handle(payload({encryptionState: MessageEncryptionState.Plain, content: 'aGk='}));

        expect(emitted[0].undecryptable).toBe(false);
        expect(emitted[0].content).toBe('aGk=');
    });

    // ─── H1: the plaintext cache must not be addressable by the server ────────

    it('looks the cache up on the context and generation, not the id alone', async () => {
        const {mls, handle} = setup();

        await handle(payload());

        expect(mls.getCachedMessage).toHaveBeenCalledWith(CTX, 1, 'msg-1', 'user-2');
    });

    it('stores a fresh decrypt under the composite key with its authenticated author', async () => {
        const {sync, mls, handle} = setup();
        sync.decryptMessage.mockResolvedValue('cGxhaW4=');

        await handle(payload());

        expect(mls.cacheMessage).toHaveBeenCalledWith(CTX, 1, 'msg-1', 'cGxhaW4=', 'user-2');
    });

    // ─── L3: `senderDeviceId` is a server field, so the drop must be bounded ──

    it('drops a message the server says this device sent, when it also says we wrote it', async () => {
        const {emitted, handle} = setup();

        await handle(payload({senderDeviceId: OWN_DEVICE, authorId: OWN_USER}));

        // The genuine case: our own plaintext is already in the store from the send flow, and our
        // own ciphertext cannot be decrypted by us.
        expect(emitted).toHaveLength(0);
    });

    it("does not let the device label suppress another author's message", async () => {
        const {emitted, handle} = setup();

        // Unbounded, this was a suppression primitive: the server could hide *any* message from
        // the live view just by labelling it as ours.
        await handle(payload({senderDeviceId: OWN_DEVICE, authorId: 'user-2'}));

        expect(emitted).toHaveLength(1);
        expect(emitted[0].authorId).toBe('user-2');
    });
});

/**
 * §B / §L.3: the server pushes a join request to every member of the conversation, the requester's
 * own account included. Nothing here listened for it, so every admission request a real user filed
 * arrived, was dropped, and the request sat Pending until it expired - the reported symptom being
 * a desktop that could never read a DM while the phone on the same account could.
 */
describe('MessagingWebsocketService admission requests', () => {
    it('listens for conversation.MlsJoinRequest at all', async () => {
        const {service, handlers} = setup();
        await service.start();

        expect(handlers.has('conversation.MlsJoinRequest')).toBe(true);
    });

    it('re-emits the push with the fingerprint a human is meant to compare', async () => {
        const {service, handlers} = setup();
        await service.start();

        const seen: unknown[] = [];
        service.mlsJoinRequestObservable.subscribe(event => seen.push(event));

        handlers.get('conversation.MlsJoinRequest')!({
            contextId: CTX,
            conversationId: CTX,
            channelId: null,
            requestId: 'mljr-1',
            requesterUserId: OWN_USER,
            requesterDeviceId: 'device-b',
            requesterDeviceName: 'Desktop',
            generation: 1,
            signatureKeyFingerprint: '517F4-D75A0-AD0A2-6BBCF',
            requiresManualApproval: false,
        } as never);

        expect(seen).toEqual([
            {
                contextId: CTX,
                isChannel: false,
                generation: 1,
                requestId: 'mljr-1',
                requesterUserId: OWN_USER,
                requesterDeviceId: 'device-b',
                requesterDeviceName: 'Desktop',
                signatureKeyFingerprint: '517F4-D75A0-AD0A2-6BBCF',
                requiresManualApproval: false,
            },
        ]);
    });
});
