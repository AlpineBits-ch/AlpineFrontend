import {inject, Injectable} from '@angular/core';
import {CreateConversationDto} from "../dtos/request/create-conversation.dto";
import {Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";
import {ConversationDto} from "../dtos/response/conversation.dto";

@Injectable({
  providedIn: 'root',
})
export class ConversationService {

  private httpClient = inject(HttpClient);
  public createConversation(createConversationDto: CreateConversationDto): Observable<ConversationDto>{
    return this.httpClient.post<ConversationDto>(environment.apiUrl + '/api/v1/messaging/conversations', createConversationDto);
  }

  public getConversations(offset: number, limit: number): Observable<ConversationDto[]>{
    return this.httpClient.get<ConversationDto[]>(environment.apiUrl + `/api/v1/messaging/conversations?offset=${offset}&limit=${limit}`);
  }

  public deleteConversation(id: string): Observable<void>{
    return this.httpClient.delete<void>(environment.apiUrl + `/api/v1/messaging/conversations/${id}`);
  }

}
