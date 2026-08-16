import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {signal} from '@angular/core';
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

/**
 * Fake timers throughout, and not for speed.
 *
 * <p>Copying now owns two timers: the wait for a first snapshot when the panel was never opened,
 * and the dwell on the confirmation the tile shows afterwards. `fixture.whenStable()` waits for
 * both to drain, which means every assertion about the confirmation would run <em>after</em> it had
 * already cleared itself - a test that can only ever see null. Driving the clock is what puts the
 * assertion inside the window being asserted on.</p>
 */
describe('CallShareTileComponent copy raw stats', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        vi.useFakeTimers();
    });

    afterEach(() => vi.useRealTimers());

    /** Let the copy's wait and the promise plumbing behind it run to completion. */
    const settle = () => vi.advanceTimersByTimeAsync(2_400);

    it('writes the snapshot to the clipboard as JSON', async () => {
        const written: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text: string) => (written.push(text), Promise.resolve())},
        });
        const fixture = setup();

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();

        expect(JSON.parse(written[0])).toMatchObject({direction: 'inbound', source: 'webview'});
    });

    it('closes the menu after copying', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: () => Promise.resolve()},
        });
        const fixture = setup();

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stream-menu"]')).toBeNull();
    });

    it('copies nothing rather than the word null when there is no snapshot', async () => {
        const written: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text: string) => (written.push(text), Promise.resolve())},
        });
        const fixture = setup(() => null);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();

        expect(written).toEqual([]);
    });

    /**
     * The primary path for this menu item, and the one that was a silent no-op: right-click, copy,
     * paste into a bug report, without ever opening the panel. Nothing polls a stream nobody is
     * inspecting, so the snapshot signal is null at the moment of the press - the copy has to start
     * the poll itself and wait for the first snapshot to land.
     */
    it('starts the inspection and waits for a snapshot when the panel was never opened', async () => {
        const written: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text: string) => (written.push(text), Promise.resolve())},
        });
        // Exactly what a real host does: nothing to report until something asks for an inspection.
        const inspected = signal<CallScreenShare | null>(null);
        const fixture = setup(s => inspected() && inspected()!.shareId === s.shareId ? SNAPSHOT : null);
        fixture.componentInstance.statsInspect.subscribe(s => inspected.set(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();

        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0])).toMatchObject({direction: 'inbound'});
    });

    /**
     * And it puts the poll back. A copy is a one-shot read, not a subscription: leaving the
     * inspection running would pin the RTC service's stats poll at its 1s diagnostics cadence with
     * no panel on screen to justify it.
     */
    it('closes the inspection it started once the copy is done', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: () => Promise.resolve()},
        });
        const inspected = signal<CallScreenShare | null>(null);
        const emitted: (CallScreenShare | null)[] = [];
        const fixture = setup(s => inspected() && inspected()!.shareId === s.shareId ? SNAPSHOT : null);
        fixture.componentInstance.statsInspect.subscribe(s => {
            emitted.push(s);
            inspected.set(s);
        });

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();

        expect(emitted).toEqual([share(), null]);
    });

    /**
     * A menu item that appears to do nothing reads as a broken build. When no snapshot can be had -
     * a stream with nothing to report, or a host that wired no resolver - the tile has to say so.
     */
    it('says so on the tile when no snapshot can be obtained', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: () => Promise.resolve()},
        });
        const fixture = setup(() => null);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();
        fixture.detectChanges();

        const notice = fixture.nativeElement.querySelector('[data-testid="stats-copy-notice"]');
        expect(notice).toBeTruthy();
        expect(notice.textContent).toContain('CALL.STATS_NERD.COPY_FAILED');
    });

    it('confirms a copy that worked', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: () => Promise.resolve()},
        });
        const fixture = setup();

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();
        fixture.detectChanges();

        const notice = fixture.nativeElement.querySelector('[data-testid="stats-copy-notice"]');
        expect(notice.textContent).toContain('CALL.STATS_NERD.COPIED');
    });
});

/**
 * A tile can be destroyed with its panel still open - the sharer stops, the layout drops the tile,
 * the user navigates away - and nothing else will ever close the inspection it left behind. Both
 * services holding the other end are `providedIn: 'root'`, so what leaks is not one stale signal
 * but a `getStats()` poll running at double rate for the rest of the session, into the next call
 * as well as this one.
 */
describe('CallShareTileComponent teardown with the panel open', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('emits null so the host stops the detailed poll', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();
        expect(inspected).toEqual([share()]);

        fixture.destroy();

        expect(inspected).toEqual([share(), null]);
    });

    it('stops the publisher poll for a local tile', () => {
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
                        outboundStats: () => SNAPSHOT,
                        inspectOutbound,
                    },
                },
            ],
        });
        const fixture = TestBed.createComponent(CallShareTileComponent);
        fixture.componentRef.setInput('share', share({isLocal: true}));
        fixture.detectChanges();

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();
        expect(inspectOutbound).toHaveBeenLastCalledWith(true);

        fixture.destroy();

        expect(inspectOutbound).toHaveBeenLastCalledWith(false);
    });

    /** Idempotent: a tile destroyed with no panel open must not announce a close nobody asked for. */
    it('announces nothing when there was no inspection to close', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        fixture.destroy();

        expect(inspected).toEqual([]);
    });
});
