import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {OsInfo} from '../platform/ports/os-info.port';
import {ApiConfigService} from './api-config.service';
import {AuthService} from './auth.service';

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
    private auth = inject(AuthService);
    private os = inject(OsInfo);

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
     * True when the artifact can be written straight to disk by the shell.
     *
     * <p>Off the desktop shell the caller has no choice but {@link download}, CORS and all.</p>
     *
     * <p>The same gate as before, asked of {@link OsInfo} instead of `isTauri()` and
     * `PlatformService`: a desktop host (`kind` is a real OS, not `'web'`) that is not a phone. Both
     * halves still matter - the Rust command exists in the mobile shell too, but a phone has no file
     * picker worth showing.</p>
     */
    get canSaveToDisk(): boolean {
        return this.os.kind !== 'web' && !this.os.isMobile;
    }

    /**
     * Asks where to put the archive, then streams it there. False when the dialog was dismissed.
     *
     * <p>The destination is asked for <em>before</em> the transfer starts: an export runs to whatever
     * the account weighs, and a cancelled save should not have cost the user that download first. This
     * is the whole flow rather than a path getter because the path must not leave
     * `src/app/platform/` - see {@link chooseDataExportPath}.</p>
     *
     * <p>Rejects with {@link DataExportSaveUnsupportedError} on a host where {@link canSaveToDisk} is
     * false. Callers must check that first and fall back to {@link download}.</p>
     */
    async saveToDiskWithPicker(exportId: string, suggestedName: string): Promise<boolean> {
        this.requireDiskSaveSupport();

        const {chooseDataExportPath} = await import('../platform/tauri/data-export-download');
        const dest = await chooseDataExportPath(suggestedName);
        if (dest === null) return false;

        await this.saveToDisk(exportId, dest);
        return true;
    }

    /**
     * Downloads the artifact to `dest` through the native HTTP client.
     *
     * <p><b>Why not the webview.</b> The endpoint answers `302` to a short-lived signed URL on
     * Google Cloud Storage, and that bucket serves no `Access-Control-Allow-Origin`. Following the
     * redirect from the webview - which is what {@link download} does - is therefore blocked by
     * CORS, and the app reports a download failure for an artifact that is sitting there intact:
     * the same URL downloads fine pasted into a browser, because a navigation is not CORS-checked.
     * CORS is a browser policy, so a native client is not subject to it. Should the bucket ever
     * grow a CORS policy, {@link download} becomes viable again - but this path stays the better
     * one regardless, because it streams to the chosen file instead of holding an
     * account-sized zip in webview memory as a `Blob`.</p>
     *
     * <p>The bearer is passed explicitly because the HTTP interceptors do not reach a request made
     * outside the webview. `reqwest` drops it when the redirect crosses to the storage host, so the
     * signed URL is still fetched with nothing but its own signature.</p>
     *
     * <p>Rejects with a {@link DataExportDownloadError}, or with
     * {@link DataExportSaveUnsupportedError} where {@link canSaveToDisk} is false - <b>a capability
     * gate rather than a second implementation</b>. There is no browser equivalent of this path to
     * write: the point of it is being outside the webview, and a web build has no outside. So the web
     * answer is a typed refusal a caller can branch on, never a silent no-op.</p>
     */
    async saveToDisk(exportId: string, dest: string): Promise<void> {
        this.requireDiskSaveSupport();

        // Reached only past the gate above, so a browser bundle never loads the module and never
        // touches the Tauri plugin it imports.
        const {streamDataExportToFile} = await import('../platform/tauri/data-export-download');

        const url = `${this.base}/${exportId}/download`;
        try {
            await streamDataExportToFile({url, token: await this.auth.ensureValidToken(), dest});
        } catch (err) {
            // The interceptor's refresh-and-retry does not reach a request made outside the
            // webview, so a 401 is answered here rather than surfacing as "could not download" -
            // a token the server rejects while still looking unexpired would otherwise cost the
            // user the whole download.
            if (downloadErrorStatus(err) !== 401) throw err;
            await streamDataExportToFile({url, token: await this.auth.refresh(), dest});
        }
    }

    private requireDiskSaveSupport(): void {
        if (!this.canSaveToDisk) throw new DataExportSaveUnsupportedError(this.os.kind);
    }

    /**
     * Fetches the artifact as a blob.
     *
     * <p>Kept for shells without {@link saveToDisk} - see the CORS caveat there, which applies in
     * full to this path.</p>
     *
     * <p>Errors are meaningful and the caller must distinguish them: `409` is a `Failed` export,
     * `410` an expired one - a different sentence and a different next step each.</p>
     */
    download(exportId: string): Observable<Blob> {
        return this.http.get(`${this.base}/${exportId}/download`, {responseType: 'blob'});
    }
}

/** The shape `saveToDisk` rejects with; mirrors `DownloadError` in `src-tauri/src/data_export.rs`. */
export interface DataExportDownloadError {
    /** The endpoint's status, or `null` when nothing answered. */
    status: number | null;
    message: string;
}

/**
 * Thrown when a host without the native streaming path is asked to write an export to disk.
 *
 * <p>Carries the {@link DataExportDownloadError} shape so it flows through `downloadErrorStatus` and
 * the existing error reporting like any other failure, with `status: null` - which is honest: nothing
 * answered, because nothing was asked. A real class rather than a bare `Error` so a caller can tell
 * "this host cannot" from "the server said no" without matching on a message string.</p>
 *
 * <p>Reaching this is a bug in the caller, not a state to surface: {@link DataExportService.canSaveToDisk}
 * is the check, and a browser build downloads the artifact with {@link DataExportService.download}
 * instead.</p>
 */
export class DataExportSaveUnsupportedError extends Error implements DataExportDownloadError {
    override readonly name = 'DataExportSaveUnsupportedError';
    readonly status = null;

    constructor(host: string) {
        super(`Saving a data export straight to disk needs the desktop shell; this host is "${host}". `
            + 'Check canSaveToDisk and use download() instead.');
    }
}

/**
 * Reads the status out of whatever a download path rejected with.
 *
 * <p>Returns `null` for a transport failure, and for anything unrecognised - a caller that cannot
 * tell which export answer it got must fall back to the generic message rather than guess.</p>
 */
export function downloadErrorStatus(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' && status > 0 ? status : null;
}
