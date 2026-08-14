import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallScreenShare} from '../call.types';
import {ShareWatchService, WatchScope} from '../../../services/share-watch.service';
import {RustMediaService} from '../../../services/rust-media.service';

function share(shareId: string, isLocal = false): CallScreenShare {
    return {
        shareId,
        userId: isLocal ? 'me' : `user-${shareId}`,
        displayName: isLocal ? 'You' : shareId,
        isLocal,
    };
}

type ProtectedSurface = {
    displayedShares: () => CallScreenShare[];
    hiddenShares: () => CallScreenShare[];
    maximizedId: {(): string | null; set: (id: string | null) => void};
    hideShare: (shareId: string) => void;
    showShare: (shareId: string) => void;
};

/**
 * Builds the layout against a stubbed ShareWatchService whose `setWatching` calls are inspectable -
 * the whole point of this suite is proving the watch claim actually shrinks, not just that a tile
 * stopped rendering. Reaching into `protected` members mirrors the sibling specs in this directory:
 * the alternative is asserting on tile counts in rendered markup.
 */
function setup(shares: CallScreenShare[], scope: WatchScope, setWatching = vi.fn()) {
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
                    viewersOf: () => [],
                },
            },
            {
                provide: RustMediaService,
                useValue: {previewPaused: () => false, claimPreviewRender: vi.fn(), releasePreviewRender: vi.fn(), resumePreview: vi.fn()},
            },
        ],
    });

    const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', []);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    fixture.componentRef.setInput('watchScope', scope);
    fixture.detectChanges();

    return {fixture, layout: fixture.componentInstance as unknown as ProtectedSurface};
}

/** The shareIds most recently handed to setWatching, or undefined if it was never called. */
function lastWatched(setWatching: ReturnType<typeof vi.fn>): string[] | undefined {
    const call = setWatching.mock.calls.at(-1) as [WatchScope, readonly string[]] | undefined;
    return call ? [...call[1]] : undefined;
}

describe('CallScreenLayoutComponent hiding a share', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};

    beforeEach(() => TestBed.resetTestingModule());

    it('removes a hidden share from the displayed set', () => {
        const {layout} = setup([share('a'), share('b')], scope);

        layout.hideShare('a');

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['b']);
    });

    it('shrinks the watch claim when a share is hidden, not just what renders', () => {
        // Watching is inferred from displayedShares by an effect elsewhere in the component - see
        // its constructor. Asserting on setWatching's own arguments, rather than on displayedShares
        // again, is what actually proves the two stayed coupled after this change.
        const setWatching = vi.fn();
        const {fixture, layout} = setup([share('a'), share('b')], scope, setWatching);
        expect(lastWatched(setWatching)).toEqual(['a', 'b']);

        layout.hideShare('a');
        // hideShare only writes the hiddenIds signal - the watch-claim effect that reads it through
        // displayedShares is flushed on the next change-detection pass, not synchronously on write.
        fixture.detectChanges();

        expect(lastWatched(setWatching)).toEqual(['b']);
    });

    it('leaves the remote grid and the claim untouched if something hides the local share by id', () => {
        // The tile gates the hide control to remote shares (see call-share-tile.component.html), so
        // this path is not reachable from the UI - but hiddenIds is keyed by shareId with nothing
        // stopping a local id from landing in it some other way, and the local share was never in
        // the claim to begin with (the effect filters !isLocal before calling setWatching). Pinning
        // this is pinning that such a call would be a harmless no-op, not a silent grid change.
        const setWatching = vi.fn();
        const {fixture, layout} = setup([share('mine', true), share('a'), share('b')], scope, setWatching);
        expect(lastWatched(setWatching)).toEqual(['a', 'b']);

        layout.hideShare('mine');
        fixture.detectChanges();

        // The local share was never part of the grid here - two remote shares already crowd it out
        // (see displayedShares' own doc comment) - so there was nothing for hiding it to change.
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
        expect(lastWatched(setWatching)).toEqual(['a', 'b']);
    });

    it('falls back to the grid rather than an empty layout when the maximised share is hidden', () => {
        const {layout} = setup([share('a'), share('b'), share('c')], scope);
        layout.maximizedId.set('a');
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a']);

        layout.hideShare('a');

        // Unmaximised, and 'a' dropped - 'b' and 'c' are "the rest" this fallback exists to show.
        expect(layout.maximizedId()).toBeNull();
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['b', 'c']);
    });

    it('restores a hidden share back into the displayed set', () => {
        const {layout} = setup([share('a'), share('b')], scope);
        layout.hideShare('a');

        layout.showShare('a');

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
    });

    it('lists only the still-live hidden shares, for the restore row', () => {
        const {layout} = setup([share('a'), share('b'), share('c')], scope);

        layout.hideShare('a');
        layout.hideShare('c');

        expect(layout.hiddenShares().map(s => s.shareId)).toEqual(['a', 'c']);
    });
});

describe('CallScreenLayoutComponent hidden shares that come and go', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};

    beforeEach(() => TestBed.resetTestingModule());

    it('drops the restore chip the moment a hidden share ends, rather than leaving it dangling', () => {
        const {fixture, layout} = setup([share('a'), share('b')], scope);
        layout.hideShare('a');
        expect(layout.hiddenShares().map(s => s.shareId)).toEqual(['a']);

        // The share ends - it stops appearing in screenShares entirely, same as any other stream
        // that stops being shared.
        fixture.componentRef.setInput('screenShares', [share('b')]);
        fixture.detectChanges();

        expect(layout.hiddenShares()).toEqual([]);
    });

    it('is visible again automatically if a hidden share stops and restarts under the same id', () => {
        const {fixture, layout} = setup([share('a'), share('b')], scope);
        layout.hideShare('a');
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['b']);

        // Gone, then the same slot shares again under the same shareId.
        fixture.componentRef.setInput('screenShares', [share('b')]);
        fixture.detectChanges();
        fixture.componentRef.setInput('screenShares', [share('a'), share('b')]);
        fixture.detectChanges();

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
        expect(layout.hiddenShares()).toEqual([]);
    });
});
