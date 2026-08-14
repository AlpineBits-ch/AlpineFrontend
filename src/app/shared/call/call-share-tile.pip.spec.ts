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
 */
function setPipEnvironment(video: boolean, doc: boolean): void {
    Object.defineProperty(document, 'pictureInPictureEnabled', {value: video, configurable: true});
    if (doc) Object.defineProperty(window, 'documentPictureInPicture', {value: {}, configurable: true});
    else delete (window as {documentPictureInPicture?: unknown}).documentPictureInPicture;
}

function setup(s: CallScreenShare): ComponentFixture<CallShareTileComponent> {
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
    fixture.detectChanges();
    return fixture;
}

/** The PiP action is the only tile action using this icon - fullscreen and maximise use others. */
function pipButton(fixture: ComponentFixture<CallShareTileComponent>): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector('app-call-tile-action[icon="pi-external-link"]');
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

    it('hides the button when there is no stream, even though video PiP is supported', () => {
        // The Rust-published local share (previewSrc only, no MediaStream) has no <video> to pop.
        setPipEnvironment(true, false);

        const fixture = setup(share({previewSrc: 'data:image/png;base64,xx'}));

        expect(pipButton(fixture)).toBeNull();
    });

    it('shows the button when a stream exists and video PiP is supported', () => {
        setPipEnvironment(true, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).not.toBeNull();
    });

    it('hides the button when a stream exists but only document PiP is supported', () => {
        // togglePip() only ever performs video-element PiP - document PiP dispatch is Task 9's to add
        // - so claiming this state is poppable would reproduce the exact dead button this task exists
        // to remove, just under a different capability skew. This is the WebView2-shaped case: video
        // PiP unverified/false, document PiP present.
        setPipEnvironment(false, true);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).toBeNull();
    });

    it('hides the button when PiP is unsupported entirely, even with a stream', () => {
        setPipEnvironment(false, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).toBeNull();
    });
});
