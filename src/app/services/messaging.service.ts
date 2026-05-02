import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {Observable, Subject} from "rxjs";
import {environment} from "../../environments/environment";
import {CreateMessageDto} from "../dtos/request/create-message.dto";
import {MessageDto} from "../dtos/response/message.dto";

@Injectable({
  providedIn: 'root',
})
export class MessagingService {
  private httpClient = inject(HttpClient);
  readonly messageSentObservable = new Subject<MessageDto>();

  public createMessage(createConversationDto: CreateMessageDto): Observable<MessageDto>{
    return this.httpClient.post<MessageDto>(environment.apiUrl + '/api/v1/messaging/messaging', createConversationDto);
  }

  public getMessagesForConversation(conversationId: string, offset: number, limit: number): Observable<MessageDto[]>{
    return this.httpClient.get<MessageDto[]>(environment.apiUrl + '/api/v1/messaging/messaging/conversations/' + conversationId + '/messages?offset=' + offset + '&limit=' + limit);
  }

  public getMessagesForChannel(channelId: string, offset: number, limit: number): Observable<MessageDto[]>{
    return this.httpClient.get<MessageDto[]>(environment.apiUrl + '/api/v1/messaging/messaging/channels/' + channelId + '/messages?offset=' + offset + '&limit=' + limit);
  }

  public deleteMessage(messageId: string): Observable<void>{
    return this.httpClient.delete<void>(environment.apiUrl + '/api/v1/messaging/messaging/' + messageId);
  }
  public updateMessage(messageId: string, content: string): Observable<MessageDto>{
    return this.httpClient.put<MessageDto>(environment.apiUrl + '/api/v1/messaging/messaging/' + messageId, {content});
  }

  public searchMessagesForChannel(channelId: string, query: string): Observable<MessageDto[]> {
    return this.httpClient.get<MessageDto[]>(
        `${environment.apiUrl}/api/v1/messaging/messaging/channels/${channelId}/messages/search?q=${encodeURIComponent(query)}`
    );
  }
  public searchMessagesForConversation(conversationId: string, query: string): Observable<MessageDto[]> {
    return this.httpClient.get<MessageDto[]>(
      `${environment.apiUrl}/api/v1/messaging/messaging/conversations/${conversationId}/messages/search?q=${encodeURIComponent(query)}`
    );
  }
}
