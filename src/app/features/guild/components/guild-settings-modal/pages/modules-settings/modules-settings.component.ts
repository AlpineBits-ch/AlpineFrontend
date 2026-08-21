import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    inject,
    input,
    output,
    signal,
} from '@angular/core';
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
    guildFeatureLabelKey,
    guildFeatures,
    guildKindMeta,
    guildKindOf,
    HOUSEHOLD_MODULES,
    serializeGuildFeatures,
    withGuildFeature,
} from '../../../../guild-features';

/** Keys that move focus inside the kind radiogroup. */
const KIND_NAV_KEYS = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];

/** What the guild *is* (its kind) and what it *has* (its modules). Every toggle saves on the spot; there is no Save button, so this page never reports itself dirty to the modal shell. */
@Component({
    selector: 'app-modules-settings',
    imports: [FormsModule, Button, Dialog, ToggleSwitch, PrimeTemplate, TranslateModule],
    templateUrl: './modules-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModulesSettingsComponent {
    readonly guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();

    protected readonly kinds = GUILD_KIND_META;
    protected readonly communityModules = COMMUNITY_MODULES;

    /** Set while the *kind* is saving; that one genuinely locks the page, since a kind change can re-seed the entire module set and a toggle flipped alongside it would race the re-seed. A module save, by contrast, only locks its own row; see {@link savingModules}. */
    protected readonly savingKind = signal(false);
    /** The modules with a save in flight, by flag name, so three of them can be flipped in a row. */
    protected readonly savingModules = signal<ReadonlySet<string>>(new Set<string>());
    /** Set while the "switch this guild's kind?" confirmation is open. */
    protected readonly pendingKind = signal<GuildKind | null>(null);
    /** The kind option focus last landed on; drives the roving tabindex. */
    protected readonly focusedKind = signal<GuildKind | null>(null);

    /** What the user asked for, per module, until the server confirms or refuses it. The switches read this layered over `features()` rather than binding straight to the guild, since a one-way binding leaves a failed save's switch stuck showing "on" next to the error toast that says it isn't. */
    private readonly optimistic = signal<ReadonlyMap<string, boolean>>(new Map<string, boolean>());

    protected readonly features = computed(() => guildFeatures(this.guild()));
    protected readonly kind = computed(() => guildKindOf(this.guild()));
    protected readonly pendingKindLabel = computed(
        () => guildKindMeta(this.pendingKind() ?? undefined).labelKey,
    );

    /** Server truth with the in-flight intent laid over it. This is what the switches show. */
    protected readonly displayedFeatures = computed<ReadonlySet<string>>(() => {
        const shown = new Set(this.features());
        for (const [module, enabled] of this.optimistic()) {
            if (enabled) shown.add(module);
            else shown.delete(module);
        }
        return shown;
    });

    /** The group is one tab stop: the checked option carries it unless focus has moved on. */
    protected readonly tabbableKind = computed(() => this.focusedKind() ?? this.kind());

    /** Household modules only appear once the guild actually has one; togglable rows for features that do nothing would be a promise this build can't keep. Deliberately off `features()`, not `displayedFeatures()`: a row must not vanish from under a switch that is still saving, only once the server has agreed. */
    protected readonly householdModules = computed(() =>
        HOUSEHOLD_MODULES.filter(m => this.features().has(m)),
    );

    private host: ElementRef<HTMLElement> = inject(ElementRef);
    private guildService = inject(GuildService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    protected isOn(module: string): boolean {
        return this.displayedFeatures().has(module);
    }

    /** Only this module's own row locks while it saves; the rest of the page stays live. */
    protected isBusy(module: string): boolean {
        return this.savingKind() || this.savingModules().has(module);
    }

    /** The kind list is locked by any save, since either one can rewrite the module set. */
    protected kindLocked(): boolean {
        return this.savingKind() || this.savingModules().size > 0;
    }

    /** Ties the row's title to the switch, which otherwise has no accessible name at all. */
    protected labelId(module: string): string {
        return `guild-module-${module}`;
    }

    /** Unknown-to-this-build modules have no key; ngx-translate echoes the raw name back. */
    protected labelKey(module: string): string {
        return guildFeatureLabelKey(module);
    }

    protected descriptionKey(module: string): string {
        const stem = GUILD_FEATURE_LABEL_KEY[module];
        return stem ? `${stem}.DESC` : '';
    }

    protected toggle(module: string, enabled: boolean): void {
        if (this.isBusy(module)) return;
        // Built from what is *shown*, not from what the server last confirmed: with two toggles in flight at once, a payload off server truth would silently undo the other one.
        const next = withGuildFeature(this.displayedFeatures(), module, enabled);
        this.optimistic.update(map => new Map(map).set(module, enabled));
        this.savingModules.update(set => new Set(set).add(module));
        this.save({features: serializeGuildFeatures(next)}, () => {
            this.savingModules.update(set => {
                const rest = new Set(set);
                rest.delete(module);
                return rest;
            });
            // Dropping the entry hands the switch back to server truth either way: after a success that is the value we just asked for, after a failure it is the revert.
            this.optimistic.update(map => {
                const rest = new Map(map);
                rest.delete(module);
                return rest;
            });
        });
    }

    protected requestKind(kind: GuildKind): void {
        if (this.kindLocked() || kind === this.kind()) return;
        // Sending `kind` on its own re-seeds the module set from that kind's preset, silently discarding whatever the owner customised; ask first, and offer the other option, relabel while keeping the modules, which means sending both.
        this.pendingKind.set(kind);
    }

    protected confirmKind(usePreset: boolean): void {
        const kind = this.pendingKind();
        this.pendingKind.set(null);
        if (!kind) return;
        this.savingKind.set(true);
        this.save(
            {
                kind,
                // Sending the current set alongside the kind is what stops the server re-seeding it.
                ...(usePreset ? {} : {features: serializeGuildFeatures(this.displayedFeatures())}),
            },
            () => this.savingKind.set(false),
        );
    }

    protected cancelKind(): void {
        this.pendingKind.set(null);
    }

    /** Roving focus over the kind options, which is what `role="radiogroup"` promises and five separate tab stops did not deliver. Focus moves, selection does not follow it: picking a kind opens a confirmation dialog, so arrowing down the list would fire one dialog per keypress. Space and Enter commit, which the underlying buttons already do for free. */
    protected onKindKeydown(event: KeyboardEvent): void {
        if (!KIND_NAV_KEYS.includes(event.key)) return;
        const options = Array.from(
            this.host.nativeElement.querySelectorAll<HTMLElement>('[data-kind-option]'),
        );
        if (!options.length) return;
        const current = options.indexOf(document.activeElement as HTMLElement);
        let next: number;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = options.length - 1;
        else if (current === -1) next = 0;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
            next = (current + 1) % options.length;
        else next = (current - 1 + options.length) % options.length;
        event.preventDefault();
        options[next]?.focus();
    }

    private save(dto: UpdateGuildDto, settled: () => void): void {
        this.guildService.updateGuild(this.guild().id, dto).subscribe({
            next: updated => {
                settled();
                this.guildUpdated.emit(updated);
            },
            error: err => {
                settled();
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.MODULES.SAVE_ERROR'), err);
            },
        });
    }
}
