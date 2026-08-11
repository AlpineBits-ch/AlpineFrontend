import {OsInfo} from '../ports/os-info.port';
import {OsFamily, sniffOsFamily} from '../os-kind';

/**
 * The global `@tauri-apps/plugin-os` injects into every window before application script runs.
 *
 * <p>Declared locally rather than imported, and that is the interesting decision in this file. The
 * plugin's `type()` is not an IPC call - it is one property read off this object, set at compile
 * time. Since {@link OsInfo.kind} is a synchronous field, a lazily {@code import()}ed module could
 * not fill it in: the value has to exist the moment the adapter is constructed. Statically importing
 * the plugin instead would put it in the single shared bundle and break the rule that the web build
 * pulls no Tauri plugin. Reading the global directly is the only option that satisfies both, and it
 * reads exactly what `type()` would have returned.</p>
 *
 * <p>The two genuinely asynchronous answers below - app name and version - do come over IPC, and
 * those <i>are</i> behind a lazy {@code import()}.</p>
 */
interface TauriOsPluginInternals {
    readonly os_type?: OsFamily;
}

/**
 * What the desktop shell knows about itself.
 *
 * <p>Replaces `PlatformService`'s `isTauri() && (type() == 'ios' || type() == 'android')`. The
 * difference that matters is that nothing here can throw: `PlatformService` documents at length how a
 * `TypeError` from a field initialiser took route activation down with it, and the fix is that a
 * missing global is a value rather than an exception.</p>
 */
export class TauriOsInfo extends OsInfo {
    override readonly kind: OsInfo['kind'];
    override readonly isMobile: boolean;

    constructor() {
        super();
        this.kind = readOsType() ?? sniffOsFamily() ?? 'linux';
        this.isMobile = this.kind === 'ios' || this.kind === 'android';
    }

    /** The `productName` from `tauri.conf.json`, so a rename reaches the UI without a frontend edit. */
    override async appName(): Promise<string> {
        const {getName} = await import('@tauri-apps/api/app');
        return getName();
    }

    /** The `version` from `tauri.conf.json`, which the release bump script owns. */
    override async appVersion(): Promise<string> {
        const {getVersion} = await import('@tauri-apps/api/app');
        return getVersion();
    }
}

/**
 * The OS the shell was compiled for, or null when the plugin is not registered in this window.
 *
 * <p>Falling through to a UA sniff and then to {@code 'linux'} rather than to {@code 'web'} is
 * deliberate: this adapter is only ever constructed inside a Tauri window, so {@code 'web'} would be
 * a false answer that switches off capabilities the host really has. A wrong <i>desktop</i> OS is a
 * cosmetic error; "this is a browser" is not.</p>
 */
function readOsType(): OsFamily | null {
    if (typeof window === 'undefined') return null;
    const internals = (window as unknown as {
        __TAURI_OS_PLUGIN_INTERNALS__?: TauriOsPluginInternals;
    }).__TAURI_OS_PLUGIN_INTERNALS__;
    return internals?.os_type ?? null;
}
