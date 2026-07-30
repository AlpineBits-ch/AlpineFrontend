import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

@Injectable({providedIn: 'root'})
export class PasswordResetService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/user';
    }

    /**
     * Always 202, whether or not the account exists - deliberate, so the response
     * can't be used to probe which emails are registered. Never branch on it.
     */
    requestReset(email: string): Observable<void> {
        return this.http.get<void>(`${this.base}/request-password-reset`, {
            params: new HttpParams().set('email', email),
        });
    }

    resetPassword(email: string, code: string, newPassword: string): Observable<void> {
        return this.http.post<void>(`${this.base}/reset-password`, {email, code, newPassword});
    }
}
