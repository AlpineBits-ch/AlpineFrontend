import {computed, inject, Injectable} from '@angular/core';
import {VoiceChannelService} from './voice-channel.service';
import {CallSessionService} from './call-session.service';

/**
 * Mute and deafen for whichever call is actually live.
 *
 * <p>There are two independent call surfaces - a guild voice channel
 * ({@link VoiceChannelService}) and a 1:1/group call ({@link CallSessionService}) - each holding its
 * own local state, and the bottom bar has one microphone button for both. Wired to only one of them,
 * that button silently did nothing during a call on the other: it lit up, the state it flipped
 * belonged to a channel nobody was in, and the microphone stayed open.</p>
 *
 * <p>Mirrors {@link CallHotkeyService}, which gates both surfaces together for exactly the same
 * reason. Anything that changes here should change there.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceControlsService {
    private voiceChannel = inject(VoiceChannelService);
    private callSession = inject(CallSessionService);

    /**
     * The state the button should show.
     *
     * <p>The call wins when both are somehow live: it is the surface the user is looking at, and
     * the toggle below moves both anyway. Outside any call this falls through to the channel's
     * state, which is where mute persists between sessions - arriving in a channel already muted is
     * a setting, not an accident.</p>
     */
    readonly isMuted = computed(() =>
        this.callSession.session()?.local.isMuted ?? this.voiceChannel.localState().isMuted);

    readonly isDeafened = computed(() =>
        this.callSession.session()?.local.isDeafened ?? this.voiceChannel.localState().isDeafened);

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
