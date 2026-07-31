import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {environment} from '../../environments/environment';
import {ApiConfigService} from "./api-config.service";

export interface VoiceParticipantDto {
    userId: string;
    channelId: string;
    guildId: string;
    cfSessionId: string | null;
    audioTrackName: string | null;
    isSelfMuted: boolean;
    isSelfDeafened: boolean;
    isServerMuted: boolean;
    isServerDeafened: boolean;
    isStreaming: boolean;
    joinedAt: string;
}

export interface VoiceStateDto {
    channelId: string;
    guildId: string;
    participants: VoiceParticipantDto[];
}

export interface CfGuildTrackNew {
    location: 'local' | 'remote';
    mid?: string;
    trackName?: string;
    sessionId?: string;
}

export interface CfGuildTracksNewRequest {
    cfSessionId: string;
    sessionDescription: RTCSessionDescriptionInit;
    tracks: CfGuildTrackNew[];
}

export interface CfGuildTrackResult {
    /** Absent when the track failed - see errorCode/errorDescription. */
    mid?: string;
    trackName: string;
    sessionId?: string;
    location?: string;
    /** Cloudflare's per-track failure fields - see the note on CfTrackResult in voice.service.ts. */
    errorCode?: string;
    errorDescription?: string;
}

export interface CfGuildTracksNewResponse {
    sessionDescription: RTCSessionDescriptionInit;
    tracks: CfGuildTrackResult[];
    requiresImmediateRenegotiation: boolean;
}

export interface CfGuildRenegotiateResponse {
    sessionDescription: RTCSessionDescriptionInit;
}

@Injectable({providedIn: 'root'})
export class GuildVoiceService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    join(guildId: string, channelId: string): Observable<VoiceStateDto> {
        return this.client.post<VoiceStateDto>(`${this.base(guildId, channelId)}/join`, {});
    }

    leave(guildId: string, channelId: string): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/leave`, {});
    }

    getState(guildId: string, channelId: string): Observable<VoiceStateDto> {
        return this.client.get<VoiceStateDto>(this.base(guildId, channelId));
    }

    /**
     * Open a Cloudflare session.
     *
     * `primary` decides whether the backend runs this session through the device-connect path. The
     * microphone is published from Rust on its own session, so the webview's session is secondary -
     * it exists only to receive.
     */
    createSession(guildId: string, channelId: string, primary = true): Observable<{ cfSessionId: string }> {
        return this.client.post<{ cfSessionId: string }>(
            `${this.base(guildId, channelId)}/session?primary=${primary}`, {});
    }

    tracksNew(guildId: string, channelId: string, body: CfGuildTracksNewRequest): Observable<CfGuildTracksNewResponse> {
        return this.client.post<CfGuildTracksNewResponse>(`${this.base(guildId, channelId)}/cf/tracks/new`, body);
    }

    renegotiate(
        guildId: string,
        channelId: string,
        cfSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
    ): Observable<CfGuildRenegotiateResponse> {
        return this.client.put<CfGuildRenegotiateResponse>(
            `${this.base(guildId, channelId)}/cf/renegotiate`,
            {cfSessionId, sessionDescription},
        );
    }

    closeTracks(guildId: string, channelId: string, cfSessionId: string, trackNames: string[]): Observable<void> {
        return this.client.put<void>(
            `${this.base(guildId, channelId)}/cf/tracks/close`,
            {cfSessionId, trackNames},
        );
    }

    serverDeafen(guildId: string, channelId: string, userId: string, isDeafened: boolean): Observable<void> {
        return this.client.patch<void>(
            `${this.base(guildId, channelId)}/participants/${userId}/deafen`,
            {isDeafened},
        );
    }

    private base(guildId: string, channelId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/channels/${channelId}/voice`;
    }
}
