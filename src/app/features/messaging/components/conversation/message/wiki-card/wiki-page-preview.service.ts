import {inject, Injectable} from '@angular/core';
import {catchError, map, Observable, of, shareReplay} from 'rxjs';
import {WikiService} from '../../../../../../services/wiki.service';
import {WikiCategoryDto, WikiPageDto} from '../../../../../../dtos/response/wiki.dto';

/** What a card needs, already resolved: the page plus the names above it. */
export interface WikiPagePreview {
    page: WikiPageDto;
    /** Outermost category first. Empty for a page filed nowhere. */
    categoryPath: string[];
}

/**
 * Fetches the page behind a wiki link in chat, once per page.
 *
 * <p>A channel scrolls past the same link many times - a page somebody keeps referring to, a
 * pinned post reopened - and every card mounts its own fetch. The cache is a `shareReplay` per
 * page id rather than a stored value, so cards that mount together share one request in flight as
 * well as its answer.</p>
 *
 * <p>Nothing invalidates it. A card is a pointer, not a copy: it is read once when the message
 * scrolls into view, and a title that is a few minutes stale is not worth a refetch on every
 * scroll. Opening the page always goes to the wiki, which fetches fresh.</p>
 */
@Injectable({providedIn: 'root'})
export class WikiPagePreviewService {
    private readonly wikiService = inject(WikiService);
    private readonly pages = new Map<string, Observable<WikiPagePreview | null>>();
    private readonly categories = new Map<string, Observable<WikiCategoryDto[]>>();

    preview(guildId: string, pageId: string): Observable<WikiPagePreview | null> {
        const key = `${guildId}/${pageId}`;
        const cached = this.pages.get(key);
        if (cached) return cached;

        const request = this.wikiService.getPage(guildId, pageId).pipe(
            map(page => ({page, categoryPath: [] as string[]})),
            catchError(() => of(null)),
            shareReplay({bufferSize: 1, refCount: false}),
        );
        this.pages.set(key, request);
        return request;
    }

    /**
     * The guild's categories, for the path above a page.
     *
     * <p>Separate from {@link preview} because the page fetch carries only a `categoryId`, and one
     * listing serves every card in the guild. `getWiki` swallows its own errors into an empty wiki,
     * so a failure here costs the breadcrumb line and nothing else.</p>
     */
    categoriesFor(guildId: string): Observable<WikiCategoryDto[]> {
        const cached = this.categories.get(guildId);
        if (cached) return cached;

        const request = this.wikiService.getWiki(guildId).pipe(
            map(wiki => wiki.categories),
            catchError(() => of([] as WikiCategoryDto[])),
            shareReplay({bufferSize: 1, refCount: false}),
        );
        this.categories.set(guildId, request);
        return request;
    }
}

/** Walks a category up to the root. Guards against a cycle rather than trusting the server's tree. */
export function categoryPath(categories: readonly WikiCategoryDto[], categoryId?: string): string[] {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = categoryId;
    while (current && !seen.has(current)) {
        seen.add(current);
        const category = categories.find(c => c.id === current);
        if (!category) break;
        path.unshift(category.name);
        current = category.parentCategoryId;
    }
    return path;
}
