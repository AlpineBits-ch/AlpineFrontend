import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {RustMediaService} from '../../services/rust-media.service';
import {ACTIVATION_CLICK_MS} from './activation-click';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: false,
        ...overrides,
    };
}

/** `rustMedia` overrides the stub member by member. */
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

/** The pan/zoom surface: the only part of the tile a press is meant to open. */
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

describe('CallShareTileComponent click to maximise', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither play() nor pause().
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
        const {fixture, maximize} = setup();
        const audioToggle = vi.fn();
        fixture.componentInstance.audioToggle.subscribe(audioToggle);

        click(control(fixture, 'CALL.MUTE_STREAM_AUDIO'));

        expect(audioToggle).toHaveBeenCalledTimes(1);
        expect(maximize).not.toHaveBeenCalled();
    });

    it('maximises exactly once when the maximise action itself is pressed', () => {
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
        const {fixture, maximize} = setup();
        click(control(fixture, 'CALL.ZOOM_IN'));
        fixture.detectChanges();

        const el = surface(fixture);
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 100, clientY: 100}));
        el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 100, clientY: 100}));
        click(el);

        expect(maximize).toHaveBeenCalledTimes(1);
    });

    it('ignores the click that brought the window back to the front', () => {
        vi.useFakeTimers();
        try {
            const {fixture, maximize} = setup();

            window.dispatchEvent(new Event('focus'));
            click(picture(fixture));

            expect(maximize).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('takes clicks again once the window has been focused for a moment', () => {
        vi.useFakeTimers();
        try {
            const {fixture, maximize} = setup();
            window.dispatchEvent(new Event('focus'));

            vi.advanceTimersByTime(ACTIVATION_CLICK_MS);
            click(picture(fixture));

            expect(maximize).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resumes the paused preview instead of maximising', () => {
        const {fixture, maximize, resumePreview} = setup(
            // `localRender` is what the pause keys off, not `previewSrc`.
            share({isLocal: true, previewSrc: 'data:image/png;base64,x', localRender: true}),
            {previewPaused: () => true},
        );

        // The paused card has no aria-label of its own; its pause glyph is what identifies it.
        click(surface(fixture).querySelector('.pi-pause-circle')!);

        expect(resumePreview).toHaveBeenCalledTimes(1);
        expect(maximize).not.toHaveBeenCalled();
    });
});
