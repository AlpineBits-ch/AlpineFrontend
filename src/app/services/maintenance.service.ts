import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {forkJoin, Observable, of, tap} from 'rxjs';
import {catchError} from 'rxjs/operators';
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
import {MaintenanceApiService, ServiceRecorded} from './maintenance-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';

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

const EMPTY_STATE: MaintenanceChannelState = {
    assets: [],
    records: [],
    recordsCursor: null,
    loadingMore: false,
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
};

export interface AttentionState {
    entries: MaintenanceAttentionEntry[];
    loading: boolean;
    loaded: boolean;
    forbidden: boolean;
}

const EMPTY_ATTENTION: AttentionState = {
    entries: [],
    loading: false,
    loaded: false,
    forbidden: false,
};

/**
 * The Maintenance module: what the house owns, what state it is in, and what has been done to it.
 *
 * <p>Two caches, at two scopes, and they are not derivable from one another. The per-channel one is
 * a catalogue; {@link attentionFor} is guild-wide and spans every upkeep channel the caller can see,
 * so it cannot be assembled by filtering the channels this session happens to have opened.</p>
 *
 * <p>The attention board is invalidated rather than recomputed on every asset event. Whether an
 * asset needs a human depends on the server's warranty window and overdue cutoff, and a client that
 * re-derived those would drift from the board the moment either changed - so an event marks the
 * answer stale and the next open re-reads it.</p>
 */
@Injectable({providedIn: 'root'})
export class MaintenanceService {
    private api = inject(MaintenanceApiService);
    private realtime = inject(RealtimeConnectionService);

    private readonly states = signal<Record<string, MaintenanceChannelState>>({});
    private readonly attention = signal<Record<string, AttentionState>>({});

    private readonly requested = new Set<string>();
    /** Guilds whose attention answer is known to be out of date. See the class doc. */
    private readonly attentionStale = new Set<string>();

    constructor() {
        // Registered once, here, in a root singleton - `RealtimeConnectionService.on` does not
        // deduplicate.
        this.realtime.on('guild.MaintenanceAssetCreated', (d: MaintenanceAssetCreated) =>
            this.onAssetUpserted(d),
        );
        this.realtime.on('guild.MaintenanceAssetUpdated', (d: MaintenanceAssetUpdated) =>
            this.onAssetUpserted(d),
        );
        this.realtime.on('guild.MaintenanceAssetDeleted', (d: MaintenanceAssetDeleted) =>
            this.onAssetDeleted(d),
        );
        this.realtime.on('guild.MaintenanceRecordCreated', (d: MaintenanceRecordCreated) =>
            this.onRecordUpserted(d),
        );
        this.realtime.on('guild.MaintenanceRecordUpdated', (d: MaintenanceRecordUpdated) =>
            this.onRecordUpserted(d),
        );
        this.realtime.on('guild.MaintenanceRecordDeleted', (d: MaintenanceRecordDeleted) =>
            this.onRecordDeleted(d),
        );
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): MaintenanceChannelState {
        return this.states()[channelId] ?? EMPTY_STATE;
    }

    attentionFor(guildId: string): AttentionState {
        return this.attention()[guildId] ?? EMPTY_ATTENTION;
    }

    assetById(channelId: string, assetId: string): MaintenanceAsset | null {
        return this.stateFor(channelId).assets.find(a => a.id === assetId) ?? null;
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        if (this.requested.has(channelId)) return;
        this.requested.add(channelId);
        this.refresh(channelId);
    }

