import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { catchError, map, Observable, of } from 'rxjs';
import { EncryptedMasterKey, UserDto } from '../dtos/response/UserDto';

@Injectable({ providedIn: 'root' })
export class UserService {
  private httpClient = inject(HttpClient);

  getSelf(): Observable<UserDto> {
    return this.httpClient.get<UserDto>(`${environment.apiUrl}/api/v1/identity/users/self`);
  }

  verifyPassword(password: string): Observable<boolean> {
    return this.httpClient.post<unknown>(
      `${environment.apiUrl}/api/v1/identity/authentication/verify`,
      { password }
    ).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  // MOCKED: replace with HTTP PUT/POST when backend is ready
  uploadEncryptedMasterKey(_payload: EncryptedMasterKey): Observable<void> {

    return this.httpClient.post<void>(
      `${environment.apiUrl}/api/v1/identity/users/master`,
      _payload
    );

  }
}
