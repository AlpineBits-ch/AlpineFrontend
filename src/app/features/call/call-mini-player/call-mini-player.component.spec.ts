/**
 * The app-level mini-player: the picture, kept while you go and read something else.
 *
 * <p>Three things are worth guarding here, and they are the three the feature is actually made of.
 * It has to be <b>hidden while the stage it duplicates is on screen</b> and shown when it is not -
 * a mini-player that renders beside the full call view is a bug, and one that never renders is the
 * whole feature missing. It has to <b>claim its watch</b>, asserted against what `ShareWatchService`
 * was told rather than against what rendered: the claim is a network fact, and a DOM-only test would
 * pass with `setWatching` deleted while the streamer's viewer count quietly drained. And dragging
 * has to <b>stay inside the viewport</b>, including when the window is the thing that moved.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CallMiniPlayerComponent} from './call-mini-player.component';
import {VoiceChannelParticipant, VoiceChannelService, VoiceLocalState} from '../../../services/voice-channel.service';
import {CallSessionService} from '../../../services/call-session.service';
import {CallWebRtcService} from '../../../services/call-webrtc.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {GuildService} from '../../../services/guild.service';
import {ConversationStore} from '../../../stores/conversation.store';
import {NavigationService, WorkspaceContext} from '../../main-page/navigation.service';
import {CallStagePresenceService} from '../../../services/call-stage-presence.service';
import {CallMiniPlayerService} from '../../../services/call-mini-player.service';
import {ShareWatchService, WatchScope} from '../../../services/share-watch.service';
import {ActiveCallSession, CallParticipantUi, ScreenShareUi} from '../../../services/call-session.types';
import {ConversationDto} from '../../../dtos/response/conversation.dto';
import {GuildDto} from '../../../dtos/response/guild.dto';

const CHANNEL_SCOPE: WatchScope = {kind: 'channel', guildId: 'guild-1', channelId: 'chan-1'};
const CALL_SCOPE: WatchScope = {kind: 'call', callId: 'call-1'};

function rosterEntry(overrides: Partial<VoiceChannelParticipant> = {}): VoiceChannelParticipant {
    return {
        userId: 'u2',
        displayName: 'Ada Lovelace',
        avatarLabel: 'A',
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        isScreenSharing: false,
        isServerDeafened: false,
        isLocal: false,
        ...overrides,
    };
}

function callParticipant(overrides: Partial<CallParticipantUi> = {}): CallParticipantUi {
    return {
        userId: 'u2',
        displayName: 'Ada Lovelace',
        avatarLabel: 'A',
        avatarUrl: undefined,
        isLocal: false,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        videoStream: undefined,
        ...overrides,
    };
}

function dmSession(shares: ScreenShareUi[] = []): ActiveCallSession {
    return {
        callId: 'call-1',
        conversationId: 'conv-1',
        participants: [callParticipant({userId: 'me', displayName: 'You', isLocal: true}), callParticipant()],
        screenShares: shares,
        local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
        startedAt: new Date(),
    };
}

interface Fakes {
    isInVoice: WritableSignal<boolean>;
    joinedChannelId: WritableSignal<string | null>;
    joinedGuildId: WritableSignal<string | null>;
    joinedChannelName: WritableSignal<string | null>;
    channelParticipants: WritableSignal<Map<string, VoiceChannelParticipant[]>>;
    localState: WritableSignal<VoiceLocalState>;
    session: WritableSignal<ActiveCallSession | null>;
    guildToggleMute: ReturnType<typeof vi.fn>;
    dmToggleMute: ReturnType<typeof vi.fn>;
    leaveChannel: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    openChannel: ReturnType<typeof vi.fn>;
    openConversation: ReturnType<typeof vi.fn>;
    /** Every `setWatching` the component made, in order - the point of the watch-claim suite. */
    watchCalls: Array<{scope: WatchScope; shareIds: readonly string[]}>;
    claimPreviewRender: ReturnType<typeof vi.fn>;
    releasePreviewRender: ReturnType<typeof vi.fn>;
}

interface Harness {
    fixture: ComponentFixture<CallMiniPlayerComponent>;
    fakes: Fakes;
    presence: CallStagePresenceService;
}

