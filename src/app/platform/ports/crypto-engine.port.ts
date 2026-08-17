/**
 * Key generation, master-key wrapping, recovery codes and device certificates.
 *
 * Addressed by command name, like {@link MlsEngine}: the Rust crate is the one place the commands
 * and their argument shapes are written down. No `available` flag; both adapters run the same Rust.
 */
export abstract class CryptoEngine {
    abstract call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}
