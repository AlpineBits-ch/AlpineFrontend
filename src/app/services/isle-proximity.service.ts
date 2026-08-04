import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {IsleVoiceApiService} from './isle-voice-api.service';
import {IsleVoiceWebsocketService} from './isle-voice-websocket.service';
import {IsleVoiceRtcService} from './isle-voice-rtc.service';
import {SpatialAudioService} from './spatial-audio.service';
import {HotkeyService} from './hotkey.service';
import {NativePttService} from './native-ptt.service';
import {AudioSettingsService} from './audio-settings.service';
import {KeybindsService} from './keybinds.service';
import {findKeybindAction, KeybindActionId} from '../models/keybind-action.model';
import {UserService} from './user.service';
import {ToastService} from './toast.service';
import {SoundSettingsService} from './sound-settings.service';
import {RealtimeConnectionService, ConnectionState} from './realtime-connection.service';
import {PrivacySettingsService} from './privacy-settings.service';

/**
 * Public surface for Isle proximity voice -the UI binds to this.
 *
 * Owns detection (game-connected state), the join/leave flow, hotkey wiring, and
 * hub-reconnect resilience. Composes the REST, signalling, WebRTC and spatial
 * services. Runs entirely app-wide and independently of guild voice.
 *
 * The outgoing mic has exactly one gate, {@link syncMic}: push-to-talk,
 * toggle-mute and push-to-mute (each independent, each optional) - see
 * `keybind-action.model.ts` - the mute state and the connection state all feed
 * into it, and nothing else touches `rtc.setMicEnabled`.
 */

const PTT_ACTION = findKeybindAction('isle-ptt');
const TOGGLE_MUTE_ACTION = findKeybindAction('isle-toggle-mute');
const PUSH_TO_MUTE_ACTION = findKeybindAction('isle-push-to-mute');
/** How often to reconcile game/voice state against the backend. */
const STATUS_POLL_MS = 60_000;

@Injectable({providedIn: 'root'})
export class IsleProximityService {
    private api = inject(IsleVoiceApiService);
    private ws = inject(IsleVoiceWebsocketService);
    private rtc = inject(IsleVoiceRtcService);
    private spatial = inject(SpatialAudioService);
    private hotkey = inject(HotkeyService);
    private nativePtt = inject(NativePttService);
    private audioSettings = inject(AudioSettingsService);
    private keybinds = inject(KeybindsService);
    private userService = inject(UserService);
    private toast = inject(ToastService);
    private sounds = inject(SoundSettingsService);
    private realtime = inject(RealtimeConnectionService);
    private privacy = inject(PrivacySettingsService);

    // ── State the UI reads ──────────────────────────────────────────────────
    readonly isGameConnected = signal(false);
    readonly isVoiceActive = signal(false);
    readonly isConnecting = signal(false);
    /** Mic is open right now -derived by {@link syncMic}, never set directly. */
    readonly isTransmitting = signal(false);
    /** Mute toggle. Overrides both keys below. */
    readonly isMuted = signal(false);
    readonly connectedSince = signal<number | null>(null);

    readonly isLinked = computed(() => !!this.userService.self()?.steamId);
    readonly rtcState = this.rtc.rtcState;
    readonly peerCount = computed(() => this.rtc.peers().size);

    private detectionStarted = false;
    /** Which native hook slots already have a live edge subscription. */
    private readonly wiredSlots = new Set<number>();
    /** Push-to-talk is bound to something (any mechanism); without it the mic stays open. */
    private pttBound = false;
    /** Push-to-talk key physically held right now. */
    private pttHeld = false;
    /** Push-to-mute key physically held right now - forces the mic closed while true. */
    private pushMuteHeld = false;
    private pollHandle: ReturnType<typeof setInterval> | null = null;
    private lastConnState = ConnectionState.Disconnected;
    private republishing = false;

    constructor() {
        // Begin detection once the user is loaded (auth available for WS + REST).
        effect(() => {
            if (this.userService.self() && !this.detectionStarted) {
                this.startDetection();
            }
        });

        // Rebind live: a key changed in the Keybinds settings page while
        // proximity voice is already connected.
        this.keybinds.rebind$.subscribe(id => {
            const isOurs = id === PTT_ACTION.id || id === TOGGLE_MUTE_ACTION.id || id === PUSH_TO_MUTE_ACTION.id;
            if (isOurs && this.isVoiceActive()) {
                void this.registerPtt();
            }
        });

        // Keep the live spatial graph in sync with settings while connected.
        // Output-device changes apply instantly via AudioContext.setSinkId -no
        // reconnect, no dropped peers.
        effect(() => {
            const s = this.audioSettings.settings();
            if (this.isVoiceActive()) {
                this.spatial.setMasterVolume(s.proximityVolume);
                this.spatial.setSpatialEnabled(s.proximitySpatialEnabled);
                void this.spatial.setOutputDevice(s.speakerId);
                this.rtc.setMicGain(s.proximityMicGain);
            }
        });

        // Hub lifecycle resilience while connected.
        effect(() => {
            const state = this.realtime.connectionState();
            const prev = this.lastConnState;
            this.lastConnState = state;
            if (!this.isVoiceActive()) return;
            if (state === ConnectionState.Connected && prev !== ConnectionState.Connected) {
                // Reconnected -backend may have forgotten state, so re-publish.
                void this.republish();
            } else if (state !== ConnectionState.Connected && prev === ConnectionState.Connected) {
                // Dropped -no isle.PeerLeft can arrive while offline, so clear stale peers.
                this.rtc.tearDownAllRemotePeers();
            }
        });
    }

