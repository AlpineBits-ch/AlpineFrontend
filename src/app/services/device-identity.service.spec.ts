/**
 * The device id, now one per account rather than one per installation.
 *
 * <p>It is the whole of the isolation between two accounts on one machine: the keychain entries
 * are `alpine_mls_{deviceId}_*`, the engine state file is `mls_state_{deviceId}.json`, and the
 * group registry and message cache carry it in their filenames. Two accounts that resolved to one
 * id would share every one of them - which is what shipped, and what the leak test in
 * `mls-account-scope.spec.ts` covers from the other end.</p>
 *
 * <p>The migration is the part with teeth. An installation that upgrades already holds key
 * material named after the pre-slot `mls_device_id`; minting a fresh id for the first slot instead
 * of adopting that one would address all of it to a slot nothing looks up, which presents as this
 * device being silently ejected from every group it belongs to.</p>
 */
// The desktop settings backend is chosen by `detectHost()`, which reads the Tauri global - so the
// host is entered by defining it (see `enterTauri`) rather than by mocking a function. Only the
// store plugin still has to be mocked: `openSettingsStore()` reaches it through the Tauri adapter's
// lazy `import()`, and the real one would attempt IPC.
vi.mock('@tauri-apps/plugin-store');

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {LazyStore} from '@tauri-apps/plugin-store';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeSecureStore} from '../platform/testing/fake-secure-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from './account-registry.service';

/**
 * Stateful, and shared across every `new LazyStore(...)` in a test.
 *
 * <p>The service re-opens the store per write, and the migration is entirely about what one call
 * leaves behind for the next - a stub that answered a fixed value per key could not express
 * "the legacy id has already been claimed".</p>
 */
const values = new Map<string, unknown>();
let failNextGet = false;

const store = {
    get: vi.fn(async (key: string) => {
        if (failNextGet) {
            failNextGet = false;
            throw new Error('store locked');
        }
        return values.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
    save: vi.fn(async () => undefined),
};

/**
 * Which host the bundle believes it is in.
 *
 * <p>Entered by defining the global the Tauri runtime injects, because that is what `detectHost()`
 * reads and therefore what decides which `SettingsStore` adapter `openSettingsStore()` hands back.
 * Re-entered in `beforeEach` for the same reason the old `isTauri` mock was re-stubbed there:
 * everything outside the "outside Tauri" block is about the desktop path and would otherwise
 * silently start asserting against `localStorage`.</p>
 */
const TAURI_GLOBAL = '__TAURI_INTERNALS__';

function enterTauri(): void {
    (globalThis as Record<string, unknown>)[TAURI_GLOBAL] = {};
}

function leaveTauri(): void {
    delete (globalThis as Record<string, unknown>)[TAURI_GLOBAL];
}

/** The keychain, as a provided port rather than a mocked module. See {@link FakeSecureStore}. */
let secure: FakeSecureStore;

/** The registry, stubbed: these tests are about the id, not about slot bookkeeping. */
class RegistryStub {
    constructor(public slotId: string = BOOTSTRAP_SLOT_ID) { }
    async activeSlotId(): Promise<string> { return this.slotId; }
}

let registry: RegistryStub;

/**
 * This runner's global `localStorage` exists but has no methods on it, so every read and write in
 * the browser-backend tests would silently do nothing and the persistence they exist to prove
 * would be unobservable. An in-memory stand-in makes it real. Same stand-in, same reason, as in
 * `scoped-oauth-storage.spec.ts`.
 */
const browserStorage = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => browserStorage.get(k) ?? null,
            setItem: (k: string, v: string) => void browserStorage.set(k, String(v)),
            removeItem: (k: string) => void browserStorage.delete(k),
            clear: () => browserStorage.clear(),
        },
    });
});

afterAll(() => {
    leaveTauri();
});

beforeEach(() => {
    vi.clearAllMocks();
    enterTauri();
    secure = new FakeSecureStore();
    values.clear();
    localStorage.clear();
    failNextGet = false;
    registry = new RegistryStub();
    // A regular function, not an arrow: the service calls `new LazyStore(...)`, and arrow
    // functions are not constructors.
    vi.mocked(LazyStore).mockImplementation(function () {
        return store as unknown as LazyStore;
    });
});

function setup(slotId = BOOTSTRAP_SLOT_ID): DeviceIdentityService {
    registry.slotId = slotId;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: AccountRegistryService, useValue: registry},
            {provide: SecureStore, useValue: secure},
        ],
    });
    return TestBed.inject(DeviceIdentityService);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

