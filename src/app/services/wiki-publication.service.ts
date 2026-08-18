import {computed, inject, Injectable, Injector, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, Observable, switchMap, tap, throwError} from 'rxjs';
import {WikiPublicationApi} from './wiki-publication-api.service';
import {ApiConfigService} from './api-config.service';
import {WikiService} from './wiki.service';
import {WikiPagePublicationDto, WikiPublicationDto} from '../dtos/response/wiki-publication.dto';
import {deriveWikiHost} from '../features/guild/components/wiki/wiki-slug';

/** True for the answer the slug field is built around: somebody else already has this name. */
export function isSlugTaken(err: unknown): boolean {
    return err instanceof HttpErrorResponse && err.status === 409;
}

/** The two writes a page that is private inside the guild needs before it can be public. */
export type WikiPublishStep = 'visibility' | 'publish';

export interface WikiPublishFailure {
    step: WikiPublishStep;
    error: unknown;
}

export function isWikiPublishFailure(err: unknown): err is WikiPublishFailure {
    const step = (err as WikiPublishFailure | null)?.step;
    return step === 'visibility' || step === 'publish';
}

function failed(step: WikiPublishStep, error: unknown): WikiPublishFailure {
    return {step, error};
}

/**
 * Whether a guild's wiki is on the public host, and which of its pages have opted in.
 *
 * Both halves are needed for a page to be readable, and they are stored separately because the
 * server stores them separately: a page keeps its opt-in while the wiki is offline.
 */
@Injectable({providedIn: 'root'})
export class WikiPublicationService {
    private readonly injector = inject(Injector);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly wiki = inject(WikiService);

    private readonly publications = signal<Record<string, WikiPublicationDto>>({});
    private readonly loading = signal<Record<string, boolean>>({});
    private readonly requested = new Set<string>();

    /** The zone published wikis sit in when the server has not said. */
    private readonly fallbackHost = computed(() => deriveWikiHost(this.apiConfig.baseUrl()));

    private get api(): WikiPublicationApi {
        return this.injector.get(WikiPublicationApi);
    }

    publication(guildId: string | null | undefined): WikiPublicationDto | null {
        return guildId ? (this.publications()[guildId] ?? null) : null;
    }

    slug(guildId: string | null | undefined): string | null {
        return this.publication(guildId)?.slug ?? null;
    }

    /** The whole wiki is on the public host. Necessary for any page to be readable, never sufficient. */
    isPublished(guildId: string | null | undefined): boolean {
        return !!this.slug(guildId);
    }

    isLoading(guildId: string | null | undefined): boolean {
        return !!guildId && !!this.loading()[guildId];
    }

    /** The zone published wikis sit in. The server's answer wins; this only fills the gap before it lands. */
    host(guildId: string | null | undefined): string {
        return this.publication(guildId)?.host || this.fallbackHost();
    }

    ensureLoaded(guildId: string | null | undefined, force = false): void {
        if (!guildId) return;
        if (this.requested.has(guildId) && !force) return;
        this.requested.add(guildId);
        this.loading.update(map => ({...map, [guildId]: true}));

        this.api.get(guildId).subscribe({
            next: state => {
                this.publications.update(map => ({...map, [guildId]: state}));
                this.loading.update(map => ({...map, [guildId]: false}));
            },
            error: () => {
                // Left unrequested so a failed read is retried rather than presenting as "not public".
                this.requested.delete(guildId);
                this.loading.update(map => ({...map, [guildId]: false}));
            },
        });
    }

    /** Null takes the whole wiki off the public host. */
    setSlug(guildId: string, slug: string | null): Observable<WikiPublicationDto> {
        return this.api
            .set(guildId, {slug})
            .pipe(tap(state => this.publications.update(map => ({...map, [guildId]: state}))));
    }

    /**
     * The opt-in lives on the page, so the answer to "which pages are public" comes from the page
     * list rather than from here. Nothing is cached: there would be two counts to keep in step.
     */
    setPagePublished(guildId: string, pageId: string, published: boolean): Observable<unknown> {
        return this.api.setPage(guildId, pageId, {published});
    }

    /**
     * Opens the page to the guild and then puts it on the public host. Two writes, so a failure
     * names the half it stopped at: a refused publish leaves the page readable in the guild.
     */
    publishFromPrivate(guildId: string, pageId: string): Observable<WikiPagePublicationDto> {
        return this.wiki.updatePage(guildId, pageId, {visibility: 'public'}).pipe(
            catchError((error: unknown) => throwError(() => failed('visibility', error))),
            switchMap(() => this.publishOnly(guildId, pageId)),
        );
    }

    /** The second write on its own, for a retry after the first has already landed. */
    publishOnly(guildId: string, pageId: string): Observable<WikiPagePublicationDto> {
        return this.api
            .setPage(guildId, pageId, {published: true})
            .pipe(catchError((error: unknown) => throwError(() => failed('publish', error))));
    }
}
