/**
 * "Add Account", end to end across the boundary that actually decides whether it works.
 *
 * <p><b>Why this file exists.</b> The unit tests for `AccountSwitchService` all passed while the
 * feature did nothing but reload the page. Each of them stopped at a module edge - one asserted the
 * mirror moved, another asserted the registry file was left alone, and the second was written up as
 * a feature ("so a cancelled add returns to it"). It was the bug, stated as intent.</p>
 *
 * <p>The collision was between the two records of *which slot is live*: the registry file and the
 * `localStorage` mirror. `beginAddAccount` set the mirror aside; then the first thing on the login
 * screen to ask for a device id loaded the registry, and the read path republished the file's
 * `activeSlotId` over the mirror. The previous account's tokens came back into view and the login
 * screen redirected straight into it.</p>
 *
 * <p>So these tests assert the user-visible outcome across a simulated reload - "is there a session
 * to be found" - rather than what any one module wrote. Reading the registry first, exactly as the
 * device-id interceptor does, is the point of the exercise and not incidental setup.</p>
 */
vi.mock('@tauri-apps/plugin-store', () => ({
    LazyStore: class LazyStoreStub {
        static readonly files = new Map<string, Map<string, unknown>>();

        private readonly values: Map<string, unknown>;

        constructor(file: string) {
            const existing = LazyStoreStub.files.get(file);
            this.values = existing ?? new Map<string, unknown>();
            LazyStoreStub.files.set(file, this.values);
        }

        async get<T>(key: string) { return this.values.get(key) as T | undefined; }
        async set(key: string, value: unknown) { this.values.set(key, value); }
        async delete(key: string) { this.values.delete(key); }
        async clear() { this.values.clear(); }
        async save() { }
    },
}));

import {TestBed} from '@angular/core/testing';
import {LazyStore} from '@tauri-apps/plugin-store';
import {AccountRegistryService} from './account-registry.service';
import {AccountSwitchService, ReentryTarget} from './account-switch.service';
import {DeviceIdentityService} from './device-identity.service';
import {SessionTeardownService} from './session-teardown.service';
import {
    BOOTSTRAP_SLOT_ID,
    ScopedOAuthStorage,
    scopedOAuthKey,
} from './scoped-oauth-storage';

const LazyStoreMock = LazyStore as unknown as {files: Map<string, Map<string, unknown>>};

/** This runner's global `localStorage` has no methods, so the mirror would be unobservable. */
const store = new Map<string, string>();

/**
 * The global the Tauri runtime injects, defined so `detectHost()` answers `'tauri'` and the registry
 * keeps resolving to the `LazyStore` stub above.
 *
 * <p>These tests are about the desktop path. Under the runner there is no Tauri host, and without
 * this the slot list would quietly move into `localStorage` - where `LazyStoreMock.files.clear()`
 * does not reach it, so state would leak from one simulated boot into the next.</p>
 */
const TAURI_GLOBAL = '__TAURI_INTERNALS__';

beforeAll(() => {
    (globalThis as Record<string, unknown>)[TAURI_GLOBAL] = {};
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
});

afterAll(() => {
    delete (globalThis as Record<string, unknown>)[TAURI_GLOBAL];
});

let reentered: ReentryTarget[];

/**
 * A fresh process against the same persisted state.
 *
 * <p>`localStorage` and the Tauri store survive; every service is rebuilt. That is what a switch or
 * an add actually does, and it is the only place the two records of the live slot can disagree.</p>
 */
function boot(): {registry: AccountRegistryService; switcher: AccountSwitchService} {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            AccountRegistryService,
            AccountSwitchService,
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-live'}},
            {
                provide: SessionTeardownService,
                useValue: {wipeAccount: async () => ({keyPackagesReset: true})},
            },
        ],
    });
    const registry = TestBed.inject(AccountRegistryService);
    const switcher = TestBed.inject(AccountSwitchService);
    switcher.environment = {
        reenter: t => void reentered.push(t),
        callIsLive: () => false,
        confirmLeaveCall: async () => true,
    };
    return {registry, switcher};
}

/** What `AuthService.isLoggedIn` ultimately reads: a token under whichever slot is live. */
function sessionToken(): string | null {
    return new ScopedOAuthStorage().getItem('access_token');
}

/** Stands in for a completed sign-in, which always writes to the bootstrap slot. */
function signInAs(): void {
    new ScopedOAuthStorage().setItem('access_token', 'token-from-login');
}

beforeEach(() => {
    LazyStoreMock.files.clear();
    store.clear();
    reentered = [];
});

afterEach(() => store.clear());

