import {detectHost, PlatformHost} from './host';
import {SecureStore} from './ports/secure-store.port';
import {TauriSecureStore} from './tauri/secure-store';
import {WebSecureStore} from './web/secure-store';

/**
 * The {@link SecureStore} adapter for a host.
 *
 * <p>Both adapters are imported statically and both are trivial - the heavy dependency each one
 * needs (the keychain plugin, IndexedDB) is reached on first call, not here. So the unused adapter
 * costs a few lines in the bundle and nothing at runtime, and in exchange the choice is made in one
 * place that `providePlatform()` and a test can both call.</p>
 */
export function createSecureStore(host: PlatformHost = detectHost()): SecureStore {
    return host === 'tauri' ? new TauriSecureStore() : new WebSecureStore();
}
