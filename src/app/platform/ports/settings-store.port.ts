import type {SettingsStore} from '../../services/settings-store';

/**
 * Re-exported so a migrated caller can depend on this port alone and never reach back into
 * `services/settings-store.ts`. The interface itself is unchanged and still declared there - it is
 * the narrow four-method shape `LazyStore` satisfies structurally, and widening or moving it would
 * break exactly the property that makes one implementation serve both hosts.
 */
export type {SettingsStore};

/**
 * Opens the app's settings file for whichever host this bundle is running in.
 *
 * <p>Replaces the free function `openSettingsStore()`, which had to decide the host itself. Same
 * per-call lifetime: `LazyStore` is lazy by construction, so an unused one costs nothing, and
 * holding that lifetime identical is what keeps the desktop path unobservably the same.</p>
 */
export abstract class SettingsStoreFactory {
    abstract open(file: string): SettingsStore;
}
