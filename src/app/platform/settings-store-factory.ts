import {detectHost, PlatformHost} from './host';
import {SettingsStoreFactory} from './ports/settings-store.port';
import {TauriSettingsStoreFactory} from './tauri/settings-store';
import {WebSettingsStoreFactory} from './web/settings-store';

/**
 * The {@link SettingsStoreFactory} adapter for a host.
 *
 * <p><b>The one place the settings backend is chosen.</b> Two callers reach it: the
 * `SettingsStoreFactory` provider in `providePlatform()`, for anything that injects the port, and
 * `openSettingsStore()` in `services/settings-store.ts`, which is still a free function because two
 * of its three callers belong to tracks that have not migrated yet. Having them share this function
 * is what keeps that transitional state from becoming a second host gate.</p>
 *
 * <p>Neither adapter holds state, and both are cheap to construct - the desktop one defers its plugin
 * `import()` to the first call - so callers are free to build one per use, which is what the
 * per-call lifetime of `openSettingsStore()` does.</p>
 */
export function createSettingsStoreFactory(
    host: PlatformHost = detectHost(),
): SettingsStoreFactory {
    return host === 'tauri' ? new TauriSettingsStoreFactory() : new WebSettingsStoreFactory();
}
