/**
 * The IPC boundary `MasterKeyStateService`'s own spec mocks away.
 *
 * <p><b>This file exists because of C2.</b> `rewrap_master_key` was invoked with three of its five
 * required arguments, so every call in the field failed at Tauri's argument deserialization before
 * any crypto ran - no Alpine user could obtain a recovery code, and a user mid-recovery holding a
 * correct code was told it was wrong. Nothing caught it: the Rust unit tests call the function
 * directly, and `master-key-state.service.spec.ts` provides a wholesale `MasterKeyService` double,
 * so a command that failed 100% of the time was invisible to a green suite in two languages.</p>
 *
 * <p>The Rust-side companion is `the_tauri_argument_names_match_the_typescript_call_sites`, which
 * compares these call sites against the real signatures. This half pins the argument *names and
 * values* one layer up, and the error classification that turns an IPC fault into something other
 * than "your credential is wrong".</p>
 */
import {TestBed} from '@angular/core/testing';
import {CryptoEngine} from '../platform/ports/crypto-engine.port';
import {FakeCryptoEngine} from '../platform/testing/fake-crypto-engine';
import {CredentialRejectedError, MasterKeyEngineError, MasterKeyService} from './master-key.service';
import {EncryptedMasterKey} from '../dtos/response/UserDto';

/**
 * The boundary, as a provided fake rather than as `vi.mock('@tauri-apps/api/core')`.
 *
 * <p>Same assertions, one layer lower: `MasterKeyService` now calls {@link CryptoEngine}, and both of
 * its adapters pass `(command, args)` through untouched to the same Rust functions - Tauri's `invoke`
 * on the desktop, wasm-bindgen in a browser. So pinning the argument names here pins them for both
 * hosts, which a module mock of one host's IPC could not do.</p>
 *
 * <p>Driven by a `vi.fn()` so the recorded calls read exactly as they did before: `[command, args]`.</p>
 */
const invokeStub = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const engine = new FakeCryptoEngine();

const WRAPPED: EncryptedMasterKey = {
    cipherText: 'Y3Q=',
    salt: 'c2FsdA==',
    iv: 'aXY=',
    argon2Iterations: 3,
    argon2Memory: 65536,
    argon2Parallelism: 1,
    version: 1,
    publicVerifier: 'dmVyaWZpZXI=',
};

function args(n = 0): Record<string, unknown> {
    return invokeStub.mock.calls[n]![1] as Record<string, unknown>;
}

