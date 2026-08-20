import {inject, Injectable, signal} from '@angular/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {environment} from '../../environments/environment';
import {authConfig} from '../auth.config';
import {Observable} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {activeSlotId, scopedOAuthKey} from './scoped-oauth-storage';

const STORAGE_KEY = 'server_url';

/** What the compiled-in default is called in the UI. Its API host is a subdomain of it. */
const HOME_DOMAIN = 'venta.gg';

/**
 * The server this account is on, kept per slot.
 *
 * <p>Slots are per-server by construction, which is what makes holding the same account on two
 * servers - or two accounts on two servers - work without any of it being a special case. The
 * unscoped key is kept in step as the login screen's "last server used" and as the value an
 * installation upgrading already has.</p>
 */
function readServerUrl(): string | null {
    return (
        localStorage.getItem(scopedOAuthKey(activeSlotId(), STORAGE_KEY)) ?? localStorage.getItem(STORAGE_KEY)
    );
}

function writeServerUrl(url: string): void {
    localStorage.setItem(scopedOAuthKey(activeSlotId(), STORAGE_KEY), url);
    localStorage.setItem(STORAGE_KEY, url);
}

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
        const saved = readServerUrl();
        const url = saved ?? environment.apiUrl;
        this.baseUrl.set(url);
        this.oauthService.configure({
            ...authConfig,
            issuer: url,
            tokenEndpoint: `${url}/connect/token`,
        });
    }

    /**
     * Whether this URL is one of ours, and therefore one the bearer token belongs on.
     *
     * <p>Both hosts count: the server hands out absolute URLs built from its own configured base,
     * and the token interceptor rewrites the compiled-in default to whichever instance is
     * selected - so a URL against either is a URL the interceptor will authenticate.</p>
     */
    isOwnUrl(url: string): boolean {
        return url.startsWith(this.baseUrl()) || url.startsWith(environment.apiUrl);
    }

    /** Set the active server from a bare domain name (e.g. `selfhosted.com` or `venta.gg`). */
    setServer(domain: string): void {
        const url = ApiConfigService.domainToUrl(domain);
        this.baseUrl.set(url);
        writeServerUrl(url);
        this.oauthService.configure({
            ...authConfig,
            issuer: url,
            tokenEndpoint: `${url}/connect/token`,
        });
    }

    reset(): void {
        this.baseUrl.set(environment.apiUrl);
        // This slot's server, and the shared "last server used" the login screen reads. The other
        // slots' entries are untouched: signing out of one account must not send the others to a
        // server they are not on.
        localStorage.removeItem(scopedOAuthKey(activeSlotId(), STORAGE_KEY));
        localStorage.removeItem(STORAGE_KEY);
        this.oauthService.configure({
            ...authConfig,
            issuer: environment.apiUrl,
            tokenEndpoint: `${environment.apiUrl}/connect/token`,
        });
    }

    /** Derive the API base URL from a bare domain name. */
    static domainToUrl(domain: string): string {
        return domain === HOME_DOMAIN ? environment.apiUrl : `https://${domain}`;
    }

    /**
     * The inverse of {@link domainToUrl}: what the instance picker shows for a base URL.
     *
     * <p>The home instance is not a plain host round-trip - its API lives on a subdomain of the
     * name people know it by.</p>
     */
    static urlToDomain(url: string): string {
        if (url === environment.apiUrl) return HOME_DOMAIN;
        try {
            return new URL(url).host;
        } catch {
            return HOME_DOMAIN;
        }
    }

    /** The instance the app ships pointed at. */
    static get homeDomain(): string {
        return HOME_DOMAIN;
    }

    public getServerConfiguration(domain: string): Observable<ServerConfiguration> {
        return this.http.get<ServerConfiguration>(`${domain}/api/v1/configuration`);
    }
}
