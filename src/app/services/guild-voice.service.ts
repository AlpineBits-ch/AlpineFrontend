import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {environment} from '../../environments/environment';
import {ApiConfigService} from "./api-config.service";
import {EntitlementDegradationDto, VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {VoiceRoomSnapshot, VoiceSubscriberUpdate} from '../models/voice-room';

/**
 * One track in a negotiate request.
 *
 * `direction` says what this caller is doing rather than where the media happens to sit, which is
 * the whole point of the neutral contract: `publish` carries a `mid` and no session, `subscribe`
 * carries the `mediaSessionId` it is pulling from and no mid (the SFU allocates that).
 */
export interface VoiceTrackRef {
    direction: 'publish' | 'subscribe';
    mid?: string;
    trackName?: string;
    /** Subscribe only: the session publishing this track. */
    mediaSessionId?: string;
}

export interface VoiceNegotiateRequest {
    mediaSessionId: string;
    sessionDescription: RTCSessionDescriptionInit;
    tracks: VoiceTrackRef[];
    /**
     * What this client intends to send, so the server can clamp it rather than guess.
     *
     * <p>Additive and optional in both directions: a server built before the entitlement contract
     * ignores it, and an audio-only publish omits it because nothing about audio is laddered. Sent
     * on the publish that carries the video track, never on a subscribe.</p>
     */
    video?: VideoPublishIntentDto;
}

export interface VoiceTrackResult {
    /** Absent when the track failed - see errorCode/errorDescription. */
    mid?: string;
    trackName: string;
    mediaSessionId?: string;
    /** Per-track failure fields - see the note on VoiceTrackResult in voice.service.ts. */
    errorCode?: string;
    errorDescription?: string;
}

export interface VoiceNegotiateResponse {
    sessionDescription: RTCSessionDescriptionInit;
    tracks: VoiceTrackResult[];
    requiresImmediateRenegotiation: boolean;
    /**
     * What the server gave less of than was asked for, on an otherwise ordinary `200`.
     *
     * <p>The publish <b>succeeded</b>; this says it succeeded smaller, and the client re-encodes to
     * the granted rung rather than arguing. Absent and empty mean the same thing and are the normal
     * case - a publish nothing reduced is byte-identical to what a client before this contract
     * received. A publish that could not degrade at all is a `403` instead, and never reaches
     * here.</p>
     */
    degradations?: EntitlementDegradationDto[];
}

export interface VoiceRenegotiateResponse {
    sessionDescription: RTCSessionDescriptionInit;
}

@Injectable({providedIn: 'root'})
export class GuildVoiceService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    /**
     * Join the room, and get its authoritative state back in the same round trip.
     *
     * <p>The server also pushes the identical `Snapshot` over SignalR, so this response is a
     * convenience rather than the only copy - but it means the roster can be rendered without
     * waiting for an event to arrive.</p>
     */
    join(guildId: string, channelId: string): Observable<VoiceRoomSnapshot> {
        return this.client.post<VoiceRoomSnapshot>(`${this.base(guildId, channelId)}/join`, {});
    }

    leave(guildId: string, channelId: string): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/leave`, {});
    }

    /**
     * The authoritative state of the room: who is pullable, on which session, and which
     * screen-share tracks are live right now.
     *
     * <p>This is the recovery read, and the only one that carries `shares[].trackNames`. The shape
     * this replaces deliberately withheld the media handles, which is what made HTTP catch-up
     * structurally incapable of restoring a subscription - a viewer joining a channel where a share
     * was already running knew someone was streaming and could not find out what to pull.</p>
     *
     * <p>`GET .../voice` answers the same thing, for anyone still calling it.</p>
     */
    getSnapshot(guildId: string, channelId: string): Observable<VoiceRoomSnapshot> {
        return this.client.get<VoiceRoomSnapshot>(`${this.base(guildId, channelId)}/snapshot`);
    }

    /**
     * Open a media session.
     *
     * <p>`primary` decides whether the backend runs this session through the device-connect path.
     * The microphone is published from Rust on its own session, so the webview's session is
     * secondary - it exists only to receive.</p>
     *
     * <p>`backend` names the SFU behind it. Nothing else on this surface is backend-specific, so it
     * is read for logging rather than branched on; an unrecognised value means "I cannot handle
     * this room" rather than "assume Cloudflare".</p>
     */
    createSession(guildId: string, channelId: string, primary = true)
        : Observable<{ mediaSessionId: string; backend?: string }> {
        return this.client.post<{ mediaSessionId: string; backend?: string }>(
            `${this.base(guildId, channelId)}/session?primary=${primary}`, {});
    }

    /** Publish and subscribe are one route now; `direction` on each track says which. */
    negotiateTracks(
        guildId: string,
        channelId: string,
        body: VoiceNegotiateRequest,
    ): Observable<VoiceNegotiateResponse> {
        return this.client.post<VoiceNegotiateResponse>(`${this.base(guildId, channelId)}/tracks`, body);
    }

    /**
     * Re-offer on an open session, optionally re-declaring what the video now is.
     *
     * <p>`video` belongs here only when this renegotiation is what changes the picture. The server's
     * fan-out cap is computed from the last declaration it saw, so an absent field leaves that cap
     * exactly where it is - it neither applies one nor lifts one, and a renegotiation is never
     * refused over it. An ICE restart, a reconnect and the immediate re-offer the SFU asks for after
     * a publish all send the body they always sent.</p>
     */
    renegotiate(
        guildId: string,
        channelId: string,
        mediaSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
        video?: VideoPublishIntentDto,
    ): Observable<VoiceRenegotiateResponse> {
        return this.client.put<VoiceRenegotiateResponse>(
            `${this.base(guildId, channelId)}/negotiate`,
            {mediaSessionId, sessionDescription, ...(video ? {video} : {})},
        );
    }

    /** POST, not PUT - the close verb changed with the route. */
    closeTracks(guildId: string, channelId: string, mediaSessionId: string, trackNames: string[]): Observable<void> {
        return this.client.post<void>(
            `${this.base(guildId, channelId)}/tracks/close`,
            {mediaSessionId, trackNames},
        );
    }

    serverDeafen(guildId: string, channelId: string, userId: string, isDeafened: boolean): Observable<void> {
        return this.client.patch<void>(
            `${this.base(guildId, channelId)}/participants/${userId}/deafen`,
            {isDeafened},
        );
    }

    /**
     * Voice occupancy across every guild this user is in, for the server rail.
     *
     * <p>One request for the whole rail. The alternative - the voice state of every channel of
     * every guild - is what this endpoint exists to avoid.</p>
     */
    getVoiceActivity(): Observable<GuildVoiceActivityDto[]> {
        return this.client.get<GuildVoiceActivityDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/voice-activity`
        );
    }

    // ── Screen share viewers ─────────────────────────────────────────────────

    /**
     * Announces this client as watching `shareId`, or refreshes that claim.
     *
     * The claim expires server-side after 90s, so it has to be re-sent while the stream is on
     * screen: pulling the track from the SFU is not a watch signal, since nothing obliges a client
     * to tear one down when it stops looking.
     */
    watchShare(guildId: string, channelId: string, shareId: string): Observable<ShareViewersDto> {
        return this.client.post<ShareViewersDto>(
            `${this.base(guildId, channelId)}/shares/${shareId}/watch`, {}
        );
    }

    unwatchShare(guildId: string, channelId: string, shareId: string): Observable<ShareViewersDto> {
        return this.client.delete<ShareViewersDto>(
            `${this.base(guildId, channelId)}/shares/${shareId}/watch`
        );
    }

    /** Everyone watching each live share in this channel - the catch-up read for joining mid-stream. */
    getShareViewers(guildId: string, channelId: string): Observable<Record<string, string[]>> {
        return this.client.get<Record<string, string[]>>(
            `${this.base(guildId, channelId)}/shares/viewers`
        );
    }

    // ── Subscriber state ─────────────────────────────────────────────────────

    /**
     * Tells the server what this client can actually see - see
     * {@link VoiceSubscriberReportService}, which is the only caller.
     *
     * <p>The reply is this client's own subscription set. It is typed as `unknown` because nothing
     * here consumes it: Alpine does not implement selective subscription, and declaring a shape it
     * never reads would suggest otherwise.</p>
     */
    updateSubscriber(guildId: string, channelId: string, update: VoiceSubscriberUpdate): Observable<unknown> {
        return this.client.post(`${this.base(guildId, channelId)}/subscriptions`, update);
    }

    private base(guildId: string, channelId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/channels/${channelId}/voice`;
    }
}