function setup(): Harness {
    const fakes: Fakes = {
        isInVoice: signal(false),
        joinedChannelId: signal<string | null>(null),
        joinedGuildId: signal<string | null>(null),
        joinedChannelName: signal<string | null>('General Voice'),
        channelParticipants: signal(new Map<string, VoiceChannelParticipant[]>()),
        localState: signal<VoiceLocalState>({
            isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false,
        }),
        session: signal<ActiveCallSession | null>(null),
        guildToggleMute: vi.fn(),
        dmToggleMute: vi.fn(),
        leaveChannel: vi.fn().mockResolvedValue(undefined),
        end: vi.fn(),
        openChannel: vi.fn(),
        openConversation: vi.fn(),
        watchCalls: [],
        claimPreviewRender: vi.fn(),
        releasePreviewRender: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [CallMiniPlayerComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {
                provide: VoiceChannelService,
                useValue: {
                    isInVoice: fakes.isInVoice,
                    joinedChannelId: fakes.joinedChannelId,
                    joinedGuildId: fakes.joinedGuildId,
                    joinedChannelName: fakes.joinedChannelName,
                    channelParticipants: fakes.channelParticipants,
                    localState: fakes.localState,
                    localVideoStream: signal(null),
                    localScreenStream: signal(null),
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                    inboundVideoFps: signal<Record<string, number>>({}),
                    getVideoStream: () => null,
                    getScreenStream: () => null,
                    isScreenAudioMuted: () => false,
                    toggleMute: fakes.guildToggleMute,
                    toggleDeafen: vi.fn(),
                    leaveChannel: fakes.leaveChannel,
                },
            },
            {
                provide: CallSessionService,
                useValue: {
                    session: fakes.session,
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                    toggleMute: fakes.dmToggleMute,
                    toggleDeafen: vi.fn(),
                    end: fakes.end,
                },
            },
            {
                provide: CallWebRtcService,
                useValue: {
                    isScreenAudioMuted: () => false,
                    inboundVideoFpsByShare: signal<Record<string, number>>({}),
                },
            },
            {
                provide: RustMediaService,
                useValue: {
                    publishPreview: signal(null),
                    renderedFps: signal(0),
                    inboundFps: signal(0),
                    previewPaused: signal(false),
                    claimPreviewRender: fakes.claimPreviewRender,
                    releasePreviewRender: fakes.releasePreviewRender,
                    resumePreview: vi.fn(),
                },
            },
            {provide: GuildService, useValue: {guilds: signal<readonly GuildDto[]>([])}},
            {provide: ConversationStore, useValue: {entities: signal<ConversationDto[]>([])}},
            {
                provide: NavigationService,
                useValue: {
                    workspace: signal<WorkspaceContext>({type: 'dms'}),
                    selectServer: vi.fn(),
                    openChannel: fakes.openChannel,
                    openConversation: fakes.openConversation,
                },
            },
            {
                // Stubbed rather than spied on the real thing, so the assertions are about what the
                // component *said* and never about the HTTP the real service would try to send.
                provide: ShareWatchService,
                useValue: {
                    setWatching: (scope: WatchScope, shareIds: readonly string[]) =>
                        fakes.watchCalls.push({scope, shareIds: [...shareIds]}),
                    viewerCount: () => 0,
                    viewersOf: () => [],
                    refresh: () => void 0,
                    clear: () => void 0,
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(CallMiniPlayerComponent);
    fixture.detectChanges();

    return {fixture, fakes, presence: TestBed.inject(CallStagePresenceService)};
}

/** Puts the harness in guild voice, optionally with somebody sharing. */
function joinGuildVoice(fakes: Fakes, sharing = false): void {
    fakes.isInVoice.set(true);
    fakes.joinedChannelId.set('chan-1');
    fakes.joinedGuildId.set('guild-1');
    fakes.channelParticipants.set(new Map([[
        'chan-1',
        [rosterEntry({isScreenSharing: sharing, mediaSessionId: sharing ? 'share-1' : null})],
    ]]));
}

function tile(fixture: ComponentFixture<CallMiniPlayerComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('section');
}

function closeButton(fixture: ComponentFixture<CallMiniPlayerComponent>): HTMLButtonElement {
    return fixture.nativeElement.querySelector('[aria-label="CALL.HIDE_MINI_PLAYER"]') as HTMLButtonElement;
}

describe('CallMiniPlayerComponent visibility', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders nothing with no call running at all', () => {
        const {fixture} = setup();

        expect(tile(fixture)).toBeNull();
    });

    it('renders for guild voice while the channel stage is not on screen', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes);
        fixture.detectChanges();

        expect(tile(fixture)).not.toBeNull();
    });

    it('stands down while the guild stage for that channel is mounted', () => {
        const {fixture, fakes, presence} = setup();
        joinGuildVoice(fakes);
        fixture.detectChanges();

        presence.register('channel:chan-1');
        fixture.detectChanges();

        expect(tile(fixture)).toBeNull();
    });

    it('comes back when that stage unmounts again', () => {
        const {fixture, fakes, presence} = setup();
        joinGuildVoice(fakes);
        presence.register('channel:chan-1');
        fixture.detectChanges();

        presence.unregister('channel:chan-1');
        fixture.detectChanges();

        expect(tile(fixture)).not.toBeNull();
    });

    it('keeps playing while a different voice channel is being browsed', () => {
        // The presence key is the session, not the surface: opening channel 2 while connected to
        // channel 1 mounts a stage, but not this session's stage.
        const {fixture, fakes, presence} = setup();
        joinGuildVoice(fakes);
        presence.register('channel:chan-2');
        fixture.detectChanges();

        expect(tile(fixture)).not.toBeNull();
    });

    it('goes away when the header close control is used', () => {
        // Without this the tile is inescapable: a voice channel nobody is sharing in parks a panel
        // over every view in the app until you hang up.
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes);
        fixture.detectChanges();

        closeButton(fixture).click();
        fixture.detectChanges();

        expect(tile(fixture)).toBeNull();
    });

    it('dismisses one session only, so the next call still gets a tile', () => {
        // The part most likely to be got wrong: a bare boolean would leave the next call with no
        // tile and nothing on screen to explain why.
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes);
        fixture.detectChanges();
        closeButton(fixture).click();
        fixture.detectChanges();
        expect(tile(fixture)).toBeNull();

        fakes.joinedChannelId.set('chan-2');
        fixture.detectChanges();

        expect(tile(fixture)).not.toBeNull();
        // And the sidebar stops offering to restore a tile that is already back.
        expect(TestBed.inject(CallMiniPlayerService).isDismissed()).toBe(false);
    });

    it('comes back when the sidebar voice bar asks for it', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes);
        fixture.detectChanges();
        closeButton(fixture).click();
        fixture.detectChanges();

        TestBed.inject(CallMiniPlayerService).restore();
        fixture.detectChanges();

        expect(tile(fixture)).not.toBeNull();
    });

    it('renders for a DM call while its panel is not on screen, and stands down when it is', () => {
        const {fixture, fakes, presence} = setup();
        fakes.session.set(dmSession());
        fixture.detectChanges();
        expect(tile(fixture)).not.toBeNull();

        presence.register('call:call-1');
        fixture.detectChanges();

        expect(tile(fixture)).toBeNull();
    });
});

