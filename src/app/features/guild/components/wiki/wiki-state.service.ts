import {inject, Injectable, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiView} from './wiki.types';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {wikiAbilities, WikiAbilities} from './wiki-permissions';
import {effectiveGuildPermissions} from '../../guild-permissions';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';

@Injectable({providedIn: 'root'})
export class WikiStateService {
    readonly wiki = signal<WikiDto | null>(null);
    readonly wikiView = signal<WikiView>('home');
    readonly selectedPage = signal<WikiPageDto | null>(null);
    readonly editingPage = signal<WikiPageDto | null>(null);
    readonly editorDefaults = signal<{ categoryId?: string; parentPageId?: string } | null>(null);
    readonly guildId = signal<string>('');
    readonly pageLoading = signal(false);
    readonly pendingRemoteUpdate = signal<WikiPageDto | null>(null);
    /**
     * What this member may do here. Starts at nothing and stays there until the fetch answers,
     * so a control is never briefly offered to somebody who turns out not to hold the permission.
     */
    readonly abilities = signal<WikiAbilities>(wikiAbilities(0n));
    readonly ownUserId = signal<string | null>(null);
    private readonly wikiService = inject(WikiService);
    private readonly ws = inject(GuildWebsocketService);
    private readonly contentCache = inject(WikiContentCacheService);
    private readonly guildService = inject(GuildService);
    private readonly profileService = inject(ProfileService);
    private suppressNextPageRefresh = false;

