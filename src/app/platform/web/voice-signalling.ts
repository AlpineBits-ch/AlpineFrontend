import type {HttpClient} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import type {VideoPublishIntentDto} from '../../dtos/response/entitlement.dto';
import type {VoiceTarget} from '../ports/voice-publisher.port';

/**
 * Voice signalling, spoken from the browser, in two dialects: guild channels and DM calls use the
 * backend-neutral contract, Isle stays on the Cloudflare-shaped surface. Sending the wrong
 * vocabulary fails as an auth-looking rejection, not a contract error.
 */

/** Which vocabulary a surface speaks. */
export type VoiceDialect = 'neutral' | 'cloudflare';

/**
 * The name every other client resolves a participant's microphone by. Must match
 * `media::voice::rtc::TRACK_NAME`; changing it orphans every client on any other build.
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
 * One track in a `tracks` response. `mid` is absent when the track failed; never substitute a local
 * transceiver's mid for a missing one.
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

/** The create-session response, under either name. `backend` is read for the log, never acted on. */
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

/** The per-track direction key, and its two values. The dialects are not interchangeable. */
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
 * Endpoint root, matching `Signalling::voice_base` and `GuildVoiceService.base()`. These are gateway
 * paths: the segment after `v1` names the service and never appears in the controller route.
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
 * URL for opening this session. `primary=true` is load-bearing: exactly one session per participant
 * may be primary, and the microphone is that session. Isle has no `primary` concept.
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

/**
 * The size a video publish is about to encode, when there is one to state. Neutral surface only,
 * and omitted rather than guessed when either axis is non-positive.
 */
function videoIntent(
    dialect: VoiceDialect,
    video: VideoPublishIntentDto | undefined,
): {video: VideoPublishIntentDto} | Record<string, never> {
    if (dialect !== 'neutral' || !video) return {};
    if (video.height <= 0 || video.framerate <= 0) return {};
    return {video};
}

export function publishBody(
    dialect: VoiceDialect,
    sessionId: string,
    sessionDescription: SdpPayload,
    tracks: LocalTrackRef[],
    video?: VideoPublishIntentDto,
): Record<string, unknown> {
    return {
        [sessionKey(dialect)]: sessionId,
        sessionDescription,
        tracks: tracks.map(t => ({
            [directionKey(dialect)]: publishValue(dialect),
            mid: t.mid,
            trackName: t.trackName,
        })),
        ...videoIntent(dialect, video),
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
        // No mid: the SFU allocates it, and sending one is rejected.
        tracks: tracks.map(t => ({
            [directionKey(dialect)]: subscribeValue(dialect),
            trackName: t.trackName,
            [remoteSourceKey(dialect)]: t.sessionId,
        })),
    };
}

/**
 * A renegotiation, optionally re-declaring what this session's video now is. `video` belongs here
 * only when this renegotiation is what changes the picture.
 */
export function renegotiateBody(
    dialect: VoiceDialect,
    sessionId: string,
    sessionDescription: SdpPayload,
    video?: VideoPublishIntentDto,
): Record<string, unknown> {
    return {
        [sessionKey(dialect)]: sessionId,
        sessionDescription,
        ...videoIntent(dialect, video),
    };
}

export function closeTracksBody(
    dialect: VoiceDialect,
    sessionId: string,
    trackNames: string[],
): Record<string, unknown> {
    return {[sessionKey(dialect)]: sessionId, trackNames};
}

/** The session id out of a create-session response, under whichever name it arrived. */
export function sessionIdFrom(response: CreateSessionDto): string | null {
    return response.mediaSessionId ?? response.cfSessionId ?? null;
}

/**
 * A per-track failure, as a message, or null when the track is fine. Must check every track, not
 * only the first.
 */
export function trackError(tracks: TrackResultDto[] | undefined): string | null {
    for (const track of tracks ?? []) {
        const message = track.error ?? track.errorCode;
        if (message) return `${message}${track.errorDescription ? `: ${track.errorDescription}` : ''}`;
    }
    return null;
}

/**
 * An HTTP client scoped to one voice channel, call or proximity session. Neither `Authorization` nor
 * `X-Device-Id` is set here: the interceptor chain stamps both.
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
        // Logged rather than enforced: an unrecognised SFU is still WebRTC.
        if (response.backend && response.backend !== 'cloudflare') {
            console.warn(`[voice] media session on an unfamiliar backend: ${response.backend}`);
        }
        const id = sessionIdFrom(response);
        if (!id) throw new Error('the voice session response carried no session id');
        return id;
    }

    publish(
        sessionId: string,
        sdp: SdpPayload,
        tracks: LocalTrackRef[],
        video?: VideoPublishIntentDto,
    ): Promise<TracksResponseDto> {
        return firstValueFrom(this.http.post<TracksResponseDto>(
            tracksUrl(this.apiBase, this.target),
            publishBody(this.dialect, sessionId, sdp, tracks, video),
        ));
    }

    subscribe(sessionId: string, sdp: SdpPayload, tracks: RemoteTrackRef[]): Promise<TracksResponseDto> {
        return firstValueFrom(this.http.post<TracksResponseDto>(
            tracksUrl(this.apiBase, this.target),
            subscribeBody(this.dialect, sessionId, sdp, tracks),
        ));
    }

    renegotiate(
        sessionId: string,
        sdp: SdpPayload,
        video?: VideoPublishIntentDto,
    ): Promise<RenegotiateResponseDto> {
        return firstValueFrom(this.http.put<RenegotiateResponseDto>(
            negotiateUrl(this.apiBase, this.target),
            renegotiateBody(this.dialect, sessionId, sdp, video),
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
