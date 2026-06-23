import {inject, Injectable, signal} from '@angular/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {environment} from '../../environments/environment';
import {authConfig} from '../app.config';
import {Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";

const STORAGE_KEY = 'server_url';

export interface ServerConfiguration {
    isRegisterEnabled: boolean;
    isLoginEnabled: boolean;
}
@Injectable({providedIn: 'root'})
export class ApiConfigService {
    private oauthService = inject(OAuthService);
    readonly baseUrl = signal<string>(environment.apiUrl);
    private http = inject(HttpClient);
    constructor() {
        const saved = localStorage.getItem(STORAGE_KEY);
        const url = saved ?? environment.apiUrl;
        this.baseUrl.set(url);
        this.oauthService.configure({
            ...authConfig,
            issuer: url,
            tokenEndpoint: `${url}/connect/token`,
        });
    }


    /**
     * Parses `user` or `user@server.com`, updates the base URL, persists it,
     * re-configures OAuth, and returns the bare username.
     */
    applyLoginInput(input: string): string {
        const atIdx = input.lastIndexOf('@');
        let username: string;
        let apiUrl: string;

        if (atIdx > 0) {
            username = input.slice(0, atIdx);
            const domain = input.slice(atIdx + 1);
            apiUrl = `https://${domain}`;
        } else {
            username = input;
            apiUrl = environment.apiUrl;
        }

        this.baseUrl.set(apiUrl);
        localStorage.setItem(STORAGE_KEY, apiUrl);
        this.oauthService.configure({
            ...authConfig,
            issuer: apiUrl,
            tokenEndpoint: `${apiUrl}/connect/token`,
        });

        return username;
    }

    /** Returns the display hostname for a login input string. */
    static serverLabel(input: string): string {
        const atIdx = input.lastIndexOf('@');
        if (atIdx > 0) return input.slice(atIdx + 1);
        return 'venta.gg';
    }

    /** Set the active server from a bare domain name (e.g. `selfhosted.com` or `venta.gg`). */
    setServer(domain: string): void {
        const url = domain === 'venta.gg' ? environment.apiUrl : `https://${domain}`;
        this.baseUrl.set(url);
        localStorage.setItem(STORAGE_KEY, url);
        this.oauthService.configure({
            ...authConfig,
            issuer: url,
            tokenEndpoint: `${url}/connect/token`,
        });
    }

    reset(): void {
        this.baseUrl.set(environment.apiUrl);
        localStorage.removeItem(STORAGE_KEY);
        this.oauthService.configure({
            ...authConfig,
            issuer: environment.apiUrl,
            tokenEndpoint: `${environment.apiUrl}/connect/token`,
        });
    }

    /** Derive the API base URL from a bare domain name. */
    static domainToUrl(domain: string): string {
        return domain === 'venta.gg' ? environment.apiUrl : `https://${domain}`;
    }

    public getServerConfiguration(domain: string): Observable<ServerConfiguration> {
        return this.http.get<ServerConfiguration>(`${domain}/api/v1/configuration`);
    }
}
