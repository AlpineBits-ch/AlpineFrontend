import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {VoiceStatusBarComponent} from './voice-status-bar.component';
import {VoiceChannelService, VoiceLocalState} from '../../../../services/voice-channel.service';
import {CallSessionService} from '../../../../services/call-session.service';
import {CallWebRtcService} from '../../../../services/call-webrtc.service';
import {RustMediaService} from '../../../../services/rust-media.service';
import {ConversationStore} from '../../../../stores/conversation.store';
import {NavigationService, WorkspaceContext} from '../../navigation.service';
import {CallMiniPlayerService} from '../../../../services/call-mini-player.service';
import {ActiveCallSession, CallParticipantUi} from '../../../../services/call-session.types';
import {ConversationDto} from '../../../../dtos/response/conversation.dto';

function participant(userId: string, displayName: string, isLocal: boolean): CallParticipantUi {
    return {
        userId,
        displayName,
        avatarLabel: displayName[0]?.toUpperCase() ?? '?',
        avatarUrl: undefined,
        isLocal,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        videoStream: undefined,
    };
}

function dmSession(overrides: Partial<ActiveCallSession> = {}): ActiveCallSession {
    return {
        callId: 'call-1',
        conversationId: 'conv-1',
        participants: [participant('me', 'You', true), participant('them', 'Bob Testuser', false)],
        screenShares: [],
        local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
        startedAt: new Date(),
        ...overrides,
    };
}

interface Fakes {
    isInVoice: WritableSignal<boolean>;
    localState: WritableSignal<VoiceLocalState>;
    voiceRtcState: WritableSignal<string>;
    joinedChannelName: WritableSignal<string | null>;
    joinedGuildName: WritableSignal<string | null>;
    joinedChannelId: WritableSignal<string | null>;
    leaveChannel: ReturnType<typeof vi.fn>;
    guildToggleScreenShare: ReturnType<typeof vi.fn>;
    session: WritableSignal<ActiveCallSession | null>;
    dmRtcState: WritableSignal<string>;
    end: ReturnType<typeof vi.fn>;
    dmToggleScreenShare: ReturnType<typeof vi.fn>;
    publishPreview: WritableSignal<string | null>;
    previewPaused: WritableSignal<boolean>;
    claimPreviewRender: ReturnType<typeof vi.fn>;
    releasePreviewRender: ReturnType<typeof vi.fn>;
    resumePreview: ReturnType<typeof vi.fn>;
    workspace: WritableSignal<WorkspaceContext>;
    openChannel: ReturnType<typeof vi.fn>;
    openConversation: ReturnType<typeof vi.fn>;
    entities: WritableSignal<ConversationDto[]>;
}

function setup(): {fixture: ComponentFixture<VoiceStatusBarComponent>; component: VoiceStatusBarComponent; fakes: Fakes} {
    const fakes: Fakes = {
        isInVoice: signal(false),
        localState: signal<VoiceLocalState>({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false}),
        voiceRtcState: signal('connected'),
        joinedChannelName: signal<string | null>(null),
        joinedGuildName: signal<string | null>(null),
        joinedChannelId: signal<string | null>(null),
        leaveChannel: vi.fn().mockResolvedValue(undefined),
        guildToggleScreenShare: vi.fn().mockResolvedValue(undefined),
        session: signal<ActiveCallSession | null>(null),
        dmRtcState: signal('connected'),
        end: vi.fn(),
        dmToggleScreenShare: vi.fn().mockResolvedValue(undefined),
        publishPreview: signal<string | null>(null),
        previewPaused: signal(false),
        claimPreviewRender: vi.fn(),
        releasePreviewRender: vi.fn(),
        resumePreview: vi.fn(),
        workspace: signal<WorkspaceContext>({type: 'dms'}),
        openChannel: vi.fn(),
        openConversation: vi.fn(),
        entities: signal<ConversationDto[]>([]),
    };

    TestBed.configureTestingModule({
        imports: [VoiceStatusBarComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {
                provide: VoiceChannelService,
                useValue: {
                    isInVoice: fakes.isInVoice,
                    localState: fakes.localState,
                    rtcState: fakes.voiceRtcState,
                    joinedChannelName: fakes.joinedChannelName,
                    joinedGuildName: fakes.joinedGuildName,
                    joinedChannelId: fakes.joinedChannelId,
                    leaveChannel: fakes.leaveChannel,
                    toggleScreenShare: fakes.guildToggleScreenShare,
                },
            },
            {
                provide: CallSessionService,
                useValue: {
                    session: fakes.session,
                    end: fakes.end,
                    toggleScreenShare: fakes.dmToggleScreenShare,
                },
            },
            {provide: CallWebRtcService, useValue: {rtcState: fakes.dmRtcState}},
            {
                provide: RustMediaService,
                useValue: {
                    publishPreview: fakes.publishPreview,
                    previewPaused: fakes.previewPaused,
                    claimPreviewRender: fakes.claimPreviewRender,
                    releasePreviewRender: fakes.releasePreviewRender,
                    resumePreview: fakes.resumePreview,
                },
            },
            {
                provide: ConversationStore,
                useValue: {entities: fakes.entities},
            },
            {
                provide: NavigationService,
                useValue: {
                    workspace: fakes.workspace,
                    openChannel: fakes.openChannel,
                    openConversation: fakes.openConversation,
                },
            },
        ],
    });

    const fixture: ComponentFixture<VoiceStatusBarComponent> = TestBed.createComponent(VoiceStatusBarComponent);
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, fakes};
}

