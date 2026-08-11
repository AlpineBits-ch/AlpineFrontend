/**
 * The MLS engine, addressed by command name.
 *
 * <p><b>Deliberately not 45 named methods.</b> The `mls_*` command names and their argument shapes
 * are already settled and shared line-for-line with venta-mobile; restating them as a TypeScript
 * interface would create a second place for them to drift, and the drift would present as a silent
 * deserialisation mismatch rather than a type error. The adapter routes to Tauri `invoke` or to
 * wasm-bindgen; callers pass the same command and the same argument names either way.</p>
 *
 * <p>{@link available} is the gate `runMlsLaunch` needs. Until the WASM crate lands the web adapter
 * reports false, and a caller that respects it degrades to a usable client rather than throwing
 * through boot - which is the difference between a blank screen and a working one during the
 * migration.</p>
 */
export abstract class MlsEngine {
    abstract call<T>(command: string, args?: Record<string, unknown>): Promise<T>;

    abstract readonly available: boolean;
}
