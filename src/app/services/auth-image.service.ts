import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {ApiConfigService} from './api-config.service';

/**
 * Fetches images that only an authenticated request may read.
 *
 * <p>Attachment routes stopped serving reads anonymously, so `/attachments/{id}/thumbnail` and
 * `/attachments/{id}/download` answer 401 to anything without a bearer. The browser's own image
 * loader is one of those things: it never passes through `HttpClient`, so no interceptor attaches
 * the token. Going through `HttpClient` here is what gets the header on the request.</p>
 */
@Injectable({providedIn: 'root'})
export class AuthImageService {
    /**
     * Enough to cover a screen of messages several times over, so scrolling back over the same
     * conversation does not re-download what was already fetched.
     */
    private static readonly MAX_ENTRIES = 100;

    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);

    /**
     * Keyed by URL, in insertion order so the oldest entry is the one evicted.
     *
     * <p>Holds blobs rather than object URLs on purpose. An object URL handed to two elements is
     * revoked by whichever unmounts first, and the other one goes blank; every consumer minting its
     * own from a shared blob has no such coupling.</p>
     */
    private readonly cache = new Map<string, Promise<Blob>>();

    /** Whether this URL is one of ours, and therefore one the token belongs on. */
    needsAuth(url: string): boolean {
        return this.apiConfig.isOwnUrl(url);
    }

    fetch(url: string): Promise<Blob> {
        const cached = this.cache.get(url);
        if (cached) {
            // Re-inserted so a URL that is still being looked at is not the next one evicted.
            this.cache.delete(url);
            this.cache.set(url, cached);
            return cached;
        }

        const pending = firstValueFrom(this.http.get(url, {responseType: 'blob'}));
        // A failure must not be cached, or one flaky response leaves that image broken for the rest
        // of the session with no way to retry it.
        void pending.catch(() => this.cache.delete(url));

        this.cache.set(url, pending);
        if (this.cache.size > AuthImageService.MAX_ENTRIES) {
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        return pending;
    }
}
