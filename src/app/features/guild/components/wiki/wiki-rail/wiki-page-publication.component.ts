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
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {
    isPagePublished,
    WikiPageDto,
    WikiVisibility,
    withPagePublished,
} from '../../../../../dtos/response/wiki.dto';
import {
    isWikiPublishFailure,
    WikiPublicationService,
    WikiPublishStep,
} from '../../../../../services/wiki-publication.service';
import {WikiStateService} from '../wiki-state.service';
import {ToastService} from '../../../../../services/toast.service';
import {LinkOpener} from '../../../../../platform/ports/link-opener.port';
import {publicWikiUrl} from '../wiki-slug';
import {canEditPage} from '../wiki-permissions';
import {coverHost, publishRefusal, WikiPublishRefusal} from '../wiki-publish/wiki-publish-refusal';
import {WikiPublishConsentComponent} from '../wiki-publish/wiki-publish-consent.component';

/**
 * Whether this page is on the public host, from the page itself rather than from settings. Says
 * what the other half of the answer is when the wiki has no address, instead of offering a switch
 * that would silently do nothing.
 */
@Component({
    selector: 'app-wiki-page-publication',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, ToggleSwitch, TranslateModule, WikiPublishConsentComponent],
    template: `
        @if (page(); as target) {
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-[0.6875rem] text-text-muted">{{
                        'WIKI_PUBLISH.RAIL.LABEL' | translate
                    }}</span>
                    @if (canPublish()) {
                        <p-toggleswitch
                            (ngModelChange)="setPublished($event)"
                            [ariaLabel]="'WIKI_PUBLISH.RAIL.ARIA' | translate"
                            [disabled]="saving()"
                            [ngModel]="switchOn()"
                        />
                    } @else {
                        <i
                            [class.pi-globe]="published()"
                            [class.pi-lock]="!published()"
                            [class.text-online]="published() && isLive()"
                            [class.text-text-faint]="!published() || !isLive()"
                            class="pi text-[0.75rem]"
                        ></i>
                    }
                </div>

                @if (published() && isPrivate()) {
                    <!-- Opted in and unreachable: the guild-facing flag vetoes the public one. -->
                    <p class="m-0 text-[0.6875rem] leading-snug text-connecting">
                        {{ 'WIKI_PUBLISH.RAIL.BLOCKED_PRIVATE' | translate }}
                    </p>
                } @else if (published() && liveUrl(); as url) {
                    <button
                        (click)="open(url)"
                        class="cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-[0.6875rem] text-brand-dim hover:underline"
                        type="button"
                    >
                        {{ url }}
                    </button>
                } @else if (published()) {
                    <p class="m-0 text-[0.6875rem] leading-snug text-connecting">
                        {{ 'WIKI_PUBLISH.RAIL.NEEDS_ADDRESS' | translate }}
                    </p>
                } @else if (isPrivate()) {
                    <p class="m-0 text-[0.6875rem] leading-snug text-text-faint">
                        {{ 'WIKI_PUBLISH.RAIL.PRIVATE_PAGE' | translate }}
                    </p>
                } @else {
                    <p class="m-0 text-[0.6875rem] leading-snug text-text-faint">
                        {{ 'WIKI_PUBLISH.RAIL.PRIVATE' | translate }}
                    </p>
                }

                <!-- The refusals, in place: each one is about this page and names what would fix it. -->
                @if (refusal() === 'private') {
                    <div
                        class="flex flex-col gap-2 rounded-lg border border-connecting/25 bg-connecting/[0.07] px-2.5 py-2"
                    >
                        <p class="m-0 text-[0.6875rem] leading-snug text-text-secondary">
                            {{ 'WIKI_PUBLISH.REFUSED.PRIVATE' | translate }}
                        </p>
                        @if (canOpenToGuild()) {
                            <button
                                (click)="openConsent()"
                                class="w-full cursor-pointer rounded-md border border-white/[0.12] bg-transparent px-2 py-1 text-[0.6875rem] font-medium text-text-primary hover:border-white/25 hover:bg-hover"
                                type="button"
                            >
                                {{ 'WIKI_PUBLISH.REFUSED.PRIVATE_FIX' | translate }}
                            </button>
                        } @else {
                            <p class="m-0 text-[0.6875rem] leading-snug text-text-muted">
                                {{ 'WIKI_PUBLISH.REFUSED.PRIVATE_NO_RIGHTS' | translate }}
                            </p>
                        }
                    </div>
                } @else if (refusal() === 'cover') {
                    <div class="rounded-lg border border-connecting/25 bg-connecting/[0.07] px-2.5 py-2">
                        <p class="m-0 text-[0.6875rem] leading-snug text-text-secondary">
                            @if (refusedCoverHost(); as host) {
                                {{ 'WIKI_PUBLISH.REFUSED.COVER' | translate: {host: host} }}
                            } @else {
                                {{ 'WIKI_PUBLISH.REFUSED.COVER_UNKNOWN_HOST' | translate }}
                            }
                        </p>
                    </div>
                }

                @if (halfDone()) {
                    <p class="m-0 text-[0.6875rem] leading-snug text-text-secondary">
                        {{ 'WIKI_PUBLISH.HALF_DONE' | translate }}
                    </p>
                }

                @if (failed()) {
                    <p class="m-0 text-[0.6875rem] text-rose-400/80">
                        {{ 'WIKI.RAIL.SAVE_FAILED' | translate }}
                    </p>
                }
            </div>

            @if (consentOpen()) {
                <app-wiki-publish-consent
                    (confirmed)="confirmPublish()"
                    (dismissed)="closeConsent()"
                    [failedStep]="consentFailedStep()"
                    [title]="target.title"
                    [url]="liveUrl()"
                    [working]="consentWorking()"
                />
            }
        }
    `,
})
export class WikiPagePublicationComponent {
    readonly guildId = input.required<string>();
    readonly page = input<WikiPageDto | null>(null);

