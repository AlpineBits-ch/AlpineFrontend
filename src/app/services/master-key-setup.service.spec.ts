import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {MasterKeySetupService} from './master-key-setup.service';
import {MasterKeyService} from './master-key.service';
import {BackupService, PutRecoveryKeyDto} from './backup.service';
import {UserService} from './user.service';
import {EncryptedMasterKey} from '../dtos/response/UserDto';

const PASSWORD_WRAPPING: EncryptedMasterKey = {
    cipherText: 'cGFzc3dvcmQ=',
    salt: 'c2FsdA==',
    iv: 'aXY=',
    argon2Iterations: 3,
    argon2Memory: 65536,
    argon2Parallelism: 1,
    version: 4,
    publicVerifier: 'dmVyaWZpZXI=',
};

const CODE_WRAPPING: EncryptedMasterKey = {
    ...PASSWORD_WRAPPING,
    cipherText: 'Y29kZQ==',
};

const CODE = 'ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2';

function setup(options: {uploadFails?: boolean} = {}) {
    const order: string[] = [];

    const generateRecoveryCode = vi.fn(async () => CODE);
    const setupDualWrapped = vi.fn(async () => {
        order.push('setupDualWrapped');
        return {passwordWrapping: PASSWORD_WRAPPING, recoveryCodeWrapping: CODE_WRAPPING};
    });
    const putRecoveryKey = vi.fn((_dto: PutRecoveryKeyDto) => {
        order.push('putRecoveryKey');
        return options.uploadFails
            ? throwError(() => new Error('nope'))
            : of({version: PASSWORD_WRAPPING.version});
    });

    TestBed.configureTestingModule({
        providers: [
            {provide: UserService, useValue: {verifyPassword: vi.fn(() => of(true))}},
            {
                provide: MasterKeyService,
                useValue: {generateRecoveryCode, setupDualWrapped},
            },
            {provide: BackupService, useValue: {putRecoveryKey}},
        ],
    });

    return {
        service: TestBed.inject(MasterKeySetupService),
        order,
        setupDualWrapped,
        putRecoveryKey,
        sentDto: () => putRecoveryKey.mock.calls[0]![0],
    };
}

describe('MasterKeySetupService.run', () => {
    it('wraps before it writes', async () => {
        const {service, order} = setup();
        await service.generateRecoveryCode();

        await service.run('hunter2');

        expect(order).toEqual(['setupDualWrapped', 'putRecoveryKey']);
    });

    it('carries publicVerifier through on both wrappings', async () => {
        const {service, sentDto} = setup();
        await service.generateRecoveryCode();

        await service.run('hunter2');

        // Echo hard-refuses the key-establishing write without it, for every account (§L.11).
        expect(sentDto().publicVerifier).toBe(PASSWORD_WRAPPING.publicVerifier);
        expect(sentDto().recoveryCodeWrapping?.publicVerifier).toBe(CODE_WRAPPING.publicVerifier);
    });

    it('seals the code that was shown, at the version the engine minted', async () => {
        const {service, setupDualWrapped, sentDto} = setup();
        const shown = await service.generateRecoveryCode();

        await service.run('hunter2', [1, 2, 3]);

        expect(setupDualWrapped).toHaveBeenCalledWith('hunter2', shown, [1, 2, 3]);
        expect(sentDto().version).toBe(PASSWORD_WRAPPING.version);
    });

    it('refuses to run without a generated code', async () => {
        const {service, setupDualWrapped} = setup();

        await expect(service.run('hunter2')).rejects.toThrow();
        expect(setupDualWrapped).not.toHaveBeenCalled();
    });
});

describe('MasterKeySetupService recovery-code lifetime', () => {
    it('drops the code once it is written', async () => {
        const {service} = setup();
        await service.generateRecoveryCode();

        await service.run('hunter2');

        // The one credential a reset cannot replace: nothing may reuse it after the run.
        await expect(service.run('hunter2')).rejects.toThrow();
    });

    it('keeps the code for a retry when the write fails', async () => {
        const {service, setupDualWrapped} = setup({uploadFails: true});
        const shown = await service.generateRecoveryCode();

        await expect(service.run('hunter2')).rejects.toThrow();

        await expect(service.run('hunter2')).rejects.toThrow();
        expect(setupDualWrapped).toHaveBeenNthCalledWith(2, 'hunter2', shown, []);
    });

    it('drops the code on discard', async () => {
        const {service} = setup();
        await service.generateRecoveryCode();

        service.discard();

        await expect(service.run('hunter2')).rejects.toThrow();
    });
});
