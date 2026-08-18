import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto, GuildKind} from '../../../../../../dtos/response/guild.dto';
import {
    isPagePublished,
    WikiPageSummaryDto,
    WikiVisibility,
    withPagePublished,
} from '../../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../../services/wiki.service';
import {
    isSlugTaken,
    isWikiPublishFailure,
    WikiPublicationService,
    WikiPublishStep,
} from '../../../../../../services/wiki-publication.service';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {LinkOpener} from '../../../../../../platform/ports/link-opener.port';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {guildAbilities} from '../../../../guild-permissions';
import {canEditPage, wikiAbilities} from '../../../wiki/wiki-permissions';
import {coverHost, publishRefusal, WikiPublishRefusal} from '../../../wiki/wiki-publish/wiki-publish-refusal';
import {WikiPublishConsentComponent} from '../../../wiki/wiki-publish/wiki-publish-consent.component';
import {
    checkSlug,
    normaliseSlugInput,
    publicWikiHost,
    publicWikiUrl,
    SLUG_MAX_LENGTH,
    slugifyName,
    slugSuggestions,
} from '../../../wiki/wiki-slug';

/**
 * The keys chosen in code rather than written in the template, so `i18n-keys.spec.ts` can check
 * them: its patterns only see a literal piped to `translate`.
 */
export const WIKI_PUBLISH_STATUS_KEYS: readonly string[] = [
    'WIKI_PUBLISH.STATUS.OFFLINE',
    'WIKI_PUBLISH.STATUS.NO_PAGES',
    'WIKI_PUBLISH.STATUS.LIVE',
    'WIKI_PUBLISH.STATUS.LIVE_ONE',
    'WIKI_PUBLISH.PAGES_WAITING',
    'WIKI_PUBLISH.PAGES_WAITING_ONE',
    'WIKI_PUBLISH.OFFLINE_BODY',
    'WIKI_PUBLISH.OFFLINE_BODY_ONE',
    'WIKI_PUBLISH.OFFLINE_BODY_NONE',
];

/** Publishing the guild's wiki to the public internet, and choosing which pages go with it. */
@Component({
    selector: 'app-wiki-settings',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        Button,
        InputText,
        Dialog,
        ToggleSwitch,
        PrimeTemplate,
        TranslateModule,
        WikiPublishConsentComponent,
    ],
    templateUrl: './wiki-settings.component.html',
})
export class WikiSettingsComponent {
    readonly guild = input.required<GuildDto>();

    protected readonly publication = inject(WikiPublicationService);
    private readonly wikiService = inject(WikiService);
    private readonly guilds = inject(GuildService);
    private readonly profiles = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly links = inject(LinkOpener);

    protected readonly slugMaxLength = SLUG_MAX_LENGTH;

    protected readonly slug = signal('');
    protected readonly saving = signal(false);
    protected readonly takingOffline = signal(false);
    protected readonly confirmOffline = signal(false);
    /** The slug the server refused. Cleared the moment the field changes. */
    protected readonly takenSlug = signal<string | null>(null);
    protected readonly pages = signal<WikiPageSummaryDto[]>([]);
    protected readonly pagesLoading = signal(false);
    protected readonly pageQuery = signal('');
    protected readonly busyPageId = signal<string | null>(null);
    /** The row the server refused, and why. One at a time: it is answered before the next attempt. */
    protected readonly refusedPageId = signal<string | null>(null);
    protected readonly refusal = signal<WikiPublishRefusal | null>(null);
    /** The row whose guild half landed and whose public half did not. */
    protected readonly halfDonePageId = signal<string | null>(null);

    protected readonly consentPage = signal<WikiPageSummaryDto | null>(null);
    protected readonly consentWorking = signal(false);
    protected readonly consentFailedStep = signal<WikiPublishStep | null>(null);

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    /** Slugs this session has already been told are taken, so a suggestion is never re-offered. */
    private readonly knownTaken = signal<string[]>([]);
    /** The guild whose field has already been seeded. */
    private seededFor: string | null = null;

    protected readonly isHousehold = computed(() => this.guild().kind === GuildKind.Household);

    private readonly abilities = computed(() =>
        wikiAbilities(guildAbilities(this.ownMember(), this.guild(), this.profiles.ownProfile()?.userId)),
    );

    protected readonly canPublish = computed(() => this.abilities().canPublish);

    protected readonly host = computed(() => this.publication.host(this.guild().id));
    protected readonly liveSlug = computed(() => this.publication.slug(this.guild().id));
    protected readonly isLive = computed(() => !!this.liveSlug());

    protected readonly check = computed(() => checkSlug(this.slug()));
    protected readonly grammarError = computed(() => this.check().messageKey);

    /** The address as it will read, updated on every keystroke: the point is that it is a real place. */
    protected readonly previewHost = computed(() =>
        this.check().valid ? publicWikiHost(this.slug(), this.host()) : null,
    );

