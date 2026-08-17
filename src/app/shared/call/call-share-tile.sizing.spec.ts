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

function setup(s: CallScreenShare): ComponentFixture<CallShareTileComponent> {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {
                    previewPaused: () => false,
                    claimPreviewRender: vi.fn(),
                    releasePreviewRender: vi.fn(),
                    resumePreview: vi.fn(),
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', s);
    fixture.detectChanges();
    return fixture;
}

/** The tile root - the element that is the grid item, since the host is `display: contents`. */
function root(fixture: ComponentFixture<CallShareTileComponent>): HTMLElement {
    return (fixture.nativeElement as HTMLElement).querySelector('div') as HTMLElement;
}

/**
 * The tile has to carry its own height.
 *
 * <p>The stage grid is `auto-rows-min` (see call-screen-layout.component.html), so a row is only as
 * tall as its tallest tile's intrinsic height - it does not stretch to fill the leftover flex
 * space. Every other thing that lands in that grid states its own box: `app-call-participant-tile`
 * and `app-call-invite-card` are both `aspect-video w-full`. This tile's entire contents - the
 * pan/zoom surface and every overlay - are absolutely positioned, so without the same declaration
 * its intrinsic height is zero and the tile renders as nothing at all. That is exactly what
 * happened: starting a share in a guild voice channel emptied the stage, because the one tile on it
 * was the sharer's own and it collapsed to a 0px row.</p>
 *
 * <p>Asserted on classes rather than a measured box because the test DOM does no layout at all -
 * every element measures 0 there, so a height assertion would pass against the broken tile too.</p>
 */
describe('CallShareTileComponent sizing', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('gives the tile root an intrinsic box, like every other stage tile', () => {
        const el = root(setup(share()));

        expect(el.className).toContain('aspect-video');
        expect(el.className).toContain('w-full');
    });

    it('does so for the local share too - the one that ends up alone on the stage', () => {
        const el = root(setup(share({isLocal: true})));

        expect(el.className).toContain('aspect-video');
    });
});
