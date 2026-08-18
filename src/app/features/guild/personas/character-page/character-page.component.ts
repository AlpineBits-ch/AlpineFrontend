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
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../persona-avatar/persona-avatar.component';
import {PersonaService} from '../../../../services/persona.service';
import {ProfileService} from '../../../../services/profile.service';
import {ProfilePopoutService} from '../../../../services/profile-popout.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {WikiDeepLinkService} from '../../components/wiki/wiki-share/wiki-deep-link.service';
import {renderWikiMarkdown} from '../../components/wiki/wiki.utils';
import {WikiPageDto} from '../../../../dtos/response/wiki.dto';
import {PersonaPagePullStrategy, PersonaUpstreamState} from '../../../../dtos/response/persona.dto';
import {personaCoverGradient, personaIdentity} from '../persona-identity';
import {approvalMeta} from '../persona-approval';
import {
    infoboxEditFields,
    InfoboxValues,
    parseInfoboxTemplate,
    parseInfoboxValues,
    renderInfobox,
    serialiseInfoboxValues,
} from '../persona-infobox';

/**
 * A character's page: the wiki page it is, with the structured half drawn as an infobox. The prose
 * is edited in the wiki, which already has an editor; only the infobox is edited here, because the
 * wiki editor has nowhere to put it.
 */
@Component({
    selector: 'app-character-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [PersonaAvatarComponent, TranslateModule, Button, Dialog, PrimeTemplate, FormsModule],
    templateUrl: './character-page.component.html',
    styleUrl: './character-page.component.css',
    host: {class: 'flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden'},
})
export class CharacterPageComponent {
    readonly guildId = input.required<string>();
    readonly personaId = input.required<string>();

