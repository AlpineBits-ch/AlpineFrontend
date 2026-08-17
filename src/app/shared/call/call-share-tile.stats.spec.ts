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

/** `RustMediaService` is stubbed: the real service reaches for `ScreenPublisher` and throws here. */
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

    it("asks the resolver for this tile's own share", () => {
        const resolver = vi.fn(() => SNAPSHOT);
        const fixture = setup(resolver);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(resolver).toHaveBeenCalledWith(share());
    });

    it('drives the publisher poll rather than the host for a local share', () => {
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
                        // A local share's panel reads this, not the resolver.
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
        expect(inspectOutbound).toHaveBeenCalledWith(true);
        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeTruthy();
    });
});

/** Fake timers throughout: `whenStable()` would drain the confirmation dwell before it can be asserted on. */
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

    it('starts the inspection and waits for a snapshot when the panel was never opened', async () => {
        const written: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text: string) => (written.push(text), Promise.resolve())},
        });
        const inspected = signal<CallScreenShare | null>(null);
        const fixture = setup(s => (inspected() && inspected()!.shareId === s.shareId ? SNAPSHOT : null));
        fixture.componentInstance.statsInspect.subscribe(s => inspected.set(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();

        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0])).toMatchObject({direction: 'inbound'});
    });

    it('closes the inspection it started once the copy is done', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: () => Promise.resolve()},
        });
        const inspected = signal<CallScreenShare | null>(null);
        const emitted: (CallScreenShare | null)[] = [];
        const fixture = setup(s => (inspected() && inspected()!.shareId === s.shareId ? SNAPSHOT : null));
        fixture.componentInstance.statsInspect.subscribe(s => {
            emitted.push(s);
            inspected.set(s);
        });

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await settle();

        expect(emitted).toEqual([share(), null]);
    });

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
