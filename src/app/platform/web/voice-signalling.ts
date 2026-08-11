import type {HttpClient} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import type {VoiceTarget} from '../ports/voice-publisher.port';

/**
 * Voice signalling, spoken from the browser.
 *
 * <p>A line-for-line counterpart to `src-tauri/src/media/publisher/signalling.rs`, which is what the
 * Rust publisher speaks. The two have to agree exactly: a participant published from a browser and one
 * published from the desktop app are indistinguishable to everyone else, because all any subscriber
 * ever sees is `{mediaSessionId, trackName}`.</p>
 *
 * <h3>Two dialects, on purpose</h3>
 *
 * <p>Guild channels and DM calls moved to a backend-neutral contract (Echo `075c096`):
 * `mediaSessionId`, `direction: publish|subscribe`, and routes with no `cf/` in them. <b>Isle
 * deliberately did not</b> - it drives `CloudflareService` directly, has no room model, and was left
 * on the Cloudflare-shaped surface. So one client has to speak both, and the difference is not
 * incidental. Four things change together:</p>
 *
 * <ol>
 *   <li>the session-id field name (`mediaSessionId` vs `cfSessionId`), in the request <i>and</i> in
 *       the create-session response;</li>
 *   <li>the per-track direction key (`direction` vs `location`) <b>and its values</b>
 *       (`publish`/`subscribe` vs `local`/`remote`);</li>
 *   <li>the field naming the session a remote track is pulled <i>from</i> - `mediaSessionId` on the
 *       neutral surface, `sessionId` on Isle's, while the caller's own session sits under the
 *       top-level key on both;</li>
 *   <li>three of the four route suffixes, and the HTTP <i>method</i> of the close call - POST on the
 *       neutral surface, PUT on Isle's.</li>
 * </ol>
 *
 * <p>Sending the wrong vocabulary is not a loud failure: the neutral surface deserialises `direction`,
 * so a stray `location` leaves the direction null and the track is rejected by a route that exists,
 * which reads like an auth problem rather than a contract one.</p>
 *
 * <h3>Why the bodies are built by pure functions</h3>
 *
 * <p>The request shape is the part that is easy to get wrong and it is validated only by the real SFU,
 * which is the most expensive place to find out. Split out so every shape above is pinned by a test
 * that needs no network and no peer connection - the same reason `subscription_tracks` and
 * `publish_body` are split out on the Rust side.</p>
 */

/** Which vocabulary a surface speaks. See the module docs for why there are two. */
export type VoiceDialect = 'neutral' | 'cloudflare';

/**
 * The name every other client resolves a participant's microphone by.
 *
 * <p>Matches `media::voice::rtc::TRACK_NAME`. Changing it orphans every client on any other build,
 * desktop or web, because a subscriber asks for this name by string.</p>
 */
export const VOICE_TRACK_NAME = 'audio';

export interface SdpPayload {
    type: string;
    sdp: string;
}

export interface LocalTrackRef {
    mid: string;
    trackName: string;
}

export interface RemoteTrackRef {
    trackName: string;
    /** The session publishing it. */
    sessionId: string;
}

/**
 * One track in a `tracks` response.
 *
 * <p>`mid` is absent when the track failed. Never substitute a local transceiver's mid for a missing
 * one: that is what turned a reported failure into a silent one, leaving the participant marked
 * subscribed and permanently inaudible.</p>
 */
export interface TrackResultDto {
    mid?: string;
    trackName?: string;
    /** Neutral surface. */
    errorCode?: string;
    errorDescription?: string;
    /** What the Rust client reads; some relays flatten the SFU's own error to this. */
    error?: string;
}

export interface TracksResponseDto {
    sessionDescription: SdpPayload;
    tracks?: TrackResultDto[];
    requiresImmediateRenegotiation?: boolean;
}

export interface RenegotiateResponseDto {
    sessionDescription: SdpPayload;
}

/**
 * The create-session response, under either name.
 *
 * <p>`backend` is read but not acted on: this publisher speaks WebRTC to whatever answers and the SDP
 * exchange is the same shape either way. It exists so an unrecognised SFU is <i>loggable</i> rather
 * than silently assumed to be Cloudflare.</p>
 */
export interface CreateSessionDto {
    mediaSessionId?: string;
    cfSessionId?: string;
    backend?: string;
}

export function dialectFor(target: VoiceTarget): VoiceDialect {
    return target.kind === 'isle' ? 'cloudflare' : 'neutral';
}

