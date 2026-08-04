import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

export type DataExportStatus = 'Pending' | 'Running' | 'Ready' | 'Failed' | 'Expired';

export interface DataExportDto {
    exportId: string;
    status: DataExportStatus;
    requestedAt: string;
    /** Set once the artifact exists; it is deleted at this point (7 days by default). */
    expiresAt: string | null;
}

/** Statuses that will not change again without a new request. */
export const DATA_EXPORT_TERMINAL: readonly DataExportStatus[] = ['Ready', 'Failed', 'Expired'];

/**
 * GDPR Art. 15/20 data exports (T1-7).
 *
 * <p>The export is assembled asynchronously by a saga across every service, so requesting one
 * returns a 202 and the client polls. One request per account per 24h is enforced server-side;
 * the client surfaces the refusal rather than trying to predict it.</p>
 */
@Injectable({providedIn: 'root'})
export class DataExportService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/data-exports';
    }

    list(): Observable<DataExportDto[]> {
        return this.http.get<DataExportDto[]>(this.base);
    }

    request(): Observable<DataExportDto> {
        return this.http.post<DataExportDto>(this.base, {});
    }

    /**
     * Fetches the artifact.
     *
     * <p>Read as a blob rather than by pointing the browser at the URL: the endpoint is
     * authenticated, and a plain navigation would arrive without the bearer token. The redirect to
     * the signed URL is followed by the HTTP stack, so what lands here is the zip itself. That
     * does mean it is held in memory - acceptable for a personal archive, and the alternative
     * (handing the signed URL to the client) would put a downloadable credential somewhere it can
     * be copied out of.</p>
     */
    download(exportId: string): Observable<Blob> {
        return this.http.get(`${this.base}/${exportId}/download`, {responseType: 'blob'});
    }
}
