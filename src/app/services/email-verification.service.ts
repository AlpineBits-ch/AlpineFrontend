import { inject, Injectable, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface PendingCredentials {
  email: string;
  password: string;
}

export type PostVerifyAction = 'none' | 'navigate-login';

@Injectable({ providedIn: 'root' })
export class EmailVerificationService {
  private http = inject(HttpClient);

  readonly visible = signal(false);
  readonly email = signal('');
  readonly postVerifyAction = signal<PostVerifyAction>('none');
  readonly pendingCredentials = signal<PendingCredentials | null>(null);

  /** Stored from the last getSelf() call so token-refresh handlers can look it up. */
  private _knownEmail = signal('');

  storeKnownEmail(email: string): void {
    if (email) this._knownEmail.set(email);
  }

  knownEmail(): string {
    return this._knownEmail();
  }

  show(email: string, action: PostVerifyAction = 'none', credentials?: PendingCredentials): void {
    this.email.set(email);
    this.postVerifyAction.set(action);
    this.pendingCredentials.set(credentials ?? null);
    this.visible.set(true);
  }

  dismiss(): void {
    this.visible.set(false);
    this.pendingCredentials.set(null);
  }

  resendCode(email: string): Observable<void> {
    return this.http.get<void>(
      `${environment.apiUrl}/api/v1/identity/user/generate-verification-code`,
      { params: new HttpParams().set('email', email) }
    );
  }

  verifyCode(email: string, code: string): Observable<void> {
    return this.http.get<void>(
      `${environment.apiUrl}/api/v1/identity/user/verify-email`,
      { params: new HttpParams().set('email', email).set('code', code) }
    );
  }
}
