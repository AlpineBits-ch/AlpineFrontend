import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {HomeStatusDto, SetHomeStatusDto} from '../dtos/response/home-status.dto';

/**
 * The home-status HTTP surface, and nothing else. State, decay and realtime reconciliation live
 * in {@link import('./home-status.service').HomeStatusService}.
 *
 * <p>There is no user id in any write path and no endpoint that takes one: you can only ever set
 * or clear your **own** status. "Anna is asleep" is only Anna's to assert, so there is no admin
 * affordance to build here even for the guild owner.</p>
 */
@Injectable({providedIn: 'root'})
export class HomeStatusApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private base(guildId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/home-status`;
    }

    /**
     * Every member with a *live* status, in no guaranteed order.
     *
     * <p>Expired entries are never returned and a member with nothing to say is simply absent -
     * there is no row per member, so the array length is not the member count.</p>
     */
    list(guildId: string): Observable<HomeStatusDto[]> {
        return this.http.get<HomeStatusDto[]>(this.base(guildId));
    }

    /** Sets the caller's own status. Re-`PUT`ting is how a status is extended. */
    set(guildId: string, body: SetHomeStatusDto): Observable<HomeStatusDto> {
        return this.http.put<HomeStatusDto>(this.base(guildId), body);
    }

    /** Clears the caller's own status ahead of its expiry. */
    clear(guildId: string): Observable<void> {
        return this.http.delete<void>(this.base(guildId));
    }
}
