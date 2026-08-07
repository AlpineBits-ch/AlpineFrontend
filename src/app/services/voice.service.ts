import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {CallDto} from '../dtos/response/call.dto';
import {OngoingCallDto} from '../dtos/response/ongoing-call.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {CreateCallDto} from '../dtos/request/create-call.dto';
import {ApiConfigService} from "./api-config.service";
import {VoiceRoomSnapshot} from '../models/voice-room';

// ── Voice media DTOs ─────────────────────────────────────────────────────────
//
// Backend-neutral: no SFU vocabulary reaches this client any more. The session response names its
// backend so a client can refuse a room it cannot handle, and everything else - routes, bodies,
// responses - is the same whichever SFU is behind it.

export interface CfTrackNew {
    /** What this caller is doing, rather than where the media sits. */
    direction: 'publish' | 'subscribe';
    mid?: string;       // publish: set after RTCPeerConnection.setLocalDescription
    trackName?: string; // publish: the name to publish under; subscribe: the name to pull
    mediaSessionId?: string; // subscribe: the session publishing it
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
    mediaSessionId?: string;
    /** Per-track failure fields. The backend answers a response containing these with a 502 rather
     *  than passing it off as a success, so in practice a failed track no longer reaches this
     *  client - they are declared because the wire contract carries them. */
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

    /**
     * Ends the call for everyone. No UI action reaches this any more - the single hang-up button
     * means {@link leaveCall}. Kept because the endpoint exists and the app may grow a host
     * action; there is no host concept today.
     */
    endCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/end`, {});
    }

    /**
     * Removes only the local user. Dropping to zero connected participants ends the call
     * server-side; dropping to one starts a grace period before it is force-ended.
     *
     * This is what hanging up now does, and it is the fix for the decline-here/end-there bug:
     * leaving on one device no longer tears the call down for everyone else.
     */
    leaveCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/leave`, {});
    }

    /** Authoritative current-state fetch - the catch-up path when a live
     *  `call.*` SignalR event may have been missed (e.g. a reconnect gap). */
    getCall(callId: string): Observable<CallDto> {
        return this.client.get<CallDto>(`${this.base}/call/${callId}`);
    }

    /**
     * The call's media state: who is pullable, on which session, and which screen-share tracks are
     * live right now.
     *
     * <p>Distinct from {@link getCall}, which carries the ring lifecycle (status, invitees,
     * decline) and no media handles at all. Identical in shape to the guild-channel snapshot,
     * because the server produces both from the same code.</p>
     */
    getCallSnapshot(callId: string): Observable<VoiceRoomSnapshot> {
        return this.client.get<VoiceRoomSnapshot>(`${this.base}/call/${callId}/snapshot`);
    }

    /**
     * The call ringing for this user right now, or `null` when none is - the server answers 204,
     * which Angular hands back as a null body.
     *
     * `call.IncomingCall` is broadcast once and never replayed, so a client that was not connected
     * at that moment - the app opened while somebody was already calling, or a socket that
     * reconnected after the fact - never learns it is being called at all. This is the catch-up
     * read for that, and the incoming-call counterpart to {@link getCall}.
     */
    getPendingCall(): Observable<CallDto | null> {
        return this.client.get<CallDto | null>(`${this.base}/call/pending`);
    }

    /**
     * The call going on in this conversation right now, or `null` (the server answers 204).
     *
     * Distinct from {@link getPendingCall}, which answers only for someone this call is *ringing*.
     * This answers for any member of the conversation - including one who declined, one who left,
     * and one who was never invited - and is what the "join the call" banner reads.
     */
    getConversationCall(conversationId: string): Observable<OngoingCallDto | null> {
        return this.client.get<OngoingCallDto | null>(
            `${this.base}/conversations/${conversationId}/call`
        );
    }

    // ── Screen share viewers ─────────────────────────────────────────────────

    /**
     * Announces this client as watching `shareId`, or refreshes that claim.
     *
     * The claim expires server-side after 90s, so this has to be re-sent on a timer for as long as
     * the stream is on screen - a subscribe on the SFU is not a watch signal, since nothing obliges
     * a client to tear one down.
     */
    watchShare(callId: string, shareId: string): Observable<ShareViewersDto> {
        return this.client.post<ShareViewersDto>(
            `${this.base}/call/${callId}/shares/${shareId}/watch`, {}
        );
    }

    unwatchShare(callId: string, shareId: string): Observable<ShareViewersDto> {
        return this.client.delete<ShareViewersDto>(
            `${this.base}/call/${callId}/shares/${shareId}/watch`
        );
    }

    /** Everyone watching each live share in this call - the catch-up read for joining mid-stream. */
    getShareViewers(callId: string): Observable<Record<string, string[]>> {
        return this.client.get<Record<string, string[]>>(`${this.base}/call/${callId}/shares/viewers`);
    }

    // ── Voice media endpoints ────────────────────────────────────────────────
    //
    // Note the plural `calls/` here against the singular `call/` on the lifecycle routes above.
    // That is historical and both are correct; getting it backwards 404s at the gateway.

    /**
     * `primary` decides whether the backend runs this session through `Call.ConnectDevice`, which
     * is where device-takeover detection lives. The microphone is published from Rust on its own
     * session, so the webview's session is secondary - a second primary session for the same user
     * reads as a takeover and hangs up the call.
     */
    cfCreateSession(callId: string, primary = true): Observable<{ mediaSessionId: string; backend?: string }> {
        return this.client.post<{ mediaSessionId: string; backend?: string }>(
            `${this.base}/calls/${callId}/session?primary=${primary}`, {}
        );
    }

    /** Publish and subscribe are one route; `direction` on each track says which. */
    cfTracksNew(callId: string, mediaSessionId: string, body: CfTracksNewRequest): Observable<CfTracksNewResponse> {
        return this.client.post<CfTracksNewResponse>(
            `${this.base}/calls/${callId}/tracks`,
            {mediaSessionId, ...body}
        );
    }

    cfRenegotiate(
        callId: string,
        mediaSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
    ): Observable<CfRenegotiateResponse> {
        return this.client.put<CfRenegotiateResponse>(
            `${this.base}/calls/${callId}/negotiate`,
            {mediaSessionId, sessionDescription}
        );
    }

    /** POST, not PUT - the close verb changed with the route. */
    cfCloseTracks(callId: string, mediaSessionId: string, trackNames: string[]): Observable<void> {
        return this.client.post<void>(
            `${this.base}/calls/${callId}/tracks/close`,
            {mediaSessionId, trackNames}
        );
    }
}
