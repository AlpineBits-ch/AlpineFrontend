import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {RustMediaService} from '../../services/rust-media.service';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: true,
        ...overrides,
    };
}

/**
 * Stubs the two browser feature checks pip-support.ts reads. jsdom implements neither API, so both
 * flags are absent by default; defined here rather than through vi.spyOn on the module because
 * pip-support's exports are live ES bindings the build does not allow reconfiguring.
 *
 * <p>The document-PiP stub carries a real `requestWindow` because that is what the support check
 * looks for - an object without one is not a capability, it is a property that would throw on the
 * one call anybody makes of it.</p>
 */
function setPipEnvironment(video: boolean, doc: boolean): void {
    Object.defineProperty(document, 'pictureInPictureEnabled', {value: video, configurable: true});
    if (doc) {
        Object.defineProperty(window, 'documentPictureInPicture', {
            value: {requestWindow: vi.fn()},
            configurable: true,
        });
    } else {
        delete (window as {documentPictureInPicture?: unknown}).documentPictureInPicture;
    }
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

/** The PiP action is the only tile action using this icon - fullscreen and maximise use others. */
function pipButton(fixture: ComponentFixture<CallShareTileComponent>): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector(
        'app-call-tile-action[icon="pi-external-link"]',
    );
}

describe('CallShareTileComponent PiP gating', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither play() nor pause(); an unhandled "not implemented" would fail
        // the run before the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    afterEach(() => {
        delete (document as {pictureInPictureEnabled?: unknown}).pictureInPictureEnabled;
        delete (window as {documentPictureInPicture?: unknown}).documentPictureInPicture;
    });

    it('hides the button when there is no stream and only video PiP is supported', () => {
        // The Rust-published local share (previewSrc only, no MediaStream) has no <video> to pop.
        // Document PiP could carry its <img>, but this host does not have document PiP.
        setPipEnvironment(true, false);

        const fixture = setup(share({previewSrc: 'data:image/png;base64,xx'}));

        expect(pipButton(fixture)).toBeNull();
    });

    it('shows the button when a stream exists and video PiP is supported', () => {
        setPipEnvironment(true, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).not.toBeNull();
    });

    it('shows the button when only document PiP is supported, and labels it as a pop-out', () => {
        // The WebView2-shaped case: video PiP unverified/false, document PiP present. This used to
        // render nothing, because the action could only do video PiP; Task 9 gave the action a
        // document-PiP route, so the gate opened in the same change. The popped-out suite proves the
        // click actually moves the picture in this exact combination.
        setPipEnvironment(false, true);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)?.querySelector('button')?.getAttribute('aria-label')).toBe('CALL.POP_OUT');
    });

    it('shows the button for a preview-only local share when document PiP is supported', () => {
        // The crux of the capability split: no MediaStream at all, so video PiP has nothing to pop,
        // but document PiP moves the <img> preview just as happily as a <video>.
        setPipEnvironment(false, true);

        const fixture = setup(share({previewSrc: 'data:image/png;base64,xx'}));

        expect(pipButton(fixture)).not.toBeNull();
    });

    it('prefers the document-PiP label when both kinds are supported', () => {
        setPipEnvironment(true, true);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)?.querySelector('button')?.getAttribute('aria-label')).toBe('CALL.POP_OUT');
    });

    it('labels the video-PiP fallback as picture in picture', () => {
        setPipEnvironment(true, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)?.querySelector('button')?.getAttribute('aria-label')).toBe(
            'CALL.PICTURE_IN_PICTURE',
        );
    });

    it('hides the button when document PiP is supported but there is nothing to look at', () => {
        // No stream and no preview renders only the placeholder. Popping an empty box into its own
        // OS window is a press that fires and accomplishes nothing.
        setPipEnvironment(false, true);

        const fixture = setup(share());

        expect(pipButton(fixture)).toBeNull();
    });

    it('hides the button when PiP is unsupported entirely, even with a stream', () => {
        setPipEnvironment(false, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).toBeNull();
    });
});
