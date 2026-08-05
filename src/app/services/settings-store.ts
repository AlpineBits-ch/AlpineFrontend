import {isTauri} from '@tauri-apps/api/core';
import {LazyStore} from '@tauri-apps/plugin-store';

/**
 * The one Tauri store file the app's settings have always been written to.
 *
 * <p>Shared, not per-feature: the account registry, the device ids and the push token are three
 * unrelated keys in the same file, and each of their services opened its own `LazyStore` over it.
 * That is why this module is named for the file rather than for any one of its readers.</p>
 */
const STORE_FILE = 'settings.json';

/**
 * Namespace for the browser mirror of {@link STORE_FILE}.
 *
 * <p>Deliberately long and product-specific. `localStorage` is one flat namespace already shared
 * with the scoped OAuth token keys and the active-slot mirror, and the keys that go underneath
 * this prefix (`accounts`, `mls_device_ids`, `mls_device_id`, `push_token`) are generic enough that
 * something else could plausibly pick the same name. A collision here would not present as a
 * storage bug; it would present as this device being silently ejected from every MLS group it
 * belongs to, or as the account registry answering with somebody else's slots.</p>
 */
const BROWSER_KEY_PREFIX = 'alpine_settings::';

/**
 * The four operations the settings readers ask of their store, and nothing else.
 *
 * <p>Narrow on purpose. `LazyStore` satisfies it structurally, so the in-Tauri path stays the same
 * object making the same calls it always made, and the browser implementation only has to be
 * honest about these four rather than about a whole store API.</p>
 */
export interface SettingsStore {
    get<T>(key: string): Promise<T | undefined>;

    set(key: string, value: unknown): Promise<void>;

    delete(key: string): Promise<boolean>;

    save(): Promise<void>;
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
 * the device ids - see {@link UserTokenService}, where the tradeoff is spelled out. It is
 * acceptable only because this path is reached exclusively when there is no Tauri host to have
 * offered anything better, which in practice means the E2E browser build and nothing that ships to
 * a user. The packaged desktop app never constructs it.</p>
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

/**
 * The store for whichever host this bundle is running in, opened fresh per call.
 *
 * <p>Per call rather than cached, because that is precisely what the callers already did: a
 * `new LazyStore(STORE_FILE)` at every read and every write. `LazyStore` is lazy by construction,
 * so an unused one costs nothing, and holding the lifetime identical is part of what makes this
 * change a pure addition rather than an edit to the desktop path.</p>
 *
 * <p>Gated on `isTauri()` rather than on a build flag, because one bundle is both the thing the dev
 * server serves and the thing that gets packed into the desktop app. Inside Tauri this returns
 * exactly the `new LazyStore(STORE_FILE)` it has always returned, so nothing downstream of it can
 * observe that the other branch was added.</p>
 */
export function openSettingsStore(): SettingsStore {
    return isTauri() ? new LazyStore(STORE_FILE) : new BrowserSettingsStore();
}
