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

function profileFor(userId: string) {
    return {
        id: `p_${userId}`, userId, userName: 'Ada', bio: undefined, avatarUrl: undefined,
        bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
        createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
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
    /**
     * Drains and resets even when `verify()` throws.
     *
     * <p>Without the reset, one failing expectation in this suite leaves the TestBed instantiated
     * and every later test in the file dies with "Cannot configure the test module", which buries
     * the one assertion that actually failed.</p>
     */
    afterEach(() => {
        const ctrl = TestBed.inject(HttpTestingController);
        try {
            ctrl.verify();
        } finally {
            ctrl.match(() => true).forEach(r => r.flush({}));
            TestBed.resetTestingModule();
        }
    });

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
        service.getByUserId(USER).subscribe(p => fromCache = p.userName);

        expect(fromCache).toBe('Ada');
        ctrl.expectNone(BY_USER);
    });

    it('still fetches different user ids separately', () => {
        const {service, ctrl} = setup();

        service.resolveByUserId('user_a');
        service.resolveByUserId('user_b');
        service.resolveByUserId('user_a');

        ctrl.expectOne('https://api.test.example/api/v1/social/profiles/by-user/user_a')
            .flush(profileFor('user_a'));
        ctrl.expectOne('https://api.test.example/api/v1/social/profiles/by-user/user_b')
            .flush(profileFor('user_b'));
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

    // A failed fetch must leave nothing behind, or the id becomes permanently unfetchable.
    it('clears the in-flight entry when the request fails', () => {
        const {service, ctrl} = setup();

        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush({}, {status: 429, statusText: 'Too Many Requests'});

        service.resolveByUserId(USER);
        ctrl.expectOne(BY_USER).flush(profileFor(USER));
    });

    it('coalesces concurrent fetches by profile id too', () => {
        const {service, ctrl} = setup();
        const url = 'https://api.test.example/api/v1/social/profiles/p1';

        for (let i = 0; i < 10; i++) service.resolveById('p1');

        expect(ctrl.match(url).length).toBe(1);
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
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        service.setSelfStatus(OnlineStatus.DoNotDisturb).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me/status');
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.DoNotDisturb,
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
            id: 'p1', userId: 'u1', userName: 'me', bio: 'hi', avatarUrl: undefined,
            bannerUrl: undefined, accentColor: '#5865F2', font: ProfileFont.Serif,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
    });

    it('updates ownProfile signal on success', () => {
        const {service, ctrl} = setup();
        service.updateProfile({bio: 'hi'}).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me');
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: 'hi', avatarUrl: undefined,
            bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        expect(service.ownProfile()?.bio).toBe('hi');
    });
});

describe('ProfileService.uploadBanner', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('does nothing when there is no current profile', () => {
        const {service, ctrl} = setup();
        const file = new File(['x'], 'banner.png', {type: 'image/png'});
        let completed = false;
        service.uploadBanner(file).subscribe({complete: () => completed = true});
        expect(completed).toBe(true);
        ctrl.verify();
    });

    it('PATCHes /api/v1/social/profiles/{id}/banner with FormData, then refetches the profile via getSelf since the upload endpoint returns no body', () => {
        const {service, ctrl} = setup();
        service['ownProfile'].set({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
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
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            bannerUrl: 'https://cdn.example/banner.png', accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        expect(service.ownProfile()?.bannerUrl).toBe('https://cdn.example/banner.png');
    });
});
