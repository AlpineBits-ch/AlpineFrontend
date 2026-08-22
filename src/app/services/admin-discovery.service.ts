import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ListingState} from '../dtos/response/discovery.dto';

export interface AdminListingRowDto {
    guildId: string;
    guildName: string;
    headline: string;
    state: ListingState;
    publishedAt: string | null;
}

export interface AdminListingSearchDto {
    rows: AdminListingRowDto[];
    nextCursor: string | null;
}

export interface DiscoveryBanDto {
    guildId: string;
    guildName: string;
    /** Shown to the guild owner. */
    reason: string;
    /** Staff only. Never shown outside this console. */
    staffNote: string | null;
    bannedByUserId: string;
    bannedAt: string;
    expiresAt: string | null;
    liftedAt: string | null;
    liftedByUserId: string | null;
}

export interface DiscoveryBanListDto {
    bans: DiscoveryBanDto[];
    nextCursor: string | null;
}

export interface CreateDiscoveryBanDto {
    guildId: string;
    reason: string;
    staffNote?: string;
    expiresAt?: string;
}

/**
 * The staff discovery-ban console's HTTP surface, and nothing else. State lives in
 * `AdminDiscoveryComponent`.
 */
@Injectable({providedIn: 'root'})
export class AdminDiscoveryService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/admin/discovery';
    }

    searchListings(q?: string, cursor?: string): Observable<AdminListingSearchDto> {
        let params = new HttpParams();
        if (q) params = params.set('q', q);
        if (cursor) params = params.set('cursor', cursor);
        return this.http.get<AdminListingSearchDto>(`${this.base}/listings`, {params});
    }

    listBans(includeLifted: boolean, cursor?: string): Observable<DiscoveryBanListDto> {
        let params = new HttpParams();
        if (includeLifted) params = params.set('includeLifted', 'true');
        if (cursor) params = params.set('cursor', cursor);
        return this.http.get<DiscoveryBanListDto>(`${this.base}/bans`, {params});
    }

    createBan(dto: CreateDiscoveryBanDto): Observable<DiscoveryBanDto> {
        return this.http.post<DiscoveryBanDto>(`${this.base}/bans`, dto);
    }

    liftBan(guildId: string): Observable<DiscoveryBanDto> {
        return this.http.delete<DiscoveryBanDto>(`${this.base}/bans/${guildId}`);
    }
}
