/**
 * Key generation, master-key wrapping, recovery codes and device certificates.
 *
 * <p>Same `call(command, args)` shape and the same reasoning as {@link MlsEngine}: these commands are
 * shared with venta-mobile and their argument shapes are part of an at-rest format, so the one place
 * they are written down stays the Rust crate.</p>
 *
 * <p>No `available` flag, unlike `MlsEngine`. There is no useful client without key generation, so
 * an unavailable crypto engine is a boot failure rather than a capability to branch on - and both
 * adapters run the same Rust code, one over IPC and one over wasm-bindgen, producing byte-identical
 * output. That parity is the load-bearing test of this design, not an assumption.</p>
 */
export abstract class CryptoEngine {
    abstract call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}
