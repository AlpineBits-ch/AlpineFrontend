import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {CallDto} from '../dtos/response/call.dto';
import {OngoingCallDto} from '../dtos/response/ongoing-call.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {CreateCallDto} from '../dtos/request/create-call.dto';
import {VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {ApiConfigService} from "./api-config.service";
import {VoiceRoomSnapshot, VoiceSubscriberUpdate} from '../models/voice-room';
import {
    connectionQuery,
    VoiceConnectionDto,
    VoicePublishRequest,
    VoicePublishResponse,
    VoiceVideoDeclarationResponse,
} from './guild-voice.service';

// ── Voice media DTOs ─────────────────────────────────────────────────────────
//
// Imported rather than restated. A call room and a guild channel are the same room model behind the
// same neutral contract - the server produces both from the same code - so a second copy of these
// shapes here would only be a second place for them to drift.

export type {
    VoiceConnectionDto,
    VoicePublishRequest,
    VoicePublishResponse,
    VoiceVideoDeclarationResponse,
} from './guild-voice.service';

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
     * Everything needed to connect to the SFU for this call, minted fresh every time it is asked
     * for - taking one is `Joined`, not `Publishing`, until {@link publish} declares a track.
     *
     * <p>Never cache the returned `url` against a call id: a room lives on exactly one node and that
     * field is the routing answer. Re-fetching is cheap and touches neither the roster nor a
     * connection already held, so the rule is to ask again rather than to keep one.</p>
     *
     * @param primary whether this connection carries the microphone. `false` for a second connection
     *        opened beside it: the SFU keys participants by identity and evicts an earlier session
     *        that reappears under the same one, so a secondary connection minted as primary hangs up
     *        this user's own call.
     * @param tag what distinguishes that second identity - stripped to letters and digits, truncated
     *        to 32, falling back to `alt`. One tag per connection per user.
     */
    connection(callId: string, primary = true, tag?: string): Observable<VoiceConnectionDto> {
        return this.client.post<VoiceConnectionDto>(
            `${this.base}/calls/${callId}/connection${connectionQuery(primary, tag)}`, {}
        );
    }

    /**
     * Declares what was just published, which is what puts this client on the call's roster as
     * publishing.
     *
     * <p>Two answers carry meaning beyond success. A `200` with `degradations` is a publish that
     * <b>worked, smaller</b>: re-encode to the granted rung and declare again, rolling nothing back.
     * A `403` is a refusal that could not degrade - stop the local track, because the token this
     * client connected with does not permit it either and nobody will receive it.</p>
     */
    publish(callId: string, body: VoicePublishRequest): Observable<VoicePublishResponse> {
        return this.client.post<VoicePublishResponse>(`${this.base}/calls/${callId}/publish`, body);
    }

    /** Marks the tracks closed so peers drop them rather than waiting on media that has ended. */
    unpublish(callId: string, trackNames: string[]): Observable<void> {
        return this.client.post<void>(`${this.base}/calls/${callId}/unpublish`, {trackNames});
    }

    /**
     * Re-declares what is being sent, for a change made without republishing.
     *
     * <p>A ceiling computed once at publish time is one a later resolution change walks straight
     * past, and this is the only thing that tells the server about it. <b>It never refuses
     * anything</b> - the cap applies to what leaves the room - and an unchanged resolution needs no
     * call at all, since declaring nothing leaves the ceiling where the last publish put it.</p>
     */
    declareVideo(callId: string, video: VideoPublishIntentDto): Observable<VoiceVideoDeclarationResponse> {
        return this.client.put<VoiceVideoDeclarationResponse>(
            `${this.base}/calls/${callId}/video`, video);
    }

    /**
     * Asserts over HTTP that this device is still in the call - the liveness signal that survives
     * SignalR being down.
     *
     * <p>The call-side twin of `GuildVoiceService.alive`, and on the media routes, so plural
     * `calls/`. `voice.Heartbeat` rides the very connection whose loss it would have to report, so
     * a hub outage that outlasts the 90s eviction sweep hangs the call up while the media is still
     * flowing. This route is the independent channel that stops that happening.</p>
     *
     * <p>`404`/`409` means the server does not place this device in this call and the room should
     * be torn down locally; anything else is transient. {@link VoiceLivenessService} owns that
     * distinction and the cadence.</p>
     */
    alive(callId: string): Observable<void> {
        return this.client.post<void>(`${this.base}/calls/${callId}/alive`, {});
    }

    /**
     * Tells the server what this client can actually see - see
     * {@link VoiceSubscriberReportService}, which is the only caller.
     *
     * <p>On the media routes, so plural `calls/` - the same route shape and the same body as the
     * guild side, because it is the same operation on the same room model.</p>
     *
     * <p>The reply is this client's own subscription set, typed as `unknown` because nothing here
     * consumes it: Alpine does not implement selective subscription.</p>
     */
    updateSubscriber(callId: string, update: VoiceSubscriberUpdate): Observable<unknown> {
        return this.client.post(`${this.base}/calls/${callId}/subscriptions`, update);
    }
}