describe('VoiceStatusBarComponent visibility', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders nothing on neither surface', () => {
        const {fixture} = setup();
        expect(fixture.nativeElement.querySelector('div')).toBeNull();
    });

    it('renders for guild voice', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('div')).not.toBeNull();
    });

    it('renders for a DM call with no guild voice session', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('div')).not.toBeNull();
    });

    it('prefers guild voice when somehow both are present', () => {
        const {component, fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.session.set(dmSession());
        fixture.detectChanges();

        expect(component['isGuildVoice']()).toBe(true);
        expect(component['isDmCall']()).toBe(false);
    });
});

describe('VoiceStatusBarComponent ordinary state', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('shows the channel and guild name for guild voice, and no live row', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.joinedChannelName.set('general');
        fakes.joinedGuildName.set('Alpine HQ');
        fixture.detectChanges();

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('general');
        expect(text).toContain('Alpine HQ');
        expect(fixture.nativeElement.querySelector('app-call-live-badge')).toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).toBeNull();
    });

    it('shows the peer name for a DM call, and no live row', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('Bob Testuser');
        expect(fixture.nativeElement.querySelector('app-call-live-badge')).toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).toBeNull();
    });

    it('disconnects guild voice through leaveChannel', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="VOICE_BAR.DISCONNECT"]') as HTMLButtonElement).click();

        expect(fakes.leaveChannel).toHaveBeenCalledTimes(1);
        expect(fakes.end).not.toHaveBeenCalled();
    });

    it('ends a DM call through CallSessionService.end, not leaveChannel', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.DISCONNECT"]') as HTMLButtonElement).click();

        expect(fakes.end).toHaveBeenCalledTimes(1);
        expect(fakes.leaveChannel).not.toHaveBeenCalled();
    });

    it('labels the disconnect button with the channel-specific key for guild voice', () => {
        // VOICE_BAR.DISCONNECT reads "Disconnect from voice channel" in German and French - correct
        // for guild voice, which has a channel to name.
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="VOICE_BAR.DISCONNECT"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.DISCONNECT"]')).toBeNull();
    });

    it('labels the disconnect button with the locale-neutral key for a DM call', () => {
        // A DM call has no channel, so the channel-specific VOICE_BAR.DISCONNECT wording is not just
        // guild-flavoured but factually wrong in German ("Vom Sprachkanal trennen") and French
        // ("Se déconnecter du canal vocal") - CALL.DISCONNECT is the neutral "Disconnect" instead.
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.DISCONNECT"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="VOICE_BAR.DISCONNECT"]')).toBeNull();
    });
});

describe('VoiceStatusBarComponent mini player restore', () => {
    // The floating call tile's own close button cannot bring it back, so the way back lives here -
    // this bar is already the one thing on screen for the whole length of a call, wherever the user
    // has navigated to. See CallMiniPlayerService.
    beforeEach(() => TestBed.resetTestingModule());

    it('offers nothing while the tile is where it should be', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHOW_MINI_PLAYER"]')).toBeNull();
    });

    it('offers the tile back once it has been dismissed', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        TestBed.inject(CallMiniPlayerService).dismiss('channel:chan-1');
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHOW_MINI_PLAYER"]')).not.toBeNull();
    });

    it('restores the tile and stops offering to', () => {
        const {fixture, fakes} = setup();
        const miniPlayer = TestBed.inject(CallMiniPlayerService);
        fakes.isInVoice.set(true);
        miniPlayer.dismiss('channel:chan-1');
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.SHOW_MINI_PLAYER"]') as HTMLButtonElement).click();
        fixture.detectChanges();

        expect(miniPlayer.isDismissed()).toBe(false);
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHOW_MINI_PLAYER"]')).toBeNull();
    });

    it('leaves the stop-sharing control alone', () => {
        // The restore sits beside the canonical stop-sharing button; it must not displace it.
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        TestBed.inject(CallMiniPlayerService).dismiss('channel:chan-1');
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHOW_MINI_PLAYER"]')).not.toBeNull();
    });
});

