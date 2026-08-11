/**
 * What this client is running on, and what it calls itself.
 *
 * <p>`kind` gains a `'web'` member that the Tauri OS plugin's own type does not have. That is
 * deliberate: every existing caller of `type()` is really asking "which desktop OS", and the honest
 * answer in a browser is none of them. Making the absence a value rather than a thrown `TypeError`
 * is the fix for the failure mode `PlatformService` documents at length - a field initialiser that
 * throws while the injector is constructing a component, taking the route activation down with
 * it.</p>
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
