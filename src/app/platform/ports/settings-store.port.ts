import type {SettingsStore} from '../../services/settings-store';

/** Re-exported so a caller can depend on this port alone. Still declared in `services/settings-store.ts`. */
export type {SettingsStore};

/**
 * Opens the app's settings file for whichever host this bundle is running in.
 *
 * The file name is the caller's argument, and every settings reader must pass `SETTINGS_FILE`: the
 * web adapter ignores the name, so an invented one is wrong on desktop only.
 */
export abstract class SettingsStoreFactory {
    abstract open(file: string): SettingsStore;
}
