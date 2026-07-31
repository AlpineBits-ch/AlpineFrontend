/**
 * The device id is the single identity the backend now validates. These tests pin the two
 * properties everything else depends on: it is stable across calls, and a transient store
 * failure does not poison the cache for the rest of the session.
 */
vi.mock('@tauri-apps/plugin-store');

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {LazyStore} from '@tauri-apps/plugin-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

const store = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    save: vi.fn(),
};

beforeEach(() => {
    vi.clearAllMocks();
    store.get.mockResolvedValue({value: 'stored-device-id'});
    store.set.mockResolvedValue(undefined);
    store.delete.mockResolvedValue(undefined);
    store.save.mockResolvedValue(undefined);
    // A regular function, not an arrow: the service calls `new LazyStore(...)`, and arrow
    // functions are not constructors.
    vi.mocked(LazyStore).mockImplementation(function () {
        return store as unknown as LazyStore;
    });
});

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
        ],
    });
    return TestBed.inject(DeviceIdentityService);
}

it('returns the id persisted in the store', async () => {
    const service = setup();
    await expect(service.deviceId()).resolves.toBe('stored-device-id');
    expect(store.set).not.toHaveBeenCalled();
});

it('generates and persists an id when the store has none', async () => {
    store.get.mockResolvedValue(null);
    const service = setup();

    const id = await service.deviceId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.set).toHaveBeenCalledWith('mls_device_id', {value: id});
    expect(store.save).toHaveBeenCalled();
});

it('reads the store once across repeated calls', async () => {
    const service = setup();

    await Promise.all([service.deviceId(), service.deviceId(), service.deviceId()]);

    expect(store.get).toHaveBeenCalledTimes(1);
});

it('does not cache a failure - a later call retries the store', async () => {
    store.get.mockRejectedValueOnce(new Error('store locked'));
    const service = setup();

    await expect(service.deviceId()).rejects.toThrow('store locked');
    await expect(service.deviceId()).resolves.toBe('stored-device-id');
});

it('reset clears the persisted id and the cache', async () => {
    const service = setup();
    await service.deviceId();

    await service.reset();
    store.get.mockResolvedValue({value: 'regenerated-id'});

    expect(store.delete).toHaveBeenCalledWith('mls_device_id');
    await expect(service.deviceId()).resolves.toBe('regenerated-id');
});
