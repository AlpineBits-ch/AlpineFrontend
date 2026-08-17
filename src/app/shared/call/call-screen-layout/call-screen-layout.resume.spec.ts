import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallParticipant, CallScreenShare} from '../call.types';
import {ShareWatchService, WatchScope} from '../../../services/share-watch.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {ProfileService} from '../../../services/profile.service';

/** The stage must survive a share id changing underneath it. */

function share(shareId: string, userId: string, state?: 'live' | 'resuming'): CallScreenShare {
    return {shareId, userId, displayName: userId, isLocal: false, state};
}

function participant(userId: string): CallParticipant {
    return {
        userId,
        displayName: userId,
        avatarLabel: userId[0]!.toUpperCase(),
        isLocal: false,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
    };
}

interface ProtectedSurface {
    displayedShares: () => CallScreenShare[];
    displayedTiles: () => unknown[];
    gridClass: () => string;
    showInviteCard: () => boolean;
    maximizedId: {(): string | null; set: (id: string | null) => void};
}

const scope: WatchScope = {kind: 'call', callId: 'call-1'};
/** The invite card is a guild-channel idea and renders nowhere else. */
const channelScope: WatchScope = {kind: 'channel', guildId: 'g1', channelId: 'c1'};

function setup(
    shares: CallScreenShare[],
    participants: CallParticipant[] = [],
    watchScope: WatchScope = scope,
) {
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
            {
                provide: RustMediaService,
                useValue: {
                    previewPaused: () => false,
                    claimPreviewRender: vi.fn(),
                    releasePreviewRender: vi.fn(),
                    resumePreview: vi.fn(),
                },
            },
            // Both are reached only once a participant seat renders.
            {
                provide: ProfileService,
                useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => undefined},
            },
            {
                provide: OsInfo,
                useValue: {
                    kind: 'windows',
                    isMobile: false,
                    appName: async () => 'Alpine',
                    appVersion: async () => '0.0.0',
                },
            },
        ],
    });

    const fixture: ComponentFixture<CallScreenLayoutComponent> =
        TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', participants);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    fixture.componentRef.setInput('watchScope', watchScope);
    fixture.detectChanges();

    const layout = fixture.componentInstance as unknown as ProtectedSurface;
    const setShares = (next: CallScreenShare[]) => {
        fixture.componentRef.setInput('screenShares', next);
        fixture.detectChanges();
    };
    /** Maximise, then settle: the owner is recorded by an effect that must run before anything changes. */
    const maximize = (shareId: string) => {
        layout.maximizedId.set(shareId);
        fixture.detectChanges();
    };
    return {fixture, layout, setShares, maximize};
}

describe('CallScreenLayoutComponent across a share being replaced', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('follows the same person when the maximised share changes id', () => {
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('new', 'anna')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['new']);
    });

    it('never leaves the stage empty while that person is still sharing', () => {
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('new', 'anna')]);

        expect(layout.displayedTiles().length).toBeGreaterThan(0);
    });

    it('re-points the maximise itself, not just what is drawn', () => {
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('new', 'anna')]);

        expect(layout.maximizedId()).toBe('new');
    });

    it('does not follow a different person', () => {
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('other', 'bruno')]);

        expect(layout.maximizedId()).toBeNull();
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['other']);
    });

    it('returns to the grid when the maximised share ends with nothing to follow', () => {
        const {layout, setShares, maximize} = setup([share('mine', 'anna')], [participant('bruno')]);
        maximize('mine');

        setShares([]);

        expect(layout.maximizedId()).toBeNull();
        expect(layout.displayedTiles().length).toBeGreaterThan(0);
    });

    it('holds the maximise while that share is only resuming', () => {
        const {layout, setShares, maximize} = setup([share('a', 'anna')]);
        maximize('a');

        setShares([share('a', 'anna', 'resuming')]);

        expect(layout.maximizedId()).toBe('a');
    });

    it('holds the grid still while a share is resuming', () => {
        const {layout, setShares} = setup([share('a', 'anna'), share('b', 'bruno')]);
        const before = layout.gridClass();

        setShares([share('a', 'anna', 'resuming'), share('b', 'bruno')]);

        expect(layout.gridClass()).toBe(before);
        expect(layout.displayedShares().length).toBe(2);
    });

    it('does not offer the invite card over a resuming stream', () => {
        // A channel scope, because that is the only place the card renders at all.
        const {layout, setShares} = setup([share('a', 'anna')], [participant('anna')], channelScope);

        setShares([share('a', 'anna', 'resuming')]);

        expect(layout.showInviteCard()).toBe(false);
        expect(layout.displayedShares().length).toBe(1);
        expect(layout.displayedTiles().length).toBe(2);
    });
});
