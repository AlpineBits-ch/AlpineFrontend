/**
 * Moving between the accounts this machine holds.
 *
 * <p>One account is live at a time and the switch is a reload - see {@link AccountSwitchService}
 * for why. That makes the ordering the whole correctness argument: everything deciding who the app
 * comes back as has to be committed <i>before</i> the reload, because nothing after it runs.</p>
 */
// Pinned true so the registry keeps resolving to the `LazyStore` stub below. These tests are about
// the desktop path, and the real `isTauri()` answers false under the runner - which would quietly
// move the slot list into `localStorage`, where `LazyStoreMock.files.clear()` does not reach it and
// state would leak from one test into the next.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
}));
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
import {AccountSwitchService, ReentryTarget} from './account-switch.service';
import {AccountRegistryService} from './account-registry.service';
import {DeviceIdentityService} from './device-identity.service';
import {SessionTeardownService} from './session-teardown.service';
import {
    ACTIVE_SLOT_KEY,
    activeSlotId,
    BOOTSTRAP_SLOT_ID,
    scopedOAuthKey,
    setActiveSlotId,
} from './scoped-oauth-storage';

const LazyStoreMock = LazyStore as unknown as {files: Map<string, Map<string, unknown>>};

let calls: string[];
let reentered: ReentryTarget[];
let callLive: boolean;
let confirmLeave: boolean;
let wipeFails: boolean;
let liveDeviceId: string;

let registry: AccountRegistryService;
let service: AccountSwitchService;

function build(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            AccountSwitchService,
            AccountRegistryService,
            {
                provide: DeviceIdentityService,
                useValue: {deviceId: async () => liveDeviceId},
            },
            {
                provide: SessionTeardownService,
                useValue: {
                    wipeAccount: async (id: string) => {
                        calls.push(`wipeAccount:${id}`);
                        if (wipeFails) throw new Error('keychain locked');
                        return {keyPackagesReset: true};
                    },
                },
            },
        ],
    });
    registry = TestBed.inject(AccountRegistryService);
    service = TestBed.inject(AccountSwitchService);
    service.environment = {
        reenter: target => {
            calls.push(`reenter:${target}`);
            reentered.push(target);
        },
        callIsLive: () => callLive,
        confirmLeaveCall: async () => {
            calls.push('confirmLeaveCall');
            return confirmLeave;
        },
    };
}

/**
 * This runner's global `localStorage` exists but has no methods on it, so the live-slot mirror and
 * the per-slot token keys - the two things a switch actually commits - would be unobservable.
 */
const store = new Map<string, string>();

