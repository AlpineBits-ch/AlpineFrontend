import {
    ChangeDetectionStrategy,
    Component,
    effect,
    ElementRef,
    inject,
    input,
    viewChild,
} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import type {IconNode} from 'lucide';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Renders one lucide icon. The data is bundled at build time, never user input. */
@Component({
    selector: 'app-lucide-icon',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'contents'},
    template: `
        <svg
            #svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        ></svg>
    `,
    styles: `
        /* Two knobs, both overridable per slot.

           Size: lucide's 24 viewBox holds about 2 units of padding, so a glyph drawn at
           1em covers ~0.83em and lands visibly smaller than the icon font it replaced.

           Stroke: the width is in viewBox units, so it shrinks with the box. At the
           sidebar's 0.8125rem the shipped 2 renders as 1.08px, which reads as too light
           beside a text glyph. */
        svg {
            width: var(--lucide-size, 1.25em);
            height: var(--lucide-size, 1.25em);
            stroke-width: var(--lucide-stroke-width, 2.5);
        }
    `,
})
export class LucideIconComponent {
    readonly icon = input.required<IconNode>();

    private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
    private readonly doc = inject(DOCUMENT);

    constructor() {
        effect(() => {
            const host = this.svg().nativeElement;
            host.replaceChildren();
            for (const [tag, attrs] of this.icon()) {
                const el = this.doc.createElementNS(SVG_NS, tag);
                for (const [name, value] of Object.entries(attrs)) {
                    el.setAttribute(name, String(value));
                }
                host.appendChild(el);
            }
        });
    }
}
