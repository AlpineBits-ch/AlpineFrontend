import {Directive, effect, ElementRef, inject, input, OnDestroy} from '@angular/core';

/**
 * Binds a `MediaStream` to a `<video>` (or `<audio>`) element, and pauses playback while the
 * window is hidden. Pause only: never unsubscribe, which would drop the viewer claim. A video in
 * either Picture-in-Picture route keeps playing.
 */
@Directive({selector: '[appStreamSrc]', standalone: true})
export class StreamSrcDirective implements OnDestroy {
    readonly appStreamSrc = input<MediaStream | null | undefined>();

    private readonly el = inject<ElementRef<HTMLVideoElement | HTMLAudioElement>>(ElementRef);
    private readonly onVisibilityChange = (): void => this.applyVisibility();

    constructor() {
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        effect(() => {
            const stream = this.appStreamSrc() ?? null;
            const el = this.el.nativeElement;
            el.srcObject = stream;
            // Skip the play() call outright while hidden.
            if (stream && el instanceof HTMLVideoElement && !document.hidden) {
                void el.play().catch(() => {});
            }
        });
    }

    ngOnDestroy(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    private applyVisibility(): void {
        const el = this.el.nativeElement;
        if (!(el instanceof HTMLVideoElement) || !this.appStreamSrc()) return;
        // Both PiP pop-out routes must keep playing while this window is hidden - see the class doc.
        if (document.pictureInPictureElement === el) return;
        if (el.ownerDocument !== document) return;

        if (document.hidden) el.pause();
        else void el.play().catch(() => {});
    }
}
