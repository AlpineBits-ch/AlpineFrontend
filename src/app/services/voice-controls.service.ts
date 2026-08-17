import {computed, inject, Injectable} from '@angular/core';
import {VoiceChannelService} from './voice-channel.service';
import {CallSessionService} from './call-session.service';

/**
 * Mute and deafen for whichever call is actually live.
 *
 * Both surfaces must be gated together: wired to only one, the button lights up while the
 * microphone stays open. Mirrors {@link CallHotkeyService}; changes here belong there too.
 */
@Injectable({providedIn: 'root'})
export class VoiceControlsService {
    private voiceChannel = inject(VoiceChannelService);
    private callSession = inject(CallSessionService);

    /** The state the button should show: the call wins when both are live, otherwise the channel's sticky state. */
    readonly isMuted = computed(
        () => this.callSession.session()?.local.isMuted ?? this.voiceChannel.localState().isMuted,
    );

    readonly isDeafened = computed(
        () => this.callSession.session()?.local.isDeafened ?? this.voiceChannel.localState().isDeafened,
    );

    /** Toggles every live surface, and the channel's sticky state when none is live. */
    toggleMute(): void {
        const inCall = this.callSession.session() !== null;
        if (inCall) this.callSession.toggleMute();
        if (this.voiceChannel.isInVoice() || !inCall) this.voiceChannel.toggleMute();
    }

    toggleDeafen(): void {
        const inCall = this.callSession.session() !== null;
        if (inCall) this.callSession.toggleDeafen();
        if (this.voiceChannel.isInVoice() || !inCall) this.voiceChannel.toggleDeafen();
    }
}
