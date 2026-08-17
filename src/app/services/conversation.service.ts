import {inject, Injectable} from '@angular/core';
import {CreateConversationDto} from "../dtos/request/create-conversation.dto";
import {Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";
import {ConversationDto} from "../dtos/response/conversation.dto";
import {MlsDeviceTokenDto} from "../dtos/response/mls-device-token.dto";
import {ApiConfigService} from "./api-config.service";

@Injectable({
    providedIn: 'root',
})
export class ConversationService {

    private httpClient = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    public createConversation(createConversationDto: CreateConversationDto): Observable<ConversationDto> {
        this.apiConfig.baseUrl();
        return this.httpClient.post<ConversationDto>(this.apiConfig.baseUrl() + '/api/v1/messaging/conversations', createConversationDto);
    }

    // The un-scoped `GET /conversations/welcomes` is deliberately not exposed here. It selected the
    // legacy contract, where the server matched on user alone and consumed on read - so one device
    // could burn the single-use init key of a Welcome addressed to a *different* device of the same
    // user, which then never saw it again and stayed permanently outside that group. The route
    // still exists for clients in the field (contract §I.3); this client uses the device-scoped
    // `MlsTransportService.getPendingWelcomes` only.

    public getConversations(offset: number, limit: number): Observable<ConversationDto[]> {
        return this.httpClient.get<ConversationDto[]>(this.apiConfig.baseUrl() + `/api/v1/messaging/conversations?offset=${offset}&limit=${limit}`);
    }

    public getConversationById(id: string): Observable<ConversationDto> {
        return this.httpClient.get<ConversationDto>(this.apiConfig.baseUrl() + `/api/v1/messaging/conversations/${id}`);
    }

    /**
     * Adds someone to an existing group conversation.
     *
     * Roster only. For an encrypted conversation their devices still have to be admitted to the MLS
     * group, which only a member's client can do - see {@link ConversationMemberService.addMember}
     * for the pairing.
     */
    public addMember(conversationId: string, userId: string): Observable<ConversationDto> {
        return this.httpClient.post<ConversationDto>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/conversations/${conversationId}/members`,
            {userId});
    }

    public deleteConversation(id: string): Observable<void> {
        return this.httpClient.delete<void>(this.apiConfig.baseUrl() + `/api/v1/messaging/conversations/${id}`);
    }

    public getMlsTokensForUserIds(ids: string[]): Observable<{ deviceTokens: MlsDeviceTokenDto[] }> {
        return this.httpClient.post<{
            deviceTokens: MlsDeviceTokenDto[]
        }>(this.apiConfig.baseUrl() + '/api/v1/messaging/conversations/consume-tokens', {
            userIds: ids
        });
    }

}
