/**
 * The restore half of the §D backup, and the ordering that keeps a failure from half-applying.
 *
 * <p>The logout dialog offers "sign out without losing your keys", writes the full envelope, then
 * wipes the keychain, the state file, the registry and the cache. `mls_import_backup` had no
 * TypeScript caller and no UI, so the file could not be read back - and the command dropped the
 * signing keypair, so even a wired restore would have worked until the app was next killed and
 * then looked exactly like lost keys.</p>
 */
import {TestBed} from '@angular/core/testing';
import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeMlsEngine} from '../platform/testing/fake-mls-engine';
import {FakeMlsLocalStoreFactory} from '../platform/testing/fake-mls-local-store';
import {MlsBackupImportError, MlsBackupImportResult, MlsService} from './mls.service';
import {DeviceIdentityService} from './device-identity.service';
import {describeImportFailure} from '../features/settings/key-backup-restore/key-backup-restore.component';

/**
 * The engine and the key store as provided fakes, in place of `vi.mock`ing two Tauri modules.
 *
 * <p>What this file is about does not change with the host: the ordering that keeps a failed restore
 * from half-applying, and the fact that the signing keypair goes into the key store rather than only
 * into the session - a restore that set only the session handle worked until the app was next killed
 * and then looked exactly like lost keys. On web that store is IndexedDB rather than a keychain, which
 * is a downgrade `SecureStore.hardwareBacked` states; the ordering requirement is identical.</p>
 */
const invokeStub = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const engine = new FakeMlsEngine();
const localStores = new FakeMlsLocalStoreFactory();

/** The state key the message-cache seal is derived from, as a keychain would answer it. */
const STATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

class StubSecureStore extends SecureStore {
    readonly hardwareBacked = true;
    getItem = vi.fn(async (_key: string): Promise<string | null> => STATE_KEY);
    setItem = vi.fn(async (_key: string, _value: string): Promise<void> => undefined);
    removeItem = vi.fn(async (_key: string): Promise<void> => undefined);
}

const secureStore = new StubSecureStore();
const setItem = secureStore.setItem;

const DEVICE_ID = 'device-a';

function importResult(overrides: Partial<MlsBackupImportResult> = {}): MlsBackupImportResult {
    return {
        userId: 'user-1',
        deviceId: DEVICE_ID,
        createdAt: '2026-08-02T00:00:00Z',
        appVersion: '3.0.155',
        identity: 'user-1',
        keyHandle: 'handle-1',
        signingPublicKey: 'cHVia2V5',
        signingPrivateKey: 'cHJpdmtleQ==',
        engineRestored: true,
        groupRegistry: {'ctx-1#0': 'Z3JvdXA=', 'ctx-1#active': 0},
        messageCache: {'ctx-1#0#msg-1': 'aGVsbG8='},
        ...overrides,
    };
}

