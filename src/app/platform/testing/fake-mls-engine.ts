import {MlsEngine} from '../ports/mls-engine.port';

/** One recorded call, in the shape the Rust-side argument-name assertions talk about. */
export interface RecordedEngineCall {
    command: string;
    args: Record<string, unknown> | undefined;
}

/** What a fake engine answers a command with. Receives exactly what `call` received. */
export type EngineHandler = (command: string, args?: Record<string, unknown>) => unknown;

/**
 * An {@link MlsEngine} for specs, provided in TestBed in place of an adapter.
 *
 * <p>This is what replaced `vi.mock('@tauri-apps/api/core')` in the MLS specs. The difference is not
 * tidiness: a module mock pins one host's IPC, so the two things only the port can express were
 * untestable - {@link available} being false, and the same call sites running against a second engine.
 * `MlsService` is a pure adapter over this port, so a fake here exercises exactly what it did before
 * against exactly the same 250 assertions.</p>
 *
 * <p>Records every `(command, args)` pair, because the argument <i>names</i> are the contract: they are
 * `#[serde(rename_all = "camelCase")]` field names on the Rust side, so a mismatch is a silent
 * deserialization failure rather than a type error. The Rust tests
 * `the_tauri_argument_names_match_the_typescript_call_sites` and
 * `the_wasm_argument_names_match_the_tauri_commands` assert the other two sides of the same triangle.</p>
 *
 * <p>{@link handler} exists so a spec can drive this with a `vi.fn()` and keep using
 * `mockResolvedValue` / `mockRejectedValue` / `mock.calls` - which is how the existing specs moved onto
 * the port without rewriting the assertions that are the actual value in them.</p>
 */
export class FakeMlsEngine extends MlsEngine {
    /** Flip to false to stand in for a build - or a page - whose engine never loaded. */
    available = true;

    readonly calls: RecordedEngineCall[] = [];

    /** Answers every command when set. Takes precedence over {@link result} and {@link rejection}. */
    handler: EngineHandler | undefined;

    /** What every command resolves to when there is no {@link handler}. */
    result: unknown = undefined;

    /** Set to make every command reject with this. */
    rejection: unknown = undefined;

    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        this.calls.push({command, args});

        if (this.handler) return await this.handler(command, args) as T;
        if (this.rejection !== undefined) throw this.rejection;
        return this.result as T;
    }

    /** The last call, or the last call to `command`. */
    lastCall(command?: string): RecordedEngineCall | undefined {
        const matching = command === undefined
            ? this.calls
            : this.calls.filter(call => call.command === command);
        return matching.at(-1);
    }

    /** Every command name seen, in order. */
    commands(): string[] {
        return this.calls.map(call => call.command);
    }

    reset(): void {
        this.calls.length = 0;
        this.handler = undefined;
        this.result = undefined;
        this.rejection = undefined;
        this.available = true;
    }
}