    protected readonly liveUrl = computed(() => {
        const slug = this.liveSlug();
        return slug ? publicWikiUrl(slug, this.host()) : null;
    });

    protected readonly suggestions = computed(() => {
        const taken = this.takenSlug();
        if (!taken) return [];
        return slugSuggestions(this.guild().name, taken, this.knownTaken());
    });

    protected readonly dirty = computed(() => this.slug() !== (this.liveSlug() ?? ''));

    protected readonly canSave = computed(
        () => this.check().valid && this.dirty() && !this.takenSlug() && !this.saving(),
    );

    protected readonly publishedPages = computed(() => this.pages().filter(isPagePublished));

    /// The template cannot reach a module-level function.
    protected readonly isPagePublished = isPagePublished;

    protected readonly visiblePages = computed(() => {
        const query = this.pageQuery().trim().toLowerCase();
        const rows = [...this.pages()].sort((a, b) => a.title.localeCompare(b.title));
        return query ? rows.filter(p => p.title.toLowerCase().includes(query)) : rows;
    });

    /**
     * The one sentence that answers "is anything actually public right now". The keys are literal
     * rather than assembled, so `i18n-keys.spec.ts` can see every one of them.
     */
    protected readonly statusKey = computed(() => {
        if (!this.isLive()) return 'WIKI_PUBLISH.STATUS.OFFLINE';
        const count = this.publishedPages().length;
        if (!count) return 'WIKI_PUBLISH.STATUS.NO_PAGES';
        return count === 1 ? 'WIKI_PUBLISH.STATUS.LIVE_ONE' : 'WIKI_PUBLISH.STATUS.LIVE';
    });

    protected readonly waitingKey = computed(() =>
        this.publishedPages().length === 1 ? 'WIKI_PUBLISH.PAGES_WAITING_ONE' : 'WIKI_PUBLISH.PAGES_WAITING',
    );

    protected readonly offlineBodyKey = computed(() => {
        const count = this.publishedPages().length;
        if (!count) return 'WIKI_PUBLISH.OFFLINE_BODY_NONE';
        return count === 1 ? 'WIKI_PUBLISH.OFFLINE_BODY_ONE' : 'WIKI_PUBLISH.OFFLINE_BODY';
    });

    constructor() {
        effect(() => {
            const guildId = this.guild().id;
            untracked(() => {
                this.publication.ensureLoaded(guildId);
                this.loadPages(guildId);
                this.guilds.getOwnMember(guildId).subscribe({
                    next: member => this.ownMember.set(member),
                    error: () => this.ownMember.set(null),
                });
            });
        });

        // Pre-filled rather than placeholdered: somebody happy with the suggestion should be able
        // to press Publish without touching the field. Seeded once per guild, so a refresh landing
        // mid-edit cannot overwrite what is being typed.
        effect(() => {
            const guildId = this.guild().id;
            // Gated on the read having landed, not merely on it having stopped: seeding early
            // would put the slugified name over a wiki that is already published under another.
            const loaded = this.publication.publication(guildId);
            const name = this.guild().name;
            untracked(() => {
                if (!loaded || this.seededFor === guildId) return;
                this.seededFor = guildId;
                this.slug.set(loaded.slug ?? slugifyName(name));
            });
        });
    }

    protected onSlugInput(raw: string): void {
        this.slug.set(normaliseSlugInput(raw));
        this.takenSlug.set(null);
    }

    protected useSuggestion(suggestion: string): void {
        this.slug.set(suggestion);
        this.takenSlug.set(null);
    }

    protected save(): void {
        if (!this.canSave()) return;
        const guildId = this.guild().id;
        const attempted = this.slug();

        this.saving.set(true);
        this.publication.setSlug(guildId, attempted).subscribe({
            next: () => {
                this.saving.set(false);
                this.toast.success(this.translate.instant('WIKI_PUBLISH.PUBLISHED_TOAST'));
            },
            error: (err: unknown) => {
                this.saving.set(false);
                // The expected answer for any guild with a common name, so it lands on the field
                // rather than in a toast that would take what they typed with it.
                if (isSlugTaken(err)) {
                    this.takenSlug.set(attempted);
                    this.knownTaken.update(rows => [...new Set([...rows, attempted])]);
                    return;
                }
                this.toast.httpError(this.translate.instant('WIKI_PUBLISH.SAVE_FAILED'), err);
            },
        });
    }

    protected takeOffline(): void {
        const guildId = this.guild().id;
        this.takingOffline.set(true);
        this.publication.setSlug(guildId, null).subscribe({
            next: () => {
                this.takingOffline.set(false);
                this.confirmOffline.set(false);
                this.slug.set(slugifyName(this.guild().name));
                this.takenSlug.set(null);
                this.toast.success(this.translate.instant('WIKI_PUBLISH.OFFLINE_TOAST'));
            },
            error: (err: unknown) => {
                this.takingOffline.set(false);
                this.toast.httpError(this.translate.instant('WIKI_PUBLISH.OFFLINE_FAILED'), err);
            },
        });
    }