/** The name of the "which session is this" field, in request bodies and in the session response. */
export function sessionKey(dialect: VoiceDialect): 'mediaSessionId' | 'cfSessionId' {
    return dialect === 'neutral' ? 'mediaSessionId' : 'cfSessionId';
}

/** The per-track direction key, and its two values. Not interchangeable - see the module docs. */
export function directionKey(dialect: VoiceDialect): 'direction' | 'location' {
    return dialect === 'neutral' ? 'direction' : 'location';
}

export function publishValue(dialect: VoiceDialect): 'publish' | 'local' {
    return dialect === 'neutral' ? 'publish' : 'local';
}

export function subscribeValue(dialect: VoiceDialect): 'subscribe' | 'remote' {
    return dialect === 'neutral' ? 'subscribe' : 'remote';
}

/** The field naming the session a remote track is pulled *from*. */
export function remoteSourceKey(dialect: VoiceDialect): 'mediaSessionId' | 'sessionId' {
    return dialect === 'neutral' ? 'mediaSessionId' : 'sessionId';
}

/**
 * Endpoint root, matching `Signalling::voice_base` and `GuildVoiceService.base()`.
 *
 * <p>These are <b>gateway</b> paths, not the backend controllers' own routes. YARP matches on a
 * service segment and then strips it (`/api/v1/guild/{**rest}` -> `/api/v1/{**rest}`), so the segment
 * after `v1` names the service and never appears in the controller route. Deriving these from the
 * controllers instead is how the call route came to be missing its `messaging/` segment - the DM path
 * 404'd at the gateway and never reached the service at all.</p>
 */
export function voiceBase(apiBase: string, target: VoiceTarget): string {
    const root = apiBase.replace(/\/+$/, '');
    switch (target.kind) {
        case 'guild':
            return `${root}/api/v1/guild/guilds/${target.guildId}/channels/${target.channelId}/voice`;
        case 'call':
            return `${root}/api/v1/messaging/voice/calls/${target.callId}`;
        case 'isle':
            return `${root}/api/v1/isle/voice`;
    }
}

/**
 * URL for opening this session.
 *
 * <p>`primary=true` is load-bearing: exactly one session per participant may be primary, and it is
 * the one the backend records as that participant's audio. The microphone <b>is</b> that session, so
 * unlike the screen publisher this one claims it. The webview's receive session passes
 * `primary=false` for the same reason (`voice-rtc.service.ts`).</p>
 *
 * <p>Isle is the exception on both counts: it opens at `cf/session` rather than `session`, and it has
 * no `primary` concept because a player has exactly one proximity session.</p>
 */
export function sessionUrl(apiBase: string, target: VoiceTarget): string {
    const base = voiceBase(apiBase, target);
    return target.kind === 'isle' ? `${base}/cf/session` : `${base}/session?primary=true`;
}

/** Where tracks are published and subscribed. Publish and subscribe share one route on both. */
export function tracksUrl(apiBase: string, target: VoiceTarget): string {
    const base = voiceBase(apiBase, target);
    return dialectFor(target) === 'neutral' ? `${base}/tracks` : `${base}/cf/tracks/new`;
}

export function negotiateUrl(apiBase: string, target: VoiceTarget): string {
    const base = voiceBase(apiBase, target);
    return dialectFor(target) === 'neutral' ? `${base}/negotiate` : `${base}/cf/renegotiate`;
}

export function closeTracksUrl(apiBase: string, target: VoiceTarget): string {
    const base = voiceBase(apiBase, target);
    return dialectFor(target) === 'neutral' ? `${base}/tracks/close` : `${base}/cf/tracks/close`;
}

/** The close verb differs too, not just the path. */
export function closeTracksMethod(dialect: VoiceDialect): 'post' | 'put' {
    return dialect === 'neutral' ? 'post' : 'put';
}

export function publishBody(
    dialect: VoiceDialect,
    sessionId: string,
    sessionDescription: SdpPayload,
    tracks: LocalTrackRef[],
): Record<string, unknown> {
    return {
        [sessionKey(dialect)]: sessionId,
        sessionDescription,
        tracks: tracks.map(t => ({
            [directionKey(dialect)]: publishValue(dialect),
            mid: t.mid,
            trackName: t.trackName,
        })),
    };
}

export function subscribeBody(
    dialect: VoiceDialect,
    sessionId: string,
    sessionDescription: SdpPayload,
    tracks: RemoteTrackRef[],
): Record<string, unknown> {
    return {
        [sessionKey(dialect)]: sessionId,
        sessionDescription,
        // No mid, deliberately - the SFU allocates it, and sending one is rejected.
        tracks: tracks.map(t => ({
            [directionKey(dialect)]: subscribeValue(dialect),
            trackName: t.trackName,
            [remoteSourceKey(dialect)]: t.sessionId,
        })),
    };
}

