import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {VoiceInviteSentDto, VoiceRingDto} from '../dtos/response/voice-ring.dto';

/**
 * The HTTP half of the voice-channel ring. Accepting does not join: `accept` closes the invitation
 * and hands back the channel's coordinates, and the caller then goes through the ordinary join.
 * There must be no second join path. {@link deviceIdInterceptor} stamps `X-Device-Id`, not this.
 */
@Injectable({providedIn: 'root'})
export class VoiceRingService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    /**
     * Asks one member into the voice channel the caller is sitting in, and buzzes them now.
     * Idempotent. Sends `delivery` explicitly rather than relying on the server default, which
     * exists only for clients that predate the field.
     */
    ring(guildId: string, channelId: string, targetUserId: string): Observable<VoiceRingDto> {
        return this.http.post<VoiceRingDto>(
            `${this.base}/guilds/${guildId}/channels/${channelId}/voice/rings`,
            {targetUserId, delivery: 'Both'},
        );
    }

    /**
     * Puts an invitation in the DM and interrupts nobody. No ring is created, so there is nothing
     * to accept, decline or expire. Unlike a ring the caller need not be sitting in the channel,
     * but this can be refused with `403 RecipientPolicy` when the recipient blocks DMs.
     */
    invite(guildId: string, channelId: string, targetUserId: string): Observable<VoiceInviteSentDto> {
        return this.http.post<VoiceInviteSentDto>(
            `${this.base}/guilds/${guildId}/channels/${channelId}/voice/rings`,
            {targetUserId, delivery: 'Message'},
        );
    }

    /**
     * Every ring currently asking this account in. Must be called on launch and on every realtime
     * reconnect: `guild.VoiceRingIncoming` is never replayed, so nothing else recovers a missed one.
     */
    pending(): Observable<VoiceRingDto[]> {
        return this.http.get<VoiceRingDto[]>(`${this.base}/guilds/voice/rings/pending`);
    }

    accept(ringId: string): Observable<VoiceRingDto> {
        return this.http.post<VoiceRingDto>(`${this.base}/guilds/voice/rings/${ringId}/accept`, {});
    }

    /**
     * Turns a ring down. Not cosmetic: it locks that inviter out for 15 minutes, then 2 hours, then
     * 24 if they keep coming back. Letting the card lapse is a different act and carries none of it.
     */
    decline(ringId: string): Observable<VoiceRingDto> {
        return this.http.post<VoiceRingDto>(`${this.base}/guilds/voice/rings/${ringId}/decline`, {});
    }

    /** The inviter takes it back. `403` if you are not the inviter; the target has `decline`. */
    cancel(ringId: string): Observable<VoiceRingDto> {
        return this.http.delete<VoiceRingDto>(`${this.base}/guilds/voice/rings/${ringId}`);
    }

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild`;
    }
}
