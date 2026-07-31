import {inject, Injectable} from '@angular/core';
import {CreateConversationDto} from "../dtos/request/create-conversation.dto";
import {Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";
import {ConversationDto} from "../dtos/response/conversation.dto";
import {MlsDeviceTokenDto} from "../dtos/response/mls-device-token.dto";
import {PendingWelcomeDto} from "../dtos/response/pending-welcome.dto";
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

    public getPendingWelcomes(): Observable<PendingWelcomeDto[]> {
        return this.httpClient.get<PendingWelcomeDto[]>(this.apiConfig.baseUrl() + '/api/v1/messaging/conversations/welcomes');
    }

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
