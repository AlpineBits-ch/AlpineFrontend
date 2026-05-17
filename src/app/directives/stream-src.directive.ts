import {Directive, ElementRef, Input} from '@angular/core';

@Directive({selector: '[streamSrc]', standalone: true})
export class StreamSrcDirective {
    constructor(private el: ElementRef<HTMLVideoElement | HTMLAudioElement>) {
    }

    @Input() set streamSrc(stream: MediaStream | null | undefined) {
        const el = this.el.nativeElement;
        el.srcObject = stream ?? null;
        if (stream && el instanceof HTMLVideoElement) {
            void el.play().catch(() => {
            });
        }
    }
}
