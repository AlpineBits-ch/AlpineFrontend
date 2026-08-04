import {computed, inject, Injectable, signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, tap} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {UserService} from './user.service';
import {ConsentRequirement, LegalDocumentType} from '../dtos/response/UserDto';

export interface LegalDocumentDto {
    documentType: LegalDocumentType;
    version: string;
    effectiveAt: string;
    /** Hash of the published text, so a silent edit to a document is detectable. */
    contentHash: string;
    url: string;
}

export interface UserConsentDto {
    documentType: LegalDocumentType;
    version: string;
    acceptedAt: string;
}

/**
 * Versioned acceptance of the Terms, Privacy Policy and Cookie Policy (T1-10, T1-12).
 *
 * <p>Terms and Privacy are not withdrawable while the account is open - the withdrawal path is
 * account deletion, and the UI says so rather than offering a control that cannot work. The
 * optional consents (the data-use flags) live on the privacy record instead, where withdrawal is
 * immediate and never degrades the service.</p>
 */
@Injectable({providedIn: 'root'})
export class LegalService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private users = inject(UserService);

    /** Documents accepted in this session, so the prompt clears without refetching `/users/self`. */
    private readonly accepted = signal<ReadonlySet<string>>(new Set());

    /**
     * What the account still has to accept, read straight off `GET /users/self`.
     *
     * <p>An absent field means the server does not publish consent records at all, which is not the
     * same as "everything outstanding" - see the note on `UserDto.consentRequired`.</p>
     */
    readonly outstanding = computed<ConsentRequirement[]>(() => {
        const required = this.users.self()?.consentRequired ?? [];
        const done = this.accepted();
        return required.filter(r => !done.has(LegalService.key(r.documentType, r.version)));
    });

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/legal';
    }

    private static key(documentType: LegalDocumentType, version: string): string {
        return `${documentType}@${version}`;
    }

    documents(): Observable<LegalDocumentDto[]> {
        return this.http.get<LegalDocumentDto[]>(`${this.base}/documents`);
    }

    consents(): Observable<UserConsentDto[]> {
        return this.http.get<UserConsentDto[]>(`${this.base}/consents`);
    }

    /** Records acceptance of one document version. The server stamps the time and the IP. */
    accept(documentType: LegalDocumentType, version: string): Observable<void> {
        return this.http.post<void>(`${this.base}/consents`, {documentType, version}).pipe(
            tap(() => this.accepted.update(done =>
                new Set(done).add(LegalService.key(documentType, version)),
            )),
        );
    }
}
