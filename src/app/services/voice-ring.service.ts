import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {VoiceRingDto} from '../dtos/response/voice-ring.dto';

/**
 * The HTTP half of the voice-channel ring.
 *
 * <p><b>Accepting does not join.</b> `accept` closes the invitation and hands back the channel's
 * coordinates; the caller then goes through the ordinary join, which already handles device
 * resolution, media negotiation, leaving whatever channel you were in and reporting entitlement
 * degradations. Two calls in that order, and no second join path.</p>
 *
 * <p>`X-Device-Id` is not set here: {@link deviceIdInterceptor} stamps every request to this API
 * with it, which is what lets the server tell one of your devices from another when one answers.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceRingService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    /**
     * Asks one member into the voice channel the caller is sitting in.
     *
     * <p>Idempotent: repeating a ring already out to the same person into the same channel answers
     * `200` with the same ring and sends nothing new, so the button can be naive.</p>
     */
    ring(guildId: string, channelId: string, targetUserId: string): Observable<VoiceRingDto> {
        return this.http.post<VoiceRingDto>(
            `${this.base}/guilds/${guildId}/channels/${channelId}/voice/rings`,
            {targetUserId},
        );
    }

    /**
     * Every ring currently asking this account in.
     *
     * <p><b>Call this on launch and on every realtime reconnect.</b> `guild.VoiceRingIncoming` is a
     * live broadcast that is never replayed and the push is best effort, so this read is the only
     * way a client that was offline for ten seconds finds out it was asked.</p>
     */
    pending(): Observable<VoiceRingDto[]> {
        return this.http.get<VoiceRingDto[]>(`${this.base}/guilds/voice/rings/pending`);
    }

    accept(ringId: string): Observable<VoiceRingDto> {
        return this.http.post<VoiceRingDto>(`${this.base}/guilds/voice/rings/${ringId}/accept`, {});
    }

    /**
     * Turns a ring down.
     *
     * <p>Meaningful rather than cosmetic: it locks that one inviter out of ringing this account
     * again for 15 minutes, then 2 hours, then 24 if they keep coming back. Letting the card lapse
     * is a different act and carries none of it, which is why the decline button has to be
     * unmistakably the decline button.</p>
     */
    decline(ringId: string): Observable<VoiceRingDto> {
        return this.http.post<VoiceRingDto>(`${this.base}/guilds/voice/rings/${ringId}/decline`, {});
    }

    /** The inviter takes it back. `403` if you are not the inviter - the target has `decline`. */
    cancel(ringId: string): Observable<VoiceRingDto> {
        return this.http.delete<VoiceRingDto>(`${this.base}/guilds/voice/rings/${ringId}`);
    }

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild`;
    }
}
