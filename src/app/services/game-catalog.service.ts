import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {PresenceCatalog} from '../platform/ports/presence-catalog.port';
import {ApiConfigService} from './api-config.service';
import {OsInfo} from '../platform/ports/os-info.port';

/** The Rust side's view of the catalog, mirroring `presence::CatalogState`. Rust owns the on-disk cache and the ETag; this service is only a courier. */
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
        /** Entries discarded for carrying no application id. Not a parse failure: such a game could never have been reported anyway. */
        droppedWithoutApplicationId: number;
    };
}

/**
 * Fetches the detectable-games catalog and hands it to the Rust matcher: Angular authenticates and transports, Rust parses and matches.
 * The `social` segment is load-bearing. The gateway rewrites `/api/v1/social/{**catch-all}` to `/api/v1/{**catch-all}`, so the internal path 404s through the gateway while passing every in-process test.
 * Failure is quiet and total: no catalog means no process detection, and the legacy CSV matcher in `scan_game_process` is the fallback.
 */
@Injectable({providedIn: 'root'})
export class GameCatalogService {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly os = inject(OsInfo);
    private readonly catalog = inject(PresenceCatalog);

    private readonly _state = signal<GameCatalogState | null>(null);
    /** What the matcher is working from, for diagnostics. Null until the first sync completes. */
    readonly state = this._state.asReadonly();

    private syncing = false;
    /** One warning per session, not one per attempt. */
    private warned = false;

    /** Brings the local catalog up to date. Safe to call repeatedly; concurrent calls collapse. A 304 arrives as an `HttpErrorResponse`. */
    async sync(): Promise<void> {
        // Two questions, not one: a host with no matcher cannot hold the catalog, and a Tauri phone
        // build reports `supported === true` while still being unable to enumerate a process.
        if (!this.catalog.supported || this.os.isMobile || this.syncing) return;
        this.syncing = true;

        try {
            const state = await this.catalog.state();
            this._state.set(state);

            const headers = state.etag
                ? new HttpHeaders({'If-None-Match': state.etag})
                : undefined;

            const response = await firstValueFrom(this.http.get(
                `${this.apiConfig.baseUrl()}/api/v1/social/games/catalog`,
                {params: {os: state.os}, headers, observe: 'response', responseType: 'text'},
            ));

            if (response.status !== 200 || !response.body) return;

            // The ETag goes down with the body it belongs to, never separately: Rust writes it after
            // the catalog it describes, so a crash between the two cannot claim a version we lack.
            this._state.set(await this.catalog.load(response.body, response.headers.get('ETag')));
        } catch (err) {
            // Unchanged since last time, which is the whole point of sending the ETag.
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
