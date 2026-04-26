import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {Observable} from "rxjs";
import {environment} from "../../environments/environment";
import {CreateMessageDto} from "../dtos/request/create-message.dto";
import {MessageDto} from "../dtos/response/message.dto";

@Injectable({
  providedIn: 'root',
})
export class MessagingService {
  private httpClient = inject(HttpClient);
  public createMessage(createConversationDto: CreateMessageDto): Observable<MessageDto>{
    return this.httpClient.post<MessageDto>(environment.apiUrl + '/api/v1/messaging/messaging', createConversationDto);
  }

  public getMessagesForConversation(conversationId: string, offset: number, limit: number): Observable<MessageDto[]>{
    return this.httpClient.get<MessageDto[]>(environment.apiUrl + '/api/v1/messaging/messaging/conversations/' + conversationId + '/messages?offset=' + offset + '&limit=' + limit);
  }
}
