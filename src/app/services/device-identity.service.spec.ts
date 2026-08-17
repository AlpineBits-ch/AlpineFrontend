/** One device id per account: it names the keychain entries and state files, so a shared id shares them all. */
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {SecureStore} from '../platform/ports/secure-store.port';
import {SettingsStore, SettingsStoreFactory} from '../platform/ports/settings-store.port';
import {FakeSecureStore} from '../platform/testing/fake-secure-store';
import {provideFakePlatform} from '../platform/testing/provide-fake-platform';
import {WebSettingsStoreFactory} from '../platform/web/settings-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from './account-registry.service';

/** Stateful across every `open()`, with {@link failNextGet} for the "a transient error is not cached" test. */
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

/** Records what it was asked to open, which is what makes the injected-backend seam observable. */
class StubSettingsStoreFactory extends SettingsStoreFactory {
    readonly opened: string[] = [];

    open(file: string): SettingsStore {
        this.opened.push(file);
        return store as unknown as SettingsStore;
    }
}

const settings = new StubSettingsStoreFactory();

/** The keychain, as a provided port rather than a mocked module. See {@link FakeSecureStore}. */
let secure: FakeSecureStore;

/** The registry, stubbed: these tests are about the id, not about slot bookkeeping. */
class RegistryStub {
    constructor(public slotId: string = BOOTSTRAP_SLOT_ID) { }
    async activeSlotId(): Promise<string> { return this.slotId; }
}

let registry: RegistryStub;

/** The runner's `localStorage` has no methods, so an in-memory stand-in makes persistence observable. */
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

beforeEach(() => {
    vi.clearAllMocks();
    secure = new FakeSecureStore();
    values.clear();
    settings.opened.length = 0;
    localStorage.clear();
    failNextGet = false;
    registry = new RegistryStub();
});

function setup(
    slotId = BOOTSTRAP_SLOT_ID,
    backend: SettingsStoreFactory = settings,
): DeviceIdentityService {
    registry.slotId = slotId;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideFakePlatform({SecureStore: secure, SettingsStoreFactory: backend}),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: AccountRegistryService, useValue: registry},
        ],
    });
    return TestBed.inject(DeviceIdentityService);
}

// ---------------------------------------------------------------------------
// The DI seam
// ---------------------------------------------------------------------------

it('opens the shared settings file through the injected factory', async () => {
    // Would fail with the free function wired up: the service would have built its own backend.
    const only = new StubSettingsStoreFactory();
    const service = setup('slot-a', only);

    await service.deviceId();

    expect(only.opened).toContain('settings.json');
    expect(settings.opened).toEqual([]);
});

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

// The first slot adopts the legacy id: minting a fresh one orphans the key material named after it.

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

    // Still what slot-a adopted: a second account writing here hands its id to every pre-slot path.
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
        // Named after the device id, not the slot: another name orphans the device from its keys.
        expect(secure.reads).toContain('alpine_mls_stored-device-id_pub');
        req.flush({});

        await expect(result).resolves.toBe(true);
    });

    it('reports failure rather than inventing a key when none is stored', async () => {
        // Nothing put in the store: `FakeSecureStore` answers null, as the real one does.
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

/** The `localStorage` fallback, held to the same assertions as the desktop path. */
describe('outside Tauri', () => {
    /** Pinned as a literal: changing this persisted prefix orphans every existing browser session's id. */
    const PREFIX = 'alpine_settings::';

    const web = new WebSettingsStoreFactory();

    /** Same arrangement as {@link setup}, over the browser adapter. */
    function browser(slotId = BOOTSTRAP_SLOT_ID): DeviceIdentityService {
        return setup(slotId, web);
    }

    function stored<T>(key: string): T | undefined {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? undefined : JSON.parse(raw) as T;
    }

    it('mints and persists an id without ever opening the Tauri store', async () => {
        const service = browser('slot-a');

        const id = await service.deviceId();

        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(stored('mls_device_ids')).toEqual({'slot-a': id});
        // Structural rather than asserted: the service is handed a backend and has no other branch.
        expect(settings.opened).toEqual([]);
        expect(store.get).not.toHaveBeenCalled();
        expect(store.set).not.toHaveBeenCalled();
    });

    it('returns the persisted id on a second boot rather than minting again', async () => {
        const minted = await browser('slot-a').deviceId();

        await expect(browser('slot-a').deviceId()).resolves.toBe(minted);
    });

    it('keeps one slot stable across repeated calls', async () => {
        const service = browser('slot-a');

        const [a, b] = await Promise.all([service.deviceId(), service.deviceId()]);

        expect(b).toBe(a);
    });

    it('gives two accounts two different ids - the whole of the isolation', async () => {
        const service = browser('slot-a');
        const a = await service.deviceId();

        registry.slotId = 'slot-b';
        const b = await service.deviceId();

        expect(b).not.toBe(a);
        expect(stored('mls_device_ids')).toEqual({'slot-a': a, 'slot-b': b});
    });

    it('adopts the legacy installation id for the first slot rather than re-minting', async () => {
        localStorage.setItem(`${PREFIX}mls_device_id`, JSON.stringify({value: 'legacy-device'}));
        const service = browser('slot-a');

        await expect(service.deviceId()).resolves.toBe('legacy-device');
    });

    it('hands the legacy id to one slot only - a second account gets a fresh one', async () => {
        localStorage.setItem(`${PREFIX}mls_device_id`, JSON.stringify({value: 'legacy-device'}));
        const service = browser('slot-a');
        await expect(service.deviceId()).resolves.toBe('legacy-device');

        registry.slotId = 'slot-b';
        await expect(service.deviceId()).resolves.not.toBe('legacy-device');
        // Still what slot-a adopted, for the same reason as in Tauri.
        expect(stored('mls_device_id')).toEqual({value: 'legacy-device'});
    });

    it('keeps the legacy id for the bootstrap slot, and mirrors a minted one back', async () => {
        localStorage.setItem(`${PREFIX}mls_device_id`, JSON.stringify({value: 'legacy-device'}));
        await expect(browser(BOOTSTRAP_SLOT_ID).deviceId()).resolves.toBe('legacy-device');

        localStorage.clear();
        const minted = await browser(BOOTSTRAP_SLOT_ID).deviceId();

        expect(stored('mls_device_id')).toEqual({value: minted});
    });

    it('persists the same shape the Tauri store holds, so neither backend is a fork', async () => {
        const service = browser(BOOTSTRAP_SLOT_ID);
        const id = await service.deviceId();

        // Byte for byte what the desktop path holds, only JSON encoded and prefixed.
        expect(localStorage.getItem(`${PREFIX}mls_device_ids`))
            .toBe(JSON.stringify({[BOOTSTRAP_SLOT_ID]: id}));
        expect(localStorage.getItem(`${PREFIX}mls_device_id`))
            .toBe(JSON.stringify({value: id}));
    });

    it('reset drops the live slot and the legacy mirror, and the next read mints anew', async () => {
        const service = browser(BOOTSTRAP_SLOT_ID);
        const first = await service.deviceId();

        await service.reset();

        expect(stored('mls_device_ids')).toEqual({});
        expect(stored('mls_device_id')).toBeUndefined();
        await expect(service.deviceId()).resolves.not.toBe(first);
    });

    it('mints rather than throwing when the stored value is corrupt', async () => {
        localStorage.setItem(`${PREFIX}mls_device_ids`, 'not json');
        const service = browser('slot-a');

        // Boot survivability: stranding the launch on an unparseable value is the failure to avoid.
        await expect(service.deviceId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });
});
