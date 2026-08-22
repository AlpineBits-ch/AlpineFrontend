import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of} from 'rxjs';
import {SocialKeyGateService} from './social-key-gate.service';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';
import {FirstRunService, FirstRunOptions} from './first-run.service';
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

    let finish: ((done: boolean) => void) | null = null;
    const open = vi.fn((_options?: FirstRunOptions) => new Promise<boolean>(resolve => (finish = resolve)));

    TestBed.configureTestingModule({
        providers: [
            {provide: UserService, useValue: {self, getSelf}},
            {provide: OnboardingService, useValue: {addSocialInterest}},
            {provide: MasterKeyService, useValue: {isAvailable}},
            {provide: FirstRunService, useValue: {open}},
        ],
    });

    return {
        service: TestBed.inject(SocialKeyGateService),
        self,
        getSelf,
        addSocialInterest,
        isAvailable,
        open,
        finish: (done: boolean) => finish?.(done),
    };
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
        const {service, isAvailable, open} = setup({id: 'user_1'} as UserDto, false);
        void service.require();
        expect(isAvailable).toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });
});

describe('SocialKeyGateService.require', () => {
    it('resolves true immediately without a first run when a key exists', async () => {
        const {service, open} = setup({id: 'user_1', encryptedMasterKey: KEY} as UserDto);
        await expect(service.require()).resolves.toBe(true);
        expect(open).not.toHaveBeenCalled();
    });

    /** The stored answer may say Isle only; a gated action still needs the key. */
    it('opens first run demanding a key when none exists', () => {
        const {service, open} = setup();
        void service.require();
        expect(open).toHaveBeenCalledWith({keyRequired: true});
    });

    /** The caller must be let through, not parked behind a run nobody can finish. */
    it('resolves true without a first run when there is no local key engine', async () => {
        const {service, open} = setup({id: 'user_1'} as UserDto, false);
        await expect(service.require()).resolves.toBe(true);
        expect(open).not.toHaveBeenCalled();
    });

    it('resolves true once setup completes', async () => {
        const {service, finish} = setup();
        const allowed = service.require();
        finish(true);
        await expect(allowed).resolves.toBe(true);
    });

    /**
     * A caller that retries the instant the run ends must not be told to set up a key it has just
     * written, and must not be handed a fabricated envelope to get there.
     */
    it('is satisfied immediately after completion, without waiting on the refetch', async () => {
        const {service, self, finish} = setup();
        const allowed = service.require();
        finish(true);
        await allowed;
        expect(service.isSatisfied()).toBe(true);
        expect(self()?.encryptedMasterKey).toBeTruthy();
    });

    it('records the social interest once setup completes', async () => {
        const {service, addSocialInterest, finish} = setup();
        const allowed = service.require();
        finish(true);
        await allowed;
        expect(addSocialInterest).toHaveBeenCalled();
    });

    /** Two gated actions in quick succession must share one run and one answer. */
    it('shares one run between concurrent callers and answers both', async () => {
        const {service, open, finish} = setup();
        const first = service.require();
        const second = service.require();
        finish(true);
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(open).toHaveBeenCalledTimes(1);
    });
});

describe('SocialKeyGateService.promptNow', () => {
    it('opens first run demanding a key', () => {
        const {service, open} = setup();
        service.promptNow();
        expect(open).toHaveBeenCalledWith({keyRequired: true});
    });

    it('does not record a social interest, since the account already stated one', async () => {
        const {service, addSocialInterest, finish} = setup();
        service.promptNow();
        finish(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(addSocialInterest).not.toHaveBeenCalled();
    });

    /**
     * Suppressed too: a browser session has no engine, so it would sit on a ceremony it cannot
     * finish with no way forward and no way back.
     */
    it('stays silent when there is no local key engine', () => {
        const {service, open} = setup({id: 'user_1'} as UserDto, false);
        service.promptNow();
        expect(open).not.toHaveBeenCalled();
    });
});
