import {ChangeDetectionStrategy, Component, computed, inject, model, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {GuildService} from '../../../../services/guild.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto, GuildKind} from '../../../../dtos/response/guild.dto';
import {DiscordImportService} from '../../../../services/discord-import.service';
import {ExternalLinkService} from '../../../../services/external-link.service';
import {ToastService} from '../../../../services/toast.service';
import {GuildTemplateService} from '../../../../services/guild-template.service';
import {GuildTemplateDto} from '../../../../dtos/response/guild-template.dto';
import {TemplatePreviewComponent} from './template-preview.component';
import {GUILD_KIND_META, guildKindMeta} from '../../guild-features';

/**
 * `start` is the fork - make one, clone a template, or pull a Discord server across.
 * The create path then splits in two because the kind seeds the whole module set:
 * it's the decision that shapes everything else, and it's far cheaper to answer up
 * front than to unpick afterwards in settings.
 */
type CreateGuildStep = 'start' | 'kind' | 'details' | 'template';

@Component({
    selector: 'app-create-guild-modal',
    imports: [Dialog, Button, InputText, FormsModule, PrimeTemplate, TranslateModule, TemplatePreviewComponent],
    templateUrl: './create-guild-modal.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateGuildModalComponent {
    readonly visible = model.required<boolean>();
    readonly guildCreated = output<GuildDto>();
    readonly name = signal('');
    readonly description = signal('');
    readonly loading = signal(false);
    readonly importingFromDiscord = signal(false);

    readonly step = signal<CreateGuildStep>('start');
    readonly kind = signal<GuildKind>(GuildKind.Community);
    readonly kinds = GUILD_KIND_META;

    readonly templateInput = signal('');
    readonly templateLoading = signal(false);
    readonly templateNotFound = signal(false);
    readonly template = signal<GuildTemplateDto | null>(null);
    readonly templateGuildName = signal('');
    readonly creatingFromTemplate = signal(false);

    /** Metadata for the chosen kind: its noun, blurb and name placeholder. */
    readonly selectedKind = computed(() => guildKindMeta(this.kind()));

    /** Only the create path is a numbered journey; the template path is a single screen. */
    readonly stepNumber = computed(() => this.step() === 'kind' ? 1 : this.step() === 'details' ? 2 : 0);
    readonly stepCount = 2;
    readonly stepIndicators = [1, 2];

    readonly title = computed(() => {
        switch (this.step()) {
            case 'kind':
                return 'CREATE_GUILD.STEP_KIND_TITLE';
            case 'details':
                return 'CREATE_GUILD.STEP_DETAILS_TITLE';
            case 'template':
                return 'CREATE_GUILD.TEMPLATE.TITLE';
            default:
                return 'CREATE_GUILD.TITLE';
        }
    });

    private guildService = inject(GuildService);
    private discordImportService = inject(DiscordImportService);
    private externalLinkService = inject(ExternalLinkService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private guildTemplateService = inject(GuildTemplateService);

    startDiscordImport(): void {
        if (this.importingFromDiscord() || this.loading()) return;
        this.importingFromDiscord.set(true);
        this.discordImportService.startImport().subscribe({
            next: res => {
                this.importingFromDiscord.set(false);
                // The user may have already cancelled/closed the modal while this request was
                // in flight - don't slam it shut again or launch the OAuth browser in that case.
                if (!this.visible()) return;
                this.close();
                void this.externalLinkService.openExternalLink(res.authorizeUrl);
            },
            error: err => {
                this.importingFromDiscord.set(false);
                this.toastService.httpError(this.translate.instant('CREATE_GUILD.IMPORT_ERROR_TOAST'), err);
            },
        });
    }

    // ── Step navigation ─────────────────────────────────────────────────────
    showKindStep(): void {
        if (this.loading() || this.importingFromDiscord()) return;
        this.step.set('kind');
    }

    selectKind(kind: GuildKind): void {
        this.kind.set(kind);
    }

    /** Double-click / Enter on a kind card commits the choice and moves on in one gesture. */
    chooseKind(kind: GuildKind): void {
        this.selectKind(kind);
        this.step.set('details');
    }

    continueFromKind(): void {
        this.step.set('details');
    }

    back(): void {
        switch (this.step()) {
            case 'details':
                this.step.set('kind');
                return;
            case 'kind':
                this.step.set('start');
                return;
            case 'template':
                this.resetTemplateState();
                this.step.set('start');
                return;
            default:
                return;
        }
    }

    submit(): void {
        const trimmed = this.name().trim();
        if (!trimmed || this.loading()) return;
        this.loading.set(true);
        this.guildService.createGuild(trimmed, this.description().trim() || undefined, this.kind()).subscribe({
            next: guild => {
                this.loading.set(false);
                this.guildCreated.emit(guild);
                this.close();
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('CREATE_GUILD.CREATE_ERROR_TOAST'), err);
            },
        });
    }

    close(): void {
        this.visible.set(false);
        this.name.set('');
        this.description.set('');
        this.kind.set(GuildKind.Community);
        this.loading.set(false);
        this.importingFromDiscord.set(false);
        this.resetTemplateState();
        this.step.set('start');
    }

    // ── Create from template ────────────────────────────────────────────────
    showTemplateMode(): void {
        if (this.loading() || this.importingFromDiscord()) return;
        this.step.set('template');
    }

    /** Typing a corrected id must retire the stale "not found" message immediately,
     *  rather than leaving it under the field until the next blur re-runs the lookup. */
    onTemplateInputChange(value: string): void {
        this.templateInput.set(value);
        this.templateNotFound.set(false);
    }

    lookupTemplate(): void {
        const id = this.extractTemplateId(this.templateInput());
        if (!id || this.templateLoading()) return;
        this.templateLoading.set(true);
        this.templateNotFound.set(false);
        this.template.set(null);
        this.guildTemplateService.get(id).subscribe({
            next: dto => {
                this.templateLoading.set(false);
                // The user may have already left template mode or changed the input while this
                // request was in flight - don't resurrect abandoned template state in that case.
                if (this.isTemplateLookupStale(id)) return;
                this.template.set(dto);
            },
            error: err => {
                this.templateLoading.set(false);
                // Same stale-response guard as above - a late error for an abandoned lookup
                // shouldn't surface a "not found" message or toast for state nobody cares about anymore.
                if (this.isTemplateLookupStale(id)) return;
                if (err?.status === 404) {
                    this.templateNotFound.set(true);
                } else {
                    this.toastService.httpError(this.translate.instant('CREATE_GUILD.TEMPLATE.LOOKUP_ERROR_TOAST'), err);
                }
            },
        });
    }

    createFromTemplate(): void {
        const template = this.template();
        const trimmedName = this.templateGuildName().trim();
        if (!template || !trimmedName || this.creatingFromTemplate()) return;
        this.creatingFromTemplate.set(true);
        this.guildTemplateService.useTemplate(template.id, {name: trimmedName}).subscribe({
            next: created => {
                this.guildService.getGuild(created.id).subscribe({
                    next: guild => {
                        this.creatingFromTemplate.set(false);
                        // The user may have already cancelled/left template mode while this
                        // request was in flight - don't slam the modal shut or navigate away in that case.
                        if (!this.visible() || this.step() !== 'template') return;
                        this.guildCreated.emit(guild);
                        this.close();
                    },
                    error: err => {
                        this.creatingFromTemplate.set(false);
                        // The guild WAS created -only the follow-up fetch failed. Closing
                        // silently would look like nothing happened and invite the user to
                        // run the template again, creating a duplicate. Say so out loud.
                        this.toastService.httpError(this.translate.instant('CREATE_GUILD.TEMPLATE.CREATE_ERROR_TOAST'), err);
                        if (!this.visible() || this.step() !== 'template') return;
                        this.close();
                    },
                });
            },
            error: err => {
                this.creatingFromTemplate.set(false);
                this.toastService.httpError(this.translate.instant('CREATE_GUILD.TEMPLATE.CREATE_ERROR_TOAST'), err);
            },
        });
    }

    private resetTemplateState(): void {
        this.templateInput.set('');
        this.templateLoading.set(false);
        this.templateNotFound.set(false);
        this.template.set(null);
        this.templateGuildName.set('');
        this.creatingFromTemplate.set(false);
    }

    /** True if a lookup for `requestedId` is no longer relevant: the modal closed, the user
     *  left template mode, or the input has since changed to point at a different template. */
    private isTemplateLookupStale(requestedId: string): boolean {
        return !this.visible()
            || this.step() !== 'template'
            || this.extractTemplateId(this.templateInput()) !== requestedId;
    }

    /** Accepts a bare template id or a pasted full URL, returning the trailing id segment. */
    private extractTemplateId(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        const withoutQuery = trimmed.split(/[?#]/)[0];
        const segments = withoutQuery.split('/').filter(Boolean);
        return segments.length ? segments[segments.length - 1] : '';
    }
}