describe('MasterKeyService', () => {
    let service: MasterKeyService;

    beforeEach(() => {
        invokeStub.mockReset();
        engine.reset();
        engine.handler = invokeStub;
        TestBed.configureTestingModule({
            providers: [MasterKeyService, {provide: CryptoEngine, useValue: engine}],
        });
        service = TestBed.inject(MasterKeyService);
    });

    describe('rewrap', () => {
        it('supplies all five arguments the command requires', async () => {
            invokeStub.mockResolvedValue(WRAPPED as never);

            await service.rewrap(WRAPPED, 'the-code', 'recoveryCode', 'new-pw', 'password');

            expect(invokeStub.mock.calls[0]![0]).toBe('rewrap_master_key');
            // Exactly these five. `fromKind` and `toKind` are `CredentialKind` in Rust - no
            // `Default`, not `Option` - so omitting either fails the whole call at deserialization.
            expect(Object.keys(args()).sort()).toEqual([
                'encrypted',
                'fromCredential',
                'fromKind',
                'toCredential',
                'toKind',
            ]);
        });

        it('names the kinds rather than letting the engine infer them', async () => {
            invokeStub.mockResolvedValue(WRAPPED as never);

            await service.rewrap(WRAPPED, 'the-code', 'recoveryCode', 'new-pw', 'password');

            // Inference is what sealed a retrofit under a *dashed* code that no later unwrap could
            // reproduce: only the caller knows which credential it holds.
            expect(args()['fromKind']).toBe('recoveryCode');
            expect(args()['toKind']).toBe('password');
        });

        it('reports a genuinely wrong credential as a credential rejection', async () => {
            invokeStub.mockRejectedValue('Decryption failed: invalid password or corrupted data' as never);

            await expect(
                service.rewrap(WRAPPED, 'wrong', 'recoveryCode', 'pw', 'password'),
            ).rejects.toBeInstanceOf(CredentialRejectedError);
        });

        it('reports a malformed recovery code as a credential rejection', async () => {
            invokeStub.mockRejectedValue(
                "InvalidRecoveryCode: 'Ł' is not a recovery-code character" as never,
            );

            await expect(
                service.rewrap(WRAPPED, 'bad', 'recoveryCode', 'pw', 'password'),
            ).rejects.toBeInstanceOf(CredentialRejectedError);
        });

        it('reports an argument rejection as an engine failure, not a bad credential', async () => {
            // The exact shape of C2. Telling someone their last surviving credential is wrong when
            // the command never ran is the failure this classification exists to prevent.
            invokeStub.mockRejectedValue(
                'invalid args `fromKind` for command `rewrap_master_key`: missing field' as never,
            );

            await expect(
                service.rewrap(WRAPPED, 'correct', 'recoveryCode', 'pw', 'password'),
            ).rejects.toBeInstanceOf(MasterKeyEngineError);
        });

        it('reports an absent command as an engine failure', async () => {
            invokeStub.mockRejectedValue('Command rewrap_master_key not found' as never);

            await expect(
                service.rewrap(WRAPPED, 'correct', 'recoveryCode', 'pw', 'password'),
            ).rejects.toBeInstanceOf(MasterKeyEngineError);
        });

        it('classifies anything unrecognised as an engine failure', async () => {
            // Fails to the safe side deliberately: "we could not run the check" must never be
            // rendered as "your code is wrong". The reverse default is what shipped.
            invokeStub.mockRejectedValue('something nobody anticipated' as never);

            await expect(
                service.rewrap(WRAPPED, 'correct', 'recoveryCode', 'pw', 'password'),
            ).rejects.toBeInstanceOf(MasterKeyEngineError);
        });
    });

    describe('normalizeRecoveryCode', () => {
        it('routes to the engine rather than reimplementing the rules', async () => {
            invokeStub.mockResolvedValue('AAAABBBB' as never);

            await service.normalizeRecoveryCode('aaaa-bbbb');

            expect(invokeStub.mock.calls[0]![0]).toBe('normalize_recovery_code_checked');
            expect(args()['code']).toBe('aaaa-bbbb');
        });

        it('surfaces an invalid code as a credential rejection', async () => {
            invokeStub.mockRejectedValue('InvalidRecoveryCode: expected 32 characters, got 8' as never);

            await expect(service.normalizeRecoveryCode('too-short')).rejects.toBeInstanceOf(
                CredentialRejectedError,
            );
        });
    });

    describe('decryptMasterKey', () => {
        it('passes the credential through verbatim under `password`', async () => {
            invokeStub.mockResolvedValue([1, 2, 3] as never);

            await service.decryptMasterKey(WRAPPED, 'Correct Horse-Battery Staple');

            // Nothing is folded here, and the doc comment used to claim otherwise. Guessing whether
            // a string is a password or a recovery code derives the wrong key silently in whichever
            // direction it guesses wrong.
            expect(args()['password']).toBe('Correct Horse-Battery Staple');
        });

        it('distinguishes a wrong password from an engine failure', async () => {
            invokeStub.mockRejectedValue('Decryption failed: invalid password' as never);
            await expect(service.decryptMasterKey(WRAPPED, 'nope')).rejects.toBeInstanceOf(
                CredentialRejectedError,
            );

            invokeStub.mockRejectedValue(
                'InvalidMasterKeyEnvelope: refusing declared Argon2 parameters' as never,
            );
            await expect(service.decryptMasterKey(WRAPPED, 'nope')).rejects.toBeInstanceOf(
                MasterKeyEngineError,
            );
        });
    });

    describe('setupDualWrapped', () => {
        it('generates and wraps in one call, with the entropy the caller collected', async () => {
            invokeStub.mockResolvedValue({
                passwordWrapping: WRAPPED,
                recoveryCodeWrapping: WRAPPED,
            } as never);

            await service.setupDualWrapped('pw', 'CODE', [1, 2, 3]);

            expect(invokeStub.mock.calls[0]![0]).toBe('setup_master_key_dual');
            expect(Object.keys(args()).sort()).toEqual(['password', 'recoveryCode', 'userEntropy']);
            // One call rather than two, so the two wrappings cannot end up sealing different keys -
            // a mistake that looks fine until the day the recovery path is actually needed.
            expect(args()['userEntropy']).toEqual([1, 2, 3]);
        });
    });
});
