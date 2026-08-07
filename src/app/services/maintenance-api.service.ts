import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    MaintenanceAsset,
    MaintenanceAttentionEntry,
    MaintenanceRecord,
    MaintenanceRecordPage,
} from '../dtos/response/maintenance.dto';
import {
    CreateMaintenanceAssetDto,
    CreateMaintenanceRecordDto,
    RecordServiceDto,
    UpdateAssetStatusDto,
    UpdateMaintenanceAssetDto,
    UpdateMaintenanceRecordDto,
} from '../dtos/request/maintenance.dto';

/** What a `POST /serviced` answers with: the asset as it now stands, and the log line it wrote. */
export interface ServiceRecorded {
    asset: MaintenanceAsset;
    record: MaintenanceRecord;
}

export const MAINTENANCE_RECORD_PAGE_SIZE = 50;

/**
 * The Maintenance HTTP surface, and nothing else.
 *
 * <p>Two scopes, and the second is not an oversight: assets and records are per channel, but
 * {@link attention} is <b>per guild</b> - "what in this house needs a human" is a question about the
 * house, and a flat with an upkeep channel per floor would otherwise have to be asked twice.</p>
 */
@Injectable({providedIn: 'root'})
export class MaintenanceApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Assets ───────────────────────────────────────────────────────────────

    listAssets(channelId: string): Observable<MaintenanceAsset[]> {
        return this.http.get<MaintenanceAsset[]>(`${this.base}/channels/${channelId}/maintenance-assets`);
    }

    getAsset(assetId: string): Observable<MaintenanceAsset> {
        return this.http.get<MaintenanceAsset>(`${this.base}/maintenance-assets/${assetId}`);
    }

    /** `ManageMaintenance` - cataloguing a machine is administration, unlike reporting one broken. */
    createAsset(channelId: string, body: CreateMaintenanceAssetDto): Observable<MaintenanceAsset> {
        return this.http.post<MaintenanceAsset>(`${this.base}/channels/${channelId}/maintenance-assets`, body);
    }

    updateAsset(assetId: string, body: UpdateMaintenanceAssetDto): Observable<MaintenanceAsset> {
        return this.http.patch<MaintenanceAsset>(`${this.base}/maintenance-assets/${assetId}`, body);
    }

    deleteAsset(assetId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/maintenance-assets/${assetId}`);
    }

    /**
     * Sets an asset's status. <b>`LogMaintenance`, not `ManageMaintenance`, on purpose.</b>
     *
     * <p>The person who discovers the washing machine is dead is whoever tried to use it, so this is
     * the participation bit and the control belongs everywhere the asset appears.</p>
     */
    setStatus(assetId: string, body: UpdateAssetStatusDto): Observable<MaintenanceAsset> {
        return this.http.put<MaintenanceAsset>(`${this.base}/maintenance-assets/${assetId}/status`, body);
    }

    /**
     * Marks an asset serviced and writes the log line in one call. `LogMaintenance`.
     *
     * <p>Two things it does not do. It schedules the next service from when the work was
     * <b>actually done</b>, not from when it was supposed to happen - so a callout entered a week
     * late has to say so. And it does <b>not clear a `Broken` status</b>: a visit is not proof it
     * works, and the caller must not imply otherwise.</p>
     */
    recordService(assetId: string, body: RecordServiceDto = {}): Observable<ServiceRecorded> {
        return this.http.post<ServiceRecorded>(`${this.base}/maintenance-assets/${assetId}/serviced`, body);
    }

    // ── Records ──────────────────────────────────────────────────────────────

    /** The service log, newest first. Cursor-paged; `assetId` narrows it to one machine. */
    listRecords(
        channelId: string,
        options: {assetId?: string | null; limit?: number; cursor?: string | null} = {},
    ): Observable<MaintenanceRecordPage> {
        let params = new HttpParams().set('limit', options.limit ?? MAINTENANCE_RECORD_PAGE_SIZE);
        if (options.assetId) params = params.set('assetId', options.assetId);
        if (options.cursor) params = params.set('cursor', options.cursor);
        return this.http.get<MaintenanceRecordPage>(
            `${this.base}/channels/${channelId}/maintenance-records`, {params});
    }

    createRecord(channelId: string, body: CreateMaintenanceRecordDto): Observable<MaintenanceRecord> {
        return this.http.post<MaintenanceRecord>(`${this.base}/channels/${channelId}/maintenance-records`, body);
    }

    updateRecord(recordId: string, body: UpdateMaintenanceRecordDto): Observable<MaintenanceRecord> {
        return this.http.patch<MaintenanceRecord>(`${this.base}/maintenance-records/${recordId}`, body);
    }

    deleteRecord(recordId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/maintenance-records/${recordId}`);
    }

    // ── The attention board ──────────────────────────────────────────────────

    /**
     * Everything in the house that needs a human: broken, overdue service, warranty inside 30 days.
     *
     * <p>Spans every maintenance channel the caller can see, and carries the reasons with each row
     * rather than leaving them to be derived - deriving them would mean reimplementing the warranty
     * window and the overdue cutoff, and the two copies would drift the first time either moved.</p>
     */
    attention(guildId: string): Observable<MaintenanceAttentionEntry[]> {
        return this.http.get<MaintenanceAttentionEntry[]>(`${this.base}/guilds/${guildId}/maintenance/attention`);
    }
}
