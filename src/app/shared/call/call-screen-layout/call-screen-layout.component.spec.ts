import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallParticipant, CallScreenShare, CallStageTile} from '../call.types';
import {ShareWatchService, WatchScope, scopeKey} from '../../../services/share-watch.service';
import {CallFocusService} from '../../../services/call-focus.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {ProfileService} from '../../../services/profile.service';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {FakeOsInfo} from '../../../platform/testing/fake-os-info';

/**
 * What `app-avatar` needs to render, and nothing else.
 *
 * <p>Only reached once a spec passes participants: the strip draws an avatar per person, and that
 * component resolves a profile picture behind the initials. Neither the picture nor the platform is
 * what any of these specs is about, so the real services (an HttpClient chain and a Tauri port) stay
 * out of the module.</p>
 */
function avatarProviders() {
    return [
        {provide: OsInfo, useValue: new FakeOsInfo('web', false)},
        {provide: ProfileService, useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => undefined}},
    ];
}

/** A stand-in that never claims - CallScreenLayoutComponent injects RustMediaService for Task 10's
 *  idle pause, and none of these specs are about that behaviour. */
function fakeRustMedia() {
    return {previewPaused: () => false, claimPreviewRender: vi.fn(), releasePreviewRender: vi.fn(), resumePreview: vi.fn()};
}

function share(shareId: string, isLocal = false): CallScreenShare {
    return {
        shareId,
        userId: isLocal ? 'me' : `user-${shareId}`,
        displayName: isLocal ? 'You' : shareId,
        isLocal,
    };
}

/** Camera off unless a test says otherwise - the stage only promotes a participant who has one. */
function participant(userId: string, overrides: Partial<CallParticipant> = {}): CallParticipant {
    return {
        userId,
        displayName: userId,
        avatarLabel: userId[0].toUpperCase(),
        isLocal: false,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        ...overrides,
    };
}

/**
 * Reaching into protected members: they are the whole behaviour of this component, and the
 * alternative is asserting on tile counts in rendered markup.
 */
interface ProtectedSurface {
    displayedShares: () => CallScreenShare[];
    displayedTiles: () => CallStageTile[];
    stripParticipants: () => CallParticipant[];
    canToggleFocus: () => boolean;
    selfCard: () => CallScreenShare | null;
    gridClass: () => string;
    showInviteCard: () => boolean;
    maximizedId: {(): string | null; set: (id: string | null) => void};
    toggleGridFocus: () => void;
    viewerNames: (shareId: string) => string[];
}

interface SetupOptions {
    watchScope?: WatchScope | null;
    /** viewersOf() implementations the tests below plug in - default is the empty-scope case. */
    viewersOf?: (scope: WatchScope, shareId: string) => string[];
    nameOf?: (userId: string) => string;
    participants?: CallParticipant[];
}

function setup(shares: CallScreenShare[], options: SetupOptions = {}) {
    const setWatching = vi.fn();
    TestBed.configureTestingModule({
        // The layout renders translated tiles now, so it needs a TranslateService to resolve them.
        imports: [CallScreenLayoutComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: ShareWatchService,
                useValue: {
                    setWatching,
                    refresh: vi.fn(),
                    clear: vi.fn(),
                    viewerCount: () => 0,
                    viewersOf: options.viewersOf ?? (() => []),
                },
            },
            {provide: RustMediaService, useValue: fakeRustMedia()},
            ...avatarProviders(),
        ],
    });

    const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', options.participants ?? []);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    if (options.watchScope) fixture.componentRef.setInput('watchScope', options.watchScope);
    if (options.nameOf) fixture.componentRef.setInput('nameOf', options.nameOf);
    fixture.detectChanges();

    return {
        fixture,
        setWatching,
        layout: fixture.componentInstance as unknown as ProtectedSurface,
    };
}

/** The shareIds most recently handed to setWatching, or undefined if it was never called. */
function lastWatched(setWatching: ReturnType<typeof vi.fn>): string[] | undefined {
    const call = setWatching.mock.calls.at(-1) as [WatchScope, readonly string[]] | undefined;
    return call ? [...call[1]] : undefined;
}

