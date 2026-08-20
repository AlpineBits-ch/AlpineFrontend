/**
 * Characterization of everything the send path carries: the persona a message is spoken as, the
 * draft's own fields, and the encrypted branch. Written against the component before the send
 * mechanics moved out, so it is evidence the move changed nothing.
 */
import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {
    mlsStub,
    mlsSyncStub,
    messageFixture,
    personaFixture,
    sendPayload,
    settle,
    setup,
} from './channel-conversation.harness';
import {MlsService} from '../../../../../services/mls.service';
import {MlsSyncService} from '../../../../../services/mls-sync.service';
import {PersonaService} from '../../../../../services/persona.service';
import {SceneService} from '../../../../../services/scene.service';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';

/** The MLS stub the component was handed, so a spec can read the calls back off it. */
function mls() {
    return TestBed.inject(MlsService) as unknown as ReturnType<typeof mlsStub>;
}

describe('ChannelConversationComponent send draft', () => {
    it('passes the draft through to the server untouched', async () => {
        const {component, messaging} = await setup();

        component.createMessage(
            sendPayload({
                attachments: ['atac_1'],
                inReplyTo: 'mesg_parent',
                mentions: ['u2'],
                roleMentions: ['role_1'],
                personaMentions: ['pers_2'],
                mentionsEveryone: true,
                mentionsHere: true,
            }),
        );
        await settle();

        expect(messaging.createMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'hello',
                channelId: 'chan1',
                conversationId: undefined,
                attachments: ['atac_1'],
                inReplyTo: 'mesg_parent',
                mentions: ['u2'],
                roleMentions: ['role_1'],
                personaMentions: ['pers_2'],
                mentionsEveryone: true,
                mentionsHere: true,
            }),
        );
    });

    it('carries the reply and the mentions on the optimistic copy, but no attachments yet', async () => {
        const {component, store} = await setup();

        component.createMessage(
            sendPayload({attachments: ['atac_1'], inReplyTo: 'mesg_parent', mentions: ['u2']}),
        );

        const optimistic = store.addMessage.mock.calls[0][0] as MessageDto;
        expect(optimistic.inReplyTo).toBe('mesg_parent');
        expect(optimistic.mentions).toEqual(['u2']);
        // The upload is only a list of ids here; the server answers with the resolved attachments.
        expect(optimistic.attachments).toEqual([]);
    });

    it('clears the reply chip on send', async () => {
        const {component} = await setup();
        const inner = component as unknown as {
            replyingTo: {set: (v: MessageDto | null) => void; (): MessageDto | null};
        };
        inner.replyingTo.set(messageFixture());

        component.createMessage(sendPayload({inReplyTo: 'mesg_1'}));

        expect(inner.replyingTo()).toBeNull();
    });
});

describe('ChannelConversationComponent send as a persona', () => {
    it('shows the character on the optimistic message', async () => {
        const {component, store} = await setup('ok', [], null, {
            providers: [
                {
                    provide: PersonaService,
                    useValue: {entry: () => personaFixture({displayName: 'Vera Cruz'}), identity: () => null},
                },
            ],
        });

        component.createMessage(sendPayload({personaId: 'pers_1'}));

        const optimistic = store.addMessage.mock.calls[0][0] as MessageDto;
        expect(optimistic.personaId).toBe('pers_1');
        expect(optimistic.authorDisplayName).toBe('Vera Cruz');
        expect(optimistic.authorAvatarUrl).toBe('https://cdn.test/vera.png');
    });

    it('leaves the display fields null when nothing is speaking', async () => {
        const {component, store} = await setup();

        component.createMessage(sendPayload());

        const optimistic = store.addMessage.mock.calls[0][0] as MessageDto;
        expect(optimistic.authorDisplayName).toBeNull();
        expect(optimistic.authorAvatarUrl).toBeNull();
    });

    it('tells the scene rail who just posted', async () => {
        const notePost = vi.fn();
        const {component} = await setup('ok', [], null, {
            providers: [
                {
                    provide: SceneService,
                    useValue: {
                        scenes: () => [],
                        scene: () => null,
                        speakableIds: () => [],
                        now: () => 0,
                        ensureGuild: vi.fn(),
                        refreshScene: vi.fn(),
                        notePost,
                        advanceTurn: () => of(null),
                    },
                },
            ],
        });

        component.createMessage(sendPayload({personaId: 'pers_1'}));

        expect(notePost).toHaveBeenCalledWith('g1', 'chan1', 'pers_1');
    });

    it('notes an out-of-character post with a null persona', async () => {
        const notePost = vi.fn();
        const {component} = await setup('ok', [], null, {
            providers: [
                {
                    provide: SceneService,
                    useValue: {
                        scenes: () => [],
                        scene: () => null,
                        speakableIds: () => [],
                        now: () => 0,
                        ensureGuild: vi.fn(),
                        refreshScene: vi.fn(),
                        notePost,
                        advanceTurn: () => of(null),
                    },
                },
            ],
        });

        component.createMessage(sendPayload());

        expect(notePost).toHaveBeenCalledWith('g1', 'chan1', null);
    });
});

