import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {VoiceControlsService} from './voice-controls.service';
import {VoiceChannelService} from './voice-channel.service';
import {CallSessionService} from './call-session.service';

interface SetupOptions {
    /** Whether a guild voice channel is joined. */
    inChannel?: boolean;
    /** Whether a 1:1/group call is live. */
    inCall?: boolean;
    channelMuted?: boolean;
    channelDeafened?: boolean;
    callMuted?: boolean;
    callDeafened?: boolean;
}

function setup(options: SetupOptions = {}) {
    const channelState = signal({
        isMuted: options.channelMuted ?? false,
        isDeafened: options.channelDeafened ?? false,
        isCameraOn: false,
        isScreenSharing: false,
    });
    const voiceChannel = {
        localState: channelState,
        isInVoice: () => options.inChannel ?? false,
        toggleMute: vi.fn(),
        toggleDeafen: vi.fn(),
    };

    const session = signal(options.inCall
        ? {callId: 'call-1', local: {isMuted: options.callMuted ?? false, isDeafened: options.callDeafened ?? false}}
        : null);
    const callSession = {
        session,
        toggleMute: vi.fn(),
        toggleDeafen: vi.fn(),
    };

    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceChannelService, useValue: voiceChannel},
            {provide: CallSessionService, useValue: callSession},
        ],
    });

    return {service: TestBed.inject(VoiceControlsService), voiceChannel, callSession};
}

describe('VoiceControlsService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('mutes the call when one is live', () => {
        // The bug this exists for: the bottom bar was wired to the guild channel alone, so during a
        // DM call the button lit up, flipped state on a channel nobody was in, and left the
        // microphone open.
        const {service, callSession} = setup({inCall: true});

        service.toggleMute();

        expect(callSession.toggleMute).toHaveBeenCalled();
    });

    it('mutes the channel when that is what is live', () => {
        const {service, voiceChannel, callSession} = setup({inChannel: true});

        service.toggleMute();

        expect(voiceChannel.toggleMute).toHaveBeenCalled();
        expect(callSession.toggleMute).not.toHaveBeenCalled();
    });

    it('mutes both when both are somehow live', () => {
        // Matches CallHotkeyService, which gates both surfaces together - one button leaving one of
        // them transmitting would be worse than either behaviour.
        const {service, voiceChannel, callSession} = setup({inChannel: true, inCall: true});

        service.toggleMute();

        expect(callSession.toggleMute).toHaveBeenCalled();
        expect(voiceChannel.toggleMute).toHaveBeenCalled();
    });

    it('still toggles the sticky channel state outside any call', () => {
        // Mute is a statement about this machine's microphone, and arriving in a channel already
        // muted is a setting rather than an accident.
        const {service, voiceChannel} = setup();

        service.toggleMute();

        expect(voiceChannel.toggleMute).toHaveBeenCalled();
    });

    it('shows the call state while a call is live', () => {
        const {service} = setup({inCall: true, callMuted: true, channelMuted: false});

        expect(service.isMuted()).toBe(true);
    });

    it('falls back to the channel state with no call', () => {
        const {service} = setup({channelMuted: true});

        expect(service.isMuted()).toBe(true);
    });

    it('routes deafen the same way', () => {
        const {service, callSession} = setup({inCall: true});

        service.toggleDeafen();

        expect(callSession.toggleDeafen).toHaveBeenCalled();
    });

    it('shows the call deafen state while a call is live', () => {
        const {service} = setup({inCall: true, callDeafened: true});

        expect(service.isDeafened()).toBe(true);
    });
});
