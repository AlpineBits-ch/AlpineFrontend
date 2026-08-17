import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {ApiConfigService} from './api-config.service';

/** Fetches images only an authenticated request may read: the browser's own image loader carries no bearer. */
@Injectable({providedIn: 'root'})
export class AuthImageService {
    /** Enough to cover a screen of messages several times over. */
    private static readonly MAX_ENTRIES = 100;

    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);

    /** Keyed by URL, oldest evicted first. Blobs, not object URLs: a shared object URL is revoked by one unmount. */
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
        // A failure must not be cached, or one flaky response leaves that image broken for the session.
        void pending.catch(() => this.cache.delete(url));

        this.cache.set(url, pending);
        if (this.cache.size > AuthImageService.MAX_ENTRIES) {
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        return pending;
    }
}
