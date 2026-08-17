import {ChangeDetectionStrategy, Component, computed, effect, inject, model, signal, untracked} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MemberPrompt, OnboardingResponse} from '../../../../dtos/response/guild-safety.dto';
import {GuildSafetyService} from '../../../../services/guild-safety.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {OnboardingPromptStepComponent} from '../onboarding-gate/onboarding-prompt-step.component';

/** Post-join "Channels & Roles" screen: every prompt the guild defines, including those hidden from the join flow, with the member's current picks editable. Save is a full replace across all prompts: an omitted prompt is read as "nothing selected" and its grants revoked, so the whole set always goes up together, never a delta. */
@Component({
    selector: 'app-channels-and-roles-modal',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, OnboardingPromptStepComponent],
    templateUrl: './channels-and-roles-modal.component.html',
})
export class ChannelsAndRolesModalComponent {
    readonly visible = model.required<boolean>();
    readonly guildId = model.required<string>();

    protected readonly loading = signal(true);
    protected readonly saving = signal(false);
    protected readonly prompts = signal<MemberPrompt[]>([]);
    /** promptId → chosen option ids; seeded from the server's `selected` flags. */
    protected readonly answers = signal<Record<string, string[]>>({});
    protected readonly missingRequired = signal<string[]>([]);

    private safety = inject(GuildSafetyService);
    private guildService = inject(GuildService);
    private emojiStore = inject(GuildEmojiStore);
    private navService = inject(NavigationService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly emojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.guildId())) map[emoji.id] = emoji.imageUrl;
        return map;
    });

    protected readonly sortedPrompts = computed(() => [...this.prompts()].sort((a, b) => a.position - b.position));

    protected readonly dirty = computed(() => {
        const original = this.originalAnswers();
        const current = this.answers();
        const keys = new Set([...Object.keys(original), ...Object.keys(current)]);
        for (const key of keys) {
            const a = [...(original[key] ?? [])].sort();
            const b = [...(current[key] ?? [])].sort();
            if (a.length !== b.length || a.some((v, i) => v !== b[i])) return true;
        }
        return false;
    });

    private readonly originalAnswers = signal<Record<string, string[]>>({});

    constructor() {
        effect(() => {
            const open = this.visible();
            const guildId = this.guildId();
            // Re-read on every open: another device (or the join wizard) may have changed these picks since the last time this dialog was mounted.
            if (open && guildId) untracked(() => this.load(guildId));
        });
    }

    protected onSelectionChange(promptId: string | undefined, optionIds: string[]): void {
        if (!promptId) return;
        this.answers.update(a => ({...a, [promptId]: optionIds}));
        this.missingRequired.update(ids => ids.filter(id => id !== promptId || optionIds.length === 0));
    }

    protected selectedFor(promptId: string | undefined): string[] {
        return promptId ? this.answers()[promptId] ?? [] : [];
    }

    protected isMissing(promptId: string | undefined): boolean {
        return !!promptId && this.missingRequired().includes(promptId);
    }

    protected save(): void {
        if (this.saving()) return;

        // Required prompts must still have an answer afterwards: catching it here beats a 400 that names an id the user never sees.
        const missing = this.sortedPrompts()
            .filter(p => p.required && this.selectedFor(p.id).length === 0)
            .map(p => p.id!)
            .filter(Boolean);

        if (missing.length > 0) {
            this.missingRequired.set(missing);
            return;
        }
        this.missingRequired.set([]);
        this.saving.set(true);

        // Every prompt is sent, including the empty ones: that's how a deselection is expressed, and omitting them would be read the same way anyway.
        const responses: OnboardingResponse[] = this.sortedPrompts()
            .filter(p => !!p.id)
            .map(p => ({promptId: p.id!, optionIds: this.selectedFor(p.id)}));

        this.safety.setMyResponses(this.guildId(), responses).subscribe({
            next: () => {
                this.saving.set(false);
                this.originalAnswers.set(this.answers());
                this.visible.set(false);
                this.toast.success(this.translate.instant('CHANNELS_ROLES.SAVE_SUCCESS'));
                // Roles and channel visibility both change here, so the cached guild is stale.
                this.guildService.getGuild(this.guildId()).subscribe({
                    next: guild => this.navService.updateCurrentGuild(guild),
                    error: () => undefined,
                });
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('CHANNELS_ROLES.SAVE_ERROR'), err);
            },
        });
    }

    private load(guildId: string): void {
        this.loading.set(true);
        this.missingRequired.set([]);
        this.emojiStore.ensureLoaded(guildId);

        this.safety.getMyPrompts(guildId).subscribe({
            next: prompts => {
                const answers: Record<string, string[]> = {};
                for (const prompt of prompts) {
                    if (!prompt.id) continue;
                    answers[prompt.id] = prompt.options.filter(o => o.selected && o.id).map(o => o.id!);
                }
                this.prompts.set(prompts);
                this.answers.set(answers);
                this.originalAnswers.set(answers);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toast.httpError(this.translate.instant('CHANNELS_ROLES.LOAD_ERROR'), err);
            },
        });
    }
}
