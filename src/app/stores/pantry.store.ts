import {inject} from '@angular/core';
import {Observable, tap} from 'rxjs';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {
    PantryBarcode,
    PantryConfig,
    PantryItem,
    PantryItemCreated,
    PantryItemDeleted,
    PantryItemUpdated,
    ScanPantryItemResult,
} from '../dtos/response/pantry.dto';
import {
    ConsumePantryItemDto,
    CreatePantryItemDto,
    RestockPantryItemDto,
    ScanPantryItemDto,
    UpdatePantryConfigDto,
    UpdatePantryItemDto,
} from '../dtos/request/pantry.dto';
import {PantryApiService} from '../services/pantry-api.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';

interface PantryConfigState {
    configByChannel: Record<string, PantryConfig>;
}

/** Name order, case-insensitive. Not urgency order: urgency is carried by the badge, and grouping is the view's decision. */
function byName(a: PantryItem, b: PantryItem): number {
    return a.name.localeCompare(b.name);
}

/** The expiring view is the one place urgency is the order: soonest first. */
function byExpiry(a: PantryItem, b: PantryItem): number {
    const at = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt || a.name.localeCompare(b.name);
}

/**
 * Pantry stock and per-pantry config, kept fresh by realtime rather than by refetching.
 *
 * Two indexes over one entity map: stock per channel, expiring per guild. `PantryItem` carries no
 * `guildId`, so the expiring index cannot be derived from the row and is set by its own loader.
 */
export const PantryStore = signalStore(
    {providedIn: 'root'},
    withEntities<PantryItem>(),

    withKeyedIndex<PantryItem, 'stock'>({
        collection: 'stock',
        sort: byName,
        fetch: () => {
            const api = inject(PantryApiService);
            return (channelId: string) => api.listItems(channelId);
        },
    }),

    withKeyedIndex<PantryItem, 'expiring', number | null>({
        collection: 'expiring',
        sort: byExpiry,
        fetch: () => {
            const api = inject(PantryApiService);
            return (guildId: string, days?: number | null) => api.expiring(guildId, days);
        },
    }),

    withState<PantryConfigState>({configByChannel: {}}),

    withMethods((store, api = inject(PantryApiService)) => {
        const fetchConfig = (channelId: string): void => {
            // Config failing must not take the stock list down with it.
            api.getConfig(channelId).subscribe({
                next: config => putConfig(config),
                error: () => undefined,
            });
        };

        const putConfig = (config: PantryConfig): void => {
            patchState(store, {
                configByChannel: {...store.configByChannel(), [config.channelId]: config},
            });
        };

        const upsert = (channelId: string, item: PantryItem): void => {
            store.attachToStock(channelId, item);
        };

        return {
            putConfig,

            /** Idempotent per pantry for the session; safe on every open. */
            loadFor(channelId: string): void {
                if (store.stockTracked(channelId)) return;
                store.loadStock(channelId);
                fetchConfig(channelId);
            },

            refresh(channelId: string): void {
                store.loadStock(channelId, {force: true});
                fetchConfig(channelId);
            },

            addItem(channelId: string, dto: CreatePantryItemDto): Observable<PantryItem> {
                return api.createItem(channelId, dto).pipe(tap(item => upsert(channelId, item)));
            },

            updateItem(channelId: string, itemId: string, dto: UpdatePantryItemDto): Observable<PantryItem> {
                return api.updateItem(itemId, dto).pipe(tap(item => upsert(channelId, item)));
            },

            deleteItem(channelId: string, itemId: string): Observable<void> {
                return api.deleteItem(itemId).pipe(
                    tap(() => {
                        store.detachFromStock(channelId, itemId);
                        patchState(store, removeEntity(itemId));
                    }),
                );
            },

            saveConfig(channelId: string, dto: UpdatePantryConfigDto): Observable<PantryConfig> {
                return api.putConfig(channelId, dto).pipe(tap(config => putConfig(config)));
            },

            scan(
                guildId: string,
                channelId: string,
                dto: ScanPantryItemDto,
            ): Observable<ScanPantryItemResult> {
                return api.scan(channelId, dto).pipe(
                    tap(result => {
                        upsert(channelId, result.item);
                        // A scan can carry an expiry, and the expiring view is keyed on the guild.
                        store.invalidateExpiring(guildId);
                    }),
                );
            },

            consume(
                guildId: string,
                channelId: string,
                itemId: string,
                dto: ConsumePantryItemDto,
            ): Observable<PantryItem> {
                return api.consume(itemId, dto).pipe(
                    tap(item => {
                        upsert(channelId, item);
                        store.invalidateExpiring(guildId);
                    }),
                );
            },

            restock(
                guildId: string,
                channelId: string,
                itemId: string,
                dto: RestockPantryItemDto,
            ): Observable<PantryItem> {
                return api.restock(itemId, dto).pipe(
                    tap(item => {
                        upsert(channelId, item);
                        store.invalidateExpiring(guildId);
                    }),
                );
            },

            /** Uncached: it backs a search-as-you-type field and every answer is query-specific. */
            barcodes(guildId: string, query?: string | null): Observable<PantryBarcode[]> {
                return api.barcodes(guildId, query);
            },

            // Created and Updated share a handler: both carry the full item and key by id. It must
            // remember nothing, so `restockedAt` is read off the payload every time.
            applyUpserted(payload: PantryItemCreated | PantryItemUpdated): void {
                store.invalidateExpiring(payload.guildId);

                // Pantries nobody has opened are dropped rather than seeded with a partial list
                // that reports itself as loaded. A row already in the entity map is still patched:
                // it is on screen in the expiring view, which shares that map.
                if (store.stockLoaded(payload.channelId)) {
                    store.attachToStock(payload.channelId, payload.item);
                } else if (payload.item.id in store.entityMap()) {
                    patchState(store, upsertEntity(payload.item));
                }
            },

            applyDeleted(payload: PantryItemDeleted): void {
                store.invalidateExpiring(payload.guildId);
                store.detachFromExpiring(payload.guildId, payload.itemId);
                store.detachFromStock(payload.channelId, payload.itemId);
                patchState(store, removeEntity(payload.itemId));
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.PantryItemCreated').subscribe(e => store.applyUpserted(e));
            realtime.stream('guild.PantryItemUpdated').subscribe(e => store.applyUpserted(e));
            realtime.stream('guild.PantryItemDeleted').subscribe(e => store.applyDeleted(e));
        },
    }),
);
