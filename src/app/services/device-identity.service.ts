import {Injectable} from '@angular/core';
import {LazyStore} from '@tauri-apps/plugin-store';

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
    private cached: Promise<string> | null = null;

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
