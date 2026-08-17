import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {EntitlementDegradationDto, VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {VoiceRoomSnapshot, VoiceSubscriberUpdate, VoiceSubscriptionLayer} from '../models/voice-room';

// ── The SFU control plane ────────────────────────────────────────────────────
//
// Four routes, none of which carries media state: the backend mints a token saying who may send
// what, then is told what was published. The same four shapes serve guild channels and direct
// calls; `voice.service.ts` imports them rather than restating them.

/**
 * Everything needed to open a connection to the SFU: which node, as whom, and with what rights.
 *
 * Never cache {@link url} against a room id: a room lives on exactly one node with no shared
 * hostname in front of the fleet, so a kept URL connects to the wrong machine. {@link token} is
 * short-lived and only read at socket open, so re-ask on an auth refusal, not per reconnect attempt.
 */
export interface VoiceConnectionDto {
    /** The SFU behind this room. An unrecognised value means "cannot handle this room". */
    backend: string;
    url: string;
    token: string;
    room: string;
    /**
     * How the SFU names this connection: the bare user id on a primary, `{userId}#{tag}` on a
     * secondary. Splitting on the first `#` recovers the user; Sqids ids never contain one.
     */
    identity: string;
    /** The same string as {@link identity}, under the name the roster and snapshot already use. */
    mediaSessionId: string;
    expiresAt: string;
    /**
     * What the token grants. The mic and camera buttons must render from these, never from a
     * locally computed permission: the rights are minted into the token and enforced by the node.
     */
    canPublishAudio: boolean;
    canPublishVideo: boolean;
}

/** What was just published, in the track naming the roster and the peers agree on. */
export interface VoicePublishRequest {
    trackNames: string[];
    /** What this client intends to send, so the server can clamp it. Absent means "room default". */
    video?: VideoPublishIntentDto;
}

/**
 * What the room will let out of this publisher. The media does not depend on this call, but nothing
 * else in the product can see the publication until it lands.
 */
export interface VoicePublishResponse {
    identity: string;
    /** The rung the server settled on, or null for an audio-only publish. */
    rung: string | null;
    height: number | null;
    framerate: number | null;
    /**
     * The best layer of our video the room will distribute, or null when nothing caps the publish.
     * Non-null means we declared above our rung: re-encode to {@link rung} and declare again.
     */
    maxLayer: VoiceSubscriptionLayer | null;
    /**
     * What the server gave less of than was asked for, on an otherwise ordinary `200`. The publish
     * succeeded smaller and must not be rolled back; absent and empty mean the same thing. A `403`
     * is the refusal that could not degrade, and the local track must be stopped.
     */
    degradations?: EntitlementDegradationDto[];
}

/** The answer to a resolution change declared without republishing. It refuses nothing. */
export interface VoiceVideoDeclarationResponse {
    changed: boolean;
    maxLayer: VoiceSubscriptionLayer | null;
}

/**
 * The query string for a connection request, shared by both room kinds. An absent tag must be left
 * off, never sent empty: an empty tag falls back to `alt` server-side, so every tagless secondary
 * would share one identity, and identical identities evict one another.
 */
export function connectionQuery(primary: boolean, tag?: string): string {
    const tagged = tag ? `&tag=${encodeURIComponent(tag)}` : '';
    return `?primary=${primary}${tagged}`;
}

/**
 * A guild voice seat the server still places this user in. A roster entry, not a claim that
 * anything is connected: a seat outlives a client that never ran the leave path.
 */
export interface VoiceStateDto {
    guildId: string;
    channelId: string;
    /** Null when the channel was deleted under a roster that has not been swept yet. */
    channelName: string | null;
    /** The device that took the seat. Ours after a relaunch; somebody else's phone otherwise. */
    deviceId: string | null;
    joinedAt: string;
}

@Injectable({providedIn: 'root'})
export class GuildVoiceService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    /**
     * Where the server currently places this user in guild voice, or `null` (a 204, which Angular
     * hands back as a null body). The launch read behind the reconnect banner: a force-quit client
     * never ran {@link leave}, so only the eviction sweep removes its seat. Claims no liveness and
     * does not extend the seat it reports.
     */
    getVoiceState(): Observable<VoiceStateDto | null> {
        return this.client.get<VoiceStateDto | null>(`${this.apiConfig.baseUrl()}/api/v1/guild/voice/state`);
    }
    /** Join the room, and get its authoritative state back in the same round trip. */
    join(guildId: string, channelId: string): Observable<VoiceRoomSnapshot> {
        return this.client.post<VoiceRoomSnapshot>(`${this.base(guildId, channelId)}/join`, {});
    }

    leave(guildId: string, channelId: string): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/leave`, {});
    }

    /**
     * Asserts over HTTP that this device is still in the room. Must stay off the hub: the
     * `voice.Heartbeat` channel rides the same connection whose loss it would report, so a hub
     * outage outlasting the 90s eviction sweep would take voice down while media still flows.
     * Only `404`/`409` mean "not in this room" and justify a local teardown; everything else is
     * transient and must be ignored. See {@link VoiceLivenessService}.
     */
    alive(guildId: string, channelId: string): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/alive`, {});
    }

    /**
     * The authoritative state of the room: who is pullable, on which session, and which
     * screen-share tracks are live. The recovery read, and the only one carrying
     * `shares[].trackNames`, without which a subscription cannot be restored.
     */
    getSnapshot(guildId: string, channelId: string): Observable<VoiceRoomSnapshot> {
        return this.client.get<VoiceRoomSnapshot>(`${this.base(guildId, channelId)}/snapshot`);
    }

    /**
     * Everything needed to connect to the SFU, minted fresh every time. Taking a connection is
     * `Joined`, not `Publishing`, until a track exists and {@link publish} has declared it.
     *
     * @param primary whether this connection carries the microphone. A secondary minted as primary
     *        kicks this user's own call off the air: the SFU evicts an earlier session that
     *        reappears under the same identity.
     * @param tag what distinguishes that second identity, stripped to alphanumerics, truncated to
     *        32, falling back to `alt`. One tag per connection per user: two connections sharing a
     *        tag share an identity and the second evicts the first, so never reuse a tag string.
     */
    connection(
        guildId: string,
        channelId: string,
        primary = true,
        tag?: string,
    ): Observable<VoiceConnectionDto> {
        return this.client.post<VoiceConnectionDto>(
            `${this.base(guildId, channelId)}/connection${connectionQuery(primary, tag)}`,
            {},
        );
    }

    /**
     * Declares what was just published, which is what puts this client on the roster as publishing.
     * `200` with `degradations` worked smaller: re-encode and declare again, roll nothing back.
     * `403` could not degrade: stop the local track, because no retry will be received.
     */
    publish(guildId: string, channelId: string, body: VoicePublishRequest): Observable<VoicePublishResponse> {
        return this.client.post<VoicePublishResponse>(`${this.base(guildId, channelId)}/publish`, body);
    }

    /** Marks the tracks closed so peers drop them rather than waiting on media that has ended. */
    unpublish(guildId: string, channelId: string, trackNames: string[]): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/unpublish`, {trackNames});
    }

    /**
     * Re-declares what is being sent, for a resolution change made without republishing: the only
     * thing that stops a later change walking past the ceiling set at publish time. Never refuses.
     */
    declareVideo(
        guildId: string,
        channelId: string,
        video: VideoPublishIntentDto,
    ): Observable<VoiceVideoDeclarationResponse> {
        return this.client.put<VoiceVideoDeclarationResponse>(
            `${this.base(guildId, channelId)}/video`,
            video,
        );
    }

    serverDeafen(guildId: string, channelId: string, userId: string, isDeafened: boolean): Observable<void> {
        return this.client.patch<void>(`${this.base(guildId, channelId)}/participants/${userId}/deafen`, {
            isDeafened,
        });
    }

    /** Voice occupancy across every guild this user is in: one request for the whole server rail. */
    getVoiceActivity(): Observable<GuildVoiceActivityDto[]> {
        return this.client.get<GuildVoiceActivityDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/voice-activity`,
        );
    }

    // ── Screen share viewers ─────────────────────────────────────────────────

    /**
     * Announces this client as watching `shareId`, or refreshes that claim. The claim expires
     * server-side after 90s and must be re-sent while the stream is on screen; holding the track
     * is not a watch signal.
     */
    watchShare(guildId: string, channelId: string, shareId: string): Observable<ShareViewersDto> {
        return this.client.post<ShareViewersDto>(
            `${this.base(guildId, channelId)}/shares/${shareId}/watch`,
            {},
        );
    }

    unwatchShare(guildId: string, channelId: string, shareId: string): Observable<ShareViewersDto> {
        return this.client.delete<ShareViewersDto>(
            `${this.base(guildId, channelId)}/shares/${shareId}/watch`,
        );
    }

    /** Everyone watching each live share in this channel: the catch-up read for joining mid-stream. */
    getShareViewers(guildId: string, channelId: string): Observable<Record<string, string[]>> {
        return this.client.get<Record<string, string[]>>(`${this.base(guildId, channelId)}/shares/viewers`);
    }

    // ── Subscriber state ─────────────────────────────────────────────────────

    /**
     * Tells the server what this client can actually see. Only caller is
     * {@link VoiceSubscriberReportService}. The reply is typed `unknown` because nothing reads it.
     */
    updateSubscriber(guildId: string, channelId: string, update: VoiceSubscriberUpdate): Observable<unknown> {
        return this.client.post(`${this.base(guildId, channelId)}/subscriptions`, update);
    }

    private base(guildId: string, channelId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/channels/${channelId}/voice`;
    }
}
