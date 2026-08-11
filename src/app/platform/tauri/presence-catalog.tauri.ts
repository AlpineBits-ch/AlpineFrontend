import {GameCatalogState, PresenceCatalog} from '../ports/presence-catalog.port';

/** The `presence_catalog_state` / `presence_load_catalog` pair, argument names unchanged. */
export class TauriPresenceCatalog extends PresenceCatalog {
    readonly supported = true;

    async state(): Promise<GameCatalogState> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<GameCatalogState>('presence_catalog_state');
    }

    async load(json: string, etag: string | null): Promise<GameCatalogState> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<GameCatalogState>('presence_load_catalog', {json, etag});
    }
}
