import {computed, inject, Signal} from '@angular/core';
import {map, Observable, tap} from 'rxjs';
import {patchState, signalStore, type, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {
    AssetStatus,
    MaintenanceAsset,
    MaintenanceAssetCreated,
    MaintenanceAssetDeleted,
    MaintenanceAssetUpdated,
    MaintenanceAttentionEntry,
    MaintenanceRecord,
    MaintenanceRecordCreated,
    MaintenanceRecordDeleted,
    MaintenanceRecordPage,
    MaintenanceRecordUpdated,
    normalizeAsset,
    normalizeRecord,
    primaryReason,
    reasonRank,
} from '../dtos/response/maintenance.dto';
import {
    CreateMaintenanceAssetDto,
    CreateMaintenanceRecordDto,
    RecordServiceDto,
    UpdateAssetStatusDto,
    UpdateMaintenanceAssetDto,
    UpdateMaintenanceRecordDto,
} from '../dtos/request/maintenance.dto';
import {MaintenanceApiService, ServiceRecorded} from '../services/maintenance-api.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';

export interface MaintenanceChannelState {
    assets: MaintenanceAsset[];
    /** The service log, newest first. However many pages have been asked for. */
    records: MaintenanceRecord[];
    recordsCursor: string | null;
    loadingMore: boolean;
    loading: boolean;
    loaded: boolean;
    /** A `403` - the house has no Maintenance module. Render nothing, never a denial. */
    forbidden: boolean;
    failed: boolean;
}

const EMPTY_STATE: MaintenanceChannelState = Object.freeze({
    assets: Object.freeze([] as MaintenanceAsset[]) as MaintenanceAsset[],
    records: Object.freeze([] as MaintenanceRecord[]) as MaintenanceRecord[],
    recordsCursor: null,
    loadingMore: false,
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
});

export interface AttentionState {
    entries: MaintenanceAttentionEntry[];
    loading: boolean;
    loaded: boolean;
    forbidden: boolean;
}

const EMPTY_ATTENTION: AttentionState = Object.freeze({
    entries: Object.freeze([] as MaintenanceAttentionEntry[]) as MaintenanceAttentionEntry[],
    loading: false,
    loaded: false,
    forbidden: false,
});

/** A board row, given an id so it can sit in an entity map. It keys on the asset it is about. */
interface AttentionEntry extends MaintenanceAttentionEntry {
    id: string;
}

function toAttentionEntry(entry: MaintenanceAttentionEntry): AttentionEntry {
    return {...entry, id: entry.asset.id};
}

interface MaintenanceScopedState {
    /** Per channel, the `nextCursor` off the log's last page. `null` means the log is complete. */
    recordsCursor: Record<string, string | null>;
    loadingMore: Record<string, boolean>;
}

// `upsertEntities` merges rather than replaces, so a field the server drops to clear it would
// survive on the row it lands on. Naming every optional field is what puts the whole row back.
// The wire clears through `clearPurchasedAt`, `clearWarrantyUntil` and `clearServiceInterval`, and
// a status written with no note clears `statusNote`, so all four can come back absent.
function wholeAsset(raw: MaintenanceAsset): MaintenanceAsset {
    return {
        ...normalizeAsset(raw),
        location: raw.location ?? null,
        brand: raw.brand ?? null,
        model: raw.model ?? null,
        serialNumber: raw.serialNumber ?? null,
        purchasedAt: raw.purchasedAt ?? null,
        warrantyUntil: raw.warrantyUntil ?? null,
        vendorName: raw.vendorName ?? null,
        vendorPhone: raw.vendorPhone ?? null,
        vendorEmail: raw.vendorEmail ?? null,
        notes: raw.notes ?? null,
        serviceIntervalDays: raw.serviceIntervalDays ?? null,
        lastServicedAt: raw.lastServicedAt ?? null,
        nextServiceAt: raw.nextServiceAt ?? null,
        statusNote: raw.statusNote ?? null,
    };
}

/** The same rule as {@link wholeAsset}. The wire clears through `clearCost` and `clearExpense`. */
function wholeRecord(raw: MaintenanceRecord): MaintenanceRecord {
    return {
        ...normalizeRecord(raw),
        assetId: raw.assetId ?? null,
        description: raw.description ?? null,
        vendorName: raw.vendorName ?? null,
        currency: raw.currency ?? null,
        expenseId: raw.expenseId ?? null,
    };
}

function assetUrgency(asset: MaintenanceAsset): number {
    if (asset.status === AssetStatus.Broken) return 0;
    if (asset.isServiceOverdue) return 1;
    if (asset.status === AssetStatus.NeedsAttention) return 2;
    if (asset.isWarrantyExpiring) return 3;
    // Out of service last, below Ok: it is the one state where nothing is expected of anybody.
    return asset.status === AssetStatus.OutOfService ? 5 : 4;
}

/**
 * Assets that need something first, then by name. A catalogue sorted purely alphabetically buries
 * the dead washing machine between the boiler and the dishwasher.
 */
function byUrgency(a: MaintenanceAsset, b: MaintenanceAsset): number {
    return assetUrgency(a) - assetUrgency(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** The log is history, so newest first: the opposite of the asset list, which is a to-do. */
function byNewest(a: MaintenanceRecord, b: MaintenanceRecord): number {
    return b.performedAt.localeCompare(a.performedAt) || b.id.localeCompare(a.id);
}

function byReason(a: AttentionEntry, b: AttentionEntry): number {
    return (
        reasonRank(primaryReason(a.reasons)) - reasonRank(primaryReason(b.reasons)) ||
        a.asset.name.localeCompare(b.asset.name)
    );
}

function sameState(a: MaintenanceChannelState, b: MaintenanceChannelState): boolean {
    return (
        a.assets === b.assets &&
        a.records === b.records &&
        a.recordsCursor === b.recordsCursor &&
        a.loadingMore === b.loadingMore &&
        a.loading === b.loading &&
        a.loaded === b.loaded &&
        a.forbidden === b.forbidden &&
        a.failed === b.failed
    );
}

function sameAttention(a: AttentionState, b: AttentionState): boolean {
    return (
        a.entries === b.entries &&
        a.loading === b.loading &&
        a.loaded === b.loaded &&
        a.forbidden === b.forbidden
    );
}

/**
 * The Maintenance module: what the house owns, what state it is in, and what has been done to it.
 *
 * Two caches at two scopes, and they are not derivable from one another. The per-channel pair is a
 * catalogue and its log; the attention board is guild-wide and spans every upkeep channel the
 * caller can see, so it cannot be assembled by filtering the channels this session has opened.
 *
 * The board is invalidated rather than recomputed on an asset event. Whether an asset needs a human
 * depends on the server's warranty window and overdue cutoff, so an event marks the answer stale and
 * the next open re-reads it.
 */
export const MaintenanceStore = signalStore(
    {providedIn: 'root'},
    withEntities<MaintenanceAsset, 'asset'>({entity: type<MaintenanceAsset>(), collection: 'asset'}),
    withEntities<MaintenanceRecord, 'record'>({entity: type<MaintenanceRecord>(), collection: 'record'}),
    withEntities<AttentionEntry, 'attn'>({entity: type<AttentionEntry>(), collection: 'attn'}),
    withState<MaintenanceScopedState>({recordsCursor: {}, loadingMore: {}}),

    withKeyedIndex<MaintenanceAsset, 'assets', 'asset'>({
        collection: 'assets',
        entities: 'asset',
        sort: byUrgency,
        fetch: () => {
            const api = inject(MaintenanceApiService);
            return (channelId: string) =>
                api.listAssets(channelId).pipe(map(assets => assets.map(wholeAsset)));
        },
    }),

    withKeyedIndex<
        MaintenanceRecord,
        'records',
        'record',
        never,
        MaintenanceRecordPage,
        MaintenanceScopedState
    >({
        collection: 'records',
        entities: 'record',
        sort: byNewest,
        fetch: () => {
            const api = inject(MaintenanceApiService);
            return (channelId: string) => api.listRecords(channelId);
        },
        rows: page => page.items.map(wholeRecord),
        onLoaded: (page, channelId, state) => ({
            recordsCursor: {...state.recordsCursor, [channelId]: page.nextCursor ?? null},
        }),
    }),

    withKeyedIndex<AttentionEntry, 'attention', 'attn'>({
        collection: 'attention',
        entities: 'attn',
        sort: byReason,
        fetch: () => {
            const api = inject(MaintenanceApiService);
            return (guildId: string) =>
                api.attention(guildId).pipe(map(entries => entries.map(toAttentionEntry)));
        },
    }),

    withMethods((store, api = inject(MaintenanceApiService)) => {
        const channelViews = new Map<string, Signal<MaintenanceChannelState>>();
        const boardViews = new Map<string, Signal<AttentionState>>();

        const assetsIn = (channelId: string) => store.assetsFor(channelId)();
        const recordsIn = (channelId: string) => store.recordsFor(channelId)();

        // A write can put a row under a key nobody fetched, which leaves `Tracked` false. Realtime
        // must still reach that channel, so an id list counts as having opened it.
        const opened = (channelId: string): boolean =>
            store.assetsHeld(channelId) || store.recordsHeld(channelId);

        const setLoadingMore = (channelId: string, value: boolean): void => {
            patchState(store, {loadingMore: {...store.loadingMore(), [channelId]: value}});
        };

        const setCursor = (channelId: string, cursor: string | null): void => {
            patchState(store, {recordsCursor: {...store.recordsCursor(), [channelId]: cursor}});
        };

        /**
         * Keeps a loaded board's copy of one asset current. It never adds a row: whether an asset
         * belongs there is the server's judgement, made against cutoffs this client does not carry.
         */
        const patchBoardAsset = (asset: MaintenanceAsset): void => {
            const held = store.attnEntityMap()[asset.id];
            if (!held) return;
            patchState(store, upsertEntity({...held, asset}, {collection: 'attn'}));
        };

        const upsertAsset = (channelId: string, raw: MaintenanceAsset, existingOnly = false): void => {
            const asset = wholeAsset(raw);
            if (!existingOnly || opened(channelId)) store.attachToAssets(channelId, asset);
            patchBoardAsset(asset);
        };

        const upsertRecord = (channelId: string, raw: MaintenanceRecord): void => {
            store.attachToRecords(channelId, wholeRecord(raw));
        };

        const refresh = (channelId: string): void => {
            store.loadAssets(channelId, {force: true});
            store.loadRecords(channelId, {force: true});
        };

        return {
            // ── Reads ────────────────────────────────────────────────────────

            stateFor(channelId: string): Signal<MaintenanceChannelState> {
                const cached = channelViews.get(channelId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const assets = assetsIn(channelId);
                        const records = recordsIn(channelId);
                        const tracked = store.assetsTracked(channelId);
                        if (!tracked && assets.length === 0 && records.length === 0) return EMPTY_STATE;

                        const assetError = store.assetsError(channelId);
                        const recordError = store.recordsError(channelId);
                        const forbidden = assetError === 'forbidden' || recordError === 'forbidden';
                        const loading = store.assetsLoading(channelId) || store.recordsLoading(channelId);

                        return {
                            assets,
                            records,
                            recordsCursor: store.recordsCursor()[channelId] ?? null,
                            loadingMore: store.loadingMore()[channelId] ?? false,
                            loading,
                            loaded: tracked && store.recordsTracked(channelId) && !loading,
                            forbidden,
                            failed: !forbidden && assetError !== null && recordError !== null,
                        };
                    },
                    {equal: sameState},
                );

                channelViews.set(channelId, view);
                return view;
            },

            attentionStateFor(guildId: string): Signal<AttentionState> {
                const cached = boardViews.get(guildId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const entries = store.attentionFor(guildId)();
                        if (!store.attentionTracked(guildId) && entries.length === 0) {
                            return EMPTY_ATTENTION;
                        }
                        return {
                            entries,
                            loading: store.attentionLoading(guildId),
                            loaded: store.attentionLoaded(guildId),
                            forbidden: store.attentionError(guildId) === 'forbidden',
                        };
                    },
                    {equal: sameAttention},
                );

                boardViews.set(guildId, view);
                return view;
            },

            // ── Loading ──────────────────────────────────────────────────────

            /** Idempotent per channel for the session; safe on every open. */
            loadFor(channelId: string): void {
                if (store.assetsTracked(channelId)) return;
                refresh(channelId);
            },

            refresh,

            loadMoreRecords(channelId: string): void {
                const cursor = store.recordsCursor()[channelId] ?? null;
                if (
                    !cursor ||
                    store.loadingMore()[channelId] ||
                    store.assetsLoading(channelId) ||
                    store.recordsLoading(channelId)
                ) {
                    return;
                }

                setLoadingMore(channelId, true);
                api.listRecords(channelId, {cursor}).subscribe({
                    next: page => {
                        setLoadingMore(channelId, false);
                        // A refresh that landed while this was in the air threw away everything the
                        // page sits behind; appending it would leave a hole in the middle of the log.
                        if ((store.recordsCursor()[channelId] ?? null) !== cursor) return;

                        const held = new Set(recordsIn(channelId).map(r => r.id));
                        for (const raw of page.items) {
                            if (!held.has(raw.id)) upsertRecord(channelId, raw);
                        }
                        setCursor(channelId, page.nextCursor ?? null);
                    },
                    error: () => setLoadingMore(channelId, false),
                });
            },

            // ── Writes ───────────────────────────────────────────────────────

            addAsset(
                guildId: string,
                channelId: string,
                body: CreateMaintenanceAssetDto,
            ): Observable<MaintenanceAsset> {
                return api.createAsset(channelId, body).pipe(
                    tap(asset => {
                        upsertAsset(channelId, asset);
                        store.invalidateAttention(guildId);
                    }),
                );
            },

            editAsset(
                guildId: string,
                channelId: string,
                assetId: string,
                body: UpdateMaintenanceAssetDto,
            ): Observable<MaintenanceAsset> {
                return api.updateAsset(assetId, body).pipe(
                    tap(asset => {
                        upsertAsset(channelId, asset);
                        store.invalidateAttention(guildId);
                    }),
                );
            },

            removeAsset(guildId: string, channelId: string, assetId: string): Observable<void> {
                return api.deleteAsset(assetId).pipe(
                    tap(() => {
                        store.detachFromAssets(channelId, assetId);
                        patchState(store, removeEntity(assetId, {collection: 'asset'}));
                        store.invalidateAttention(guildId);
                    }),
                );
            },

            setStatus(
                guildId: string,
                channelId: string,
                assetId: string,
                status: AssetStatus,
                note?: string,
            ): Observable<MaintenanceAsset> {
                const body: UpdateAssetStatusDto = note ? {status, note} : {status};
                return api.setStatus(assetId, body).pipe(
                    tap(asset => {
                        upsertAsset(channelId, asset);
                        store.invalidateAttention(guildId);
                    }),
                );
            },

            recordService(
                guildId: string,
                channelId: string,
                assetId: string,
                body: RecordServiceDto = {},
            ): Observable<ServiceRecorded> {
                return api.recordService(assetId, body).pipe(
                    tap(result => {
                        upsertAsset(channelId, result.asset);
                        upsertRecord(channelId, result.record);
                        store.invalidateAttention(guildId);
                    }),
                );
            },

            addRecord(channelId: string, body: CreateMaintenanceRecordDto): Observable<MaintenanceRecord> {
                return api.createRecord(channelId, body).pipe(tap(record => upsertRecord(channelId, record)));
            },

            editRecord(
                channelId: string,
                recordId: string,
                body: UpdateMaintenanceRecordDto,
            ): Observable<MaintenanceRecord> {
                return api.updateRecord(recordId, body).pipe(tap(record => upsertRecord(channelId, record)));
            },

            removeRecord(channelId: string, recordId: string): Observable<void> {
                return api.deleteRecord(recordId).pipe(
                    tap(() => {
                        store.detachFromRecords(channelId, recordId);
                        patchState(store, removeEntity(recordId, {collection: 'record'}));
                    }),
                );
            },

            // ── Realtime ─────────────────────────────────────────────────────

            applyAssetUpserted(event: MaintenanceAssetCreated | MaintenanceAssetUpdated): void {
                store.invalidateAttention(event.guildId);
                upsertAsset(event.channelId, event.asset, true);
            },

            applyAssetDeleted(event: MaintenanceAssetDeleted): void {
                store.invalidateAttention(event.guildId);
                if (opened(event.channelId)) {
                    store.detachFromAssets(event.channelId, event.assetId);
                    patchState(store, removeEntity(event.assetId, {collection: 'asset'}));
                }
                // Records keep their `assetId` server-side or lose it; either way the log entries
                // stay, because what was done to a machine outlives the catalogue row.
                store.detachFromAttention(event.guildId, event.assetId);
                patchState(store, removeEntity(event.assetId, {collection: 'attn'}));
            },

            applyRecordUpserted(event: MaintenanceRecordCreated | MaintenanceRecordUpdated): void {
                if (!opened(event.channelId)) return;
                upsertRecord(event.channelId, event.record);
            },

            applyRecordDeleted(event: MaintenanceRecordDeleted): void {
                if (!opened(event.channelId)) return;
                store.detachFromRecords(event.channelId, event.recordId);
                patchState(store, removeEntity(event.recordId, {collection: 'record'}));
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.MaintenanceAssetCreated').subscribe(e => store.applyAssetUpserted(e));
            realtime.stream('guild.MaintenanceAssetUpdated').subscribe(e => store.applyAssetUpserted(e));
            realtime.stream('guild.MaintenanceAssetDeleted').subscribe(e => store.applyAssetDeleted(e));
            realtime.stream('guild.MaintenanceRecordCreated').subscribe(e => store.applyRecordUpserted(e));
            realtime.stream('guild.MaintenanceRecordUpdated').subscribe(e => store.applyRecordUpserted(e));
            realtime.stream('guild.MaintenanceRecordDeleted').subscribe(e => store.applyRecordDeleted(e));
        },
    }),
);
