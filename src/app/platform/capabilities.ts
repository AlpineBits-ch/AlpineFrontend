import {Injectable} from '@angular/core';
import {detectHost, PlatformHost} from './host';

/**
 * What this host can actually do, read directly by templates.
 *
 * <p><b>Plain readonly booleans, not signals.</b> Every one of these is decided by which shell the
 * bundle loaded into, and that cannot change without a reload - so a signal would add a subscription
 * to a value that has no second state. `host` is fixed at boot for the same reason.</p>
 *
 * <p>This is what call sites should read instead of {@link detectHost}. "Is this Tauri" is almost
 * never the real question: the real questions are "can I bind a global hotkey" and "are these keys
 * OS-protected", and those stay answerable when a third host appears.</p>
 *
 * <p>The rules these drive, from the design spec:</p>
 * <ul>
 *   <li>A control that cannot work is <b>hidden</b> when its absence needs no explanation - window
 *       controls, the updater page.</li>
 *   <li>It is <b>disabled with a one-line reason</b> when a user would go looking for it - Activity
 *       and game detection, autostart, global hotkeys. The reason strings are i18n keys and ship in
 *       the locales submodule as their own commit.</li>
 *   <li>No control is ever left enabled over a no-op.</li>
 * </ul>
 *
 * <p>An abstract class so `inject(PlatformCapabilities)` needs no separate token, matching the ports.
 * The `useFactory` here is the default for anything that injects it without `providePlatform()`
 * having run - specs, mostly. `providePlatform()` overrides it with the same two factories.</p>
 */
@Injectable({
    providedIn: 'root',
    useFactory: (): PlatformCapabilities =>
        detectHost() === 'tauri' ? tauriCapabilities() : webCapabilities(),
})
export abstract class PlatformCapabilities {
    abstract readonly host: PlatformHost;
    /** Hotkeys that fire while another application has focus. The one PTT depends on. */
    abstract readonly globalHotkeys: boolean;
    /** Enumerating running processes to detect a game. */
    abstract readonly gameDetection: boolean;
    /** Binding `discord-ipc-0` and publishing what this machine is doing. */
    abstract readonly richPresence: boolean;
    abstract readonly autostart: boolean;
    /** Replacing the running app in place. A web client updates by being reloaded. */
    abstract readonly selfUpdate: boolean;
    /** The app draws its own titlebar and frame. */
    abstract readonly customWindowChrome: boolean;
    abstract readonly nativeToasts: boolean;
    /**
     * Whether a notification can arrive while the app is closed.
     *
     * <p>Distinct from {@link nativeToasts}, and deliberately so: a browser tab <i>can</i> show a
     * toast, it just cannot receive anything once it is shut. That is the sentence a settings page
     * has to render - "notifications only arrive while Venta is open" - and `nativeToasts` alone
     * would render it as "no notifications", which is wrong in the direction that loses messages
     * the user thinks they will be told about.</p>
     *
     * <p>False on web until Web Push exists, which is blocked on the server accepting a third token
     * kind. See the design spec's "Backend dependencies".</p>
     */
    abstract readonly backgroundPush: boolean;
    /** Whether key material sits behind an OS keychain. See `SecureStore.hardwareBacked`. */
    abstract readonly hardwareBackedKeys: boolean;
    /** Whether the in-app screen picker is used, or the host's own. */
    abstract readonly screenSourcePicker: boolean;
    /**
     * Whether voice activity detection stands in for push-to-talk.
     *
     * <p>Read as "VAD is the substitute for a global hotkey", not "this host can gate on speech".
     * The desktop engine has had a gate all along - `inputMode: 'voice'` - and that is unaffected by
     * this flag. What is web-only is VAD being the <i>only</i> way to key a microphone while a game
     * has focus, which is what makes Isle proximity voice usable in a browser at all, and what puts
     * a threshold slider and live input meter in voice settings on web only.</p>
     */
    abstract readonly voiceActivityDetection: boolean;
    /**
     * Whether this build ships an MLS engine at all.
     *
     * <p>True on both hosts as of 2026-08-11: `crates/venta-crypto` cross-compiles the same engine
     * to `wasm32`, and `mls::parity_tests` runs on that target proving it decrypts venta-mobile's
     * golden Welcome and unwraps its master-key envelopes byte-identically.</p>
     *
     * <p><b>This is a build-shape question, not a runtime-readiness one</b>, which is why it stays a
     * plain boolean while the wasm module loads asynchronously. Whether the engine is loaded
     * <i>right now</i> is `MlsEngine.available`, and a module that fails to load must still refuse
     * loudly through `MlsUnavailableError` - per that error's own comment, "it crashes earlier is
     * not an access control". Collapsing the two would make a transient load failure look like a
     * client that was never built with encryption, and those need different answers: one is retry,
     * the other is "use the desktop app".</p>
     */
    abstract readonly e2ee: boolean;
}

/** The desktop shell: everything native, and no VAD substitute because PTT works properly. */
export function tauriCapabilities(): PlatformCapabilities {
    return {
        host: 'tauri',
        globalHotkeys: true,
        gameDetection: true,
        richPresence: true,
        autostart: true,
        selfUpdate: true,
        customWindowChrome: true,
        nativeToasts: true,
        backgroundPush: true,
        hardwareBackedKeys: true,
        screenSourcePicker: true,
        voiceActivityDetection: false,
        e2ee: true,
    };
}

/**
 * A browser tab.
 *
 * <p>`nativeToasts` is false even though the Notification API exists: what the app needs from a toast
 * is the action types and the click routing the desktop plugin provides, and a web notification
 * carries neither without a service worker. The `Notifier` port still shows notifications on web -
 * this flag is about the native integration, not about whether anything appears on screen.</p>
 */
export function webCapabilities(): PlatformCapabilities {
    return {
        host: 'web',
        globalHotkeys: false,
        gameDetection: false,
        richPresence: false,
        autostart: false,
        selfUpdate: false,
        customWindowChrome: false,
        nativeToasts: false,
        // Blocked on the server accepting a `WebPush` token kind, not on client work.
        backgroundPush: false,
        hardwareBackedKeys: false,
        screenSourcePicker: false,
        voiceActivityDetection: true,
        e2ee: true,
    };
}
