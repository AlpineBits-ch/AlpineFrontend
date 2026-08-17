/**
 * The one Tauri store file the app's settings have always been written to.
 *
 * <p>Shared, not per-feature: the account registry, the device ids and the push token are three
 * unrelated keys in the same file, and each of their services opened its own `LazyStore` over it.
 * That is why this module is named for the file rather than for any one of its readers.</p>
 *
 * <p>Exported now that the three readers open it themselves through the injected
 * {@link SettingsStoreFactory}. It is the argument they pass, not a default any adapter applies -
 * the web adapter ignores the file name entirely, so a caller that forgot it would only be caught
 * on the desktop.</p>
 */
export const SETTINGS_FILE = 'settings.json';

/**
 * The four operations the settings readers ask of their store, and nothing else.
 *
 * <p>Narrow on purpose. `LazyStore` satisfies it structurally, so the in-Tauri path stays the same
 * object making the same calls it always made, and the browser implementation only has to be
 * honest about these four rather than about a whole store API.</p>
 *
 * <p>Still declared here rather than in `platform/ports/settings-store.port.ts`, which re-exports it:
 * moving it would break the one property that makes a single interface serve both hosts, since
 * `LazyStore` satisfies this shape by accident of having the same four methods.</p>
 */
export interface SettingsStore {
    get<T>(key: string): Promise<T | undefined>;

    set(key: string, value: unknown): Promise<void>;

    delete(key: string): Promise<boolean>;

    save(): Promise<void>;
}
