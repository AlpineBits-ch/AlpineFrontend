import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {describeEntitlementDenial} from '../core/entitlement-message';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';
import {VoiceLimitsService} from './voice-limits.service';
import {ProfileService} from './profile.service';
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

/**
 * Mute and deafen outlive the call they were set in.
 *
 * <p>They are statements about this machine's microphone and speakers, not about a channel. A user
 * who mutes before joining means "do not transmit when I get there", and wiping the flag on join
 * answers a question they did not ask — it also makes the always-visible mic button in the bottom
 * bar a liar, since the state it shows would silently reset underneath it.</p>
 *
 * <p>Camera and screen share are deliberately <b>not</b> persisted. Each holds a live publication
 * tied to the channel it was started in, so neither can mean anything after a channel change.</p>
 */
export function loadStickyVoiceState(): Pick<VoiceLocalState, 'isMuted' | 'isDeafened'> {
    try {
        const raw = localStorage.getItem(STICKY_VOICE_STATE_KEY);
        if (!raw) return {isMuted: false, isDeafened: false};
        const stored = JSON.parse(raw) as Partial<VoiceLocalState>;
        // Explicit true, not truthiness: a corrupt blob should read as "not muted" rather than as
        // whatever a stray string coerces to.
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
    /**
     * Push-to-talk gate, independent of the deliberate mute toggle - true means
     * "allowed to transmit". Driven by {@link CallHotkeyService}; stays true when
     * no push-to-talk key is bound, so the mic is open by default.
     */
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
    /**
     * What this room's plan allows, and what it has already reduced. Held for the life of the call
     * rather than announced once: a ceiling is a condition, not an event.
     */
    readonly limits = inject(VoiceLimitsService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private channelParticipantsSignal = signal<Map<string, VoiceChannelParticipant[]>>(new Map());

    /**
     * Users whose screen track has closed and whose picture is still expected back.
     *
     * <p>Read by the stage projections to mark a tile `'resuming'` rather than removing it. A signal
     * beside the tracker, not derived from it, because a `setTimeout` map cannot be read reactively
     * and the grid has to repaint the moment either edge of the window is crossed.</p>
     */
    private readonly screenResuming = signal<ReadonlySet<string>>(new Set());

    /**
     * The grace window itself. Expiry is the only thing that finally clears `isScreenSharing`,
     * which is what makes "the track closed" and "they stopped sharing" two different events.
     */
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
    readonly channelParticipants = this.channelParticipantsSignal.asReadonly();

    // ── Sidebar voice state cache ──────────────────────────────────────────────
    private lastLoadedGuildId: string | null = null;

    // ── Join guard ─────────────────────────────────────────────────────────────

    private pendingJoinId: string | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    /**
     * `instanceId` and `version` for the channel we are in, and the decision procedure for every
     * event that arrives about it. See {@link VoiceRoomTracker}.
     */
    private readonly tracker = new VoiceRoomTracker();
    /** Guards against a burst of gaps firing a refetch per event. */
    private refetchInFlight = false;
    /** Previous hub state, so only the transition *into* Connected fires the reconnect heartbeat. */
    private prevConnectionState: ConnectionState | null = null;

    constructor() {
        // Remote participants' speaking state, from the Rust mixer.
        //
        // These come from the same decoded frames that reach the speakers, so the indicator cannot
        // disagree with what is audible - which it could when each `<audio>` element had its own
        // WebAudio analyser making an independent judgement.
        effect(() => {
            const levels = this.voiceEngine.remoteLevels();
            const channelId = this.joinedChannelId();
            if (!channelId) return;
            for (const [userId, level] of levels) {
                this.patchParticipant(channelId, userId, p =>
                    p.isSpeaking === level.speaking ? p : {...p, isSpeaking: level.speaking});
            }
        });

        // Own speaking state, straight from the Rust gate. This is the same decision that picks
        // which frames are transmitted, so the indicator cannot disagree with what is actually
        // being sent - the release hold that used to live here is now part of that gate.
        effect(() => {
            const isSpeaking = this.voiceEngine.speaking();
            const channelId = this.joinedChannelId();
            const ownId = this.profileService.ownProfile()?.userId;
            if (!channelId || !ownId) return;
            this.patchParticipant(channelId, ownId, p => p.isSpeaking === isSpeaking ? p : {...p, isSpeaking});
        });

        // A hub reconnect is when to *assert* our state, not when to rebuild it.
        //
        // Nothing here touches the peer connection or the media session, deliberately. Media rides
        // its own transport and a websocket blip says nothing about it; rebuilding on every blip
        // spends the media session id and earns `sessionGone` on everything after it.
        //
        // What a reconnect does mean is that events broadcast during the gap are lost - SignalR does
        // not queue them - and that the server has shortened our liveness to 45 seconds. One
        // heartbeat answers both: it restores the liveness window, and it hands back a Snapshot if
        // we fell behind. Sent now rather than at the next tick of the 30-second timer, which could
        // be 29 seconds of a stale roster away.
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

        // A publish the server refused outright. The card explaining it is already filed by the time
        // this fires; this is the acknowledgement that the button did nothing, which is the one
        // thing a persistent surface cannot say. It never reaches the generic error path - "video
        // failed" is a different sentence from "this server's plan does not include it".
        this.limits.refused$.subscribe(notice =>
            this.toast.error(this.translate.instant(notice.messageKey)));

        // A subscribe the server refused as stale means the roster we acted on is out of date. The
        // refetch is guarded against bursts, so several refusals in a row cost one read.
        this.rtc.staleSubscription$.subscribe(() => void this.refetchSnapshot());
    }

    // ── Recovery ───────────────────────────────────────────────────────────────

    /**
     * Decide what an arriving event means, and act on it.
     *
     * <p>Events about other channels drive the sidebar roster and carry a version for a room we are
     * not tracking, so they bypass the gate entirely - comparing them against the version we hold
     * for the channel we are *in* would refetch on every one of them.</p>
     */
    private gate(channelId: string, event: VoiceEventEnvelope, apply: () => void): void {
        this.decide(channelId, apply, () => this.tracker.receive(event));
    }

    /**
     * The same, for relay events - applied without advancing the version. See
     * {@link VoiceRoomTracker.receiveRelay}.
     */
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

    /**
     * Read the authoritative state again, because what we hold cannot be repaired from an event.
     *
     * <p>Best-effort and deliberately not retried here: a failed read is covered by the next
     * heartbeat, which asserts a version the server will disagree with and pushes a snapshot
     * back.</p>
     */
    private async refetchSnapshot(): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || !guildId || this.refetchInFlight) return;

        this.refetchInFlight = true;
        try {
            const snapshot = await firstValueFrom(this.guildVoiceSvc.getSnapshot(guildId, channelId));
            // The channel can be left while the request is in flight; applying it then would
            // populate a roster for a room we are no longer in.
            if (this.joinedChannelId() !== channelId) return;
            await this.applySnapshot(snapshot);
        } catch (err) {
            console.error('[voice] snapshot refetch failed', err);
        } finally {
            this.refetchInFlight = false;
        }
    }

    /**
     * Take a snapshot wholesale and reconcile media against it.
     *
     * <p>Two halves, and the second is the one this whole mechanism exists for. The roster is
     * replaced rather than merged - the reason to be holding a snapshot is that the local copy is
     * known to be wrong. Then every publisher and every live screen-share track in it is
     * subscribed to, which is what a viewer joining a channel where a share is already running has
     * never been able to do: `isStreaming` said someone was sharing, and the track name needed to
     * pull it - `screen-{shareId}`, a UUID chosen by the publisher - existed nowhere the joiner
     * could reach. `shares[].trackNames` is that missing piece.</p>
     */
    private async applySnapshot(snapshot: VoiceRoomSnapshot): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || snapshot.roomId !== channelId) return;

        this.tracker.applySnapshot(snapshot);
        // Every snapshot, not only the join reply. A room's limits can move during a call - a boost
        // lapses, a plan downgrades at period end - and the snapshot is the only ordered channel
        // that carries the change.
        this.limits.applySnapshot(snapshot);

        const ownId = this.profileService.ownProfile()?.userId ?? '';
        const list = snapshot.participants.map(p => this.snapshotToParticipant(p, ownId));

        // Our own row is rebuilt from local state rather than from the snapshot: mute, camera and
        // screen share are things this client decided, and the server's copy of them lags by a
        // round trip.
        const {isMuted, isCameraOn, isScreenSharing} = this.localState();
        const withLocal = list.map(p => p.isLocal ? {...p, isMuted, isCameraOn, isScreenSharing} : p);

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(channelId, withLocal);
            return n;
        });
        // Every snapshot, not just the one from join. The roster is replaced wholesale, so any
        // snapshot that has not caught up with our own join erases us from our own channel - which
        // reads as "the join failed" and hides the mute button's target.
        this.ensureLocalParticipant(channelId);

        // Anyone who left while we were out of sync. `Resync{participantLeft}` covers the live case;
        // this covers everything missed.
        const present = new Set(snapshot.participants.map(p => p.userId));
        for (const known of this.rtc.subscribedUserIds()) {
            if (!present.has(known)) this.rtc.cleanupParticipant(known);
        }

        if (!guildId) return;
        await this.subscribeFromSnapshot(snapshot, guildId, channelId, ownId);
    }

    /**
     * Subscribe to everything in the snapshot that is pullable.
     *
     * <p>Idempotent by construction: both subscribe paths key on (source, publishing session), so
     * re-running this on every snapshot costs nothing for tracks already held and repairs the ones
     * that were missed.</p>
     */
    private async subscribeFromSnapshot(
        snapshot: VoiceRoomSnapshot,
        guildId: string,
        channelId: string,
        ownId: string,
    ): Promise<void> {
        for (const p of snapshot.participants) {
            // Our own announcement names the session *we* publish on, and Cloudflare will not let a
            // session pull its own local track: the subscribe fails identically every time and the
            // participant never recovers.
            if (p.userId === ownId) continue;
            // A session id alone is not an invitation to subscribe. `Joined` means a session exists
            // and a track does not, so the pull would fail and burn the retry budget.
            if (p.publishState !== 'Publishing' || !p.mediaSessionId || !p.audioTrackName) continue;

            const mediaSessionId = p.mediaSessionId;
            void this.rtc.subscribeAudio([{
                userId: p.userId, mediaSessionId, trackName: p.audioTrackName,
            }]);

            for (const share of p.shares) {
                // The share's own session, never the microphone one above - see
                // `VoiceShareSnapshot.mediaSessionId`. A null is not an invitation to fall back:
                // the handle for such a share exists only in the `TrackPublished` we already
                // received, so the live subscription is the best copy there is and re-announcing
                // it from here could only replace it with one that cannot work.
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
        }
    }

    /**
     * "You are behind" - or, on `roomGone`, "you are not in a room at all any more".
     *
     * <p>Deliberately not version-gated. A resync is an instruction rather than state, and
     * `roomGone` carries a blank instance and version zero precisely because there is no incarnation
     * left to compare against; running it through the tracker would classify the one event that
     * matters most as a stale duplicate.</p>
     */
    private async onResync(e: { channelId: string; reason: string }): Promise<void> {
        if (e.channelId !== this.joinedChannelId()) return;

        if (e.reason === 'roomGone') {
            // Not "silently rejoin": the room is gone or we are not in it, and re-admitting
            // ourselves on our own say-so is exactly what the server refuses to do. Rejoining goes
            // through the authorised path, which means the user asking for it.
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

    /**
     * Join a voice channel, and say whether it worked.
     *
     * <p><b>The joined-state signals are set only once the server has admitted us.</b> They used to
     * be written before the request went out, so a refusal - a permission change, a full room, an
     * entitlement rejection - left the sidebar, the status bar and the mute controls all rendering
     * as joined against no media, with no way out except clicking another channel. Everything that
     * can fail before that point rolls the state back and says so, because a join that silently
     * half-succeeds is worse than one that visibly does not.</p>
     *
     * <p>Returns false when the channel was not joined. Callers that do something to the room
     * afterwards - focusing a stream, opening the stage - have to check it, or they act on a room
     * that is not there.</p>
     */
    async joinChannel(channel: ChannelDto, guildName: string): Promise<boolean> {
        if (this.pendingJoinId === channel.id) return false;
        if (this.joinedChannelId() === channel.id) return true;

        const prevId = this.joinedChannelId();
        const prevGuild = this.joinedGuildId();
        this.pendingJoinId = channel.id;

        try {
            if (prevId && prevGuild) {
                await this.doLeave(prevGuild, prevId, true);
            }

            try {
                // Join answers with the room's authoritative state, so there is no second read and
                // no second shape: the same snapshot the SignalR event carries, through the same
                // apply path. `applySnapshot` also seeds the version tracker, which is what makes
                // the very next event classifiable.
                const snapshot = await firstValueFrom(
                    this.guildVoiceSvc.join(channel.guildId, channel.id));

                this.joinedChannelId.set(channel.id);
                this.joinedGuildId.set(channel.guildId);
                this.joinedChannelName.set(channel.name);
                this.joinedGuildName.set(guildName);
                // Before the snapshot is applied, because that is what files the room's limits.
                this.limits.enterRoom(channel.guildId);
                // Mute and deafen survive the join - see loadStickyVoiceState. Only the two flags
                // that hold a live publication are cleared.
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
                // The engine starts with its talk key up, which in push-to-talk mode means the gate
                // is shut. Nothing else calls syncMic until the user toggles something, so without
                // this a push-to-talk user joins silent and has no way to tell why.
                this.syncMic();

                // Read the room again now that there is something to subscribe *on*.
                //
                // The join snapshot above lands before this point: audio survives that because
                // subscribeAudio waits for the Rust session, but video needs `pc` and the
                // receive-side media session, and neither exists until connect resolves. Without
                // this, the snapshot's screen shares are dropped on the floor and joining a channel
                // mid-share shows nothing - the exact bug this is all for.
                void this.refetchSnapshot();

                // Tell the room what it cannot infer. Everyone else builds their roster from the
                // join event, which carries no mute state, so a user who arrived already muted
                // would render as live to every other participant - their mic off, and the UI
                // saying otherwise, which is the worst combination of the two.
                const {isMuted, isDeafened} = this.localState();
                if (isMuted) this.guildWsSvc.invokeVoiceMuteChanged(channel.id, true);
                if (isDeafened) {
                    this.guildWsSvc.invokeVoiceDeafenChanged(channel.id, true);
                    this.rtc.setDeafened(true);
                }

                // Liveness *and* repair. Stop sending it and the sweep evicts this client after
                // 90s; send it without the state below and the server can learn we are alive but
                // never that we are wrong, which is the whole reason a missed event used to be
                // permanent.
                this.heartbeatTimer = setInterval(() => this.sendHeartbeat(channel.id), 30_000);

                // Whatever the room gave less of than was asked for. This is a success carrying a
                // note, not a failure: the 11th member of a full room is in the room, on an
                // audio-only seat, and nothing above this line rolls back on account of it.
                this.limits.noteDegradations(snapshot);
                return true;
            } catch (err) {
                console.error('VoiceChannelService: join failed', err);
                this.clearJoinedState();
                // The previous channel was left silently, on the understanding that the server moves
                // a participant when their next join lands. That join did not land, so it has to be
                // told explicitly or the room the user just left still shows them in it.
                if (prevId && prevGuild) {
                    await firstValueFrom(this.guildVoiceSvc.leave(prevGuild, prevId)).catch(() => {
                    });
                }
                this.toast.error(this.translate.instant(this.joinFailureKey(err)));
                return false;
            }
        } finally {
            this.pendingJoinId = null;
        }
    }

    /**
     * What to tell the user about a join that did not happen.
     *
     * <p>An entitlement refusal is not a failure of the client's - the room was full, or the plan
     * does not stretch that far - and it has its own sentence naming which side bound and who can
     * change it. Everything else is the generic one. See
     * `Echo/docs/specs/entitlements-frontend-guide.md` section 4.</p>
     */
    private joinFailureKey(err: unknown): string {
        const denial = describeEntitlementDenial(err);
        return denial?.messageKey ?? 'VOICE.JOIN_FAILED';
    }

    async leaveChannel(): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || !guildId) return;
        await this.doLeave(guildId, channelId, false);
        this.clearJoinedState();
    }

    /**
     * Out of every channel, as far as this client is concerned.
     *
     * <p>Mute and deafen are preferences rather than call state and are deliberately left alone -
     * the bar's mic button still shows what the microphone is actually doing after the call ends.
     * The two flags that hold a live publication are not preferences and cannot outlive it.</p>
     */
    private clearJoinedState(): void {
        this.joinedChannelId.set(null);
        this.joinedGuildId.set(null);
        this.joinedChannelName.set(null);
        this.joinedGuildName.set(null);
        this.localState.update(s => ({...s, isCameraOn: false, isScreenSharing: false}));
        // Held tiles belong to the stage that is going away. An expiry firing afterwards would
        // patch a roster for a channel this client has left.
        this.screenResume.clear();
        this.screenResuming.set(new Set());
        // Nothing a room said about its plan outlives the room. Carrying a ceiling into the next
        // channel would disable a camera button on a plan that never mentioned one.
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

    /**
     * Remember mute and deafen for the next launch.
     *
     * <p>Best-effort: storage can be unavailable or full, and a failed write here is not worth
     * failing a mute over. The cost of losing it is one un-muted launch, which the button on screen
     * reports accurately either way.</p>
     */
    private persistSticky(): void {
        const {isMuted, isDeafened} = this.localState();
        try {
            localStorage.setItem(STICKY_VOICE_STATE_KEY, JSON.stringify({isMuted, isDeafened}));
        } catch { /* storage unavailable */
        }
    }

    /**
     * The one place that gates the outgoing mic: deliberate mute + the PTT key.
     *
     * Both go to the Rust engine, which owns the microphone. They stay separate there rather than
     * being collapsed into one boolean as they were when this toggled a MediaStreamTrack: the
     * engine's own voice-activity gate has to distinguish "the user muted" from "the talk key is
     * up", and in voice-activity mode there is no talk key at all.
     */
    private syncMic(): void {
        const {isMuted} = this.localState();
        // Mute is engine-wide - it is a statement about the microphone. The talk key is not: it goes
        // through the RTC service, which knows which publication this channel's audio is on, so
        // keying here cannot also open Isle proximity voice.
        void this.voiceEngine.setMute(isMuted);
        this.rtc.setPttOpen(this.pttGateOpen());
    }

    /**
     * Whether starting video would only be turned down, and why.
     *
     * <p>Read by the controls before they draw the button, and again here before the request goes
     * out. The two are not the same check: the first is what stops a camera button being offered
     * into an audio-only room, and the second is what stops a keyboard shortcut or a stale render
     * spending a `getUserMedia` prompt on a publish the server has already said no to.</p>
     *
     * <p>Null while publishing. Stopping is never blocked - see {@link videoPublishBlock}.</p>
     */
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
        // Checked before the picker opens. A source dialog for a publish that cannot happen is
        // worse than no button at all: the user chooses a window and then nothing appears.
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

    /**
     * Change stream quality mid-share.
     *
     * <p>Announces nothing, because nothing the room can see changes. Every part of a preset is now
     * applied to the running publish in place - the encoder is retyped rather than rebuilt - so the
     * share id viewers hold stays valid and their tiles never leave the grid.</p>
     *
     * <p>This used to relay a stopped-then-started pair for a resolution change, which is what made
     * one person adjusting their quality blank out everybody else's stage.</p>
     */
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
        // The next channel starts from nothing rather than from this one's version - two rooms have
        // unrelated counters, and carrying one across would make the first event in the new channel
        // read as a gap or as stale depending on which way the numbers happened to fall.
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

    /**
     * Mirrors {@link leaveChannel} with `silent: true` - the server already removed this device
     * when the other one joined, so calling the leave endpoint would only produce a pointless
     * request against a participant record that no longer exists.
     *
     * Before this event existed, joining from a second device left both fighting over one media
     * session and the first device's audio silently broke.
     */
    private async onKickedByOtherDevice(e: WsKickedByOtherDevice): Promise<void> {
        if (e.channelId !== this.joinedChannelId()) return;
        const guildId = this.joinedGuildId();
        if (!guildId) return;

        await this.doLeave(guildId, e.channelId, true);
        this.clearJoinedState();
        this.toast.info('You joined this channel from another device');
    }

    // ── SignalR event handlers ─────────────────────────────────────────────────

    private onUserJoinedVoice(e: WsUserJoinedVoice): void {
        this.gate(e.channelId, e, () => this.applyUserJoinedVoice(e));
    }

    private applyUserJoinedVoice(e: WsUserJoinedVoice): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        if (e.userId === ownId) return;

        if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceJoin();

        const profile = this.profileService.getCachedByUserId(e.userId);
        const participant: VoiceChannelParticipant = {
            userId: e.userId,
            displayName: profile?.userName ?? e.userId,
            avatarLabel: (profile?.userName?.[0] ?? '?').toUpperCase(),
            avatarUrl: profile?.avatarUrl,
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
        if (e.userId === ownId) return;

        if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceLeave();

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(e.channelId, (n.get(e.channelId) ?? []).filter(p => p.userId !== e.userId));
            return n;
        });

        this.rtc.cleanupParticipant(e.userId);
    }

    private onParticipantJoined(e: WsGuildParticipantJoined): void {
        if (e.channelId !== this.joinedChannelId()) return;
        this.gate(e.channelId, e, () => {
            this.patchParticipant(e.channelId, e.userId, p => ({...p, mediaSessionId: e.mediaSessionId}));

            // Our own announcement is still worth patching in above - it is what carries our session
            // id into the participant row - but it must never be subscribed to. Since the Rust
            // rewrite this event names the session *we* publish on, and Cloudflare will not let a
            // session pull its own local track: the subscribe fails identically on all four attempts
            // and the participant never recovers, because nothing announces them a second time. The
            // leave handler has always guarded on this; the join handler was the one that did not.
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
                // Deliberately not `isScreenSharing: false`. A closed screen track is usually the
                // end of a share, but it is also what a source switch, a dead publication and a
                // renegotiation look like - and clearing the flag here is what took the tile out of
                // every viewer's grid, reflowed the layout under it, and emptied the stage outright
                // for anyone watching that stream maximised. The seat is held instead; see
                // ScreenResumeTracker. If nothing comes back, expiry clears the flag.
                this.screenResume.hold(e.userId);
                this.screenResuming.update(ids => new Set(ids).add(e.userId));
            }
        });
    }

    /** Whether this user's picture is between tracks and expected back - see {@link screenResume}. */
    isScreenResuming(userId: string): boolean {
        return this.screenResuming().has(userId);
    }

    /**
     * A held share came back, or really ended. Either way it is no longer resuming.
     *
     * <p>Separate from the tracker's own `cancel` because the signal is what the projections read,
     * and leaving the two to be updated at each call site is how one of them drifts.</p>
     */
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
            // Before the patch, so the tile this replaces goes straight from held to live rather
            // than flickering through a frame of neither.
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

    /**
     * Returns the same map when `fn` changed nothing, so a no-op patch notifies nobody.
     *
     * This is written at speaking rate, and it used to rebuild the map unconditionally. No effect
     * here reads it, so it never looped - but the equivalent in CallSessionService did, and the
     * cheapest guarantee that it never starts is to not emit a change when there isn't one.
     */
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

    /**
     * The snapshot's participant shape, which carries strictly more than {@link VoiceParticipantDto}
     * - the media handles, the publish state, and the live shares.
     *
     * <p>`isCameraOn` is still seeded false, and that is not an oversight: camera state is relayed
     * rather than stored server-side, so it is genuinely absent from the snapshot. It arrives on the
     * next `CameraChanged`, or when the camera track is subscribed to.</p>
     */
    private snapshotToParticipant(p: VoiceParticipantSnapshot, ownId: string): VoiceChannelParticipant {
        const profile = this.profileService.getCachedByUserId(p.userId);
        return {
            userId: p.userId,
            displayName: profile?.userName ?? p.userId,
            avatarLabel: (profile?.userName?.[0] ?? '?').toUpperCase(),
            avatarUrl: profile?.avatarUrl,
            isMuted: p.isSelfMuted || p.isServerMuted,
            isSpeaking: false,
            isCameraOn: false,
            isScreenSharing: p.isStreaming,
            isServerDeafened: p.isServerDeafened,
            isLocal: p.userId === ownId,
            mediaSessionId: p.mediaSessionId,
        };
    }

    /**
     * Put ourselves in the roster if the snapshot has not caught up yet.
     *
     * <p>The server adds the joiner before any media work, so normally we are already in it. But a
     * room the local user is not rendered in reads as "the join failed", and that is not a state
     * worth leaving to a race.</p>
     */
    private ensureLocalParticipant(channelId: string): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        this.channelParticipantsSignal.update(map => {
            const list = map.get(channelId) ?? [];
            if (list.some(p => p.isLocal)) return map;

            const profile = this.profileService.ownProfile();
            const n = new Map(map);
            n.set(channelId, [{
                userId: ownId,
                displayName: profile?.userName ?? 'You',
                avatarLabel: (profile?.userName?.[0] ?? 'Y').toUpperCase(),
                avatarUrl: profile?.avatarUrl,
                // Seeded, not assumed false: arriving muted and rendering yourself live is the one
                // state where the room and the roster disagree about the same fact.
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
