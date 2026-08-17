import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {describeEntitlementDenial} from '../core/entitlement-message';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';
import {VoiceLimitsService} from './voice-limits.service';
import {ProfileService} from './profile.service';
import {ProfileDto} from '../dtos/response/profile.dto';
import {GuildVoiceService} from './guild-voice.service';
import {
    GuildWebsocketService,
    WsGuildParticipantJoined,
    WsKickedByOtherDevice,
    WsGuildTrackClosed,
    WsGuildTrackPublished,
    WsMovedToChannel,
    WsUserJoinedVoice,
    WsUserLeftVoice,
    WsVoiceCameraChanged,
    WsVoiceDeafenChanged,
    WsVoiceMuteChanged,
    WsVoiceScreenShareStarted,
} from './guild-websocket.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceRTCService} from './voice-rtc.service';
import {StreamPreset} from '../models/stream-preset';
import {VoiceEngineService} from './voice-engine.service';
import {ToastService} from './toast.service';
import {ConnectionState} from './realtime-connection.service';
import {ScreenResumeTracker} from '../shared/call/screen-resume';
import {
    describeTrack,
    VoiceEventDecision,
    VoiceEventEnvelope,
    VoiceParticipantSnapshot,
    VoiceRoomSnapshot,
    VoiceRoomTracker,
} from '../models/voice-room';

export interface VoiceChannelParticipant {
    userId: string;
    displayName: string;
    avatarLabel: string;
    avatarUrl?: string;
    isMuted: boolean;
    isSpeaking: boolean;
    isCameraOn: boolean;
    isScreenSharing: boolean;
    isServerDeafened: boolean;
    isLocal: boolean;
    mediaSessionId?: string | null;
}

export interface VoiceLocalState {
    isMuted: boolean;
    isDeafened: boolean;
    isCameraOn: boolean;
    isScreenSharing: boolean;
}

const STICKY_VOICE_STATE_KEY = 'alpine_voice_local_state';

/** Mute and deafen persist across calls; camera and screen share hold a live publication and never do. */
export function loadStickyVoiceState(): Pick<VoiceLocalState, 'isMuted' | 'isDeafened'> {
    try {
        const raw = localStorage.getItem(STICKY_VOICE_STATE_KEY);
        if (!raw) return {isMuted: false, isDeafened: false};
        const stored = JSON.parse(raw) as Partial<VoiceLocalState>;
        // Explicit true, not truthiness: a corrupt blob must read as "not muted".
        return {isMuted: stored.isMuted === true, isDeafened: stored.isDeafened === true};
    } catch {
        return {isMuted: false, isDeafened: false};
    }
}

@Injectable({providedIn: 'root'})
export class VoiceChannelService {
    readonly rtc = inject(VoiceRTCService);
    readonly joinedChannelId = signal<string | null>(null);
    readonly joinedGuildId = signal<string | null>(null);
    readonly joinedChannelName = signal<string | null>(null);
    readonly joinedGuildName = signal<string | null>(null);

