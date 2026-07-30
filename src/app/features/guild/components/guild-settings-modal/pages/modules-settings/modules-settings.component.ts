import {Component, computed, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto, GuildKind} from '../../../../../../dtos/response/guild.dto';
import {GuildService, UpdateGuildDto} from '../../../../../../services/guild.service';
import {ToastService} from '../../../../../../services/toast.service';
import {
    COMMUNITY_MODULES,
    GUILD_FEATURE_LABEL_KEY,
    GUILD_KIND_META,
    guildFeatures,
    guildKindMeta,
    guildKindOf,
    HOUSEHOLD_MODULES,
    serializeGuildFeatures,
    withGuildFeature,
} from '../../../../guild-features';

/**
 * What the guild *is* (its kind) and what it *has* (its modules).
 *
 * Every toggle saves on the spot - there is no Save button, because each module is
 * independently meaningful and a half-applied set isn't a state worth being able to
 * hold. That also means this page never reports itself dirty to the modal shell.
 */
@Component({
    selector: 'app-modules-settings',
    imports: [FormsModule, Button, Dialog, ToggleSwitch, PrimeTemplate, TranslateModule],
    templateUrl: './modules-settings.component.html',
})
export class ModulesSettingsComponent {
    guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();

    protected readonly kinds = GUILD_KIND_META;
    protected readonly communityModules = COMMUNITY_MODULES;

    protected saving = signal(false);
    /** Set while the "switch this guild's kind?" confirmation is open. */
    protected pendingKind = signal<GuildKind | null>(null);

    protected features = computed(() => guildFeatures(this.guild()));
    protected kind = computed(() => guildKindOf(this.guild()));
    protected pendingKindLabel = computed(() => guildKindMeta(this.pendingKind() ?? undefined).labelKey);

    /**
     * Household modules are flag values with nothing behind them yet, so they only
     * appear once the guild actually has one - togglable rows for features that do
     * nothing would be a promise this build can't keep.
     */
    protected householdModules = computed(() => HOUSEHOLD_MODULES.filter(m => this.features().has(m)));

    private guildService = inject(GuildService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    protected isOn(module: string): boolean {
        return this.features().has(module);
    }

    /** Unknown-to-this-build modules have no key; ngx-translate echoes the raw name back. */
    protected labelKey(module: string): string {
        const stem = GUILD_FEATURE_LABEL_KEY[module];
        return stem ? `${stem}.LABEL` : module;
    }

    protected descriptionKey(module: string): string {
        const stem = GUILD_FEATURE_LABEL_KEY[module];
        return stem ? `${stem}.DESC` : '';
    }

    protected toggle(module: string, enabled: boolean): void {
        if (this.saving()) return;
        this.save({features: serializeGuildFeatures(withGuildFeature(this.features(), module, enabled))});
    }

    protected requestKind(kind: GuildKind): void {
        if (this.saving() || kind === this.kind()) return;
        // Sending `kind` on its own re-seeds the module set from that kind's preset,
        // silently discarding whatever the owner customised. Ask first, and offer the
        // other option: relabel while keeping the modules, which means sending both.
        this.pendingKind.set(kind);
    }

    protected confirmKind(usePreset: boolean): void {
        const kind = this.pendingKind();
        this.pendingKind.set(null);
        if (!kind) return;
        this.save({
            kind,
            // Sending the current set alongside the kind is what stops the server re-seeding it.
            ...(usePreset ? {} : {features: serializeGuildFeatures(this.features())}),
        });
    }

    protected cancelKind(): void {
        this.pendingKind.set(null);
    }

    private save(dto: UpdateGuildDto): void {
        this.saving.set(true);
        this.guildService.updateGuild(this.guild().id, dto).subscribe({
            next: updated => {
                this.saving.set(false);
                this.guildUpdated.emit(updated);
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.MODULES.SAVE_ERROR'), err);
            },
        });
    }
}
