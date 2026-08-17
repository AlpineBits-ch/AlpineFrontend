import {inject, Injectable, signal} from '@angular/core';
import {WikiService} from '../../../../services/wiki.service';

/**
 * Session cache of page bodies.
 *
 * `getWiki` returns summaries without content by default, so full-text search and backlinks both
 * need the bodies and would otherwise each fetch them separately. One cache serves both: it fills
 * opportunistically as pages are opened, and can be warmed in full the first time a feature needs
 * complete coverage - never on wiki load, for a feature the user may not touch.
 *
 * The warm is a single `includeContent=true` request. It used to be one request per page; the
 * server gained the flag precisely so this could stop being N.
 */
@Injectable({providedIn: 'root'})
export class WikiContentCacheService {
    private readonly store = signal<ReadonlyMap<string, string>>(new Map());
    private readonly isWarming = signal(false);
    private readonly isWarmed = signal(false);
    private readonly didFail = signal(false);

    readonly content = this.store.asReadonly();
    readonly warming = this.isWarming.asReadonly();
    /** True only when every body is present, so callers can be honest about coverage. */
    readonly warmed = this.isWarmed.asReadonly();
    readonly failed = this.didFail.asReadonly();

    private readonly wikiService = inject(WikiService);

    put(pageId: string, content: string): void {
        this.store.update(map => new Map(map).set(pageId, content));
    }

    invalidate(pageId: string): void {
        this.store.update(map => {
            const next = new Map(map);
            next.delete(pageId);
            return next;
        });
        // One stale page is enough to make a backlink index wrong, so coverage is no longer
        // complete until the next warm.
        this.isWarmed.set(false);
    }

    reset(): void {
        this.store.set(new Map());
        this.isWarming.set(false);
        this.isWarmed.set(false);
        this.didFail.set(false);
    }

    /**
     * Loads every page body in one request. A completed warm is not repeated; a failed one is
     * retryable, because a failure that pinned the cache shut would leave search quietly
     * title-only for the rest of the session.
     */
    warm(guildId: string): void {
        if (this.isWarming() || this.isWarmed()) return;
        this.isWarming.set(true);
        this.didFail.set(false);
        this.wikiService.getWikiWithContent(guildId).subscribe({
            next: wiki => {
                this.store.update(map => {
                    const next = new Map(map);
                    // `?? ''` rather than a skip: an empty body is a truthful "nothing to
                    // search here", while a missing key would break candidate mapping.
                    for (const page of wiki.pages) next.set(page.id, page.content ?? '');
                    return next;
                });
                this.isWarming.set(false);
                this.isWarmed.set(true);
            },
            error: () => {
                this.isWarming.set(false);
                this.didFail.set(true);
            },
        });
    }
}
