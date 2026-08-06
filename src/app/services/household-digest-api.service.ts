import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {catchError, map, Observable, of, throwError} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {HouseholdDigest, HouseholdDigestResponse} from '../dtos/response/household-digest.dto';

/**
 * The home-digest HTTP surface, and nothing else. State and refresh policy live in
 * {@link import('./household-digest.service').HouseholdDigestService}.
 *
 * <p>One request replaces six. The doubled `guild` segment is correct: the gateway strips one
 * before forwarding, so the public path really is `/api/v1/guild/guilds/{id}/home`.</p>
 */
@Injectable({providedIn: 'root'})
export class HouseholdDigestApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /**
     * The digest, conditionally.
     *
     * <p>Passing the previous `ETag` turns this into an `If-None-Match` request, and an unchanged
     * house answers `304` with no body. Angular treats any non-2xx as a failure, so that `304`
     * arrives here as an {@link HttpErrorResponse} and has to be caught back into a success - which
     * is the whole reason this method exists rather than a bare `http.get`.</p>
     *
     * <p>The response is `Cache-Control: private, no-cache` and is per-user. Nothing here may put
     * it anywhere shared.</p>
     */
    digest(guildId: string, etag?: string | null): Observable<HouseholdDigestResponse> {
        const headers = etag ? new HttpHeaders({'If-None-Match': etag}) : undefined;

        return this.http
            .get<HouseholdDigest>(`${this.base}/guilds/${guildId}/home`, {headers, observe: 'response'})
            .pipe(
                map(response => ({
                    digest: response.body,
                    etag: response.headers.get('ETag'),
                    notModified: false,
                })),
                catchError((err: unknown) => {
                    if (err instanceof HttpErrorResponse && err.status === 304) {
                        // Not an error: the caller's copy is current. The tag is echoed back so a
                        // server that rotates it on a `304` does not leave this client revalidating
                        // against a tag it will never match again.
                        return of<HouseholdDigestResponse>({
                            digest: null,
                            etag: err.headers.get('ETag') ?? etag ?? null,
                            notModified: true,
                        });
                    }
                    return throwError(() => err);
                }),
            );
    }
}
