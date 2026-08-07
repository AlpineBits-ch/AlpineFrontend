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

/**
 * The account's own phone number.
 *
 * <p>Two things are being pinned. The route goes through <b>identity</b>, not guild - the sharing
 * opt-in next to it does go to guild, and writing this one to the wrong service is a 404 that looks
 * like "the feature is broken". And the cached self is patched from the <b>server's echo</b>: the
 * server normalises, so the string it stores can differ from the string that was sent, and it is the
 * stored one a housemate will be shown.</p>
 */
describe('UserService phone number', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PUTs to the identity service and returns the normalised number the server stored', () => {
        const {service, ctrl} = setup();
        let returned: string | undefined;
        service.setPhoneNumber('+41791234567').subscribe(value => returned = value);

        const req = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self/phone');
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({phoneNumber: '+41791234567'});
        req.flush({phoneNumber: '+41791234567'});

        expect(returned).toBe('+41791234567');
    });

    it('caches what the server echoed rather than what was sent', () => {
        const {service, ctrl} = setup();
        service.self.set(makeUser({phoneNumber: null}));

        // The separators are the case: the server strips them, so the stored form differs from the
        // typed form and only one of the two is the number a flatmate will be handed.
        service.setPhoneNumber('+41 79 123 45 67').subscribe();
        ctrl.expectOne(req => req.method === 'PUT').flush({phoneNumber: '+41791234567'});

        expect(service.self()?.phoneNumber).toBe('+41791234567');
    });

    it('leaves the cache alone when nothing has loaded self yet', () => {
        const {service, ctrl} = setup();
        service.setPhoneNumber('+41791234567').subscribe();
        ctrl.expectOne(req => req.method === 'PUT').flush({phoneNumber: '+41791234567'});

        // Inventing a UserDto from one field would put a half-built account in the signal every
        // other reader treats as the whole thing.
        expect(service.self()).toBeNull();
    });

    it('surfaces a rejected format instead of swallowing it', () => {
        const {service, ctrl} = setup();
        service.self.set(makeUser({phoneNumber: '+41791234567'}));

        let status: number | undefined;
        service.setPhoneNumber('+0041791234567')
            .subscribe({error: err => status = err.status});

        ctrl.expectOne(req => req.method === 'PUT')
            .flush('A phone number must be in international format', {status: 400, statusText: 'Bad Request'});

        expect(status).toBe(400);
        // A refused write must not look like it landed.
        expect(service.self()?.phoneNumber).toBe('+41791234567');
    });

    it('DELETEs the same path and clears the cached number', () => {
        const {service, ctrl} = setup();
        service.self.set(makeUser({phoneNumber: '+41791234567'}));

        service.removePhoneNumber().subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self/phone');
        expect(req.request.method).toBe('DELETE');
        req.flush(null, {status: 204, statusText: 'No Content'});

        expect(service.self()?.phoneNumber).toBeNull();
    });

    it('leaves every other field of self intact', () => {
        const {service, ctrl} = setup();
        service.self.set(makeUser({phoneNumber: null, steamId: 'steam-1'}));

        service.setPhoneNumber('+41791234567').subscribe();
        ctrl.expectOne(req => req.method === 'PUT').flush({phoneNumber: '+41791234567'});

        expect(service.self()?.steamId).toBe('steam-1');
        expect(service.self()?.email).toBe('me@example.com');
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