it('returns the id persisted for this slot', async () => {
    values.set('mls_device_ids', {'slot-a': 'stored-device-id'});
    const service = setup('slot-a');

    await expect(service.deviceId()).resolves.toBe('stored-device-id');
    expect(store.set).not.toHaveBeenCalled();
});

it('generates and persists an id when the slot has none', async () => {
    const service = setup('slot-a');

    const id = await service.deviceId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(values.get('mls_device_ids')).toEqual({'slot-a': id});
    expect(store.save).toHaveBeenCalled();
});

it('keeps one slot stable across repeated calls', async () => {
    const service = setup('slot-a');

    const [a, b, c] = await Promise.all([
        service.deviceId(), service.deviceId(), service.deviceId(),
    ]);

    expect(b).toBe(a);
    expect(c).toBe(a);
});

it('gives two accounts two different ids - the whole of the isolation', async () => {
    const service = setup('slot-a');
    const a = await service.deviceId();

    registry.slotId = 'slot-b';
    const b = await service.deviceId();

    expect(b).not.toBe(a);
});

it('returns each slot to its own id when the live slot changes back', async () => {
    const service = setup('slot-a');
    const a = await service.deviceId();

    registry.slotId = 'slot-b';
    await service.deviceId();

    registry.slotId = 'slot-a';
    await expect(service.deviceId()).resolves.toBe(a);
});

it('persists a minted id, so a restart does not orphan the key material named after it', async () => {
    const service = setup('slot-a');
    const minted = await service.deviceId();

    await expect(setup('slot-a').deviceId()).resolves.toBe(minted);
});

// ---------------------------------------------------------------------------
// Migration off the pre-slot single id
// ---------------------------------------------------------------------------

it('adopts the legacy installation id for the first slot rather than re-minting', async () => {
    values.set('mls_device_id', {value: 'legacy-device'});
    const service = setup('slot-a');

    await expect(service.deviceId()).resolves.toBe('legacy-device');
});

it('hands the legacy id to one slot only - a second account gets a fresh one', async () => {
    values.set('mls_device_id', {value: 'legacy-device'});
    const service = setup('slot-a');
    await expect(service.deviceId()).resolves.toBe('legacy-device');

    registry.slotId = 'slot-b';
    await expect(service.deviceId()).resolves.not.toBe('legacy-device');
});

it('keeps the legacy id for the bootstrap slot, so the login request does not change id mid-flight', async () => {
    values.set('mls_device_id', {value: 'legacy-device'});
    const service = setup(BOOTSTRAP_SLOT_ID);

    await expect(service.deviceId()).resolves.toBe('legacy-device');
});

it('mints for the bootstrap slot when there is no legacy id, and mirrors it back', async () => {
    const service = setup(BOOTSTRAP_SLOT_ID);

    const minted = await service.deviceId();

    expect(values.get('mls_device_id')).toEqual({value: minted});
});

it('does not mirror a per-account id onto the legacy key', async () => {
    values.set('mls_device_id', {value: 'legacy-device'});
    const service = setup('slot-a');
    await service.deviceId();

    registry.slotId = 'slot-b';
    await service.deviceId();

    // Still what slot-a adopted. A second account writing here would hand its id to every
    // pre-slot code path, and to whichever slot next tried to claim it.
    expect(values.get('mls_device_id')).toEqual({value: 'legacy-device'});
});

// ---------------------------------------------------------------------------
// adopt() - the restore path's one irreplaceable step
// ---------------------------------------------------------------------------

it('adopt replaces the live slot id and the next read returns it', async () => {
    const service = setup('slot-a');
    await service.deviceId();

    await service.adopt('device-from-backup');

    await expect(service.deviceId()).resolves.toBe('device-from-backup');
});

it('adopt persists, so a restore survives the restart it usually precedes', async () => {
    const service = setup('slot-a');
    await service.deviceId();
    await service.adopt('device-from-backup');

    await expect(setup('slot-a').deviceId()).resolves.toBe('device-from-backup');
});

