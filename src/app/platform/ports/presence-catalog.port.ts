import type {GameCatalogState} from '../../services/game-catalog.service';

/** Unchanged, and re-exported so a caller can depend on this port alone. See `presence.port.ts`. */
export type {GameCatalogState};

/**
 * The detectable-games catalog the process matcher works from. Desktop-only.
 *
 * Unlike the rest of the desktop-only ports, `WebPresenceCatalog.state()` rejects rather than
 * answering an honest empty: `{loaded: false, etag: null}` reads as "go and fetch it".
 */
export abstract class PresenceCatalog {
    /** False on web. The caller skips the sync entirely rather than fetching a catalog nobody holds. */
    abstract readonly supported: boolean;

    /** What Rust already has cached, including the ETag to send as `If-None-Match`. */
    abstract state(): Promise<GameCatalogState>;

    /**
     * Hands a freshly fetched catalog to Rust, which parses, indexes and caches it.
     *
     * The ETag must go down with the body it belongs to, never separately.
     */
    abstract load(json: string, etag: string | null): Promise<GameCatalogState>;
}
