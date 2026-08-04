import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

export type DataExportStatus = 'Pending' | 'Running' | 'Ready' | 'Partial' | 'Failed' | 'Expired';

export interface DataExportDto {
    exportId: string;
    status: DataExportStatus;
    requestedAt: string;
    completedAt: string | null;
    /** Set once the artifact exists; it is deleted at this point (7 days by default). */
    expiresAt: string | null;
    /** A sentence explaining a `Failed`, or what was left out of a `Partial`. */
    failureReason: string | null;
    /**
     * Services that did not return their data in time for a `Partial`. Empty for every other
     * status. Named in the UI - "some of your data is missing" without saying which is not an
     * answer the user can do anything with.
     */
    missingServices: string[];
}

/** Statuses that will not change again without a new request. */
export const DATA_EXPORT_TERMINAL: readonly DataExportStatus[] =
    ['Ready', 'Partial', 'Failed', 'Expired'];

/**
 * Statuses the server will actually serve an artifact for.
 *
 * <p><b>`Partial` belongs here.</b> A client gating the button on `Ready` alone hides a download
 * the server would happily serve, and leaves the user believing their export failed when most of
 * it is sitting there ready - so this is a set rather than an equality check, and new
 * partially-successful statuses join it rather than falling through to "broken".</p>
 */
export const DATA_EXPORT_DOWNLOADABLE: readonly DataExportStatus[] = ['Ready', 'Partial'];

export function canDownload(status: DataExportStatus): boolean {
    return DATA_EXPORT_DOWNLOADABLE.includes(status);
}

/**
 * GDPR Art. 15/20 data exports (T1-7).
 *
 * <p>The export is assembled asynchronously by a saga across every service, so requesting one
 * returns a 202 and the client polls - there is no push notification. One request per account per
 * 24h is enforced server-side; the client surfaces the refusal rather than trying to predict it.
 * `Failed` and `Partial` exports do not count against that limit, which is why a failed export
 * still leaves the request button live.</p>
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
     * <p>The endpoint answers `302` to a short-lived signed URL. This reads the result as a blob
     * and lets the HTTP stack follow the redirect, rather than surfacing the signed URL: the
     * endpoint is authenticated, so a plain navigation would arrive without the bearer, and handing
     * the signed URL to the page would put a bearer-free download credential somewhere it can be
     * copied out of. Browsers strip `Authorization` on a cross-origin redirect, so the storage host
     * sees only the signature it issued.</p>
     *
     * <p>Errors are meaningful and the caller must distinguish them: `409` is a `Failed` export,
     * `410` an expired one - a different sentence and a different next step each.</p>
     */
    download(exportId: string): Observable<Blob> {
        return this.http.get(`${this.base}/${exportId}/download`, {responseType: 'blob'});
    }
}
