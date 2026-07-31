/**
 * Install an in-memory `localStorage` for the duration of a spec.
 *
 * The unit-test environment exposes a `localStorage` global that is only a stub - `clear` and
 * `removeItem` are missing, so anything persisting settings cannot be tested against it. Services
 * wrap their storage access in try/catch, which means a broken stub fails silently as "always
 * defaults" rather than as an error, so the substitution has to be explicit.
 *
 * Call in `beforeEach`; the returned function restores the original global.
 */
export function installMemoryStorage(): () => void {
    const store = new Map<string, string>();
    const memory: Storage = {
        get length() {
            return store.size;
        },
        clear: () => store.clear(),
        getItem: (key: string) => store.get(key) ?? null,
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        removeItem: (key: string) => void store.delete(key),
        setItem: (key: string, value: string) => void store.set(key, String(value)),
    };

    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {value: memory, configurable: true, writable: true});

    return () => {
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
        else delete (globalThis as {localStorage?: Storage}).localStorage;
    };
}
