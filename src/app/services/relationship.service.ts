import {inject, Injectable} from '@angular/core';
import {Observable} from "rxjs";
import {
    MinimalProfileId,
    RelationshipModel
} from "../features/friendship/components/friendship-modal/dto/relationship.model";
import {HttpClient, HttpParams} from "@angular/common/http";
import {ApiConfigService} from "./api-config.service";

/** One entry of the caller's block list. */
export interface BlockedUserDto {
    /** The relationship row, which is what `unblock` and the realtime events key on. */
    id: string;
    user: MinimalProfileId;
    blockedAt: string;
}

export interface BlockedUsersPage {
    blocked: BlockedUserDto[];
    nextCursor: string | null;
}

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
            username
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

    public getBlockedUsers(cursor?: string | null): Observable<BlockedUsersPage> {
        const params = cursor ? new HttpParams().set('cursor', cursor) : undefined;
        return this.httpClient.get<BlockedUsersPage>(`${this.base}/blocked`, {params});
    }
}
