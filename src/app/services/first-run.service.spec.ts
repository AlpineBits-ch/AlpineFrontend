import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {FirstRunService} from './first-run.service';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';
import {SignupPasswordHolder} from './signup-password-holder';
import {EncryptedMasterKey, UserDto, UserInterest} from '../dtos/response/UserDto';

const KEY = {version: 1} as EncryptedMasterKey;

function setup(
    options: {
        user?: Partial<UserDto>;
        needsOnboarding?: boolean;
        passwordHeld?: boolean;
        engineAvailable?: boolean;
    } = {},
) {
    const self = signal<UserDto | null>({
        id: 'user_1',
        onboardedAt: '2026-01-01T00:00:00Z',
        interests: [UserInterest.Social],
        ...options.user,
    } as UserDto);
    const needsOnboarding = signal(options.needsOnboarding ?? false);
    const passwordHeld = signal(options.passwordHeld ?? true);

    TestBed.configureTestingModule({
        providers: [
            {provide: UserService, useValue: {self}},
            {provide: OnboardingService, useValue: {needsOnboarding}},
            {provide: MasterKeyService, useValue: {isAvailable: () => options.engineAvailable ?? true}},
            {provide: SignupPasswordHolder, useValue: {has: () => passwordHeld()}},
        ],
    });

    return {service: TestBed.inject(FirstRunService), self, needsOnboarding, passwordHeld};
}

describe('FirstRunService.open', () => {
    it('resolves true without showing anything when nothing is owed', async () => {
        const {service} = setup({user: {encryptedMasterKey: KEY}});

        await expect(service.open()).resolves.toBe(true);
        expect(service.visible()).toBe(false);
    });

    it('shows the takeover with the steps this account owes', () => {
        const {service} = setup({needsOnboarding: true, passwordHeld: false});

        void service.open();

        expect(service.visible()).toBe(true);
        expect(service.steps()).toEqual(['pick', 'password', 'recovery-code']);
    });

    /** The rail is sized off this list, so it must not resize under someone mid-answer. */
    it('keeps the snapshotted steps when the account changes under it', () => {
        const {service, self, needsOnboarding, passwordHeld} = setup();

        void service.open();
        expect(service.steps()).toEqual(['recovery-code']);

        self.set({id: 'user_1', encryptedMasterKey: KEY} as UserDto);
        needsOnboarding.set(true);
        passwordHeld.set(false);

        expect(service.steps()).toEqual(['recovery-code']);
    });

    it('shares one run between concurrent callers and answers both', async () => {
        const {service, needsOnboarding} = setup();

        const first = service.open();
        needsOnboarding.set(true);
        const second = service.open();

        expect(service.steps()).toEqual(['recovery-code']);

        service.complete();

        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(service.visible()).toBe(false);
    });

    /** A gated action demands a key whatever the picker's stored answer was. */
    it('owes the key steps for an Isle-only account when the caller requires one', () => {
        const {service} = setup({user: {interests: [UserInterest.Isle]}, passwordHeld: false});

        void service.open({keyRequired: true});

        expect(service.steps()).toEqual(['password', 'recovery-code']);
    });

    it('owes no key steps without a local key engine', () => {
        const {service} = setup({needsOnboarding: true, engineAvailable: false});

        void service.open();

        expect(service.steps()).toEqual(['pick']);
    });
});
