import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';

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

    it('hides the button when there is nothing poppable: no stream and no document PiP', () => {
        // The Rust-published local share (previewSrc only, no MediaStream) has no <video> to pop, and
        // with no documentPictureInPicture either there is no way to pop the <img> preview instead.
        setPipEnvironment(true, false);

        const fixture = setup(share({previewSrc: 'data:image/png;base64,xx'}));

        expect(pipButton(fixture)).toBeNull();
    });

    it('shows the button when a stream exists and video PiP is supported', () => {
        setPipEnvironment(true, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).not.toBeNull();
    });

    it('shows the button for a stream-less local share when document PiP can carry the preview', () => {
        setPipEnvironment(false, true);

        const fixture = setup(share({previewSrc: 'data:image/png;base64,xx'}));

        expect(pipButton(fixture)).not.toBeNull();
    });

    it('hides the button when PiP is unsupported entirely, even with a stream', () => {
        setPipEnvironment(false, false);

        const fixture = setup(share({stream: {} as MediaStream}));

        expect(pipButton(fixture)).toBeNull();
    });
});
