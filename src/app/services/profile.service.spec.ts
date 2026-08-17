import {effect} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {ProfileService} from './profile.service';
import {ApiConfigService} from './api-config.service';
import {OnlineStatus, ProfileFont} from '../dtos/response/profile.dto';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(ProfileService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

const USER = 'user_3HOx0QEFRmtVe4s3719mX1y95WQ';
const BY_USER = `https://api.test.example/api/v1/social/profiles/by-user/${USER}`;
const ME = 'https://api.test.example/api/v1/social/profiles/me';
const byUser = (userId: string) => `https://api.test.example/api/v1/social/profiles/by-user/${userId}`;

/**
 * Drains and resets even when `verify()` throws.
 *
 * <p>Without the reset, one failing expectation leaves the TestBed instantiated and every later
 * test in the file dies with "Cannot configure the test module", which buries the one assertion
 * that actually failed.</p>
 */
function drainAndReset(): void {
    const ctrl = TestBed.inject(HttpTestingController);
    try {
        ctrl.verify();
    } finally {
        ctrl.match(() => true).forEach(r => r.flush({}));
        TestBed.resetTestingModule();
    }
}

function profileFor(userId: string) {
    return {
        id: `p_${userId}`,
        userId,
        userName: 'Ada',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

/**
 * The 429 storm.
 *
 * <p>These assert <b>how many requests go out</b>, not what comes back. A test that only checks
 * the returned profile passes just as happily when the same id is fetched ten times, which is the
 * defect: on first paint every avatar, DM row, message header and friends-list entry resolved the
 * same user id inside one change-detection pass, each looked at a cache no response had reached
 * yet, and each issued its own GET.</p>
 */
describe('ProfileService request coalescing', () => {
    afterEach(drainAndReset);

    it('issues one request for ten concurrent resolutions of the same user id', () => {
        const {service, ctrl} = setup();

        for (let i = 0; i < 10; i++) service.resolveByUserId(USER);

        expect(ctrl.match(BY_USER).length).toBe(1);
        ctrl.expectNone(BY_USER);
    });

    it('coalesces getByUserId subscribers onto the same in-flight request', () => {
        const {service, ctrl} = setup();
        const seen: string[] = [];

        for (let i = 0; i < 10; i++) {
            service.getByUserId(USER).subscribe(p => seen.push(p.userName));
        }

        const requests = ctrl.match(BY_USER);
        expect(requests.length).toBe(1);

        requests[0].flush(profileFor(USER));
        // Every caller is still answered - coalescing shares the response, it does not drop it.
        expect(seen.length).toBe(10);
        expect(new Set(seen)).toEqual(new Set(['Ada']));
    });

    it('serves a later resolution from cache, so the whole scenario costs one request', () => {
        const {service, ctrl} = setup();

        for (let i = 0; i < 10; i++) service.resolveByUserId(USER);
        const requests = ctrl.match(BY_USER);
        expect(requests.length).toBe(1);
        requests[0].flush(profileFor(USER));

        // A second wave, after the response landed: a component re-rendering, a new avatar, the
        // friends-list effect re-running.
        for (let i = 0; i < 10; i++) service.resolveByUserId(USER);
        let fromCache: string | undefined;
        service.getByUserId(USER).subscribe(p => (fromCache = p.userName));

        expect(fromCache).toBe('Ada');
        ctrl.expectNone(BY_USER);
    });

    it('still fetches different user ids separately', () => {
        const {service, ctrl} = setup();

        service.resolveByUserId('user_a');
        service.resolveByUserId('user_b');
        service.resolveByUserId('user_a');

        ctrl.expectOne('https://api.test.example/api/v1/social/profiles/by-user/user_a').flush(
            profileFor('user_a'),
        );
        ctrl.expectOne('https://api.test.example/api/v1/social/profiles/by-user/user_b').flush(
            profileFor('user_b'),
        );
    });

    // The coalescing window is not a second cache. Settings tables call `fetchByUserId` precisely
    // because they want a fresh row, and a window that outlived its request would silently stop
    // them refetching.
    it('lets an explicit fetch go out again once the previous one has settled', () => {
        const {service, ctrl} = setup();

        service.fetchByUserId(USER).subscribe();
        ctrl.expectOne(BY_USER).flush(profileFor(USER));

        service.fetchByUserId(USER).subscribe();
        ctrl.expectOne(BY_USER).flush(profileFor(USER));
    });

    // A failed fetch must leave nothing behind in the *coalescing* map, or the id becomes
    // permanently unfetchable. (The negative cache below deliberately does hold a failed id back,
    // but only on the `resolve*` path - `fetchByUserId` is the escape hatch and must still work.)
    it('clears the in-flight entry when the request fails', () => {
        const {service, ctrl} = setup();

        service.fetchByUserId(USER).subscribe();
        ctrl.expectOne(BY_USER).flush({}, {status: 429, statusText: 'Too Many Requests'});

        service.fetchByUserId(USER).subscribe();
        ctrl.expectOne(BY_USER).flush(profileFor(USER));
    });

    it('coalesces concurrent fetches by profile id too', () => {
        const {service, ctrl} = setup();
        const url = 'https://api.test.example/api/v1/social/profiles/p1';

        for (let i = 0; i < 10; i++) service.resolveById('p1');

        expect(ctrl.match(url).length).toBe(1);
    });
});

/**
 * The sequential half of the storm, which coalescing cannot reach.
 *
 * <p>Coalescing only merges callers that arrive while a request is on the wire. An id that
 * <b>failed</b> left the cache exactly as empty as before it was asked for, so the next paint asked
 * again, and the next, forever - and since every profile that lands re-runs every avatar effect on
 * screen, "the next paint" happens once per profile in the batch. Ten profiles arriving meant the
 * one deleted user was fetched ten times, one request at a time, each one settling before the next
 * began.</p>
 */
describe('ProfileService negative caching', () => {
    afterEach(() => {
        try {
            drainAndReset();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not re-request a user id whose fetch failed', () => {
        const {service, ctrl} = setup();

        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush({}, {status: 404, statusText: 'Not Found'});

        // Every subsequent profile landing on this screen re-runs the avatar effect behind this id.
        for (let i = 0; i < 10; i++) service.resolveByUserId(USER);

        ctrl.expectNone(BY_USER);
    });

    it('does not re-request a profile id whose fetch failed', () => {
        const {service, ctrl} = setup();
        const url = 'https://api.test.example/api/v1/social/profiles/p_gone';

        service.resolveById('p_gone');
        ctrl.expectOne(url).flush({}, {status: 404, statusText: 'Not Found'});

        for (let i = 0; i < 10; i++) service.resolveById('p_gone');

        ctrl.expectNone(url);
    });

    // A cooldown, not a tombstone: a 429 or a blip must not cost the profile for the whole session.
    it('lets the id be resolved again once the cooldown has elapsed', () => {
        vi.useFakeTimers();
        const {service, ctrl} = setup();

        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush({}, {status: 429, statusText: 'Too Many Requests'});

        vi.advanceTimersByTime(59_000);
        service.resolveByUserId(USER);
        ctrl.expectNone(BY_USER);

        vi.advanceTimersByTime(2_000);
        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush(profileFor(USER));
    });

    // The settings tables ask explicitly because they want a fresh row; the negative cache gates
    // the fire-and-forget path only.
    it('does not block an explicit fetch', () => {
        const {service, ctrl} = setup();

        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush({}, {status: 404, statusText: 'Not Found'});

        service.fetchByUserId(USER).subscribe();
        ctrl.expectOne(BY_USER).flush(profileFor(USER));
    });

    it('forgets the failure once the id resolves', () => {
        vi.useFakeTimers();
        const {service, ctrl} = setup();

        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush({}, {status: 404, statusText: 'Not Found'});

        // An explicit fetch succeeds - a user that had been deleted was restored, or the 404 was a
        // routing blip. The id must not stay marked, or it would go dark again the moment the
        // profile is evicted for any other reason.
        service.fetchByUserId(USER).subscribe();
        ctrl.expectOne(BY_USER).flush(profileFor(USER));

        const marked = (service as unknown as {negativeByUserId: Map<string, number>}).negativeByUserId;
        expect(marked.has(USER)).toBe(false);
    });

    it('holds back only the id that failed', () => {
        const {service, ctrl} = setup();

        service.resolveByUserId('user_a');
        ctrl.expectOne(byUser('user_a')).flush({}, {status: 404, statusText: 'Not Found'});

        service.resolveByUserId('user_a');
        service.resolveByUserId('user_b');

        ctrl.expectNone(byUser('user_a'));
        ctrl.expectOne(byUser('user_b')).flush(profileFor('user_b'));
    });

    /**
     * The circuit breaker and the negative cache answer different questions - "is the profile
     * service up" versus "does this id resolve" - and feeding one from the other breaks both. A
     * 30-second outage would otherwise mark every id that happened to be on screen and keep them
     * dark for a further minute after the service came back.
     */
    it('does not mark ids that were never requested because the circuit was open', () => {
        vi.useFakeTimers();
        const {service, ctrl} = setup();

        // Trip the breaker on ids nobody will ask about again.
        for (const id of ['trip_a', 'trip_b', 'trip_c']) {
            service.fetchByUserId(id).subscribe();
            ctrl.expectOne(byUser(id)).flush({}, {status: 503, statusText: 'Service Unavailable'});
        }

        // Open: this never reaches the wire, so it is not evidence about `USER`.
        service.resolveByUserId(USER);
        ctrl.expectNone(BY_USER);

        // Recovery window elapses, the breaker half-opens, and `USER` gets its first real try.
        vi.advanceTimersByTime(31_000);
        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush(profileFor(USER));
    });
});

/**
 * Why `resolve*` reads the cache untracked.
 *
 * <p>`avatar.component`, `message.component` and `system-message.component` all call a resolver from
 * inside an `effect`. Reading the profile map there made every one of those effects a subscriber to
 * <b>the whole map</b>, and `store` replaces the map object on every profile that lands - so one
 * profile arriving re-ran every avatar and message effect on screen, and each re-run re-asked for
 * any id the cache still lacked. That is the multiplier that turned one unresolvable id into ten
 * requests.</p>
 */
describe('ProfileService resolver reactivity', () => {
    afterEach(drainAndReset);

    /** Caps its own re-entry so a regression fails the assertion instead of hanging the run. */
    function countEffectRuns(body: () => void): () => number {
        let runs = 0;
        TestBed.runInInjectionContext(() => {
            effect(() => {
                runs++;
                if (runs > 20) return;
                body();
            });
        });
        TestBed.tick();
        return () => runs;
    }

    it('does not re-run a caller effect when an unrelated profile is stored', () => {
        const {service, ctrl} = setup();
        const runs = countEffectRuns(() => service.resolveByUserId('user_a'));
        expect(runs()).toBe(1);

        ctrl.expectOne(byUser('user_a')).flush(profileFor('user_a'));
        service.resolveByUserId('user_b');
        ctrl.expectOne(byUser('user_b')).flush(profileFor('user_b'));
        TestBed.tick();

        expect(runs()).toBe(1);
    });

    it('does not re-run a caller effect resolving by profile id either', () => {
        const {service, ctrl} = setup();
        const runs = countEffectRuns(() => service.resolveById('p_a'));
        expect(runs()).toBe(1);

        ctrl.expectOne('https://api.test.example/api/v1/social/profiles/p_a').flush(profileFor('a'));
        service.resolveByUserId('user_b');
        ctrl.expectOne(byUser('user_b')).flush(profileFor('user_b'));
        TestBed.tick();

        expect(runs()).toBe(1);
    });
});

/**
 * `getSelf` is called from the app shell, the main page and quick settings, all within a few frames
 * of launch, and it had no coalescing at all.
 *
 * <p>Coalescing only, deliberately: quick settings and the settings pages call this <b>because</b>
 * they want a fresh row, so a cache-first version would quietly stop them ever seeing a change made
 * on another device.</p>
 */
describe('ProfileService.getSelf coalescing', () => {
    afterEach(drainAndReset);

    it('shares one request between concurrent callers and answers all of them', () => {
        const {service, ctrl} = setup();
        const seen: string[] = [];

        service.getSelf().subscribe(p => seen.push(p.userName));
        service.getSelf().subscribe(p => seen.push(p.userName));
        service.getSelf().subscribe(p => seen.push(p.userName));

        const requests = ctrl.match(ME);
        expect(requests.length).toBe(1);

        requests[0].flush(profileFor('u1'));
        expect(seen).toEqual(['Ada', 'Ada', 'Ada']);
    });

    it('refetches for a caller that arrives after the first request settled', () => {
        const {service, ctrl} = setup();

        service.getSelf().subscribe();
        ctrl.expectOne(ME).flush(profileFor('u1'));

        // The settings page reopening, quick settings being opened again: these want the live row.
        service.getSelf().subscribe();
        ctrl.expectOne(ME).flush(profileFor('u1'));
    });

    it('clears the window when the request fails, so the next caller retries', () => {
        const {service, ctrl} = setup();

        service.getSelf().subscribe({error: () => void 0});
        ctrl.expectOne(ME).flush({}, {status: 500, statusText: 'Server Error'});

        service.getSelf().subscribe();
        ctrl.expectOne(ME).flush(profileFor('u1'));
    });

    /**
     * The read-after-write case. An avatar upload refetches because the PATCH returns no body, and
     * joining a `me` request that was already on the wire would answer it with the profile as it
     * was before the upload - the new avatar missing until something else happened to refetch.
     */
    it('does not let an avatar upload join a request that predates it', () => {
        const {service, ctrl} = setup();
        service['ownProfile'].set(profileFor('u1'));

        service.getSelf().subscribe();
        const stale = ctrl.expectOne(ME);

        service.uploadAvatar(new File(['x'], 'a.png', {type: 'image/png'})).subscribe();
        ctrl.expectOne('https://api.test.example/api/v1/social/profiles/p_u1/avatar').flush('');

        const refetch = ctrl.match(ME);
        expect(refetch.length).toBe(1);

        stale.flush(profileFor('u1'));
        refetch[0].flush({...profileFor('u1'), avatarUrl: 'https://cdn.example/new.png'});

        expect(service.ownProfile()?.avatarUrl).toBe('https://cdn.example/new.png');
    });
});

describe('ProfileService.setSelfStatus', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PATCHes /api/v1/social/profiles/me/status with the status', () => {
        const {service, ctrl} = setup();
        service.setSelfStatus(OnlineStatus.Idle).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me/status');
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({status: 'Idle'});
        req.flush({onlineStatus: 'Idle'});
    });

    it('updates ownProfile signal on success', () => {
        const {service, ctrl} = setup();
        service['ownProfile'].set({
            id: 'p1',
            userId: 'u1',
            userName: 'me',
            bio: undefined,
            avatarUrl: undefined,
            bannerUrl: undefined,
            accentColor: null,
            font: ProfileFont.Default,
            createdAt: new Date(),
            updatedAt: new Date(),
            onlineStatus: OnlineStatus.Online,
        });
        service.setSelfStatus(OnlineStatus.DoNotDisturb).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me/status');
        req.flush({
            id: 'p1',
            userId: 'u1',
            userName: 'me',
            bio: undefined,
            avatarUrl: undefined,
            bannerUrl: undefined,
            accentColor: null,
            font: ProfileFont.Default,
            createdAt: new Date(),
            updatedAt: new Date(),
            onlineStatus: OnlineStatus.DoNotDisturb,
        });
        expect(service.ownProfile()?.onlineStatus).toBe(OnlineStatus.DoNotDisturb);
    });
});

describe('ProfileService.updateProfile', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PATCHes /api/v1/social/profiles/me with the patch body', () => {
        const {service, ctrl} = setup();
        service.updateProfile({bio: 'hi', accentColor: '#5865F2', font: ProfileFont.Serif}).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me');
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({bio: 'hi', accentColor: '#5865F2', font: 'Serif'});
        req.flush({
            id: 'p1',
            userId: 'u1',
            userName: 'me',
            bio: 'hi',
            avatarUrl: undefined,
            bannerUrl: undefined,
            accentColor: '#5865F2',
            font: ProfileFont.Serif,
            createdAt: new Date(),
            updatedAt: new Date(),
            onlineStatus: OnlineStatus.Online,
        });
    });

    it('updates ownProfile signal on success', () => {
        const {service, ctrl} = setup();
        service.updateProfile({bio: 'hi'}).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me');
        req.flush({
            id: 'p1',
            userId: 'u1',
            userName: 'me',
            bio: 'hi',
            avatarUrl: undefined,
            bannerUrl: undefined,
            accentColor: null,
            font: ProfileFont.Default,
            createdAt: new Date(),
            updatedAt: new Date(),
            onlineStatus: OnlineStatus.Online,
        });
        expect(service.ownProfile()?.bio).toBe('hi');
    });
});

