/**
 * What this client is running on, and what it calls itself.
 *
 * `kind` carries a `'web'` member the Tauri OS plugin's own type does not have. `isMobile` is a
 * form factor on both hosts, so it is true on a phone browser.
 */
export abstract class OsInfo {
    abstract readonly kind: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'web';
    abstract readonly isMobile: boolean;

    abstract appName(): Promise<string>;

    abstract appVersion(): Promise<string>;

    /** The machine's network name, or null where the host has none to give. */
    abstract hostname(): Promise<string | null>;
}