    // ── Public actions ────────────────────────────────────────────────────────

    async join(): Promise<void> {
        if (this.isConnecting() || this.isVoiceActive()) return;

        // Positional capture registers this account's position against a voice track, which is a
        // good deal more than "is in a voice call". Declining it (T2-19) does not stop the user
        // speaking in ordinary voice channels - it stops them being registered for the positional
        // path at all, so there is nothing to opt out of downstream.
        if (!this.privacy.allowPositionalVoiceCapture()) {
            this.toast.error('Positional voice capture is turned off in your privacy settings');
            return;
        }

        this.isConnecting.set(true);
        try {
            try {
                await firstValueFrom(this.api.join());
            } catch (err) {
                if (err instanceof HttpErrorResponse && err.status === 400) {
                    this.toast.error('Link your Steam account to use proximity chat');
                } else {
                    this.toast.httpError('Could not join Isle proximity chat', err);
                }
                return;
            }

            const published = await this.rtc.connect();
            if (!published) {
                this.toast.error('Microphone unavailable -check your audio settings');
                await firstValueFrom(this.api.leave()).catch(() => void 0);
                return;
            }

            const settings = this.audioSettings.settings();
            this.spatial.setMasterVolume(settings.proximityVolume);
            this.spatial.setSpatialEnabled(settings.proximitySpatialEnabled);
            void this.spatial.setOutputDevice(settings.speakerId);
            await this.registerPtt();

            this.isVoiceActive.set(true);
            this.connectedSince.set(Date.now());
            this.syncMic();
        } finally {
            this.isConnecting.set(false);
        }
    }

    /**
     * Tear down the proximity-voice session.
     *
     * @param playLeaveSound emit the voice-leave cue -used when the game
     *   disconnects out from under us so the drop is audible, rather than a
     *   deliberate user-initiated leave (which is silent).
     */
    async leave(playLeaveSound = false): Promise<void> {
        if (!this.isVoiceActive() && !this.isConnecting()) return;
        if (playLeaveSound) this.sounds.playVoiceLeave();
        await this.unregisterPtt();
        await this.rtc.disconnect();
        await firstValueFrom(this.api.leave()).catch(() => void 0);
        this.isVoiceActive.set(false);
        this.connectedSince.set(null);
        this.syncMic();
    }

    /**
     * Flip the mute toggle -the bar's mic button, and the hotkey itself in
     * toggle mode. Mute is deliberate, so it survives leaving and rejoining.
     */
    toggleMute(): void {
        this.setMuted(!this.isMuted());
    }

    setMuted(muted: boolean): void {
        this.isMuted.set(muted);
        this.syncMic();
    }

    /** Live-apply the master volume slider (also persists via settings). */
    setVolume(volume: number): void {
        this.audioSettings.update({proximityVolume: volume});
        this.spatial.setMasterVolume(volume);
    }

    /** Live-apply the outgoing mic gain (1 = 100%, >1 boosts; also persists). */
    setMicGain(gain: number): void {
        this.audioSettings.update({proximityMicGain: gain});
        this.rtc.setMicGain(gain);
    }

    /** Toggle HRTF panning vs distance-only (also persists via settings). */
    setSpatialEnabled(enabled: boolean): void {
        this.audioSettings.update({proximitySpatialEnabled: enabled});
        this.spatial.setSpatialEnabled(enabled);
    }

    // ── Detection ──────────────────────────────────────────────────────────────

    private startDetection(): void {
        this.detectionStarted = true;
        void this.ws.start();

        this.ws.playerJoined$.subscribe(() => this.isGameConnected.set(true));
        this.ws.playerDisconnected$.subscribe(() => {
            this.isGameConnected.set(false);
            if (this.isVoiceActive()) void this.leave(true);
        });

        this.ws.subscribeMutual$.subscribe(p => {
            if (this.isVoiceActive()) void this.rtc.subscribeToPeer(p.targetUserId, p.cfSessionId, p.trackName);
        });
        this.ws.selfPosition$.subscribe(p =>
            this.spatial.updateSelf(p.x, p.y, p.z, p.yaw, p.vx ?? 0, p.vy ?? 0, p.vz ?? 0));
        this.ws.playerPosition$.subscribe(p =>
            this.spatial.updatePeer(p.userId, p.x, p.y, p.z, p.vx ?? 0, p.vy ?? 0, p.vz ?? 0));
        this.ws.peerLeft$.subscribe(p => this.rtc.tearDownPeer(p.userId));

        // Isle restarted and forgot our published track. The hub socket never
        // dropped, so the reconnect path below cannot cover this -re-publish now,
        // otherwise we stay audible to nobody while still hearing everyone.
        this.ws.republishVoice$.subscribe(() => {
            if (this.isVoiceActive()) void this.republish();
        });

        // Check a few times on start, then reconcile on a slow poll.
        this.refreshStatus();
        setTimeout(() => this.refreshStatus(), 1_500);
        setTimeout(() => this.refreshStatus(), 4_000);
        this.pollHandle = setInterval(() => this.refreshStatus(), STATUS_POLL_MS);
    }

