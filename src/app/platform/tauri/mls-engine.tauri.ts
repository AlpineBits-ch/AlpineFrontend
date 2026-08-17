import {MlsEngine} from '../ports/mls-engine.port';

/**
 * {@link MlsEngine} over Tauri's `invoke`.
 *
 * <p>A lookup table with no translation: the port's `call(command, args)` is the IPC call, because the
 * command names and argument objects the callers already pass <i>are</i> the Tauri ones. Nothing is
 * renamed, defaulted or reshaped here - the Rust test `the_tauri_argument_names_match_the_typescript_call_sites`
 * asserts the pairing directly against the call sites, and it can only keep doing that while this
 * adapter stays a pass-through.</p>
 *
 * <p>{@link available} is a constant `true`: inside Tauri the engine is compiled into the binary, so
 * there is nothing to load and nothing that can fail to. A command the running build does not define
 * is a different question, answered per call by `MlsService.callOptional`.</p>
 *
 * <p>`@tauri-apps/api/core` is imported on first call rather than at module scope, so the plugin is
 * fetched by the host that has it and never by a browser client that loaded this file's sibling.</p>
 */
export class TauriMlsEngine extends MlsEngine {
    readonly available = true;

    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<T>(command, args);
    }
}
