import {createSettingsStoreFactory} from '../platform/settings-store-factory';

/**
 * The one Tauri store file the app's settings have always been written to.
 *
 * <p>Shared, not per-feature: the account registry, the device ids and the push token are three
 * unrelated keys in the same file, and each of their services opened its own `LazyStore` over it.
 * That is why this module is named for the file rather than for any one of its readers.</p>
 */
const STORE_FILE = 'settings.json';

/**
 * The four operations the settings readers ask of their store, and nothing else.
 *
 * <p>Narrow on purpose. `LazyStore` satisfies it structurally, so the in-Tauri path stays the same
 * object making the same calls it always made, and the browser implementation only has to be
 * honest about these four rather than about a whole store API.</p>
 *
 * <p>Still declared here rather than in `platform/ports/settings-store.port.ts`, which re-exports it:
 * moving it would break the one property that makes a single interface serve both hosts, since
 * `LazyStore` satisfies this shape by accident of having the same four methods.</p>
 */
export interface SettingsStore {
    get<T>(key: string): Promise<T | undefined>;

    set(key: string, value: unknown): Promise<void>;

    delete(key: string): Promise<boolean>;

    save(): Promise<void>;
}

/**
 * The store for whichever host this bundle is running in, opened fresh per call.
 *
 * <p>Per call rather than cached, because that is precisely what the callers already did: a
 * `new LazyStore(STORE_FILE)` at every read and every write. `LazyStore` is lazy by construction,
 * so an unused one costs nothing, and holding the lifetime identical is part of what makes this
 * change a pure addition rather than an edit to the desktop path.</p>
 *
 * <p>The backend is chosen at runtime rather than by a build flag, because one bundle is both the
 * thing the dev server serves and the thing that gets packed into the desktop app. That decision
 * used to be an `isTauri()` call right here; it now belongs to `SettingsStoreFactory` and its two
 * adapters, and `createSettingsStoreFactory()` asks `detectHost()` per call for the same reason
 * `isTauri()` was called per call - so a test can define the Tauri global and get the branch it asked
 * for. Inside Tauri this still resolves to a `LazyStore` over `STORE_FILE`, so nothing downstream can
 * observe that either branch exists.</p>
 *
 * <p><b>Still a free function, deliberately.</b> Its three callers are `DeviceIdentityService`,
 * `AccountRegistryService` and `UserTokenService`, and the latter two belong to tracks that have not
 * migrated - `AccountRegistryService` in particular is reached from a route guard and an interceptor
 * before much of the injector exists. When they inject {@link SettingsStoreFactory} directly this
 * function goes away; until then it is one delegate over the port rather than a second host gate.</p>
 */
export function openSettingsStore(): SettingsStore {
    return createSettingsStoreFactory().open(STORE_FILE);
}
