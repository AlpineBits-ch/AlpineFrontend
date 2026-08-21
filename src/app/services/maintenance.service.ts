import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {AssetStatus, MaintenanceAsset, MaintenanceRecord} from '../dtos/response/maintenance.dto';
import {
    CreateMaintenanceAssetDto,
    CreateMaintenanceRecordDto,
    RecordServiceDto,
    UpdateMaintenanceAssetDto,
    UpdateMaintenanceRecordDto,
} from '../dtos/request/maintenance.dto';
import {AttentionState, MaintenanceChannelState, MaintenanceStore} from '../stores/maintenance.store';
import {ServiceRecorded} from './maintenance-api.service';

export type {AttentionState, MaintenanceChannelState};

/** The view-facing shape of {@link MaintenanceStore}. State and realtime both live in the store. */
@Injectable({providedIn: 'root'})
export class MaintenanceService {
    private store = inject(MaintenanceStore);

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): MaintenanceChannelState {
        return this.store.stateFor(channelId)();
    }

    attentionFor(guildId: string): AttentionState {
        return this.store.attentionStateFor(guildId)();
    }

    assetById(channelId: string, assetId: string): MaintenanceAsset | null {
        return this.stateFor(channelId).assets.find(a => a.id === assetId) ?? null;
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        this.store.loadFor(channelId);
    }

    refresh(channelId: string): void {
        this.store.refresh(channelId);
    }

    loadMoreRecords(channelId: string): void {
        this.store.loadMoreRecords(channelId);
    }

    /** The guild-wide attention board, served from cache unless an asset event marked it stale or `force` is set. */
    loadAttention(guildId: string, force = false): void {
        this.store.loadAttention(guildId, {force});
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addAsset(
        guildId: string,
        channelId: string,
        body: CreateMaintenanceAssetDto,
    ): Observable<MaintenanceAsset> {
        return this.store.addAsset(guildId, channelId, body);
    }

    editAsset(
        guildId: string,
        channelId: string,
        assetId: string,
        body: UpdateMaintenanceAssetDto,
    ): Observable<MaintenanceAsset> {
        return this.store.editAsset(guildId, channelId, assetId, body);
    }

    removeAsset(guildId: string, channelId: string, assetId: string): Observable<void> {
        return this.store.removeAsset(guildId, channelId, assetId);
    }

    /**
     * The one-tap status write, and the reason it takes only `LogMaintenance`.
     *
     * Callers put this wherever the asset appears, including surfaces that hold nothing else about
     * it, which is why it takes ids rather than the row.
     */
    setStatus(
        guildId: string,
        channelId: string,
        assetId: string,
        status: AssetStatus,
        note?: string,
    ): Observable<MaintenanceAsset> {
        return this.store.setStatus(guildId, channelId, assetId, status, note);
    }

    /**
     * Records a service. It writes a log line and moves the next due date, and it does not clear a
     * `Broken` status, so a caller must not report it as a repair.
     */
    recordService(
        guildId: string,
        channelId: string,
        assetId: string,
        body: RecordServiceDto = {},
    ): Observable<ServiceRecorded> {
        return this.store.recordService(guildId, channelId, assetId, body);
    }

    addRecord(channelId: string, body: CreateMaintenanceRecordDto): Observable<MaintenanceRecord> {
        return this.store.addRecord(channelId, body);
    }

    editRecord(
        channelId: string,
        recordId: string,
        body: UpdateMaintenanceRecordDto,
    ): Observable<MaintenanceRecord> {
        return this.store.editRecord(channelId, recordId, body);
    }

    removeRecord(channelId: string, recordId: string): Observable<void> {
        return this.store.removeRecord(channelId, recordId);
    }
}