export function renegotiateBody(
    dialect: VoiceDialect,
    sessionId: string,
    sessionDescription: SdpPayload,
): Record<string, unknown> {
    return {[sessionKey(dialect)]: sessionId, sessionDescription};
}

export function closeTracksBody(
    dialect: VoiceDialect,
    sessionId: string,
    trackNames: string[],
): Record<string, unknown> {
    return {[sessionKey(dialect)]: sessionId, trackNames};
}

/**
 * The session id out of a create-session response, under whichever name it arrived.
 *
 * <p>Aliased rather than branched, matching `CreateSessionResponse`'s `#[serde(alias)]`: one field
 * means one thing to every caller, and the alias costs nothing.</p>
 */
export function sessionIdFrom(response: CreateSessionDto): string | null {
    return response.mediaSessionId ?? response.cfSessionId ?? null;
}

/**
 * A per-track failure, as a message, or null when the track is fine.
 *
 * <p>Checked on <b>every</b> track rather than only the first: a `tracks` call carries more than one
 * on a share with audio, and a 200 whose second track failed is exactly the shape that leaves one
 * participant permanently silent while every layer above reports success.</p>
 */
export function trackError(tracks: TrackResultDto[] | undefined): string | null {
    for (const track of tracks ?? []) {
        const message = track.error ?? track.errorCode;
        if (message) return `${message}${track.errorDescription ? `: ${track.errorDescription}` : ''}`;
    }
    return null;
}

/**
 * An HTTP client scoped to one voice channel, call or proximity session.
 *
 * <p><b>Neither `Authorization` nor `X-Device-Id` is set here</b>, and that is deliberate rather than
 * an omission. On this host both are stamped by the interceptor chain for every URL under
 * `ApiConfigService.baseUrl()` - `tokenInterceptor` and `deviceIdInterceptor` - and the token one also
 * refreshes an expired bearer and replays the request, which a token string captured at join time
 * cannot do. Setting the headers here would be overwritten by those interceptors anyway; the port
 * still takes `token` and `deviceId` because the Rust adapter genuinely has no interceptor chain and
 * must carry both itself.</p>
 */
export class VoiceSignalling {
    readonly dialect: VoiceDialect;

    constructor(
        private readonly http: HttpClient,
        private readonly apiBase: string,
        private readonly target: VoiceTarget,
    ) {
        this.dialect = dialectFor(target);
    }

    async createSession(): Promise<string> {
        const response = await firstValueFrom(
            this.http.post<CreateSessionDto>(sessionUrl(this.apiBase, this.target), {}),
        );
        // Logged rather than enforced: an unrecognised SFU is still WebRTC, and refusing to publish
        // over one we merely have not heard of would be a self-inflicted outage. But a silent
        // assumption is how a backend swap would present as "voice is broken".
        if (response.backend && response.backend !== 'cloudflare') {
            console.warn(`[voice] media session on an unfamiliar backend: ${response.backend}`);
        }
        const id = sessionIdFrom(response);
        if (!id) throw new Error('the voice session response carried no session id');
        return id;
    }

    publish(sessionId: string, sdp: SdpPayload, tracks: LocalTrackRef[]): Promise<TracksResponseDto> {
        return firstValueFrom(this.http.post<TracksResponseDto>(
            tracksUrl(this.apiBase, this.target),
            publishBody(this.dialect, sessionId, sdp, tracks),
        ));
    }

    subscribe(sessionId: string, sdp: SdpPayload, tracks: RemoteTrackRef[]): Promise<TracksResponseDto> {
        return firstValueFrom(this.http.post<TracksResponseDto>(
            tracksUrl(this.apiBase, this.target),
            subscribeBody(this.dialect, sessionId, sdp, tracks),
        ));
    }

    renegotiate(sessionId: string, sdp: SdpPayload): Promise<RenegotiateResponseDto> {
        return firstValueFrom(this.http.put<RenegotiateResponseDto>(
            negotiateUrl(this.apiBase, this.target),
            renegotiateBody(this.dialect, sessionId, sdp),
        ));
    }

    closeTracks(sessionId: string, trackNames: string[]): Promise<unknown> {
        const url = closeTracksUrl(this.apiBase, this.target);
        const body = closeTracksBody(this.dialect, sessionId, trackNames);
        return firstValueFrom(
            closeTracksMethod(this.dialect) === 'post'
                ? this.http.post(url, body)
                : this.http.put(url, body),
        );
    }
}
