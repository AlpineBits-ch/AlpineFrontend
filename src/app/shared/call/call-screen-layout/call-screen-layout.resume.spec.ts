import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallParticipant, CallScreenShare} from '../call.types';
import {ShareWatchService, WatchScope} from '../../../services/share-watch.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {ProfileService} from '../../../services/profile.service';

/**
 * The stage must survive a share id changing underneath it.
 *
 * <p><b>The failure this pins.</b> A share id belongs to a publication, not to a person: a sharer
 * switching source, a publication that died on a run of failed writes, or a browser publish
 * renegotiating all end one track and open another under a fresh id seconds later. `displayedShares`
 * filtered on `maximizedId` and returned an empty array when nothing matched, and `displayedTiles`
 * is shares-only while maximised - so the viewer's entire stage went blank, not just the one tile.
 * That is the worst symptom of the whole class of bug, because there is nothing left on screen to
 * explain it.</p>
 *
 * <p>What the viewer chose when they maximised was a person's stream. Following the person is the
 * only reading of that press that still makes sense after the id moves.</p>
 */

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

type ProtectedSurface = {
    displayedShares: () => CallScreenShare[];
    displayedTiles: () => unknown[];
    gridClass: () => string;
    showInviteCard: () => boolean;
    maximizedId: {(): string | null; set: (id: string | null) => void};
};

const scope: WatchScope = {kind: 'call', callId: 'call-1'};
/** The invite card is a guild-channel idea and renders nowhere else - see `showInviteCard`. */
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
            // Both are reached only once a participant seat renders: the seat draws an avatar, and
            // `app-call-invite-card` sits beside it. Same shape as the sibling tile spec's stub.
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

    const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
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
    /**
     * Maximise, and let the component settle before the caller changes anything.
     *
     * <p>The settle is load-bearing rather than tidiness: whose stream is maximised is recorded by
     * an effect, and an effect that has not run yet has recorded nothing to follow.</p>
     */
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
        // The reported symptom, asserted directly: not "the right tile" but "any tile at all".
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('new', 'anna')]);

        expect(layout.displayedTiles().length).toBeGreaterThan(0);
    });

    it('re-points the maximise itself, not just what is drawn', () => {
        // Everything else keyed on the id - the tile's own `maximized` binding, the toolbar toggle,
        // the watch claim - would otherwise stay pointed at a share that no longer exists.
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('new', 'anna')]);

        expect(layout.maximizedId()).toBe('new');
    });

    it('does not follow a different person', () => {
        // Maximise means "show me this person's stream". Adopting somebody else's would put a
        // viewer in front of a stream they never chose. Anna's stream ending drops back to the
        // grid instead, where bruno's is one tile among the rest rather than the whole stage.
        const {layout, setShares, maximize} = setup([share('old', 'anna')]);
        maximize('old');

        setShares([share('other', 'bruno')]);

        expect(layout.maximizedId()).toBeNull();
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['other']);
    });

    it('returns to the grid when the maximised share ends with nothing to follow', () => {
        // The reported bug, and the one that hurts most on your own stream: stopping it left
        // `maximizedId` on a share that no longer exists, and maximised mode draws shares only -
        // so the picture went and took every other tile with it. Escape was the only way back.
        const {layout, setShares, maximize} = setup([share('mine', 'anna')], [participant('bruno')]);
        maximize('mine');

        setShares([]);

        expect(layout.maximizedId()).toBeNull();
        // Not merely "unmaximised" - the people still in the channel are on screen again.
        expect(layout.displayedTiles().length).toBeGreaterThan(0);
    });

    it('holds the maximise while that share is only resuming', () => {
        // The release above must not undo the grace window: a share between tracks is still in
        // `screenShares`, so the viewer keeps watching rather than being dropped to the grid and
        // pulled back a second later.
        const {layout, setShares, maximize} = setup([share('a', 'anna')]);
        maximize('a');

        setShares([share('a', 'anna', 'resuming')]);

        expect(layout.maximizedId()).toBe('a');
    });

    it('holds the grid still while a share is resuming', () => {
        // The reflow is most of the damage. A resuming share stays in the pool, so the column count
        // cannot move and the tile keeps its slot and its size.
        const {layout, setShares} = setup([share('a', 'anna'), share('b', 'bruno')]);
        const before = layout.gridClass();

        setShares([share('a', 'anna', 'resuming'), share('b', 'bruno')]);

        expect(layout.gridClass()).toBe(before);
        expect(layout.displayedShares().length).toBe(2);
    });

    it('does not offer the invite card over a resuming stream', () => {
        // The single worst frame of the old behaviour: an invite card appearing where somebody's
        // stream had been, which reads as the channel having emptied out. A channel scope, because
        // that is the only place the card renders at all - on a call scope this would pass without
        // proving anything.
        const {layout, setShares} = setup([share('a', 'anna')], [participant('anna')], channelScope);

        setShares([share('a', 'anna', 'resuming')]);

        expect(layout.showInviteCard()).toBe(false);
        // And for the right reason. `showInviteCard` is gated on a share-less stage holding one
        // tile, which is exactly the shape this stage would have had if the resuming share had been
        // dropped - so the share still being in the pool is the whole of what keeps the card away.
        // Asserted rather than rendered: putting the card on screen pulls ProfileService and the
        // whole auth chain into a spec about layout.
        expect(layout.displayedShares().length).toBe(1);
        expect(layout.displayedTiles().length).toBe(2);
    });
});
