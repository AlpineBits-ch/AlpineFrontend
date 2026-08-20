import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, of, throwError} from 'rxjs';
import {MasterKeyStateService} from './master-key-state.service';
import {UserService} from './user.service';
import {BackupService, MasterKeyWrappingDto, PutRecoveryKeyDto, RecoveryKeyDto} from './backup.service';
import {
    CredentialKind,
    CredentialRejectedError,
    MasterKeyEngineError,
    MasterKeyService,
} from './master-key.service';
import {EncryptedMasterKey} from '../dtos/response/UserDto';

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
        putRecoveryKey: vi.fn<
            (dto: PutRecoveryKeyDto, acknowledgeOrphans?: boolean) => Observable<{version: number}>
        >(() => of({version: 1})),
        rewrapPassword: vi.fn<
            (
                version: number,
                w: MasterKeyWrappingDto,
            ) => Observable<{version: number; encryptedHistoryRecoverable: boolean}>
        >(() => of({version: 1, encryptedHistoryRecoverable: true})),
    };
    // Typed with the real parameter list on purpose. A zero-argument double is what let the call
    // site drop two required arguments and stay green: `mock.calls` had no positions to assert on,
    // so nothing here could notice the shape of the call at all.
    const masterKey = {
        rewrap: vi.fn(
            async (
                _encrypted: EncryptedMasterKey,
                _fromCredential: string,
                _fromKind: CredentialKind,
                _toCredential: string,
                _toKind: CredentialKind,
            ) => ({
                cipherText: 'bmV3',
                salt: 'bmV3c2FsdA==',
                iv: 'bmV3aXY=',
                argon2Iterations: 3,
                argon2Memory: 65536,
                argon2Parallelism: 1,
                version: 1,
                publicVerifier: 'dmVyaWZpZXI=',
            }),
        ),
        generateRecoveryCode: vi.fn(async () => 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH'),
        setupDualWrapped: vi.fn(async (_password: string, _recoveryCode: string) => ({
            passwordWrapping: {
                cipherText: 'ZnJlc2g=',
                salt: 'ZnJlc2hzYWx0',
                iv: 'ZnJlc2hpdg==',
                argon2Iterations: 3,
                argon2Memory: 65536,
                argon2Parallelism: 1,
                version: 1,
                publicVerifier: 'ZnJlc2h2ZXJpZmllcg==',
            },
            recoveryCodeWrapping: {
                cipherText: 'ZnJlc2hyYw==',
                salt: 'ZnJlc2hyY3NhbHQ=',
                iv: 'ZnJlc2hyY2l2',
                argon2Iterations: 3,
                argon2Memory: 65536,
                argon2Parallelism: 1,
                version: 1,
                publicVerifier: 'ZnJlc2h2ZXJpZmllcg==',
            },
        })),
    };

    const user = {verifyPassword: vi.fn<(password: string) => Observable<boolean>>(() => of(true))};

    TestBed.configureTestingModule({
        providers: [
            MasterKeyStateService,
            {provide: BackupService, useValue: backup},
            {provide: MasterKeyService, useValue: masterKey},
            {provide: UserService, useValue: user},
        ],
    });

    return {state: TestBed.inject(MasterKeyStateService), backup, masterKey, user};
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
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                    }),
                ),
            );

            expect(await state.refresh()).toBe('rewrap-required');
        });

        it('reports a completed loss ahead of anything else', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        recoveryCodeWrapping: null,
                        passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                        encryptedHistoryRecoverable: false,
                    }),
                ),
            );

            // Already lost, not a prompt to do something: no password will ever open this key
            // again. Offering a repair here would be a lie.
            expect(await state.refresh()).toBe('unrecoverable');
        });

        it('treats a 404 as first-run rather than a fault', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(throwError(() => new HttpErrorResponse({status: 404})));

            expect(await state.refresh()).toBe('not-set-up');
            expect(state.needsAttention()).toBe(false);
        });

        it('keeps the previous verdict when the lookup fails', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        encryptedHistoryRecoverable: false,
                    }),
                ),
            );
            await state.refresh();

            backup.getRecoveryKey.mockReturnValue(throwError(() => new HttpErrorResponse({status: 500})));

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
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                    }),
                ),
            );
            await state.refresh();

            const result = await state.rewrapUnderNewPassword(
                'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
                'new-pw',
            );

            expect(result.outcome).toBe('ok');
            expect(masterKey.rewrap).toHaveBeenCalled();
            // Same version: this re-wraps the key the account already has. A different one would
            // orphan every blob sealed under the current version.
            expect(backup.rewrapPassword.mock.calls[0]![0]).toBe(1);
        });

        // ─── C2: both credential kinds must be named, and never inferred ──────

        it('names both credential kinds on the re-wrap', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                    }),
                ),
            );
            await state.refresh();

            await state.rewrapUnderNewPassword('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', 'new-pw');

            // `rewrap_master_key` takes five arguments and was invoked with three. `CredentialKind`
            // has no `Default` and is not `Option`, so every call failed at Tauri's argument
            // deserialization before any crypto ran - and the caller reported that as a bad
            // recovery code.
            const [, fromCredential, fromKind, toCredential, toKind] = masterKey.rewrap.mock.calls[0]!;
            expect(fromCredential).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
            expect(fromKind).toBe('recoveryCode');
            expect(toCredential).toBe('new-pw');
            expect(toKind).toBe('password');
        });

        it('reports a wrong recovery code without writing anything', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                    }),
                ),
            );
            await state.refresh();
            masterKey.rewrap.mockRejectedValue(
                new CredentialRejectedError('recoveryCode', 'Decryption failed'),
            );

            const result = await state.rewrapUnderNewPassword('WRONG', 'new-pw');

            expect(result.outcome).toBe('credential-rejected');
            expect(backup.rewrapPassword).not.toHaveBeenCalled();
        });

        it('does not report an engine failure as a bad recovery code', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z',
                    }),
                ),
            );
            await state.refresh();
            masterKey.rewrap.mockRejectedValue(
                new MasterKeyEngineError(
                    'rewrap_master_key',
                    'invalid args `fromKind` for command `rewrap_master_key`',
                ),
            );

            // The C2 outcome, stated as a test: a user mid-recovery, holding a *correct* code and
            // no other credential, was told the one thing that would make them stop trying.
            const result = await state.rewrapUnderNewPassword('CORRECT-CODE', 'new-pw');

            expect(result.outcome).toBe('engine-failed');
            expect(backup.rewrapPassword).not.toHaveBeenCalled();
        });

        it('cannot re-wrap an account that never had a recovery code', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(
                of(
                    envelope({
                        recoveryCodeWrapping: null,
                        encryptedHistoryRecoverable: false,
                    }),
                ),
            );
            await state.refresh();

            const result = await state.rewrapUnderNewPassword('anything', 'new-pw');

            expect(result.outcome).toBe('not-applicable');
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

            const result = await state.addRecoveryCode('pw');

            expect(result).toEqual({
                outcome: 'ok',
                recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
            });
            const dto = backup.putRecoveryKey.mock.calls[0]![0];
            // Purely additive: the same key gains a second wrapping. Raising the version would
            // invalidate every device backup blob, which is the opposite of what a user asking for
            // more safety expects.
            expect(dto.version).toBe(1);
            expect(dto.recoveryCodeWrapping).toBeTruthy();
            // The working wrapping is re-sent unchanged; sending half the pair would drop it.
            expect(dto.cipherText).toBe('Y3Q=');
        });

        it('names both credential kinds on the retrofit', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();
            backup.getRecoveryKey.mockReturnValue(of(envelope()));

            await state.addRecoveryCode('pw');

            // The retrofit is the direction that was broken twice over: the engine once normalized
            // only the `from` side and sealed under a *dashed* code, and the fix for that was never
            // plumbed through here, so the command failed outright instead.
            const [, fromCredential, fromKind, toCredential, toKind] = masterKey.rewrap.mock.calls[0]!;
            expect(fromCredential).toBe('pw');
            expect(fromKind).toBe('password');
            expect(toCredential).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
            expect(toKind).toBe('recoveryCode');
        });

        it('sends the same public verifier for both wrappings', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();
            backup.getRecoveryKey.mockReturnValue(of(envelope()));

            await state.addRecoveryCode('pw');

            // §L.11: two verifiers means the two wrappings do not seal the same key, and Echo
            // rejects the write. The value is derived from the master key alone, so the one the
            // engine just produced is correct for the wrapping already stored.
            const dto = backup.putRecoveryKey.mock.calls[0]![0];
            expect(dto.publicVerifier).toBe('dmVyaWZpZXI=');
            expect(dto.recoveryCodeWrapping!.publicVerifier).toBe('dmVyaWZpZXI=');
        });

        it('does not hand back a code the server did not store', async () => {
            const {state, backup} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();

            // The endpoint treats a same-version write as an idempotent re-post and answers Ok
            // having written nothing. Trusting that 200 would leave the user holding a code that
            // opens nothing, believing they are protected.
            const result = await state.addRecoveryCode('pw');

            expect(result.outcome).toBe('not-stored');
        });

        it('reports a wrong password without writing anything', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();
            masterKey.rewrap.mockRejectedValue(new CredentialRejectedError('password', 'Decryption failed'));

            const result = await state.addRecoveryCode('wrong');

            expect(result.outcome).toBe('credential-rejected');
            expect(backup.putRecoveryKey).not.toHaveBeenCalled();
        });

        it('does not report an engine failure as a wrong password', async () => {
            const {state, backup, masterKey} = setup();
            backup.getRecoveryKey.mockReturnValue(of(envelope({recoveryCodeWrapping: null})));
            await state.refresh();
            masterKey.rewrap.mockRejectedValue(
                new MasterKeyEngineError(
                    'rewrap_master_key',
                    'invalid args `toKind` for command `rewrap_master_key`',
                ),
            );

            // Live behaviour before this change: no Alpine user could ever obtain a recovery code,
            // and the reason shown was "Check your password and try again."
            const result = await state.addRecoveryCode('correct-password');

            expect(result.outcome).toBe('engine-failed');
            expect(backup.putRecoveryKey).not.toHaveBeenCalled();
        });
    });

    describe('starting over without a recovery code', () => {
        /** Puts the account in the state the branch exists for, with the re-read seeing a rotation. */
        async function stuckAfterReset() {
            const kit = setup();
            kit.backup.getRecoveryKey.mockReturnValue(
                of(envelope({passwordWrappingInvalidatedAt: '2026-08-01T10:00:00Z'})),
            );
            await kit.state.refresh();
            kit.backup.getRecoveryKey.mockReturnValue(of(envelope({version: 2})));
            return kit;
        }

        it('rotates to a new key and hands back the new code', async () => {
            const {state, backup} = await stuckAfterReset();

            const result = await state.resetEncryption('new-password');

            expect(result).toEqual({
                outcome: 'ok',
                recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
            });
            const [dto] = backup.putRecoveryKey.mock.calls[0]!;
            // The whole point of this path: a different key, so the version has to move. At the
            // stored version the server reads the write as a claim that the bytes seal the same key
            // and refuses it.
            expect(dto.version).toBe(2);
            expect(dto.cipherText).toBe('ZnJlc2g=');
            expect(dto.recoveryCodeWrapping!.cipherText).toBe('ZnJlc2hyYw==');
        });

        it('does not silently strand the backups the server warned about', async () => {
            const {state, backup} = await stuckAfterReset();
            backup.putRecoveryKey.mockReturnValue(
                throwError(
                    () =>
                        new HttpErrorResponse({
                            status: 409,
                            error: {version: 1, orphanedBlobDeviceIds: ['device-a', 'device-b']},
                        }),
                ),
            );

            const result = await state.resetEncryption('new-password');

            expect(result).toEqual({outcome: 'orphans-pending', deviceIds: ['device-a', 'device-b']});
            expect(backup.putRecoveryKey.mock.calls[0]![1]).toBe(false);
        });

        it('acknowledges the orphans on the second attempt', async () => {
            const {state, backup} = await stuckAfterReset();

            await state.resetEncryption('new-password', true);

            expect(backup.putRecoveryKey.mock.calls[0]![1]).toBe(true);
        });

        it('checks the password before anything is generated', async () => {
            const {state, backup, masterKey, user} = await stuckAfterReset();
            user.verifyPassword.mockReturnValue(of(false));

            const result = await state.resetEncryption('wrong');

            expect(result.outcome).toBe('credential-rejected');
            expect(masterKey.setupDualWrapped).not.toHaveBeenCalled();
            expect(backup.putRecoveryKey).not.toHaveBeenCalled();
        });

        it('repeats what the server said rather than blaming the password', async () => {
            const {state, backup} = await stuckAfterReset();
            backup.putRecoveryKey.mockReturnValue(
                throwError(() => new HttpErrorResponse({status: 400, error: 'publicVerifier is required'})),
            );

            const result = await state.resetEncryption('new-password');

            expect(result).toEqual({outcome: 'server-refused', detail: 'publicVerifier is required'});
        });

        it('does not hand back a code the rotation did not take', async () => {
            const {state, backup} = await stuckAfterReset();
            // The re-read still shows the old version, so the new code opens nothing.
            backup.getRecoveryKey.mockReturnValue(of(envelope()));

            const result = await state.resetEncryption('new-password');

            expect(result.outcome).toBe('not-stored');
        });
    });
});
