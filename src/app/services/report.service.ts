import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {refusalCode} from './privacy-settings.service';
import {
    CreateReportRequest,
    CreateReportResponse,
    FiledReport,
    REPORT_REFUSAL_CODES,
} from '../models/report.model';

/** The server's ceiling; asking for more is a 400 rather than a silent clamp. */
export const REPORTS_MINE_DEFAULT_LIMIT = 25;

/** Filing reports, and reading back what came of them. Addressed through {@link ApiConfigService}, not `environment.apiUrl`, because a report must reach the moderators of the instance the content is on. */
@Injectable({providedIn: 'root'})
export class ReportService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/reports`;
    }

    /** Files a report. A `merged: true` in the response means it folded into one the same user filed against the same subject within 24 hours, and callers must say so rather than showing a second "Report submitted". */
    create(request: CreateReportRequest): Observable<CreateReportResponse> {
        return this.http.post<CreateReportResponse>(this.base, request);
    }

    /** The reports this account filed, newest first. */
    mine(limit = REPORTS_MINE_DEFAULT_LIMIT): Observable<FiledReport[]> {
        return this.http.get<FiledReport[]>(`${this.base}/mine`, {
            params: new HttpParams().set('limit', limit),
        });
    }
}

/**
 * What to tell the user about a refused report.
 *
 * @returns a translation key, or null when this is not a refusal the client has anything specific
 *          to say about and the caller should fall back to its generic failure message.
 */
export function reportRefusalKey(err: unknown): string | null {
    if (!(err instanceof HttpErrorResponse)) return null;

    switch (refusalCode(err)) {
        case REPORT_REFUSAL_CODES.selfReport:
            return 'REPORT.ERROR.SELF_REPORT';
        case REPORT_REFUSAL_CODES.subjectIdRequired:
            return 'REPORT.ERROR.SUBJECT_REQUIRED';
        case REPORT_REFUSAL_CODES.evidenceTooLarge:
            return 'REPORT.ERROR.EVIDENCE_TOO_LARGE';
        case REPORT_REFUSAL_CODES.reasonInvalid:
            return 'REPORT.ERROR.REASON_INVALID';
        default:
            return null;
    }
}
