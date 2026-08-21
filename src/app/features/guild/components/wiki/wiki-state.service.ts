import {computed, inject, Injectable, Signal, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiView} from './wiki.types';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {WikiGraphSourceService} from './wiki-graph/wiki-graph-source.service';
import {WikiDraftsService} from './wiki-drafts.service';
import {wikiAbilities, WikiAbilities} from './wiki-permissions';
import {guildAbilities} from '../../guild-permissions';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';

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
    /** True when the tree fetch failed. Without it an errored load is indistinguishable from an empty wiki. */
    readonly wikiLoadFailed = signal(false);
    private readonly wikiService = inject(WikiService);
    private readonly realtime = inject(RealtimeConnectionService);
    private readonly contentCache = inject(WikiContentCacheService);
    private readonly graphSource = inject(WikiGraphSourceService);
    private readonly drafts = inject(WikiDraftsService);
    private readonly guildService = inject(GuildService);
    private readonly profileService = inject(ProfileService);

    /** What the member fetch reported. Null until it answers, so permissions fail closed. */
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    /** The id the member fetch reported, as a fallback before the profile has loaded. */
    private readonly memberUserId = signal<string | null>(null);
    /** False while the member fetch is in flight. Anything that branches on `abilities` rather than merely hiding a control has to wait for this, or it reads the fail-closed value. */
    readonly abilitiesResolved = signal(false);

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
        this.realtime.stream('guild.WikiPageCreated').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
            this.graphChanged();
        });

        this.realtime.stream('guild.WikiPageUpdated').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
            // A cache nothing invalidates goes stale, and stale bodies produce a backlink index pointing at links that are no longer there.
            this.contentCache.invalidate(e.pageId);
            this.graphChanged();

            // Consumed once, for both branches below.
            const affectsOpenPage =
                this.selectedPage()?.id === e.pageId || this.editingPage()?.id === e.pageId;
            if (affectsOpenPage && this.suppressNextPageRefresh) {
                this.suppressNextPageRefresh = false;
                return;
            }

            this.rereadOpenPage(e.pageId);
        });

        // A character page is an ordinary wiki page, but neither its creation nor a pull into it
        // sends a wiki event: only these two say the tree and the body moved.
        this.realtime.stream('guild.PersonaPageCreated').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.realtime.stream('guild.PersonaPagePulled').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
            this.contentCache.invalidate(e.pageId);
            this.graphChanged();
            this.rereadOpenPage(e.pageId);
        });

        this.realtime.stream('guild.WikiPageDeleted').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.contentCache.invalidate(e.pageId);
            this.graphChanged();
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

        this.realtime.stream('guild.WikiCategoryCreated').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.realtime.stream('guild.WikiCategoryUpdated').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });

        this.realtime.stream('guild.WikiCategoryDeleted').subscribe(e => {
            if (e.guildId !== this.guildId()) return;
            this.loadWiki(this.guildId());
        });
    }

    /** Reads a page again wherever it is open: straight into the view, or as a prompt in the editor. */
    private rereadOpenPage(pageId: string): void {
        if (this.wikiView() === 'page' && this.selectedPage()?.id === pageId) {
            this.pageLoading.set(true);
            this.wikiService.getPage(this.guildId(), pageId).subscribe({
                next: page => {
                    this.selectedPage.set(page);
                    this.pageLoading.set(false);
                },
                error: () => this.pageLoading.set(false),
            });
        }

        if (this.wikiView() === 'editor' && this.editingPage()?.id === pageId) {
            this.wikiService.getPage(this.guildId(), pageId).subscribe({
                next: page => this.pendingRemoteUpdate.set(page),
                error: () => {},
            });
        }
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
        this.abilitiesResolved.set(false);
        this.guildService.getOwnMember(guildId).subscribe({
            next: member => {
                this.ownMember.set(member);
                this.memberUserId.set(member.userId ?? null);
                this.abilitiesResolved.set(true);
            },
            // Ownership is decided separately and reactively, so an owner keeps their abilities even when this fetch fails.
            error: () => {
                this.ownMember.set(null);
                this.abilitiesResolved.set(true);
            },
        });
    }

    private loadWiki(guildId: string, navigateTo?: WikiPageDto): void {
        this.wikiService.getWikiTree(guildId).subscribe({
            next: wiki => {
                this.wikiLoadFailed.set(false);
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
            },
            // `wiki` keeps whatever it held: a failed refresh must not blank a tree the user is reading.
            error: () => {
                this.wikiLoadFailed.set(true);
                this.pageLoading.set(false);
            },
        });
    }

    /** The link graph moved. Refreshes the shared source so the home preview follows live edits. */
    private graphChanged(): void {
        this.graphSource.refresh(this.guildId());
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