    refresh(channelId: string): void {
        this.patch(channelId, state => ({...state, loading: true, failed: false}));

        forkJoin({
            // Folded to null rather than allowed to collapse the pair: the catalogue is the useful
            // half and must survive a log that 500s, and the reverse for a channel logging repairs
            // against nothing catalogued.
            assets: this.api
                .listAssets(channelId)
                .pipe(catchError((err: unknown) => this.swallow<MaintenanceAsset[]>(channelId, err))),
            records: this.api
                .listRecords(channelId)
                .pipe(
                    catchError((err: unknown) =>
                        this.swallow<{items: MaintenanceRecord[]; nextCursor: string | null}>(channelId, err),
                    ),
                ),
        }).subscribe(({assets, records}) => {
            this.patch(channelId, state => ({
                ...state,
                assets: this.sortedAssets((assets ?? []).map(normalizeAsset)),
                records: this.sortedRecords((records?.items ?? []).map(normalizeRecord)),
                recordsCursor: records?.nextCursor ?? null,
                loading: false,
                loaded: true,
                failed: !state.forbidden && assets === null && records === null,
            }));
        });
    }

    loadMoreRecords(channelId: string): void {
        const state = this.stateFor(channelId);
        if (!state.recordsCursor || state.loadingMore || state.loading) return;

        const cursor = state.recordsCursor;
        this.patch(channelId, current => ({...current, loadingMore: true}));

        this.api.listRecords(channelId, {cursor}).subscribe({
            next: page =>
                this.patch(channelId, current => {
                    // A refresh that landed while this was in the air threw away everything the page
                    // sits behind; appending it would leave a hole in the middle of the log.
                    if (current.recordsCursor !== cursor) return {...current, loadingMore: false};
                    const held = new Set(current.records.map(r => r.id));
                    return {
                        ...current,
                        records: this.sortedRecords([
                            ...current.records,
                            ...page.items.filter(r => !held.has(r.id)).map(normalizeRecord),
                        ]),
                        recordsCursor: page.nextCursor ?? null,
                        loadingMore: false,
                    };
                }),
            error: () => this.patch(channelId, current => ({...current, loadingMore: false})),
        });
    }