    // ── Public state ───────────────────────────────────────────────────────────
    readonly localState = signal<VoiceLocalState>({
        ...loadStickyVoiceState(),
        isCameraOn: false,
        isScreenSharing: false
    });
    readonly isInVoice = computed(() => this.joinedChannelId() !== null);
    /** Push-to-talk gate, independent of mute: true means "allowed to transmit", and it stays true when no key is bound. */
    readonly pttGateOpen = signal(true);
    // Pass-through signals from VoiceRTCService for template consumption
    readonly rtcState = this.rtc.rtcState;
    readonly participantsWithAudio = this.rtc.participantsWithAudio;
    readonly localVideoStream = this.rtc.localVideoStream;
    readonly localScreenStream = this.rtc.localScreenStream;
    readonly localScreenHasAudio = this.rtc.localScreenHasAudio;
    readonly localScreenAudioMuted = this.rtc.localScreenAudioMuted;
    readonly videoStreams = this.rtc.videoStreams;
    readonly screenStreams = this.rtc.screenStreams;
    readonly screenAudioMuted = this.rtc.screenAudioMuted;
    readonly inboundVideoFps = this.rtc.inboundVideoFps;
    private profileService = inject(ProfileService);
    private guildVoiceSvc = inject(GuildVoiceService);
    private guildWsSvc = inject(GuildWebsocketService);
    private soundSettings = inject(SoundSettingsService);
    private voiceEngine = inject(VoiceEngineService);
    /** What this room's plan allows and what it has already reduced, held for the life of the call. */
    readonly limits = inject(VoiceLimitsService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private readonly channelParticipantsSignal = signal<Map<string, VoiceChannelParticipant[]>>(new Map());
    /** See {@link nameFromCache}. Weak, so a roster entry that drops out is not held alive by it. */
    private readonly namedParticipants =
        new WeakMap<VoiceChannelParticipant, {profile: ProfileDto; named: VoiceChannelParticipant}>();

    /** Users whose screen track has closed and whose picture is still expected back. */
    private readonly screenResuming = signal<ReadonlySet<string>>(new Set());

    /** The grace window: expiry is the only thing that finally clears `isScreenSharing`. */
    private readonly screenResume = new ScreenResumeTracker(userId => {
        this.screenResuming.update(ids => {
            const next = new Set(ids);
            next.delete(userId);
            return next;
        });
        const channelId = this.joinedChannelId();
        if (channelId) {
            this.patchParticipant(channelId, userId, p => ({...p, isScreenSharing: false}));
        }
    });
    /**
     * The roster, named from the profile cache at read time: a roster entry must never carry a name of its own.
     * Unchanged entries and an unchanged map are handed back by identity, or one arriving profile rebuilds every row.
     */
    readonly channelParticipants = computed(() => {
        const roster = this.channelParticipantsSignal();
        let mapChanged = false;
        const next = new Map<string, VoiceChannelParticipant[]>();

        for (const [channelId, list] of roster) {
            const named = list.map(p => this.nameFromCache(p));
            const listChanged = named.some((n, i) => n !== list[i]);
            if (listChanged) mapChanged = true;
            next.set(channelId, listChanged ? named : list);
        }

        return mapChanged ? next : roster;
    });

    /** The named form of one roster entry, memoised on (entry, profile); both keys are replaced rather than mutated, so identity is a sound staleness test. */
    private nameFromCache(p: VoiceChannelParticipant): VoiceChannelParticipant {
        const profile = this.profileService.getCachedByUserId(p.userId);
        if (!profile?.userName) return p;

        const memo = this.namedParticipants.get(p);
        if (memo?.profile === profile) return memo.named;

        const named: VoiceChannelParticipant = {
            ...p,
            displayName: profile.userName,
            avatarLabel: profile.userName[0].toUpperCase(),
            avatarUrl: profile.avatarUrl,
        };
        this.namedParticipants.set(p, {profile, named});
        return named;
    }

    // ── Sidebar voice state cache ──────────────────────────────────────────────
    private lastLoadedGuildId: string | null = null;

    // ── Join guard ─────────────────────────────────────────────────────────────

    /** The channel a join is currently in flight for, or null. Public so the lobby can draw a spinner. */
    readonly pendingJoinId = signal<string | null>(null);
    /** A teardown still running for a channel already left: a join must await this before touching the transport, or `rtc.teardown()` closes the connection the new join just opened. */
    private leaveInFlight: Promise<void> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    /** `instanceId` and `version` for the channel we are in, plus the decision procedure for events about it. See {@link VoiceRoomTracker}. */
    private readonly tracker = new VoiceRoomTracker();
    /** Guards against a burst of gaps firing a refetch per event. */
    private refetchInFlight = false;
    /** Previous hub state, so only the transition *into* Connected fires the reconnect heartbeat. */
    private prevConnectionState: ConnectionState | null = null;

    constructor() {
        // Remote participants' speaking state, from the Rust mixer.
        effect(() => {
            const levels = this.voiceEngine.remoteLevels();
            const channelId = this.joinedChannelId();
            if (!channelId) return;
            for (const [userId, level] of levels) {
                this.patchParticipant(channelId, userId, p =>
                    p.isSpeaking === level.speaking ? p : {...p, isSpeaking: level.speaking});
            }
        });

        // Own speaking state, straight from the Rust gate that decides which frames are transmitted.
        effect(() => {
            const isSpeaking = this.voiceEngine.speaking();
            const channelId = this.joinedChannelId();
            const ownId = this.profileService.ownProfile()?.userId;
            if (!channelId || !ownId) return;
            this.patchParticipant(channelId, ownId, p => p.isSpeaking === isSpeaking ? p : {...p, isSpeaking});
        });

        // A reconnect asserts state and never rebuilds media: rebuilding spends the media session id.
        // One heartbeat restores the shortened liveness window and backfills the events lost in the gap.
        effect(() => {
            const state = this.guildWsSvc.connectionState();
            untracked(() => {
                const wasConnected = this.prevConnectionState === ConnectionState.Connected;
                this.prevConnectionState = state;
                const channelId = this.joinedChannelId();
                if (state === ConnectionState.Connected && !wasConnected && channelId) {
                    this.sendHeartbeat(channelId);
                }
            });
        });

        // Auto-stop screen share when the OS ends the screen track
        this.rtc.screenEnded$.subscribe(() => {
            if (this.localState().isScreenSharing) void this.toggleScreenShare();
        });

        this.guildWsSvc.userJoinedVoiceObservable.subscribe(e => this.onUserJoinedVoice(e));
        this.guildWsSvc.userLeftVoiceObservable.subscribe(e => this.onUserLeftVoice(e));
        this.guildWsSvc.guildParticipantJoinedObservable.subscribe(e => this.onParticipantJoined(e));
        this.guildWsSvc.guildTrackPublishedObservable.subscribe(e => this.onTrackPublished(e));
        this.guildWsSvc.guildTrackClosedObservable.subscribe(e => this.onTrackClosed(e));
        this.guildWsSvc.voiceMuteChangedObservable.subscribe(e => this.onMuteChanged(e));
        this.guildWsSvc.voiceDeafenChangedObservable.subscribe(e => this.onDeafenChanged(e));
        this.guildWsSvc.voiceCameraChangedObservable.subscribe(e => this.onCameraChanged(e));
        this.guildWsSvc.voiceScreenShareStartedObservable.subscribe(e => this.onScreenShareStarted(e));
        this.guildWsSvc.voiceScreenShareStoppedObservable.subscribe(() => { /* TrackClosed handles cleanup */
        });
        this.guildWsSvc.movedToChannelObservable.subscribe(e => void this.onMovedToChannel(e));
        this.guildWsSvc.kickedByOtherDeviceObservable.subscribe(e => void this.onKickedByOtherDevice(e));

        this.guildWsSvc.voiceSnapshotObservable.subscribe(s => void this.applySnapshot(s));
        this.guildWsSvc.voiceResyncObservable.subscribe(e => void this.onResync(e));

        // A publish the server refused outright: the toast acknowledges that the button did nothing.
        this.limits.refused$.subscribe(notice =>
            this.toast.error(this.translate.instant(notice.messageKey)));

        // A stale-subscription refusal means our roster is out of date; the refetch is burst-guarded.
        this.rtc.staleSubscription$.subscribe(() => void this.refetchSnapshot());
    }

    // ── Recovery ───────────────────────────────────────────────────────────────

    /** Decide what an arriving event means and act on it. Events for other channels bypass the version gate: their version belongs to a room we do not track. */
    private gate(channelId: string, event: VoiceEventEnvelope, apply: () => void): void {
        this.decide(channelId, apply, () => this.tracker.receive(event));
    }

    /** The same, for relay events: applied without advancing the version. See {@link VoiceRoomTracker.receiveRelay}. */
    private gateRelay(channelId: string, event: VoiceEventEnvelope, apply: () => void): void {
        this.decide(channelId, apply, () => this.tracker.receiveRelay(event));
    }

    private decide(channelId: string, apply: () => void, classify: () => VoiceEventDecision): void {
        if (channelId !== this.joinedChannelId()) {
            apply();
            return;
        }
        switch (classify()) {
            case 'apply':
                apply();
                return;
            case 'ignore':
                return;
            case 'refetch':
                void this.refetchSnapshot();
                return;
        }
    }

    /** Read the authoritative state again. Best-effort and not retried: a failed read is covered by the next heartbeat. */
    private async refetchSnapshot(): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || !guildId || this.refetchInFlight) return;