describe('CallMiniPlayerComponent watch claim', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('tells ShareWatchService about the stream it is showing', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes, true);
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([{scope: CHANNEL_SCOPE, shareIds: ['share-1']}]);
    });

    it('claims the DM call scope for a DM share', () => {
        const {fixture, fakes} = setup();
        fakes.session.set(dmSession([
            {shareId: 'share-9', userId: 'u2', displayName: 'Ada Lovelace', isLocal: false, stream: undefined},
        ]));
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([{scope: CALL_SCOPE, shareIds: ['share-9']}]);
    });

    it('claims nothing when nobody is sharing', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes);
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([]);
    });

    it('claims nothing for this client\'s own share', () => {
        // Watching your own stream is not a thing to tell the server, and the sidebar voice bar is
        // what shows it back to you.
        const {fixture, fakes} = setup();
        fakes.isInVoice.set(true);
        fakes.joinedChannelId.set('chan-1');
        fakes.joinedGuildId.set('guild-1');
        fakes.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true});
        fakes.channelParticipants.set(new Map([[
            'chan-1', [rosterEntry({userId: 'me', displayName: 'You', isLocal: true})],
        ]]));
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([]);
    });

    it('releases the claim when the session ends', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes, true);
        fixture.detectChanges();

        fakes.isInVoice.set(false);
        fakes.joinedChannelId.set(null);
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([
            {scope: CHANNEL_SCOPE, shareIds: ['share-1']},
            {scope: CHANNEL_SCOPE, shareIds: []},
        ]);
    });

    it('releases the claim when the tile is closed', () => {
        // Claims are driven by what renders. A dismissed tile renders nothing, so continuing to
        // claim would inflate the streamer's viewer count with someone who closed the video.
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes, true);
        fixture.detectChanges();

        closeButton(fixture).click();
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([
            {scope: CHANNEL_SCOPE, shareIds: ['share-1']},
            {scope: CHANNEL_SCOPE, shareIds: []},
        ]);
    });

    it('leaves the claim alone when the stage takes the screen back', () => {
        // setWatching declares the *complete* set for a scope, and the stage declares its own the
        // moment it mounts. Clearing ours on the way out would wipe theirs.
        const {fixture, fakes, presence} = setup();
        joinGuildVoice(fakes, true);
        fixture.detectChanges();

        presence.register('channel:chan-1');
        fixture.detectChanges();

        expect(fakes.watchCalls).toEqual([{scope: CHANNEL_SCOPE, shareIds: ['share-1']}]);
    });
});

