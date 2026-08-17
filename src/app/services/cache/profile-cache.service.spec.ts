import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {of, throwError} from 'rxjs';

import {ProfileDto, OnlineStatus, ProfileFont} from '../../dtos/response/profile.dto';
import {CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {ProfileService} from '../profile.service';
import {ProfileCacheService} from './profile-cache.service';

function profile(userId: string, userName: string): ProfileDto {
    return {
        id: `prfl_${userId}`,
        userId,
        userName,
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        onlineStatus: OnlineStatus.Offline,
    };
}

/** An in-memory stand-in for CacheStore, so these tests are about the service, not IndexedDB. */
class FakeCacheStore {
    readonly entries = new Map<string, unknown>();
    async get(_d: string, key: string) {
        return this.entries.get(key);
    }
    async set(_d: string, key: string, value: unknown) {
        this.entries.set(key, value);
    }
    async delete(_d: string, key: string) {
        this.entries.delete(key);
    }
    async all<T>() {
        return [...this.entries.entries()] as [string, T][];
    }
    async clear() {
        this.entries.clear();
    }
    sizeOf() {
        return 0;
    }
}

let cache: FakeCacheStore;
let profiles: ProfileService;
let subject: ProfileCacheService;
/** The device id the fake identity service answers with. Mutable, to model a sign-out. */
let deviceId: string;
/** Every device id the factory was asked for, in order. */
let opened: string[];

function configure(fetchByUserId = vi.fn(() => of(profile('u1', 'ada')))) {
    cache = new FakeCacheStore();
    deviceId = 'device-a';
    opened = [];
    TestBed.configureTestingModule({
        providers: [
            {
                provide: CacheStoreFactory,
                useValue: {
                    open: (id: string) => {
                        opened.push(id);
                        return cache;
                    },
                },
            },
            {provide: DeviceIdentityService, useValue: {deviceId: async () => deviceId}},
            {
                provide: ProfileService,
                useValue: Object.assign(Object.create(ProfileService.prototype) as ProfileService, {
                    fetchByUserId,
                    hydrateFrom: vi.fn(),
                    cachePersist: null,
                }),
            },
        ],
    });
    profiles = TestBed.inject(ProfileService);
    subject = TestBed.inject(ProfileCacheService);
}

describe('ProfileCacheService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('writes a profile it is handed', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));

        expect(cache.entries.get('u1')).toMatchObject({userName: 'ada'});
    });

    it('hydrates every cached profile into the service before anything is fetched', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));
        await subject.remember(profile('u2', 'grace'));

        const loaded = await subject.hydrate();

        expect(loaded).toBe(2);
        expect(profiles.hydrateFrom).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({userName: 'ada'}),
                expect.objectContaining({userName: 'grace'}),
            ]),
        );
    });

    it('revives dates, which JSON does not carry', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));
        // Simulate the round trip through JSON that a real store performs.
        cache.entries.set('u1', JSON.parse(JSON.stringify(cache.entries.get('u1'))));

        await subject.hydrate();

        const [[hydrated]] = (profiles.hydrateFrom as ReturnType<typeof vi.fn>).mock.calls;
        expect(hydrated[0].updatedAt).toBeInstanceOf(Date);
    });

    it('hydrating an empty cache loads nothing and does not throw', async () => {
        configure();
        expect(await subject.hydrate()).toBe(0);
    });

    it('revalidates every hydrated id in the background', async () => {
        const fetchByUserId = vi.fn(() => of(profile('u1', 'ada')));
        configure(fetchByUserId);
        await subject.remember(profile('u1', 'ada'));
        await subject.remember(profile('u2', 'grace'));
        await subject.hydrate();

        subject.revalidateAll();
        await subject.queue.drain();

        expect(fetchByUserId).toHaveBeenCalledTimes(2);
    });

    /**
     * The account-crossing defect. Signing out is `router.navigate(['/authentication'])` and
     * signing back in is `router.navigate(['/overview'])` - one document, one injector, one live
     * `ProfileCacheService`. A store memoised on first use would put account B's profiles under
     * account A's device id, where A's next launch hydrates them as its own contact graph.
     */
    it('writes under the device id of the account signed in now, not the one it started with', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));
        expect(opened).toEqual(['device-a']);

        deviceId = 'device-b';
        await subject.remember(profile('u2', 'grace'));

        expect(opened).toEqual(['device-a', 'device-b']);
    });

    /**
     * `CacheStore.set` rejects on `quota`, `unavailable`, `blocked` and `version`. Discarded, that
     * rejection reaches `GlobalErrorHandler`, which reloads the window after three in five seconds
     * - and `revalidateAll` on an exhausted quota produces three in well under a second.
     */
    it('a rejecting cache write never escapes the write-behind hook', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        configure();
        cache.set = () => Promise.reject(new Error('quota exceeded'));
        await subject.hydrate();

        expect(profiles.cachePersist).not.toBeNull();
        // Would be an unhandled rejection without the catch, which fails this file outright.
        expect(() => profiles.cachePersist!(profile('u1', 'ada'))).not.toThrow();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(debug).toHaveBeenCalled();
        debug.mockRestore();
    });

    it('a failed revalidation leaves the cached copy in place', async () => {
        const fetchByUserId = vi.fn(() => throwError(() => new Error('429')));
        configure(fetchByUserId);
        await subject.remember(profile('u1', 'ada'));
        await subject.hydrate();

        subject.revalidateAll();
        await subject.queue.drain();

        expect(cache.entries.get('u1')).toMatchObject({userName: 'ada'});
    });
});
