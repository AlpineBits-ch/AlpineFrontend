import {ChangeDetectionStrategy, Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StreamSrcDirective} from './stream-src.directive';

@Component({
    selector: 'app-stream-src-host',
    imports: [StreamSrcDirective],
    template: `<video [appStreamSrc]="stream"></video>`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    stream: MediaStream | null = null;
}

/** jsdom's `document.hidden` is a real getter on the prototype; shadow it with an own property and
 *  delete it afterwards to fall back to the real one. */
function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
}

describe('StreamSrcDirective visibility pause', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither play() nor pause(); an unhandled "not implemented" would fail the
        // run before the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
        setHidden(false);
    });

    afterEach(() => {
        delete (document as unknown as Record<string, unknown>)['hidden'];
        delete (document as unknown as Record<string, unknown>)['pictureInPictureElement'];
    });

    function render(): {fixture: ComponentFixture<HostComponent>; video: HTMLVideoElement} {
        TestBed.configureTestingModule({imports: [HostComponent]});
        const fixture = TestBed.createComponent(HostComponent);
        fixture.componentInstance.stream = {} as MediaStream;
        fixture.detectChanges();
        return {fixture, video: fixture.nativeElement.querySelector('video') as HTMLVideoElement};
    }

    it('binds the stream to srcObject and plays while visible', () => {
        const {video} = render();

        expect(video.srcObject).toBeTruthy();
        expect(video.play).toHaveBeenCalled();
    });

    it('pauses the element - and nothing else - when the window goes hidden', () => {
        const {video} = render();
        expect(video.srcObject).toBeTruthy();

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));

        expect(video.pause).toHaveBeenCalledTimes(1);
        // Not unsubscribed: the stream is still bound. Pausing playback is the whole point - see
        // the directive's class doc on why this must never touch srcObject.
        expect(video.srcObject).toBeTruthy();
    });

    it('resumes playback when the window comes back', () => {
        const {video} = render();
        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));
        (video.play as ReturnType<typeof vi.fn>).mockClear();

        setHidden(false);
        document.dispatchEvent(new Event('visibilitychange'));

        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('leaves a video in Picture-in-Picture alone', () => {
        // PiP's entire purpose is to keep playing while the host window is not the thing on screen -
        // pausing it the moment the window backgrounds would defeat it outright.
        const {video} = render();
        Object.defineProperty(document, 'pictureInPictureElement', {configurable: true, value: video});

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));

        expect(video.pause).not.toHaveBeenCalled();
    });

    it('leaves an element moved into a Document-PiP pop-out window alone', () => {
        // Document PiP moves the element into a separate pop-out window's own document, so
        // `document.pictureInPictureElement` never points at it - it must be detected via
        // `ownerDocument` instead, or the pop-out freezes the moment the host window hides.
        const {video} = render();
        const otherDocument = document.implementation.createHTMLDocument('pip');
        otherDocument.body.appendChild(video);

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));

        expect(video.pause).not.toHaveBeenCalled();
    });

    it('does nothing when there is no stream bound', () => {
        TestBed.configureTestingModule({imports: [HostComponent]});
        const fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));

        expect(video.pause).not.toHaveBeenCalled();
    });
});