describe('CallScreenLayoutComponent share placement', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('gives your own stream the grid when nobody else is sharing', () => {
        // Alone, the local preview is the only thing there is to show - demoting it would leave an
        // empty layout with a thumbnail in the corner.
        const {layout} = setup([share('mine', true)]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['mine']);
        expect(layout.selfCard()).toBeNull();
    });

    it('drops your own stream out of the grid once somebody else shares', () => {
        // The local preview is a low-rate thumbnail of a screen already in front of you. At full
        // tile size it reads as a broken stream, and it was taking half the room from the stream
        // actually worth watching.
        const {layout} = setup([share('mine', true), share('theirs')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['theirs']);
        expect(layout.selfCard()?.shareId).toBe('mine');
    });

    it('keeps every remote stream in the grid', () => {
        const {layout} = setup([share('mine', true), share('a'), share('b')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
    });

    it('shows only the maximised stream, self-card included', () => {
        const {layout} = setup([share('mine', true), share('theirs')]);

        layout.maximizedId.set('mine');

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['mine']);
        expect(layout.selfCard()).toBeNull();
    });

    it('lays one stream out full width', () => {
        expect(setup([share('a')]).layout.gridClass()).toBe('grid-cols-1');
    });

    it('pairs two', () => {
        expect(setup([share('a'), share('b')]).layout.gridClass()).toBe('grid-cols-2');
    });

    it('still pairs at four', () => {
        expect(setup([share('a'), share('b'), share('c'), share('d')]).layout.gridClass()).toBe('grid-cols-2');
    });

    it('goes to three columns past four, rather than stranding a tile', () => {
        const {layout} = setup([share('a'), share('b'), share('c'), share('d'), share('e')]);

        expect(layout.gridClass()).toBe('grid-cols-3');
    });

    it('counts columns from what is displayed, not from what exists', () => {
        // Your own share is not in the grid, so it must not widen it either.
        const {layout} = setup([share('mine', true), share('theirs')]);

        expect(layout.gridClass()).toBe('grid-cols-1');
    });
});

describe('CallScreenLayoutComponent grid/focus toggle', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('focuses the first displayed share when toggled from the grid', () => {
        // There is no single "the" share to focus from the grid without a specific tile having
        // been picked - this is the coarse entry point; a double-click on a particular tile is the
        // precise one (see call-share-tile.component.html).
        const {layout} = setup([share('a'), share('b'), share('c')]);

        layout.toggleGridFocus();

        expect(layout.maximizedId()).toBe('a');
    });

    it('clears back to the grid when toggled while a share is maximised', () => {
        const {layout} = setup([share('a'), share('b')]);
        layout.maximizedId.set('b');

        layout.toggleGridFocus();

        expect(layout.maximizedId()).toBeNull();
    });
});

describe('CallScreenLayoutComponent focus requests', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};

    beforeEach(() => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            imports: [CallScreenLayoutComponent, TranslateModule.forRoot()],
            providers: [
                {
                    provide: ShareWatchService,
                    useValue: {
                        setWatching: vi.fn(),
                        refresh: vi.fn(),
                        clear: vi.fn(),
                        viewerCount: () => 0,
                        viewersOf: () => [],
                    },
                },
                {provide: RustMediaService, useValue: fakeRustMedia()},
            ],
        });
    });

    /**
     * Creates the layout for `scope` against whatever CallFocusService request the test armed
     * beforehand - request() has to land before the layout exists, exactly the ordering a real
     * caller (a notification action, click-to-watch) cannot control either, since the layout for the
     * scope it cares about may not have been created yet.
     */
    function createLayout(shares: CallScreenShare[]) {
        const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
        fixture.componentRef.setInput('screenShares', shares);
        fixture.componentRef.setInput('participants', []);
        fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
        fixture.componentRef.setInput('watchScope', scope);
        fixture.detectChanges();

        return fixture.componentInstance as unknown as {displayedShares: () => CallScreenShare[]};
    }

    it('maximizes the share belonging to a requested user id', () => {
        TestBed.inject(CallFocusService).request(scopeKey(scope), {userId: 'user-b'});

        const layout = createLayout([share('mine', true), share('a'), share('b')]);

        // Resolved through getShareForUser: the caller only knew whose stream to focus, not its
        // share id.
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['b']);
    });

    it('ignores a request armed for a different scope', () => {
        // Armed for a call this layout is not showing - a request meant for another surface must
        // not leak into whichever layout happens to run its effect first.
        TestBed.inject(CallFocusService).request('call:some-other-call', {userId: 'user-a'});

        const layout = createLayout([share('a'), share('b')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
    });
});

