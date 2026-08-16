import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from "./api-config.service";
import {EntitlementDegradationDto, VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {VoiceRoomSnapshot, VoiceSubscriberUpdate, VoiceSubscriptionLayer} from '../models/voice-room';

// ── The SFU control plane ────────────────────────────────────────────────────
//
// Four routes, and none of them carries media state. The backend stopped being an SDP relay: it
// mints a token saying who may send what, and afterwards it is told what was published so the
// roster, the share viewer counts and the usage meter can see it. The negotiation belongs to the
// SDK and the node, so nothing below has an offer, an answer or a session id in it.
//
// The same four shapes serve guild channels and direct calls, and are declared here once - see
// `voice.service.ts`, which imports them rather than restating them.

/**
 * Everything needed to open a connection to the SFU: which node, as whom, and with what rights.
 *
 * <p><b>Never cache {@link url} against a room id.</b> There is no shared hostname in front of the
 * fleet - a room lives on exactly one node and this field is the routing answer, so a URL kept from
 * an earlier room is a connection to the wrong machine. Re-fetching is cheap: it does not touch the
 * roster, does not re-announce anybody, and disturbs no connection already held.</p>
 *
 * <p>{@link token} is short-lived (ten minutes by default) and is only read while the WebSocket is
 * opened, so an expiry mid-call is not an event. Ask again on an auth refusal or after a gap longer
 * than the TTL, never once per attempt of a reconnect ladder.</p>
 */
export interface VoiceConnectionDto {
    /** The SFU behind this room. Read for logging; an unrecognised value means "I cannot handle
     *  this room" rather than "assume the one I know". */
    backend: string;
    url: string;
    token: string;
    room: string;
    /**
     * How the SFU names this connection: the bare user id on a primary, `{userId}#{tag}` on a
     * secondary. Splitting on the first `#` always recovers the user - ids are Sqids and never
     * contain one - so a remote participant maps to a user without consulting the snapshot.
     */
    identity: string;
    /** The same string as {@link identity}, under the name the roster and snapshot already use. */
    mediaSessionId: string;
    expiresAt: string;
    /**
     * What the token actually grants, and what the microphone and camera buttons render from.
     *
     * <p>Not a locally computed permission. The rights are decided when the token is minted and
     * enforced by the node, so a member whose plan has no video left connects, hears everyone, and
     * cannot turn a camera on however the client is patched. A button drawn from our own arithmetic
     * would be a button that does nothing.</p>
     */
    canPublishAudio: boolean;
    canPublishVideo: boolean;
}

/** What was just published, in the track naming the roster and the peers agree on. */
export interface VoicePublishRequest {
    trackNames: string[];
    /**
     * What this client intends to send, so the server can clamp it rather than guess.
     *
     * <p>Optional and only read when the body carries video - the video ceiling has never had
     * anything to say about a microphone. Absent means "whatever the room allows".</p>
     */
    video?: VideoPublishIntentDto;
}

/**
 * What the room will let out of this publisher.
 *
 * <p>The media does not depend on this call - the SDK is already publishing by the time it is made -
 * but nothing else in the product can see the publication until it lands.</p>
 */
export interface VoicePublishResponse {
    identity: string;
    /** The rung the server settled on, or null for an audio-only publish. */
    rung: string | null;
    height: number | null;
    framerate: number | null;
    /**
     * The best layer of our video the room will distribute to anyone, or null - the ordinary case -
     * for a publish nothing caps.
     *
     * <p>Non-null means we declared above our rung: still publishing, but no viewer is served above
     * this layer however large their tile. Re-encode to {@link rung}, declare it again, and it goes
     * back to null.</p>
     */
    maxLayer: VoiceSubscriptionLayer | null;
    /**
     * What the server gave less of than was asked for, on an otherwise ordinary `200`.
     *
     * <p>The publish <b>succeeded</b>; this says it succeeded smaller, and the client re-encodes to
     * `granted.rung` rather than arguing. Absent and empty mean the same thing and are the normal
     * case. The other answer to handle is a `403`, which is a refusal that could not degrade at all:
     * stop the local track, because the token this client connected with does not permit it either
     * and nobody will receive it whatever is retried.</p>
     */
    degradations?: EntitlementDegradationDto[];
}

/**
 * The answer to a resolution change declared without republishing.
 *
 * <p>It refuses nothing - the ceiling is applied to what leaves the room rather than to what enters
 * it - so there is no error path here and {@link maxLayer} is the whole of what it says.</p>
 */
export interface VoiceVideoDeclarationResponse {
    changed: boolean;
    maxLayer: VoiceSubscriptionLayer | null;
}

/**
 * The query string for a connection request, shared by both room kinds.
 *
 * <p>An absent tag is left off rather than sent empty: anything that survives stripping as empty
 * falls back to `alt` server-side, so an unconditional `&tag=` would hand every tagless secondary
 * connection the same identity - and identical identities evict one another.</p>
 */
export function connectionQuery(primary: boolean, tag?: string): string {
    const tagged = tag ? `&tag=${encodeURIComponent(tag)}` : '';
    return `?primary=${primary}${tagged}`;
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
     * Asserts over HTTP that this device is still in the room - the liveness signal that survives
     * SignalR being down.
     *
     * <p>Deliberately not the hub. `voice.Heartbeat` is our only other liveness channel, and it
     * rides the same connection whose loss it would have to report: a hub outage that outlasts the
     * 90s eviction sweep takes voice down with it while the media is still flowing perfectly. This
     * route exists precisely so the two failure modes are independent, and it is why the sweep can
     * be trusted to mean "gone" rather than "the socket blinked".</p>
     *
     * <p>A `404` or a `409` is the answer that matters: the server does not place this device in
     * this room, and the caller should tear the room down locally. Every other failure is transient
     * and must be ignored - see {@link VoiceLivenessService}, which owns that distinction and the
     * cadence.</p>
     */
    alive(guildId: string, channelId: string): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/alive`, {});
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
     * Everything needed to connect to the SFU, minted fresh every time it is asked for.
     *
     * <p>Taking a connection does not make anybody audible: this is `Joined`, not `Publishing`, until
     * a track exists and {@link publish} has declared it.</p>
     *
     * @param primary whether this connection carries the microphone. `false` is for a *second*
     *        connection opened alongside it - the webview's video-only room beside the Rust one.
     *        The SFU keys participants by identity and evicts an earlier session that reappears
     *        under the same one, so a secondary connection minted as primary kicks this user's own
     *        call off the air.
     * @param tag what distinguishes that second identity. Free-form: stripped to letters and digits,
     *        truncated to 32, falling back to `alt`. One tag per connection per user - two
     *        connections sharing a tag share an identity, and the second evicts the first.
     */
    connection(guildId: string, channelId: string, primary = true, tag?: string)
        : Observable<VoiceConnectionDto> {
        return this.client.post<VoiceConnectionDto>(
            `${this.base(guildId, channelId)}/connection${connectionQuery(primary, tag)}`, {});
    }

    /**
     * Declares what was just published, which is what puts this client on the roster as publishing.
     *
     * <p>Two answers carry meaning beyond success. A `200` with `degradations` is a publish that
     * <b>worked, smaller</b>: re-encode to the granted rung and declare again, and roll nothing back.
     * A `403` is a refusal that could not degrade - stop the local track, because the token this
     * client connected with does not permit it either, so nobody receives it whatever is retried.</p>
     */
    publish(guildId: string, channelId: string, body: VoicePublishRequest)
        : Observable<VoicePublishResponse> {
        return this.client.post<VoicePublishResponse>(`${this.base(guildId, channelId)}/publish`, body);
    }

    /** Marks the tracks closed so peers drop them rather than waiting on media that has ended. */
    unpublish(guildId: string, channelId: string, trackNames: string[]): Observable<void> {
        return this.client.post<void>(`${this.base(guildId, channelId)}/unpublish`, {trackNames});
    }

    /**
     * Re-declares what is being sent, for a change made without republishing.
     *
     * <p>A ceiling computed once at publish time is one a later resolution change walks straight
     * past - a share that switches source, a camera that comes back at a different size - and this
     * is the only thing that tells the server about it. <b>It never refuses anything</b>: the cap
     * applies to what leaves the room, which needs no cooperation from here.</p>
     *
     * <p>An unchanged resolution needs no call at all. Declaring nothing leaves the ceiling exactly
     * where the last publish put it, so silence is not a claim in either direction.</p>
     */
    declareVideo(guildId: string, channelId: string, video: VideoPublishIntentDto)
        : Observable<VoiceVideoDeclarationResponse> {
        return this.client.put<VoiceVideoDeclarationResponse>(
            `${this.base(guildId, channelId)}/video`, video);
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
