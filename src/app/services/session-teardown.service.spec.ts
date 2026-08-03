/**
 * The one place local MLS state is destroyed, and the order it destroys it in.
 *
 * <p>There were three copies of this and they disagreed. The logout dialog wiped everything; the
 * launch sequence's corruption recovery wiped everything except the signing key; and
 * `MainPageComponent.logout` - which is also the `Ctrl+Shift+L` handler - wiped nothing at all and
 * just dropped the OAuth token. Signing out that way and signing in as somebody else left the
 * previous account's signing key, groups, registry and plaintext message history on disk and
 * readable, because the cache seal key is derived per device rather than per account.</p>
 */
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {signal} from '@angular/core';
import {SessionTeardownService} from './session-teardown.service';
import {MlsService} from './mls.service';
import {DeviceService} from './device.service';

const DEVICE_ID = 'device-a';

let calls: string[];
let keyHandle: ReturnType<typeof signal<string | undefined>>;
let resetFails: boolean;
let unloadFails: boolean;

function mlsStub() {
    return {
        keyHandle,
        unloadSigningKey: (handle: string) => {
            calls.push(`unloadSigningKey:${handle}`);
            return unloadFails ? throwError(() => new Error('handle gone')) : of(undefined as void);
        },
        clearStoredSigningKey: (deviceId: string) => {
            calls.push(`clearStoredSigningKey:${deviceId}`);
            return of(undefined as void);
        },
        clearStorage: () => {
            calls.push('clearStorage');
            return of(undefined as void);
        },
        clearGroupRegistry: async () => { calls.push('clearGroupRegistry'); },
        clearMessageCache: async () => { calls.push('clearMessageCache'); },
    };
}

function deviceStub() {
    return {
        resetKeyPackages: (deviceId: string) => {
            calls.push(`resetKeyPackages:${deviceId}`);
            return resetFails
                ? throwError(() => new Error('server unreachable'))
                : of({deletedCount: 3});
        },
    };
}

function build(): SessionTeardownService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            SessionTeardownService,
            {provide: MlsService, useValue: mlsStub()},
            {provide: DeviceService, useValue: deviceStub()},
        ],
    });
    return TestBed.inject(SessionTeardownService);
}

beforeEach(() => {
    calls = [];
    keyHandle = signal<string | undefined>('handle-1');
    resetFails = false;
    unloadFails = false;
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => vi.restoreAllMocks());

describe('wipeAccount', () => {
    it('destroys everything this device holds for the account', async () => {
        const service = build();

        await service.wipeAccount(DEVICE_ID);

        expect(calls).toEqual([
            'unloadSigningKey:handle-1',
            `clearStoredSigningKey:${DEVICE_ID}`,
            'clearStorage',
            'clearGroupRegistry',
            'clearMessageCache',
            `resetKeyPackages:${DEVICE_ID}`,
        ]);
    });

    it('releases the session handle before deleting the key it refers to', async () => {
        const service = build();

        await service.wipeAccount(DEVICE_ID);

        expect(calls.indexOf('unloadSigningKey:handle-1'))
            .toBeLessThan(calls.indexOf(`clearStoredSigningKey:${DEVICE_ID}`));
    });

    it('drops the session handle so nothing can keep acting as the wiped account', async () => {
        const service = build();

        await service.wipeAccount(DEVICE_ID);

        expect(keyHandle()).toBeUndefined();
    });

    it('deletes the key even when the handle cannot be released', async () => {
        const service = build();
        unloadFails = true;

        await service.wipeAccount(DEVICE_ID);

        // The handle is a session-scoped reference to a key that is about to be deleted anyway.
        expect(calls).toContain(`clearStoredSigningKey:${DEVICE_ID}`);
        expect(calls).toContain('clearMessageCache');
    });

    it('wipes an account that has no live session handle', async () => {
        const service = build();
        keyHandle.set(undefined);

        await service.wipeAccount(DEVICE_ID);

        expect(calls.some(c => c.startsWith('unloadSigningKey'))).toBe(false);
        expect(calls).toContain(`clearStoredSigningKey:${DEVICE_ID}`);
    });

    it('reports a failed server-side reset without abandoning the local wipe', async () => {
        const service = build();
        resetFails = true;

        const outcome = await service.wipeAccount(DEVICE_ID);

        // Contract §A: the server would otherwise keep handing out key packages whose private
        // halves were just deleted, and every Welcome sealed to one is undecryptable by the device
        // it was meant for. Worth reporting - never worth stopping the local wipe over.
        expect(outcome.keyPackagesReset).toBe(false);
        expect(calls).toContain('clearMessageCache');
        expect(calls).toContain('clearStorage');
    });

    it('reports a successful reset', async () => {
        const service = build();

        await expect(service.wipeAccount(DEVICE_ID)).resolves.toEqual({keyPackagesReset: true});
    });
});

describe('wipeEngineState', () => {
    it('drops group state but keeps this device identity', async () => {
        const service = build();

        await service.wipeEngineState(DEVICE_ID);

        expect(calls).toEqual([
            'clearStorage',
            'clearGroupRegistry',
            'clearMessageCache',
            `resetKeyPackages:${DEVICE_ID}`,
        ]);
    });

    it('never touches the signing key - a corrupt state file must not cost the account its identity', async () => {
        const service = build();

        await service.wipeEngineState(DEVICE_ID);

        // Deleting it would send the next launch to the registration modal, which mints a *fresh*
        // keypair and orphans this device from every group it belongs to. That is unrecoverable;
        // rejoining with the identity this device already has is not.
        expect(calls.some(c => c.startsWith('clearStoredSigningKey'))).toBe(false);
        expect(calls.some(c => c.startsWith('unloadSigningKey'))).toBe(false);
        expect(keyHandle()).toBe('handle-1');
    });

    it('reports a failed server-side reset', async () => {
        const service = build();
        resetFails = true;

        await expect(service.wipeEngineState(DEVICE_ID))
            .resolves.toEqual({keyPackagesReset: false});
    });
});
