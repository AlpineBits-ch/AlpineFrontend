import {inject, Injectable, signal} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {Observable, tap} from "rxjs";
import {environment} from "../../environments/environment";
import {ProfileDto} from "../dtos/response/profile.dto";

@Injectable({
  providedIn: 'root',
})
export class ProfileService {
  private httpClient = inject(HttpClient);

  public profile = signal<ProfileDto | undefined>(undefined);

  public getSelf(): Observable<ProfileDto>{
    return this.httpClient.get<ProfileDto>(environment.apiUrl+ '/api/v1/social/profiles/me').pipe(tap(v => {
      this.profile.set(v);
    }));
  }
}
