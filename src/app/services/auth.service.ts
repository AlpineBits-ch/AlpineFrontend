import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {catchError, from, Observable, tap, throwError} from "rxjs";
import {environment} from "../../environments/environment";
import {OAuthService, TokenResponse} from "angular-oauth2-oidc";
import {authConfig} from "../app.config";

@Injectable({
    providedIn: 'root',
})
export class AuthService {
    private http = inject(HttpClient);
    private oauthService = inject(OAuthService);
    private _activeRefresh: Promise<string> | null = null;

    constructor() {
        this.oauthService.configure(authConfig);
    }

    public register(email: string, username: string, password: string, birthdate: Date): Observable<unknown> {
        return this.http.post(`${environment.apiUrl}/api/v1/identity/authentication/register`, {
            email,
            password,
            birthdate,
            username
        });
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
            await this.refresh();
        } catch {
            return false;
        }
        return this.oauthService.hasValidAccessToken();
    }

    /**
     * Force a token refresh. All callers share the same in-flight promise so
     * concurrent calls (interceptor 401, WS reconnect, token_expires event)
     * hit the token endpoint exactly once — no racing over a single-use refresh token.
     */
    public refresh(): Promise<string> {
        if (!this._activeRefresh) {
            this._activeRefresh = this.oauthService.refreshToken()
                .then(() => {
                    this._activeRefresh = null;
                    return this.oauthService.getAccessToken() ?? '';
                })
                .catch(err => {
                    this._activeRefresh = null;
                    throw err;
                });
        }
        return this._activeRefresh;
    }

    /**
     * Returns the current access token, calling refresh() only if it has expired.
     * Used by WS accessTokenFactories where the token may already be valid.
     */
    public async ensureValidToken(): Promise<string> {
        if (this.oauthService.hasValidAccessToken()) {
            return this.oauthService.getAccessToken()!;
        }
        return this.refresh();
    }

    public getJsonSettings(): Observable<unknown> {
        return this.http.get(`${environment.apiUrl}/api/v1/identity/users/self/settings`);
    }

    public updateJsonSettings(settings: unknown): Observable<unknown> {
        return this.http.put(`${environment.apiUrl}/api/v1/identity/users/self/settings`, settings);
    }
}
