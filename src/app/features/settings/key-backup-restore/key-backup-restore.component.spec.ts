/** The restore flow, and the two things it used to leave undone. */
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {signal} from '@angular/core';
import {KeyBackupRestoreComponent} from './key-backup-restore.component';
import {MlsBackupImportResult, MlsService} from '../../../services/mls.service';
import {UserService} from '../../../services/user.service';
import {DeviceService} from '../../../services/device.service';
import {DeviceIdentityService} from '../../../services/device-identity.service';

const THIS_DEVICE = 'device-here';
const BACKUP_DEVICE = 'device-from-the-old-machine';

let calls: string[];
let currentDeviceId: string;
let importResults: MlsBackupImportResult[];
let importError: unknown;
let resetFails: boolean;
let replenishFails: boolean;

function importResult(over: Partial<MlsBackupImportResult> = {}): MlsBackupImportResult {
    return {
        userId: 'user-1',
        deviceId: BACKUP_DEVICE,
        createdAt: '2026-08-03T00:00:00Z',
        appVersion: '3.0.165',
        identity: 'user-1',
        keyHandle: 'handle-1',
        signingPublicKey: 'cHVi',
        signingPrivateKey: 'cHJpdg==',
        engineRestored: false,
        groupRegistry: {},
        messageCache: {},
        ...over,
    };
}

function build(): KeyBackupRestoreComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {
                provide: MlsService,
                useValue: {
                    keyHandle: signal<string | undefined>(undefined),
                    importBackup: async () => {
                        calls.push('importBackup');
                        if (importError) throw importError;
                        return importResults.shift() ?? importResult();
                    },
                },
            },
            {
                provide: UserService,
                useValue: {
                    getSelf: () => of({id: 'user-1'}),
                    replenishKeyCount: () => {
                        calls.push('replenishKeyCount');
                        return replenishFails
                            ? throwError(() => new Error('server down'))
                            : of(undefined as void);
                    },
                },
            },
            {
                provide: DeviceService,
                useValue: {
                    resetKeyPackages: (id: string) => {
                        calls.push(`resetKeyPackages:${id}`);
                        return resetFails
                            ? throwError(() => new Error('server down'))
                            : of({deletedCount: 1});
                    },
                },
            },
            {
                provide: DeviceIdentityService,
                useValue: {
                    deviceId: async () => currentDeviceId,
                    adopt: async (id: string) => {
                        calls.push(`adopt:${id}`);
                        currentDeviceId = id;
                    },
                    ensureRegistered: async () => {
                        calls.push('ensureRegistered');
                        return true;
                    },
                },
            },
        ],
    });
    return TestBed.createComponent(KeyBackupRestoreComponent).componentInstance;
}

/** Drives the component to the point where `restore()` can run. */
function armWithFile(component: KeyBackupRestoreComponent): void {
    const internals = component as unknown as {
        blob: string | null;
        passphrase: ReturnType<typeof signal<string>>;
        step: ReturnType<typeof signal<string>>;
    };
    internals.blob = '<envelope>';
    internals.passphrase.set('pass');
    internals.step.set('passphrase');
}

function inner(component: KeyBackupRestoreComponent) {
    return component as unknown as {
        step: () => string;
        outcome: () => {engineRestored: boolean; deviceId: string} | null;
        errorMsg: () => string;
        restore: () => Promise<void>;
        adoptAndRestore: () => Promise<void>;
        declineAdopt: () => void;
    };
}

beforeEach(() => {
    calls = [];
    currentDeviceId = THIS_DEVICE;
    importResults = [];
    importError = null;
    resetFails = false;
    replenishFails = false;
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => vi.restoreAllMocks());

describe('repairing the server after a restore', () => {
    it('clears stale packages, re-registers, then replenishes - in that order', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({deviceId: THIS_DEVICE, engineRestored: true})];

        await inner(component).restore();

        expect(calls).toEqual([
            'importBackup',
            `resetKeyPackages:${THIS_DEVICE}`,
            // The device row still advertises the signing key this device had *before* the
            // restore, so packages minted under the restored one would not match it.
            'ensureRegistered',
            // And without this the device holds every key it needs and still has no packages on
            // the server, so nobody can add it to anything.
            'replenishKeyCount',
        ]);
    });

    it('still reports success when the package reset fails', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({deviceId: THIS_DEVICE, engineRestored: true})];
        resetFails = true;

        await inner(component).restore();

        // A restore that worked must not be reported as failed because a follow-up call did not
        // land - the keys are on this device either way, and telling the user otherwise sends
        // them to re-run something that already succeeded.
        expect(inner(component).step()).toBe('done');
        expect(inner(component).errorMsg()).toBe('');
    });

    it('still reports success when the replenish fails', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({deviceId: THIS_DEVICE, engineRestored: true})];
        replenishFails = true;

        await inner(component).restore();

        expect(inner(component).step()).toBe('done');
        expect(inner(component).errorMsg()).toBe('');
    });

    it('reports a genuine import failure as a failure', async () => {
        const component = build();
        armWithFile(component);
        importError = new Error('engine exploded');

        await inner(component).restore();

        expect(inner(component).step()).toBe('passphrase');
        expect(inner(component).errorMsg()).toBeTruthy();
        expect(calls).toEqual(['importBackup']);
    });
});

