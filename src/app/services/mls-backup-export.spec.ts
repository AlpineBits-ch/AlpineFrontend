/** The §D export: anything this envelope omits is destroyed by the sign-out wipe moments later. */
import {TestBed} from '@angular/core/testing';
import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeMlsEngine} from '../platform/testing/fake-mls-engine';
import {FakeMlsLocalStoreFactory} from '../platform/testing/fake-mls-local-store';
import {MlsFeatureUnavailableError, MlsService} from './mls.service';
import {DeviceIdentityService} from './device-identity.service';

/** The engine and key store as provided fakes; these assert the entry names, so both stay ports. */
const invokeStub = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const engine = new FakeMlsEngine();
const localStores = new FakeMlsLocalStoreFactory();

class StubSecureStore extends SecureStore {
    readonly hardwareBacked = true;
    getItem = vi.fn(async (_key: string): Promise<string | null> => null);
    setItem = vi.fn(async (_key: string, _value: string): Promise<void> => undefined);
    removeItem = vi.fn(async (_key: string): Promise<void> => undefined);
}

const secureStore = new StubSecureStore();
const getItem = secureStore.getItem;

const DEVICE_ID = 'device-a';
const STATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

let service: MlsService;

/** The last `mls_export_backup` invocation's arguments. */
function exportArgs(): Record<string, unknown> {
    const call = invokeStub.mock.calls.find(([cmd]) => cmd === 'mls_export_backup');
    return (call?.[1] ?? {}) as Record<string, unknown>;
}

/** A keychain holding the state key, plus whatever else the test names. */
function keychain(extra: Record<string, string> = {}): void {
    getItem.mockImplementation(async (name: string) => {
        if (name.endsWith('_statekey')) return STATE_KEY;
        return extra[name] ?? null;
    });
}

beforeEach(() => {
    invokeStub.mockReset();
    getItem.mockReset();
    keychain();
    engine.reset();
    engine.handler = invokeStub;
    localStores.reset();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            MlsService,
            {provide: MlsEngine, useValue: engine},
            {provide: SecureStore, useValue: secureStore},
            {provide: MlsLocalStoreFactory, useValue: localStores},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => DEVICE_ID}},
        ],
    });
    service = TestBed.inject(MlsService);
    service.keyHandle.set('handle-1');
    invokeStub.mockResolvedValue('<envelope>' as never);
});

