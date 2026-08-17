import {GameCatalogState, PresenceCatalog} from '../ports/presence-catalog.port';

/**
 * No matcher, so no catalog.
 *
 * <p>Both methods reject rather than answering with an empty state. `state()` returning
 * `{loaded: false, etag: null, …}` would be read as "nothing cached yet, go and fetch it", which would
 * put a 12 MB conditional request on every web session forever - for a blob whose only consumer does
 * not exist on this host. And `load()` resolving would claim Rust had indexed a catalog it never saw,
 * which is the failure the design spec calls "a feature that silently does nothing".</p>
 *
 * <p>Callers check {@link supported} and skip the sync, so neither of these should be reached.</p>
 */
export class WebPresenceCatalog extends PresenceCatalog {
    readonly supported = false;

    state(): Promise<GameCatalogState> {
        return unsupported('state');
    }

    load(_json: string, _etag: string | null): Promise<GameCatalogState> {
        return unsupported('load');
    }
}

function unsupported(operation: string): Promise<never> {
    return Promise.reject(new Error(
        `PresenceCatalog.${operation}() is desktop-only; there is no process matcher to feed. ` +
        'Gate on PresenceCatalog.supported or PlatformCapabilities.gameDetection.',
    ));
}
