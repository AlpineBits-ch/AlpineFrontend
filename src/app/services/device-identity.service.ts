import {inject, Injectable, Injector} from '@angular/core';
import {firstValueFrom, from, Observable, switchMap} from 'rxjs';
import {LazyStore} from '@tauri-apps/plugin-store';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {DeviceService} from './device.service';
import {describeCurrentDevice} from './device-description';

const STORE_FILE = 'settings.json';
const DEVICE_ID_KEY = 'mls_device_id';

/**
 * Owns this installation's device identity - the id the backend validates as `X-Device-Id`,
 * attributes push tokens to, and links login sessions against.
 *
 * It is deliberately the *same* value MLS already persisted under `mls_device_id`: the MLS
 * keychain entries are named `alpine_mls_{deviceId}_{field}`, so a second identifier would
 * orphan every stored signing key. `MlsService` delegates here rather than keeping its own copy.
 */
@Injectable({providedIn: 'root'})
export class DeviceIdentityService {
    private readonly injector = inject(Injector);
    private cached: Promise<string> | null = null;

    /**
     * Resolved on demand, not as a field.
     *
     * Reading the device id needs no HTTP at all - only registration does. Injecting
     * `DeviceService` eagerly would drag `ApiConfigService` and `OAuthService` into every
     * consumer's injector, which is how this first broke `MlsService`: 250 tests of a pure Tauri
     * adapter suddenly needed an OAuth provider.
     */
    private get devices(): DeviceService {
        return this.injector.get(DeviceService);
    }

    /** Stable per-installation id. Resolved from the store once per app session. */
    deviceId(): Promise<string> {
        if (!this.cached) {
            // A rejected promise left in the cache would fail every later caller for the whole
            // session, turning one transient store error into a permanently header-less client.
            this.cached = this.resolve().catch((err: unknown) => {
                this.cached = null;
                throw err;
            });
        }
        return this.cached;
    }

    /** Drops the persisted id so the next {@link deviceId} call mints a fresh one. */
    async reset(): Promise<void> {
        this.cached = null;
        const store = new LazyStore(STORE_FILE);
        await store.delete(DEVICE_ID_KEY);
        await store.save();
    }

    /**
     * Idempotently (re)creates this device's server-side record.
     *
     * Deliberately re-registers with the signing key already in secure storage instead of
     * generating a batch: `MlsService.generateKeyPackages` mints a *fresh* Ed25519 keypair, which
     * would silently orphan this device from every MLS group it belongs to. Recovering a deleted
     * device row must not cost the account its message history on this machine.
     *
     * @returns false when it could not register - the caller should fall through to its normal
     *          error path rather than retry. The interactive `DeviceRegistrationModalComponent`
     *          remains the only correct recovery when no signing key is stored at all.
     */
    async ensureRegistered(): Promise<boolean> {
        try {
            const deviceId = await this.deviceId();
            const identityPublicKey = await secureStorage.getItem(`alpine_mls_${deviceId}_pub`);
            if (!identityPublicKey) return false;

            const {deviceName, deviceType} = describeCurrentDevice();
            await firstValueFrom(this.devices.registerDevice({
                clientDeviceId: deviceId,
                deviceName,
                deviceType,
                identityPublicKey,
            }));
            return true;
        } catch (err) {
            console.error('Device re-registration failed', err);
            return false;
        }
    }

    /** "Forget this device" - see {@link DeviceService.deleteDevice} for what this destroys. */
    unregister(): Observable<void> {
        return from(this.deviceId()).pipe(
            switchMap(deviceId => this.devices.deleteDevice(deviceId)),
        );
    }

    private async resolve(): Promise<string> {
        const store = new LazyStore(STORE_FILE);
        let entry = await store.get<{ value: string }>(DEVICE_ID_KEY);

        if (!entry) {
            entry = {value: crypto.randomUUID()};
            await store.set(DEVICE_ID_KEY, entry);
            await store.save();
        }

        return entry.value;
    }
}