describe('VoiceStatusBarComponent live sharing state', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('shows the live badge and stop button while sharing on guild voice', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('app-call-live-badge')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).not.toBeNull();
    });

    it('stops a guild voice share through VoiceChannelService.toggleScreenShare, the controls-bar path', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]') as HTMLButtonElement).click();

        expect(fakes.guildToggleScreenShare).toHaveBeenCalledTimes(1);
        expect(fakes.dmToggleScreenShare).not.toHaveBeenCalled();
    });

    it('shows the live badge and stop button while sharing on a DM call', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession({local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: true}}));
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('app-call-live-badge')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).not.toBeNull();
    });

    it('stops a DM call share through CallSessionService.toggleScreenShare, not the guild path', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession({local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: true}}));
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]') as HTMLButtonElement).click();

        expect(fakes.dmToggleScreenShare).toHaveBeenCalledTimes(1);
        expect(fakes.guildToggleScreenShare).not.toHaveBeenCalled();
    });

    it('shows the start-sharing control instead of stop while not sharing on guild voice', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHARE_SCREEN"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).toBeNull();
    });

    it('starts a guild voice share through VoiceChannelService.toggleScreenShare, the controls-bar path', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.SHARE_SCREEN"]') as HTMLButtonElement).click();

        expect(fakes.guildToggleScreenShare).toHaveBeenCalledTimes(1);
        expect(fakes.dmToggleScreenShare).not.toHaveBeenCalled();
    });

    it('shows the start-sharing control instead of stop while not sharing on a DM call', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHARE_SCREEN"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).toBeNull();
    });

    it('starts a DM call share through CallSessionService.toggleScreenShare, not the guild path', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.SHARE_SCREEN"]') as HTMLButtonElement).click();

        expect(fakes.dmToggleScreenShare).toHaveBeenCalledTimes(1);
        expect(fakes.guildToggleScreenShare).not.toHaveBeenCalled();
    });

    it('hides the start-sharing control once sharing begins, on either surface', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[aria-label="CALL.SHARE_SCREEN"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[aria-label="CALL.STOP_SHARING"]')).not.toBeNull();
    });

    it('renders the preview thumbnail once RustMediaService has one', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fakes.publishPreview.set('data:image/jpeg;base64,abc');
        fixture.detectChanges();

        const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
        expect(img).not.toBeNull();
        expect(img.src).toContain('data:image/jpeg;base64,abc');
    });

    it('falls back to a desktop glyph before the first preview frame arrives', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('img')).toBeNull();
        expect(fixture.nativeElement.querySelector('.pi-desktop')).not.toBeNull();
    });
});

describe('VoiceStatusBarComponent preview claim', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('claims the preview render while the live row is actually showing a frame', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fakes.publishPreview.set('data:image/jpeg;base64,abc');
        fixture.detectChanges();

        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);
    });

    it('claims nothing before the first frame arrives', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fixture.detectChanges();

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
    });

    it('releases the claim once sharing stops', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fakes.publishPreview.set('data:image/jpeg;base64,abc');
        fixture.detectChanges();
        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);

        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});
        fixture.detectChanges();

        expect(fakes.releasePreviewRender).toHaveBeenCalledTimes(1);
    });
});

describe('VoiceStatusBarComponent paused preview card', () => {
    beforeEach(() => TestBed.resetTestingModule());

    function setSharing(fakes: Fakes): void {
        fakes.isInVoice.set(true);
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fakes.publishPreview.set('data:image/jpeg;base64,abc');
    }

    it('swaps the thumbnail and live badge for the paused card, keeping the still-running wording', () => {
        const {fixture, fakes} = setup();
        setSharing(fakes);
        fixture.detectChanges();

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('CALL.PREVIEW_PAUSED');
        expect(text).not.toContain('CALL.YOU_ARE_LIVE');
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
        expect(fixture.nativeElement.querySelector('app-call-live-badge')).toBeNull();
    });

    it('resumes on interacting with the paused thumbnail', () => {
        const {fixture, fakes} = setup();
        setSharing(fakes);
        fixture.detectChanges();
        fakes.previewPaused.set(true);
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('[aria-label="CALL.RESUME_PREVIEW"]') as HTMLButtonElement).click();

        expect(fakes.resumePreview).toHaveBeenCalledTimes(1);
    });

    it('never shows the paused card while not sharing, even if the flag is somehow true', () => {
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
    });
});
