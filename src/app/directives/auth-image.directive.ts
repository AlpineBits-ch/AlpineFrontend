import {DestroyRef, Directive, effect, ElementRef, inject, input} from '@angular/core';
import {AuthImageService} from '../services/auth-image.service';

/**
 * Points an `<img>` at a URL the session has to authenticate for. Use in place of `[src]` for
 * anything served by our own API; a URL that is not ours is assigned straight across.
 */
@Directive({selector: 'img[appAuthSrc]', standalone: true})
export class AuthImageDirective {
    readonly appAuthSrc = input<string | null | undefined>();

    private readonly el = inject<ElementRef<HTMLImageElement>>(ElementRef);
    private readonly images = inject(AuthImageService);
    private objectUrl: string | null = null;

    constructor() {
        effect(onCleanup => {
            const url = this.appAuthSrc();
            let cancelled = false;
            // A response still in flight must not overwrite an element that has moved on.
            onCleanup(() => (cancelled = true));

            this.release();
            if (!url) return;

            if (!this.images.needsAuth(url)) {
                this.el.nativeElement.src = url;
                return;
            }

            this.images
                .fetch(url)
                .then(blob => {
                    if (cancelled) return;
                    this.objectUrl = URL.createObjectURL(blob);
                    this.el.nativeElement.src = this.objectUrl;
                })
                .catch(() => {
                    // Leaves the element with no `src` at all. An empty string would resolve against
                    // the page and load the document as an image.
                });
        });

        inject(DestroyRef).onDestroy(() => this.release());
    }

    private release(): void {
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
        this.el.nativeElement.removeAttribute('src');
    }
}
