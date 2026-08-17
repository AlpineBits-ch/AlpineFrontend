import {computed, effect, inject, Injectable} from '@angular/core';
import {CallSessionService} from './call-session.service';
import {VoiceChannelService} from './voice-channel.service';
import {KeybindsService} from './keybinds.service';
import {HotkeyService} from './hotkey.service';
import {NativePttService} from './native-ptt.service';
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
 * These use the native Windows low-level hook (slots 3-5, see `ptt_hook.rs`),
 * same mechanism as Isle proximity - NOT the OS global-shortcut plugin.
 * `RegisterHotKey`-backed accelerators swallow the bound key system-wide
 * (including inside Alpine's own text inputs) for as long as they're
 * registered, which broke typing a bare-letter PTT key (e.g. `T`) anywhere
 * while in a call. The native hook only observes keystrokes and never
 * swallows them, so it has no such side effect.
 *
 * Instantiated eagerly from AppComponent, same as CallWebRtcService.
 */
@Injectable({providedIn: 'root'})
export class CallHotkeyService {
    private callSession = inject(CallSessionService);
    private voiceChannel = inject(VoiceChannelService);
    private keybinds = inject(KeybindsService);
    private hotkey = inject(HotkeyService);
    private nativePtt = inject(NativePttService);

    private readonly active = computed(
        () => this.callSession.session() !== null || this.voiceChannel.isInVoice(),
    );
    private armed = false;

    /** Which native hook slots already have a live edge subscription. */
    private readonly wiredSlots = new Set<number>();
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
            const isOurs =
                id === PTT_ACTION.id || id === TOGGLE_MUTE_ACTION.id || id === PUSH_TO_MUTE_ACTION.id;
            if (isOurs && this.active()) {
                void this.arm();
            }
        });
    }

    private async arm(): Promise<void> {
        this.armed = true;

        this.pttBound = await this.armAction(PTT_ACTION.id, PTT_ACTION.nativeSlot!, down => {
            this.pttHeld = down;
            this.updateGate();
        });

        await this.armAction(TOGGLE_MUTE_ACTION.id, TOGGLE_MUTE_ACTION.nativeSlot!, down => {
            if (down) this.toggleMute();
        });

        await this.armAction(PUSH_TO_MUTE_ACTION.id, PUSH_TO_MUTE_ACTION.nativeSlot!, down => {
            this.pushMuteHeld = down;
            this.updateGate();
        });

        this.updateGate();
    }

    private async disarm(): Promise<void> {
        this.armed = false;
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
        this.updateGate();
    }

    /**
     * Arm one action's current binding, native hook first (matches Isle
     * proximity's `armAction`), falling back to the OS global-shortcut plugin
     * only where the native hook isn't available (macOS/Linux). Returns
     * whether *some* mechanism ended up armed.
     */
    private async armAction(
        id: KeybindActionId,
        slot: number,
        onEdge: (down: boolean) => void,
    ): Promise<boolean> {
        const token = this.keybinds.getBinding(id);
        if (!token) {
            await this.hotkey.unbind(id);
            if (this.nativePtt.supported()) await this.nativePtt.disarm(slot).catch(() => void 0);
            return false;
        }

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
                console.error(`[call-hotkey] native arm failed for ${id}, falling back`, e);
            }
        }

        // Fallback: global-shortcut plugin (macOS/Linux) - keyboard accelerators only.
        if (this.hotkey.supported) {
            await this.hotkey.bind(id, token, {
                onDown: () => onEdge(true),
                onUp: () => onEdge(false),
            });
            return true;
        }

        return false; // no hotkey mechanism (e.g. browser dev)
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
