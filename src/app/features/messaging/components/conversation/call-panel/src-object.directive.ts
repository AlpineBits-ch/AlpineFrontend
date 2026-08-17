import {Directive, ElementRef, inject, Input} from '@angular/core';

/** Binds a MediaStream to a <video> element's srcObject property. */
@Directive({selector: 'video[srcObject]', standalone: true})
export class SrcObjectDirective {
    private el = inject(ElementRef<HTMLVideoElement>);

    @Input() set srcObject(stream: MediaStream | null | undefined) {
        this.el.nativeElement.srcObject = stream ?? null;
    }
}
