import {Directive, ElementRef, inject, OnDestroy, OnInit, output} from '@angular/core';

/**
 * Emits once, the first time the host element is anywhere near the viewport.
 *
 * <p>Written for the screen picker, where the alternative is capturing a full-resolution image of
 * every window on the desktop before the dialog can render - the cost of which is paid whether or
 * not the user ever scrolls far enough to see them.</p>
 *
 * <p>Fires once and then disconnects: what it guards is a one-off fetch, and re-firing on every
 * scroll past would defeat the point.</p>
 */
@Directive({selector: '[appInView]'})
export class InViewDirective implements OnInit, OnDestroy {
    /** Emitted the first time the element enters (or nearly enters) the viewport. */
    readonly appInView = output<void>();

    private readonly host = inject(ElementRef<HTMLElement>);
    private observer: IntersectionObserver | null = null;

    ngOnInit(): void {
        // No IntersectionObserver (older webview, a test environment): emit immediately rather than
        // never. Eager loading is the old behaviour, and it is a great deal better than blank tiles.
        if (typeof IntersectionObserver === 'undefined') {
            this.appInView.emit();
            return;
        }

        this.observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            this.disconnect();
            this.appInView.emit();
        }, {
            // A screen's worth of margin, so a tile has usually been asked for by the time it is
            // scrolled to and arrives without a visible gap.
            rootMargin: '200px',
        });

        this.observer.observe(this.host.nativeElement);
    }

    ngOnDestroy(): void {
        this.disconnect();
    }

    private disconnect(): void {
        this.observer?.disconnect();
        this.observer = null;
    }
}