describe('MlsService.exportBackup', () => {
    it('passes every argument the command requires', async () => {
        await service.exportBackup('pass', 'user-1', '3.0.165', false);

        const args = exportArgs();
        expect(args['passphrase']).toBe('pass');
        expect(args['userId']).toBe('user-1');
        expect(args['appVersion']).toBe('3.0.165');
        expect(args['deviceId']).toBe(DEVICE_ID);
        expect(args['keyHandle']).toBe('handle-1');
    });

    it('refuses a locked session before reading anything', async () => {
        service.keyHandle.set(undefined);

        await expect(service.exportBackup('pass', 'user-1', '3.0.165', true))
            .rejects.toThrow(/locked/i);

        // The signing key never crosses IPC, so without a handle there is nothing to export.
        expect(invokeStub).not.toHaveBeenCalled();
    });

    it('reports a build with no export engine as unavailable, not as a failure', async () => {
        invokeStub.mockRejectedValue(
            'Command mls_export_backup not found' as never,
        );

        // Reported as a failure it sends the user back to retry something that can never succeed.
        await expect(service.exportBackup('pass', 'user-1', '3.0.165', false))
            .rejects.toBeInstanceOf(MlsFeatureUnavailableError);
    });

    describe('the message cache', () => {
        it('is omitted when the caller says so', async () => {
            await service.cacheMessage('ctx-1', 0, 'msg-1', 'aGVsbG8=', 'user-1');

            await service.exportBackup('pass', 'user-1', '3.0.165', false);

            // The most sensitive thing in the envelope: including it must be an explicit choice.
            expect(exportArgs()['messageCache']).toBeUndefined();
        });

        it('is sent as plaintext under its stored keys when the caller asks for it', async () => {
            await service.cacheMessage('ctx-1', 0, 'msg-1', 'aGVsbG8=', 'user-1');

            await service.exportBackup('pass', 'user-1', '3.0.165', true);

            // Keyed by the stored key, so a restore does not collapse one message id across contexts.
            expect(exportArgs()['messageCache']).toEqual({'ctx-1#0#msg-1': 'aGVsbG8='});
        });

        it('skips an entry this device can no longer open', async () => {
            await service.cacheMessage('ctx-1', 0, 'good', 'aGVsbG8=', 'user-1');
            const store = await (service as unknown as {
                cacheStore(): Promise<{set(k: string, v: unknown): Promise<void>}>
            }).cacheStore();
            await store.set('ctx-1#0#broken', {v: 1, at: Date.now(), iv: 'AAAA', ct: 'bm90'});

            await service.exportBackup('pass', 'user-1', '3.0.165', true);

            // An entry that will not unseal must not be exported as the garbage it decrypts to.
            expect(exportArgs()['messageCache']).toEqual({'ctx-1#0#good': 'aGVsbG8='});
        });
    });

    describe('the group registry', () => {
        it('is sent whole, floor and active generation included', async () => {
            await service.registerGroup('ctx-1', 3, 'Z3JvdXA=');

            await service.exportBackup('pass', 'user-1', '3.0.165', false);

            expect(exportArgs()['groupRegistry']).toEqual({
                'ctx-1#3': 'Z3JvdXA=',
                'ctx-1#active': 3,
                'ctx-1#floor': 3,
            });
        });

        it('is sent as an empty object when this device holds no groups', async () => {
            await service.exportBackup('pass', 'user-1', '3.0.165', false);

            expect(exportArgs()['groupRegistry']).toEqual({});
        });
    });

    describe('the account identity key', () => {
        it('is carried back out when this device holds one', async () => {
            keychain({
                [`alpine_mls_${DEVICE_ID}_account_identity_pub`]: 'YWNjLXB1Yg==',
                [`alpine_mls_${DEVICE_ID}_account_identity_priv`]: 'YWNjLXByaXY=',
            });

            await service.exportBackup('pass', 'user-1', '3.0.165', false);

            expect(exportArgs()['accountIdentity'])
                .toEqual({pub: 'YWNjLXB1Yg==', priv: 'YWNjLXByaXY='});
        });

        it('is absent when this device holds none', async () => {
            await service.exportBackup('pass', 'user-1', '3.0.165', false);

            // Absent rather than null: a half-formed field reads as an unusable identity key.
            expect(exportArgs()['accountIdentity']).toBeUndefined();
        });

        it('is absent when only one half is stored', async () => {
            keychain({
                [`alpine_mls_${DEVICE_ID}_account_identity_pub`]: 'YWNjLXB1Yg==',
            });

            await service.exportBackup('pass', 'user-1', '3.0.165', false);

            expect(exportArgs()['accountIdentity']).toBeUndefined();
        });

        it('does not stop a backup being written when the keychain will not answer', async () => {
            getItem.mockImplementation(async (name: string) => {
                if (name.endsWith('_statekey')) return STATE_KEY;
                throw new Error('keychain locked');
            });

            await expect(service.exportBackup('pass', 'user-1', '3.0.165', false))
                .resolves.toBe('<envelope>');

            // This is the logout path; the alternative to a backup missing a field is no keys at all.
            expect(exportArgs()['accountIdentity']).toBeUndefined();
        });
    });

    describe('round trip with the import side', () => {
        it('reproduces the registry it was taken from', async () => {
            await service.registerGroup('ctx-1', 3, 'Z3JvdXA=');
            await service.exportBackup('pass', 'user-1', '3.0.165', true);
            const exported = exportArgs()['groupRegistry'] as Record<string, string | number>;

            // A fresh device, handed exactly what the export produced.
            TestBed.resetTestingModule();
            TestBed.configureTestingModule({
                providers: [
                    MlsService,
                    {provide: MlsEngine, useValue: engine},
                    {provide: SecureStore, useValue: secureStore},
                    // The same factory instance, so "device-b" genuinely opens different files.
                    {provide: MlsLocalStoreFactory, useValue: localStores},
                    {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-b'}},
                ],
            });
            const restored = TestBed.inject(MlsService);
            invokeStub.mockResolvedValue({
                userId: 'user-1',
                deviceId: DEVICE_ID,
                createdAt: '2026-08-03T00:00:00Z',
                appVersion: '3.0.165',
                identity: 'user-1',
                keyHandle: 'handle-2',
                signingPublicKey: 'cHVi',
                signingPrivateKey: 'cHJpdg==',
                engineRestored: false,
                groupRegistry: exported,
                messageCache: {},
            } as never);

            await restored.importBackup('<blob>', 'pass', 'user-1');

            expect(await restored.getGroupId('ctx-1', 3)).toBe('Z3JvdXA=');
            expect(await restored.getKnownGeneration('ctx-1')).toBe(3);
            expect(await restored.getEncryptionFloor('ctx-1')).toBe(3);
        });
    });
});