describe('CallScreenLayoutComponent viewer names', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};
    const roster: Record<string, string> = {'user-x': 'Xena', 'user-y': 'Yara'};

    beforeEach(() => TestBed.resetTestingModule());

    it('maps viewer ids through the given name resolver', () => {
        const {layout} = setup([share('a')], {
            watchScope: scope,
            viewersOf: (_, shareId) => shareId === 'a' ? ['user-x', 'user-y'] : [],
            nameOf: id => roster[id] ?? id,
        });

        expect(layout.viewerNames('a')).toEqual(['Xena', 'Yara']);
    });

    it('falls back to echoing the id when no resolver is wired', () => {
        // The default a host that forgets to pass nameOf gets - see the nameOf doc comment. Real
        // hosts always wire one; this only proves the fallback does not throw or silently drop ids.
        const {layout} = setup([share('a')], {
            watchScope: scope,
            viewersOf: (_, shareId) => shareId === 'a' ? ['user-x'] : [],
        });

        expect(layout.viewerNames('a')).toEqual(['user-x']);
    });

    it('returns no names without a watch scope, regardless of what viewersOf would say', () => {
        const {layout} = setup([share('a')], {watchScope: null, viewersOf: () => ['user-x']});

        expect(layout.viewerNames('a')).toEqual([]);
    });
});

