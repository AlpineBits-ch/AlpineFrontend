import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: false,
        ...overrides,
    };
}

function setup(): ComponentFixture<CallShareTileComponent> {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
    });

    const fixture = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', share());
    fixture.detectChanges();
    return fixture;
}

/** Fires a real, bubbling dblclick so delegation up to the tile root behaves as it would in a
 *  browser - dispatching straight on the root would skip the propagation this suite exists to
 *  check. */
function doubleClick(el: Element): void {
    el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
}

describe('CallShareTileComponent double-click focus', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither play() nor pause(); an unhandled "not implemented" would fail the
        // run before the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('emits maximizeToggle on a double-click anywhere on the tile', () => {
        const fixture = setup();
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        // The host's own class is 'contents' (see the component's `host` metadata), so its first
        // rendered child is the #root div the (dblclick) binding lives on.
        const root = (fixture.nativeElement as HTMLElement).firstElementChild as HTMLElement;
        doubleClick(root);

        expect(emitted).toHaveBeenCalledTimes(1);
    });

    it('does not maximize on a double-click on the zoom-in button', () => {
        const fixture = setup();
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        const zoomIn = (fixture.nativeElement as HTMLElement)
            .querySelector('[aria-label="CALL.ZOOM_IN"]')!;
        doubleClick(zoomIn);

        expect(emitted).not.toHaveBeenCalled();
    });

    it('does not maximize on a double-click on the zoom-out button', () => {
        const fixture = setup();
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        const zoomOut = (fixture.nativeElement as HTMLElement)
            .querySelector('[aria-label="CALL.ZOOM_OUT"]')!;
        doubleClick(zoomOut);

        expect(emitted).not.toHaveBeenCalled();
    });

    it('does not maximize on a double-click on the audio toggle', () => {
        // A remote share (isLocal: false, the setup() default) always renders the audio toggle -
        // see the `!s.isLocal || s.hasAudio` guard in the template.
        const fixture = setup();
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        // aria-label is set via [attr.aria-label], which - unlike a plain [label] property binding
        // - lands as a real DOM attribute, so it is the one dynamic value on this element a
        // querySelector can actually see.
        const audioToggle = (fixture.nativeElement as HTMLElement)
            .querySelector('[aria-label="CALL.MUTE_STREAM_AUDIO"]')!;
        doubleClick(audioToggle);

        expect(emitted).not.toHaveBeenCalled();
    });

    it('does not maximize on a double-click on the maximise action itself', () => {
        const fixture = setup();
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        // The button this suite most cares about: it already toggles maximise on a single click, so
        // a double-click here bubbling up to the root's own dblclick binding would be a second,
        // redundant maximize-toggle path firing off the same gesture.
        const maximizeButton = (fixture.nativeElement as HTMLElement)
            .querySelector('[aria-label="CALL.HIDE_OTHER_STREAMS"]')!;
        doubleClick(maximizeButton);

        expect(emitted).not.toHaveBeenCalled();
    });

    it('does not maximize on a double-click on the hide action', () => {
        // The newest member of the top-left guarded cluster - same requirement as its neighbours
        // above: reading its name must not also toggle maximise.
        const fixture = setup();
        const emitted = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(emitted);

        const hideButton = (fixture.nativeElement as HTMLElement)
            .querySelector('[aria-label="CALL.STOP_WATCHING"]')!;
        doubleClick(hideButton);

        expect(emitted).not.toHaveBeenCalled();
    });
});
