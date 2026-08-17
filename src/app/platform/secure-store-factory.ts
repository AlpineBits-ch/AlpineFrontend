import {detectHost, PlatformHost} from './host';
import {SecureStore} from './ports/secure-store.port';
import {TauriSecureStore} from './tauri/secure-store';
import {WebSecureStore} from './web/secure-store';

/** The {@link SecureStore} adapter for a host. Each adapter reaches its backend on first call. */
export function createSecureStore(host: PlatformHost = detectHost()): SecureStore {
    return host === 'tauri' ? new TauriSecureStore() : new WebSecureStore();
}
