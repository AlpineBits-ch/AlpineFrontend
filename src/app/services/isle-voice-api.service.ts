import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

/**
 * REST client for the Isle proximity-voice subsystem.
 *
 * Mirrors {@link GuildVoiceService}: the `Authorization` bearer is added by
 * `tokenInterceptor`, and the base URL is resolved per-call from
 * {@link ApiConfigService.baseUrl} so self-hosted server switching is respected.
 *
 * Gateway base path: `/api/v1/isle/voice` (the `/isle` segment is already the
 * gateway rewrite onto the Isle microservice -do not add another prefix).
 */

/** Membership/connection status for the current user. */
export interface IsleVoiceStatus {
    /** The player's character is currently online on an Isle game server. */
    isGameConnected: boolean;
    /** The player is registered for proximity voice. */
    isVoiceConnected: boolean;
}

export interface CfIsleTrackNew {
    location: 'local' | 'remote';
    mid?: string;
    trackName?: string;
    /** Remote only: the peer's cfSessionId. */
    sessionId?: string;
}

export interface CfIsleTracksNewRequest {
    /** The caller's own session. */
    cfSessionId: string;
    sessionDescription: RTCSessionDescriptionInit;
    tracks: CfIsleTrackNew[];
}

export interface CfIsleTrackResult {
    /** Absent when the track failed - see errorCode/errorDescription. */
    mid?: string;
    trackName: string;
    sessionId?: string;
    location?: string;
    /** Cloudflare's per-track failure fields - see the note on CfTrackResult in voice.service.ts.
     *  The Isle relay retries a failed subscribe and then throws rather than relaying it, so a
     *  track carrying these should not reach this client; they are declared because the wire
     *  contract has them. */
    errorCode?: string;
    errorDescription?: string;
}

export interface CfIsleTracksNewResponse {
    sessionDescription: RTCSessionDescriptionInit;
    tracks: CfIsleTrackResult[];
    requiresImmediateRenegotiation: boolean;
}

export interface CfIsleRenegotiateResponse {
    sessionDescription: RTCSessionDescriptionInit;
}

@Injectable({providedIn: 'root'})
export class IsleVoiceApiService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    // ── Membership ───────────────────────────────────────────────────────────

    /** Opt into proximity voice (registers steamId↔userId). 400 if not fully linked. */
    join(): Observable<void> {
        return this.client.post<void>(`${this.base()}/join`, {});
    }

    /** Remove self from proximity voice and the spatial grid. */
    leave(): Observable<void> {
        return this.client.post<void>(`${this.base()}/leave`, {});
    }

    getStatus(): Observable<IsleVoiceStatus> {
        return this.client.get<IsleVoiceStatus>(`${this.base()}/status`);
    }

    // ── Cloudflare Calls signalling relay ─────────────────────────────────────

    createSession(): Observable<{ cfSessionId: string }> {
        return this.client.post<{ cfSessionId: string }>(`${this.base()}/cf/session`, {});
    }

    tracksNew(body: CfIsleTracksNewRequest): Observable<CfIsleTracksNewResponse> {
        return this.client.post<CfIsleTracksNewResponse>(`${this.base()}/cf/tracks/new`, body);
    }

    renegotiate(
        cfSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
    ): Observable<CfIsleRenegotiateResponse> {
        return this.client.put<CfIsleRenegotiateResponse>(
            `${this.base()}/cf/renegotiate`,
            {cfSessionId, sessionDescription},
        );
    }

    closeTracks(cfSessionId: string, trackNames: string[]): Observable<void> {
        return this.client.put<void>(
            `${this.base()}/cf/tracks/close`,
            {cfSessionId, trackNames},
        );
    }

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/isle/voice`;
    }
}