/**
 * `hydrateFrom` is the boot-path bulk loader `ProfileCacheService` calls with everything read
 * back from disk. Its two invariants matter more than anything else in this file: a live row
 * fetched this session must beat the disk copy (`??=`, not `=`), and the whole batch must land
 * as one signal write, not one per profile - `store` re-runs every avatar and message effect on
 * screen, and hydrating a few thousand cached rows through it would run each of those a few
 * thousand times.
 *
 * <p>`profile-cache.service.spec.ts` only proves `ProfileCacheService` <i>calls</i>
 * `hydrateFrom` with the right array - there `ProfileService` is a hand-built stand-in and this
 * method's real body never runs. These tests exercise the real implementation instead.</p>
 */
describe('ProfileService.hydrateFrom', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('does not let a hydrated row overwrite one already fetched this session', () => {
        const {service} = setup();
        const live = profileFor('user_a');
        service['byProfileId'].set({[live.id]: live});
        service['byUserId'].set({[live.userId]: live});

        // Same ids, different object and different content - as if the disk copy were stale.
        const staleSameUser = {...profileFor('user_a'), userName: 'Stale'};
        const fresh = profileFor('user_b');
        service.hydrateFrom([staleSameUser, fresh]);

        expect(service.getCachedByUserId('user_a')).toBe(live);
        expect(service.getCachedById(live.id)).toBe(live);
        expect(service.getCachedByUserId('user_b')).toEqual(fresh);
    });

    it('populates both indexes for a hydrated profile', () => {
        const {service} = setup();
        const p = profileFor('user_c');

        service.hydrateFrom([p]);

        expect(service.getCachedById(p.id)).toEqual(p);
        expect(service.getCachedByUserId(p.userId)).toEqual(p);
    });

    it('writes each index signal exactly once, regardless of how many profiles are hydrated', () => {
        const {service} = setup();
        const byProfileIdSet = vi.spyOn(service['byProfileId'], 'set');
        const byUserIdSet = vi.spyOn(service['byUserId'], 'set');
        const byProfileIdUpdate = vi.spyOn(service['byProfileId'], 'update');
        const byUserIdUpdate = vi.spyOn(service['byUserId'], 'update');

        service.hydrateFrom([profileFor('user_d'), profileFor('user_e'), profileFor('user_f')]);

        expect(byProfileIdSet).toHaveBeenCalledTimes(1);
        expect(byUserIdSet).toHaveBeenCalledTimes(1);
        expect(byProfileIdUpdate).not.toHaveBeenCalled();
        expect(byUserIdUpdate).not.toHaveBeenCalled();
    });

    it('does nothing for an empty batch', () => {
        const {service} = setup();
        const byProfileIdSet = vi.spyOn(service['byProfileId'], 'set');
        const byUserIdSet = vi.spyOn(service['byUserId'], 'set');

        service.hydrateFrom([]);

        expect(byProfileIdSet).not.toHaveBeenCalled();
        expect(byUserIdSet).not.toHaveBeenCalled();
    });
});

