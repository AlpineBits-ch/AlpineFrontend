import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of} from 'rxjs';
import {SocialKeyGateService} from './social-key-gate.service';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';
import {EncryptedMasterKey, UserDto} from '../dtos/response/UserDto';

const KEY = {version: 1} as EncryptedMasterKey;

/**
 * `engineAvailable` defaults to true, which is not what the real predicate reports under jsdom.
 * It must stay stubbed, or every case below silently becomes "a browser lets everything through".
 */
function setup(initial: UserDto | null = {id: 'user_1'} as UserDto, engineAvailable = true) {
    const self = signal<UserDto | null>(initial);
    // Mirrors the real service, which tees every fetch into `self`.
    const getSelf = vi.fn(() => {
        const fetched = {id: 'user_1', encryptedMasterKey: KEY} as UserDto;
        self.set(fetched);
        return of(fetched);
    });
    const addSocialInterest = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const isAvailable = vi.fn(() => engineAvailable);
    TestBed.configureTestingModule({
        providers: [
            {provide: UserService, useValue: {self, getSelf}},
            {provide: OnboardingService, useValue: {addSocialInterest}},
            {provide: MasterKeyService, useValue: {isAvailable}},
        ],
    });
    return {service: TestBed.inject(SocialKeyGateService), self, getSelf, addSocialInterest, isAvailable};
}

describe('SocialKeyGateService.isSatisfied', () => {
    it('is true when the account already holds a master key', () => {
        const {service} = setup({id: 'user_1', encryptedMasterKey: KEY} as UserDto);
        expect(service.isSatisfied()).toBe(true);
    });

    it('is false when the account has no master key', () => {
        const {service} = setup();
        expect(service.isSatisfied()).toBe(false);
    });

    /** Fails open: blocking a send on an unloaded signal is worse than one unshown prompt. */
    it('is true while self has not loaded', () => {
        const {service} = setup(null);
        expect(service.isSatisfied()).toBe(true);
    });

    /**
     * The ceremony is Tauri commands, so a build with no engine cannot finish it: blocking there
     * forbids creating a guild and sending a message rather than deferring the setup.
     */
    it('is true with no local key engine, even though the account holds no key', () => {
        const {service} = setup({id: 'user_1'} as UserDto, false);
        expect(service.isSatisfied()).toBe(true);
    });

    /** The account state is not consulted there: there is nothing it could change. */
    it('does not consult the account when there is no engine', () => {
        const {service, isAvailable} = setup({id: 'user_1'} as UserDto, false);
        void service.require();
        expect(isAvailable).toHaveBeenCalled();
        expect(service.dialogVisible()).toBe(false);
    });
});

describe('SocialKeyGateService.require', () => {
    it('resolves true immediately without opening the dialog when a key exists', async () => {
        const {service} = setup({id: 'user_1', encryptedMasterKey: KEY} as UserDto);
        await expect(service.require()).resolves.toBe(true);
        expect(service.dialogVisible()).toBe(false);
    });

    it('opens a dismissible dialog when no key exists', () => {
        const {service} = setup();
        void service.require();
        expect(service.dialogVisible()).toBe(true);
        expect(service.dismissible()).toBe(true);
    });

    /** The caller must be let through, not parked behind a dialog nobody can finish. */
    it('resolves true without a dialog when there is no local key engine', async () => {
        const {service} = setup({id: 'user_1'} as UserDto, false);
        await expect(service.require()).resolves.toBe(true);
        expect(service.dialogVisible()).toBe(false);
    });

    it('resolves true once setup completes', async () => {
        const {service} = setup();
        const allowed = service.require();
        service.onSetupComplete();
        await expect(allowed).resolves.toBe(true);
        expect(service.dialogVisible()).toBe(false);
    });

    it('resolves false when the user backs out, leaving the caller to do nothing', async () => {
        const {service} = setup();
        const allowed = service.require();
        service.onDismissed();
        await expect(allowed).resolves.toBe(false);
        expect(service.dialogVisible()).toBe(false);
    });

    /**
     * A caller that retries the instant the dialog closes must not be told to set up a key it has
     * just written, and must not be handed a fabricated envelope to get there.
     */
    it('is satisfied immediately after completion, without waiting on the refetch', async () => {
        const {service, self} = setup();
        const allowed = service.require();
        service.onSetupComplete();
        await allowed;
        expect(service.isSatisfied()).toBe(true);
        expect(self()?.encryptedMasterKey).toBeTruthy();
    });

    it('records the social interest once setup completes', async () => {
        const {service, addSocialInterest} = setup();
        const allowed = service.require();
        service.onSetupComplete();
        await allowed;
        expect(addSocialInterest).toHaveBeenCalled();
    });

    /** Two gated actions in quick succession must share one dialog and one answer. */
    it('shares one dialog between concurrent callers and answers both', async () => {
        const {service} = setup();
        const first = service.require();
        const second = service.require();
        service.onSetupComplete();
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    });
});

describe('SocialKeyGateService.promptNow', () => {
    /** The launch-time path: same dialog, no action waiting behind it and no way out. */
    it('opens the dialog non-dismissibly', () => {
        const {service} = setup();
        service.promptNow();
        expect(service.dialogVisible()).toBe(true);
        expect(service.dismissible()).toBe(false);
    });

    it('does not record a social interest, since the account already stated one', async () => {
        const {service, addSocialInterest} = setup();
        service.promptNow();
        service.onSetupComplete();
        await Promise.resolve();
        expect(addSocialInterest).not.toHaveBeenCalled();
    });

    /**
     * Suppressed too: this dialog is `[closable]="false"` with no "Not now", so a browser session
     * reaching it would sit on an uncompletable ceremony with no way forward and no way back.
     */
    it('stays silent when there is no local key engine', () => {
        const {service} = setup({id: 'user_1'} as UserDto, false);
        service.promptNow();
        expect(service.dialogVisible()).toBe(false);
    });
});