    private refreshStatus(): void {
        if (!this.userService.self()) return;
        firstValueFrom(this.api.getStatus())
            .then(status => {
                this.isGameConnected.set(status.isGameConnected);
                if (!status.isGameConnected && this.isVoiceActive()) void this.leave(true);
            })
            .catch(() => void 0);
    }

    // ── Hotkeys (push-to-talk, toggle-mute, push-to-mute - independent) ─────────

    private async registerPtt(): Promise<void> {
        this.pttBound = await this.armAction(PTT_ACTION.id, PTT_ACTION.nativeSlot!, down => {
            this.pttHeld = down;
            this.syncMic();
        });
        await this.armAction(TOGGLE_MUTE_ACTION.id, TOGGLE_MUTE_ACTION.nativeSlot!, down => {
            if (down) this.toggleMute();
        });
        await this.armAction(PUSH_TO_MUTE_ACTION.id, PUSH_TO_MUTE_ACTION.nativeSlot!, down => {
            this.pushMuteHeld = down;
            this.syncMic();
        });
        this.syncMic();
    }

    private async unregisterPtt(): Promise<void> {
        if (this.nativePtt.supported()) {
            await this.nativePtt.disarm(PTT_ACTION.nativeSlot!).catch(() => void 0);
            await this.nativePtt.disarm(TOGGLE_MUTE_ACTION.nativeSlot!).catch(() => void 0);
            await this.nativePtt.disarm(PUSH_TO_MUTE_ACTION.nativeSlot!).catch(() => void 0);
        }
        await this.hotkey.unbind(PTT_ACTION.id);
        await this.hotkey.unbind(TOGGLE_MUTE_ACTION.id);
        await this.hotkey.unbind(PUSH_TO_MUTE_ACTION.id);
        this.pttBound = false;
        this.pttHeld = false;
        this.pushMuteHeld = false;
    }

    /**
     * Arm one action's current binding, native hook first (bare modifiers +
     * mouse buttons, and keeps working while a game has focus), falling back to
     * the OS global-shortcut plugin (keyboard only). Returns whether *some*
     * mechanism ended up armed - callers use this to know whether the action is
     * meaningfully "bound" at all.
     */
    private async armAction(id: KeybindActionId, slot: number, onEdge: (down: boolean) => void): Promise<boolean> {
        const token = this.keybinds.getBinding(id);
        if (!token) return false;

        await this.nativePtt.whenReady();
        if (this.nativePtt.supported()) {
            if (!this.wiredSlots.has(slot)) {
                this.wiredSlots.add(slot);
                this.nativePtt.edgesFor(slot).subscribe(onEdge);
            }
            try {
                await this.nativePtt.setBinding(slot, token);
                await this.nativePtt.arm(slot);
                return true;
            } catch (e) {
                console.error(`[isle-voice] native arm failed for ${id}, falling back`, e);
            }
        }

        // Fallback: global-shortcut plugin (macOS/Linux) -keyboard accelerators only.
        if (this.hotkey.supported) {
            await this.hotkey.bind(id, token, {
                onDown: () => onEdge(true),
                onUp: () => onEdge(false),
            });
            return true;
        }

        return false; // no hotkey mechanism (e.g. browser dev)
    }

    /**
     * Recompute the outgoing mic gate. Called synchronously from every input that
     * can change it -a signal effect would defer this past the hotkey edge, and
     * the events arrive from outside Angular's zone.
     */
    private syncMic(): void {
        const open = this.isVoiceActive()
            && !this.isMuted()
            && !this.pushMuteHeld
            && (!this.pttBound || this.pttHeld);
        this.rtc.setMicEnabled(open);
        this.isTransmitting.set(open);
    }

    // ── Resilience ─────────────────────────────────────────────────────────────

    /**
     * Re-run the full publish flow (join → cf session → local "audio" track).
     *
     * Triggered by a hub reconnect or an `isle.RepublishVoice` nudge; both can
     * fire close together (or repeatedly) for one server restart, so the guard
     * keeps concurrent runs from tearing down each other's fresh session.
     */
    private async republish(): Promise<void> {
        if (this.republishing) return;
        this.republishing = true;
        try {
            await this.rtc.disconnect();
            await firstValueFrom(this.api.join()).catch(() => void 0);
            const ok = await this.rtc.connect();
            if (ok) {
                const settings = this.audioSettings.settings();
                this.spatial.setMasterVolume(settings.proximityVolume);
                this.spatial.setSpatialEnabled(settings.proximitySpatialEnabled);
                void this.spatial.setOutputDevice(settings.speakerId);
                await this.registerPtt();
            } else {
                await this.leave();
            }
        } catch {
            await this.leave();
        } finally {
            this.republishing = false;
        }
    }
}
