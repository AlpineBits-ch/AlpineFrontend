import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {MfaEnrollResponse, MfaRecoveryCodesResponse} from '../dtos/response/mfa.dto';

@Injectable({providedIn: 'root'})
export class MfaService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/user/mfa';
    }

    /**
     * Step 1 of enrollment. Safe to call repeatedly before `enable` - the server
     * re-returns the same pending secret rather than minting a new one.
     */
    enroll(): Observable<MfaEnrollResponse> {
        return this.http.post<MfaEnrollResponse>(`${this.base}/enroll`, {});
    }

    /** Step 2 - proves the authenticator works. 400 means the code did not verify. */
    enable(code: string): Observable<MfaRecoveryCodesResponse> {
        return this.http.post<MfaRecoveryCodesResponse>(`${this.base}/enable`, {code});
    }

    /** Password-gated rather than code-gated: someone disabling MFA may have lost their device. */
    disable(password: string): Observable<void> {
        return this.http.post<void>(`${this.base}/disable`, {password});
    }

    /** Invalidates every previously issued recovery code. */
    regenerateRecoveryCodes(password: string): Observable<MfaRecoveryCodesResponse> {
        return this.http.post<MfaRecoveryCodesResponse>(`${this.base}/recovery-codes`, {password});
    }
}