describe('ChannelConversationComponent encrypted send', () => {
    async function setupEncrypted() {
        const harness = await setup('ok', [], null, {
            providers: [
                {
                    provide: MlsService,
                    useValue: mlsStub({
                        getKnownGeneration: vi.fn(async () => 3 as number | null),
                        getGroupId: vi.fn(async () => 'grp_1' as string | null),
                        keyHandle: vi.fn(() => 'key_1' as string | null),
                    }),
                },
                {
                    provide: MlsSyncService,
                    useValue: mlsSyncStub({refreshState: vi.fn(async () => ({encrypted: true}))}),
                },
            ],
        });
        // The server echoes back what it stored, which for this channel is ciphertext.
        harness.messaging.createMessage = vi.fn(() =>
            of(messageFixture({id: 'mesg_real', encryptionState: MessageEncryptionState.Encrypted})),
        );
        return harness;
    }

    it('seals the body and posts the ciphertext', async () => {
        const {component, messaging} = await setupEncrypted();

        component.createMessage(sendPayload());
        await settle();

        expect(mls().sendMessage).toHaveBeenCalledWith('grp_1', 'key_1', btoa('hello'));
        expect(messaging.createMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'ciphertext',
                encryptionState: MessageEncryptionState.Encrypted,
                mlsEpoch: 7,
                mlsGeneration: 3,
                senderDeviceId: 'dev1',
            }),
        );
    });

    it('keeps the plaintext on screen and caches it under the generation it sealed with', async () => {
        const {component, store} = await setupEncrypted();

        component.createMessage(sendPayload());
        await settle();

        expect(mls().cacheMessage).toHaveBeenCalledWith('chan1', 3, 'mesg_real', btoa('hello'), 'u1');
        const shown = store.confirmMessage.mock.calls[0][1] as MessageDto;
        expect(atob(shown.content)).toBe('hello');
    });

    it('refuses to post when this device holds no group for the channel', async () => {
        const {component, store, messaging} = await setup('ok', [], null, {
            providers: [
                {
                    provide: MlsService,
                    useValue: mlsStub({getKnownGeneration: vi.fn(async () => 3 as number | null)}),
                },
                {
                    provide: MlsSyncService,
                    useValue: mlsSyncStub({refreshState: vi.fn(async () => ({encrypted: true}))}),
                },
            ],
        });

        component.createMessage(sendPayload());
        await settle();

        expect(messaging.createMessage).not.toHaveBeenCalled();
        expect(store.failMessage).toHaveBeenCalled();
    });

    it('refuses cleartext once this device has ever held a generation here', async () => {
        const {component, store, messaging} = await setup('ok', [], null, {
            providers: [
                {
                    provide: MlsService,
                    useValue: mlsStub({getEncryptionFloor: vi.fn(async () => 2 as number | null)}),
                },
            ],
        });

        component.createMessage(sendPayload());
        await settle();

        expect(messaging.createMessage).not.toHaveBeenCalled();
        expect(store.failMessage).toHaveBeenCalled();
    });

    it('re-reads the channel and sends once more on a 409', async () => {
        const conflict = new HttpErrorResponse({status: 409});
        const createMessage = vi
            .fn()
            .mockReturnValueOnce(throwError(() => conflict))
            .mockReturnValueOnce(of(messageFixture({id: 'mesg_real'})));
        const refreshState = vi.fn(async () => ({encrypted: false}));

        const {component, store, messaging} = await setup('ok', [], null, {
            providers: [{provide: MlsSyncService, useValue: mlsSyncStub({refreshState})}],
        });
        // Swapped in after setup so the constructor's own refreshState call is not counted.
        messaging.createMessage = createMessage;
        refreshState.mockClear();

        component.createMessage(sendPayload());
        await settle();

        expect(createMessage).toHaveBeenCalledTimes(2);
        expect(refreshState).toHaveBeenCalledWith('chan1', true);
        expect(store.confirmMessage).toHaveBeenCalled();
    });
});
