/**
 * The slot list: which accounts this installation holds, and which one is live.
 *
 * <p>Matching is on `{serverUrl, userId}` rather than on the username, and the tests pin that -
 * a rename must not strand the account's device id, MLS state and message history behind a slot
 * nothing looks up any more.</p>
 */
import {TestBed} from '@angular/core/testing';
import {SettingsStoreFactory} from '../platform/ports/settings-store.port';
import {FakeSettingsStoreFactory} from '../platform/testing/fake-settings-store';
import {provideFakePlatform} from '../platform/testing/provide-fake-platform';
import {WebSettingsStoreFactory} from '../platform/web/settings-store';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from './account-registry.service';
import {setActiveSlotId} from './scoped-oauth-storage';

/**
 * Which slot is live lives in `localStorage`, not in the registry file - see `RegistryFile`. This
 * runner's global has no methods, so without a stand-in every commit would silently no-op and every
 * read would answer "nobody is signed in".
 */
const localStore = new Map<string, string>();

/**
 * The settings backend, provided rather than detected.
 *
 * <p>This file used to define `__TAURI_INTERNALS__` on `globalThis` and mock
 * `@tauri-apps/plugin-store`, because the service reached the backend through a free function that
 * asked `detectHost()`. It injects {@link SettingsStoreFactory} now, so the backend is a provider -
 * which is the point of the seam and not merely tidier: the global trick chose a *host*, and every
 * spec doing it fought over one module-mock registration per run.</p>
 *
 * <p>Held at module scope and reset per test, so it survives the `TestBed.resetTestingModule()` in
 * {@link freshService} the way a real store file survives a restart.</p>
 */
const settings = new FakeSettingsStoreFactory();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

/**
 * A restart: every service rebuilt against the same persisted state.
 *
 * <p>Takes the backend as an argument so the "outside Tauri" block below can hand over the real
 * `localStorage` adapter. Defaults to {@link settings}, which is the shared in-memory one.</p>
 */
function freshService(backend: SettingsStoreFactory = settings): AccountRegistryService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [provideFakePlatform({SettingsStoreFactory: backend}), AccountRegistryService],
    });
    return TestBed.inject(AccountRegistryService);
}

