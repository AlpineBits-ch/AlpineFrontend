import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, of, throwError} from 'rxjs';
import {MasterKeyStateService} from './master-key-state.service';
import {
    BackupService,
    MasterKeyWrappingDto,
    PutRecoveryKeyDto,
    RecoveryKeyDto,
} from './backup.service';
import {MasterKeyService} from './master-key.service';

function wrapping(overrides: Partial<MasterKeyWrappingDto> = {}): MasterKeyWrappingDto {
    return {
        kdf: 'argon2id',
        iterations: 3,
        memoryKiB: 65536,
        parallelism: 1,
        salt: 'c2FsdA==',
        iv: 'aXY=',
        cipherText: 'Y3Q=',
        ...overrides,
    };
}

function envelope(overrides: Partial<RecoveryKeyDto> = {}): RecoveryKeyDto {
    return {
        ...wrapping(),
        version: 1,
        recoveryCodeWrapping: wrapping({salt: 'b3RoZXI='}),
        passwordWrappingInvalidatedAt: null,
        encryptedHistoryRecoverable: true,
        ...overrides,
    };
}

function setup() {
    const backup = {
        getRecoveryKey: vi.fn<() => Observable<RecoveryKeyDto>>(() => of(envelope())),
        putRecoveryKey: vi.fn<(dto: PutRecoveryKeyDto) => Observable<{ version: number }>>(
            () => of({version: 1})),
        rewrapPassword: vi.fn<(version: number, w: MasterKeyWrappingDto) =>
            Observable<{ version: number; encryptedHistoryRecoverable: boolean }>>(
            () => of({version: 1, encryptedHistoryRecoverable: true})),
    };
    const masterKey = {
        rewrap: vi.fn(async () => ({
            cipherText: 'bmV3', salt: 'bmV3c2FsdA==', iv: 'bmV3aXY=',
            argon2Iterations: 3, argon2Memory: 65536, argon2Parallelism: 1, version: 1,
        })),
        generateRecoveryCode: vi.fn(async () => 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH'),
    };

    TestBed.configureTestingModule({
        providers: [
            MasterKeyStateService,
            {provide: BackupService, useValue: backup},
            {provide: MasterKeyService, useValue: masterKey},
        ],
    });

    return {state: TestBed.inject(MasterKeyStateService), backup, masterKey};
}

describe('MasterKeyStateService', () => {
    describe('reading the account state', () => {
        it('reports a healthy account as ok', async () => {
            const {state} = setup();
            expect(await state.refresh()).toBe('ok');
            expect(state.needsAttention()).toBe(false);
        });

        it('reports an account with no recovery-code wrapping', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));

            // Not broken yet - but one password reset away from being unrecoverable, which is
            // exactly the state nobody was ever told about.
            expect(await state.refresh()).toBe('recovery-code-missing');
            expect(state.needsAttention()).toBe(true);
        });

        it('reports a reset that needs re-wrapping', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({
                passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
            })));

            expect(await state.refresh()).toBe('rewrap-required');
        });

        it('reports a completed loss ahead of anything else', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({
                recoveryCodeWrapping: null,
                passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                encryptedHistoryRecoverable: false,
            })));

            // Already lost, not a prompt to do something: no password will ever open this key
            // again. Offering a repair here would be a lie.
            expect(await state.refresh()).toBe('unrecoverable');
        });

        it('treats a 404 as first-run rather than a fault', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(
                throwError(() => new HttpErrorResponse({status: 404})));

            expect(await state.refresh()).toBe('not-set-up');
            expect(state.needsAttention()).toBe(false);
        });

        it('keeps the previous verdict when the lookup fails', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({
                encryptedHistoryRecoverable: false,
            })));
            await state.refresh();

            backup.getRecoveryKey.mockReturnValue(
                throwError(() => new HttpErrorResponse({status: 500})));

            // Guessing 'ok' on a failed lookup is how a real loss goes unreported.
            expect(await state.refresh()).toBe('unrecoverable');
        });

        it('gates cloud engine backup on a healthy key', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();

            // The server refuses these without the second wrapping; saying why beats a disabled
            // control with no explanation.
            expect(state.canUseCloudEngineBackup()).toBe(false);
        });
    });

    describe('re-wrapping after a reset', () => {
        it('re-wraps from the recovery code at the same version', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({
                passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
            })));
            await state.refresh();

            const ok = await state.rewrapUnderNewPassword('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', 'new-pw');

            expect(ok).toBe(true);
            expect(masterKey.rewrap).toHaveBeenCalled();
            // Same version: this re-wraps the key the account already has. A different one would
            // orphan every blob sealed under the current version.
            expect(backup.rewrapPassword.mock.calls[0]![0]).toBe(1);
        });

        it('reports a wrong recovery code without writing anything', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({
                passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
            })));
            await state.refresh();
            masterKey.rewrap.mockRejectedValue(new Error('Decryption failed'));

            expect(await state.rewrapUnderNewPassword('WRONG', 'new-pw')).toBe(false);
            expect(backup.rewrapPassword).not.toHaveBeenCalled();
        });

        it('cannot re-wrap an account that never had a recovery code', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({
                recoveryCodeWrapping: null,
                encryptedHistoryRecoverable: false,
            })));
            await state.refresh();

            expect(await state.rewrapUnderNewPassword('anything', 'new-pw')).toBe(false);
            expect(backup.rewrapPassword).not.toHaveBeenCalled();
        });
    });

    describe('retrofitting a recovery code', () => {
        it('adds the second wrapping without raising the version', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();
            // The re-read after the write sees the wrapping the server stored.
            backup.getRecoveryKey.mockReturnValue(of(envelope()));

            const code = await state.addRecoveryCode('pw');

            expect(code).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
            const dto = backup.putRecoveryKey.mock.calls[0]![0];
            // Purely additive: the same key gains a second wrapping. Raising the version would
            // invalidate every device backup blob, which is the opposite of what a user asking for
            // more safety expects.
            expect(dto.version).toBe(1);
            expect(dto.recoveryCodeWrapping).toBeTruthy();
            // The working wrapping is re-sent unchanged; sending half the pair would drop it.
            expect(dto.cipherText).toBe('Y3Q=');
        });

        it('does not hand back a code the server did not store', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();

            // The endpoint treats a same-version write as an idempotent re-post and answers Ok
            // having written nothing. Trusting that 200 would leave the user holding a code that
            // opens nothing, believing they are protected.
            const code = await state.addRecoveryCode('pw');

            expect(code).toBeNull();
        });

        it('reports a wrong password without writing anything', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();
            masterKey.rewrap.mockRejectedValue(new Error('Decryption failed'));

            expect(await state.addRecoveryCode('wrong')).toBeNull();
            expect(backup.putRecoveryKey).not.toHaveBeenCalled();
        });
    });
});
