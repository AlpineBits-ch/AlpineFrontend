import {detectHost, PlatformHost} from './host';
import {SettingsStoreFactory} from './ports/settings-store.port';
import {TauriSettingsStoreFactory} from './tauri/settings-store';
import {WebSettingsStoreFactory} from './web/settings-store';

/**
 * The {@link SettingsStoreFactory} adapter for a host.
 *
 * <p><b>The one place the settings backend is chosen, and now the only one.</b> Its single caller is
 * the `SettingsStoreFactory` provider in `providePlatform()`. There used to be a second - the free
 * function `openSettingsStore()` in `services/settings-store.ts`, kept while its three callers
 * migrated - and it is gone: `AccountRegistryService`, `DeviceIdentityService` and `UserTokenService`
 * inject the port. The `host` parameter therefore has no caller that omits it, and the
 * `detectHost()` default stays only so this function reads correctly on its own.</p>
 *
 * <p>Neither adapter holds state, and both are cheap to construct - the desktop one defers its plugin
 * `import()` to the first call - so callers are free to build one per use, which is what the
 * per-call lifetime of {@link SettingsStoreFactory.open} does.</p>
 */
export function createSettingsStoreFactory(
    host: PlatformHost = detectHost(),
): SettingsStoreFactory {
    return host === 'tauri' ? new TauriSettingsStoreFactory() : new WebSettingsStoreFactory();
}