    private readonly personas = inject(PersonaService);
    private readonly profiles = inject(ProfileService);
    private readonly sanitizer = inject(DomSanitizer);
    private readonly deepLink = inject(WikiDeepLinkService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    protected readonly popout = inject(ProfilePopoutService);
    protected readonly nav = inject(NavigationService);

    protected readonly page = signal<WikiPageDto | null>(null);
    protected readonly loading = signal(false);
    protected readonly creating = signal(false);
    protected readonly pulling = signal(false);
    protected readonly infoboxOpen = signal(false);
    protected readonly infoboxDraft = signal<InfoboxValues>({});
    protected readonly savingInfobox = signal(false);
    private readonly templateJson = signal<string | null>(null);
    private readonly categories = signal<{id: string; infoboxTemplateJson?: string | null}[]>([]);

    protected readonly entry = computed(() => this.personas.entry(this.guildId(), this.personaId()));
    protected readonly identity = computed(() => {
        const entry = this.entry();
        return entry ? personaIdentity(entry) : null;
    });

    protected readonly approval = computed(() => {
        const entry = this.entry();
        return entry ? approvalMeta(entry.approvalState) : null;
    });

    protected readonly owner = computed(() => {
        const ownerId = this.entry()?.persona.ownerUserId;
        return ownerId ? this.profiles.getCachedByUserId(ownerId) : null;
    });

    protected readonly ownerId = computed(() => this.entry()?.persona.ownerUserId ?? null);

    protected readonly cover = computed(() => this.page()?.coverUrl ?? null);

    protected readonly coverGradient = computed(() => personaCoverGradient(this.identity()?.color ?? null));

    protected readonly body = computed((): SafeHtml | null => {
        const content = this.page()?.content?.trim();
        return content ? renderWikiMarkdown(content, this.sanitizer) : null;
    });

    protected readonly infobox = computed(() =>
        renderInfobox(this.templateJson(), this.page()?.infoboxJson, this.identity()?.name ?? null),
    );

    protected readonly hasInfobox = computed(
        () => this.infobox().sections.length > 0 && !this.infobox().isEmpty,
    );

    protected readonly infoboxFields = computed(() =>
        infoboxEditFields(parseInfoboxTemplate(this.templateJson())),
    );

    protected readonly tags = computed(() => this.page()?.tags ?? []);

    protected readonly upstream = computed(() => {
        const state = this.entry()?.upstreamState;
        return state && state !== PersonaUpstreamState.Current ? state : null;
    });

    /** A page with no body, no infobox and no cover. Drawn as an invitation, not as a broken page. */
    protected readonly isBare = computed(() => !this.body() && !this.hasInfobox() && !this.cover());

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.personas.ensureCast(guildId);
                this.personas.listCategories(guildId).subscribe({
                    // One category carries the character template; the page names which.
                    next: categories => this.categories.set(categories),
                    error: () => undefined,
                });
            });
        });

        effect(() => {
            const guildId = this.guildId();
            const pageId = this.entry()?.wikiPageId;
            // A pull rewrites the page under the same id, so the version is what says to read again.
            this.personas.pageVersion(pageId);
            untracked(() => {
                if (!pageId) {
                    this.page.set(null);
                    return;
                }
                this.loading.set(true);
                this.personas.getPage(guildId, pageId).subscribe({
                    next: page => {
                        this.page.set(page);
                        this.loading.set(false);
                    },
                    error: () => this.loading.set(false),
                });
            });
        });

        effect(() => {
            const categoryId = this.page()?.categoryId;
            const found = this.categories().find(c => c.id === categoryId);
            untracked(() => this.templateJson.set(found?.infoboxTemplateJson ?? null));
        });

        effect(() => {
            const ownerId = this.ownerId();
            if (ownerId) untracked(() => this.profiles.resolveByUserId(ownerId));
        });
    }

    protected createPage(): void {
        this.creating.set(true);
        this.personas.createPage(this.guildId(), this.personaId()).subscribe({
            next: page => {
                this.page.set(page);
                this.creating.set(false);
            },
            error: err => {
                this.creating.set(false);
                this.toast.httpError(this.translate.instant('PERSONA.PAGE.CREATE_FAILED'), err);
            },
        });
    }

    protected openInWiki(): void {
        const page = this.page();
        if (!page) return;
        if (!this.deepLink.open(this.guildId(), page.id, {edit: true})) {
            this.toast.error(this.translate.instant('PERSONA.PAGE.WIKI_UNAVAILABLE'));
        }
    }

    protected pull(): void {
        this.pulling.set(true);
        // The merge that keeps whatever this guild edited. Nothing here offers to discard it.
        this.personas
            .pullPage(this.guildId(), this.personaId(), PersonaPagePullStrategy.KeepLocal)
            .subscribe({
                next: () => {
                    this.pulling.set(false);
                    const pageId = this.entry()?.wikiPageId;
                    if (pageId) {
                        this.personas
                            .getPage(this.guildId(), pageId)
                            .subscribe({next: page => this.page.set(page), error: () => undefined});
                    }
                    this.toast.success(this.translate.instant('PERSONA.PAGE.PULLED'));
                },
                error: err => {
                    this.pulling.set(false);
                    this.toast.httpError(this.translate.instant('PERSONA.PAGE.PULL_FAILED'), err);
                },
            });
    }

    protected openInfobox(): void {
        this.infoboxDraft.set({...parseInfoboxValues(this.page()?.infoboxJson)});
        this.infoboxOpen.set(true);
    }

    protected setField(key: string, value: string): void {
        this.infoboxDraft.update(draft => ({...draft, [key]: value}));
    }

    protected fieldValue(key: string): string {
        const value = this.infoboxDraft()[key];
        if (Array.isArray(value)) return value.join(', ');
        return value === null || value === undefined ? '' : String(value);
    }

    protected saveInfobox(): void {
        const page = this.page();
        if (!page) return;
        this.savingInfobox.set(true);
        const infoboxJson = serialiseInfoboxValues(this.infoboxDraft());
        this.personas.savePage(this.guildId(), page.id, {infoboxJson}).subscribe({
            next: saved => {
                this.page.set(saved);
                this.savingInfobox.set(false);
                this.infoboxOpen.set(false);
            },
            error: err => {
                this.savingInfobox.set(false);
                this.toast.httpError(this.translate.instant('PERSONA.PAGE.INFOBOX_SAVE_FAILED'), err);
            },
        });
    }

    protected back(): void {
        this.nav.openPersonas(this.guildId());
    }

    protected openOwner(): void {
        const ownerId = this.ownerId();
        if (ownerId) this.popout.open(ownerId);
    }
}