beforeAll(() => {
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

function trackedSet(key: string, value: string): void {
    localStorage.setItem(key, value);
}

function resetStorage(): void {
    store.clear();
}

beforeEach(() => {
    LazyStoreMock.files.clear();
    resetStorage();
    calls = [];
    reentered = [];
    callLive = false;
    confirmLeave = true;
    wipeFails = false;
    liveDeviceId = 'device-live';
    vi.spyOn(console, 'error').mockImplementation(() => { });
    build();
});

afterEach(() => {
    vi.restoreAllMocks();
    resetStorage();
});

async function twoAccounts() {
    const a = await registry.ensureSlot({userId: 'user-a', serverUrl: 'https://a.example'});
    const b = await registry.ensureSlot({userId: 'user-b', serverUrl: 'https://b.example'});
    await registry.activate(a.id);
    calls = [];
    return {a, b};
}

describe('switchTo', () => {
    it('commits the live slot before re-entering', async () => {
        const {b} = await twoAccounts();

        await service.switchTo(b.id);

        // The live slot id is what the next boot reads synchronously, before any Angular code
        // runs. Committed after the reload it would never be read at all.
        expect(calls).toEqual(['reenter:overview']);
        expect(activeSlotId()).toBe(b.id);
    });

    it('re-enters at the app, not the login screen', async () => {
        const {b} = await twoAccounts();

        await service.switchTo(b.id);

        expect(reentered).toEqual(['overview']);
    });

    it('does nothing when the slot is already live', async () => {
        const {a} = await twoAccounts();

        await expect(service.switchTo(a.id)).resolves.toBe(true);

        expect(calls).toEqual([]);
    });

    it('refuses an unknown slot rather than blanking the session', async () => {
        const {a} = await twoAccounts();

        await expect(service.switchTo('no-such-slot')).resolves.toBe(false);

        expect(reentered).toEqual([]);
        expect(await registry.activeSlotId()).toBe(a.id);
    });

    it('asks before dropping a live call', async () => {
        const {b} = await twoAccounts();
        callLive = true;

        await service.switchTo(b.id);

        expect(calls[0]).toBe('confirmLeaveCall');
        expect(reentered).toEqual(['overview']);
    });

    it('aborts without committing anything when the call prompt is declined', async () => {
        const {a, b} = await twoAccounts();
        callLive = true;
        confirmLeave = false;

        await expect(service.switchTo(b.id)).resolves.toBe(false);

        expect(reentered).toEqual([]);
        expect(await registry.activeSlotId()).toBe(a.id);
        expect(activeSlotId()).toBe(a.id);
    });

    it('does not ask when no call is live', async () => {
        const {b} = await twoAccounts();

        await service.switchTo(b.id);

        expect(calls).not.toContain('confirmLeaveCall');
    });
});

describe('beginAddAccount', () => {
    it('sets the live slot aside and goes to the login screen', async () => {
        await twoAccounts();

        service.beginAddAccount();

        expect(activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(reentered).toEqual(['authentication']);
    });

    it('does not sign the current account out', async () => {
        const {a} = await twoAccounts();
        trackedSet(scopedOAuthKey(a.id, 'refresh_token'), 'refresh-a');

        service.beginAddAccount();

        // The one thing "Add Account" must never do, and it is a single line away from doing it.
        // The slot it came from has to still be there to switch back to.
        expect(localStorage.getItem(scopedOAuthKey(a.id, 'refresh_token'))).toBe('refresh-a');
        expect(await registry.list()).toHaveLength(2);
        expect(calls.some(c => c.startsWith('wipeAccount'))).toBe(false);
    });

    it('actually leaves the account - no slot is live afterwards', async () => {
        await twoAccounts();

        service.beginAddAccount();

        // This assertion used to be the opposite, and it was the bug written down as intent. The
        // registry file also recorded a live slot back then, so reading it republished that value
        // over the mirror and the login screen found the previous account's tokens again. See
        // `add-account-flow.spec.ts` for the version of this that spans the reload.
        expect(await registry.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(await registry.activeSlot()).toBeNull();
    });

    it('keeps the slots, so the login screen can offer a way back', async () => {
        await twoAccounts();

        service.beginAddAccount();

        expect(await registry.list()).toHaveLength(2);
    });
});

describe('adoptSignedInAccount', () => {
    it('creates a slot and makes it live', async () => {
        const slot = await service.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example', username: 'ada',
        });

        expect(await registry.activeSlotId()).toBe(slot.id);
        expect(slot.username).toBe('ada');
    });

    it('moves the tokens the sign-in produced onto the slot it turned out to be', async () => {
        trackedSet(scopedOAuthKey(BOOTSTRAP_SLOT_ID, 'access_token'), 'fresh-access');
        trackedSet(scopedOAuthKey(BOOTSTRAP_SLOT_ID, 'refresh_token'), 'fresh-refresh');

        const slot = await service.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        // Every login writes to the bootstrap slot, because who the tokens belong to is not known
        // until after the grant. Left there, the slot just created reads its own empty keys and
        // the session breaks the instant it is established.
        expect(localStorage.getItem(scopedOAuthKey(slot.id, 'access_token'))).toBe('fresh-access');
        expect(localStorage.getItem(scopedOAuthKey(slot.id, 'refresh_token'))).toBe('fresh-refresh');
    });

    it('leaves nothing behind on the bootstrap slot', async () => {
        trackedSet(scopedOAuthKey(BOOTSTRAP_SLOT_ID, 'access_token'), 'fresh-access');

        await service.adoptSignedInAccount({userId: 'user-a', serverUrl: 'https://a.example'});

        // A live session nobody owns. The next sign-in would find it and adopt it into the wrong
        // account.
        expect(localStorage.getItem(scopedOAuthKey(BOOTSTRAP_SLOT_ID, 'access_token'))).toBeNull();
    });

    it('does not disturb the tokens of an account that is already live', async () => {
        const {a} = await twoAccounts();
        trackedSet(scopedOAuthKey(a.id, 'access_token'), 'existing');
        trackedSet(scopedOAuthKey(BOOTSTRAP_SLOT_ID, 'access_token'), 'stray');

        await service.adoptSignedInAccount({userId: 'user-a', serverUrl: 'https://a.example'});

        // Only a sign-in that started from the bootstrap slot has tokens to hand over. A relaunch
        // of an account that is already live must not have a stray bootstrap token dropped on it.
        expect(localStorage.getItem(scopedOAuthKey(a.id, 'access_token'))).toBe('existing');
    });

    it('activates the slot that already exists rather than making a second', async () => {
        const first = await service.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });
        const again = await service.adoptSignedInAccount({
            userId: 'user-a', serverUrl: 'https://a.example',
        });

        // Two slots for one account would be two device ids, two MLS engines and two halves of
        // one history.
        expect(again.id).toBe(first.id);
        expect(await registry.list()).toHaveLength(1);
    });
});