        this.refetchInFlight = true;
        try {
            const snapshot = await firstValueFrom(this.guildVoiceSvc.getSnapshot(guildId, channelId));
            // The channel can be left mid-flight; applying then populates a roster for a room we left.
            if (this.joinedChannelId() !== channelId) return;
            await this.applySnapshot(snapshot);
        } catch (err) {
            console.error('[voice] snapshot refetch failed', err);
        } finally {
            this.refetchInFlight = false;
        }
    }

    /** Take a snapshot wholesale and reconcile media against it: the roster is replaced, never merged, and every publisher in it is subscribed to. */
    private async applySnapshot(snapshot: VoiceRoomSnapshot): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || snapshot.roomId !== channelId) return;

        this.tracker.applySnapshot(snapshot);
        // Every snapshot, not only the join reply: a room's limits can move during a call.
        this.limits.applySnapshot(snapshot);

        const ownId = this.profileService.ownProfile()?.userId ?? '';
        const list = snapshot.participants.map(p => this.snapshotToParticipant(p, ownId));

        // Our own row is rebuilt from local state: the server's copy of mute, camera and share lags a round trip.
        const {isMuted, isCameraOn, isScreenSharing} = this.localState();
        const withLocal = list.map(p => p.isLocal ? {...p, isMuted, isCameraOn, isScreenSharing} : p);

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(channelId, withLocal);
            return n;
        });
        // Every snapshot, not just join: the roster is replaced wholesale, so a stale one erases our own row.
        this.ensureLocalParticipant(channelId);

        // Anyone who left while we were out of sync; Resync covers the live case, this the missed ones.
        const present = new Set(snapshot.participants.map(p => p.userId));
        for (const known of this.rtc.subscribedUserIds()) {
            if (!present.has(known)) this.rtc.cleanupParticipant(known);
        }

        if (!guildId) return;
        await this.subscribeFromSnapshot(snapshot, guildId, channelId, ownId);
    }

    /** Subscribe to everything pullable in the snapshot. Idempotent: both subscribe paths key on (source, publishing session). */
    private async subscribeFromSnapshot(
        snapshot: VoiceRoomSnapshot,
        guildId: string,
        channelId: string,
        ownId: string,
    ): Promise<void> {
        // Why anyone was passed over: every skip below is a silent `continue`.
        const skipped: string[] = [];

        for (const p of snapshot.participants) {
            // Never subscribe to our own session: a session cannot pull its own local track.
            if (p.userId === ownId) continue;
            // A session id alone is not an invitation: `Joined` means a session exists and a track does not.
            // `mediaSessionId` must NOT be required here - under LiveKit it arrives null and gating on it silently skips everyone already in the channel.
            if (p.publishState !== 'Publishing' || !p.audioTrackName) {
                skipped.push(`${p.userId}(${p.publishState}${p.audioTrackName ? '' : ',no-track'})`);
                continue;
            }

            // `||`, not `??`: a desktop publisher sends an EMPTY STRING media session id, which `??` does not catch.
            // The user id is the sound fallback: a primary connection's LiveKit identity is the bare user id.
            const mediaSessionId = p.mediaSessionId || p.userId;
            void this.rtc.subscribeAudio([{
                userId: p.userId, mediaSessionId, trackName: p.audioTrackName,
            }]);

            for (const share of p.shares) {
                // The share's own session, never the microphone one; a null here is not an invitation to fall back.
                const shareSessionId = share.mediaSessionId;
                if (!shareSessionId) continue;

                for (const trackName of share.trackNames) {
                    const {kind} = describeTrack(trackName);
                    if (kind === 'screenAudio') {
                        void this.rtc.subscribeAudio([{
                            userId: p.userId, mediaSessionId: shareSessionId, trackName, kind: 'screenAudio',
                        }]);
                    } else {
                        void this.rtc.subscribeVideo(
                            guildId, channelId, p.userId, shareSessionId, trackName, 'screen');
                    }
                }
            }

            // Cameras, from `videoTracks`: `'video'` and never `'screen'`, since the kind decides the layout.
            for (const video of p.videoTracks ?? []) {
                // Its own session; a null is not an invitation to fall back on the microphone's.
                if (!video.mediaSessionId) continue;
                void this.rtc.subscribeVideo(
                    guildId, channelId, p.userId, video.mediaSessionId, video.trackName, 'video');
            }
        }

        if (skipped.length) {
            console.warn('[voice] backfill passed over', skipped.join(' '));
        }
    }

    /** "You are behind", or on `roomGone` "you are not in a room at all". Never version-gated: `roomGone` carries a blank instance and version zero. */
    private async onResync(e: { channelId: string; reason: string }): Promise<void> {
        if (e.channelId !== this.joinedChannelId()) return;

        if (e.reason === 'roomGone') {
            // Never a silent rejoin: re-admitting ourselves is exactly what the server refuses to do.
            const guildId = this.joinedGuildId();
            if (guildId) await this.doLeave(guildId, e.channelId, true);
            this.clearJoinedState();
            this.toast.info('Voice channel is no longer available');
            return;
        }

        await this.refetchSnapshot();
    }

    /** What this client asserts about itself on every beat. Honest, including when not publishing. */
    private sendHeartbeat(channelId: string): void {
        const published = this.rtc.publishedMedia;
        this.guildWsSvc.invokeVoiceHeartbeat(channelId, {
            knownInstanceId: this.tracker.instanceId,
            knownVersion: this.tracker.version,
            mediaSessionId: published?.mediaSessionId ?? null,
            audioTrackName: published?.audioTrackName ?? null,
        });
    }

    // ── Voice state loading for sidebar ───────────────────────────────────────

    loadVoiceStatesForGuild(channels: ChannelDto[], guildId: string): void {
        if (this.lastLoadedGuildId === guildId) return;
        this.lastLoadedGuildId = guildId;

        channels
            .filter(c => c.type === ChannelType.Voice)
            .forEach(channel => {
                if (this.joinedChannelId() === channel.id) return;
                this.guildVoiceSvc.getSnapshot(guildId, channel.id).subscribe({
                    next: snapshot => {
                        const ownId = this.profileService.ownProfile()?.userId ?? '';
                        const participants = snapshot.participants
                            .map(p => this.snapshotToParticipant(p, ownId));
                        this.channelParticipantsSignal.update(map => {
                            const n = new Map(map);
                            n.set(channel.id, participants);
                            return n;
                        });
                    },
                    error: () => {
                    },
                });
            });
    }

    // ── Join / leave ───────────────────────────────────────────────────────────

    /** Join a voice channel. The joined-state signals are set only once the server has admitted us; returns false when it did not, and callers must check it. */
    async joinChannel(channel: ChannelDto, guildName: string): Promise<boolean> {
        // Any join in flight, not just one for this channel: two joins race one set of joined-state signals.
        if (this.pendingJoinId()) return false;
        if (this.joinedChannelId() === channel.id) return true;

        const prevId = this.joinedChannelId();
        const prevGuild = this.joinedGuildId();
        this.pendingJoinId.set(channel.id);

        try {
            // A leave the user did not wait for must finish first, or its teardown closes this join's transport.
            await this.leaveInFlight;
            if (prevId && prevGuild) {
                await this.doLeave(prevGuild, prevId, true);
            }

            try {
                // Join answers with the room's authoritative state; `applySnapshot` also seeds the version tracker.
                const snapshot = await firstValueFrom(
                    this.guildVoiceSvc.join(channel.guildId, channel.id));

                this.joinedChannelId.set(channel.id);
                this.joinedGuildId.set(channel.guildId);
                this.joinedChannelName.set(channel.name);
                this.joinedGuildName.set(guildName);
                // Before the snapshot is applied, because that is what files the room's limits.
                this.limits.enterRoom(channel.guildId);
                // Mute and deafen survive the join; only the two flags holding a live publication are cleared.
                this.localState.update(s => ({...s, isCameraOn: false, isScreenSharing: false}));

                await this.applySnapshot(snapshot);
                this.soundSettings.playVoiceJoin();
                const connected = await this.rtc.connect(channel.guildId, channel.id);
                if (!connected) {
                    console.error('VoiceChannelService: WebRTC connect() returned false -audio setup failed');
                    await this.doLeave(channel.guildId, channel.id, false);
                    this.clearJoinedState();
                    this.toast.error(this.translate.instant('VOICE.JOIN_FAILED'));
                    return false;
                }
                // The engine starts with its talk key up, so without this a push-to-talk user joins silent.
                this.syncMic();

                // Read the room again now that connect() has resolved: video subscribes need `pc` and the
                // receive-side media session, neither of which existed when the join snapshot landed.
                void this.refetchSnapshot();

                // Tell the room what it cannot infer: the join event everyone else builds from carries no mute state.
                const {isMuted, isDeafened} = this.localState();
                if (isMuted) this.guildWsSvc.invokeVoiceMuteChanged(channel.id, true);
                if (isDeafened) {
                    this.guildWsSvc.invokeVoiceDeafenChanged(channel.id, true);
                    this.rtc.setDeafened(true);
                }

                // Liveness and repair: stop sending this and the heartbeat sweep evicts this client after 90s.
                this.heartbeatTimer = setInterval(() => this.sendHeartbeat(channel.id), 30_000);

                // Whatever the room gave less of than was asked for: a success carrying a note, not a failure.
                this.limits.noteDegradations(snapshot);
                return true;
            } catch (err) {
                console.error('VoiceChannelService: join failed', err);
                this.clearJoinedState();
                // The previous channel was left silently on the assumption this join would land; it did not,
                // so the server has to be told explicitly or the old room still shows the user in it.
                if (prevId && prevGuild) {
                    await firstValueFrom(this.guildVoiceSvc.leave(prevGuild, prevId)).catch(() => {
                    });
                }
                this.toast.error(this.translate.instant(this.joinFailureKey(err)));
                return false;
            }
        } finally {
            this.pendingJoinId.set(null);
        }
    }

    /** What to tell the user about a join that did not happen; an entitlement refusal gets its own sentence. */
    private joinFailureKey(err: unknown): string {
        const denial = describeEntitlementDenial(err);
        return denial?.messageKey ?? 'VOICE.JOIN_FAILED';
    }

    /** Leaves the channel and does not wait to say so: the joined-state signals are cleared first, the opposite of {@link joinChannel}. */
    async leaveChannel(): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || !guildId) return;
        // Ahead of the awaits, and safe: `doLeave` takes the room to close over its parameters.
        this.clearJoinedState();
        await this.runLeave(guildId, channelId, false);
    }

    /** {@link doLeave}, published as {@link leaveInFlight} for the length of it. */
    private async runLeave(guildId: string, channelId: string, silent: boolean): Promise<void> {
        const leaving = this.doLeave(guildId, channelId, silent);
        this.leaveInFlight = leaving;
        try {
            await leaving;
        } finally {
            // Guarded on identity so a later leave's teardown is not un-published by this one finishing late.
            if (this.leaveInFlight === leaving) this.leaveInFlight = null;
        }
    }

    /** Out of every channel as far as this client is concerned; mute and deafen are preferences and are left alone. */
    private clearJoinedState(): void {
        this.joinedChannelId.set(null);
        this.joinedGuildId.set(null);
        this.joinedChannelName.set(null);
        this.joinedGuildName.set(null);
        this.localState.update(s => ({...s, isCameraOn: false, isScreenSharing: false}));
        // Held tiles belong to the stage that is going away; an expiry after this patches a channel we left.
        this.screenResume.clear();
        this.screenResuming.set(new Set());
        // Nothing a room said about its plan outlives the room.
        this.limits.clear();
    }

    toggleMute(): void {
        this.localState.update(s => ({...s, isMuted: !s.isMuted}));
        this.syncMic();
        const channelId = this.joinedChannelId();
        if (channelId) this.guildWsSvc.invokeVoiceMuteChanged(channelId, this.localState().isMuted);
        this.syncLocal();
        this.persistSticky();
    }

    /** Push-to-talk gate, set by {@link CallHotkeyService} as the key is held/released. */
    setPttGateOpen(open: boolean): void {
        this.pttGateOpen.set(open);
        this.syncMic();
    }

    // ── Local controls ─────────────────────────────────────────────────────────

    toggleDeafen(): void {
        this.localState.update(s => {
            const d = !s.isDeafened;
            return {...s, isDeafened: d, isMuted: d || s.isMuted};
        });
        const {isDeafened, isMuted} = this.localState();
        this.syncMic();
        this.rtc.setDeafened(isDeafened);
        const channelId = this.joinedChannelId();
        if (channelId) {
            this.guildWsSvc.invokeVoiceDeafenChanged(channelId, isDeafened);
            this.guildWsSvc.invokeVoiceMuteChanged(channelId, isMuted);
        }
        this.syncLocal();
        this.persistSticky();
    }

    /** Remember mute and deafen for the next launch. Best-effort: a failed write is not worth failing a mute over. */
    private persistSticky(): void {
        const {isMuted, isDeafened} = this.localState();
        try {
            localStorage.setItem(STICKY_VOICE_STATE_KEY, JSON.stringify({isMuted, isDeafened}));
        } catch { /* storage unavailable */
        }
    }

    /** The one place that gates the outgoing mic: mute and the PTT key must stay separate, because the engine's voice-activity gate distinguishes them. */
    private syncMic(): void {
        const {isMuted} = this.localState();
        // Mute is engine-wide; the talk key goes through the RTC service, so keying here cannot also
        // open Isle proximity voice.
        void this.voiceEngine.setMute(isMuted);
        this.rtc.setPttOpen(this.pttGateOpen());
    }

    /** Whether starting video would only be turned down, and why. Null while publishing: stopping is never blocked. */
    videoBlock(alreadyPublishing: boolean): 'audio_only' | 'publishers_full' | null {
        return this.limits.videoBlock(alreadyPublishing);
    }

    async toggleCamera(): Promise<void> {
        const guildId = this.joinedGuildId();
        const channelId = this.joinedChannelId();
        if (!guildId || !channelId) return;
        if (this.videoBlock(this.localState().isCameraOn)) return;

        if (this.localState().isCameraOn) {
            await this.rtc.closeCamera(guildId, channelId);
            this.localState.update(s => ({...s, isCameraOn: false}));
            this.guildWsSvc.invokeVoiceCameraChanged(channelId, false);
        } else {
            const trackName = await this.rtc.publishCamera(guildId, channelId);
            if (trackName === null) return;
            this.localState.update(s => ({...s, isCameraOn: true}));
            this.guildWsSvc.invokeVoiceCameraChanged(channelId, true);
        }
        this.syncLocal();
    }

    async toggleScreenShare(): Promise<void> {
        const guildId = this.joinedGuildId();
        const channelId = this.joinedChannelId();
        if (!guildId || !channelId) return;
        // Checked before the picker opens: a source dialog for a publish that cannot happen is worse than no button.
        if (this.videoBlock(this.localState().isScreenSharing)) return;

        if (this.localState().isScreenSharing) {
            const result = await this.rtc.closeScreen(guildId, channelId);
            if (result) this.guildWsSvc.invokeVoiceScreenShareStopped(channelId, result.shareId);
            this.localState.update(s => ({...s, isScreenSharing: false}));
        } else {
            const result = await this.rtc.publishScreen(guildId, channelId);
            if (!result) return;
            this.guildWsSvc.invokeVoiceScreenShareStarted(channelId, result.shareId);
            this.localState.update(s => ({...s, isScreenSharing: true}));
        }
        this.syncLocal();
    }

    /** Change stream quality mid-share. Announces nothing: a preset is applied to the running publish in place, so the share id viewers hold stays valid. */
    async setScreenPreset(preset: StreamPreset): Promise<void> {
        if (!this.joinedChannelId()) return;
        await this.rtc.setScreenPreset(preset);
    }

    setServerDeafened(userId: string, isDeafened: boolean): void {
        const channelId = this.joinedChannelId();
        if (!channelId) return;
        this.patchParticipant(channelId, userId, p => ({
            ...p,
            isServerDeafened: isDeafened,
            isMuted: isDeafened || p.isMuted
        }));
    }

    setUserVolume(userId: string, volume: number): void {
        this.rtc.setUserVolume(userId, volume);
    }

    getUserVolume(userId: string): number {
        return this.rtc.getUserVolume(userId);
    }

    /** A participant's stream volume, independent of their voice - see VoiceRTCService.setScreenVolume. */
    setScreenVolume(userId: string, volume: number): void {
        this.rtc.setScreenVolume(userId, volume);
    }

    getScreenVolume(userId: string): number {
        return this.rtc.getScreenVolume(userId);
    }

    isScreenAudioMuted(userId: string): boolean {
        return this.rtc.isScreenAudioMuted(userId);
    }

    toggleScreenAudioMute(userId: string): void {
        this.rtc.toggleScreenAudioMute(userId);
    }

    toggleLocalScreenAudio(): void {
        this.rtc.toggleLocalScreenAudio();
    }

    getVideoStream(userId: string): MediaStream | null {
        return this.rtc.getVideoStream(userId);
    }

    getScreenStream(userId: string): MediaStream | null {
        return this.rtc.getScreenStream(userId);
    }

    private async doLeave(guildId: string, channelId: string, silent: boolean): Promise<void> {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        // The next channel starts from nothing: two rooms have unrelated version counters.
        this.tracker.reset();
        this.soundSettings.playVoiceLeave();
        await this.rtc.closeAllTracks(guildId, channelId);
        this.rtc.teardown();
        if (!silent) {
            await firstValueFrom(this.guildVoiceSvc.leave(guildId, channelId)).catch(() => {
            });
        }
        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(channelId, (n.get(channelId) ?? []).filter(p => !p.isLocal));
            return n;
        });
    }

    /** Mirrors {@link leaveChannel} with `silent: true`: the server already removed this device when the other one joined. */
    private async onKickedByOtherDevice(e: WsKickedByOtherDevice): Promise<void> {
        if (e.channelId !== this.joinedChannelId()) return;
        const guildId = this.joinedGuildId();
        if (!guildId) return;

        // Cleared before the teardown, as in {@link leaveChannel}: this device is already out of the room.
        this.clearJoinedState();
        this.toast.info('You joined this channel from another device');
        await this.runLeave(guildId, e.channelId, true);
    }

    // ── SignalR event handlers ─────────────────────────────────────────────────

    private onUserJoinedVoice(e: WsUserJoinedVoice): void {
        this.gate(e.channelId, e, () => this.applyUserJoinedVoice(e));
    }

    private applyUserJoinedVoice(e: WsUserJoinedVoice): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        if (e.userId === ownId) return;

        if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceJoin();

        // Named by {@link channelParticipants} once the profile lands, not here.
        this.profileService.resolveByUserId(e.userId);
        const participant: VoiceChannelParticipant = {
            userId: e.userId,
            displayName: e.userId,
            avatarLabel: '?',
            isMuted: false,
            isSpeaking: false,
            isCameraOn: false,
            isScreenSharing: false,
            isServerDeafened: false,
            isLocal: false,
        };

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            const list = n.get(e.channelId) ?? [];
            if (!list.find(p => p.userId === e.userId)) n.set(e.channelId, [...list, participant]);
            return n;
        });
    }

    private onUserLeftVoice(e: WsUserLeftVoice): void {
        this.gate(e.channelId, e, () => this.applyUserLeftVoice(e));
    }

    private applyUserLeftVoice(e: WsUserLeftVoice): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';

        // Never apply our own departure from the channel we are in: `roomGone` owns that teardown.
        // For a channel we are not in, this is the only thing that corrects the sidebar after the
        // heartbeat sweep evicts a channel seat that outlived the client (a force quit).
        if (e.userId === ownId && e.channelId === this.joinedChannelId()) return;

        if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceLeave();

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(e.channelId, (n.get(e.channelId) ?? []).filter(p => p.userId !== e.userId));
            return n;
        });

        // Voice teardown must be guarded on room id: `cleanupParticipant` is keyed on user but these
        // events carry a room, so an unguarded call silently tears a live participant's audio out of
        // our call. The roster update above stays ungated on purpose.
        if (e.userId !== ownId && e.channelId === this.joinedChannelId()) {
            this.rtc.cleanupParticipant(e.userId);
        }
    }

    private onParticipantJoined(e: WsGuildParticipantJoined): void {
        if (e.channelId !== this.joinedChannelId()) return;
        this.gate(e.channelId, e, () => {
            this.patchParticipant(e.channelId, e.userId, p => ({...p, mediaSessionId: e.mediaSessionId}));

            // Our own announcement is worth patching in above but must never be subscribed to: a
            // session cannot pull its own local track, and nothing announces that participant twice.
            if (e.userId === (this.profileService.ownProfile()?.userId ?? '')) return;

            void this.rtc.subscribeAudio([{
                userId: e.userId, mediaSessionId: e.mediaSessionId, trackName: e.audioTrackName,
            }]);
        });
    }

    private onTrackPublished(e: WsGuildTrackPublished): void {
        if (e.channelId !== this.joinedChannelId()) return;
        const guildId = this.joinedGuildId();
        if (!guildId) return;

        this.gate(e.channelId, e, () => {
            if (e.kind === 'screenAudio') {
                void this.rtc.subscribeAudio([{
                    userId: e.userId, mediaSessionId: e.mediaSessionId, trackName: e.trackName, kind: 'screenAudio',
                }]);
            } else {
                void this.rtc.subscribeVideo(guildId, e.channelId, e.userId, e.mediaSessionId, e.trackName,
                    e.kind === 'screen' ? 'screen' : 'video');
            }
        });
    }

    private onTrackClosed(e: WsGuildTrackClosed): void {
        if (e.channelId !== this.joinedChannelId()) return;
        this.gate(e.channelId, e, () => {
            this.rtc.handleRemoteTrackClosed(e.trackName, e.userId);
            const {kind} = describeTrack(e.trackName);
            if (kind === 'video') {
                this.patchParticipant(e.channelId, e.userId, p => ({...p, isCameraOn: false}));
            } else if (kind === 'screen') {
                // Deliberately not `isScreenSharing: false`: a source switch, a dead publication and a
                // renegotiation all look like this. The seat is held instead, and expiry clears the flag.
                this.screenResume.hold(e.userId);
                this.screenResuming.update(ids => new Set(ids).add(e.userId));
            }
        });
    }

    /** Whether this user's picture is between tracks and expected back - see {@link screenResume}. */
    isScreenResuming(userId: string): boolean {
        return this.screenResuming().has(userId);
    }

    /** A held share came back, or really ended. Keeps the signal and the tracker in step. */
    private endScreenResume(userId: string): void {
        this.screenResume.cancel(userId);
        this.screenResuming.update(ids => {
            if (!ids.has(userId)) return ids;
            const next = new Set(ids);
            next.delete(userId);
            return next;
        });
    }

    private onMuteChanged(e: WsVoiceMuteChanged): void {
        this.gate(e.channelId, e, () =>
            this.patchParticipant(e.channelId, e.userId, p => ({...p, isMuted: e.isMuted})));
    }

    private onDeafenChanged(e: WsVoiceDeafenChanged): void {
        this.gate(e.channelId, e, () => {
            if (e.isDeafened) this.patchParticipant(e.channelId, e.userId, p => ({...p, isMuted: true}));
        });
    }

    /** Relay: the server does not store camera state and does not version it. */
    private onCameraChanged(e: WsVoiceCameraChanged): void {
        this.gateRelay(e.channelId, e, () =>
            this.patchParticipant(e.channelId, e.userId, p => ({...p, isCameraOn: e.isCameraOn})));
    }

    private onScreenShareStarted(e: WsVoiceScreenShareStarted): void {
        this.gate(e.channelId, e, () => {
            // Before the patch, so the tile goes straight from held to live rather than flickering.
            this.endScreenResume(e.userId);
            this.patchParticipant(e.channelId, e.userId, p => ({...p, isScreenSharing: true}));
        });
    }

    private async onMovedToChannel(e: WsMovedToChannel): Promise<void> {
        const pseudo: ChannelDto = {
            id: e.channelId, guildId: e.guildId, name: 'Voice Channel',
            type: ChannelType.Voice, createdAt: new Date(), updatedAt: new Date(),
            description: '', isAgeRestricted: false, isPrivate: false,
            categoryId: undefined, permissions: [], position: 0,
            slowModeSeconds: 0, parentChannelId: undefined,
        };
        await this.joinChannel(pseudo, this.joinedGuildName() ?? '');
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private syncLocal(): void {
        const channelId = this.joinedChannelId();
        if (!channelId) return;
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        const {isMuted, isCameraOn, isScreenSharing} = this.localState();
        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(channelId, (n.get(channelId) ?? []).map(p =>
                p.userId === ownId ? {...p, isMuted, isCameraOn, isScreenSharing} : p,
            ));
            return n;
        });
    }

    /** Returns the same map when `fn` changed nothing, so a no-op patch notifies nobody. */
    private patchParticipant(
        channelId: string,
        userId: string,
        fn: (p: VoiceChannelParticipant) => VoiceChannelParticipant,
    ): void {
        this.channelParticipantsSignal.update(map => {
            const list = map.get(channelId);
            if (!list) return map;
            let changed = false;
            const next = list.map(p => {
                if (p.userId !== userId) return p;
                const patched = fn(p);
                if (patched !== p) changed = true;
                return patched;
            });
            if (!changed) return map;
            const n = new Map(map);
            n.set(channelId, next);
            return n;
        });
    }

    /** The snapshot's participant shape. `isCameraOn` is seeded from `videoTracks`, because the `CameraChanged` that would otherwise mark it may never come. */
    private snapshotToParticipant(p: VoiceParticipantSnapshot, ownId: string): VoiceChannelParticipant {
        this.profileService.resolveByUserId(p.userId);
        return {
            userId: p.userId,
            // The id, deliberately: a roster entry must never hold a name. See {@link channelParticipants}.
            displayName: p.userId,
            avatarLabel: '?',
            isMuted: p.isSelfMuted || p.isServerMuted,
            isSpeaking: false,
            isCameraOn: (p.videoTracks?.length ?? 0) > 0,
            isScreenSharing: p.isStreaming,
            isServerDeafened: p.isServerDeafened,
            isLocal: p.userId === ownId,
            mediaSessionId: p.mediaSessionId,
        };
    }

    /** Put ourselves in the roster if the snapshot has not caught up: a room we are not rendered in reads as a failed join. */
    private ensureLocalParticipant(channelId: string): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        this.channelParticipantsSignal.update(map => {
            const list = map.get(channelId) ?? [];
            if (list.some(p => p.isLocal)) return map;

            const n = new Map(map);
            n.set(channelId, [{
                userId: ownId,
                // Replaced with our own name by {@link channelParticipants} once `/profiles/me` answers.
                displayName: 'You',
                avatarLabel: 'Y',
                // Seeded, not assumed false: arriving muted and rendering yourself live is a disagreement.
                isMuted: this.localState().isMuted,
                isSpeaking: false,
                isCameraOn: false,
                isScreenSharing: false,
                isServerDeafened: false,
                isLocal: true,
            }, ...list]);
            return n;
        });
    }
}
