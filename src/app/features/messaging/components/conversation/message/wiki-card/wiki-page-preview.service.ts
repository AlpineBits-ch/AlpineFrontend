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

/** Fetches the page behind a wiki link in chat, once per page. */
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

    /** The guild's categories, for the path above a page. */
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
