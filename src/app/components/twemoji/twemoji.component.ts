import {Component, computed, inject, input} from '@angular/core';
import {DomSanitizer} from '@angular/platform-browser';
import twemoji from 'twemoji';

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/';

@Component({
    selector: 'app-twemoji',
    template: `<span [innerHTML]="html()"></span>`,
    host: {style: 'display:inline-flex;align-items:center;line-height:0'},
})
export class TwemojiComponent {
    emoji = input.required<string>();
    size = input<string>('1.25em');
    private sanitizer = inject(DomSanitizer);
    html = computed(() => {
        const s = this.size();
        const raw = twemoji.parse(this.emoji(), {
            folder: 'svg',
            ext: '.svg',
            base: TWEMOJI_BASE,
            attributes: () => ({
                style: `height:${s};width:${s};vertical-align:middle;display:inline-block`,
                draggable: 'false',
            }),
        });
        return this.sanitizer.bypassSecurityTrustHtml(raw);
    });
}
