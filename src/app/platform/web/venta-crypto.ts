/**
 * The `venta-crypto` WASM module: the browser's copy of the same Rust engine the desktop runs.
 *
 * <p>Loaded from `assets/wasm/venta_crypto.js` at runtime rather than bundled, because that is what
 * `bun run build:wasm` produces and what `angular.json` copies - the output is a build artifact and
 * deliberately not committed (see `.gitignore`), so a static `import` of it would make a checkout
 * without the artifact fail to typecheck. The specifier is therefore a computed URL, which also stops
 * the bundler trying to resolve it at build time; `venta_crypto_bg.wasm` is fetched by the module
 * itself, relative to its own `import.meta.url`, so the two files only ever have to sit beside each
 * other.</p>
 *
 * <p><b>Every export takes a JSON string and returns a JSON string</b>, under the exact Tauri command
 * name. That is what lets {@link MlsEngine.call} be one function for both hosts: the web adapter hands
 * the wasm module the same argument object it hands Tauri's `invoke`. See the header of
 * `crates/venta-crypto/src/wasm.rs`, which is normative about why.</p>
 */

/** One wasm-bindgen wrapper. The zero-argument ones ignore the string they are handed. */
export type VentaCryptoCommand = (argsJson: string) => string;

/**
 * The module surface, declared here rather than imported from the generated `venta_crypto.d.ts`.
 *
 * <p>The generated declarations are gitignored alongside the `.wasm` they describe, so a source file
 * that imported them would only typecheck on a machine that had run `build:wasm`. This is the whole
 * shape the adapters use - 36 commands addressed by name, plus wasm-bindgen's default initialiser -
 * and the Rust-side test `the_wasm_argument_names_match_the_tauri_commands` is what pins the argument
 * objects those commands accept.</p>
 */
export interface VentaCryptoModule {
    /** wasm-bindgen's `--target web` initialiser. Fetches and instantiates `venta_crypto_bg.wasm`. */
    default: (moduleOrPath?: unknown) => Promise<unknown>;

    [command: string]: unknown;
}

export type VentaCryptoLoader = () => Promise<VentaCryptoModule>;

/** Where `angular.json` copies the wasm-pack output to, relative to the deployment's base href. */
const MODULE_PATH = 'assets/wasm/venta_crypto.js';

let loading: Promise<VentaCryptoModule> | undefined;

/**
 * The instantiated module, imported and initialised once per page.
 *
 * <p><b>A rejection is not memoised.</b> Fetching a 2MB blob over a flaky connection fails
 * transiently, and a remembered rejection would make one unlucky boot permanent for the whole
 * session - which for this module means no encryption at all until the user reloads. The same rule
 * the settings-store and secure-store adapters follow.</p>
 */
export function loadVentaCrypto(): Promise<VentaCryptoModule> {
    loading ??= importAndInit().catch((err: unknown) => {
        loading = undefined;
        throw err;
    });
    return loading;
}

async function importAndInit(): Promise<VentaCryptoModule> {
    // `document.baseURI` rather than a root-absolute path, so a deployment under a sub-path (a
    // `<base href>` other than `/`) still resolves. Computed rather than a literal so the bundler
    // leaves it alone - this file is copied as an asset, not compiled into a chunk.
    const url = new URL(MODULE_PATH, document.baseURI).href;
    const module = await (import(
        /* @vite-ignore */ /* webpackIgnore: true */ url
    ) as Promise<VentaCryptoModule>);
    await module.default();
    return module;
}

/**
 * Calls one command on the module, with the same argument object Tauri's `invoke` would receive.
 *
 * <p>The result is JSON, and a command whose Rust return type is `()` serialises to `null` - which is
 * what `invoke` resolves for a `Result<(), String>` too, so callers cannot tell the hosts apart.</p>
 *
 * <p>An absent export is reported with <b>Tauri's own not-found wording</b>, deliberately: the command
 * name plus "not found" is what `MlsService.callOptional` matches to tell a missing feature from a
 * failing one, and a browser-specific phrasing there would turn a degradable absence into a hard
 * rejection on one host only. Two Tauri commands are intentionally not exposed to wasm -
 * `mls_current_state_dir` and `device_cert_verify`, neither of which has a TypeScript caller - so this
 * is the path they would take if one ever gained a caller.</p>
 */
export function dispatchVentaCrypto<T>(
    module: VentaCryptoModule,
    command: string,
    args?: Record<string, unknown>,
): T {
    const fn = module[command];
    if (typeof fn !== 'function') {
        throw `Command ${command} not found`;
    }

    // Always a string, even for the zero-argument commands: wasm-bindgen's generated wrappers ignore
    // arguments they do not declare, so one call shape serves all 36 and no caller has to know which
    // kind it is holding.
    const json = (fn as VentaCryptoCommand)(JSON.stringify(args ?? {}));
    return JSON.parse(json) as T;
}
