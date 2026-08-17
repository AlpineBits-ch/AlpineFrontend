import {GameCatalogState, PresenceCatalog} from '../ports/presence-catalog.port';

/** An empty cache on Windows, which is the state a first-ever sync starts from. */
export function emptyCatalogState(overrides: Partial<GameCatalogState> = {}): GameCatalogState {
    return {
        loaded: false,
        version: null,
        etag: null,
        os: 'win32',
        stats: {games: 0, rules: 0, droppedWithoutApplicationId: 0},
        ...overrides,
    };
}

/**
 * A {@link PresenceCatalog} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/api/core')` in `game-catalog.service.spec.ts`, which carried a
 * note that several spec files mock that module and only one registration wins per run - so its values
 * had to be reset per test. This has no such problem.</p>
 *
 * <p>{@link stateCalls} exists because "was Rust reached at all" is the assertion the host guard needs:
 * the web adapter <i>rejects</i>, so a missing guard surfaces as a rejected promise rather than as a
 * quiet no-op, and asserting only on the absence of an HTTP request would miss it.</p>
 */
export class FakePresenceCatalog extends PresenceCatalog {
    supported = true;

    /** What Rust claims to already hold, ETag included. */
    cached: GameCatalogState = emptyCatalogState();

    /** What Rust reports after being handed a catalog. */
    afterLoad: GameCatalogState = emptyCatalogState({loaded: true});

    /** Every `(json, etag)` pair handed over, in order. */
    readonly loads: {json: string; etag: string | null}[] = [];

    stateCalls = 0;

    async state(): Promise<GameCatalogState> {
        this.stateCalls++;
        return this.cached;
    }

    async load(json: string, etag: string | null): Promise<GameCatalogState> {
        this.loads.push({json, etag});
        return this.afterLoad;
    }
}
