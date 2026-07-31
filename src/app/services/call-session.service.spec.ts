/**
 * Hanging up must remove only the local user. Ending the call for everyone is what made a
 * decline on one device kill an active call on another.
 */
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {OAuthService} from 'angular-oauth2-oidc';
import {CallSessionService} from './call-session.service';
import {VoiceService} from './voice.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';

const voiceService = {
    leaveCall: vi.fn(() => of({})),
    endCall: vi.fn(() => of({})),
};

function setup() {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceService, useValue: voiceService},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {
                provide: ProfileService,
                useValue: {ownProfile: () => ({userId: 'me'}), getCachedByUserId: () => null},
            },
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-abc'}},
            {provide: AudioSettingsService, useValue: {settings: () => ({})}},
            {provide: RustMediaService, useValue: {}},
            {provide: ScreenPickerService, useValue: {}},
        ],
    });

    const service = TestBed.inject(CallSessionService);
    service.session.set({
        callId: 'call-1',
        conversationId: 'conv-1',
        participants: [],
        screenShares: [],
        local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
        startedAt: new Date(),
    } as never);
    return service;
}

it('leaves the call rather than ending it for everyone', () => {
    const service = setup();

    service.end();

    expect(voiceService.leaveCall).toHaveBeenCalledWith('call-1');
    expect(voiceService.endCall).not.toHaveBeenCalled();
    expect(service.session()).toBeNull();
});

it('skips the network call when the server already tore the call down', () => {
    const service = setup();

    service.end(true);

    expect(voiceService.leaveCall).not.toHaveBeenCalled();
    expect(service.session()).toBeNull();
});

it('clears the alone deadline on end', () => {
    const service = setup();
    service.setAloneDeadline(new Date());

    service.end(true);

    expect(service.aloneDeadline()).toBeNull();
});

it('clears the alone deadline once someone rejoins', () => {
    const service = setup();
    service.onParticipantJoined('them');
    service.setAloneDeadline(new Date());

    service.onParticipantJoined('someone-else');

    expect(service.aloneDeadline()).toBeNull();
});

it('keeps the alone deadline while still the only participant', () => {
    const service = setup();
    const deadline = new Date();
    service.onParticipantJoined('me');
    service.setAloneDeadline(deadline);

    // A repeat of a participant already present is ignored, so the count does not grow.
    service.onParticipantJoined('me');

    expect(service.aloneDeadline()).toBe(deadline);
});
