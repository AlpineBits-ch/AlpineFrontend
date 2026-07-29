import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {UserService} from './user.service';
import {ApiConfigService} from './api-config.service';
import {AccountStatus, UserDto, UserType} from '../dtos/response/UserDto';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(UserService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function makeUser(overrides: Partial<UserDto> = {}): UserDto {
    return {
        id: 'u1',
        email: 'me@example.com',
        userType: UserType.Standard,
        createdAt: new Date(),
        updatedAt: new Date(),
        birthDate: new Date(),
        phoneVerifiedAt: undefined,
        emailVerifiedAt: new Date(),
        ageVerification: undefined,
        encryptedMasterKey: undefined,
        steamId: undefined,
        status: AccountStatus.Active,
        deletionRequestedAt: undefined,
        purgeScheduledAt: undefined,
        ...overrides,
    };
}

describe('UserService.deleteAccount', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('DELETEs /api/v1/identity/users/self, then refetches self since the mutation response has no user body', () => {
        const {service, ctrl} = setup();
        service.deleteAccount().subscribe();

        const delReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self');
        expect(delReq.request.method).toBe('DELETE');
        delReq.flush({purgeScheduledAt: '2026-08-29T21:56:14.821Z'});

        const getReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self');
        expect(getReq.request.method).toBe('GET');
        getReq.flush(makeUser({status: AccountStatus.PendingDeletion}));
    });

    it('updates the self signal with the refreshed status', () => {
        const {service, ctrl} = setup();
        service.deleteAccount().subscribe();

        ctrl.expectOne(req => req.method === 'DELETE').flush({purgeScheduledAt: '2026-08-29T21:56:14.821Z'});
        ctrl.expectOne(req => req.method === 'GET').flush(makeUser({status: AccountStatus.PendingDeletion}));

        expect(service.self()?.status).toBe(AccountStatus.PendingDeletion);
    });
});

describe('UserService.cancelDeletion', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('POSTs /api/v1/identity/users/self/cancel-deletion, then refetches self', () => {
        const {service, ctrl} = setup();
        service.cancelDeletion().subscribe();

        const postReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self/cancel-deletion');
        expect(postReq.request.method).toBe('POST');
        postReq.flush(null);

        const getReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self');
        expect(getReq.request.method).toBe('GET');
        getReq.flush(makeUser({status: AccountStatus.Active}));
    });

    it('updates the self signal back to Active', () => {
        const {service, ctrl} = setup();
        service.cancelDeletion().subscribe();

        ctrl.expectOne(req => req.method === 'POST').flush(null);
        ctrl.expectOne(req => req.method === 'GET').flush(makeUser({status: AccountStatus.Active}));

        expect(service.self()?.status).toBe(AccountStatus.Active);
    });
});