it('adopt touches only the live slot', async () => {
    const service = setup('slot-b');
    const b = await service.deviceId();

    registry.slotId = 'slot-a';
    await service.deviceId();
    await service.adopt('device-from-backup');

    registry.slotId = 'slot-b';
    await expect(service.deviceId()).resolves.toBe(b);
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

it('reset drops only the live slot, and the next read mints a different id', async () => {
    const service = setup('slot-b');
    const b = await service.deviceId();

    registry.slotId = 'slot-a';
    const a = await service.deviceId();
    await service.reset();

    await expect(service.deviceId()).resolves.not.toBe(a);
    registry.slotId = 'slot-b';
    await expect(service.deviceId()).resolves.toBe(b);
});

it('reset clears the legacy key only for the bootstrap slot', async () => {
    values.set('mls_device_id', {value: 'legacy-device'});
    const service = setup('slot-a');
    await service.deviceId();

    await service.reset();

    expect(values.get('mls_device_id')).toEqual({value: 'legacy-device'});

    registry.slotId = BOOTSTRAP_SLOT_ID;
    await service.deviceId();
    await service.reset();

    expect(values.get('mls_device_id')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

it('does not cache a failure - a later call retries the store', async () => {
    const service = setup('slot-a');
    failNextGet = true;

    await expect(service.deviceId()).rejects.toThrow('store locked');
    await expect(service.deviceId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration', () => {
    function withHttp() {
        values.set('mls_device_ids', {'slot-a': 'stored-device-id'});
        const service = setup('slot-a');
        return {service, ctrl: TestBed.inject(HttpTestingController)};
    }

    it('re-registers using the stored signing key, never a fresh one', async () => {
        secure.put('alpine_mls_stored-device-id_pub', 'stored-public-key');
        const {service, ctrl} = withHttp();

        const result = service.ensureRegistered();
        await new Promise<void>(r => setTimeout(r, 0));

        const req = ctrl.expectOne('https://api.venta.gg/api/v1/identity/devices');
        expect(req.request.method).toBe('POST');
        expect(req.request.body.clientDeviceId).toBe('stored-device-id');
        expect(req.request.body.identityPublicKey).toBe('stored-public-key');
        // Named after the device id, not after the slot: the entry is what every other piece of
        // local MLS state is addressed by, so reading a different name is how a device orphans
        // itself from its own key material.
        expect(secure.reads).toContain('alpine_mls_stored-device-id_pub');
        req.flush({});

        await expect(result).resolves.toBe(true);
    });

    it('reports failure rather than inventing a key when none is stored', async () => {
        // Nothing put in the store: `FakeSecureStore` answers null, as the real one does for an
        // absent key.
        const {service, ctrl} = withHttp();

        await expect(service.ensureRegistered()).resolves.toBe(false);

        ctrl.expectNone('https://api.venta.gg/api/v1/identity/devices');
    });

    it('reports failure when the registration request errors', async () => {
        secure.put('alpine_mls_stored-device-id_pub', 'stored-public-key');
        const {service, ctrl} = withHttp();

        const result = service.ensureRegistered();
        await new Promise<void>(r => setTimeout(r, 0));

        ctrl.expectOne('https://api.venta.gg/api/v1/identity/devices')
            .flush('nope', {status: 500, statusText: 'Server Error'});

        await expect(result).resolves.toBe(false);
    });

    it('unregisters this device by its client device id', async () => {
        const {service, ctrl} = withHttp();

        service.unregister().subscribe();
        // The url depends on an awaited store read, so let the microtask queue drain first.
        await new Promise<void>(r => setTimeout(r, 0));

        const req = ctrl.expectOne(
            'https://api.venta.gg/api/v1/identity/devices/client/stored-device-id',
        );
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});

// ---------------------------------------------------------------------------
// Outside Tauri
// ---------------------------------------------------------------------------

/**
 * The `localStorage` fallback, and the reason a browser build is possible at all.
 *
 * <p>With no IPC host every `LazyStore` call rejects, and `MainPageComponent.runDeviceLaunch`
 * reads the device id before its `try` - so one rejection here means `markReady` never runs and
 * the app never leaves the loading overlay. These tests are as much about *not* reaching
 * `LazyStore` as they are about what gets stored.</p>
 *
 * <p>The assertions are deliberately the same ones the desktop path is held to, restated against
 * the other backend. The logic above the store is a single implementation, so the value of these
 * is that it is provably backend-blind: mint, persist, isolate per slot, and adopt the pre-slot id
 * exactly once.</p>
 */
describe('outside Tauri', () => {
    /**
     * Pinned as a literal rather than imported.
     *
     * <p>Once anything has booted in a browser this prefix is a persisted name, not an
     * implementation detail: changing it orphans the id every existing browser session is using,
     * which reads as those sessions being ejected from their groups. An import would have followed
     * the rename silently.</p>
     */
    const PREFIX = 'alpine_settings::';

    beforeEach(() => {
        leaveTauri();
    });

    function stored<T>(key: string): T | undefined {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? undefined : JSON.parse(raw) as T;
    }

    it('mints and persists an id without ever opening the Tauri store', async () => {
        const service = setup('slot-a');

        const id = await service.deviceId();

        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(stored('mls_device_ids')).toEqual({'slot-a': id});
        // The gate is the whole guarantee: no IPC is attempted, so there is nothing to reject.
        expect(LazyStore).not.toHaveBeenCalled();
        expect(store.get).not.toHaveBeenCalled();
        expect(store.set).not.toHaveBeenCalled();
    });

    it('returns the persisted id on a second boot rather than minting again', async () => {
        const minted = await setup('slot-a').deviceId();

        await expect(setup('slot-a').deviceId()).resolves.toBe(minted);
    });

    it('keeps one slot stable across repeated calls', async () => {
        const service = setup('slot-a');

        const [a, b] = await Promise.all([service.deviceId(), service.deviceId()]);

        expect(b).toBe(a);
    });

    it('gives two accounts two different ids - the whole of the isolation', async () => {
        const service = setup('slot-a');
        const a = await service.deviceId();

        registry.slotId = 'slot-b';
        const b = await service.deviceId();

        expect(b).not.toBe(a);
        expect(stored('mls_device_ids')).toEqual({'slot-a': a, 'slot-b': b});
    });

    it('adopts the legacy installation id for the first slot rather than re-minting', async () => {
        localStorage.setItem(`${PREFIX}mls_device_id`, JSON.stringify({value: 'legacy-device'}));
        const service = setup('slot-a');

        await expect(service.deviceId()).resolves.toBe('legacy-device');
    });

    it('hands the legacy id to one slot only - a second account gets a fresh one', async () => {
        localStorage.setItem(`${PREFIX}mls_device_id`, JSON.stringify({value: 'legacy-device'}));
        const service = setup('slot-a');
        await expect(service.deviceId()).resolves.toBe('legacy-device');

        registry.slotId = 'slot-b';
        await expect(service.deviceId()).resolves.not.toBe('legacy-device');
        // Still what slot-a adopted, for the same reason as in Tauri: a second account writing
        // here would hand its id to every pre-slot code path.
        expect(stored('mls_device_id')).toEqual({value: 'legacy-device'});
    });

    it('keeps the legacy id for the bootstrap slot, and mirrors a minted one back', async () => {
        localStorage.setItem(`${PREFIX}mls_device_id`, JSON.stringify({value: 'legacy-device'}));
        await expect(setup(BOOTSTRAP_SLOT_ID).deviceId()).resolves.toBe('legacy-device');

        localStorage.clear();
        const minted = await setup(BOOTSTRAP_SLOT_ID).deviceId();

        expect(stored('mls_device_id')).toEqual({value: minted});
    });

    it('persists the same shape the Tauri store holds, so neither backend is a fork', async () => {
        const service = setup(BOOTSTRAP_SLOT_ID);
        const id = await service.deviceId();

        // Byte for byte what `values` ends up holding on the desktop path above, only JSON encoded
        // and prefixed. Anything flatter here would make the migration logic backend-specific.
        expect(localStorage.getItem(`${PREFIX}mls_device_ids`))
            .toBe(JSON.stringify({[BOOTSTRAP_SLOT_ID]: id}));
        expect(localStorage.getItem(`${PREFIX}mls_device_id`))
            .toBe(JSON.stringify({value: id}));
    });

    it('reset drops the live slot and the legacy mirror, and the next read mints anew', async () => {
        const service = setup(BOOTSTRAP_SLOT_ID);
        const first = await service.deviceId();

        await service.reset();

        expect(stored('mls_device_ids')).toEqual({});
        expect(stored('mls_device_id')).toBeUndefined();
        await expect(service.deviceId()).resolves.not.toBe(first);
    });

    it('mints rather than throwing when the stored value is corrupt', async () => {
        localStorage.setItem(`${PREFIX}mls_device_ids`, 'not json');
        const service = setup('slot-a');

        // Boot survivability is the point. A value nothing can parse is a value nothing can act
        // on, and stranding the launch on it is the exact failure this backend exists to remove.
        await expect(service.deviceId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });
});
