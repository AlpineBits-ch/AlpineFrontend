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
        id: `prfl_${userId}`, userId, userName,
        bio: undefined, avatarUrl: undefined, bannerUrl: undefined,
        accentColor: null, font: ProfileFont.Default,
        createdAt: new Date(0), updatedAt: new Date(0),
        onlineStatus: OnlineStatus.Offline,
    };
}

/** An in-memory stand-in for CacheStore, so these tests are about the service, not IndexedDB. */
class FakeCacheStore {
    readonly entries = new Map<string, unknown>();
    async get(_d: string, key: string) { return this.entries.get(key); }
    async set(_d: string, key: string, value: unknown) { this.entries.set(key, value); }
    async delete(_d: string, key: string) { this.entries.delete(key); }
    async all<T>() { return [...this.entries.entries()] as [string, T][]; }
    async clear() { this.entries.clear(); }
    sizeOf() { return 0; }
}

let cache: FakeCacheStore;
let profiles: ProfileService;
let subject: ProfileCacheService;

function configure(fetchByUserId = vi.fn(() => of(profile('u1', 'ada')))) {
    cache = new FakeCacheStore();
    TestBed.configureTestingModule({
        providers: [
            {provide: CacheStoreFactory, useValue: {open: () => cache}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
            {provide: ProfileService, useValue: Object.assign(
                Object.create(ProfileService.prototype) as ProfileService,
                {
                    byUserIdMap: new Map<string, ProfileDto>(),
                    fetchByUserId,
                    hydrateFrom: vi.fn(),
                    cachePersist: null,
                })},
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
            ]));
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