    private readonly publication = inject(WikiPublicationService);
    private readonly state = inject(WikiStateService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly links = inject(LinkOpener);

    protected readonly saving = signal(false);
    protected readonly failed = signal(false);
    protected readonly refusal = signal<WikiPublishRefusal | null>(null);
    /** Set when the guild half of a two-step publish landed and the public half did not. */
    protected readonly halfDone = signal(false);

    protected readonly consentOpen = signal(false);
    protected readonly consentWorking = signal(false);
    protected readonly consentFailedStep = signal<WikiPublishStep | null>(null);

    private lastPageId: string | null = null;

    protected readonly canPublish = computed(() => this.state.abilities().canPublish);
    protected readonly published = computed(() => isPagePublished(this.page()));
    protected readonly isPrivate = computed(() => this.page()?.visibility === 'private');
    protected readonly isLive = computed(() => this.publication.isPublished(this.guildId()));

    /** The switch stays down while the question is on screen, and comes back up if it is declined. */
    protected readonly switchOn = computed(() => this.published() || this.consentOpen());

    /** Opening the page to the guild is an edit, so publishing out of private needs both rights. */
    protected readonly canOpenToGuild = computed(() => {
        const page = this.page();
        return !!page && canEditPage(this.state.abilities(), page.authorId, this.state.ownUserId());
    });

    protected readonly refusedCoverHost = computed(() => coverHost(this.page()?.coverUrl));

    protected readonly liveUrl = computed(() => {
        const slug = this.publication.slug(this.guildId());
        const page = this.page();
        if (!slug || !page) return null;
        return `${publicWikiUrl(slug, this.publication.host(this.guildId()))}/${page.slug}`;
    });

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => this.publication.ensureLoaded(guildId));
        });

        // Keyed on the id, not the object: the wiki listing replaces the page on every refresh, and
        // clearing on that would wipe a refusal out from under whoever is reading it.
        effect(() => {
            const pageId = this.page()?.id ?? null;
            untracked(() => {
                if (pageId === this.lastPageId) return;
                this.lastPageId = pageId;
                this.clearNotices();
            });
        });
    }

    protected open(url: string): void {
        void this.links.open(url);
    }

    protected setPublished(published: boolean): void {
        const page = this.page();
        if (!page) return;
        this.clearNotices();

        // Asked before it is attempted: publishing this page changes who in the guild can read it too.
        if (published && page.visibility === 'private') {
            this.openConsent();
            return;
        }

        this.saving.set(true);
        this.patch(page.id, published);

        this.publication.setPagePublished(this.guildId(), page.id, published).subscribe({
            next: () => this.saving.set(false),
            error: (err: unknown) => {
                this.saving.set(false);
                this.patch(page.id, !published);

                const refusal = publishRefusal(err);
                if (refusal) {
                    this.refusal.set(refusal);
                    return;
                }

                this.failed.set(true);
                this.toast.error(this.translate.instant('WIKI_PUBLISH.PAGE_FAILED'));
            },
        });
    }

    protected openConsent(): void {
        this.consentFailedStep.set(null);
        this.consentOpen.set(true);
    }

    protected closeConsent(): void {
        if (this.consentWorking()) return;
        // Closing on a refused second write leaves the first one standing, so the panel keeps saying so.
        this.halfDone.set(this.consentFailedStep() === 'publish');
        this.consentOpen.set(false);
        this.consentFailedStep.set(null);
    }

    protected confirmPublish(): void {
        const page = this.page();
        if (!page) return;

        // A retry after the guild half already landed needs only the public half.
        const retryingPublish = this.consentFailedStep() === 'publish';
        const request = retryingPublish
            ? this.publication.publishOnly(this.guildId(), page.id)
            : this.publication.publishFromPrivate(this.guildId(), page.id);

        this.consentWorking.set(true);
        this.refusal.set(null);
        this.halfDone.set(false);
        // The visibility write comes back over the websocket; without this the article blinks
        // through a spinner for a change already on screen.
        if (!retryingPublish) this.state.suppressPageRefreshOnce();

        request.subscribe({
            next: () => {
                this.consentWorking.set(false);
                this.consentOpen.set(false);
                this.consentFailedStep.set(null);
                this.patch(page.id, true, 'public');
                this.toast.success(this.translate.instant('WIKI_PUBLISH.CONSENT.DONE'));
            },
            error: (err: unknown) => {
                this.consentWorking.set(false);
                const step = isWikiPublishFailure(err) ? err.step : 'publish';
                if (step === 'publish') this.patch(page.id, false, 'public');

                // A cover the instance does not host refuses every retry, so the dialog steps aside
                // for the panel that can actually say what to change.
                const refusal = isWikiPublishFailure(err) ? publishRefusal(err.error) : null;
                if (refusal === 'cover') {
                    this.consentOpen.set(false);
                    this.consentFailedStep.set(null);
                    this.refusal.set('cover');
                    this.halfDone.set(true);
                    return;
                }

                this.consentFailedStep.set(step);
            },
        });
    }

    private clearNotices(): void {
        this.failed.set(false);
        this.refusal.set(null);
        this.halfDone.set(false);
    }

    /** Both the open page and its row in the tree, so the nav's public marker follows immediately. */
    private patch(pageId: string, published: boolean, visibility?: WikiVisibility): void {
        const selected = this.state.selectedPage();
        if (selected?.id === pageId) {
            const next = withPagePublished(selected, published);
            this.state.selectedPage.set(visibility ? {...next, visibility} : next);
        }

        this.state.updateWikiOptimistic(wiki => ({
            ...wiki,
            pages: wiki.pages.map(p => {
                if (p.id !== pageId) return p;
                const next = withPagePublished(p, published);
                return visibility ? {...next, visibility} : next;
            }),
        }));
    }
}
