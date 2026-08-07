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
 *
 * <p>Guild-scoped rather than channel-scoped, which is not an oversight: a house can have two
 * ledger channels, and nobody has two sets of bank details per channel. The doubled `guild` segment
 * is correct - the gateway strips one before forwarding.</p>
 *
 * <p><b>Every route here needs `X-Device-Id`</b>, which the app's interceptor stamps on all API
 * requests. `GET /payment-handles` selects the wraps for that device specifically and answers `400`
 * rather than an empty result when the header is missing or unknown - deliberately, because zero
 * wraps and "nobody has shared with you yet" look identical and only one of them is true.</p>
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
        return this.http.get<PaymentHandleDirectory>(
            `${this.base}/guilds/${guildId}/payment-handles`);
    }

    /**
     * The devices to seal to, with the key and the attestation state for each.
     *
     * <p>Scoped to this guild's members and derived from the same roster read the version comes
     * from, so a client that seals against this response cannot store a version describing a roster
     * it never saw. There is deliberately no route that resolves devices for a bare user id.</p>
     */
    recipients(guildId: string): Observable<PaymentHandleRecipients> {
        return this.http.get<PaymentHandleRecipients>(
            `${this.base}/guilds/${guildId}/payment-handles/recipients`);
    }

    /**
     * Replaces the caller's own sealed blob. There is no route that writes anybody else's.
     *
     * <p><b>Wholesale replacement, never a merge.</b> A re-seal mints a fresh content key, so the
     * wraps written here are the complete set of devices that will be able to read what is stored
     * from this moment on. Sending a partial list silently revokes everybody left out.</p>
     */
    seal(guildId: string, body: SealPaymentHandlesDto): Observable<SealPaymentHandlesResult> {
        return this.http.put<SealPaymentHandlesResult>(
            `${this.base}/guilds/${guildId}/payment-handles`, body);
    }

    /** Drops the caller's blob and every wrap of it. Idempotent - deleting nothing is a `204`. */
    remove(guildId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/payment-handles`);
    }

    /**
     * Turns the caller's own phone number on or off for this household. Off is where everyone
     * starts, and there is no route for anybody else's.
     *
     * <p>Per guild, which is the point of the feature: a number entered once on an account must not
     * follow it into every server that account joins. Agreeing that three flatmates may see it is
     * not agreeing that a thousand-person community may.</p>
     *
     * <p>Sends the state it wants rather than asking for a flip, so retrying a request whose
     * outcome is unknown cannot end up sharing a number the user has just switched off.</p>
     */
    setPhoneSharing(guildId: string, share: boolean): Observable<PhoneSharingResult> {
        return this.http.put<PhoneSharingResult>(
            `${this.base}/guilds/${guildId}/payment-handles/phone-sharing`,
            {share} satisfies SetPhoneSharingDto);
    }
}
