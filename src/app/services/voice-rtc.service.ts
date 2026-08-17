import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ConnectionState} from 'livekit-client';
import {firstValueFrom, Subject} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {OAuthService} from 'angular-oauth2-oidc';
import {bitrateFor, clampPreset, DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';
import {VoiceLimitsService} from './voice-limits.service';
import {solveGeometry} from '../models/capture-geometry';
import {publishOptions} from './screen-publish';
import {describeTrack, MICROPHONE_TRACK, screenAudioTrackName, screenTrackName} from '../models/voice-room';
import {VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {VoiceEngineService, VoiceSession, VoiceTarget} from './voice-engine.service';
import {ScreenPickerChoice} from './screen-picker.service';
import {LiveKitRoomService} from './livekit-room.service';
import {inboundScreenFpsByUser, InboundTrackOwner} from '../shared/call/inbound-fps';
import {inboundStatsFor, kbpsBetween} from '../shared/call/stream-stats';
import type {StreamStatsSample, StreamStatsSnapshot} from '../shared/call/stream-stats';

export interface VoiceSpeakingChange {
    userId: string;
    isSpeaking: boolean;
}

/** One connection per user per tag: a reused tag shares an identity and the second evicts the first, so never reuse this string for a second webview room. The Rust room connects as the bare user id beside it. */
const VIEW_TAG = 'view';

/** The name a camera is published under: never `audio` and never prefixed `screen-`, because {@link describeTrack} reads anything else as a camera. */
export const CAMERA_TRACK = 'camera';

/** Backoff between subscribe retries, in ms: a roster announcement can beat the SFU's `TrackPublished`, and an announcement is never repeated. */
export const SUBSCRIBE_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/** How this client's `RTCPeerConnectionState` reads off the room's connection state. */
const PC_STATE_BY_CONNECTION: Readonly<Record<ConnectionState, RTCPeerConnectionState>> = {
    [ConnectionState.Disconnected]: 'new',
    [ConnectionState.Connecting]: 'connecting',
    [ConnectionState.Connected]: 'connected',
    [ConnectionState.Reconnecting]: 'connecting',
    [ConnectionState.SignalReconnecting]: 'connecting',
};

/** The half of a room wrapper this service needs and {@link LiveKitRoomService} does not carry yet. */
export interface RoomPublishing {
    /** Every publication this user holds, subscribed or not, so a roster row can find its sid. */
    publicationsOf(userId: string): readonly {trackSid: string; trackName: string}[];
    /** Publishes a local track under the name the roster and the peers agree on. */
    publishTrack(track: MediaStreamTrack, trackName: string): Promise<void>;
    unpublishTrack(trackName: string): Promise<void>;
}

/** What a video publish is about to send, read off the settings the device actually opened at; undefined when either half is unknown, which omits the field. */
export function trackIntent(track: MediaStreamTrack): VideoPublishIntentDto | undefined {
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
    const height = settings?.height;
    const framerate = settings?.frameRate;
    if (!height || height <= 0 || !framerate || framerate <= 0) return undefined;
    return {height, framerate: Math.round(framerate)};
}

/** The detailed inbound snapshot for one inspected user's screen stream, keyed by user rather than by share. */
export function detailedStatsFor(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
    userId: string | null,
): StreamStatsSample | null {
    for (const [mid, owner] of tracks) {
        if (owner.kind === 'screen' && owner.userId === userId) return inboundStatsFor(report, mid);
    }
    return null;
}

/** The mid a per-track statistics report files its inbound stream under. */
export function midOfReport(report: {forEach(callback: (stat: RTCStats) => void): void}): string | null {
    let mid: string | null = null;
    report.forEach(stat => {
        if (mid !== null) return;
        const s = stat as unknown as Record<string, unknown>;
        if (s['type'] === 'inbound-rtp' && s['kind'] === 'video' && typeof s['mid'] === 'string') {
            mid = s['mid'] as string;
        }
    });
    return mid;
}

export interface StaleSubscription {
    /** Whose track we asked for, when it is known. */
    userId?: string;
}

@Injectable({providedIn: 'root'})
export class VoiceRTCService {
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private readonly livekit = inject(LiveKitRoomService);

    /** True once the Rust engine is capturing and publishing. See {@link rtcState}. */
    private readonly engineUp = signal(false);

    /** What the voice UI shows as the connection state: the Rust engine stands in while the room has nothing on it. */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const state = PC_STATE_BY_CONNECTION[this.livekit.state()] ?? 'new';
        return state === 'new' && this.engineUp() ? 'connected' : state;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    readonly localVideoStream = signal<MediaStream | null>(null);
    readonly localScreenStream = signal<MediaStream | null>(null);

    /** What the token this client connected with grants. Both default to true, so a room whose connection has not landed yet does not read as forbidding everything. */
    readonly canPublishAudio = signal(true);
    readonly canPublishVideo = signal(true);

    // ── Signals ────────────────────────────────────────────────────────────────
    readonly localScreenHasAudio = signal<boolean>(false);
    readonly localScreenAudioMuted = signal<boolean>(false);
    readonly screenEnded$ = new Subject<void>();
    private readonly staleSubscriptionSignal = new Subject<StaleSubscription>();
    /** "Your roster is out of date": the room service refetches the snapshot and reconciles. */
    readonly staleSubscription$ = this.staleSubscriptionSignal.asObservable();
    private guildVoiceSvc = inject(GuildVoiceService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private voiceEngine = inject(VoiceEngineService);
    private screenPicker = inject(ScreenPickerService);
    private readonly videoStreamsSignal = signal<Map<string, MediaStream>>(new Map());
    readonly videoStreams = this.videoStreamsSignal.asReadonly();
    private readonly screenStreamsSignal = signal<Map<string, MediaStream>>(new Map());
    readonly screenStreams = this.screenStreamsSignal.asReadonly();

    // ── Observables for cross-service events ───────────────────────────────────
    private readonly screenAudioMutedSignal = signal<Set<string>>(new Set());
    readonly screenAudioMuted = this.screenAudioMutedSignal.asReadonly();

    // ── Room state ─────────────────────────────────────────────────────────────
    /** The Rust publication carrying this channel's audio. */
    private voiceSession: VoiceSession | null = null;
    /** What {@link connect} was called with. Cleared by {@link teardown}: a declaration firing after we left would announce a track into a channel this client is no longer in. */
    private voiceTarget: {guildId: string; channelId: string} | null = null;
    private setupDone = false;
    /** Said once per session rather than per call - see {@link RoomPublishing}. */
    private warnedMissingRoomSurface = false;
    /** The connection the microphone publishes on: the screen share must land on this same participant, and {@link teardown} clears it because a room lives on one node. */
    private primaryConnection: {url: string; token: string} | null = null;

    private localVideoTrack: MediaStreamTrack | null = null;
    private screenShareId: string | null = null;

    /** Remote screen shares' arriving frame rate, by user id. */
    private readonly inboundVideoFpsSignal = signal<Record<string, number>>({});
    readonly inboundVideoFps = this.inboundVideoFpsSignal.asReadonly();
    private statsInterval?: ReturnType<typeof setInterval>;

    /** Which stream the open stats panel is reading. This service uses `userId` and ignores `shareId`. */
    readonly inspected = signal<{shareId: string; userId: string} | null>(null);
    readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);

    /** The previous poll's cumulative `bytesReceived`, per layer, and when it was taken. Cleared in {@link stopStatsPolling}, or a reopened panel differentiates against the previous connection's counter. */
    private prevInboundBytes = new Map<string, number>();
    private prevInboundAt = 0;

    // Per-user volume, 0-1. The slider position lives here; the gain it produces lives in Rust.
    private readonly userVolumes = new Map<string, number>();

    // Per-share volume, 0-1. Its own map: a stream's audio is a different mixer source than its author's voice, and the two must stay adjustable independently.
    private readonly screenVolumes = new Map<string, number>();

    // userId → the mixer source id of their stream's audio, so the per-stream mute can find it.
    private readonly remoteScreenAudioIds = new Map<string, string>();

    // Mixer source id → the publishing identity we are currently pulling it from, so a corrected announcement resubscribes rather than being skipped as a duplicate.
    private readonly subscribedAudioSessions = new Map<string, string>();

    // Mixer source id → a token for the newest subscribe attempt, so a retry that is still sleeping can tell it has been superseded and stop.
    private readonly subscribeTokens = new Map<string, number>();

    // Mixer source id → the tail of that source's engine operations. Every subscribe/unsubscribe for one source must run to completion before the next starts, or concurrent announcements leave the engine with no route while a subscription is recorded, and it never repairs.
    private readonly audioOps = new Map<string, Promise<unknown>>();

    /** Track name → whose video the roster says it is: an intent, not a record of what is subscribed, because an announcement is never repeated and its sid may not be knowable yet. */
    private readonly wantedVideo = new Map<string, {userId: string; kind: 'video' | 'screen'}>();

    /** Quality of the running screen share, or null when not sharing. */
    readonly screenPreset = signal<StreamPreset | null>(null);
    /** Dimensions of the captured source: a mid-stream resolution change must re-solve from this, since re-solving from the current output geometry ratchets the picture down on every change. */
    private screenSourceSize: {width: number; height: number} | null = null;
    /** True while the running share is owned by the screen publisher rather than by this service. */
    private rustPublishing = false;
    /** The picker choice behind the running publish, so a resolution change can rebuild it. */
    private rustChoice: ScreenPickerChoice | null = null;
    /** The audio track the Rust publisher actually opened, or null for a video-only share: "asked for audio" and "has audio" are different facts. */
    private rustAudioTrackName: string | null = null;
    private readonly oauth = inject(OAuthService);
    /** The room's ceilings, and where a clamp or a refusal on a publish is filed. */
    private readonly voiceLimits = inject(VoiceLimitsService);

    constructor() {
        // A share can end without anything in the app asking it to, so it is forwarded into the same subject a user-pressed stop unwinds through.
        // Guarded on `rustPublishing`: `RustMediaService` is a singleton shared with the 1:1 call path, so `publishEnded$` fires for whichever publish ended, not for ours.
        this.rustMedia.publishEnded$.pipe(takeUntilDestroyed()).subscribe(() => {
            if (this.rustPublishing) this.screenEnded$.next();
        });

        // Re-arms the poll when a stats panel opens or closes. Runs only when the connection is
        // already polling; there is nothing to re-arm otherwise.
        effect(() => {
            this.inspected();
            if (this.statsInterval !== undefined) this.armStatsInterval();
        });

        // Rebuilt wholesale on every change: a track that goes has to leave both maps, and the room's own map is already the authority on which are still held.
        effect(() => this.projectRemoteStreams());

        // The roster's word and the room's sid arrive over different transports, so whichever is second has to re-run the diff.
        // `untracked`, because reconciling reads `remoteTracks` and subscribing writes it: tracked, this effect would re-run itself for as long as anything changed.
        effect(() => {
            this.livekit.publications();
            untracked(() => this.applySubscriptions());
        });
    }

    // ── Connection setup / teardown ────────────────────────────────────────────

    async connect(guildId: string, channelId: string): Promise<boolean> {
        this.setupDone = false;

        // Start the microphone first: if it is unavailable there is nothing worth joining for.
        // Sending and receiving are independent, so a wedged engine must never be able to hold up subscriptions on the receive side.
        this.voiceTarget = {guildId, channelId};
        try {
            // Primary, and with no tag: this connection is what the roster records as the participant, so it takes the bare user id.
            const primary = await firstValueFrom(this.guildVoiceSvc.connection(guildId, channelId, true));
            this.primaryConnection = {url: primary.url, token: primary.token};
            // From the connection that would enforce it. The microphone publishes on this one, so
            // this is the reply that decides whether the button can do anything.
            this.canPublishAudio.set(primary.canPublishAudio);

            this.voiceSession = await this.startEngine(
                {kind: 'guild', guildId, channelId},
                await this.deviceIdentity.deviceId(),
                this.primaryConnection,
            );
            this.engineUp.set(true);

            // Declare the microphone: until this lands the server has no record of this participant publishing, and other clients skip their tracks entirely.
            // Not fatal if it fails; the heartbeat asserts the same state every 30 seconds and repairs it.
            await firstValueFrom(
                this.guildVoiceSvc.publish(guildId, channelId, {trackNames: [MICROPHONE_TRACK]}),
            ).catch(e => console.error('[voice] could not declare the microphone', e));
        } catch (e) {
            console.error('[voice] Rust voice engine failed to start', e);
            this.setupDone = true;
            return false;
        }

        await this.openViewRoom(guildId, channelId);
        this.setupDone = true;
        return true;
    }

    /**
     * Join the room as this webview's own secondary connection.
     *
     * Its own fetch, never the microphone's: one connection handed to both puts two clients on one identity, and the SFU disconnects the earlier session.
     * The URL is passed straight through and never cached against a room id, because a room lives on exactly one node.
     */
    private async openViewRoom(guildId: string, channelId: string): Promise<void> {
        try {
            const connection = await firstValueFrom(
                this.guildVoiceSvc.connection(guildId, channelId, false, VIEW_TAG),
            );
            // The camera publishes on this connection, so this is the reply that decides whether its button can do anything.
            this.canPublishVideo.set(connection.canPublishVideo);
            await this.livekit.connect({url: connection.url, token: connection.token});
            this.startStatsPolling();
            // Anything announced while the connection was in flight is waiting in `wantedVideo`.
            this.applySubscriptions();
        } catch (e) {
            console.error('[voice] could not join the room for video', e);
        }
    }

    /** Start the microphone on the connection this client just fetched. */
    private startEngine(
        target: VoiceTarget,
        deviceId: string,
        livekit: {url: string; token: string},
    ): Promise<VoiceSession> {
        // Called directly, never through a cast: a cast turns a forgotten connection from a compile error into a 404 three layers down inside Rust.
        return this.voiceEngine.start(
            target,
            this.apiConfig.baseUrl(),
            this.oauth.getAccessToken(),
            deviceId,
            livekit,
        );
    }

    /** The publish half of the room, or an empty object when the wrapper does not carry it. See {@link RoomPublishing}. */
    private get roomMedia(): Partial<RoomPublishing> {
        const room = this.livekit as unknown as Partial<RoomPublishing>;
        if (!this.warnedMissingRoomSurface && typeof room.publishTrack !== 'function') {
            this.warnedMissingRoomSurface = true;
            console.error(
                '[voice] the room wrapper carries no publish/publications surface - ' +
                    'cameras cannot be published and roster rows cannot be resolved to track sids',
            );
        }
        return room;
    }

    // ── Stats polling ────────────────────────────────────────────────────────

    private startStatsPolling(): void {
        this.stopStatsPolling();
        this.armStatsInterval();
    }

    /** (Re)arm the poll at the cadence the current inspection state wants: 1s while a stats panel is open, 2s otherwise. */
    private armStatsInterval(): void {
        clearInterval(this.statsInterval);
        const period = this.inspected() ? 1000 : 2000;
        this.statsInterval = setInterval(() => void this.pollStats(), period);
    }

    /** Stop polling and forget everything it produced. `inspected` is cleared here too: this service is `providedIn: 'root'`, so a panel destroyed while open would pin the 1s cadence for the rest of the session. */
    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.inboundVideoFpsSignal.set({});
        this.inspected.set(null);
        this.inspectedStats.set(null);
        this.prevInboundBytes.clear();
        this.prevInboundAt = 0;
    }

    /** Read every held screen share's counters, one report per track. */
    private async pollStats(): Promise<void> {
        const fps: Record<string, number> = {};
        let sample: StreamStatsSample | null = null;
        const inspectedUser = this.inspected()?.userId ?? null;

        for (const track of this.livekit.remoteTracks().values()) {
            if (describeTrack(track.publication.trackName).kind !== 'screen') continue;
            const report = await track.publication.videoTrack?.getRTCStatsReport();
            if (!report) continue;
            const mid = midOfReport(report);
            if (!mid) continue;

            const owners: ReadonlyMap<string, InboundTrackOwner> = new Map([
                [mid, {userId: track.userId, kind: 'screen' as const}],
            ]);
            Object.assign(fps, inboundScreenFpsByUser(report, owners));
            sample ??= detailedStatsFor(report, owners, inspectedUser);
        }

        this.inboundVideoFpsSignal.set(fps);
        this.inspectedStats.set(this.withMeasuredBitrate(sample));
    }

    /** Turn this poll's cumulative `bytesReceived` into a per-layer `kbps`, against the last one. */
    private withMeasuredBitrate(snapshot: StreamStatsSample | null): StreamStatsSnapshot | null {
        if (!snapshot) return null;

        const now = Date.now();
        const dt = this.prevInboundAt ? (now - this.prevInboundAt) / 1000 : 0;

        for (const layer of snapshot.layers) {
            const key = layer.rid ?? layer.mid ?? '';
            const bytes = layer.bytesReceived;
            if (bytes === undefined) continue;
            const rate = kbpsBetween(bytes, this.prevInboundBytes.get(key), dt);
            if (rate !== undefined) layer.kbps = rate;
            this.prevInboundBytes.set(key, bytes);
        }
        this.prevInboundAt = now;

        return snapshot;
    }

    /**
     * What this client is actually publishing, for the heartbeat's state assertion.
     *
     * The Rust session and never this room's identity: the microphone lives on the Rust connection, and asserting this one hands peers a participant with no audio track.
     * Null means not publishing; an empty `mediaSessionId` does not, so publishing state is driven from `publishState` and never from whether this string is blank.
     */
    get publishedMedia(): {mediaSessionId: string; audioTrackName: string} | null {
        if (!this.voiceSession) return null;
        return {
            mediaSessionId: this.voiceSession.mediaSessionId,
            audioTrackName: this.voiceSession.trackName,
        };
    }

    /** Names of all local tracks published from this client's webview. The microphone is not among them: it lives on the Rust connection, which closes its own track. */
    getActiveTrackNames(): string[] {
        const names: string[] = [];
        if (this.localVideoTrack) names.push(CAMERA_TRACK);
        if (this.screenShareId) {
            names.push(screenTrackName(this.screenShareId));
            if (this.rustAudioTrackName) names.push(screenAudioTrackName(this.screenShareId));
        }
        return names;
    }

    teardown(): void {
        this.subscribedAudioSessions.clear();
        this.wantedVideo.clear();
        // Dropped rather than awaited: anything still queued is for a channel that no longer exists.
        this.audioOps.clear();
        // Bumped, not cleared: a cleared map reads as token 0 to a sleeping retry, which is the value a first attempt would match.
        this.subscribeTokens.forEach((token, id) => this.subscribeTokens.set(id, token + 1));

        // Only this channel's publication: Isle proximity voice may be running on the same microphone and must survive leaving a guild channel.
        if (this.voiceSession) void this.voiceEngine.stop(this.voiceSession);
        this.voiceSession = null;
        this.voiceTarget = null;
        this.primaryConnection = null;
        this.engineUp.set(false);
        this.localVideoTrack?.stop();
        // The publisher only, and only when one is running.
        if (this.rustPublishing) void this.rustMedia.stopScreenPublish();

        this.localVideoTrack = null;
        this.rustPublishing = false;
        this.rustChoice = null;
        this.rustAudioTrackName = null;
        this.screenShareId = null;
        this.screenSourceSize = null;
        this.screenPreset.set(null);

        this.stopStatsPolling();
        void this.livekit.disconnect();
        this.participantsWithAudio.set(new Set());
        this.canPublishAudio.set(true);
        this.canPublishVideo.set(true);
        this.setupDone = false;

        this.videoStreamsSignal.set(new Map());
        this.screenStreamsSignal.set(new Map());
        this.localVideoStream.set(null);
        this.localScreenStream.set(null);
        this.localScreenHasAudio.set(false);
        this.localScreenAudioMuted.set(false);
        this.screenAudioMutedSignal.set(new Set());
    }

    /** Open or close the microphone for this channel. Push-to-talk is per call, so the engine has to be told which one. */
    setPttOpen(open: boolean): void {
        if (this.voiceSession) void this.voiceEngine.setPttOpen(this.voiceSession, open);
    }

    /** Everyone we currently hold a subscription for, so a snapshot can tell who has left. Screen-share audio is excluded: those sources key by track name, not by user. */
    subscribedUserIds(): string[] {
        const ids = new Set<string>();
        for (const [id] of this.subscribedAudioSessions) {
            if (!id.startsWith('screen-')) ids.add(id);
        }
        for (const [, want] of this.wantedVideo) ids.add(want.userId);
        return [...ids];
    }

    /** Cleans up all per-participant resources when a remote user leaves. */
    cleanupParticipant(userId: string): void {
        // Queued behind any subscribe still running for them, or the drop lands first and the subscribe it was meant to undo finishes afterwards, putting a participant who has left back in the mix.
        void this.queueAudioOp(userId, () => this.dropSource(userId));
        // Forget the identity they were on, so rejoining resubscribes rather than being skipped as a duplicate.
        this.subscribedAudioSessions.delete(userId);
        // Invalidate any retry still sleeping for them, or someone who leaves during the backoff is resubscribed seconds later.
        this.subscribeTokens.set(userId, (this.subscribeTokens.get(userId) ?? 0) + 1);
        // Same for their video: the intent has to go before the diff runs, or the reconcile below re-subscribes whatever of theirs the room still lists.
        for (const [name, want] of this.wantedVideo) {
            if (want.userId === userId) this.wantedVideo.delete(name);
        }
        this.applySubscriptions();

        this.videoStreamsSignal.update(m => {
            const n = new Map(m);
            n.delete(userId);
            return n;
        });
        this.screenStreamsSignal.update(m => {
            const n = new Map(m);
            n.delete(userId);
            return n;
        });
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            n.delete(userId);
            return n;
        });
        this.participantsWithAudio.update(s => {
            const n = new Set(s);
            n.delete(userId);
            return n;
        });
    }

    // ── Track subscription ─────────────────────────────────────────────────────

    /**
     * Pull remote audio into the Rust mixer.
     *
     * Audio never arrives on this room: two transports playing the same participant is double playout, and the second copy is not muteable from any control the user can see.
     */
    async subscribeAudio(
        targets: {
            userId: string;
            mediaSessionId: string;
            trackName: string;
            kind?: 'audio' | 'screenAudio';
        }[],
    ): Promise<void> {
        // Concurrently: sequentially, one participant losing the publish race would hold up everyone announced alongside them.
        await Promise.all(targets.map(target => this.subscribeOne(target)));
    }

    /** Drop a source from this channel's publication. Null-safe: participants leave in paths that also run after teardown. */
    private async dropSource(id: string): Promise<void> {
        if (this.voiceSession) await this.voiceEngine.unsubscribe(this.voiceSession, id);
    }

    /**
     * Wait for this channel's publication to exist, rather than dropping a subscribe that arrived before it.
     *
     * Everyone already in the channel is announced while `voiceSession` is still null, and an announcement is never repeated, so a dropped one is permanent silence for that participant.
     */
    private async awaitSession(): Promise<VoiceSession | null> {
        if (this.voiceSession) return this.voiceSession;
        for (const delay of SUBSCRIBE_RETRY_DELAYS_MS) {
            await new Promise(r => setTimeout(r, delay));
            if (this.voiceSession) return this.voiceSession;
        }
        return this.voiceSession;
    }

    /** Run one engine operation for a source, after every operation already queued for it. The chain is kept settled, or one rejected subscribe takes every later operation for that source with it. */
    private queueAudioOp<T>(id: string, op: () => Promise<T>): Promise<T> {
        const next = (this.audioOps.get(id) ?? Promise.resolve()).catch(() => {}).then(op);
        this.audioOps.set(
            id,
            next.catch(() => {}),
        );
        return next;
    }

    private async subscribeOne(target: {
        userId: string;
        mediaSessionId: string;
        trackName: string;
        kind?: 'audio' | 'screenAudio';
    }): Promise<void> {
        // Captured once: the channel can be left mid-retry, and the loop below must not resubscribe onto a different channel's publication.
        // Waited for outside the queue: inside it, the first announcement's wait for a session would hold up every other announcement for the same source.
        const session = await this.awaitSession();
        if (!session) {
            console.error('[voice] dropped a subscribe - no session after waiting', target);
            return;
        }

        // Voice keys on the user; a stream's audio keys on its track name, so muting a stream does not mute the voice of whoever is streaming.
        const id = target.kind === 'screenAudio' ? target.trackName : target.userId;

        // An absent media session means "this user", and absent includes the empty string: the desktop client sends `''`, so `??` does not catch it and a truthiness test is required.
        const resolved = target.mediaSessionId ? target : {...target, mediaSessionId: target.userId};

        return this.queueAudioOp(id, () => this.subscribeQueued(session, id, resolved));
    }

    /** One subscribe, with no other operation for the same source in flight. The dedupe below reads a record written on success, so outside the queue it is blind for exactly as long as a subscribe takes. */
    private async subscribeQueued(
        session: VoiceSession,
        id: string,
        target: {userId: string; mediaSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio'},
    ): Promise<void> {
        // A participant is announced both live and out of the backfill, and the two do not always agree; acting on that difference is the only recovery path there is.
        const previous = this.subscribedAudioSessions.get(id);
        if (previous === target.mediaSessionId) return;
        if (previous !== undefined) {
            // The old subscription points at a participant that is no longer publishing. Drop it, or the mixer keeps a dead source.
            console.warn('[voice] publishing identity changed, resubscribing', {
                id,
                from: previous,
                to: target.mediaSessionId,
            });
            await this.voiceEngine.unsubscribe(session, id);
            this.subscribedAudioSessions.delete(id);
        }

        // Claim this source: a later announcement or a departure invalidates the token, so an attempt still sleeping between retries drops out instead of resurrecting a subscription.
        const token = (this.subscribeTokens.get(id) ?? 0) + 1;
        this.subscribeTokens.set(id, token);

        for (let attempt = 0; ; attempt++) {
            if (this.subscribeTokens.get(id) !== token) return;
            try {
                await this.voiceEngine.subscribe(session, id, target.mediaSessionId, target.trackName);
                if (this.subscribeTokens.get(id) !== token) {
                    // Superseded while the call was in flight. Drop what we just took, or it outlives the participant it belongs to.
                    await this.voiceEngine.unsubscribe(session, id);
                    return;
                }
                // Only after it succeeds: recording a failed subscribe would make a later announcement skip the identity that could have worked.
                this.subscribedAudioSessions.set(id, target.mediaSessionId);
                if (target.kind === 'screenAudio') {
                    this.remoteScreenAudioIds.set(target.userId, id);
                    // A stream that starts while its author is already muted must stay muted.
                    if (this.screenAudioMutedSignal().has(target.userId)) {
                        void this.voiceEngine.setUserVolume(id, 0);
                    } else {
                        // Re-apply the stored slider position: Rust starts every source at unity, so a volume set before this share existed would otherwise be silently lost.
                        const volume = this.screenVolumes.get(target.userId);
                        if (volume !== undefined) void this.voiceEngine.setUserVolume(id, volume);
                    }
                } else {
                    this.participantsWithAudio.update(s => new Set(s).add(target.userId));
                    // Re-apply the stored slider position: Rust starts every source at unity, so a volume set before this participant joined would otherwise be silently lost.
                    const volume = this.userVolumes.get(target.userId);
                    if (volume !== undefined) void this.voiceEngine.setUserVolume(id, volume);
                }
                return;
            } catch (e) {
                if (attempt < SUBSCRIBE_RETRY_DELAYS_MS.length) {
                    // Expected, not exceptional: a roster announcement can beat the SFU's own `TrackPublished` to the Rust room, and an announcement is never repeated.
                    console.warn(
                        '[voice] subscribe failed, retrying',
                        {
                            id,
                            attempt: attempt + 1,
                            retryInMs: SUBSCRIBE_RETRY_DELAYS_MS[attempt],
                        },
                        e,
                    );
                    await new Promise(r => setTimeout(r, SUBSCRIBE_RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                // Loud, and it stays loud: the retries are exhausted, so this participant is unhearable until they republish.
                console.error(
                    '[voice] subscribe failed',
                    {
                        id,
                        ...target,
                        attempts: SUBSCRIBE_RETRY_DELAYS_MS.length + 1,
                    },
                    e,
                );
                return;
            }
        }
    }

    /**
     * Want a remote camera or screen track open on this room.
     *
     * Records the intent and reconciles: an announcement is never repeated, which is what makes dropping an early one permanent.
     * Video only, because the Rust connection is what plays a `screen-audio-*` track into the mixer.
     */
    subscribeVideo(
        _guildId: string,
        _channelId: string,
        userId: string,
        _mediaSessionId: string,
        trackName: string,
        kind: 'video' | 'screen',
    ): Promise<void> {
        const described = describeTrack(trackName);
        if (described.kind !== 'video' && described.kind !== 'screen') {
            console.warn('[voice] not pulling an audio track onto the view room', {trackName});
            return Promise.resolve();
        }

        this.wantedVideo.set(trackName, {userId, kind});
        this.applySubscriptions();
        return Promise.resolve();
    }

    /**
     * Bring what the room is pulling into line with what the roster asked for.
     *
     * By diffing, never by rebuilding: a rebuild would drop and re-pull every tile on any change.
     * A track whose sid cannot be resolved is left for the next pass; that is the ordinary state of a publication whose announcement beat the SFU's.
     */
    private applySubscriptions(): void {
        // Guarded on the room this service owns: `LiveKitRoomService` is a root singleton shared with the DM call path, and the unsubscribe loop below closes any held track this roster does not name.
        if (!this.voiceTarget) return;

        const resolved: string[] = [];
        const unresolved: string[] = [];
        const refused: string[] = [];

        for (const [trackName, want] of this.wantedVideo) {
            const trackSid = this.sidOf(want.userId, trackName);
            if (!trackSid) {
                unresolved.push(`${want.userId}/${trackName}`);
                continue;
            }
            if (this.livekit.setSubscribed(trackSid, true)) resolved.push(`${want.userId}/${trackName}`);
            else refused.push(`${want.userId}/${trackName}@${trackSid}`);
        }
        const dropped: string[] = [];
        for (const track of this.livekit.remoteTracks().values()) {
            if (!this.wantedVideo.has(track.publication.trackName)) {
                this.livekit.setSubscribed(track.trackSid, false);
                dropped.push(`${track.userId}/${track.publication.trackName}`);
            }
        }

        // `unresolved` is the room not knowing the publication yet, `refused` is this room saying no, and pulling with nothing `held` is the SFU accepting a subscribe and forwarding nothing.
        const held = [...this.livekit.remoteTracks().values()].map(
            t => `${t.userId}/${t.publication.trackName}`,
        );
        console.info(
            `[voice] video reconcile: wanted ${this.wantedVideo.size}` +
                `, pulling ${resolved.length}${resolved.length ? ` [${resolved.join(', ')}]` : ''}` +
                (unresolved.length ? `, no sid yet [${unresolved.join(', ')}]` : '') +
                (refused.length ? `, refused [${refused.join(', ')}]` : '') +
                `, held ${held.length}${held.length ? ` [${held.join(', ')}]` : ''}` +
                // A drop takes a working picture away, so it is named rather than counted.
                (dropped.length ? `, DROPPED [${dropped.join(', ')}]` : ''),
        );
    }

    /** The sid behind a roster row, or null while the room has not been told the publication exists. Both lookups are needed: the room's own map holds only what is already subscribed. */
    private sidOf(userId: string, trackName: string): string | null {
        for (const track of this.livekit.remoteTracks().values()) {
            if (track.userId === userId && track.publication.trackName === trackName) return track.trackSid;
        }
        for (const publication of this.roomMedia.publicationsOf?.(userId) ?? []) {
            if (publication.trackName === trackName) return publication.trackSid;
        }
        return null;
    }

    /** Rebuild the two stream maps the tiles render from. {@link describeTrack} is the only thing that decides what a name means: it tests `screen-audio-` before `screen-`. */
    private projectRemoteStreams(): void {
        const video = new Map<string, MediaStream>();
        const screen = new Map<string, MediaStream>();

        for (const track of this.livekit.remoteTracks().values()) {
            const described = describeTrack(track.publication.trackName);
            if (described.kind !== 'video' && described.kind !== 'screen') continue;
            const media = track.publication.track?.mediaStreamTrack;
            if (!media) continue;
            (described.kind === 'screen' ? screen : video).set(track.userId, new MediaStream([media]));
        }

        this.videoStreamsSignal.set(video);
        this.screenStreamsSignal.set(screen);
    }

    // ── Local media controls ───────────────────────────────────────────────────

    /** Deafens output only: the capture chain is untouched, so this does not stop you transmitting. Mute is a separate control. */
    setDeafened(isDeafened: boolean): void {
        void this.voiceEngine.setDeafened(isDeafened);
    }

    /**
     * Open the camera, publish it, and declare it.
     *
     * A `200` carrying `degradations` is a publish that worked smaller: the camera stays live at the granted rung and nothing rolls back. A `403` is a refusal nobody could receive, so the local track is stopped.
     */
    async publishCamera(guildId: string, channelId: string): Promise<string | null> {
        if (!this.canPublishVideo()) {
            console.warn('[voice] the token for this room does not permit video');
            return null;
        }

        const publishTrack = this.roomMedia.publishTrack;
        if (typeof publishTrack !== 'function') return null;

        try {
            // Honour the camera picked in settings rather than opening the system default.
            const stream = await navigator.mediaDevices.getUserMedia({
                video: await this.audioSettings.buildVideoConstraint(),
                audio: false,
            });
            this.localVideoTrack = stream.getVideoTracks()[0];
            this.localVideoStream.set(new MediaStream([this.localVideoTrack]));

            // The SDK owns the send-side encodings: the ladder, the codec preference and the start bitrate.
            await publishTrack(this.localVideoTrack, CAMERA_TRACK);

            const granted = await firstValueFrom(
                this.guildVoiceSvc.publish(guildId, channelId, {
                    trackNames: [CAMERA_TRACK],
                    // What the camera actually opened at, not what was asked for: stating the request would have the server clamp against a resolution nothing is sending.
                    video: trackIntent(this.localVideoTrack),
                }),
            );

            // A clamped publish is a success carrying a note: nothing above this line rolls back on account of it.
            this.voiceLimits.noteDegradations(granted);
            await this.reencodeTo(granted.height, granted.framerate);
            return CAMERA_TRACK;
        } catch (err) {
            // A refusal is not a broken camera. The device is released either way, or the camera light stays on behind a publish that did not happen.
            this.voiceLimits.noteDenial(err);
            await this.roomMedia.unpublishTrack?.(CAMERA_TRACK).catch(() => {});
            this.releaseCameraTrack();
            return null;
        }
    }

    /** Re-encode the running camera to the rung the server granted. `applyConstraints` rather than a republish: the track, its sid and every viewer's subscription survive it. */
    private async reencodeTo(height: number | null, framerate: number | null): Promise<void> {
        const track = this.localVideoTrack;
        if (!track || height === null || framerate === null) return;
        if (typeof track.applyConstraints !== 'function') return;
        await track
            .applyConstraints({height, frameRate: framerate})
            .catch(e => console.warn('[voice] could not re-encode the camera to the granted rung', e));
    }

    /** Drop a camera capture that never became a publication. */
    private releaseCameraTrack(): void {
        this.localVideoTrack?.stop();
        this.localVideoTrack = null;
        this.localVideoStream.set(null);
    }

    async closeCamera(guildId: string, channelId: string): Promise<void> {
        if (!this.localVideoTrack) return;
        await this.roomMedia.unpublishTrack?.(CAMERA_TRACK).catch(() => {});
        this.releaseCameraTrack();
        // Best effort, and after the media has already stopped: the declaration is what makes peers drop the tile rather than waiting on a track that has ended.
        await firstValueFrom(this.guildVoiceSvc.unpublish(guildId, channelId, [CAMERA_TRACK])).catch(
            () => {},
        );
    }

    async publishScreen(guildId: string, channelId: string): Promise<{shareId: string} | null> {
        try {
            const choice = await this.screenPicker.show();
            if (!choice) return null;

            const {sourceWidth, sourceHeight} = choice;
            // Clamped before capture, not after: the picker's preset is a saved preference and outlives the room it was chosen in.
            const preset = clampPreset(choice.preset, this.voiceLimits.videoCeiling());
            this.screenPreset.set(preset);
            this.screenSourceSize = {width: sourceWidth, height: sourceHeight};

            return await this.publishScreenFromRust(guildId, channelId, {...choice, preset});
        } catch (err) {
            this.voiceLimits.noteDenial(err);
            return null;
        }
    }

    async closeScreen(guildId: string, channelId: string): Promise<{shareId: string} | null> {
        if (!this.rustPublishing) return null;

        // The publisher stops its own tracks; what is left here is the declaration, which is what makes peers drop the tile.
        const shareId = this.screenShareId ?? 'share';
        const trackNames = [screenTrackName(shareId)];
        if (this.rustAudioTrackName) trackNames.push(screenAudioTrackName(shareId));

        await this.rustMedia.stopScreenPublish();
        this.rustPublishing = false;
        this.rustChoice = null;
        this.rustAudioTrackName = null;
        this.localScreenHasAudio.set(false);
        this.localScreenAudioMuted.set(false);
        this.screenShareId = null;
        this.screenSourceSize = null;
        this.screenPreset.set(null);

        await firstValueFrom(this.guildVoiceSvc.unpublish(guildId, channelId, trackNames)).catch(() => {});
        return {shareId};
    }

    /** Publish the screen from the {@link ScreenPublisher} port, and declare what it published. The declaration is made here because this is the side with the interceptor chain. */
    private async publishScreenFromRust(
        guildId: string,
        channelId: string,
        choice: ScreenPickerChoice,
    ): Promise<{shareId: string} | null> {
        // The microphone's connection, so the share lands on the same participant rather than opening a third identity.
        const livekit = this.primaryConnection;
        if (!livekit) {
            console.error('[voice] cannot share a screen before the room connection exists');
            return null;
        }

        const shareId = crypto.randomUUID();
        try {
            const published = await this.rustMedia.startScreenPublish(
                publishOptions(
                    choice,
                    shareId,
                    this.apiConfig.baseUrl(),
                    this.oauth.getAccessToken(),
                    await this.deviceIdentity.deviceId(),
                    {guildId, channelId},
                    this.voiceLimits.videoCeiling(),
                    livekit,
                ),
            );
            console.log(`[voice] screen publisher live on ${published.encoder}`, published);
            this.screenShareId = shareId;
            this.rustPublishing = true;
            this.rustChoice = choice;
            // What was actually published, not what was asked for: the loopback device can be unavailable, and the share is then video-only.
            this.rustAudioTrackName = published.audioTrackName;
            this.localScreenHasAudio.set(published.audioTrackName !== null);
            this.localScreenAudioMuted.set(false);

            const trackNames = [screenTrackName(shareId)];
            if (published.audioTrackName) trackNames.push(screenAudioTrackName(shareId));

            const granted = await firstValueFrom(
                this.guildVoiceSvc.publish(guildId, channelId, {
                    trackNames,
                    video: this.screenIntent(choice),
                }),
            );
            this.voiceLimits.noteDegradations(granted);
            return {shareId};
        } catch (e) {
            console.error('[voice] screen publish failed', e);
            // A `403` on the declaration is a refusal the room could not degrade, so the media has to stop: nobody receives it whatever the client does.
            this.voiceLimits.noteDenial(e);
            if (this.rustPublishing) await this.rustMedia.stopScreenPublish().catch(() => {});
            this.rustPublishing = false;
            this.rustChoice = null;
            this.rustAudioTrackName = null;
            this.screenShareId = null;
            this.localScreenHasAudio.set(false);
            this.screenPreset.set(null);
            this.screenSourceSize = null;
            return null;
        }
    }

    /** What a share is about to send: the solved capture height, not the preset's nominal one, solved from the same inputs `publishOptions` uses so the two cannot drift. */
    private screenIntent(choice: ScreenPickerChoice): VideoPublishIntentDto | undefined {
        const geometry = solveGeometry(
            choice.sourceWidth,
            choice.sourceHeight,
            choice.preset.resolution,
            this.voiceLimits.videoCeiling(),
        );
        if (geometry.height <= 0) return undefined;
        return {height: geometry.height, framerate: choice.preset.framerate};
    }

    /**
     * Change stream quality mid-share.
     *
     * Nothing here restarts anything: the connection, the track and therefore the share id all survive both a framerate and a resolution change.
     * The new size is announced through `PUT .../voice/video`, which is the only thing that tells the server about a resolution change made after publish time.
     */
    async setScreenPreset(requested: StreamPreset): Promise<void> {
        const previous = this.screenPreset() ?? DEFAULT_STREAM_PRESET;
        // Both pickers already disable what the rung does not permit, so this only catches a ceiling that moved between the render and the click, and a hotkey, which passes through no picker at all.
        const preset = clampPreset(requested, this.voiceLimits.videoCeiling());
        this.screenPreset.set(preset);
        // The choice has to outlive the share. `requested`, not `preset`: see `rememberPreset`.
        this.screenPicker.rememberPreset(requested);

        if (!this.rustPublishing) return;

        // Framerate is live - the capture loop re-reads it every frame.
        if (preset.framerate !== previous.framerate) {
            await this.rustMedia.setPublishFps(preset.framerate);
        }
        // The mode moves no number the encoder is built from, so it needs its own trigger; it rides the same retype as the geometry, so a change to both is one frame boundary and not two.
        const retype = preset.resolution !== previous.resolution || preset.content !== previous.content;
        if (retype && this.screenSourceSize) {
            const {width, height} = this.screenSourceSize;
            const box = solveGeometry(width, height, preset.resolution, this.voiceLimits.videoCeiling());
            await this.rustMedia.setPublishSpec({
                width: box.width,
                height: box.height,
                kbps: bitrateFor(preset),
                content: preset.content,
            });
        }
        // Kept in step with what the encoder is now producing, so a publish that does restart later opens at the resolution the user is watching.
        if (this.rustChoice) this.rustChoice = {...this.rustChoice, preset};

        await this.declareScreenSize(preset, previous);
    }

    /** Re-declare a running share's size, for the change that did not republish. Compared on what is solved rather than on what was asked for, in both directions. */
    private async declareScreenSize(preset: StreamPreset, previous: StreamPreset): Promise<void> {
        const target = this.voiceTarget;
        if (!target) return;

        const height = this.solvedScreenHeight(preset);
        if (height === null) return;
        if (height === this.solvedScreenHeight(previous) && preset.framerate === previous.framerate) return;

        await firstValueFrom(
            this.guildVoiceSvc.declareVideo(target.guildId, target.channelId, {
                height,
                framerate: preset.framerate,
            }),
        ).catch(e => console.warn('[voice] could not declare the new share size', e));
    }

    /** What the running capture is solved to, or null when the source size is unknown. */
    private solvedScreenHeight(preset: StreamPreset): number | null {
        if (!this.screenSourceSize) return null;
        const {width, height} = this.screenSourceSize;
        const box = solveGeometry(width, height, preset.resolution, this.voiceLimits.videoCeiling());
        return box.height > 0 ? box.height : null;
    }

    // ── Volume / per-user audio controls ──────────────────────────────────────

    /** The UI owns the slider position; Rust owns what it does, which is a gain in the mixer. */
    setUserVolume(userId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.userVolumes.set(userId, clamped);
        void this.voiceEngine.setUserVolume(userId, clamped);
    }

    getUserVolume(userId: string): number {
        return this.userVolumes.get(userId) ?? 1;
    }

    /**
     * Set one participant's stream volume, independent of their voice, applied to the share's mixer source instead of the participant's.
     *
     * Mute is layered on top, not folded in: while the stream is muted the new level is only remembered, so it does not audibly un-mute the stream out from under the user.
     */
    setScreenVolume(userId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.screenVolumes.set(userId, clamped);
        if (this.screenAudioMutedSignal().has(userId)) return;
        const shareId = this.remoteScreenAudioIds.get(userId);
        if (shareId) void this.voiceEngine.setUserVolume(shareId, clamped);
    }

    getScreenVolume(userId: string): number {
        return this.screenVolumes.get(userId) ?? 1;
    }

    isScreenAudioMuted(userId: string): boolean {
        return this.screenAudioMutedSignal().has(userId);
    }

    /** Mutes a stream's audio, not the streamer's voice: `screen-audio-{shareId}` and the user id are separate mixer sources, which is why this keys on the share. */
    toggleScreenAudioMute(userId: string): void {
        const willMute = !this.screenAudioMutedSignal().has(userId);
        const shareId = this.remoteScreenAudioIds.get(userId);
        // Unmuting restores whatever volume was set, not unity: mute must not clobber the stored level.
        if (shareId)
            void this.voiceEngine.setUserVolume(shareId, willMute ? 0 : this.getScreenVolume(userId));
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            willMute ? n.add(userId) : n.delete(userId);
            return n;
        });
    }

    toggleLocalScreenAudio(): void {
        const muted = !this.localScreenAudioMuted();
        // Nothing to disable on this side: the track lives in the publisher.
        if (!this.rustAudioTrackName) return;
        void this.rustMedia.setScreenAudioMuted(muted);
        this.localScreenAudioMuted.set(muted);
    }

    getVideoStream(userId: string): MediaStream | null {
        return this.videoStreamsSignal().get(userId) ?? null;
    }

    getScreenStream(userId: string): MediaStream | null {
        return this.screenStreamsSignal().get(userId) ?? null;
    }

    /** Declares every track published from this client closed, so peers drop them. */
    async closeAllTracks(guildId: string, channelId: string): Promise<void> {
        const trackNames = this.getActiveTrackNames();
        if (trackNames.length === 0) return;
        await firstValueFrom(this.guildVoiceSvc.unpublish(guildId, channelId, trackNames)).catch(() => {});
    }

    /** Updates stream/audio state when a remote participant's track is closed by the server. */
    handleRemoteTrackClosed(trackName: string, userId: string): void {
        // Released here so a republish of the same name resubscribes instead of being skipped.
        this.wantedVideo.delete(trackName);
        const described = describeTrack(trackName);

        if (described.kind === 'screenAudio') {
            // Drop the source, or a stopped stream keeps its slot in the mixer forever.
            void this.dropSource(trackName);
            this.remoteScreenAudioIds.delete(userId);
            return;
        }

        this.applySubscriptions();
        if (described.kind === 'video') {
            this.videoStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        } else if (described.kind === 'screen') {
            this.screenStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        }
    }
}
