import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {catchError, from, Observable, switchMap, tap, throwError} from "rxjs";
import {environment} from "../../environments/environment";
import {OAuthService, TokenResponse} from "angular-oauth2-oidc";
import {ApiConfigService} from "./api-config.service";
import {DeviceIdentityService} from "./device-identity.service";
import {describeCurrentDevice} from "./device-description";
import {checkJsonSettings} from "../core/json-settings-limits";

@Injectable({
    providedIn: 'root',
})
export class AuthService {
    private http = inject(HttpClient);
    private oauthService = inject(OAuthService);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private _activeRefresh: Promise<string> | null = null;

    public register(email: string, username: string, password: string, birthdate: Date): Observable<unknown> {
        return this.http.post(`${environment.apiUrl}/api/v1/identity/authentication/register`, {
            email,
            password,
            birthdate,
            username
        });
    }

    /** Accepts `username` or `user@server.com`, resolves the server, then logs in. */
    public login(input: string, password: string, mfaCode?: string): Observable<TokenResponse> {
        const username = this.apiConfig.applyLoginInput(input);
        // fetchTokenUsingPasswordFlow is exactly fetchTokenUsingGrant('password', {username, password});
        // going through the grant call directly is the only way to add the mfa_code field the
        // backend reads off the token request.
        const parameters: Record<string, string> = {username, password};
        if (mfaCode) parameters['mfa_code'] = mfaCode;

        const {deviceName, deviceType} = describeCurrentDevice();
        parameters['device_name'] = deviceName;
        parameters['device_type'] = deviceType;

        // The device id links this session to the registered device, which is what lets revoking
        // the session also kill that device's push. A first login on a fresh install necessarily
        // happens before the device can be registered and the server ignores an unknown id, so an
        // unresolvable id is no reason to block signing in - it links from the next login onward.
        return from(this.deviceIdentity.deviceId().catch(() => null)).pipe(
            switchMap(deviceId => {
                if (deviceId) parameters['device_id'] = deviceId;
                return from(this.oauthService.fetchTokenUsingGrant('password', parameters));
            }),
            tap({
                error: (err) => console.error('Login failed', err)
            }),
            catchError((err) => throwError(() => err))
        );
    }

    public logout() {
        this.apiConfig.reset();
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
     * hit the token endpoint exactly once -no racing over a single-use refresh token.
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

    /**
     * Writes the client-owned UI settings blob.
     *
     * <p>Checked against the server's limits first (T0-6). The server rejects an oversized or
     * non-object document with 413/400; failing here instead means the caller gets a reason it can
     * act on rather than a save that silently stopped working at some size nobody measured.</p>
     */
    public updateJsonSettings(settings: unknown): Observable<unknown> {
        const check = checkJsonSettings(settings);
        if (!check.ok) {
            return throwError(() => new Error(`Refusing to save settings blob: ${check.reason}`));
        }
        return this.http.put(`${environment.apiUrl}/api/v1/identity/users/self/settings`, settings);
    }
}
