import {SettingsStore, SettingsStoreFactory} from '../ports/settings-store.port';

/**
 * An in-memory {@link SettingsStoreFactory} for specs.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/plugin-store')` stub that five specs hoist - one per file, each a
 * slightly different hand-rolled `LazyStore` - and the reason to prefer this over those is not tidiness:
 * a module mock is registered per module, so several spec files mocking `plugin-store` fight over one
 * registration per run, and the warnings the suite prints about hoisting are exactly that. A factory in
 * `providers` is scoped to its own TestBed and invisible to every other file.</p>
 *
 * <p><b>One backing map per file name, shared across `open` calls</b>, matching the desktop adapter: a
 * `LazyStore` opened twice over `settings.json` is two handles on one file, and the settings readers rely
 * on that - the account registry, the device ids and the push token are three unrelated keys in the same
 * file, each opened by its own service. The web adapter collapses every file into one `localStorage`
 * namespace, which this deliberately does not model; a spec that cares about that lives with the adapter.</p>
 */
export class FakeSettingsStoreFactory extends SettingsStoreFactory {
    /** File name -> its entries. Public so a spec can seed or inspect a file directly. */
    readonly files = new Map<string, Map<string, unknown>>();

    /** Every file name opened, in order, including repeats. */
    readonly opened: string[] = [];

    open(file: string): SettingsStore {
        this.opened.push(file);
        return new FakeSettingsStore(this.entriesFor(file));
    }

    /** Seeds a key without going through the store, for arranging state a spec starts from. */
    put(file: string, key: string, value: unknown): this {
        this.entriesFor(file).set(key, value);
        return this;
    }

    /** Reads a key without going through the store. */
    peek<T>(file: string, key: string): T | undefined {
        return this.files.get(file)?.get(key) as T | undefined;
    }

    /** Forgets every file - the fresh-installation state, not a `clear()` on each store. */
    reset(): void {
        this.files.clear();
        this.opened.length = 0;
    }

    private entriesFor(file: string): Map<string, unknown> {
        let values = this.files.get(file);
        if (!values) {
            values = new Map<string, unknown>();
            this.files.set(file, values);
        }
        return values;
    }
}

/**
 * The four methods the settings readers ask for, over a map.
 *
 * <p>`save()` counts rather than doing anything, because there is nothing buffered here - but *whether it
 * was called* is worth keeping: on the desktop backend an unsaved write is lost on exit, so a writer that
 * never saves is a setting that survives until the app closes and then does not.</p>
 */
class FakeSettingsStore implements SettingsStore {
    saves = 0;

    constructor(private readonly values: Map<string, unknown>) { }

    async get<T>(key: string): Promise<T | undefined> {
        return this.values.get(key) as T | undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }

    async delete(key: string): Promise<boolean> {
        return this.values.delete(key);
    }

    async save(): Promise<void> {
        this.saves++;
    }
}
