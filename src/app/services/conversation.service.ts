import {inject, Injectable} from '@angular/core';
import {CreateConversationDto} from "../dtos/request/create-conversation.dto";
import {Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";

@Injectable({
  providedIn: 'root',
})
export class ConversationService {

  private httpClient = inject(HttpClient);
  public createConversation(createConversationDto: CreateConversationDto): Observable<unknown>{
    return this.httpClient.post(environment.apiUrl + '/api/v1/social/conversations', createConversationDto);
  }
}
