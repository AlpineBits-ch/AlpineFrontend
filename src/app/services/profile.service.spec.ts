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
