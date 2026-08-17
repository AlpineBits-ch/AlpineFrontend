/**
 * The MLS engine, addressed by command name rather than 45 named methods.
 *
 * The `mls_*` names and argument shapes are shared with venta-mobile, so restating them here would
 * create a second place for them to drift. {@link available} is the gate `runMlsLaunch` needs.
 */
export abstract class MlsEngine {
    abstract call<T>(command: string, args?: Record<string, unknown>): Promise<T>;

    abstract readonly available: boolean;
}
