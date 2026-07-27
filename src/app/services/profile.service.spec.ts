import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {ProfileService} from './profile.service';
import {ApiConfigService} from './api-config.service';
import {OnlineStatus} from '../dtos/response/profile.dto';

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
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        service.setSelfStatus(OnlineStatus.DoNotDisturb).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me/status');
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.DoNotDisturb,
        });
        expect(service.ownProfile()?.onlineStatus).toBe(OnlineStatus.DoNotDisturb);
    });
});
