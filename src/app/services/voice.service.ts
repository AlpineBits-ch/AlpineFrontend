import {inject, Injectable} from '@angular/core';
import {Observable} from "rxjs";
import {IceServersDto} from "../dtos/response/ice-servers.dto";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";
import {CallDto} from "../dtos/response/call.dto";
import {CreateCallDto} from "../dtos/request/create-call.dto";

@Injectable({
  providedIn: 'root',
})
export class VoiceService {
  private client = inject(HttpClient);
  public getIceServers(): Observable<IceServersDto>{
    return this.client.get<IceServersDto>(environment.apiUrl + '/api/v1/messaging/voice/ice-servers');
  }

  public createCall(createCallDto: CreateCallDto): Observable<CallDto>{
    return this.client.post<CallDto>(environment.apiUrl + '/api/v1/messaging/voice/call', createCallDto);
  }

  public acceptCall(callId: string): Observable<CallDto>{
    return this.client.put<CallDto>(environment.apiUrl + `/api/v1/messaging/voice/call/${callId}/accept`, {});
  }
  public declineCall(callId: string): Observable<CallDto>{
    return this.client.put<CallDto>(environment.apiUrl + `/api/v1/messaging/voice/call/${callId}/decline`, {});
  }
  public endCall(callId: string): Observable<CallDto>{
    return this.client.put<CallDto>(environment.apiUrl + `/api/v1/messaging/voice/call/${callId}/end`, {});
  }
}