describe('adopting the backup device id', () => {
    it('offers the choice when the backup came from another device', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({engineRestored: false})];

        await inner(component).restore();

        expect(inner(component).step()).toBe('offer-adopt');
        expect(inner(component).outcome()).toEqual({
            engineRestored: false, deviceId: BACKUP_DEVICE,
        });
    });

    it('does not offer it when the engine was already restored', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({deviceId: THIS_DEVICE, engineRestored: true})];

        await inner(component).restore();

        expect(inner(component).step()).toBe('done');
        expect(calls).not.toContain(`adopt:${BACKUP_DEVICE}`);
    });

    it('adopts the id and re-imports, which is what recovers the history', async () => {
        const component = build();
        armWithFile(component);
        importResults = [
            importResult({engineRestored: false}),
            importResult({engineRestored: true}),
        ];

        await inner(component).restore();
        await inner(component).adoptAndRestore();

        // The second import is not a retry: adopting the id is what makes the *same* blob restore
        // the engine, so it has to be re-opened afterwards.
        expect(calls).toEqual([
            'importBackup', `resetKeyPackages:${THIS_DEVICE}`, 'ensureRegistered',
            'replenishKeyCount',
            `adopt:${BACKUP_DEVICE}`, 'importBackup', `resetKeyPackages:${BACKUP_DEVICE}`,
            'ensureRegistered', 'replenishKeyCount',
        ]);
        expect(inner(component).step()).toBe('done');
        expect(inner(component).outcome()?.engineRestored).toBe(true);
    });

    it('adopts before re-importing, or the second import refuses for the same reason as the first', async () => {
        const component = build();
        armWithFile(component);
        importResults = [
            importResult({engineRestored: false}),
            importResult({engineRestored: true}),
        ];

        await inner(component).restore();
        await inner(component).adoptAndRestore();

        expect(calls.indexOf(`adopt:${BACKUP_DEVICE}`))
            .toBeLessThan(calls.lastIndexOf('importBackup'));
    });

    it('re-registers under the adopted id, not the one it replaced', async () => {
        const component = build();
        armWithFile(component);
        importResults = [
            importResult({engineRestored: false}),
            importResult({engineRestored: true}),
        ];

        await inner(component).restore();
        await inner(component).adoptAndRestore();

        // The keychain entries are named after the device id, so a repair aimed at the old one
        // would register a key that is no longer where it is looked for.
        expect(calls).toContain(`resetKeyPackages:${BACKUP_DEVICE}`);
    });

    it('returns to the offer when the second import fails, so it can be retried', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({engineRestored: false})];

        await inner(component).restore();
        importError = new Error('engine exploded');
        await inner(component).adoptAndRestore();

        expect(inner(component).step()).toBe('offer-adopt');
        expect(inner(component).errorMsg()).toBeTruthy();
    });

    it('keeps the keys that were restored when the offer is declined', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({engineRestored: false})];

        await inner(component).restore();
        inner(component).declineAdopt();

        expect(inner(component).step()).toBe('done');
        expect(inner(component).outcome()?.engineRestored).toBe(false);
    });

    it('does nothing when there is no blob left to re-import', async () => {
        const component = build();
        armWithFile(component);
        importResults = [importResult({engineRestored: false})];

        await inner(component).restore();
        inner(component).declineAdopt();
        const after = [...calls];
        await inner(component).adoptAndRestore();

        // Declining drops the blob. Adopting a device id without the file that justifies it would
        // hand this installation an identity it holds no keys for.
        expect(calls).toEqual(after);
    });
});