describe('signOutOf', () => {
    it('wipes the live account key material, its tokens and its slot', async () => {
        const {a, b} = await twoAccounts();
        trackedSet(scopedOAuthKey(a.id, 'refresh_token'), 'refresh-a');
        trackedSet(scopedOAuthKey(b.id, 'refresh_token'), 'refresh-b');

        await service.signOutOf(a.id);

        expect(calls).toContain('wipeAccount:device-live');
        expect(localStorage.getItem(scopedOAuthKey(a.id, 'refresh_token'))).toBeNull();
        expect((await registry.list()).map(s => s.id)).toEqual([b.id]);
    });

    it('leaves the other accounts signed in', async () => {
        const {a, b} = await twoAccounts();
        trackedSet(scopedOAuthKey(b.id, 'refresh_token'), 'refresh-b');

        await service.signOutOf(a.id);

        expect(localStorage.getItem(scopedOAuthKey(b.id, 'refresh_token'))).toBe('refresh-b');
    });

    it('re-enters at the surviving account', async () => {
        const {a, b} = await twoAccounts();

        await service.signOutOf(a.id);

        expect(reentered).toEqual(['overview']);
        expect(activeSlotId()).toBe(b.id);
    });

    it('re-enters at the login screen when it was the last account', async () => {
        const only = await registry.ensureSlot({userId: 'user-a', serverUrl: 'https://a.example'});
        calls = [];

        await service.signOutOf(only.id);

        // Reloading in place would boot the main page with no session, which renders as an empty
        // app rather than as the login screen.
        expect(reentered).toEqual(['authentication']);
        expect(activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
    });

    it('removes the slot even when the wipe fails', async () => {
        const {a} = await twoAccounts();
        wipeFails = true;

        await service.signOutOf(a.id);

        // Leaving someone signed in because a local store would not clear is a worse answer than
        // leaving residue behind.
        expect(await registry.list()).toHaveLength(1);
        expect(reentered).toEqual(['overview']);
    });

    it('does not wipe key material when forgetting a background account', async () => {
        const {b} = await twoAccounts();
        trackedSet(scopedOAuthKey(b.id, 'refresh_token'), 'refresh-b');

        await service.signOutOf(b.id);

        // The device id resolves through the *live* slot, so a wipe here would be aimed at the
        // wrong account's key material. Forgetting the slot and leaving its stores to be reclaimed
        // is the conservative direction.
        expect(calls.some(c => c.startsWith('wipeAccount'))).toBe(false);
        expect(localStorage.getItem(scopedOAuthKey(b.id, 'refresh_token'))).toBeNull();
        expect(await registry.list()).toHaveLength(1);
    });

    it('does not re-enter when forgetting a background account', async () => {
        const {a, b} = await twoAccounts();

        await service.signOutOf(b.id);

        // Nothing about the live session changed, so tearing it down would be gratuitous.
        expect(reentered).toEqual([]);
        expect(await registry.activeSlotId()).toBe(a.id);
    });
});

describe('the live slot mirror', () => {
    it('follows the registry, so the next boot and the app agree on who is live', async () => {
        setActiveSlotId('something-stale');
        const {b} = await twoAccounts();

        await service.switchTo(b.id);

        expect(activeSlotId()).toBe(b.id);
        expect(await registry.activeSlotId()).toBe(b.id);
    });
});
