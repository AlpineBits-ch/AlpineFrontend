import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {RustMediaService} from '../../services/rust-media.service';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: false,
        ...overrides,
    };
}

function setup(s: CallScreenShare, viewers = 0, viewerNames: string[] = []): ComponentFixture<CallShareTileComponent> {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {previewPaused: () => false, claimPreviewRender: vi.fn(), releasePreviewRender: vi.fn(), resumePreview: vi.fn()},
            },
        ],
    });

    const fixture = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', s);
    fixture.componentRef.setInput('viewers', viewers);
    fixture.componentRef.setInput('viewerNames', viewerNames);
    fixture.detectChanges();
    return fixture;
}

/** The `<i class="pi pi-eye">` wrapper is the one element that only exists when the count shows. */
function viewerCountEl(fixture: ComponentFixture<CallShareTileComponent>): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.pi-eye')?.parentElement ?? null;
}

function viewerPopoverEl(fixture: ComponentFixture<CallShareTileComponent>): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.group\\/viewers > div');
}

describe('CallShareTileComponent viewer count', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('renders nothing at zero viewers, even when names would otherwise be given', () => {
        // The zero-state must not regress: a stream nobody has opened and one whose audience we have
        // not heard about look the same from here, and the popover is only ever an enhancement to a
        // count that is already showing - never a reason to start showing one at zero.
        const fixture = setup(share(), 0, ['Alice']);

        expect(viewerCountEl(fixture)).toBeNull();
    });

    it('shows the plain count tooltip when there are no resolved names yet', () => {
        const fixture = setup(share(), 3, []);

        const el = viewerCountEl(fixture) as HTMLElement;
        expect(el).not.toBeNull();
        expect(el.getAttribute('title')).toBe('CALL.WATCHING');
        expect(viewerPopoverEl(fixture)).toBeNull();
    });

    it('replaces the tooltip with a names popover once names are given', () => {
        const fixture = setup(share(), 2, ['Alice', 'Bob']);

        const el = viewerCountEl(fixture) as HTMLElement;
        expect(el.getAttribute('title')).toBeNull();

        const popover = viewerPopoverEl(fixture) as HTMLElement;
        expect(popover).not.toBeNull();
        expect(popover.textContent).toContain('Alice');
        expect(popover.textContent).toContain('Bob');
    });

    it('does not maximise the tile on a double-click over the viewer count', () => {
        // The viewer count sits in the top-left guarded region alongside the action cluster - see
        // call-share-tile.dblclick.spec.ts for the rest of that suite.
        const fixture = setup(share(), 2, ['Alice']);
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        (viewerCountEl(fixture) as HTMLElement).dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));

        expect(emitted).not.toHaveBeenCalled();
    });
});

describe('CallShareTileComponent inbound fps', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('renders nothing for a remote share while inboundFps has not arrived yet', () => {
        const fixture = setup(share({inboundFps: null}));

        expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('CALL.FPS_IN');
    });

    it('renders the fps-in readout once a remote share reports one', () => {
        const fixture = setup(share({inboundFps: 24}));

        expect((fixture.nativeElement as HTMLElement).textContent).toContain('CALL.FPS_IN');
    });

    it('never renders fps-in for the local share, even if inboundFps is somehow set', () => {
        const fixture = setup(share({isLocal: true, inboundFps: 24}));

        expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('CALL.FPS_IN');
    });
});
