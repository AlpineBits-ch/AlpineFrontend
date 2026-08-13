import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideFakePlatform} from '../platform/testing/provide-fake-platform';
import {UserService} from './user.service';
import {ApiConfigService} from './api-config.service';
import {AccountStatus, UserDto, UserType} from '../dtos/response/UserDto';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            // UserService injects MlsService, which injects MlsEngine. Nothing here encrypts
            // anything; the fakes are what keep this spec from having to know that chain exists.
            provideFakePlatform(),
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

const SELF = 'https://api.test.example/api/v1/identity/users/self';

/**
 * `getSelf` is called from about eight places, several of them within the same launch - the main
 * page alone asks twice - and it had no coalescing, so the largest payload the identity service
 * serves was pulled two or three times per start.
 *
 * <p><b>Coalescing only, deliberately not cache-first.</b> The settings screens call this because
 * they want the current row, master-key envelope and device list included, so answering a later
 * caller from a stored copy would quietly stop them reflecting a change made on another device.
 * Callers that overlap share one request; a caller arriving after it settled still refetches.</p>
 */
describe('UserService.getSelf coalescing', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('shares one request between concurrent callers and answers all of them', () => {
        const {service, ctrl} = setup();
        const seen: string[] = [];

        service.getSelf().subscribe(u => seen.push(u.id));
        service.getSelf().subscribe(u => seen.push(u.id));
        service.getSelf().subscribe(u => seen.push(u.id));

        const requests = ctrl.match(SELF);
        expect(requests.length).toBe(1);

        requests[0].flush(makeUser());
        expect(seen).toEqual(['u1', 'u1', 'u1']);
        expect(service.self()?.id).toBe('u1');
    });

    it('refetches for a caller that arrives after the first request settled', () => {
        const {service, ctrl} = setup();

        service.getSelf().subscribe();
        ctrl.expectOne(SELF).flush(makeUser({status: AccountStatus.PendingDeletion}));

        service.getSelf().subscribe();
        ctrl.expectOne(SELF).flush(makeUser({status: AccountStatus.Active}));

        // The second answer is the live one, which is the whole reason this is not a cache.
        expect(service.self()?.status).toBe(AccountStatus.Active);
    });

    it('clears the window when the request fails, so the next caller retries', () => {
        const {service, ctrl} = setup();

        service.getSelf().subscribe({error: () => void 0});
        ctrl.expectOne(SELF).flush({}, {status: 500, statusText: 'Server Error'});

        service.getSelf().subscribe();
        ctrl.expectOne(SELF).flush(makeUser());
        expect(service.self()?.id).toBe('u1');
    });

    /**
     * Coalescing is only safe between callers that want "the current row". A caller that wants "the
     * row after my write" must not be handed a request that predates the write - here that would
     * leave the account showing as Active immediately after the user asked to delete it.
     */
    it('does not let the post-delete refetch join a request that predates the delete', () => {
        const {service, ctrl} = setup();

        service.getSelf().subscribe();
        const stale = ctrl.expectOne(req => req.method === 'GET' && req.url === SELF);

        service.deleteAccount().subscribe();
        ctrl.expectOne(req => req.method === 'DELETE').flush({purgeScheduledAt: '2026-08-29T21:56:14.821Z'});

        const refetch = ctrl.match(req => req.method === 'GET' && req.url === SELF);
        expect(refetch.length).toBe(1);

        // The older answer lands first and is stale by the time it does; the refetch is what the
        // deletion screen is waiting on.
        stale.flush(makeUser({status: AccountStatus.Active}));
        refetch[0].flush(makeUser({status: AccountStatus.PendingDeletion}));

        expect(service.self()?.status).toBe(AccountStatus.PendingDeletion);
    });
});

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
