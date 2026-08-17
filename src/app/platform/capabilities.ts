import {Injectable} from '@angular/core';
import {detectHost, PlatformHost} from './host';

/**
 * What this host can actually do, read directly by templates. Read this instead of {@link detectHost}.
 *
 * Plain readonly booleans, not signals: none of them can change without a reload.
 *
 * The rules they drive: a control that cannot work is hidden when its absence needs no explanation,
 * disabled with a one-line reason when a user would go looking for it, and never left enabled over
 * a no-op.
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
     * Whether a notification can arrive while the app is closed. Distinct from {@link nativeToasts}:
     * a browser tab can show a toast, it just cannot receive one once it is shut.
     */
    abstract readonly backgroundPush: boolean;
    /** Whether key material sits behind an OS keychain. See `SecureStore.hardwareBacked`. */
    abstract readonly hardwareBackedKeys: boolean;
    /** Whether the in-app screen picker is used, or the host's own. */
    abstract readonly screenSourcePicker: boolean;
    /**
     * Whether voice activity detection stands in for push-to-talk. Not "this host can gate on
     * speech": the desktop engine's `inputMode: 'voice'` gate is unaffected by this flag.
     */
    abstract readonly voiceActivityDetection: boolean;
    /**
     * Whether this build ships an MLS engine at all. A build-shape question, not a runtime-readiness
     * one: whether the engine is loaded right now is `MlsEngine.available`, and the two must not be
     * collapsed.
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
 * `nativeToasts` is false even though the Notification API exists: it means the native integration,
 * not whether anything appears on screen. The `Notifier` port still shows notifications on web.
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
