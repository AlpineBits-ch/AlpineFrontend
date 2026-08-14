import {Directive, ElementRef, Input, OnDestroy} from '@angular/core';

/**
 * Binds a `MediaStream` to a `<video>` (or `<audio>`) element, and pauses playback while the
 * window is hidden.
 *
 * <p><b>Pause, not unsubscribe.</b> Every use of this directive in the app is a muted `<video>` -
 * remote screen shares, remote cameras, the local self-preview's real-stream path - so pausing
 * costs nothing audio ever depended on. `srcObject` and the track keep flowing exactly as before;
 * only the element stops decoding frames nobody can see. The subscription, and whatever viewer
 * claim goes with it (see `ShareWatchService`), are untouched - unsubscribing would drop the
 * streamer's viewer count and force a resubscribe on return, which is the opposite of what pausing
 * for a hidden window is for.</p>
 *
 * <p>A video already in Picture-in-Picture is left alone. PiP's entire purpose is to keep playing
 * while the host window is not the thing on screen, so pausing it the moment the window backgrounds
 * would defeat it outright.</p>
 */
@Directive({selector: '[streamSrc]', standalone: true})
export class StreamSrcDirective implements OnDestroy {
    private stream: MediaStream | null = null;
    private readonly onVisibilityChange = (): void => this.applyVisibility();

    constructor(private el: ElementRef<HTMLVideoElement | HTMLAudioElement>) {
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    @Input() set streamSrc(stream: MediaStream | null | undefined) {
        this.stream = stream ?? null;
        const el = this.el.nativeElement;
        el.srcObject = this.stream;
        // Skip the play() call outright while hidden - binding a fresh stream to an element that
        // is about to be paused anyway would just churn the decoder for a frame nobody sees.
        if (this.stream && el instanceof HTMLVideoElement && !document.hidden) {
            void el.play().catch(() => {
            });
        }
    }

    ngOnDestroy(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    private applyVisibility(): void {
        const el = this.el.nativeElement;
        if (!(el instanceof HTMLVideoElement) || !this.stream) return;
        if (document.pictureInPictureElement === el) return;

        if (document.hidden) el.pause();
        else void el.play().catch(() => {
        });
    }
}