describe('CallScreenLayoutComponent one stage for cameras and screens', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither; a camera tile with a real MediaStream renders a <video>, and an
        // unhandled "not implemented" would fail the run before the assertion it stands in front of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('gives a camera and a screen share the same grid', () => {
        // The point of the whole task: a face-cam beside a game stream. Before this, any share at
        // all sent every camera to a 32px circle in the strip below.
        const {layout} = setup([share('theirs')], {
            participants: [participant('user-theirs'), participant('cam', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:theirs', 'camera:cam']);
    });

    it('renders both kinds with their own component, rather than a second copy of either', () => {
        const {fixture} = setup([share('theirs')], {
            participants: [participant('cam', {isCameraOn: true})],
        });

        expect(fixture.nativeElement.querySelectorAll('app-call-share-tile').length).toBe(1);
        expect(fixture.nativeElement.querySelectorAll('app-call-participant-tile').length).toBe(1);
    });

    it('tiles cameras alone when nobody is sharing', () => {
        const {layout} = setup([], {
            participants: [participant('a', {isCameraOn: true}), participant('b', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.kind)).toEqual(['camera', 'camera']);
        expect(layout.displayedShares()).toEqual([]);
    });

    it('leaves the grid to the shares when no camera is on', () => {
        const {layout} = setup([share('a'), share('b')], {
            participants: [participant('user-a'), participant('user-b')],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'share:b']);
    });

    it('promotes a camera that has no track yet, rather than waiting for it to land', () => {
        // app-call-participant-tile draws the "still negotiating" state itself. Holding the seat
        // back until the track arrives would reflow every other tile the moment it did.
        const {layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true, videoStream: null})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:cam']);
    });

    it('keeps the two id spaces apart where they genuinely overlap', () => {
        // Guild voice falls back to the user id for a share with no media session id, so one person
        // sharing with their camera on produces two tiles under the identical raw id.
        const {layout} = setup([{shareId: 'dora', userId: 'dora', displayName: 'Dora', isLocal: false}], {
            participants: [participant('dora', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:dora', 'camera:dora']);
    });

    it('drops the cameras too while a share is maximised', () => {
        // Maximised means one tile. A camera left beside it would make "hide the other streams" a
        // half-truth.
        const {layout} = setup([share('a'), share('b')], {
            participants: [participant('cam', {isCameraOn: true})],
        });

        layout.maximizedId.set('a');

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a']);
    });

    it('counts columns over the combined set, not the shares alone', () => {
        const {layout} = setup([share('a')], {participants: [participant('cam', {isCameraOn: true})]});

        expect(layout.gridClass()).toBe('grid-cols-2');
    });

    it('still fits nine tiles in three columns', () => {
        const cameras = Array.from({length: 9}, (_, i) => participant(`cam-${i}`, {isCameraOn: true}));

        expect(setup([], {participants: cameras}).layout.gridClass()).toBe('grid-cols-3');
    });

    it('reaches for a fourth column only past nine', () => {
        // Counts the share-only thresholds never had to answer for: three columns of ten tiles is a
        // wall of letterboxes.
        const cameras = Array.from({length: 9}, (_, i) => participant(`cam-${i}`, {isCameraOn: true}));

        expect(setup([share('a')], {participants: cameras}).layout.gridClass()).toBe('grid-cols-4');
    });

    it('offers no grid/focus toggle on a stage of nothing but cameras', () => {
        // There would be no share for the press to maximise, so the button would do nothing.
        const {layout} = setup([], {
            participants: [participant('a', {isCameraOn: true}), participant('b', {isCameraOn: true})],
        });

        expect(layout.canToggleFocus()).toBe(false);
    });

    it('offers the toggle once a share shares the grid with a camera', () => {
        const {layout} = setup([share('a')], {participants: [participant('cam', {isCameraOn: true})]});

        expect(layout.canToggleFocus()).toBe(true);

        layout.toggleGridFocus();

        expect(layout.maximizedId()).toBe('a');
    });

    it('still offers no toggle for a lone share with nothing beside it', () => {
        const {layout} = setup([share('a')], {participants: [participant('user-a')]});

        expect(layout.canToggleFocus()).toBe(false);
    });
});

describe('CallScreenLayoutComponent participants strip', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('drops somebody whose camera got a tile, rather than showing them twice', () => {
        const {layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true}), participant('quiet')],
        });

        expect(layout.stripParticipants().map(p => p.userId)).toEqual(['quiet']);
    });

    it('keeps a sharer with their camera off, whose share tile carries none of what the strip does', () => {
        // The strip entry is the only place with that person's audio-wait badge, their context menu
        // and their per-person stream mute. A share tile shows a screen, not a person.
        const {layout} = setup([share('a')], {participants: [participant('user-a')]});

        expect(layout.stripParticipants().map(p => p.userId)).toEqual(['user-a']);
    });

    it('renders no strip at all once every camera is on the stage', () => {
        const {fixture, layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true})],
        });

        expect(layout.stripParticipants()).toEqual([]);
        // The strip's own entries are plain divs; the avatar is what identifies one in the markup.
        expect(fixture.nativeElement.querySelectorAll('app-avatar').length).toBe(0);
    });

    it('still shows a live camera in the strip while a share is maximised', () => {
        // The one state where a camera-on participant is back in this row: maximised means the stage
        // is shares only, so nobody is on stage as a person and stripParticipants filters nothing
        // out. Rendering them as a static avatar here would make turning your camera on invisible
        // the moment anyone maximised a stream - the exact bug the strip's camera circle fixed.
        const {fixture, layout} = setup([share('a'), share('b')], {
            participants: [participant('cam', {isCameraOn: true, videoStream: {} as MediaStream})],
        });
        expect(layout.stripParticipants()).toEqual([]);

        layout.maximizedId.set('a');
        fixture.detectChanges();

        expect(layout.stripParticipants().map(p => p.userId)).toEqual(['cam']);
        // The grid holds the one maximised share tile, so any <video> in the strip is the camera's.
        expect(fixture.nativeElement.querySelectorAll('app-call-participant-tile').length).toBe(0);
        expect(fixture.nativeElement.querySelector('video')).not.toBeNull();
        expect(fixture.nativeElement.querySelectorAll('app-avatar').length).toBe(0);
    });

    it('takes a camera owner back once they turn it off', () => {
        const {fixture, layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true})],
        });
        expect(layout.stripParticipants()).toEqual([]);

        fixture.componentRef.setInput('participants', [participant('cam', {isCameraOn: false})]);
        fixture.detectChanges();

        expect(layout.stripParticipants().map(p => p.userId)).toEqual(['cam']);
    });
});

