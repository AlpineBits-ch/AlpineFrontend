/**
 * What this client is running on, and what it calls itself.
 *
 * <p>`kind` gains a `'web'` member that the Tauri OS plugin's own type does not have. That is
 * deliberate: every existing caller of `type()` is really asking "which desktop OS", and the honest
 * answer in a browser is none of them. Making the absence a value rather than a thrown `TypeError`
 * is the fix for a failure this port was written in response to: `PlatformService`, now deleted,
 * read `window.__TAURI_OS_PLUGIN_INTERNALS__.os_type` from a field initialiser, so outside Tauri the
 * `TypeError` landed while the injector was constructing `MainPageComponent`. Route activation for
 * `/overview` threw, the router restored the URL it came from, and the app sat on `/authentication`
 * with an empty outlet and a perfectly good session. `isMobile` is this port's answer now, and it is
 * a *form factor* on both hosts - true on a phone browser, where the old service answered false for
 * everything outside Tauri.</p>
 *
 * <p>`appName()` and `appVersion()` are async because Tauri answers over IPC. The web adapter has
 * the answers synchronously and resolves immediately; the shape stays async so no caller has two
 * code paths.</p>
 */
export abstract class OsInfo {
    abstract readonly kind: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'web';
    abstract readonly isMobile: boolean;

    abstract appName(): Promise<string>;

    abstract appVersion(): Promise<string>;
}
