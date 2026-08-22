import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {signal} from '@angular/core';
import {OnboardingService} from './onboarding.service';
import {ApiConfigService} from './api-config.service';
import {UserService} from './user.service';
import {UserDto, UserInterest} from '../dtos/response/UserDto';

const BASE = 'https://api.test.example';
const URL = `${BASE}/api/v1/identity/users/self/onboarding`;

function user(overrides: Partial<UserDto> = {}): UserDto {
    return {id: 'user_1', ...overrides} as UserDto;
}

function setup(initial: UserDto | null = user()) {
    const self = signal<UserDto | null>(initial);
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: UserService, useValue: {self}},
        ],
    });
    return {
        service: TestBed.inject(OnboardingService),
        ctrl: TestBed.inject(HttpTestingController),
        self,
    };
}

describe('OnboardingService.needsOnboarding', () => {
    it('is true for an account that has never answered the picker', () => {
        const {service} = setup(user({onboardedAt: null}));
        expect(service.needsOnboarding()).toBe(true);
    });

    it('is false once onboardedAt is stamped', () => {
        const {service} = setup(user({onboardedAt: '2026-08-03T10:00:00Z'}));
        expect(service.needsOnboarding()).toBe(false);
    });

    /**
     * A server predating this feature sends neither field. Reading that as "needs onboarding"
     * would put every user of such a server behind a picker whose submit route answers 404 -
     * an unbreakable loop, and the exact failure the optionality of these fields exists to avoid.
     */
    it('is false when the server omits the field entirely', () => {
        const {service} = setup(user());
        expect(service.needsOnboarding()).toBe(false);
    });

    it('is false while self has not loaded, so nothing flashes during launch', () => {
        const {service} = setup(null);
        expect(service.needsOnboarding()).toBe(false);
    });
});

describe('OnboardingService.wantsSocial', () => {
    it('is true when social is among the interests', () => {
        const {service} = setup(user({interests: [UserInterest.Isle, UserInterest.Social]}));
        expect(service.wantsSocial()).toBe(true);
    });

    it('is false for an Isle-only account', () => {
        const {service} = setup(user({interests: [UserInterest.Isle]}));
        expect(service.wantsSocial()).toBe(false);
    });

    /**
     * Same reasoning as needsOnboarding: an older server that never sends interests has users who
     * have always had key setup at launch, and must keep having it.
     */
    it('is true when the server omits interests', () => {
        const {service} = setup(user());
        expect(service.wantsSocial()).toBe(true);
    });
});

describe('OnboardingService.submit', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PUTs the chosen interests', () => {
        const {service, ctrl} = setup();
        void service.submit([UserInterest.Isle]);
        const req = ctrl.expectOne(URL);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({interests: ['isle']});
        req.flush({onboardedAt: '2026-08-03T10:00:00Z', interests: ['isle']});
    });

    it('patches self from the response so the launch branch agrees without a refetch', async () => {
        const {service, ctrl, self} = setup();
        const done = service.submit([UserInterest.Isle]);
        ctrl.expectOne(URL).flush({onboardedAt: '2026-08-03T10:00:00Z', interests: ['isle']});
        await done;
        expect(self()?.onboardedAt).toBe('2026-08-03T10:00:00Z');
        expect(self()?.interests).toEqual([UserInterest.Isle]);
    });

    it('leaves self untouched when the write fails, so a retry is still offered', async () => {
        const {service, ctrl, self} = setup();
        const done = service.submit([UserInterest.Isle]);
        ctrl.expectOne(URL).flush('nope', {status: 500, statusText: 'Server Error'});
        await expect(done).rejects.toBeTruthy();
        expect(self()?.onboardedAt).toBeUndefined();
    });

    it('refuses an empty selection without calling the server', async () => {
        const {service, ctrl} = setup();
        await expect(service.submit([])).rejects.toBeTruthy();
        ctrl.expectNone(URL);
    });

    /**
     * The whole point of the deferral: completing key setup later has to move the account into
     * 'social', or the launch sequence keeps treating it as Isle-only and the two disagree forever.
     */
    it('addSocialInterest unions rather than replaces', () => {
        const {service, ctrl} = setup(user({interests: [UserInterest.Isle]}));
        void service.addSocialInterest();
        const req = ctrl.expectOne(URL);
        expect(req.request.body).toEqual({interests: ['isle', 'social']});
        req.flush({onboardedAt: '2026-08-03T10:00:00Z', interests: ['isle', 'social']});
    });

    it('addSocialInterest is a no-op when the account already wants social', () => {
        const {service, ctrl} = setup(user({interests: [UserInterest.Social]}));
        void service.addSocialInterest();
        ctrl.expectNone(URL);
    });
});
