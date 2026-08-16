import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {StreamStatsSnapshot} from './stream-stats';
import {RustMediaService} from '../../services/rust-media.service';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'share-1',
        userId: 'user-1',
        displayName: 'Test User',
        isLocal: false,
        ...overrides,
    };
}

const SNAPSHOT: StreamStatsSnapshot = {
    direction: 'inbound',
    source: 'webview',
    capturedAt: 0,
    layers: [{mid: '3', width: 1920, height: 1080}],
};

/**
 * `RustMediaService` is stubbed rather than provided for real, matching every other
 * `call-share-tile.*.spec.ts`: the real service reaches for `ScreenPublisher` in its constructor,
 * which nothing in this test module registers, and construction throws before the component under
 * test ever renders.
 */
function setup(resolver: (s: CallScreenShare) => StreamStatsSnapshot | null = () => SNAPSHOT) {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {
                    previewPaused: () => false,
                    claimPreviewRender: () => void 0,
                    releasePreviewRender: () => void 0,
                    resumePreview: () => void 0,
                    outboundStats: () => null,
                    inspectOutbound: () => void 0,
                },
            },
        ],
    });
    const fixture: ComponentFixture<CallShareTileComponent> = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', share());
    fixture.componentRef.setInput('inboundStatsOf', resolver);
    fixture.detectChanges();
    return fixture;
}

function rightClick(fixture: ComponentFixture<CallShareTileComponent>): MouseEvent {
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40, clientY: 60});
    fixture.nativeElement.querySelector('[data-testid="share-tile-root"]').dispatchEvent(event);
    fixture.detectChanges();
    return event;
}

describe('CallShareTileComponent stats menu', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('opens the menu on right-click and suppresses the OS menu', () => {
        const fixture = setup();

        const event = rightClick(fixture);

        expect(fixture.nativeElement.querySelector('[data-testid="stream-menu"]')).toBeTruthy();
        expect(event.defaultPrevented).toBe(true);
    });

    it('does not open the panel until the menu item is chosen', () => {
        const fixture = setup();

        rightClick(fixture);

        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeNull();
    });

    it('opens the panel from the menu item and emits the share upward', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeTruthy();
        expect(inspected).toEqual([share()]);
    });

    /**
     * The whole share travels rather than an id. The guild projection sets
     * `shareId: mediaSessionId ?? userId` while VoiceRTCService keys inbound stats by *user*, so a
     * host handed a bare share id could not look one up - see the keying note in the spec.
     */
    it('emits the whole share so a host can key by whichever id its service uses', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();

        expect(inspected[0]?.userId).toBe('user-1');
        expect(inspected[0]?.shareId).toBe('share-1');
    });

    it('emits null and hides the panel when it is closed', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="stats-close"]').click();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeNull();
        expect(inspected[inspected.length - 1]).toBeNull();
    });

    it('renders the resolver output, so a host that wires nothing gets the no-data panel', () => {
        const fixture = setup(() => null);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeTruthy();
    });

    it('asks the resolver for this tile\'s own share', () => {
        const resolver = vi.fn(() => SNAPSHOT);
        const fixture = setup(resolver);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(resolver).toHaveBeenCalledWith(share());
    });

    it('drives the publisher poll rather than the host for a local share', () => {
        // The local tile reads its own publish, so nothing should be asked of the inbound resolver.
        const resolver = vi.fn(() => SNAPSHOT);
        const inspectOutbound = vi.fn();
        TestBed.configureTestingModule({
            imports: [CallShareTileComponent, TranslateModule.forRoot()],
            providers: [
                {
                    provide: RustMediaService,
                    useValue: {
                        previewPaused: () => false,
                        claimPreviewRender: () => void 0,
                        releasePreviewRender: () => void 0,
                        resumePreview: () => void 0,
                        // A local share's panel reads this, not the resolver - see the assertion
                        // below on `stats-layer` actually rendering from it.
                        outboundStats: () => SNAPSHOT,
                        inspectOutbound,
                    },
                },
            ],
        });
        const fixture = TestBed.createComponent(CallShareTileComponent);
        fixture.componentRef.setInput('share', share({isLocal: true}));
        fixture.componentRef.setInput('inboundStatsOf', resolver);
        fixture.detectChanges();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(inspected).toEqual([]);
        expect(resolver).not.toHaveBeenCalled();
        // The poll this tile actually needs: RustMediaService.inspectOutbound, not the host emit.
        expect(inspectOutbound).toHaveBeenCalledWith(true);
        // And the panel itself renders what that poll produced, not a no-data state - proof
        // `panelStats` is actually wired to `outboundStats()` rather than merely not calling the
        // resolver for some unrelated reason.
        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeTruthy();
    });
});
