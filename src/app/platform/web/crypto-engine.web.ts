import {CryptoEngine} from '../ports/crypto-engine.port';
import {
    dispatchVentaCrypto,
    loadVentaCrypto,
    VentaCryptoLoader,
    VentaCryptoModule,
} from './venta-crypto';

/**
 * {@link CryptoEngine} over the `venta-crypto` WASM module.
 *
 * <p>The eight commands here - `generate_key`, `generate_key_pairs`, `setup_master_key`,
 * `setup_master_key_dual`, `rewrap_master_key`, `generate_recovery_code`,
 * `normalize_recovery_code_checked`, `decrypt_master_key` - are the same Rust functions the desktop
 * runs, so a master key wrapped in a browser unwraps on the desktop and the other way round. That is
 * asserted rather than assumed: `parity_tests.rs` opens venta-mobile's golden wrappings on both
 * targets, and `wasm-pack test --node` runs it on real `wasm32-unknown-unknown`.</p>
 *
 * <p><b>Nothing is persisted here and nothing needs to be.</b> Unlike the MLS engine, none of these
 * commands has durable state: each takes its inputs and returns its outputs, and the wrapped master
 * key is stored by the caller. So the `save_to_disk` divergence that shapes `WebMlsEngine` does not
 * reach this adapter at all.</p>
 *
 * <p>There is no `available` flag on this port, by design - see its own header. An unavailable crypto
 * engine is a boot failure rather than a capability to branch on, so a failed module load simply
 * rejects, with the load error, on every call.</p>
 */
export class WebCryptoEngine extends CryptoEngine {
    private readonly load: VentaCryptoLoader;
    private module: Promise<VentaCryptoModule> | undefined;

    /** @param load the wasm module loader. Injectable so a spec can drive a fake engine. */
    constructor(load: VentaCryptoLoader = loadVentaCrypto) {
        super();
        this.load = load;
    }

    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        return dispatchVentaCrypto<T>(await this.wasm(), command, args);
    }

    /**
     * The module, loaded once.
     *
     * <p>A rejection is not memoised: the first thing this engine is asked for during onboarding is a
     * recovery code, and a remembered chunk-load failure would make the whole ceremony unfinishable
     * for the rest of the session rather than for one attempt.</p>
     */
    private wasm(): Promise<VentaCryptoModule> {
        this.module ??= this.load().catch((err: unknown) => {
            this.module = undefined;
            throw err;
        });
        return this.module;
    }
}
