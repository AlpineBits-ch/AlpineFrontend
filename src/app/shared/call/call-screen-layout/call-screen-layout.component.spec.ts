import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallParticipant, CallScreenShare, CallStageTile} from '../call.types';
import {ShareWatchService, WatchScope, scopeKey} from '../../../services/share-watch.service';
import {CallFocusService} from '../../../services/call-focus.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {ProfileService} from '../../../services/profile.service';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {FakeOsInfo} from '../../../platform/testing/fake-os-info';

/** What `app-avatar` needs to render, and nothing else. */
function avatarProviders() {
    return [
        {provide: OsInfo, useValue: new FakeOsInfo('web', false)},
        {
            provide: ProfileService,
            useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => undefined},
        },
    ];
}

/** A stand-in that never claims. */
function fakeRustMedia() {
    return {
        previewPaused: () => false,
        claimPreviewRender: vi.fn(),
        releasePreviewRender: vi.fn(),
        resumePreview: vi.fn(),
    };
}

function share(shareId: string, isLocal = false): CallScreenShare {
    return {
        shareId,
        userId: isLocal ? 'me' : `user-${shareId}`,
        displayName: isLocal ? 'You' : shareId,
        isLocal,
    };
}

/** Camera off unless a test says otherwise. */
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

/** The protected members these specs assert on. */
interface ProtectedSurface {
    displayedShares: () => CallScreenShare[];
    displayedTiles: () => CallStageTile[];
    stripParticipants: () => CallParticipant[];
    canToggleFocus: () => boolean;
    selfCard: () => CallScreenShare | null;
    gridClass: () => string;
    showInviteCard: () => boolean;
    emitInviteRequest: () => void;
    maximizedId: {(): string | null; set: (id: string | null) => void};
    toggleGridFocus: () => void;
    viewerNames: (shareId: string) => string[];
}

interface SetupOptions {
    watchScope?: WatchScope | null;
    /** viewersOf() implementations the tests below plug in. Default is the empty-scope case. */
    viewersOf?: (scope: WatchScope, shareId: string) => string[];
    nameOf?: (userId: string) => string;
    participants?: CallParticipant[];
}