    constructor() {
        this.ws.wikiPageCreatedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.ws.wikiPageUpdatedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
            // A cache nothing invalidates goes stale, and stale bodies produce a backlink index
            // pointing at links that are no longer there.
            this.contentCache.invalidate(e.pageId);

            if (this.wikiView() === 'page' && this.selectedPage()?.id === e.pageId) {
                if (this.suppressNextPageRefresh) {
                    this.suppressNextPageRefresh = false;
                    return;
                }
                this.pageLoading.set(true);
                this.wikiService.getPage(this.guildId(), e.pageId).subscribe({
                    next: page => {
                        this.selectedPage.set(page);
                        this.pageLoading.set(false);
                    },
                    error: () => this.pageLoading.set(false),
                });
            }

            if (this.wikiView() === 'editor' && this.editingPage()?.id === e.pageId) {
                this.wikiService.getPage(this.guildId(), e.pageId).subscribe({
                    next: page => this.pendingRemoteUpdate.set(page),
                    error: () => {
                    },
                });
            }
        });

        this.ws.wikiPageDeletedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.contentCache.invalidate(e.pageId);
            const affectsSelected = this.selectedPage()?.id === e.pageId;
            const affectsEditing = this.editingPage()?.id === e.pageId;
            if (affectsSelected || affectsEditing) {
                this.selectedPage.set(null);
                this.editingPage.set(null);
                this.pendingRemoteUpdate.set(null);
                this.wikiView.set('home');
                this.pageLoading.set(false);
            }
            this.loadWiki(this.guildId());
        });

        this.ws.wikiCategoryCreatedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.ws.wikiCategoryUpdatedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.ws.wikiCategoryDeletedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });
    }

    initialize(guildId: string): void {
        if (this.guildId() !== guildId) {
            this.guildId.set(guildId);
            this.wikiView.set('home');
            this.selectedPage.set(null);
            this.editingPage.set(null);
            this.pendingRemoteUpdate.set(null);
            this.pageLoading.set(false);
            // One guild's bodies must never be searched under another guild's name.
            this.contentCache.reset();
            this.loadAbilities(guildId);
        }
        this.loadWiki(guildId);
    }

    openHome(): void {
        this.wikiView.set('home');
        this.selectedPage.set(null);
        this.pageLoading.set(false);
    }

    openPage(summary: WikiPageSummaryDto): void {
        this.selectedPage.set(null);
        this.pageLoading.set(true);
        this.wikiView.set('page');
        this.wikiService.getPage(this.guildId(), summary.id).subscribe({
            next: page => {
                this.selectedPage.set(page);
                this.pageLoading.set(false);
                // Opportunistic fill: the body is already in hand, so caching it costs nothing
                // and shrinks what a later full warm has to cover.
                this.contentCache.put(page.id, page.content ?? '');
            },
            error: () => {
                this.pageLoading.set(false);
                this.openHome();
            },
        });
    }

    openEditor(page?: WikiPageDto, defaults?: { categoryId?: string; parentPageId?: string }): void {
        this.editingPage.set(page ?? null);
        this.editorDefaults.set(page ? null : (defaults ?? null));
        this.pendingRemoteUpdate.set(null);
        this.wikiView.set('editor');
    }

    openHistory(): void {
        this.wikiView.set('history');
    }

    cancelEditor(): void {
        this.editorDefaults.set(null);
        this.pendingRemoteUpdate.set(null);
        const page = this.editingPage();
        if (page) {
            this.selectedPage.set(page);
            this.wikiView.set('page');
            this.pageLoading.set(false);
        } else {
            this.openHome();
        }
    }

    afterSaved(page: WikiPageDto): void {
        this.editorDefaults.set(null);
        this.pendingRemoteUpdate.set(null);
        // Our own write comes back over the websocket a moment later. Refetching the page in
        // response to it would replace what we already hold with an identical copy, and the
        // in-flight `pageLoading` swaps the article out for a spinner while it does - a visible
        // flash for no new information.
        this.suppressNextPageRefresh = true;
        this.loadWiki(this.guildId(), page);
    }

    afterDeleted(): void {
        this.selectedPage.set(null);
        this.pageLoading.set(false);
        this.wikiView.set('home');
        this.loadWiki(this.guildId());
    }

    afterRestored(page: WikiPageDto): void {
        this.loadWiki(this.guildId(), page);
    }

    suppressPageRefreshOnce(): void {
        this.suppressNextPageRefresh = true;
    }

    clearPendingRemoteUpdate(): void {
        this.pendingRemoteUpdate.set(null);
    }

    reload(): void {
        this.loadWiki(this.guildId());
    }

    updateWikiOptimistic(fn: (wiki: WikiDto) => WikiDto): void {
        this.wiki.update(w => (w ? fn(w) : w));
    }

    /**
     * Cleared before the fetch, not after: leaving the previous guild's answer live while the
     * new request is in flight would show manage controls to a non-manager for the duration,
     * and for the whole session if that request fails. Same guard the events panel uses.
     */
    private loadAbilities(guildId: string): void {
        this.abilities.set(wikiAbilities(0n));
        const ownUserId = this.profileService.ownProfile()?.userId ?? null;
        this.ownUserId.set(ownUserId);
        const isOwner = this.isGuildOwner(guildId, ownUserId);
        this.guildService.getOwnMember(guildId).subscribe({
            next: member => {
                this.abilities.set(wikiAbilities(effectiveGuildPermissions(member), isOwner));
                this.ownUserId.set(member.userId ?? this.ownUserId());
            },
            // The owner keeps their abilities even when the member fetch fails: ownership is
            // already known locally, and denying it here would lock them out of their own wiki.
            error: () => this.abilities.set(wikiAbilities(0n, isOwner)),
        });
    }

    private isGuildOwner(guildId: string, ownUserId: string | null): boolean {
        if (!ownUserId) return false;
        return this.guildService.guilds().find(g => g.id === guildId)?.ownerId === ownUserId;
    }

    private loadWiki(guildId: string, navigateTo?: WikiPageDto): void {
        this.wikiService.getWiki(guildId).subscribe(wiki => {
            this.wiki.set(wiki);
            if (navigateTo) {
                this.selectedPage.set(navigateTo);
                this.wikiView.set('page');
                this.pageLoading.set(false);
            } else {
                const current = this.selectedPage();
                if (current) {
                    const summary = wiki.pages.find(p => p.id === current.id);
                    if (summary) this.selectedPage.update(p => p ? mergeSummary(p, summary) : p);
                }
            }
        });
    }
}

/**
 * Refreshes the open page's metadata from the wiki listing without touching its body.
 *
 * `content` is dropped on purpose. The listing carries it only when explicitly asked
 * (`?includeContent=true`), so spreading the summary wholesale overwrote the loaded body with
 * `undefined` and blanked the page on screen until the next full fetch - which is exactly what
 * happened on the second `loadWiki` a save triggers. Any future opt-in field on the summary needs
 * the same treatment, which is why this is a named function rather than an inline spread.
 */
export function mergeSummary(page: WikiPageDto, summary: WikiPageSummaryDto): WikiPageDto {
    const {content: _optIn, ...metadata} = summary;
    return {...page, ...metadata};
}
