import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from '../../services/api-config.service';
import {
    PaymentHandleDirectory,
    PaymentHandleRecipients,
    PhoneSharingResult,
    SealPaymentHandlesDto,
    SealPaymentHandlesResult,
    SetPhoneSharingDto,
} from './payment-handle.dto';

/**
 * The payment-handle HTTP surface, and nothing else. Sealing, opening, trust and state all live in
 * {@link import('./payment-handle.service').PaymentHandleService}.
 */
@Injectable({providedIn: 'root'})
export class PaymentHandleApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /** Every member's sealed blob, with only this device's wraps. `ViewChannel` is not needed. */
    directory(guildId: string): Observable<PaymentHandleDirectory> {
        return this.http.get<PaymentHandleDirectory>(`${this.base}/guilds/${guildId}/payment-handles`);
    }

    /** The devices to seal to, with the key and the attestation state for each. */
    recipients(guildId: string): Observable<PaymentHandleRecipients> {
        return this.http.get<PaymentHandleRecipients>(
            `${this.base}/guilds/${guildId}/payment-handles/recipients`,
        );
    }

    /** Replaces the caller's own sealed blob. There is no route that writes anybody else's. */
    seal(guildId: string, body: SealPaymentHandlesDto): Observable<SealPaymentHandlesResult> {
        return this.http.put<SealPaymentHandlesResult>(
            `${this.base}/guilds/${guildId}/payment-handles`,
            body,
        );
    }

    /** Drops the caller's blob and every wrap of it. Idempotent - deleting nothing is a `204`. */
    remove(guildId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/payment-handles`);
    }

    /**
     * Turns the caller's own phone number on or off for this household. Off is where everyone
     * starts, and there is no route for anybody else's.
     */
    setPhoneSharing(guildId: string, share: boolean): Observable<PhoneSharingResult> {
        return this.http.put<PhoneSharingResult>(
            `${this.base}/guilds/${guildId}/payment-handles/phone-sharing`,
            {share} satisfies SetPhoneSharingDto,
        );
    }
}
