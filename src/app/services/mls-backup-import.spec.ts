/**
 * The restore half of the §D backup, and the ordering that keeps a failure from half-applying.
 *
 * <p>The logout dialog offers "sign out without losing your keys", writes the full envelope, then
 * wipes the keychain, the state file, the registry and the cache. `mls_import_backup` had no
 * TypeScript caller and no UI, so the file could not be read back - and the command dropped the
 * signing keypair, so even a wired restore would have worked until the app was next killed and
 * then looked exactly like lost keys.</p>
 */
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
}));
vi.mock('tauri-plugin-secure-storage-api', () => ({
    secureStorage: {
        getItem: vi.fn(async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
    LazyStore: class {
        private readonly values = new Map<string, unknown>();
        async get<T>(key: string) { return this.values.get(key) as T | undefined; }
        async set(key: string, value: unknown) { this.values.set(key, value); }
        async delete(key: string) { this.values.delete(key); }
        async entries<T>() { return [...this.values.entries()] as [string, T][]; }
        async clear() { this.values.clear(); }
        async save() { }
    },
}));

import {TestBed} from '@angular/core/testing';
import {invoke} from '@tauri-apps/api/core';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {MlsBackupImportError, MlsBackupImportResult, MlsService} from './mls.service';
import {DeviceIdentityService} from './device-identity.service';
import {describeImportFailure} from '../features/settings/key-backup-restore/key-backup-restore.component';

const invokeStub = vi.mocked(invoke);
const setItem = vi.mocked(secureStorage.setItem);

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
        TestBed.configureTestingModule({
            providers: [
                MlsService,
                // Pinned, because the keychain entry names are `alpine_mls_{deviceId}_*` and this
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

    // ─── Failure classification ───────────────────────────────────────────────
    //
    // The remedies are disjoint and mutually useless. Collapsing them is the C2 mistake: an
    // argument rejection reported as a credential rejection sends someone hunting for a password
    // that was never the problem.

    const cases: [string, string][] = [
        ['MlsError: not a backup file: EOF while parsing', 'not-a-backup'],
        ['MlsError: backup version 2 is not supported by this build', 'unsupported-version'],
        ['MlsError: unsupported backup cipher or key derivation', 'unsupported-version'],
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
            'not-a-backup', 'unsupported-version', 'wrong-passphrase-or-altered', 'wrong-account',
            'header-mismatch', 'hostile-kdf-parameters', 'malformed-contents',
            'local-store-failed', 'engine-failed',
        ] as const;

        const messages = reasons.map(r =>
            describeImportFailure(new MlsBackupImportError(r, 'detail')));

        // Distinct, because the actions they ask for are distinct - and a message repeated across
        // two causes is a message that is wrong for at least one of them.
        expect(new Set(messages).size).toBe(reasons.length);
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