describe('adding a second account', () => {
    it('leaves no session to be found after the reload', async () => {
        // An established first account.
        const first = boot();
        signInAs();
        await first.switcher.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });
        expect(sessionToken()).toBe('token-from-login');

        first.switcher.beginAddAccount();

        // The reload. Reading the registry *first* is what the device-id interceptor does on the
        // login screen's very first request, and it is what used to undo the whole thing.
        const second = boot();
        await second.registry.activeSlotId();

        // The assertion the unit tests never made: the login screen must find no session, or it
        // redirects to /overview and "Add Account" is a page refresh.
        expect(sessionToken()).toBeNull();
        expect(reentered).toEqual(['authentication']);
    });

    it('survives every registry read the login screen makes, not just the first', async () => {
        const first = boot();
        signInAs();
        await first.switcher.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        first.switcher.beginAddAccount();

        const second = boot();
        await second.registry.activeSlotId();
        await second.registry.list();
        await second.registry.activeSlot();
        await second.registry.activeSlotId();

        expect(sessionToken()).toBeNull();
    });

    it('keeps the first account signed in while the second is being added', async () => {
        const first = boot();
        signInAs();
        const slotA = await first.switcher.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        first.switcher.beginAddAccount();

        const second = boot();
        await second.registry.activeSlotId();

        // Set aside, not signed out. The whole point is that it is still there to go back to.
        expect(localStorage.getItem(scopedOAuthKey(slotA.id, 'access_token')))
            .toBe('token-from-login');
        expect(await second.registry.list()).toHaveLength(1);
    });

    it('ends with two accounts, each holding its own session', async () => {
        const first = boot();
        signInAs();
        const slotA = await first.switcher.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        first.switcher.beginAddAccount();

        // The second sign-in, on the login screen the add landed on.
        const second = boot();
        await second.registry.activeSlotId();
        new ScopedOAuthStorage().setItem('access_token', 'token-for-b');
        const slotB = await second.switcher.adoptSignedInAccount({
            userId: 'user-b', serverUrl: 'https://b.example',
        });

        expect(slotB.id).not.toBe(slotA.id);
        expect(await second.registry.list()).toHaveLength(2);
        expect(localStorage.getItem(scopedOAuthKey(slotA.id, 'access_token')))
            .toBe('token-from-login');
        expect(localStorage.getItem(scopedOAuthKey(slotB.id, 'access_token')))
            .toBe('token-for-b');
        // And the second account is the one live now.
        expect(sessionToken()).toBe('token-for-b');
    });
});

describe('switching, across the same boundary', () => {
    async function twoSignedInAccounts() {
        const first = boot();
        signInAs();
        const a = await first.switcher.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        first.switcher.beginAddAccount();

        const second = boot();
        await second.registry.activeSlotId();
        new ScopedOAuthStorage().setItem('access_token', 'token-for-b');
        const b = await second.switcher.adoptSignedInAccount({
            userId: 'user-b', serverUrl: 'https://b.example',
        });
        return {a, b};
    }

    it('finds the other account session after the reload', async () => {
        const {a} = await twoSignedInAccounts();

        const before = boot();
        await before.switcher.switchTo(a.id);

        const after = boot();
        await after.registry.activeSlotId();

        expect(sessionToken()).toBe('token-from-login');
        expect((await after.registry.activeSlot())?.userId).toBe('user-a');
    });

    it('does not drift back to the previous account when the registry is read', async () => {
        const {a, b} = await twoSignedInAccounts();

        const before = boot();
        await before.switcher.switchTo(a.id);

        const after = boot();
        // Repeated reads, which is what a running app does constantly.
        for (let i = 0; i < 3; i++) await after.registry.activeSlotId();

        expect(await after.registry.activeSlotId()).toBe(a.id);
        expect(await after.registry.activeSlotId()).not.toBe(b.id);
    });

    it('lands on the login screen after signing out of the last account', async () => {
        const first = boot();
        signInAs();
        const only = await first.switcher.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        await first.switcher.signOutOf(only.id);

        const after = boot();
        await after.registry.activeSlotId();

        expect(sessionToken()).toBeNull();
        expect(await after.registry.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(reentered).toEqual(['authentication']);
    });

    it('lands on the surviving account after signing out of one of two', async () => {
        const {a, b} = await twoSignedInAccounts();

        const before = boot();
        await before.switcher.signOutOf(b.id);

        const after = boot();
        await after.registry.activeSlotId();

        expect(await after.registry.activeSlotId()).toBe(a.id);
        expect(sessionToken()).toBe('token-from-login');
    });
});