describe('CallScreenLayoutComponent watch claim beside cameras', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};

    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('claims the shares on the stage and nothing a camera added to it', () => {
        // Asserting on what ShareWatchService was actually told, not on displayedShares again -
        // the claim is what a streamer's viewer count is built from.
        const {setWatching} = setup([share('a'), share('b')], {
            watchScope: scope,
            participants: [participant('cam', {isCameraOn: true})],
        });

        expect(lastWatched(setWatching)).toEqual(['a', 'b']);
    });

    it('claims nothing on a stage of cameras only', () => {
        const {setWatching} = setup([], {
            watchScope: scope,
            participants: [participant('cam', {isCameraOn: true})],
        });

        expect(lastWatched(setWatching)).toEqual([]);
    });

    it('shrinks the claim to the maximised share, cameras on the stage or not', () => {
        const {fixture, layout, setWatching} = setup([share('a'), share('b')], {
            watchScope: scope,
            participants: [participant('cam', {isCameraOn: true})],
        });

        layout.maximizedId.set('a');
        fixture.detectChanges();

        expect(lastWatched(setWatching)).toEqual(['a']);
    });
});

describe('CallScreenLayoutComponent share-less stage (Task 18)', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('gives every participant a full tile when nothing is being shared, camera or not', () => {
        // Both call hosts used to render their own smaller grid for exactly this case, bypassing
        // this component entirely - see voice-channel.component.html / call-panel.component.html.
        // Now that they always route through here, a share-less stage has to seat everybody, not
        // just the camera-on ones.
        const {layout} = setup([], {
            participants: [participant('a'), participant('b', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['camera:a', 'camera:b']);
        expect(layout.stripParticipants()).toEqual([]);
    });

    it('keeps the old camera-only rule the moment anything is shared', () => {
        // The widening is specifically for the share-less case - with a share on stage, a
        // camera-off participant still belongs in the strip, unchanged from before this task.
        const {layout} = setup([share('a')], {
            participants: [participant('cam-on', {isCameraOn: true}), participant('cam-off')],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:cam-on']);
        expect(layout.stripParticipants().map(p => p.userId)).toEqual(['cam-off']);
    });

    it('keeps gridClass()\'s thresholds intact against the larger share-less pool', () => {
        // Not a new threshold - the same <=1/<=4/<=9 boundaries, now fed by a bigger count. Nine
        // share-less participants still fits three columns, exactly like nine cameras already did
        // (see the "one stage" describe block above).
        const nine = Array.from({length: 9}, (_, i) => participant(`p-${i}`));

        expect(setup([], {participants: nine}).layout.gridClass()).toBe('grid-cols-3');
    });

    it('claims nothing for a share-less stage full of participants', () => {
        // The recording-stub pattern from the "watch claim beside cameras" block above: participant
        // tiles are not shares, so widening displayedTiles() to include them must not put anything
        // into the claim this client announces to ShareWatchService.
        const scope: WatchScope = {kind: 'call', callId: 'call-1'};
        const {setWatching} = setup([], {
            watchScope: scope,
            participants: [participant('a'), participant('b', {isCameraOn: true})],
        });

        expect(lastWatched(setWatching)).toEqual([]);
    });
});

describe('CallScreenLayoutComponent invite card (Task 18)', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('shows the invite card beside a lone tile', () => {
        const {fixture, layout} = setup([], {participants: [participant('solo')]});

        expect(layout.showInviteCard()).toBe(true);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(1);
    });

    it('does not show the card once a second tile exists', () => {
        const {fixture, layout} = setup([], {
            participants: [participant('a'), participant('b')],
        });

        expect(layout.showInviteCard()).toBe(false);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(0);
    });

    it('does not show the card on an empty stage', () => {
        const {layout} = setup([], {participants: []});

        expect(layout.showInviteCard()).toBe(false);
    });

    it('forces two grid columns for the card without changing what gridClass() itself reports', () => {
        // gridClass() stays pinned at 'grid-cols-1' for a one-tile count - existing specs assert
        // that directly. The template compensates at the render layer instead (see
        // call-screen-layout.component.html), which is what this asserts against the actual DOM.
        const {fixture, layout} = setup([], {participants: [participant('solo')]});

        expect(layout.gridClass()).toBe('grid-cols-1');
        const grid: HTMLElement = fixture.nativeElement.querySelector('.grid');
        expect(grid.className).toContain('grid-cols-2');
        expect(grid.className).not.toContain('grid-cols-1');
    });

    it('never lets the card reach displayedShares() or the watch claim', () => {
        const scope: WatchScope = {kind: 'call', callId: 'call-1'};
        const {layout, setWatching} = setup([], {watchScope: scope, participants: [participant('solo')]});

        expect(layout.showInviteCard()).toBe(true);
        expect(layout.displayedShares()).toEqual([]);
        expect(lastWatched(setWatching)).toEqual([]);
    });
});
