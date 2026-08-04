import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

export interface PendingCredentials {
    /** What the sign-in field takes: a bare username, or `username@server` on a self-hosted one. */
    loginId: string;
    password: string;
}

export type PostVerifyAction = 'none' | 'navigate-login';

/**
 * How sure we are that a code is actually in the user's inbox.
 *
 * <p>`sent` is for a session that is already signed in and known to be unverified - there is an
 * account, it needs confirming, and a code was sent. `unknown` is the state registration leaves the
 * user in: the `202` covers a created account and an address that already had one, and in the latter
 * case what arrives is a "someone tried to sign up with your address" notice with no code in it. The
 * copy has to hold for both.</p>
 */
export type CodeCertainty = 'sent' | 'unknown';

export interface ShowOptions {
    action?: PostVerifyAction;
    credentials?: PendingCredentials;
    certainty?: CodeCertainty;
}

@Injectable({providedIn: 'root'})
export class EmailVerificationService {
    readonly visible = signal(false);
    readonly email = signal('');
    readonly postVerifyAction = signal<PostVerifyAction>('none');
    readonly pendingCredentials = signal<PendingCredentials | null>(null);
    readonly certainty = signal<CodeCertainty>('sent');
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    /** Stored from the last getSelf() call so token-refresh handlers can look it up. */
    private _knownEmail = signal('');

    storeKnownEmail(email: string): void {
        if (email) this._knownEmail.set(email);
    }

    knownEmail(): string {
        return this._knownEmail();
    }

    show(email: string, options: ShowOptions = {}): void {
        this.email.set(email);
        this.postVerifyAction.set(options.action ?? 'none');
        this.pendingCredentials.set(options.credentials ?? null);
        this.certainty.set(options.certainty ?? 'sent');
        this.visible.set(true);
    }

    dismiss(): void {
        this.visible.set(false);
        this.pendingCredentials.set(null);
    }

    /**
     * Always `202`, for every address, whether or not it exists - and re-sending while a code is
     * still live returns the same code rather than minting a new one, so pressing this repeatedly is
     * safe and never invalidates the code already sitting in the inbox. Never branch on the result.
     */
    resendCode(email: string): Observable<void> {
        return this.http.get<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/user/generate-verification-code`,
            {params: new HttpParams().set('email', email)}
        );
    }

    verifyCode(email: string, code: string): Observable<void> {
        return this.http.get<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/user/verify-email`,
            {params: new HttpParams().set('email', email).set('code', code)}
        );
    }
}
