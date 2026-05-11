import {inject, Injectable} from '@angular/core';
import {CreateConversationDto} from "../dtos/request/create-conversation.dto";
import {Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";
import {ConversationDto} from "../dtos/response/conversation.dto";
import {MlsDeviceTokenDto} from "../dtos/response/mls-device-token.dto";
import {PendingWelcomeDto} from "../dtos/response/pending-welcome.dto";

@Injectable({
  providedIn: 'root',
})
export class ConversationService {

  private httpClient = inject(HttpClient);
  public createConversation(createConversationDto: CreateConversationDto): Observable<ConversationDto>{
    return this.httpClient.post<ConversationDto>(environment.apiUrl + '/api/v1/messaging/conversations', createConversationDto);
  }

  public getPendingWelcomes(): Observable<PendingWelcomeDto[]>{
    return this.httpClient.get<PendingWelcomeDto[]>(environment.apiUrl + '/api/v1/messaging/conversations/welcomes');
  }

  public getConversations(offset: number, limit: number): Observable<ConversationDto[]>{
    return this.httpClient.get<ConversationDto[]>(environment.apiUrl + `/api/v1/messaging/conversations?offset=${offset}&limit=${limit}`);
  }

  public getConversationById(id: string): Observable<ConversationDto>{
    return this.httpClient.get<ConversationDto>(environment.apiUrl + `/api/v1/messaging/conversations/${id}`);
  }

  public deleteConversation(id: string): Observable<void>{
    return this.httpClient.delete<void>(environment.apiUrl + `/api/v1/messaging/conversations/${id}`);
  }

  public getMlsTokensForUserIds(ids: string[]): Observable<{deviceTokens: MlsDeviceTokenDto[]}>{
    return this.httpClient.post<{deviceTokens: MlsDeviceTokenDto[]}>(environment.apiUrl + '/api/v1/messaging/conversations/consume-tokens', {
      userIds: ids
    });
  }

}
