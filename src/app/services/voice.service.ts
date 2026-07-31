import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {CallDto} from '../dtos/response/call.dto';
import {CreateCallDto} from '../dtos/request/create-call.dto';
import {ApiConfigService} from "./api-config.service";

// ── Cloudflare Calls proxy DTOs ───────────────────────────────────────────────

export interface CfTrackNew {
    location: 'local' | 'remote';
    mid?: string;       // local tracks: set after RTCPeerConnection.setLocalDescription
    trackName?: string; // local: the name to publish under; remote: the name to subscribe to
    sessionId?: string; // remote tracks: the peer's CF session ID
}

export interface CfTracksNewRequest {
    sessionDescription: RTCSessionDescriptionInit;
    tracks: CfTrackNew[];
}

export interface CfTrackResult {
    /** Absent when the track failed - see errorCode/errorDescription. Never substitute a local
     *  transceiver mid for a missing one: that is what turned a reported failure into a silent
     *  one, leaving the participant marked subscribed and permanently inaudible. */
    mid?: string;
    trackName: string;
    sessionId?: string;
    location?: string;
    /** Cloudflare's per-track failure fields, relayed verbatim by the backend proxy. The proxy now
     *  answers a response containing these with a 502 rather than passing it off as a success, so
     *  in practice a failed track no longer reaches this client - they are declared because the
     *  wire contract carries them. */
    errorCode?: string;
    errorDescription?: string;
}

export interface CfTracksNewResponse {
    sessionDescription: RTCSessionDescriptionInit;
    tracks: CfTrackResult[];
    requiresImmediateRenegotiation: boolean;
}

export interface CfRenegotiateResponse {
    sessionDescription: RTCSessionDescriptionInit;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({providedIn: 'root'})
export class VoiceService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private readonly base = this.apiConfig.baseUrl() + '/api/v1/messaging/voice';

    // ── Existing endpoints ──────────────────────────────────────────────────

    createCall(createCallDto: CreateCallDto): Observable<CallDto> {
        return this.client.post<CallDto>(`${this.base}/call`, createCallDto);
    }

    acceptCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/accept`, {});
    }

    declineCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/decline`, {});
    }

    endCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/end`, {});
    }

    /** Authoritative current-state fetch - the catch-up path when a live
     *  `call.*` SignalR event may have been missed (e.g. a reconnect gap). */
    getCall(callId: string): Observable<CallDto> {
        return this.client.get<CallDto>(`${this.base}/call/${callId}`);
    }

    // ── Cloudflare Calls proxy endpoints ─────────────────────────────────────
    //
    // All CF Calls requests are proxied through the backend so the App ID and
    // App Secret never leave the server.  Base CF URL on the server side:
    //   https://rtc.live.cloudflare.com/v1/apps/{CF_APP_ID}/sessions/{cfSessionId}/...
    //
    // Auth header the backend must add: Authorization: Bearer {CF_APP_SECRET}

    // TODO(backend): POST /api/v1/messaging/voice/calls/{callId}/session
    //   → proxies to CF POST /sessions/new (no body)
    //   → stores the returned cfSessionId in the DB associated with userId + callId
    //   → returns { cfSessionId: string }
    /**
     * `primary` decides whether the backend runs this session through `Call.ConnectDevice`, which
     * is where device-takeover detection lives. The microphone is published from Rust on its own
     * session, so the webview's session is secondary - a second primary session for the same user
     * reads as a takeover and hangs up the call.
     */
    cfCreateSession(callId: string, primary = true): Observable<{ cfSessionId: string }> {
        return this.client.post<{ cfSessionId: string }>(
            `${this.base}/calls/${callId}/session?primary=${primary}`, {}
        );
    }

    // TODO(backend): POST /api/v1/messaging/voice/calls/{callId}/cf/tracks/new
    //   Body: { cfSessionId, sessionDescription: { type, sdp }, tracks: [CfTrackNew] }
    //   → proxies to CF POST /sessions/{cfSessionId}/tracks/new with the same body
    //     (minus cfSessionId which is in the URL on the CF side)
    //   → returns CF response as-is:
    //     { sessionDescription: { type, sdp }, tracks: [CfTrackResult], requiresImmediateRenegotiation }
    //   After a successful local-track publish, emit 'TrackPublished' via SignalR to other call members.
    cfTracksNew(callId: string, cfSessionId: string, body: CfTracksNewRequest): Observable<CfTracksNewResponse> {
        return this.client.post<CfTracksNewResponse>(
            `${this.base}/calls/${callId}/cf/tracks/new`,
            {cfSessionId, ...body}
        );
    }

    // TODO(backend): PUT /api/v1/messaging/voice/calls/{callId}/cf/renegotiate
    //   Body: { cfSessionId, sessionDescription: { type, sdp } }
    //   → proxies to CF PUT /sessions/{cfSessionId}/renegotiate
    //   → returns CF response: { sessionDescription: { type, sdp } }
    cfRenegotiate(
        callId: string,
        cfSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
    ): Observable<CfRenegotiateResponse> {
        return this.client.put<CfRenegotiateResponse>(
            `${this.base}/calls/${callId}/cf/renegotiate`,
            {cfSessionId, sessionDescription}
        );
    }

    // TODO(backend): PUT /api/v1/messaging/voice/calls/{callId}/cf/tracks/close
    //   Body: { cfSessionId, trackNames: string[] }
    //   → proxies to CF PUT /sessions/{cfSessionId}/tracks/close
    //     with { tracks: trackNames.map(t => ({ trackName: t })) }
    cfCloseTracks(callId: string, cfSessionId: string, trackNames: string[]): Observable<void> {
        return this.client.put<void>(
            `${this.base}/calls/${callId}/cf/tracks/close`,
            {cfSessionId, trackNames}
        );
    }
}
