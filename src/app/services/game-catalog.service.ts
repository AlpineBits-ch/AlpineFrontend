import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {firstValueFrom} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {PlatformService} from './platform.service';

/**
 * The Rust side's view of the catalog. Mirror of `presence::CatalogState`.
 *
 * <p>Rust owns the on-disk cache and the ETag, so this service is only ever a courier: ask what we
 * already have, make one conditional request, hand back the body if it changed. Keeping the cache
 * on that side means the matcher can start on a cached catalog before the webview has even
 * rendered, and means there is exactly one copy rather than one per storage API.</p>
 */
export interface GameCatalogState {
    loaded: boolean;
    version: string | null;
    /** Sent back as `If-None-Match`. */
    etag: string | null;
    /** `win32` | `darwin` | `linux`, decided by Rust so the mapping is not duplicated here. */
    os: string;
    stats: {
        games: number;
        rules: number;
        /**
         * Entries discarded because they carry no application id. Not a parse failure — the server
         * drops an activity whose name is not vouched for by a resolvable id, so an entry without
         * one is a game we could never have reported.
         */
        droppedWithoutApplicationId: number;
    };
}

/**
 * Fetches the detectable-games catalog and hands it to the Rust matcher.
 *
 * <p><b>Why this lives in Angular at all.</b> `GET /api/v1/social/games/catalog` is `[Authorize]`,
 * and the bearer token lives in this layer's interceptor stack — Rust has no session and cannot
 * fetch it. So the split is: Angular authenticates and transports, Rust parses, caches, indexes and
 * matches. Nothing about the catalog's content is interpreted here.</p>
 *
 * <p>Note the `social` segment in the path. The gateway rewrites `/api/v1/social/{**catch-all}` →
 * `/api/v1/{**catch-all}`, so the route declared inside the service is one segment shorter than the
 * public one; calling the internal path 404s through the gateway while passing every in-process
 * test. There is a scarred comment about exactly this in `ProxyConfig.cs`.</p>
 *
 * <p><b>Failure is quiet and total.</b> No catalog means no process detection — not an error state,
 * and not something to warn about on every retry. A client that has never reached the server falls
 * back to the legacy CSV matcher in `scan_game_process`, which is why that path still exists.</p>
 */
@Injectable({providedIn: 'root'})
export class GameCatalogService {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly platform = inject(PlatformService);

    private readonly _state = signal<GameCatalogState | null>(null);
    /** What the matcher is working from, for diagnostics. Null until the first sync completes. */
    readonly state = this._state.asReadonly();

    private syncing = false;
    /** One warning per session, not one per attempt. */
    private warned = false;

    /**
     * Brings the local catalog up to date. Safe to call repeatedly; concurrent calls collapse.
     *
     * <p>The 304 path is the common one and costs a request with no body. It is delivered as an
     * `HttpErrorResponse` because Angular treats every non-2xx that way, which is the one piece of
     * genuine awkwardness here.</p>
     */
    async sync(): Promise<void> {
        if (!isTauri() || this.platform.isMobile || this.syncing) return;
        this.syncing = true;

        try {
            const state = await invoke<GameCatalogState>('presence_catalog_state');
            this._state.set(state);

            const headers = state.etag
                ? new HttpHeaders({'If-None-Match': state.etag})
                : undefined;

            const response = await firstValueFrom(this.http.get(
                `${this.apiConfig.baseUrl()}/api/v1/social/games/catalog`,
                {params: {os: state.os}, headers, observe: 'response', responseType: 'text'},
            ));

            if (response.status !== 200 || !response.body) return;

            // The ETag goes down with the body it belongs to, never separately: Rust writes it only
            // after the catalog it describes, so a crash between the two cannot leave us claiming
            // to hold a version we do not have.
            this._state.set(await invoke<GameCatalogState>('presence_load_catalog', {
                json: response.body,
                etag: response.headers.get('ETag'),
            }));
        } catch (err) {
            // Unchanged since last time — the whole point of sending the ETag.
            if (err instanceof HttpErrorResponse && err.status === 304) return;
            if (!this.warned) {
                this.warned = true;
                console.warn('[GameCatalog] could not sync the game catalog; detection stays on the legacy list', err);
            }
        } finally {
            this.syncing = false;
        }
    }
}
