import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpHeaders, HttpParams} from "@angular/common/http";
import {Observable} from "rxjs";
import {environment} from "../../environments/environment";
import {OAuthService} from "angular-oauth2-oidc";
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
  public async login(email: string, password: string): Promise<void> {
    try {
      await this.oauthService.createAndSaveNonce();
      // This one line replaces your HttpParams, HttpHeaders, and .post call
      const response = await this.oauthService.fetchTokenUsingPasswordFlow(email, password);
      console.log('Tokens received and stored automatically:', response);
    } catch (err) {
      console.error('Login failed', err);
      throw err;
    }
    return;
  }

  public logout() {
    this.oauthService.logOut();
  }
}
