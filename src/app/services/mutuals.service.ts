import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {catchError, map, Observable, throwError} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {OnlineStatus} from '../dtos/response/profile.dto';

export interface MutualFriendRow {
    profileId: string;
    userId: string;
    userName: string;
    avatarUrl: string;
    onlineStatus: OnlineStatus;
}

export interface MutualServerRow {
    guildId: string;
    name?: string;
}

export interface MutualsPage<T> {
    items: T[];
    nextCursor: string | null;
}

/** Refused because the subject does not show this list to the caller, not because anything broke. */
export class MutualsNotVisibleError extends Error {
    constructor() {
        super('not_visible');
    }
}

/**
 * The mutual-friends and mutual-servers lists. The profile payload embeds a preview of both; these
 * are the lists themselves, which a profile read deliberately does not carry.
 */
@Injectable({providedIn: 'root'})
export class MutualsService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    friends(profileId: string, cursor?: string | null): Observable<MutualsPage<MutualFriendRow>> {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        return this.get<MutualFriendRow>(`${this.base(profileId)}/mutual-friends${query}`);
    }

    servers(profileId: string): Observable<MutualsPage<MutualServerRow>> {
        return this.get<MutualServerRow>(`${this.base(profileId)}/mutual-servers`);
    }

    guildIconUrl(guildId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/icon`;
    }

    private base(profileId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${profileId}`;
    }

    private get<T>(url: string): Observable<MutualsPage<T>> {
        return this.http.get<MutualsPage<T>>(url).pipe(
            // The server omits nextCursor rather than sending null on the last page of some builds.
            map(page => ({items: page.items ?? [], nextCursor: page.nextCursor ?? null})),
            catchError((err: unknown) =>
                throwError(() =>
                    err instanceof HttpErrorResponse && err.status === 403
                        ? new MutualsNotVisibleError()
                        : err,
                ),
            ),
        );
    }
}
