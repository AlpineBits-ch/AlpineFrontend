import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {EntitlementSnapshotDto} from '../dtos/response/entitlement.dto';

/**
 * Reads a subject's resolved ceilings. See `Echo/docs/specs/entitlements-frontend-guide.md` section
 * 5.
 *
 * <p>The base URL is read per call rather than cached in a field: this client is pointed at
 * arbitrary instances at runtime, and a URL captured at construction outlives the instance it was
 * built for.</p>
 *
 * <p>Caching, staleness and the subject echo are {@link EntitlementStore}'s, not this service's.
 * Everything here is one request and one response.</p>
 */
@Injectable({providedIn: 'root'})
export class EntitlementService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    /** The caller's own set, plus what kind of instance this is. */
    getMine(): Observable<EntitlementSnapshotDto> {
        return this.http.get<EntitlementSnapshotDto>(`${this.apiConfig.baseUrl()}/api/v1/entitlements/me`);
    }

    /** One guild's set. Members only - a non-member gets the same 404 as a guild that is not there. */
    getForGuild(guildId: string): Observable<EntitlementSnapshotDto> {
        return this.http.get<EntitlementSnapshotDto>(
            `${this.apiConfig.baseUrl()}/api/v1/entitlements/guilds/${guildId}`,
        );
    }
}