/**
 * Task 10's other claim: `RustMediaService.claimPreviewRender`, for the idle preview pause. The
 * tile never picks the local share for `focusedShare` (see its own doc comment), so there is
 * structurally nothing here for the preview claim to ever fire on - but the requirement is that a
 * dismissed tile specifically claims nothing, and this pins that rather than trusting the "it never
 * renders the local preview" reasoning to hold forever on its own.
 */
describe('CallMiniPlayerComponent preview claim', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('never claims the preview while visible and sharing remotely', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes, true);
        fixture.detectChanges();

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
    });

    it('never claims the preview once dismissed', () => {
        const {fixture, fakes} = setup();
        joinGuildVoice(fakes, true);
        fixture.detectChanges();

        closeButton(fixture).click();
        fixture.detectChanges();

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
        expect(fakes.releasePreviewRender).not.toHaveBeenCalled();
    });
});

describe('CallMiniPlayerComponent dragging', () => {
    const realWidth = window.innerWidth;
    const realHeight = window.innerHeight;

    beforeEach(() => TestBed.resetTestingModule());

    afterEach(() => setViewport(realWidth, realHeight));

    function setViewport(width: number, height: number): void {
        Object.defineProperty(window, 'innerWidth', {value: width, configurable: true, writable: true});
        Object.defineProperty(window, 'innerHeight', {value: height, configurable: true, writable: true});
    }

    /** jsdom lays nothing out, so the tile has to be told how big it is for clamping to mean anything. */
    function sizeTile(element: HTMLElement, width: number, height: number): void {
        Object.defineProperty(element, 'offsetWidth', {value: width, configurable: true});
        Object.defineProperty(element, 'offsetHeight', {value: height, configurable: true});
    }

    function shown(): Harness {
        const harness = setup();
        joinGuildVoice(harness.fakes);
        harness.fixture.detectChanges();
        sizeTile(tile(harness.fixture)!, 256, 200);
        return harness;
    }

    function dragTo(fixture: ComponentFixture<CallMiniPlayerComponent>, x: number, y: number): void {
        const header = fixture.nativeElement.querySelector('header') as HTMLElement;
        header.dispatchEvent(new MouseEvent('mousedown', {clientX: 0, clientY: 0, button: 0, bubbles: true}));
        document.dispatchEvent(new MouseEvent('mousemove', {clientX: x, clientY: y, bubbles: true}));
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        fixture.detectChanges();
    }

    it('moves the tile to where it was dragged', () => {
        // Asserted on the rendered element, not only on the signal: the clamping maths below is
        // well covered, but every one of those tests would still pass with the [style.left.px]
        // binding deleted and the tile pinned to its default corner forever.
        setViewport(1200, 900);
        const {fixture} = shown();

        dragTo(fixture, 300, 200);

        const element = tile(fixture)!;
        expect(element.style.left).toBe('300px');
        expect(element.style.top).toBe('200px');
        expect(fixture.componentInstance['position']()).toEqual({x: 300, y: 200});
    });

    it('leaves the corner anchoring in place until it has been dragged', () => {
        setViewport(1200, 900);
        const {fixture} = shown();

        const element = tile(fixture)!;
        expect(element.style.left).toBe('');
        expect(element.classList).toContain('bottom-4');
        expect(element.classList).toContain('right-4');
    });

    it('clamps a drag past the right and bottom edges', () => {
        setViewport(1200, 900);
        const {fixture} = shown();

        dragTo(fixture, 5000, 5000);

        expect(fixture.componentInstance['position']()).toEqual({x: 1200 - 256, y: 900 - 200});
    });

    it('clamps a drag past the top and left edges', () => {
        setViewport(1200, 900);
        const {fixture} = shown();

        dragTo(fixture, -400, -400);

        expect(fixture.componentInstance['position']()).toEqual({x: 0, y: 0});
    });

    it('forgets where it was put once the session changes', () => {
        // The component is mounted once for the whole app, so without an explicit reset the next
        // call would open wherever a long-finished one was last dragged.
        setViewport(1200, 900);
        const {fixture, fakes} = shown();
        dragTo(fixture, 300, 200);

        fakes.joinedChannelId.set('chan-2');
        fixture.detectChanges();

        expect(fixture.componentInstance['position']()).toBeNull();
    });

    it('pulls the tile back inside when the window shrinks under it', () => {
        // There is no scrollbar that would bring a position:fixed element back, so a tile parked at
        // the right edge of a wide window is simply gone once the window is narrow.
        setViewport(1200, 900);
        const {fixture} = shown();
        dragTo(fixture, 900, 700);

        setViewport(700, 500);
        window.dispatchEvent(new Event('resize'));
        fixture.detectChanges();

        expect(fixture.componentInstance['position']()).toEqual({x: 700 - 256, y: 500 - 200});
    });
});
