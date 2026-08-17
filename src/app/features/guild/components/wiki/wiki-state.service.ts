import {computed, inject, Injectable, Signal, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiView} from './wiki.types';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {WikiDraftsService} from './wiki-drafts.service';
import {wikiAbilities, WikiAbilities} from './wiki-permissions';
import {guildAbilities} from '../../guild-permissions';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';

@Injectable({providedIn: 'root'})
export class WikiStateService {
    readonly wiki = signal<WikiDto | null>(null);
    readonly wikiView = signal<WikiView>('home');
    readonly selectedPage = signal<WikiPageDto | null>(null);
    readonly editingPage = signal<WikiPageDto | null>(null);
    readonly editorDefaults = signal<{categoryId?: string; parentPageId?: string} | null>(null);
    /** Raised by `openEditor` for a new page; the wiki shell renders the picker. */
    readonly templatePickerOpen = signal(false);
    readonly guildId = signal<string>('');
    readonly pageLoading = signal(false);
    readonly pendingRemoteUpdate = signal<WikiPageDto | null>(null);
    private readonly wikiService = inject(WikiService);
    private readonly ws = inject(GuildWebsocketService);
    private readonly contentCache = inject(WikiContentCacheService);
    private readonly drafts = inject(WikiDraftsService);
    private readonly guildService = inject(GuildService);
    private readonly profileService = inject(ProfileService);

    /** What the member fetch reported. Null until it answers, so permissions fail closed. */
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    /** The id the member fetch reported, as a fallback before the profile has loaded. */
    private readonly memberUserId = signal<string | null>(null);

    private readonly guild = computed(
        () => this.guildService.guilds().find(g => g.id === this.guildId()) ?? null,
    );

    readonly ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? this.memberUserId());

    /** What this member may do here; starts at nothing until the fetch answers (fail closed), and is derived, not snapshotted, since ownership and the member row arrive asynchronously. */
    readonly abilities: Signal<WikiAbilities> = computed(() =>
        wikiAbilities(guildAbilities(this.ownMember(), this.guild(), this.ownUserId())),
    );
    private suppressNextPageRefresh = false;

    constructor() {
        this.ws.wikiPageCreatedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.ws.wikiPageUpdatedObservable.subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
            // A cache nothing invalidates goes stale, and stale bodies produce a backlink index pointing at links that are no longer there.
            this.contentCache.invalidate(e.pageId);

            // Consumed once, for both branches below.
            const affectsOpenPage =
                this.selectedPage()?.id === e.pageId || this.editingPage()?.id === e.pageId;
            if (affectsOpenPage && this.suppressNextPageRefresh) {
                this.suppressNextPageRefresh = false;
                return;
            }

            if (this.wikiView() === 'page' && this.selectedPage()?.id === e.pageId) {
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
                    error: () => {},
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
                // Opportunistic fill: the body is already in hand, so caching it here costs nothing.
                this.contentCache.put(page.id, page.content ?? '');
            },
            error: () => {
                this.pageLoading.set(false);
                this.openHome();
            },
        });
    }

    openEditor(
        page?: WikiPageDto,
        defaults?: {categoryId?: string; parentPageId?: string},
        options?: {skipTemplatePicker?: boolean},
    ): void {
        this.editingPage.set(page ?? null);
        this.editorDefaults.set(page ? null : (defaults ?? null));
        this.pendingRemoteUpdate.set(null);
        this.wikiView.set('editor');

        // Every new page, every time, except the AI entry points, where the dialog is the point and the picker would open behind it.
        this.templatePickerOpen.set(!page && !options?.skipTemplatePicker);
    }

    openHistory(): void {
        this.wikiView.set('history');
    }

    /** The link graph; clears the selected page so the context rail doesn't describe something no longer on screen. */
    openGraph(): void {
        this.selectedPage.set(null);
        this.pageLoading.set(false);
        this.wikiView.set('graph');
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
        // Our own write echoes back over the websocket; suppress the refetch or the in-flight `pageLoading` flashes a spinner for no new information.
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

    /** Disarms the flag when the write it was armed for never happened; a failed update produces no websocket event, so left armed it would swallow the next legitimate remote refresh. */
    clearPageRefreshSuppression(): void {
        this.suppressNextPageRefresh = false;
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

    /** Cleared before the fetch, not after: leaving the previous guild's answer live would show manage controls to a non-manager while the request is in flight. */
    private loadAbilities(guildId: string): void {
        this.ownMember.set(null);
        this.memberUserId.set(null);
        this.guildService.getOwnMember(guildId).subscribe({
            next: member => {
                this.ownMember.set(member);
                this.memberUserId.set(member.userId ?? null);
            },
            // Ownership is decided separately and reactively, so an owner keeps their abilities even when this fetch fails.
            error: () => this.ownMember.set(null),
        });
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
                    if (summary) this.selectedPage.update(p => (p ? mergeSummary(p, summary) : p));
                }
            }
        });
    }
}

/**
 * Refreshes the open page's metadata from the wiki listing without touching its body.
 * `content` is dropped on purpose: spreading the summary wholesale would overwrite the loaded body with `undefined`. Any future opt-in field on the summary needs the same treatment.
 */
export function mergeSummary(page: WikiPageDto, summary: WikiPageSummaryDto): WikiPageDto {
    const {content: _optIn, ...metadata} = summary;
    return {...page, ...metadata};
}