describe('AccountRegistryService', () => {
    let service: AccountRegistryService;

    beforeEach(() => {
        settings.reset();
        localStore.clear();
        service = freshService();
    });

    it('reads and writes through the injected factory, not a backend of its own choosing', async () => {
        // The seam itself. A store nothing provided would answer nothing, so this would fail with the
        // free function still wired up: the registry would have found its own backend and this
        // factory would never have been opened.
        const only = new FakeSettingsStoreFactory();
        const isolated = freshService(only);

        const slot = await isolated.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(only.opened).toContain('settings.json');
        expect(only.peek<{slots: {id: string}[]}>('settings.json', 'accounts')?.slots)
            .toEqual([expect.objectContaining({id: slot.id})]);
        // And nothing leaked to the backend this test did not provide.
        expect(settings.opened).toEqual([]);
    });

    it('reports the bootstrap slot before anyone has signed in', async () => {
        expect(await service.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(await service.activeSlot()).toBeNull();
        expect(await service.list()).toEqual([]);
    });

    it('creates a slot on first sign-in and makes it live', async () => {
        const slot = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(slot.userId).toBe('user-1');
        expect(await service.activeSlotId()).toBe(slot.id);
        expect(await service.list()).toHaveLength(1);
    });

    it('reuses the slot for an account it already holds', async () => {
        const first = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const again = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(again.id).toBe(first.id);
        expect(await service.list()).toHaveLength(1);
    });

    it('keeps the same account on two servers apart', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const b = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://b.example'});

        expect(b.id).not.toBe(a.id);
        expect(await service.list()).toHaveLength(2);
    });

    it('matches on the user id, not the username, so a rename keeps the slot', async () => {
        const before = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'old',
        });
        const after = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'new',
        });

        expect(after.id).toBe(before.id);
        expect(after.username).toBe('new');
    });

    it('does not blank a known username when a later sign-in carries none', async () => {
        await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'named',
        });
        const again = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(again.username).toBe('named');
    });

    it('fills in the display half from a profile patch', async () => {
        const slot = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        await service.updateProfile(slot.id, {username: 'ada', avatarUrl: 'https://img/a.png'});

        const [stored] = await service.list();
        expect(stored.username).toBe('ada');
        expect(stored.displayName).toBe('ada');
        expect(stored.avatarUrl).toBe('https://img/a.png');
    });

    it('clears an avatar when the patch says null, and leaves it alone when it says nothing', async () => {
        const slot = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', avatarUrl: 'https://img/a.png',
        });

        await service.updateProfile(slot.id, {username: 'ada'});
        expect((await service.list())[0].avatarUrl).toBe('https://img/a.png');

        await service.updateProfile(slot.id, {avatarUrl: null});
        expect((await service.list())[0].avatarUrl).toBeNull();
    });

    it('activates a known slot', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        await service.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});

        expect(await service.activate(a.id)).toBe(true);
        expect(await service.activeSlotId()).toBe(a.id);
    });

    it('refuses to activate an unknown slot rather than blanking the session', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(await service.activate('no-such-slot')).toBe(false);
        expect(await service.activeSlotId()).toBe(a.id);
    });

    it('falls back to the most recently used survivor when the live slot is removed', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const b = await service.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});
        await service.activate(a.id);

        await service.remove(a.id);

        expect(await service.activeSlotId()).toBe(b.id);
    });

    it('leaves no slot live when the last one is removed', async () => {
        const only = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        await service.remove(only.id);

        expect(await service.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(await service.activeSlot()).toBeNull();
    });

    it('leaves the live slot alone when a different one is removed', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const b = await service.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});

        await service.remove(a.id);

        expect(await service.activeSlotId()).toBe(b.id);
    });

    it('survives a restart - persisted state, not the in-memory signal, is the source of truth', async () => {
        const slot = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'ada',
        });

        const restarted = freshService();

        expect(await restarted.activeSlotId()).toBe(slot.id);
        expect((await restarted.list())[0].username).toBe('ada');
    });

    it('does not move the live slot merely by being read', async () => {
        await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        // What "Add Account" does: sets the live slot aside without removing any slot.
        setActiveSlotId(BOOTSTRAP_SLOT_ID);

        const restarted = freshService();
        await restarted.list();
        await restarted.activeSlot();

        // The read path republishing a live slot from the file is what made "Add Account" a page
        // refresh: the first thing on the login screen to ask for a device id put the previous
        // account back, and its tokens came into view again.
        expect(await restarted.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
    });

    it('reads a store that has never been written as empty rather than throwing', async () => {
        settings.put('settings.json', 'accounts', {});
        const bare = freshService();

        expect(await bare.list()).toEqual([]);
        expect(await bare.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
    });

    /**
     * The `localStorage` backend, and the reason the app boots in a browser at all.
     *
     * <p>This service is the *first* store reader on the launch path: `DeviceIdentityService`
     * resolves the device id before anything else, and that goes through {@link activeSlotId},
     * which awaits {@link read}. With no IPC host a `LazyStore` call here rejects, the rejection
     * escapes `MainPageComponent.runDeviceLaunch` before its `try`, and the app never leaves the
     * loading overlay - so nothing, not even a registration request, reaches the backend. Fixing
     * `DeviceIdentityService` alone left that unchanged, which is what these tests pin.</p>
     *
     * <p>The assertions are the same ones the desktop path is held to, restated against the other
     * backend: the logic above the store is one implementation, so the value here is that it is
     * provably backend-blind.</p>
     *
     * <p><b>The real `WebSettingsStoreFactory`, provided</b> - not a host faked by deleting a global.
     * The prefix and the JSON shape below are properties of that adapter, so a fake here would have
     * asserted them against nothing.</p>
     */
    describe('outside Tauri', () => {
        /**
         * Pinned as a literal rather than imported, so a rename of the prefix has to be a
         * deliberate edit here too. Once anything has booted in a browser this is a persisted
         * name, not an implementation detail.
         */
        const PREFIX = 'alpine_settings::';

        const web = new WebSettingsStoreFactory();

        function browser(): AccountRegistryService {
            return freshService(web);
        }

        it('reads an empty registry without ever opening the Tauri store', async () => {
            const bare = browser();

            expect(await bare.list()).toEqual([]);
            expect(await bare.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
            // The gate is now structural rather than asserted: this service is handed a backend and
            // has no branch that could reach for another one.
            expect(settings.opened).toEqual([]);
        });

        it('creates a slot on first sign-in and makes it live', async () => {
            const bare = browser();

            const slot = await bare.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

            expect(await bare.activeSlotId()).toBe(slot.id);
            expect(await bare.list()).toHaveLength(1);
            expect(settings.opened).toEqual([]);
        });

        it('survives a restart, so the slot keeps its device id and MLS state', async () => {
            const slot = await browser().ensureSlot({
                userId: 'user-1', serverUrl: 'https://a.example', username: 'ada',
            });

            const restarted = browser();

            expect(await restarted.activeSlotId()).toBe(slot.id);
            expect((await restarted.list())[0].username).toBe('ada');
        });

        it('persists under the shared settings prefix, in the shape the Tauri store holds', async () => {
            const bare = browser();
            const slot = await bare.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

            // Same key, same nesting as the store file. Anything flatter here would fork the read
            // path per backend.
            const raw = localStore.get(`${PREFIX}accounts`);
            expect(JSON.parse(raw ?? 'null').slots.map((s: {id: string}) => s.id)).toEqual([slot.id]);
        });

        it('does not move the live slot merely by being read', async () => {
            await browser().ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
            // What "Add Account" does: sets the live slot aside without removing any slot.
            setActiveSlotId(BOOTSTRAP_SLOT_ID);

            const restarted = browser();
            await restarted.list();
            await restarted.activeSlot();

            expect(await restarted.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        });

        it('reads a corrupt registry as empty rather than stranding the launch', async () => {
            localStore.set(`${PREFIX}accounts`, 'not json');

            const bare = browser();

            // Boot survivability is the point, and it is the same rule the device id follows: a
            // value nothing can parse is a value nothing can act on.
            expect(await bare.list()).toEqual([]);
            expect(await bare.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        });

        it('removes the live slot and falls back to the most recently used survivor', async () => {
            const bare = browser();
            const a = await bare.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
            const b = await bare.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});
            await bare.activate(a.id);

            await bare.remove(a.id);

            expect(await bare.activeSlotId()).toBe(b.id);
        });
    });
});
