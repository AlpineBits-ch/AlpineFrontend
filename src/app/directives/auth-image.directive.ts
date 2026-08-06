import {DestroyRef, Directive, effect, ElementRef, inject, input} from '@angular/core';
import {AuthImageService} from '../services/auth-image.service';

/**
 * Points an `<img>` at a URL the session has to authenticate for.
 *
 * <p>Use in place of `[src]` for anything served by our own API. A plain `[src]` is fetched by the
 * browser itself, with no `Authorization` header on the request, which every attachment route now
 * answers 401 to - the element then renders as the browser's broken-image glyph, with the message
 * looking as though the file never uploaded. This fetches the bytes through `HttpClient`, where the
 * token interceptor applies, and gives the element an object URL.</p>
 *
 * <p>A URL that is not ours is assigned straight across: an embed's proxied image lives on another
 * origin, where an `XMLHttpRequest` would need CORS headers that a plain image load never required.
 * Routing those through here would break previews that work today.</p>
 */
@Directive({selector: 'img[appAuthSrc]', standalone: true})
export class AuthImageDirective {
    readonly appAuthSrc = input<string | null | undefined>();

    private readonly el = inject<ElementRef<HTMLImageElement>>(ElementRef);
    private readonly images = inject(AuthImageService);
    private objectUrl: string | null = null;

    constructor() {
        effect((onCleanup) => {
            const url = this.appAuthSrc();
            let cancelled = false;
            // A second URL arriving before the first resolves must not have its element overwritten
            // by the response that is still in flight for the URL it no longer shows.
            onCleanup(() => cancelled = true);

            this.release();
            if (!url) return;

            if (!this.images.needsAuth(url)) {
                this.el.nativeElement.src = url;
                return;
            }

            this.images.fetch(url).then(blob => {
                if (cancelled) return;
                this.objectUrl = URL.createObjectURL(blob);
                this.el.nativeElement.src = this.objectUrl;
            }).catch(() => {
                // Deliberately leaves the element with no `src` at all. Assigning an empty string
                // resolves against the page and loads the document as an image, which is precisely
                // how a broken-image glyph gets drawn - the thing this directive exists to stop.
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