    /**
     * The guild-wide attention board.
     *
     * <p>Served from cache unless it was marked stale or `force` is set: it is opened and closed
     * repeatedly while somebody works their way down it, and a refetch per open would spend a
     * request on an answer that has not moved.</p>
     */
    loadAttention(guildId: string, force = false): void {
        const state = this.attentionFor(guildId);
        if (state.loading) return;
        if (!force && state.loaded && !this.attentionStale.has(guildId)) return;

        this.patchAttention(guildId, current => ({...current, loading: true}));

        this.api.attention(guildId).subscribe({
            next: entries => {
                this.attentionStale.delete(guildId);
                this.patchAttention(guildId, current => ({
                    ...current,
                    entries: this.sortedAttention(entries),
                    loading: false,
                    loaded: true,
                    forbidden: false,
                }));
            },
            error: err =>
                this.patchAttention(guildId, current => ({
                    ...current,
                    loading: false,
                    forbidden: err instanceof HttpErrorResponse && err.status === 403,
                })),
        });
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addAsset(
        guildId: string,
        channelId: string,
        body: CreateMaintenanceAssetDto,
    ): Observable<MaintenanceAsset> {
        return this.api.createAsset(channelId, body).pipe(
            tap(asset => {
                this.upsertAsset(channelId, asset);
                this.attentionStale.add(guildId);
            }),
        );
    }

    editAsset(
        guildId: string,
        channelId: string,
        assetId: string,
        body: UpdateMaintenanceAssetDto,
    ): Observable<MaintenanceAsset> {
        return this.api.updateAsset(assetId, body).pipe(
            tap(asset => {
                this.upsertAsset(channelId, asset);
                this.attentionStale.add(guildId);
            }),
        );
    }

    removeAsset(guildId: string, channelId: string, assetId: string): Observable<void> {
        return this.api.deleteAsset(assetId).pipe(
            tap(() => {
                this.dropAsset(channelId, assetId);
                this.attentionStale.add(guildId);
            }),
        );
    }

    /**
     * The one-tap status write - and the reason it takes only `LogMaintenance`.
     *
     * <p>Callers put this wherever the asset appears, including surfaces that hold nothing else
     * about it, which is why it takes ids rather than the row.</p>
     */
    setStatus(
        guildId: string,
        channelId: string,
        assetId: string,
        status: AssetStatus,
        note?: string,
    ): Observable<MaintenanceAsset> {
        const body: UpdateAssetStatusDto = note ? {status, note} : {status};
        return this.api.setStatus(assetId, body).pipe(
            tap(asset => {
                this.upsertAsset(channelId, asset);
                this.attentionStale.add(guildId);
            }),
        );
    }

    /**
     * Records a service.
     *
     * <p>It writes a log line and moves the next due date, and it deliberately does <b>not</b> clear
     * a `Broken` status - so a caller must not report it as a repair. Both halves of the answer are
     * applied: the asset's schedule has moved and the log has a new line.</p>
     */
    recordService(
        guildId: string,
        channelId: string,
        assetId: string,
        body: RecordServiceDto = {},
    ): Observable<ServiceRecorded> {
        return this.api.recordService(assetId, body).pipe(
            tap(result => {
                this.upsertAsset(channelId, result.asset);
                this.upsertRecord(channelId, result.record);
                this.attentionStale.add(guildId);
            }),
        );
    }

    addRecord(channelId: string, body: CreateMaintenanceRecordDto): Observable<MaintenanceRecord> {
        return this.api
            .createRecord(channelId, body)
            .pipe(tap(record => this.upsertRecord(channelId, record)));
    }

    editRecord(
        channelId: string,
        recordId: string,
        body: UpdateMaintenanceRecordDto,
    ): Observable<MaintenanceRecord> {
        return this.api
            .updateRecord(recordId, body)
            .pipe(tap(record => this.upsertRecord(channelId, record)));
    }

    removeRecord(channelId: string, recordId: string): Observable<void> {
        return this.api.deleteRecord(recordId).pipe(
            tap(() =>
                this.patchExisting(channelId, state => ({
                    ...state,
                    records: state.records.filter(r => r.id !== recordId),
                })),
            ),
        );
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    private onAssetUpserted(event: MaintenanceAssetCreated | MaintenanceAssetUpdated): void {
        this.attentionStale.add(event.guildId);
        this.upsertAsset(event.channelId, event.asset, true);
    }

    private onAssetDeleted(event: MaintenanceAssetDeleted): void {
        this.attentionStale.add(event.guildId);
        this.patchExisting(event.channelId, state => ({
            ...state,
            assets: state.assets.filter(a => a.id !== event.assetId),
            // Records keep their `assetId` server-side or lose it; either way the log entries stay,
            // because what was done to a machine is history that outlives the catalogue row.
        }));
        this.patchAttention(event.guildId, current => ({
            ...current,
            entries: current.entries.filter(e => e.asset.id !== event.assetId),
        }));
    }

    private onRecordUpserted(event: MaintenanceRecordCreated | MaintenanceRecordUpdated): void {
        this.upsertRecord(event.channelId, event.record, true);
    }

    private onRecordDeleted(event: MaintenanceRecordDeleted): void {
        this.patchExisting(event.channelId, state => ({
            ...state,
            records: state.records.filter(r => r.id !== event.recordId),
        }));
    }

    // ── State plumbing ───────────────────────────────────────────────────────

    private upsertAsset(channelId: string, raw: MaintenanceAsset, existingOnly = false): void {
        const asset = normalizeAsset(raw);
        const apply = (state: MaintenanceChannelState): MaintenanceChannelState => ({
            ...state,
            assets: this.sortedAssets([...state.assets.filter(a => a.id !== asset.id), asset]),
        });
        if (existingOnly) this.patchExisting(channelId, apply);
        else this.patch(channelId, apply);

        // The attention board holds its own copy of the asset, and a status change is precisely
        // what somebody looking at that board is waiting to see disappear off it.
        this.patchAttentionAsset(asset);
    }

    private dropAsset(channelId: string, assetId: string): void {
        this.patch(channelId, state => ({
            ...state,
            assets: state.assets.filter(a => a.id !== assetId),
        }));
    }

    private upsertRecord(channelId: string, raw: MaintenanceRecord, existingOnly = false): void {
        const record = normalizeRecord(raw);
        const apply = (state: MaintenanceChannelState): MaintenanceChannelState => ({
            ...state,
            records: this.sortedRecords([...state.records.filter(r => r.id !== record.id), record]),
        });
        if (existingOnly) this.patchExisting(channelId, apply);
        else this.patch(channelId, apply);
    }

    /**
     * Keeps a loaded attention board's copy of one asset current.
     *
     * <p>Only replaces what is already on it; it never adds a row. Whether an asset <i>belongs</i>
     * there is the server's judgement, made against a warranty window and an overdue cutoff this
     * client does not carry - so a newly broken machine marks the board stale and appears on the
     * next read rather than being guessed onto it.</p>
     */
    private patchAttentionAsset(asset: MaintenanceAsset): void {
        this.attention.update(all => {
            let changed = false;
            const next = Object.fromEntries(
                Object.entries(all).map(([guildId, state]) => {
                    if (!state.entries.some(e => e.asset.id === asset.id)) return [guildId, state];
                    changed = true;
                    return [
                        guildId,
                        {
                            ...state,
                            entries: state.entries.map(e => (e.asset.id === asset.id ? {...e, asset} : e)),
                        },
                    ];
                }),
            );
            return changed ? next : all;
        });
    }

    /**
     * Assets that need something first, then by name.
     *
     * <p>Broken before overdue before everything else. A catalogue sorted purely alphabetically
     * buries the dead washing machine between the boiler and the dishwasher, which is the one thing
     * the list has to not do.</p>
     */
    private sortedAssets(assets: MaintenanceAsset[]): MaintenanceAsset[] {
        return [...assets].sort(
            (a, b) =>
                this.assetUrgency(a) - this.assetUrgency(b) ||
                a.name.localeCompare(b.name) ||
                a.id.localeCompare(b.id),
        );
    }

    private assetUrgency(asset: MaintenanceAsset): number {
        if (asset.status === AssetStatus.Broken) return 0;
        if (asset.isServiceOverdue) return 1;
        if (asset.status === AssetStatus.NeedsAttention) return 2;
        if (asset.isWarrantyExpiring) return 3;
        // Out of service last, below Ok: it is the one state where nothing is expected of anybody.
        return asset.status === AssetStatus.OutOfService ? 5 : 4;
    }

    /** The log is history, so newest first - the opposite of the asset list, which is a to-do. */
    private sortedRecords(records: MaintenanceRecord[]): MaintenanceRecord[] {
        return [...records].sort(
            (a, b) => b.performedAt.localeCompare(a.performedAt) || b.id.localeCompare(a.id),
        );
    }

    private sortedAttention(entries: MaintenanceAttentionEntry[]): MaintenanceAttentionEntry[] {
        return [...entries].sort(
            (a, b) =>
                reasonRank(primaryReason(a.reasons)) - reasonRank(primaryReason(b.reasons)) ||
                a.asset.name.localeCompare(b.asset.name),
        );
    }

    private patch(channelId: string, fn: (state: MaintenanceChannelState) => MaintenanceChannelState): void {
        this.states.update(all => ({...all, [channelId]: fn(all[channelId] ?? EMPTY_STATE)}));
    }

    private patchExisting(
        channelId: string,
        fn: (state: MaintenanceChannelState) => MaintenanceChannelState,
    ): void {
        this.states.update(all => (all[channelId] ? {...all, [channelId]: fn(all[channelId])} : all));
    }

    private patchAttention(guildId: string, fn: (state: AttentionState) => AttentionState): void {
        this.attention.update(all => ({...all, [guildId]: fn(all[guildId] ?? EMPTY_ATTENTION)}));
    }

    private swallow<T>(channelId: string, err: unknown): Observable<T | null> {
        if (err instanceof HttpErrorResponse && err.status === 403) {
            this.patch(channelId, state => ({...state, forbidden: true}));
        }
        return of(null);
    }
}
