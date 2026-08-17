import {Directive, ElementRef, inject, OnDestroy, OnInit, output} from '@angular/core';

/** Emits once, the first time the host element is anywhere near the viewport, then disconnects. */
@Directive({selector: '[appInView]'})
export class InViewDirective implements OnInit, OnDestroy {
    /** Emitted the first time the element enters (or nearly enters) the viewport. */
    readonly appInView = output<void>();

    private readonly host = inject(ElementRef<HTMLElement>);
    private observer: IntersectionObserver | null = null;

    ngOnInit(): void {
        // No IntersectionObserver (older webview, a test environment): emit immediately.
        if (typeof IntersectionObserver === 'undefined') {
            this.appInView.emit();
            return;
        }

        this.observer = new IntersectionObserver(
            entries => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                this.disconnect();
                this.appInView.emit();
            },
            {
                // A screen's worth of margin, so a tile is asked for before it is scrolled to.
                rootMargin: '200px',
            },
        );

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
