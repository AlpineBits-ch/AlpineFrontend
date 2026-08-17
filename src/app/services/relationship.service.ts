import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {RelationshipModel} from '../models/relationship.model';
import {HttpClient, HttpParams} from '@angular/common/http';
import {ApiConfigService} from './api-config.service';

/**
 * One entry of the caller's block list.
 *
 * <p>Flat rather than nesting a profile, and it carries three ids that are not interchangeable:
 * `userId` is the Identity id the block endpoints take, `profileId` is the Social id profile routes
 * take, and `relationshipId` names the row. Unblocking keys on <b>`userId`</b>.</p>
 */
export interface BlockedUserDto {
    relationshipId: string;
    profileId: string;
    userId: string;
    userName: string;
    avatarUrl: string | undefined;
    blockedAt: string;
}

export interface BlockedUsersPage {
    blocked: BlockedUserDto[];
    nextCursor: string | null;
}

/** The server's ceiling; asking for more is a 400 rather than a silent clamp. */
export const BLOCKED_PAGE_MAX = 100;

@Injectable({
    providedIn: 'root',
})
export class RelationshipService {
    private httpClient = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    /**
     * Reads the base from {@link ApiConfigService} rather than `environment.apiUrl`: the account
     * in the active slot may be on a self-hosted server, and the compile-time constant would send
     * every one of these calls to venta.gg regardless of who is signed in.
     */
    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/social/relationships';
    }

    public getRelationships(): Observable<RelationshipModel[]> {
        return this.httpClient.get<RelationshipModel[]>(this.base);
    }

    public createFriendRequest(username: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(this.base, {
            username,
        });
    }

    public acceptFriendRequest(id: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(`${this.base}/${id}/accept`, {});
    }

    public rejectFriendRequest(id: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(`${this.base}/${id}/reject`, {});
    }

    public revokeFriendRequest(id: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(`${this.base}/${id}/revoke`, {});
    }

    /**
     * Blocks a user.
     *
     * <p>One-directional and asymmetric: it stops them reaching the caller and is not visible to
     * them as a distinct state. It also removes an existing friendship and cancels a pending
     * request in either direction, so callers should re-read the relationship list afterwards
     * rather than patching their local copy from the 204.</p>
     */
    public blockUser(userId: string): Observable<void> {
        return this.httpClient.post<void>(`${this.base}/${userId}/block`, {});
    }

    /** Lifts a block. Idempotent - unblocking someone who is not blocked still succeeds. */
    public unblockUser(userId: string): Observable<void> {
        return this.httpClient.delete<void>(`${this.base}/${userId}/block`);
    }

    /**
     * One page of the block list, newest first.
     *
     * <p>Keyset paged: `nextCursor` is opaque and is the only valid way to ask for the next page.
     * A cursor the server does not recognise is a 400, so it must be passed back verbatim rather
     * than reconstructed.</p>
     */
    public getBlockedUsers(cursor?: string | null, limit = 50): Observable<BlockedUsersPage> {
        let params = new HttpParams().set('limit', Math.min(limit, BLOCKED_PAGE_MAX));
        if (cursor) params = params.set('cursor', cursor);
        return this.httpClient.get<BlockedUsersPage>(`${this.base}/blocked`, {params});
    }
}
