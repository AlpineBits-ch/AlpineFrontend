import { Directive, ElementRef, Input } from '@angular/core';

@Directive({ selector: '[streamSrc]', standalone: true })
export class StreamSrcDirective {
  constructor(private el: ElementRef<HTMLVideoElement | HTMLAudioElement>) {}

  @Input() set streamSrc(stream: MediaStream | null | undefined) {
    this.el.nativeElement.srcObject = stream ?? null;
  }
}