describe('MlsService.importBackup', () => {
    let service: MlsService;

    beforeEach(() => {
        invokeStub.mockReset();
        setItem.mockClear();
        secureStore.getItem.mockClear();
        engine.reset();
        engine.handler = invokeStub;
        localStores.reset();
        TestBed.configureTestingModule({
            providers: [
                MlsService,
                {provide: MlsEngine, useValue: engine},
                {provide: SecureStore, useValue: secureStore},
                {provide: MlsLocalStoreFactory, useValue: localStores},
                // Pinned, because the key-store entry names are `alpine_mls_{deviceId}_*` and this
                // test is specifically about which names get written.
                {provide: DeviceIdentityService, useValue: {deviceId: async () => DEVICE_ID}},
            ],
        });
        service = TestBed.inject(MlsService);
    });

    it('passes every argument the command requires', async () => {
        invokeStub.mockResolvedValue(importResult() as never);

        await service.importBackup('<blob>', 'pass', 'user-1');

        const [command, args] = invokeStub.mock.calls.at(-1)!;
        expect(command).toBe('mls_import_backup');
        expect(Object.keys(args as object).sort())
            .toEqual(['blob', 'currentDeviceId', 'expectedUserId', 'passphrase']);
        // Checked in Rust against the blob's own `userId`, and refused on a mismatch, so a blob for
        // another account cannot be merged into this one.
        expect((args as Record<string, unknown>)['expectedUserId']).toBe('user-1');
    });

    it('writes the restored signing keypair to the OS keychain', async () => {
        invokeStub.mockResolvedValue(importResult() as never);

        await service.importBackup('<blob>', 'pass', 'user-1');

        // <b>The bug this exists for.</b> `autoUnlock` reads the pair out of the keychain on every
        // cold start; an import that only set the session handle restored a device that worked
        // until the app was next killed. A test asserting only "import resolved" would have passed
        // against exactly that code.
        const stored = Object.fromEntries(setItem.mock.calls.map(([k, v]) => [k, v]));
        expect(stored['alpine_mls_device-a_pub']).toBe('cHVia2V5');
        expect(stored['alpine_mls_device-a_priv']).toBe('cHJpdmtleQ==');
        expect(stored['alpine_mls_device-a_identity']).toBe('user-1');
    });

    it('restores the group registry, without which every context reads as unencrypted', async () => {
        invokeStub.mockResolvedValue(importResult() as never);

        await service.importBackup('<blob>', 'pass', 'user-1');

        expect(await service.getGroupId('ctx-1', 0)).toBe('Z3JvdXA=');
        expect(await service.getKnownGeneration('ctx-1')).toBe(0);
    });

    it('restores the message cache under the keys the export carried', async () => {
        invokeStub.mockResolvedValue(importResult() as never);

        await service.importBackup('<blob>', 'pass', 'user-1');

        // Composite keys survive as composite keys. Re-deriving them here would have to guess a
        // context for every entry, and a guess that lands wrong is one conversation's plaintext
        // filed under another's.
        expect(await service.getCachedMessage('ctx-1', 0, 'msg-1')).toBe('aGVsbG8=');
    });

    it('keeps the session handle so the restored device can act immediately', async () => {
        invokeStub.mockResolvedValue(importResult() as never);
        await service.importBackup('<blob>', 'pass', 'user-1');
        expect(service.keyHandle()).toBe('handle-1');
    });

    it('reports what §D actually restored rather than deciding again on this side', async () => {
        invokeStub.mockResolvedValue(importResult({engineRestored: false}) as never);

        const result = await service.importBackup('<blob>', 'pass', 'user-1');

        // The discriminator is the device id alone and it is enforced in Rust. A second opinion
        // here is exactly how the "engine holds no groups" clause crept into an earlier draft of
        // §D and would have cloned ratchet state onto every new device.
        expect(result.engineRestored).toBe(false);
        // Everything §D does allow still comes across.
        expect(await service.getGroupId('ctx-1', 0)).toBe('Z3JvdXA=');
    });

    // ─── The encryption floor must not go backwards ───────────────────────────
    //
    // The registry is not a bag of values. `#floor` is the monotonic encryption floor - written
    // once, deliberately never deleted - and it is the one thing standing between a context that
    // was encrypted and a message composed into it in the clear. The import wrote every restored
    // key with a plain `set()`, so restoring an older backup lowered it and the very next message
    // went out as plaintext into a conversation whose whole point was that it could not. No group
    // keys required and no MLS property broken; the client simply stopped using them.

    describe('encryption floor', () => {
        it('does not lower the floor when an older backup is restored', async () => {
            await service.registerGroup('ctx-1', 5, 'Y3VycmVudA==');
            expect(await service.getEncryptionFloor('ctx-1')).toBe(5);

            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-1#2': 'b2xk', 'ctx-1#floor': 2, 'ctx-1#active': 2},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            expect(await service.getEncryptionFloor('ctx-1')).toBe(5);
        });

        it('raises the floor when the backup knows of a later generation', async () => {
            await service.registerGroup('ctx-1', 5, 'Y3VycmVudA==');

            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-1#7': 'bmV3ZXI=', 'ctx-1#floor': 7, 'ctx-1#active': 7},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            expect(await service.getEncryptionFloor('ctx-1')).toBe(7);
        });

        it('leaves an equal floor alone', async () => {
            await service.registerGroup('ctx-1', 5, 'Y3VycmVudA==');

            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-1#floor': 5},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            expect(await service.getEncryptionFloor('ctx-1')).toBe(5);
        });

        it('sets a floor for a context this device has never encrypted', async () => {
            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-new#3': 'Zg==', 'ctx-new#floor': 3},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            expect(await service.getEncryptionFloor('ctx-new')).toBe(3);
        });

        it('does not move the active generation back below the floor', async () => {
            await service.registerGroup('ctx-1', 5, 'Y3VycmVudA==');

            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-1#2': 'b2xk', 'ctx-1#floor': 2, 'ctx-1#active': 2},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            // A restored "currently on generation 2" for a context this device has since encrypted
            // at 5 is stale information about the present, not evidence about it.
            expect(await service.getKnownGeneration('ctx-1')).toBe(5);
        });

        it('takes the active generation when it is at or above the floor', async () => {
            await service.registerGroup('ctx-1', 5, 'Y3VycmVudA==');

            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-1#9': 'bmV3', 'ctx-1#floor': 9, 'ctx-1#active': 9},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            expect(await service.getKnownGeneration('ctx-1')).toBe(9);
        });

        it('still restores the per-generation group mappings from an older backup', async () => {
            await service.registerGroup('ctx-1', 5, 'Y3VycmVudA==');

            invokeStub.mockResolvedValue(importResult({
                groupRegistry: {'ctx-1#2': 'b2xk', 'ctx-1#floor': 2, 'ctx-1#active': 2},
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            // Additive by construction: two eras of one context are different groups and the
            // messages from the older era still need its keys. Refusing the downgrade must not
            // cost the user the history the backup was restored for.
            expect(await service.getGroupId('ctx-1', 2)).toBe('b2xk');
            expect(await service.getGroupId('ctx-1', 5)).toBe('Y3VycmVudA==');
        });
    });

    // ─── The §H account identity keypair ──────────────────────────────────────

    describe('account identity key', () => {
        it('stores both halves when the envelope carried them', async () => {
            invokeStub.mockResolvedValue(importResult({
                accountIdentityPublicKey: 'YWNjLXB1Yg==',
                accountIdentityPrivateKey: 'YWNjLXByaXY=',
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            const stored = Object.fromEntries(setItem.mock.calls.map(([k, v]) => [k, v]));
            expect(stored['alpine_mls_device-a_account_identity_pub']).toBe('YWNjLXB1Yg==');
            expect(stored['alpine_mls_device-a_account_identity_priv']).toBe('YWNjLXByaXY=');
        });

        it('writes nothing when the envelope carried none', async () => {
            invokeStub.mockResolvedValue(importResult() as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            const written = setItem.mock.calls.map(([k]) => k);
            expect(written.some(k => k.includes('account_identity'))).toBe(false);
        });

        it('writes nothing when only one half is present', async () => {
            invokeStub.mockResolvedValue(importResult({
                accountIdentityPublicKey: 'YWNjLXB1Yg==',
                accountIdentityPrivateKey: null,
            }) as never);

            await service.importBackup('<blob>', 'pass', 'user-1');

            // A public key with no private half is not a usable identity, and storing it would
            // make the next export emit a broken `accountIdentity` section where a *missing* one
            // is what venta-mobile's import correctly tolerates.
            const written = setItem.mock.calls.map(([k]) => k);
            expect(written.some(k => k.includes('account_identity'))).toBe(false);
        });
    });

    // ─── Failure classification ───────────────────────────────────────────────
    //
    // The remedies are disjoint and mutually useless. Collapsing them is the C2 mistake: an
    // argument rejection reported as a credential rejection sends someone hunting for a password
    // that was never the problem.

    const cases: [string, string][] = [
        ['MlsError: not a backup file: EOF while parsing', 'not-a-backup'],
        // Two versions, two remedies, and only one of them is "update". These strings are produced
        // by `import_backup` in mls.rs and asserted there too, so the split cannot drift.
        ['MlsError: backup version 2 is newer than this build supports', 'unsupported-version-newer'],
        ['MlsError: backup version 0 is older than this build supports', 'unsupported-version-older'],
        ['MlsError: unsupported backup cipher or key derivation', 'unsupported-version-newer'],
        ['MlsError: refusing declared Argon2 parameters (m=4294967295 KiB, t=3, p=4) - above the',
            'hostile-kdf-parameters'],
        ['MlsError: this backup belongs to a different account (user-9), not the one signed in',
            'wrong-account'],
        ['MlsError: backup header does not match its contents', 'header-mismatch'],
        ['MlsError: could not open the backup - wrong passphrase, or the file has been altered',
            'wrong-passphrase-or-altered'],
        ['MlsError: backup has no signing key', 'malformed-contents'],
        ['MlsError: backup engine state is unreadable: invalid type', 'malformed-contents'],
    ];

    for (const [engineError, reason] of cases) {
        it(`classifies "${engineError.slice(0, 44)}…" as ${reason}`, async () => {
            invokeStub.mockRejectedValue(engineError as never);

            await expect(service.importBackup('<blob>', 'pass', 'user-1'))
                .rejects.toMatchObject({reason});
        });
    }

    it('does not report an unrecognised engine failure as a wrong passphrase', async () => {
        invokeStub.mockRejectedValue('something nobody anticipated' as never);

        // The allow-list falls through to `engine-failed`, never to the passphrase. Telling someone
        // their passphrase is wrong when it is not is the failure the whole classification exists
        // to prevent, and an unrecognised error is by definition not evidence about it.
        await expect(service.importBackup('<blob>', 'pass', 'user-1'))
            .rejects.toMatchObject({reason: 'engine-failed'});
    });

    it('touches no local store when the engine refuses', async () => {
        const wrongAccount =
            'MlsError: this backup belongs to a different account (user-9), not the one signed in';
        invokeStub.mockRejectedValue(wrongAccount as never);

        await expect(service.importBackup('<blob>', 'pass', 'user-1')).rejects.toBeTruthy();

        // Nothing half-applied: no keychain write, no registry entry, no session handle.
        expect(setItem).not.toHaveBeenCalled();
        expect(await service.getGroupId('ctx-1', 0)).toBeNull();
        expect(service.keyHandle()).toBeUndefined();
    });

    it('reports a local-store failure as itself, not as a bad backup', async () => {
        invokeStub.mockResolvedValue(importResult() as never);
        setItem.mockRejectedValueOnce(new Error('keychain locked'));

        await expect(service.importBackup('<blob>', 'pass', 'user-1'))
            .rejects.toMatchObject({reason: 'local-store-failed'});
    });
});

describe('describeImportFailure', () => {
    it('gives each failure its own remedy', () => {
        const reasons = [
            'not-a-backup', 'unsupported-version-newer', 'unsupported-version-older',
            'wrong-passphrase-or-altered', 'wrong-account',
            'header-mismatch', 'hostile-kdf-parameters', 'malformed-contents',
            'local-store-failed', 'engine-failed',
        ] as const;

        const messages = reasons.map(r =>
            describeImportFailure(new MlsBackupImportError(r, 'detail')));

        // Distinct, because the actions they ask for are distinct - and a message repeated across
        // two causes is a message that is wrong for at least one of them.
        expect(new Set(messages).size).toBe(reasons.length);
    });

    it('tells only the newer case to update', () => {
        const newer = describeImportFailure(
            new MlsBackupImportError('unsupported-version-newer', 'detail'));
        const older = describeImportFailure(
            new MlsBackupImportError('unsupported-version-older', 'detail'));

        expect(newer).toMatch(/update/i);
        // Advice that cannot work, and that leaves someone further from the build that could have
        // read their file if they act on it. One message for both said exactly this.
        expect(older).not.toMatch(/update and try again/i);
        expect(older).toMatch(/too old/i);
    });

    it('says a wrong passphrase and an altered file cannot be told apart', () => {
        const message = describeImportFailure(
            new MlsBackupImportError('wrong-passphrase-or-altered', 'detail'));

        // AES-GCM cannot distinguish a wrong key from altered bytes, and claiming otherwise sends
        // someone to re-type a passphrase at a truncated file.
        expect(message).toMatch(/passphrase/i);
        expect(message).toMatch(/altered|truncated/i);
    });

    it('states plainly that an engine failure is not the passphrase', () => {
        const message = describeImportFailure(new MlsBackupImportError('engine-failed', 'boom'));
        expect(message).toMatch(/not the problem/i);
        expect(message).toContain('boom');
    });
});
