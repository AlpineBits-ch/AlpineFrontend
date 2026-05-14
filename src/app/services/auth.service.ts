import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {catchError, from, Observable, switchMap, tap, throwError} from "rxjs";
import {environment} from "../../environments/environment";
import {OAuthService, TokenResponse} from "angular-oauth2-oidc";
import {authConfig} from "../app.config";

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private http = inject(HttpClient);
  private oauthService = inject(OAuthService);

  constructor() {
    this.oauthService.configure(authConfig);
  }

  public register(email:string, username: string, password:string, birthdate: Date): Observable<unknown>{
    return this.http.post(`${environment.apiUrl}/api/v1/identity/authentication/register`, {email, password, birthdate, username});
  }
  public login(email: string, password: string): Observable<TokenResponse> {
    return from(this.oauthService.fetchTokenUsingPasswordFlow(email, password)).pipe(

        tap({
          error: (err) => console.error('Login failed', err)
        }),

        catchError((err) => throwError(() => err))
    );
  }

  public logout() {
    this.oauthService.logOut();
  }

  public async isLoggedIn(): Promise<boolean> {
    if (this.oauthService.hasValidAccessToken()) {
      return true;
    }

    try {
      await this.oauthService.refreshToken();
    } catch {
      return false;
    }

    return this.oauthService.hasValidAccessToken();
  }

  public getJsonSettings(): Observable<unknown>{
    return this.http.get(`${environment.apiUrl}/api/v1/identity/users/self/settings`);
  }
  public updateJsonSettings(settings: unknown): Observable<unknown>{
    return this.http.put(`${environment.apiUrl}/api/v1/identity/users/self/settings`, settings);
  }
}
