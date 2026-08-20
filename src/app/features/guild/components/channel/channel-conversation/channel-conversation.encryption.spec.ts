/**
 * Characterization of the three encryption states a channel can be in for this device, what they
 * gate, and what re-linking the device does. Written against the component before the encryption
 * mechanics moved out, and re-pointed at the service they moved to with the assertions unaltered.
 */
import {Provider} from '@angular/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {mlsStub, mlsSyncStub, settle, setup} from './channel-conversation.harness';
import {MlsService} from '../../../../../services/mls.service';
import {MlsSyncService} from '../../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../../services/mls-join-request.service';

/** True while the composer has to resolve proxy tags itself, which only an encrypted channel needs. */
function resolvesPersonaLocally(component: unknown): boolean {
    return (component as {resolvePersonaLocally: () => boolean}).resolvePersonaLocally();
}

async function setupWith(providers: Provider[]) {
    const harness = await setup('ok', [], null, {providers});
    await settle();
    return harness;
}

describe('ChannelConversationComponent encryption state', () => {
    it('reads a channel the server calls unencrypted as plain', async () => {
        const {component, encryption} = await setupWith([]);

        expect(encryption.state()).toBe('plain');
        expect(encryption.isLockedOut()).toBe(false);
        expect(resolvesPersonaLocally(component)).toBe(false);
    });

    it('reads an encrypted channel this device holds a group for as joined', async () => {
        const {component, encryption} = await setupWith([
            {
                provide: MlsService,
                useValue: mlsStub({getActiveGroupId: vi.fn(async () => 'grp_1' as string | null)}),
            },
            {
                provide: MlsSyncService,
                useValue: mlsSyncStub({refreshState: vi.fn(async () => ({encrypted: true}))}),
            },
        ]);

        expect(encryption.state()).toBe('joined');
        expect(encryption.isLockedOut()).toBe(false);
        expect(resolvesPersonaLocally(component)).toBe(true);
    });

    it('reads an encrypted channel this device was never admitted to as locked out', async () => {
        const {encryption} = await setupWith([
            {
                provide: MlsSyncService,
                useValue: mlsSyncStub({refreshState: vi.fn(async () => ({encrypted: true}))}),
            },
        ]);

        expect(encryption.state()).toBe('locked-out');
        expect(encryption.isLockedOut()).toBe(true);
    });

    it('never calls a channel plain again once this device has held a generation for it', async () => {
        const {encryption} = await setupWith([
            {
                provide: MlsService,
                useValue: mlsStub({getEncryptionFloor: vi.fn(async () => 4 as number | null)}),
            },
        ]);

        expect(encryption.state()).toBe('downgraded');
        expect(encryption.isLockedOut()).toBe(false);
    });

    it('leaves the last known state alone when the lookup fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const {encryption} = await setupWith([
            {
                provide: MlsSyncService,
                useValue: mlsSyncStub({
                    refreshState: vi.fn(async () => {
                        throw new Error('offline');
                    }),
                }),
            },
        ]);

        // Not a downgrade to plain: guessing plaintext is how ciphertext gets posted in the clear.
        expect(encryption.state()).toBe('plain');
    });
});

describe('ChannelConversationComponent device re-link', () => {
    let relink: ReturnType<typeof vi.fn>;
    let getActiveGroupId: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        relink = vi.fn(async () => ({state: 'requested'}));
        getActiveGroupId = vi.fn(async () => null as string | null);
    });

    function providers(status: unknown = null): Provider[] {
        return [
            {provide: MlsService, useValue: mlsStub({getActiveGroupId})},
            {
                provide: MlsSyncService,
                useValue: mlsSyncStub({refreshState: vi.fn(async () => ({encrypted: true}))}),
            },
            {provide: MlsJoinRequestService, useValue: {statusOf: () => status, relink}},
        ];
    }

    it('re-links this channel, as a channel', async () => {
        const {encryption} = await setupWith(providers());

        await encryption.relink();

        expect(relink).toHaveBeenCalledWith('chan1', true);
    });

    it('re-reads the state, so a device that got admitted can post again', async () => {
        const {encryption} = await setupWith(providers());
        getActiveGroupId.mockResolvedValue('grp_1');

        await encryption.relink();

        expect(encryption.state()).toBe('joined');
        expect(encryption.isLockedOut()).toBe(false);
    });

    it('stays locked out when the re-link did not get this device admitted', async () => {
        const {encryption} = await setupWith(providers());

        await encryption.relink();

        expect(encryption.state()).toBe('locked-out');
        expect(encryption.isLockedOut()).toBe(true);
    });

    it('shows what the last attempt achieved', async () => {
        const status = {tone: 'working', message: 'Checking this device...'};
        const {encryption} = await setupWith(providers(status));

        expect(encryption.relinkStatus()).toBe(status);
    });
});
