import {Directive, ElementRef, Input, OnDestroy} from '@angular/core';

/**
 * Binds a `MediaStream` to a `<video>` (or `<audio>`) element, and pauses playback while the
 * window is hidden. Pause only: never unsubscribe, which would drop the viewer claim. A video in
 * either Picture-in-Picture route keeps playing.
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
        // Skip the play() call outright while hidden.
        if (this.stream && el instanceof HTMLVideoElement && !document.hidden) {
            void el.play().catch(() => {});
        }
    }

    ngOnDestroy(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    private applyVisibility(): void {
        const el = this.el.nativeElement;
        if (!(el instanceof HTMLVideoElement) || !this.stream) return;
        // Both PiP pop-out routes must keep playing while this window is hidden - see the class doc.
        if (document.pictureInPictureElement === el) return;
        if (el.ownerDocument !== document) return;

        if (document.hidden) el.pause();
        else void el.play().catch(() => {});
    }
}
