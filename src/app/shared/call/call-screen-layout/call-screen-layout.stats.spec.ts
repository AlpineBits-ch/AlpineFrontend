import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallScreenShare} from '../call.types';
import {ShareWatchService} from '../../../services/share-watch.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {StreamStatsSnapshot} from '../stream-stats';
import {CallShareTileComponent} from '../call-share-tile/call-share-tile.component';

function share(shareId: string, isLocal = false): CallScreenShare {
    return {
        shareId,
        userId: isLocal ? 'me' : `user-${shareId}`,
        displayName: isLocal ? 'You' : shareId,
        isLocal,
    };
}

const SNAPSHOT: StreamStatsSnapshot = {
    direction: 'inbound',
    source: 'webview',
    capturedAt: 0,
    layers: [{mid: '1', width: 1280, height: 720}],
};

/** A stand-in that never claims - see the sibling specs in this directory for why. */
function fakeRustMedia() {
    return {
        previewPaused: () => false,
        claimPreviewRender: vi.fn(),
        releasePreviewRender: vi.fn(),
        resumePreview: vi.fn(),
    };
}

function setup(
    shares: CallScreenShare[],
    inboundStatsOf?: (s: CallScreenShare) => StreamStatsSnapshot | null,
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
            {provide: RustMediaService, useValue: fakeRustMedia()},
        ],
    });

    const fixture: ComponentFixture<CallScreenLayoutComponent> =
        TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', []);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    if (inboundStatsOf) fixture.componentRef.setInput('inboundStatsOf', inboundStatsOf);
    fixture.detectChanges();

    return {fixture};
}

/** Opens the rendered tile's stats panel the same way a user would - right-click, then the menu item. */
function openStatsPanel(fixture: ComponentFixture<CallScreenLayoutComponent>): void {
    const root = fixture.nativeElement.querySelector('[data-testid="share-tile-root"]');
    root.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
    fixture.detectChanges();
}

/**
 * Covers the one seam the task-6 review flagged as untested: `inboundStatsOf` and `statsInspect` at
 * `call-screen-layout.component.html`, which forward straight through to the child tile with no
 * logic of their own. That is exactly the kind of binding that fails silently - misspell it, drop it
 * in a later edit, or rename the input, and nothing throws. The tile's panel just shows the no-data
 * state forever, which reads identically to "this stream genuinely has no stats yet", the exact
 * confusion this feature exists to remove. Both tests below drive the real DOM path (right-click,
 * then the menu item) rather than reaching into the tile's component instance, so a broken template
 * binding - not just a broken property read - is what makes them fail.
 */
describe('CallScreenLayoutComponent forwards the stats seam', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('reaches the tile: the resolver passed to the layout is what the rendered panel shows', () => {
        const {fixture} = setup([share('a')], () => SNAPSHOT);

        openStatsPanel(fixture);

        const layer = fixture.nativeElement.querySelector('[data-testid="stats-layer"]');
        expect(layer).toBeTruthy();
        expect(fixture.nativeElement.querySelector('[data-testid="row-size"]').textContent).toContain(
            '1280 x 720',
        );
    });

    it('reaches the host: statsInspect re-emits the exact share the tile opened its panel for', () => {
        const {fixture} = setup([share('a')], () => SNAPSHOT);
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        openStatsPanel(fixture);

        expect(inspected).toEqual([share('a')]);
    });

    it('sanity check: the tile actually receives the same function instance the layout was given', () => {
        const resolver = () => SNAPSHOT;
        const {fixture} = setup([share('a')], resolver);

        const tile = fixture.debugElement.query(By.directive(CallShareTileComponent));

        expect(tile.componentInstance.inboundStatsOf()).toBe(resolver);
    });
});
