import {Injectable} from '@angular/core';
import {detectHost} from '../platform/host';

/**
 * `@tauri-apps/plugin-os`'s `type()`, inlined - it is literally
 * `window.__TAURI_OS_PLUGIN_INTERNALS__.os_type` and nothing more.
 *
 * <p><b>Inlined rather than routed through the `OsInfo` port, and that is a duplication worth naming.</b>
 * `OsInfo` is the right home for this and already reports `isMobile`, but its `kind`/`isMobile` are
 * populated by an adapter this service cannot inject: `PlatformService` is injected from *field
 * initialisers* all over the app, and adding a port dependency there re-opens the failure documented on
 * {@link PlatformService.isMobile} - anything that throws while the injector is constructing takes the
 * component being constructed down with it. Collapsing the two is a follow-up that belongs with the
 * consumers, not with this file.</p>
 *
 * <p>The read is `?.`-chained rather than gated, so a host that injected no such global answers `null`
 * instead of throwing. That is the whole difference between this and the plugin call it replaces.</p>
 */
function readOsType(): string | null {
    if (typeof window === 'undefined') return null;
    const internals = (window as {__TAURI_OS_PLUGIN_INTERNALS__?: {os_type?: string}})
        .__TAURI_OS_PLUGIN_INTERNALS__;
    return internals?.os_type ?? null;
}

@Injectable({
    providedIn: 'root',
})
export class PlatformService {
    /** Memoised, because the answer cannot change within a session. `null` means "not asked yet". */
    private mobile: boolean | null = null;

    /**
     * Whether this is a phone build.
     *
     * <p>Gated on the host because the OS read is not a call that can fail gracefully - it dereferences
     * `window.__TAURI_OS_PLUGIN_INTERNALS__`, a global the Tauri runtime injects, so with no runtime
     * the plugin's own `type()` throws a `TypeError` instead of returning anything. This used to be a
     * field initialiser, so the throw landed while the injector was constructing the service, and took
     * down whatever was being constructed at the time. Outside Tauri that was `MainPageComponent`:
     * route activation for `/overview` threw, the router restored the URL it came from, and the app sat
     * on `/authentication` with an empty router outlet and a perfectly good session it never got to
     * use.</p>
     *
     * <p><b>A getter now, not a field, and that is the point.</b> Both halves of the old expression are
     * still here - `detectHost() === 'tauri'` in place of `isTauri()`, and the same two OS values - so
     * no desktop or mobile build can observe a difference. What changed is *when* it runs: nothing at
     * all happens during construction, so even a future read that does throw cannot reach an injector.
     * Outside Tauri the answer is "not mobile", which is the only honest one available: there is no
     * Tauri build that runs outside Tauri, so that branch is the browser bundle.</p>
     */
    public get isMobile(): boolean {
        return (this.mobile ??= this.readIsMobile());
    }

    private readIsMobile(): boolean {
        if (detectHost() !== 'tauri') return false;
        const os = readOsType();
        return os === 'ios' || os === 'android';
    }
}
