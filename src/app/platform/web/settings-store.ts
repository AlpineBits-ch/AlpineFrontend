import {SettingsStore, SettingsStoreFactory} from '../ports/settings-store.port';

/**
 * Namespace for the browser mirror of the Tauri settings file.
 *
 * <p>Deliberately long and product-specific. `localStorage` is one flat namespace already shared
 * with the scoped OAuth token keys and the active-slot mirror, and the keys that go underneath
 * this prefix (`accounts`, `mls_device_ids`, `mls_device_id`, `push_token`) are generic enough that
 * something else could plausibly pick the same name. A collision here would not present as a
 * storage bug; it would present as this device being silently ejected from every MLS group it
 * belongs to, or as the account registry answering with somebody else's slots.</p>
 *
 * <p><b>A persisted name.</b> Every browser session that has ever booted holds its device id under
 * this prefix, so changing it orphans them - which reads as those sessions being ejected from their
 * groups. `device-identity.service.spec.ts` pins the literal for exactly that reason.</p>
 */
const BROWSER_KEY_PREFIX = 'alpine_settings::';

/**
 * {@link SettingsStoreFactory} over `localStorage`.
 *
 * <p>One store per file name, per call, matching the desktop factory's lifetime. There is nothing to
 * construct - the state lives in `localStorage` - so the file name only participates in the key
 * scoping through the prefix above, which is the shape browser sessions already have on disk.</p>
 */
export class WebSettingsStoreFactory extends SettingsStoreFactory {
    open(_file: string): SettingsStore {
        return new BrowserSettingsStore();
    }
}

/**
 * `localStorage`, shaped like the Tauri store.
 *
 * <p><b>It exists so the client can boot outside the desktop shell at all.</b> In a plain browser
 * there is no IPC host, so every `LazyStore` call rejects - and the very first thing the app does
 * is resolve a device id, which goes through `AccountRegistryService.activeSlotId()` and so through
 * this file. One rejection there and `appReady.markReady()` never runs, the app sits on the loading
 * overlay forever, and nothing - not even a registration request - reaches the backend. The same id
 * is what feeds the `X-Device-Id` header the backend validates on voice join. No store means no app
 * shell, which is the whole of why a browser build was not possible.</p>
 *
 * <p>Stores the values verbatim, one `localStorage` entry per store key, JSON encoded. Keeping the
 * persisted *shape* identical rather than inventing a flatter one is what lets the migration off
 * the pre-slot device id, the bootstrap-slot mirroring, the claim-once rule and the slot list above
 * this layer remain a single implementation that has no idea which backend it is talking to.</p>
 *
 * <p>Not a security boundary, and it cannot be made into one: a browser has no keychain, so
 * anything kept here is readable by anything with the origin. That covers the push token as well as
 * the device ids - see {@link UserTokenService}, where the tradeoff is spelled out. <b>This path now
 * ships to real users</b> - the browser-only build design makes the web client a public one, so the
 * old note that it was reached "only in the E2E build" no longer holds. What holds instead is that
 * nothing kept here is secret: ids, slot bookkeeping and the push token, none of which is key
 * material. Key material goes to {@link SecureStore}, which on web is IndexedDB and says so through
 * `hardwareBacked`.</p>
 */
class BrowserSettingsStore implements SettingsStore {
    async get<T>(key: string): Promise<T | undefined> {
        const raw = localStorage.getItem(scoped(key));
        if (raw === null) return undefined;

        try {
            return JSON.parse(raw) as T;
        } catch {
            // A value that will not parse is a value nothing above here can act on. Reporting it as
            // absent lets the caller mint a fresh id, or start from an empty slot list, which is
            // exactly what it does on a cold install; throwing would strand the boot on the failure
            // this class exists to remove.
            return undefined;
        }
    }

    async set(key: string, value: unknown): Promise<void> {
        localStorage.setItem(scoped(key), JSON.stringify(value));
    }

    async delete(key: string): Promise<boolean> {
        const name = scoped(key);
        const existed = localStorage.getItem(name) !== null;
        localStorage.removeItem(name);
        return existed;
    }

    async save(): Promise<void> {
        // `localStorage` writes through on `setItem`, so there is nothing to flush. Kept because
        // the caller cannot know which backend it is holding, and `LazyStore` genuinely needs it.
    }
}

function scoped(key: string): string {
    return `${BROWSER_KEY_PREFIX}${key}`;
}
