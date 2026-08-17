import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {IncidentDto, StatusSummaryDto} from '../dtos/response/status.dto';

/**
 * The platform status HTTP surface, and nothing else. Polling, dismissal and realtime
 * reconciliation live in {@link import('./platform-status.service').PlatformStatusService}.
 *
 * <p><b>Anonymous by construction.</b> These are the endpoints that have to answer when nothing
 * else does - including when the thing that is broken is sign-in itself - so they carry no bearer
 * token. {@link import('../interceptors/token-interceptor').tokenInterceptor} recognises the
 * `/api/v1/status/` prefix and leaves the `Authorization` header off; see
 * {@link isAnonymousStatusUrl}.</p>
 *
 * <p>Addressed through {@link ApiConfigService} rather than the hard-coded `api.venta.gg` the spec
 * writes out: a self-hosted account has to be told about its own instance's outage, and asking
 * venta.gg whether someone else's server is up answers a question nobody asked.</p>
 */
@Injectable({providedIn: 'root'})
export class StatusApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/status`;
    }

    /**
     * The whole feature in one call. Cached 15 s server-side, so polling it faster buys nothing.
     */
    summary(): Observable<StatusSummaryDto> {
        return this.http.get<StatusSummaryDto>(`${this.base()}/summary`);
    }

    /** History. Nothing in the app calls this yet - the banner links out to the status site. */
    incidents(limit = 25, offset = 0, kind?: 'incident' | 'maintenance'): Observable<IncidentDto[]> {
        const params: Record<string, string> = {limit: String(limit), offset: String(offset)};
        if (kind) params['kind'] = kind;
        return this.http.get<IncidentDto[]>(`${this.base()}/incidents`, {params});
    }

    /** One incident by its `VNT-…` reference. */
    incident(reference: string): Observable<IncidentDto> {
        return this.http.get<IncidentDto>(`${this.base()}/incidents/${encodeURIComponent(reference)}`);
    }

    /**
     * The 90-day strip: twelve components times ninety days.
     *
     * <p><b>Never poll this.</b> It is deliberately not part of the summary, and the only surface
     * that wants the whole matrix is the status page itself - which the settings screen links out
     * to rather than reimplementing. The per-component number shown in settings comes from
     * `components[].uptime90d` on the summary we already hold, at no extra request.</p>
     *
     * <p>Present for completeness; nothing in the app calls it.</p>
     */
    uptime(): Observable<unknown> {
        return this.http.get(`${this.base()}/uptime`);
    }
}

/**
 * Whether a request is one of the anonymous status calls.
 *
 * <p>Lives here rather than in the interceptor so the rule sits next to the endpoints it describes,
 * and so a test can assert on it without standing up an HTTP pipeline.</p>
 */
export function isAnonymousStatusUrl(url: string): boolean {
    return url.includes('/api/v1/status/');
}
