import {detectHost, PlatformHost} from './host';
import {SettingsStoreFactory} from './ports/settings-store.port';
import {TauriSettingsStoreFactory} from './tauri/settings-store';
import {WebSettingsStoreFactory} from './web/settings-store';

/**
 * The {@link SettingsStoreFactory} adapter for a host. The one place the settings backend is chosen.
 *
 * Neither adapter holds state, so callers may build one per use.
 */
export function createSettingsStoreFactory(host: PlatformHost = detectHost()): SettingsStoreFactory {
    return host === 'tauri' ? new TauriSettingsStoreFactory() : new WebSettingsStoreFactory();
}
