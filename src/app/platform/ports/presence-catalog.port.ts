import type {GameCatalogState} from '../../services/game-catalog.service';

/** Unchanged, and re-exported so a caller can depend on this port alone. See `presence.port.ts`. */
export type {GameCatalogState};

/**
 * The detectable-games catalog the process matcher works from.
 *
 * <p><b>Why this is a port of its own and not two more methods on {@link Presence}, revisited and
 * kept.</b> The original reason was partly transitional - folding them in would have meant editing a
 * contract another track was reading - and that reason has expired. Two durable ones have not:</p>
 * <ul>
 *   <li><b>The two web adapters answer a read in opposite ways, on purpose.</b> `WebPresence` follows
 *       the desktop-only rule: reads return the honest "nothing here" value (`current()` resolves
 *       `[]`) and only writes reject. `WebPresenceCatalog.state()` is the documented exception - it
 *       <i>rejects</i>, because `{loaded: false, etag: null}` would be read as "nothing cached yet, go
 *       and fetch it" and put a 12 MB conditional request on every web session forever. Merged, one
 *       class would hold both the rule and its exception, and the next person to add a method would
 *       have no way to tell which one they were following.</li>
 *   <li><b>The contracts have different shapes.</b> `Presence` is a lifecycle: `onChanged` hands back
 *       an unsubscribe, and `rpcStart`/`rpcStop` own a machine-wide socket whose state outlives any
 *       call. These two are idempotent request/response with nothing to tear down. One port means one
 *       fake, and `FakePresence` would grow catalog fields that no presence test touches while
 *       `FakePresenceCatalog`'s `stateCalls` counter - the thing that makes "was Rust reached at all"
 *       assertable - would be buried in it.</li>
 * </ul>
 *
 * <p>Being desktop-only is <i>not</i> a reason to merge them. Grouping ports by which host supports
 * them is grouping by the thing this layer exists to stop callers asking about; `Autostart`, `Updater`
 * and `WindowChrome` are all desktop-only too and nobody proposes one port for those.</p>
 *
 * <p>The cost accepted in exchange is a second `supported` flag that can never disagree with
 * `Presence.supported`. Both callers pair it with `!OsInfo.isMobile` anyway - a Tauri phone reports
 * `supported: true` and still cannot enumerate a process - so neither flag is the whole gate on its
 * own, and `PlatformCapabilities.gameDetection` is the answer for anything that wants one question.</p>
 *
 * <p><b>Desktop-only.</b> The catalog exists to feed a matcher that enumerates processes, so on a host
 * that cannot do that there is nothing to hold it for and nothing would read it - the web adapter
 * reports `supported = false` and the sync never starts. Mobile is excluded for the same reason by its
 * caller, which keeps its own `OsInfo.isMobile` check: downloading 12 MB to feed a matcher that cannot
 * run is worse than not having a catalog.</p>
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
