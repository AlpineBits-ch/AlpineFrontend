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

/** `rustMedia` overrides the stub member by member - only `previewPaused` is ever worth varying. */
function setup(s: CallScreenShare = share(), rustMedia: Record<string, unknown> = {}) {
    const resumePreview = vi.fn();
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {
                    previewPaused: () => false,
                    claimPreviewRender: vi.fn(),
                    releasePreviewRender: vi.fn(),
                    resumePreview,
                    ...rustMedia,
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', s);
    fixture.detectChanges();

    const maximize = vi.fn();
    fixture.componentInstance.maximizeToggle.subscribe(maximize);
    return {fixture, maximize, resumePreview};
}

/** The host is `display: contents`, so its first rendered child is the tile root. */
function tileRoot(fixture: ComponentFixture<CallShareTileComponent>): HTMLElement {
    return (fixture.nativeElement as HTMLElement).firstElementChild as HTMLElement;
}

/** The pan/zoom surface: the picture, and the only part of the tile a press is meant to open. */
function surface(fixture: ComponentFixture<CallShareTileComponent>): HTMLElement {
    return tileRoot(fixture).firstElementChild as HTMLElement;
}

/** The deepest thing inside the picture, so a click has real bubbling to do on its way out. */
function picture(fixture: ComponentFixture<CallShareTileComponent>): Element {
    return surface(fixture).querySelector('.pi') ?? surface(fixture);
}

function control(fixture: ComponentFixture<CallShareTileComponent>, label: string): Element {
    return (fixture.nativeElement as HTMLElement).querySelector(`[aria-label="${label}"]`)!;
}

function click(el: Element): void {
    el.dispatchEvent(new MouseEvent('click', {bubbles: true}));
}

/**
 * Click-to-open.
 *
 * <p>A stream is one tile among the seats now (see `CallScreenLayoutComponent.participantTiles`), so
 * it needs a way to become the thing you are actually watching. One press on the picture does that.
 * This replaced a double-click binding on the tile root: with a single click toggling, a double
 * click would have toggled twice and landed back where it started.</p>
 *
 * <p>The handler sits on the picture rather than the tile root, which is what keeps every control
 * off it - the overlays are siblings of the picture, not children, so a press on one has no path to
 * the maximise handler at all. That is a structural guarantee rather than a list of
 * `stopPropagation` calls that has to be kept in step with the markup, and the tests below are what
 * pin it.</p>
 */
describe('CallShareTileComponent click to maximise', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither play() nor pause(); an unhandled "not implemented" would fail the
        // run before the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('maximises on a click on the picture', () => {
        const {fixture, maximize} = setup();

        click(picture(fixture));

        expect(maximize).toHaveBeenCalledTimes(1);
    });

    it('does not maximise on a click on the zoom controls', () => {
        const {fixture, maximize} = setup();

        click(control(fixture, 'CALL.ZOOM_IN'));
        click(control(fixture, 'CALL.ZOOM_OUT'));

        expect(maximize).not.toHaveBeenCalled();
    });

    it('does not maximise on a click on the stream-audio toggle', () => {
        // A remote share always renders it - see the `!s.isLocal || s.hasAudio` guard in the
        // template. Muting somebody's stream and opening it are different intentions.
        const {fixture, maximize} = setup();
        const audioToggle = vi.fn();
        fixture.componentInstance.audioToggle.subscribe(audioToggle);

        click(control(fixture, 'CALL.MUTE_STREAM_AUDIO'));

        expect(audioToggle).toHaveBeenCalledTimes(1);
        expect(maximize).not.toHaveBeenCalled();
    });

    it('maximises exactly once when the maximise action itself is pressed', () => {
        // The button emits it directly. If the press also reached the picture's handler, one press
        // would toggle twice and visibly do nothing.
        const {fixture, maximize} = setup();

        click(control(fixture, 'CALL.HIDE_OTHER_STREAMS'));

        expect(maximize).toHaveBeenCalledTimes(1);
    });

    it('does not maximise on a click on the hide action', () => {
        const {fixture, maximize} = setup();
        const hide = vi.fn();
        fixture.componentInstance.hide.subscribe(hide);

        click(control(fixture, 'CALL.STOP_WATCHING'));

        expect(hide).toHaveBeenCalledTimes(1);
        expect(maximize).not.toHaveBeenCalled();
    });

    it('does not maximise on the click that ends a pan drag', () => {
        // A browser fires click on mouseup, so dragging a zoomed-in picture around would otherwise
        // maximise the tile every time you let go of it.
        const {fixture, maximize} = setup();
        click(control(fixture, 'CALL.ZOOM_IN'));
        fixture.detectChanges();

        const el = surface(fixture);
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 100, clientY: 100}));
        el.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 160, clientY: 130}));
        el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 160, clientY: 130}));
        click(el);

        expect(maximize).not.toHaveBeenCalled();
    });

    it('still maximises on the next click after a drag', () => {
        // The drag guard is spent by the click it suppresses; a press that follows is a press.
        const {fixture, maximize} = setup();
        click(control(fixture, 'CALL.ZOOM_IN'));
        fixture.detectChanges();

        const el = surface(fixture);
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 100, clientY: 100}));
        el.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 160, clientY: 130}));
        el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 160, clientY: 130}));
        click(el);
        click(el);

        expect(maximize).toHaveBeenCalledTimes(1);
    });

    it('maximises on a press that held still, drag armed or not', () => {
        // mousedown/mouseup with no movement between them is a click, not a drag.
        const {fixture, maximize} = setup();
        click(control(fixture, 'CALL.ZOOM_IN'));
        fixture.detectChanges();

        const el = surface(fixture);
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 100, clientY: 100}));
        el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 100, clientY: 100}));
        click(el);

        expect(maximize).toHaveBeenCalledTimes(1);
    });

    it('resumes the paused preview instead of maximising', () => {
        // "Any interaction with the paused preview resumes it" - maximising a frozen frame is not
        // what the press was asking for.
        const {fixture, maximize, resumePreview} = setup(
            share({isLocal: true, previewSrc: 'data:image/png;base64,x'}),
            {previewPaused: () => true},
        );

        // The paused card has no aria-label of its own - its pause glyph is what identifies it, and
        // clicking that is the "any interaction" the copy promises.
        click(surface(fixture).querySelector('.pi-pause-circle')!);

        expect(resumePreview).toHaveBeenCalledTimes(1);
        expect(maximize).not.toHaveBeenCalled();
    });
});
