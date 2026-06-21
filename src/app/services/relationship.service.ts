import {inject, Injectable} from '@angular/core';
import {Observable} from "rxjs";
import {RelationshipModel} from "../features/friendship/components/friendship-modal/dto/relationship.model";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";

@Injectable({
    providedIn: 'root',
})
export class RelationshipService {

    private httpClient = inject(HttpClient);

    public getRelationships(): Observable<RelationshipModel[]> {
        return this.httpClient.get<RelationshipModel[]>(environment.apiUrl + '/api/v1/social/relationships');
    }

    public createFriendRequest(username: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(environment.apiUrl + '/api/v1/social/relationships', {
            username
        });
    }

    public acceptFriendRequest(id: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(environment.apiUrl + `/api/v1/social/relationships/${id}/accept`, {});
    }

    public rejectFriendRequest(id: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(environment.apiUrl + `/api/v1/social/relationships/${id}/reject`, {});
    }

    public revokeFriendRequest(id: string): Observable<RelationshipModel> {
        return this.httpClient.post<RelationshipModel>(environment.apiUrl + `/api/v1/social/relationships/${id}/revoke`, {});
    }

}
