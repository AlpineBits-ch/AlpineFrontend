import type {GameCatalogState} from '../../services/game-catalog.service';

/** Unchanged, and re-exported so a caller can depend on this port alone. See `presence.port.ts`. */
export type {GameCatalogState};

/**
 * The detectable-games catalog the process matcher works from.
 *
 * <p><b>Why this is a port of its own and not two more methods on {@link Presence}.</b> The design spec
 * lists `presence.port.ts` without a signature and the surface it was given covers detection and the
 * RPC socket - "what is this machine doing" - while these two commands are a cache-coherency handshake
 * over a 12 MB blob that Rust owns. They also have a different caller (`GameCatalogService`, not
 * `RichPresenceService`) and a different lifetime. Folding them into `Presence` would have meant editing
 * a port contract another track reads, for no gain.</p>
 *
 * <p><b>Desktop-only.</b> The catalog exists to feed a matcher that enumerates processes, so on a host
 * that cannot do that there is nothing to hold it for and nothing would read it - the web adapter
 * reports `supported = false` and the sync never starts. Mobile is excluded for the same reason by its
 * caller, which keeps its own `isMobile` check: downloading 12 MB to feed a matcher that cannot run is
 * worse than not having a catalog.</p>
 *
 * <p>Signature taken from what `GameCatalogService` already invokes: `presence_catalog_state` and
 * `presence_load_catalog`, with the same argument names.</p>
 */
export abstract class PresenceCatalog {
    /** False on web. The caller skips the sync entirely rather than fetching a catalog nobody holds. */
    abstract readonly supported: boolean;

    /** What Rust already has cached, including the ETag to send as `If-None-Match`. */
    abstract state(): Promise<GameCatalogState>;

    /**
     * Hands a freshly fetched catalog to Rust, which parses, indexes and caches it.
     *
     * <p>The ETag goes down with the body it belongs to and never separately: Rust writes it only after
     * the catalog it describes, so a crash between the two cannot leave the client claiming to hold a
     * version it does not have.</p>
     */
    abstract load(json: string, etag: string | null): Promise<GameCatalogState>;
}