    protected setPagePublished(page: WikiPageSummaryDto, published: boolean): void {
        const guildId = this.guild().id;
        this.clearRefusal();

        // Asked before it is attempted: publishing this page opens it to the whole server too.
        if (published && page.visibility === 'private') {
            this.openConsent(page);
            return;
        }

        this.busyPageId.set(page.id);
        // Optimistic: the switch has already moved, and putting it back on failure is clearer
        // than leaving it inert while the write is in flight.
        this.patchPage(page.id, published);

        this.publication.setPagePublished(guildId, page.id, published).subscribe({
            next: () => this.busyPageId.set(null),
            error: (err: unknown) => {
                this.busyPageId.set(null);
                this.patchPage(page.id, !published);

                const refusal = publishRefusal(err);
                if (refusal) {
                    // In the row rather than in a toast: the answer is about this page.
                    this.refusedPageId.set(page.id);
                    this.refusal.set(refusal);
                    return;
                }

                this.toast.httpError(this.translate.instant('WIKI_PUBLISH.PAGE_FAILED'), err);
            },
        });
    }

    /** Opening a page to the guild is an edit, so publishing out of private needs both rights. */
    protected canOpenToGuild(page: WikiPageSummaryDto): boolean {
        return canEditPage(this.abilities(), page.authorId, this.profiles.ownProfile()?.userId ?? null);
    }

    protected coverHostOf(page: WikiPageSummaryDto): string | null {
        return coverHost(page.coverUrl);
    }

    protected openConsent(page: WikiPageSummaryDto): void {
        this.clearRefusal();
        this.consentFailedStep.set(null);
        this.consentPage.set(page);
    }

    /** Down while the question is on screen, so declining brings it back up. */
    protected switchOn(page: WikiPageSummaryDto): boolean {
        return isPagePublished(page) || this.consentPage()?.id === page.id;
    }

    protected closeConsent(): void {
        if (this.consentWorking()) return;
        // Closing on a refused second write leaves the first one standing, so the row keeps saying so.
        const page = this.consentPage();
        if (page && this.consentFailedStep() === 'publish') this.halfDonePageId.set(page.id);
        this.consentPage.set(null);
        this.consentFailedStep.set(null);
    }

    protected confirmPublish(): void {
        const page = this.consentPage();
        if (!page) return;

        const retryingPublish = this.consentFailedStep() === 'publish';
        const request = retryingPublish
            ? this.publication.publishOnly(this.guild().id, page.id)
            : this.publication.publishFromPrivate(this.guild().id, page.id);

        this.consentWorking.set(true);

        request.subscribe({
            next: () => {
                this.consentWorking.set(false);
                this.consentPage.set(null);
                this.consentFailedStep.set(null);
                this.patchPage(page.id, true, 'public');
                this.toast.success(this.translate.instant('WIKI_PUBLISH.CONSENT.DONE'));
            },
            error: (err: unknown) => {
                this.consentWorking.set(false);
                const step = isWikiPublishFailure(err) ? err.step : 'publish';
                if (step === 'publish') this.patchPage(page.id, false, 'public');

                // A cover the instance does not host refuses every retry, so the row says what to change.
                const refusal = isWikiPublishFailure(err) ? publishRefusal(err.error) : null;
                if (refusal === 'cover') {
                    this.consentPage.set(null);
                    this.consentFailedStep.set(null);
                    this.refusedPageId.set(page.id);
                    this.refusal.set('cover');
                    this.halfDonePageId.set(page.id);
                    return;
                }

                this.consentFailedStep.set(step);
            },
        });
    }

    protected clearRefusal(): void {
        this.refusedPageId.set(null);
        this.refusal.set(null);
        this.halfDonePageId.set(null);
    }

    protected openLive(): void {
        const url = this.liveUrl();
        if (url) void this.links.open(url);
    }

    protected copyLive(): void {
        const url = this.liveUrl();
        if (!url) return;
        void navigator.clipboard
            .writeText(url)
            .then(() => this.toast.success(this.translate.instant('WIKI_PUBLISH.COPIED')))
            .catch(() => this.toast.error(this.translate.instant('WIKI_PUBLISH.COPY_FAILED')));
    }

    protected pageUrl(page: WikiPageSummaryDto): string | null {
        const slug = this.liveSlug();
        return slug ? `${publicWikiUrl(slug, this.host())}/${page.slug}` : null;
    }

    private patchPage(pageId: string, published: boolean, visibility?: WikiVisibility): void {
        this.pages.update(rows =>
            rows.map(p => {
                if (p.id !== pageId) return p;
                const next = withPagePublished(p, published);
                return visibility ? {...next, visibility} : next;
            }),
        );
    }

    private loadPages(guildId: string): void {
        this.pagesLoading.set(true);
        this.wikiService.getWiki(guildId).subscribe({
            next: wiki => {
                this.pages.set(wiki.pages);
                this.pagesLoading.set(false);
            },
            error: () => this.pagesLoading.set(false),
        });
    }
}
