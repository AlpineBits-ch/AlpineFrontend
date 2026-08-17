import {CryptoEngine} from '../ports/crypto-engine.port';

/**
 * {@link CryptoEngine} over Tauri's `invoke`.
 *
 * <p>The same pass-through as {@link TauriMlsEngine}, for the eight key-generation, master-key and
 * recovery-code commands. It matters more here than anywhere else that nothing is reshaped: these
 * argument objects are part of an at-rest format, and C2 was a call site that supplied three of
 * `rewrap_master_key`'s five arguments - every call failed at Tauri's argument deserialization, and a
 * user mid-recovery holding a correct recovery code was told it was wrong.</p>
 */
export class TauriCryptoEngine extends CryptoEngine {
    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<T>(command, args);
    }
}
