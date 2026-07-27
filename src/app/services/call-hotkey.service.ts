import {computed, effect, inject, Injectable} from '@angular/core';
import {CallSessionService} from './call-session.service';
import {VoiceChannelService} from './voice-channel.service';
import {KeybindsService} from './keybinds.service';
import {HotkeyService} from './hotkey.service';
import {findKeybindAction, KeybindActionId} from '../models/keybind-action.model';

const PTT_ACTION = findKeybindAction('call-ptt');
const TOGGLE_MUTE_ACTION = findKeybindAction('call-toggle-mute');
const PUSH_TO_MUTE_ACTION = findKeybindAction('call-push-to-mute');

/**
 * Wires the "Voice Calls" push-to-talk / toggle-mute / push-to-mute keybinds
 * into whichever call is actually live. A 1:1 call ({@link CallSessionService})
 * and a guild voice channel ({@link VoiceChannelService}) share the same three
 * keys and are gated together if both happen to be active at once.
 *
 * Unlike Isle proximity, these use the plain OS keyboard accelerator mechanism
 * (see `keybind-action.model.ts`) - a call only ever happens while Alpine
 * itself is in use, so there's no need for the native mouse/bare-modifier hook.
 *
 * Instantiated eagerly from AppComponent, same as CallWebRtcService.
 */
@Injectable({providedIn: 'root'})
export class CallHotkeyService {
    private callSession = inject(CallSessionService);
    private voiceChannel = inject(VoiceChannelService);
    private keybinds = inject(KeybindsService);
    private hotkey = inject(HotkeyService);

    private readonly active = computed(() =>
        this.callSession.session() !== null || this.voiceChannel.isInVoice());
    private armed = false;

    /** Push-to-talk is bound to something; without it the mic stays open. */
    private pttBound = false;
    /** Push-to-talk key physically held right now. */
    private pttHeld = false;
    /** Push-to-mute key physically held right now - forces the mic closed while true. */
    private pushMuteHeld = false;

    constructor() {
        effect(() => {
            if (this.active()) {
                if (!this.armed) void this.arm();
            } else if (this.armed) {
                void this.disarm();
            }
        });

        // Rebind live: a key changed in the Keybinds settings page mid-call.
        this.keybinds.rebind$.subscribe(id => {
            const isOurs = id === PTT_ACTION.id || id === TOGGLE_MUTE_ACTION.id || id === PUSH_TO_MUTE_ACTION.id;
            if (isOurs && this.active()) {
                void this.arm();
            }
        });
    }

    private async arm(): Promise<void> {
        this.armed = true;

        const pttToken = this.keybinds.getBinding(PTT_ACTION.id);
        this.pttBound = !!pttToken;
        await this.bindAction(PTT_ACTION.id, pttToken, down => {
            this.pttHeld = down;
            this.updateGate();
        });

        await this.bindAction(TOGGLE_MUTE_ACTION.id, this.keybinds.getBinding(TOGGLE_MUTE_ACTION.id), down => {
            if (down) this.toggleMute();
        });

        await this.bindAction(PUSH_TO_MUTE_ACTION.id, this.keybinds.getBinding(PUSH_TO_MUTE_ACTION.id), down => {
            this.pushMuteHeld = down;
            this.updateGate();
        });

        this.updateGate();
    }

    private async disarm(): Promise<void> {
        this.armed = false;
        await this.hotkey.unbind(PTT_ACTION.id);
        await this.hotkey.unbind(TOGGLE_MUTE_ACTION.id);
        await this.hotkey.unbind(PUSH_TO_MUTE_ACTION.id);
        this.pttBound = false;
        this.pttHeld = false;
        this.pushMuteHeld = false;
        this.updateGate();
    }

    private async bindAction(
        id: KeybindActionId,
        token: string | null,
        onEdge: (down: boolean) => void,
    ): Promise<void> {
        if (!token) {
            await this.hotkey.unbind(id);
            return;
        }
        await this.hotkey.bind(id, token, {
            onDown: () => onEdge(true),
            onUp: () => onEdge(false),
        });
    }

    /** Recompute and apply the combined gate: push-to-mute always wins, push-to-talk otherwise. */
    private updateGate(): void {
        const open = !this.pushMuteHeld && (!this.pttBound || this.pttHeld);
        if (this.callSession.session()) this.callSession.setPttGateOpen(open);
        if (this.voiceChannel.isInVoice()) this.voiceChannel.setPttGateOpen(open);
    }

    private toggleMute(): void {
        if (this.callSession.session()) this.callSession.toggleMute();
        if (this.voiceChannel.isInVoice()) this.voiceChannel.toggleMute();
    }
}