describe('ProfileService.uploadBanner', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('does nothing when there is no current profile', () => {
        const {service, ctrl} = setup();
        const file = new File(['x'], 'banner.png', {type: 'image/png'});
        let completed = false;
        service.uploadBanner(file).subscribe({complete: () => (completed = true)});
        expect(completed).toBe(true);
        ctrl.verify();
    });

    it('PATCHes /api/v1/social/profiles/{id}/banner with FormData, then refetches the profile via getSelf since the upload endpoint returns no body', () => {
        const {service, ctrl} = setup();
        service['ownProfile'].set({
            id: 'p1',
            userId: 'u1',
            userName: 'me',
            bio: undefined,
            avatarUrl: undefined,
            bannerUrl: undefined,
            accentColor: null,
            font: ProfileFont.Default,
            createdAt: new Date(),
            updatedAt: new Date(),
            onlineStatus: OnlineStatus.Online,
        });
        const file = new File(['x'], 'banner.png', {type: 'image/png'});
        service.uploadBanner(file).subscribe();

        const patchReq = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/p1/banner');
        expect(patchReq.request.method).toBe('PATCH');
        expect(patchReq.request.body instanceof FormData).toBe(true);
        // The real endpoint returns only a status code, no body -flush empty text to match.
        patchReq.flush('');

        // uploadBanner discards the PATCH's own (bodyless) response and refetches the
        // authoritative profile instead, since the upload endpoint doesn't return one.
        const getReq = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me');
        expect(getReq.request.method).toBe('GET');
        getReq.flush({
            id: 'p1',
            userId: 'u1',
            userName: 'me',
            bio: undefined,
            avatarUrl: undefined,
            bannerUrl: 'https://cdn.example/banner.png',
            accentColor: null,
            font: ProfileFont.Default,
            createdAt: new Date(),
            updatedAt: new Date(),
            onlineStatus: OnlineStatus.Online,
        });
        expect(service.ownProfile()?.bannerUrl).toBe('https://cdn.example/banner.png');
    });
});
