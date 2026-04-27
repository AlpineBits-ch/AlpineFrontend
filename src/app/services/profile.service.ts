import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { ProfileDto } from '../dtos/response/profile.dto';

@Injectable({
  providedIn: 'root',
})
export class ProfileService {
  private httpClient = inject(HttpClient);

  /** Own profile */
  public profile = signal<ProfileDto | undefined>(undefined);

  /** Cache of other users' profiles keyed by userId */
  private userCache = signal<Record<string, ProfileDto>>({});

  public getSelf(): Observable<ProfileDto> {
    return this.httpClient
      .get<ProfileDto>(environment.apiUrl + '/api/v1/social/profiles/me')
      .pipe(tap(v => this.profile.set(v)));
  }

  public getById(userId: string): ProfileDto | undefined {
    return this.userCache()[userId];
  }

  public fetchById(userId: string): Observable<ProfileDto> {
    return this.httpClient
      .get<ProfileDto>(environment.apiUrl + `/api/v1/social/profiles/${userId}`)
      .pipe(
        tap(p => this.userCache.update(cache => ({ ...cache, [userId]: p })))
      );
  }

  /** Returns cached value; fires a fetch in the background if missing */
  public resolve(userId: string): void {
    if (!this.userCache()[userId]) {
      this.fetchById(userId).subscribe();
    }
  }
}
