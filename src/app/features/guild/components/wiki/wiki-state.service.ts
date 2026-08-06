import {computed, inject, Injectable, Signal, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiView} from './wiki.types';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {WikiDraftsService} from './wiki-drafts.service';
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

    /** What the member fetch reported. Zero until it answers, so permissions fail closed. */
    private readonly memberPermissions = signal<bigint>(0n);
    /** The id the member fetch reported, as a fallback before the profile has loaded. */
    private readonly memberUserId = signal<string | null>(null);

    readonly ownUserId = computed(() =>
        this.profileService.ownProfile()?.userId ?? this.memberUserId());

    /**
     * Derived, not snapshotted.
     *
     * This used to be read once, synchronously, at the moment the wiki mounted - and both of its
     * inputs arrive asynchronously. Opening a wiki before the profile or the guild list had landed
     * therefore decided you were not the owner, and since abilities were only reloaded when the
     * *guild id* changed, nothing ever revisited it: the owner of a guild would intermittently see
     * no Edit and no New Page at all. As a computed it simply corrects itself when the data lands.
     */
    private readonly isOwner = computed(() => {
        const ownUserId = this.ownUserId();
        if (!ownUserId) return false;
        return this.guildService.guilds().find(g => g.id === this.guildId())?.ownerId === ownUserId;
    });

    /**
     * What this member may do here. Starts at nothing and stays there until the fetch answers,
     * so a control is never briefly offered to somebody who turns out not to hold the permission.
     */
    readonly abilities: Signal<WikiAbilities> = computed(() =>
        wikiAbilities(this.memberPermissions(), this.isOwner()));
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

            // Consumed once, for both branches below. It used to guard only the reading branch,
            // so a metadata write made from the rail while editing your own page came back as a
            // `pendingRemoteUpdate` - the wiki telling you somebody else had edited underneath
            // you, about your own pin.
            const affectsOpenPage = this.selectedPage()?.id === e.pageId
                || this.editingPage()?.id === e.pageId;
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

    openEditor(
        page?: WikiPageDto,
        defaults?: { categoryId?: string; parentPageId?: string },
        options?: { skipTemplatePicker?: boolean },
    ): void {
        this.editingPage.set(page ?? null);
        this.editorDefaults.set(page ? null : (defaults ?? null));
        this.pendingRemoteUpdate.set(null);
        this.wikiView.set('editor');

        // Every new page, every time - the only exception being the AI entry points, where the
        // dialog is the point and the picker would open behind it.
        //
        // This used to also bow out whenever an unsaved "new page" draft existed, to avoid
        // stacking the restore bar on top of the picker. That made the picker's appearance
        // unpredictable in a way nothing on screen explained: abandon one new page without
        // saving, and every subsequent new page silently skipped the picker until that draft
        // aged out. Choosing a template now clears that draft instead, which is an explicit act
        // by the user and undoable like any other edit.
        this.templatePickerOpen.set(!page && !options?.skipTemplatePicker);
    }

    openHistory(): void {
        this.wikiView.set('history');
    }

    /**
     * The link graph. Clears the selected page: the graph is a view of the whole wiki, and leaving
     * a page selected would keep the context rail describing something no longer on screen.
     */
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

    /**
     * Disarms the flag when the write it was armed for never happened.
     *
     * A failed update produces no websocket event, so the suppression would sit there and swallow
     * the next legitimate remote refresh instead - the one case where the user genuinely needs to
     * be told the page moved under them.
     */
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

    /**
     * Cleared before the fetch, not after: leaving the previous guild's answer live while the
     * new request is in flight would show manage controls to a non-manager for the duration,
     * and for the whole session if that request fails. Same guard the events panel uses.
     */
    private loadAbilities(guildId: string): void {
        this.memberPermissions.set(0n);
        this.memberUserId.set(null);
        this.guildService.getOwnMember(guildId).subscribe({
            next: member => {
                this.memberPermissions.set(effectiveGuildPermissions(member));
                this.memberUserId.set(member.userId ?? null);
            },
            // Ownership is decided separately and reactively, so an owner keeps their abilities
            // even when this fetch fails - denying them would lock them out of their own wiki.
            error: () => this.memberPermissions.set(0n),
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
