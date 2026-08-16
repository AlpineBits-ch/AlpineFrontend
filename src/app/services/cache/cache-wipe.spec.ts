import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {signal} from '@angular/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {SessionTeardownService} from '../session-teardown.service';
import {MlsService} from '../mls.service';
import {DeviceService} from '../device.service';
import {MlsCoverageService} from '../mls-coverage.service';
import {ProfileService} from '../profile.service';
import {CacheStoreFactory} from '../../platform/cache-store';
import {provideFakePlatform} from '../../platform/testing/provide-fake-platform';

/**
 * A wipe that left the profile/message cache behind would leave the contact graph and the message
 * metadata on disk after a sign-out - the exact material the sealing exists to protect, kept past
 * the moment the user asked for it to be gone.
 *
 * <p>Exercised through the real {@link SessionTeardownService}, not a pair of stubs calling each
 * other: the thing worth proving is that the actual teardown code path reaches
 * `CacheStoreFactory.open(deviceId).clear()`, scoped to the device being wiped, and that a failure
 * there does not stop the rest of the teardown.</p>
 */
const DEVICE_ID = 'device-a';

let clearCalls: string[];
let clearThrows: boolean;
let coverageCleared: boolean;
let profiles: {cachePersist: ((profile: unknown) => void) | null};

function mlsStub() {
    return {
        keyHandle: signal<string | undefined>(undefined),
        unloadSigningKey: () => of(undefined as void),
        clearStoredSigningKey: () => of(undefined as void),
        clearStorage: () => of(undefined as void),
        clearGroupRegistry: async () => { /* no-op */ },
        clearMessageCache: async () => { /* no-op */ },
    };
}

function deviceStub() {
    return {resetKeyPackages: () => of({deletedCount: 0})};
}

/** Records which device id a clear was scoped to, and can be made to fail like a real store can. */
function fakeCacheStores(): CacheStoreFactory {
    return {
        open: (deviceId: string) => ({
            clear: async () => {
                clearCalls.push(deviceId);
                if (clearThrows) throw new Error('cache store unavailable');
            },
        }),
    } as unknown as CacheStoreFactory;
}

function build(): SessionTeardownService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideFakePlatform(),
            SessionTeardownService,
            {provide: MlsService, useValue: mlsStub()},
            {provide: DeviceService, useValue: deviceStub()},
            {provide: MlsCoverageService, useValue: {clear: () => { coverageCleared = true; }}},
            {provide: CacheStoreFactory, useFactory: fakeCacheStores},
            // Stubbed because the real one reaches ApiConfigService -> OAuthService, which this
            // pure Tauri harness has no business providing. Only the write-behind hook is used.
            {provide: ProfileService, useFactory: () => profiles},
        ],
    });
    return TestBed.inject(SessionTeardownService);
}

beforeEach(() => {
    clearCalls = [];
    clearThrows = false;
    coverageCleared = false;
    profiles = {cachePersist: () => { /* the outgoing account's hook */ }};
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

describe('cache wipe', () => {
    it('clears this device\'s cache store as part of wipeEngineState', async () => {
        const service = build();

        await service.wipeEngineState(DEVICE_ID);

        expect(clearCalls).toEqual([DEVICE_ID]);
    });

    it('clears the cache store as part of wipeAccount too', async () => {
        const service = build();

        await service.wipeAccount(DEVICE_ID);

        expect(clearCalls).toEqual([DEVICE_ID]);
    });

    it('scopes the clear to the device being wiped, not some other one', async () => {
        const service = build();

        await service.wipeEngineState('some-other-device');

        expect(clearCalls).toEqual(['some-other-device']);
    });

    it('does not abort the rest of the teardown when the cache clear fails', async () => {
        clearThrows = true;
        const service = build();

        const outcome = await service.wipeEngineState(DEVICE_ID);

        // The clear was attempted and failed, but everything after it in the method still ran.
        expect(clearCalls).toEqual([DEVICE_ID]);
        expect(coverageCleared).toBe(true);
        expect(outcome.keyPackagesReset).toBe(true);
    });

    it('logs a failed cache clear rather than swallowing it silently', async () => {
        clearThrows = true;
        const service = build();

        await service.wipeEngineState(DEVICE_ID);

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('cache'), expect.any(Error));
    });

    /**
     * The clear only reaches what is already on disk. The hook `ProfileCacheService.hydrate`
     * installed is still live, and a sign-out never destroys an injector - so left in place it
     * would write the *next* account's profiles into the namespace this wipe just emptied.
     */
    it('takes the write-behind hook down even when the cache clear fails', async () => {
        clearThrows = true;
        const service = build();

        await service.wipeEngineState(DEVICE_ID);

        expect(profiles.cachePersist).toBeNull();
    });

    it('completes a full account wipe even when the cache clear fails', async () => {
        clearThrows = true;
        const service = build();

        const outcome = await service.wipeAccount(DEVICE_ID);

        expect(clearCalls).toEqual([DEVICE_ID]);
        expect(outcome.keyPackagesReset).toBe(true);
    });
});