function setup(shares: CallScreenShare[], options: SetupOptions = {}) {
    const setWatching = vi.fn();
    TestBed.configureTestingModule({
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

    const fixture: ComponentFixture<CallScreenLayoutComponent> =
        TestBed.createComponent(CallScreenLayoutComponent);
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
        const {layout} = setup([share('mine', true)]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['mine']);
        expect(layout.selfCard()).toBeNull();
    });

    it('drops your own stream out of the grid once somebody else shares', () => {
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
        expect(setup([share('a'), share('b'), share('c'), share('d')]).layout.gridClass()).toBe(
            'grid-cols-2',
        );
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

    /** Creates the layout for `scope` against whatever CallFocusService request the test armed first. */
    function createLayout(shares: CallScreenShare[]) {
        const fixture: ComponentFixture<CallScreenLayoutComponent> =
            TestBed.createComponent(CallScreenLayoutComponent);
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

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['b']);
    });

    it('ignores a request armed for a different scope', () => {
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
            viewersOf: (_, shareId) => (shareId === 'a' ? ['user-x', 'user-y'] : []),
            nameOf: id => roster[id] ?? id,
        });

        expect(layout.viewerNames('a')).toEqual(['Xena', 'Yara']);
    });

    it('falls back to echoing the id when no resolver is wired', () => {
        const {layout} = setup([share('a')], {
            watchScope: scope,
            viewersOf: (_, shareId) => (shareId === 'a' ? ['user-x'] : []),
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
        // jsdom implements neither.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('gives a camera and a screen share the same grid', () => {
        const {layout} = setup([share('theirs')], {
            participants: [participant('user-theirs'), participant('cam', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual([
            'share:theirs',
            'camera:user-theirs',
            'camera:cam',
        ]);
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

    it('orders every share ahead of every seat, cameras on or off', () => {
        const {layout} = setup([share('a'), share('b')], {
            participants: [participant('user-a'), participant('user-b')],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual([
            'share:a',
            'share:b',
            'camera:user-a',
            'camera:user-b',
        ]);
    });

    it('promotes a camera that has no track yet, rather than waiting for it to land', () => {
        const {layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true, videoStream: null})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:cam']);
    });

    it('keeps the two id spaces apart where they genuinely overlap', () => {
        // Guild voice falls back to the user id when a share has no media session id.
        const {layout} = setup([{shareId: 'dora', userId: 'dora', displayName: 'Dora', isLocal: false}], {
            participants: [participant('dora', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:dora', 'camera:dora']);
    });

    it('drops the cameras too while a share is maximised', () => {
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
        const cameras = Array.from({length: 9}, (_, i) => participant(`cam-${i}`, {isCameraOn: true}));

        expect(setup([share('a')], {participants: cameras}).layout.gridClass()).toBe('grid-cols-4');
    });

    it('offers no grid/focus toggle on a stage of nothing but cameras', () => {
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

    it('offers the toggle for a share beside a lone seat - there is something to focus away from', () => {
        const {layout} = setup([share('a')], {participants: [participant('user-a')]});

        expect(layout.canToggleFocus()).toBe(true);
    });

    it('still offers no toggle for a share with an empty roster', () => {
        const {layout} = setup([share('a')], {participants: []});

        expect(layout.canToggleFocus()).toBe(false);
    });
});

describe('CallScreenLayoutComponent participants strip', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('drops everybody who has a seat, rather than showing them twice', () => {
        const {layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true}), participant('quiet')],
        });

        expect(layout.stripParticipants()).toEqual([]);
    });

    it('leaves a sharer with their camera off in the grid, not in the strip', () => {
        const {layout} = setup([share('a')], {participants: [participant('user-a')]});

        expect(layout.stripParticipants()).toEqual([]);
    });

    it('renders no strip at all while nothing is maximised', () => {
        const {fixture, layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true})],
        });

        expect(layout.stripParticipants()).toEqual([]);
        // The strip's own entries are plain divs; the avatar is what identifies one in the markup.
        expect(fixture.nativeElement.querySelectorAll('app-avatar').length).toBe(0);
    });

    it('still shows a live camera in the strip while a share is maximised', () => {
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

    it('keeps a seat when the camera behind it goes off', () => {
        const {fixture, layout} = setup([share('a')], {
            participants: [participant('cam', {isCameraOn: true})],
        });
        expect(layout.stripParticipants()).toEqual([]);

        fixture.componentRef.setInput('participants', [participant('cam', {isCameraOn: false})]);
        fixture.detectChanges();

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:cam']);
        expect(layout.stripParticipants()).toEqual([]);
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
        const {layout} = setup([], {
            participants: [participant('a'), participant('b', {isCameraOn: true})],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['camera:a', 'camera:b']);
        expect(layout.stripParticipants()).toEqual([]);
    });

    it("keeps gridClass()'s thresholds intact against the larger share-less pool", () => {
        const nine = Array.from({length: 9}, (_, i) => participant(`p-${i}`));

        expect(setup([], {participants: nine}).layout.gridClass()).toBe('grid-cols-3');
    });

    it('claims nothing for a share-less stage full of participants', () => {
        const scope: WatchScope = {kind: 'call', callId: 'call-1'};
        const {setWatching} = setup([], {
            watchScope: scope,
            participants: [participant('a'), participant('b', {isCameraOn: true})],
        });

        expect(lastWatched(setWatching)).toEqual([]);
    });
});

describe('CallScreenLayoutComponent a share never costs anybody their seat', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('seats a camera-off participant beside a share rather than dropping them to the strip', () => {
        const {layout} = setup([share('a')], {
            participants: [participant('cam-on', {isCameraOn: true}), participant('cam-off')],
        });

        expect(layout.displayedTiles().map(t => t.id)).toEqual([
            'share:a',
            'camera:cam-on',
            'camera:cam-off',
        ]);
        expect(layout.stripParticipants()).toEqual([]);
    });

    it('seats the sharer as well, so their stream sits beside them rather than replacing them', () => {
        const {layout} = setup([share('a')], {participants: [participant('user-a')]});

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:user-a']);
        expect(layout.stripParticipants()).toEqual([]);
    });

    it('leaves a lone sharer with a seat and a stream, and no strip under either', () => {
        const {fixture, layout} = setup([share('mine', true)], {
            participants: [participant('me', {isLocal: true})],
        });

        expect(layout.displayedTiles().map(t => t.kind)).toEqual(['share', 'camera']);
        expect(fixture.nativeElement.querySelectorAll('app-call-share-tile').length).toBe(1);
        expect(fixture.nativeElement.querySelectorAll('app-call-participant-tile').length).toBe(1);
        expect(layout.stripParticipants()).toEqual([]);
    });

    it('returns everybody to the strip while a share is maximised, camera or not', () => {
        const {layout} = setup([share('a')], {
            participants: [participant('cam-on', {isCameraOn: true}), participant('cam-off')],
        });

        layout.maximizedId.set('a');

        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a']);
        expect(layout.stripParticipants().map(p => p.userId)).toEqual(['cam-on', 'cam-off']);
    });
});

describe('CallScreenLayoutComponent escape leaves the maximised stream', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    afterEach(() => {
        delete (document as unknown as Record<string, unknown>)['fullscreenElement'];
    });

    function pressEscape(): void {
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    }

    it('returns to the grid on escape', () => {
        const {fixture, layout} = setup([share('a')], {participants: [participant('cam')]});
        layout.maximizedId.set('a');
        fixture.detectChanges();

        pressEscape();
        fixture.detectChanges();

        expect(layout.maximizedId()).toBeNull();
        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:cam']);
    });

    it('leaves escape alone while the browser is closing a real fullscreen', () => {
        const {fixture, layout} = setup([share('a')], {participants: [participant('cam')]});
        layout.maximizedId.set('a');
        fixture.detectChanges();
        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: {}});

        pressEscape();
        fixture.detectChanges();

        expect(layout.maximizedId()).toBe('a');
    });

    it('does nothing on escape when nothing is maximised', () => {
        const {fixture, layout} = setup([share('a')], {participants: [participant('cam')]});

        pressEscape();
        fixture.detectChanges();

        expect(layout.maximizedId()).toBeNull();
        expect(layout.displayedTiles().map(t => t.id)).toEqual(['share:a', 'camera:cam']);
    });
});

describe('CallScreenLayoutComponent invite card (Task 18)', () => {
    /** The card needs a channel scope: a DM call has no ring endpoint behind it. */
    const CHANNEL: WatchScope = {kind: 'channel', guildId: 'g1', channelId: 'chan-1'};

    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('shows the invite card beside a lone tile', () => {
        const {fixture, layout} = setup([], {watchScope: CHANNEL, participants: [participant('solo')]});

        expect(layout.showInviteCard()).toBe(true);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(1);
    });

    it('does not show the card once a second tile exists', () => {
        const {fixture, layout} = setup([], {
            watchScope: CHANNEL,
            participants: [participant('a'), participant('b')],
        });

        expect(layout.showInviteCard()).toBe(false);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(0);
    });

    it('does not show the card on an empty stage', () => {
        const {layout} = setup([], {watchScope: CHANNEL, participants: []});

        expect(layout.showInviteCard()).toBe(false);
    });

    it('does not show the card in a DM call, which has no ring', () => {
        const {fixture, layout} = setup([], {
            watchScope: {kind: 'call', callId: 'call-1'},
            participants: [participant('solo')],
        });

        expect(layout.showInviteCard()).toBe(false);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(0);
    });

    it('does not show the card with no scope at all', () => {
        const {layout} = setup([], {participants: [participant('solo')]});

        expect(layout.showInviteCard()).toBe(false);
    });

    it('re-emits the press with the channel it belongs to', () => {
        const {fixture, layout} = setup([], {watchScope: CHANNEL, participants: [participant('solo')]});
        const seen: {guildId: string; channelId: string}[] = [];
        fixture.componentInstance.inviteRequested.subscribe(e => seen.push(e));

        layout.emitInviteRequest();

        expect(seen).toEqual([{guildId: 'g1', channelId: 'chan-1'}]);
    });

    it('emits nothing off a channel scope', () => {
        const {fixture, layout} = setup([], {
            watchScope: {kind: 'call', callId: 'call-1'},
            participants: [participant('solo')],
        });
        const seen: unknown[] = [];
        fixture.componentInstance.inviteRequested.subscribe(e => seen.push(e));

        layout.emitInviteRequest();

        expect(seen).toEqual([]);
    });

    it('forces two grid columns for the card without changing what gridClass() itself reports', () => {
        const {fixture, layout} = setup([], {watchScope: CHANNEL, participants: [participant('solo')]});

        expect(layout.gridClass()).toBe('grid-cols-1');
        const grid: HTMLElement = fixture.nativeElement.querySelector('.grid');
        expect(grid.className).toContain('grid-cols-2');
        expect(grid.className).not.toContain('grid-cols-1');
    });

    it('never lets the card reach displayedShares() or the watch claim', () => {
        const {layout, setWatching} = setup([], {watchScope: CHANNEL, participants: [participant('solo')]});

        expect(layout.showInviteCard()).toBe(true);
        expect(layout.displayedShares()).toEqual([]);
        expect(lastWatched(setWatching)).toEqual([]);
    });

    it('does not show the card beside a lone share - a 1:1 call, not an empty one', () => {
        const {fixture, layout} = setup([share('a')], {participants: [participant('user-a')]});

        expect(layout.showInviteCard()).toBe(false);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(0);
    });

    it('does not show the card while a share is maximised', () => {
        const {fixture, layout} = setup([share('a'), share('b')], {
            participants: [participant('cam', {isCameraOn: true})],
        });

        layout.maximizedId.set('a');
        fixture.detectChanges();

        expect(layout.displayedTiles().length).toBe(1);
        expect(layout.showInviteCard()).toBe(false);
        expect(fixture.nativeElement.querySelectorAll('app-call-invite-card').length).toBe(0);
    });
});

describe('CallScreenLayoutComponent grid overflow (Task 18 review fix round 1, Important)', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('scrolls a busy share-less stage instead of clipping it silently', () => {
        const many = Array.from({length: 6}, (_, i) => participant(`p-${i}`));
        const {fixture} = setup([], {participants: many});

        const grid: HTMLElement = fixture.nativeElement.querySelector('.grid');
        expect(grid.className).toContain('overflow-y-auto');
        expect(grid.className).toContain('thin-scrollbar');
    });

    it('fits the maximised stream to the stage instead of scrolling it', () => {
        const {fixture, layout} = setup([share('a'), share('b')], {
            participants: [participant('cam', {isCameraOn: true}), participant('other')],
        });

        layout.maximizedId.set('a');
        fixture.detectChanges();

        const grid: HTMLElement = fixture.nativeElement.querySelector('.grid');
        expect(grid.className).toContain('grid-rows-1');
        expect(grid.className).not.toContain('auto-rows-min');
        expect(grid.className).not.toContain('overflow-y-auto');
    });

    it('gives the scrolling grid back when the maximise is released', () => {
        const {fixture, layout} = setup([share('a'), share('b')]);

        layout.maximizedId.set('a');
        fixture.detectChanges();
        layout.maximizedId.set(null);
        fixture.detectChanges();

        const grid: HTMLElement = fixture.nativeElement.querySelector('.grid');
        expect(grid.className).toContain('auto-rows-min');
        expect(grid.className).toContain('overflow-y-auto');
        expect(grid.className).not.toContain('grid-rows-1');
    });
});
