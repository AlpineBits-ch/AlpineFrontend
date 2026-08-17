import {Injectable, signal} from '@angular/core';

/**
 * Remembers which image URLs turned out to serve nothing.
 *
 * <p>The API mints an avatar and a banner URL for every profile from its id alone, whether or
 * not an image was ever uploaded, so a populated `avatarUrl` / `bannerUrl` says nothing about
 * the image existing - the request 404s and the browser paints its broken-image glyph. The only
 * way to learn a profile has no banner is to watch the `<img>` fail, which makes that verdict
 * state the templates have to keep.</p>
 *
 * <p>It lives here rather than in each component because the same URL is rendered in many places
 * at once - a member list draws one avatar per row, and the profile dialog draws it again - and a
 * per-component flag would let each copy rediscover the same 404. Keyed by URL, one failure
 * retires every copy, and a component destroyed and rebuilt (a list scrolling, a dialog
 * reopening) does not start over.</p>
 */
@Injectable({providedIn: 'root'})
export class BrokenImageService {
    private readonly broken = signal<ReadonlySet<string>>(new Set());

    isBroken(url: string | null | undefined): boolean {
        return !!url && this.broken().has(url);
    }

    markBroken(url: string | null | undefined): void {
        if (!url || this.broken().has(url)) return;
        this.broken.update(prev => new Set(prev).add(url));
    }

    /**
     * Forgets a verdict, so the next render requests the image again. Called when the user
     * uploads or removes their own image: that is the one moment a URL known to serve nothing
     * starts serving something, and the URL itself does not change to signal it.
     */
    clear(url: string | null | undefined): void {
        if (!url || !this.broken().has(url)) return;
        this.broken.update(prev => {
            const next = new Set(prev);
            next.delete(url);
            return next;
        });
    }
}
