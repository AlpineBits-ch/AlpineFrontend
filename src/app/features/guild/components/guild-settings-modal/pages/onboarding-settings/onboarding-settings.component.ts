import {ChangeDetectionStrategy, Component, computed, effect, inject, input, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {MultiSelect} from 'primeng/multiselect';
import {Select} from 'primeng/select';
import {Tooltip} from 'primeng/tooltip';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {
    ONBOARDING_LIMITS,
    OnboardingConfig,
    OnboardingMode,
    OnboardingPrompt,
    PendingMember,
    WelcomeChannel,
    WelcomeScreen,
} from '../../../../../../dtos/response/guild-safety.dto';
import {GuildSafetyService} from '../../../../../../services/guild-safety.service';
import {ToastService} from '../../../../../../services/toast.service';
import {OnboardingPromptEditorComponent} from './onboarding-prompt-editor.component';

@Component({
    selector: 'app-onboarding-settings',
    imports: [
        FormsModule, Button, InputText, Textarea, ToggleSwitch, MultiSelect, Select, Tooltip, Dialog, PrimeTemplate,
        TranslateModule, OnboardingPromptEditorComponent,
    ],
    templateUrl: './onboarding-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    /** Lets the settings shell warn before navigating away from unsaved edits. */
    dirtyChange = output<boolean>();

    /** A getter for the reason spelled out in onboarding-prompt-editor.component.ts. */
    protected get limits() {
        return ONBOARDING_LIMITS;
    }

    protected loading = signal(true);
    protected saving = signal(false);
    protected savingWelcome = signal(false);

    // ── Onboarding config ────────────────────────────────────────────────────
    protected enabled = signal(false);
    protected mode = signal<OnboardingMode>(OnboardingMode.Default);
    protected rulesText = signal('');
    protected defaultChannelIds = signal<string[]>([]);
    protected prompts = signal<OnboardingPrompt[]>([]);

    // ── Prompt editor ────────────────────────────────────────────────────────
    protected showPromptEditor = signal(false);
    protected editingPrompt = signal<OnboardingPrompt | null>(null);
    private editingIndex = signal<number | null>(null);

    protected showRemovePrompt = signal(false);
    protected promptPendingRemoval = signal<OnboardingPrompt | null>(null);
    private removeIndex = signal<number | null>(null);

    // ── Welcome screen ───────────────────────────────────────────────────────
    protected welcomeEnabled = signal(false);
    protected welcomeDescription = signal('');
    protected welcomeChannels = signal<WelcomeChannel[]>([]);

    // ── Pending members ──────────────────────────────────────────────────────
    protected pendingMembers = signal<PendingMember[]>([]);
    protected pendingLoaded = signal(false);

    /**
     * The two halves save through different endpoints, so each keeps its own baseline and
     * the shell is told about the union. Serialising is what lets a prompt reorder or an
     * edit-and-undo settle back to clean; the previous flag latched true until a save.
     */
    private configSnapshot = computed(() => JSON.stringify({
        enabled: this.enabled(),
        mode: this.mode(),
        rulesText: this.rulesText(),
        defaultChannelIds: this.defaultChannelIds(),
        prompts: this.prompts(),
    }));

    private welcomeSnapshot = computed(() => JSON.stringify({
        enabled: this.welcomeEnabled(),
        description: this.welcomeDescription(),
        channels: this.welcomeChannels(),
    }));

    private configBaseline = signal(this.configSnapshot());
    private welcomeBaseline = signal(this.welcomeSnapshot());

    protected configDirty = computed(() => this.configSnapshot() !== this.configBaseline());
    protected welcomeDirty = computed(() => this.welcomeSnapshot() !== this.welcomeBaseline());
    protected dirty = computed(() => this.configDirty() || this.welcomeDirty());

    private safety = inject(GuildSafetyService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected channelOptions = computed(() =>
        this.guild().channels
            .filter(c => !c.parentChannelId && c.type !== ChannelType.Thread && c.type !== ChannelType.Voice)
            .sort((a, b) => a.position - b.position)
            .map(c => ({label: c.name, value: c.id})));

    protected modeOptions = computed(() => [
        {label: this.translate.instant('GUILD_SETTINGS.ONBOARDING.MODE_DEFAULT'), value: OnboardingMode.Default},
        {label: this.translate.instant('GUILD_SETTINGS.ONBOARDING.MODE_ADVANCED'), value: OnboardingMode.Advanced},
    ]);

    /** Channels not already on the welcome screen - it caps at 5 and forbids duplicates. */
    protected availableWelcomeChannels = computed(() => {
        const used = new Set(this.welcomeChannels().map(c => c.channelId));
        return this.channelOptions().filter(o => !used.has(o.value));
    });

    protected atWelcomeCap = computed(() => this.welcomeChannels().length >= this.limits.welcomeChannels);
    protected atPromptCap = computed(() => this.prompts().length >= this.limits.promptsPerGuild);

    // ── Validation ───────────────────────────────────────────────────────────
    // Live, so a blocking problem is visible next to the field that caused it instead of
    // appearing in a summary box only after the Save button has already been pressed.
    protected needsContent = computed(() =>
        this.enabled() && !this.rulesText().trim() && !this.prompts().some(p => p.inOnboarding));

    protected rulesTooLong = computed(() => this.rulesText().length > this.limits.rulesTextLength);

    protected tooManyChannels = computed(() => this.defaultChannelIds().length > this.limits.defaultChannels);

    protected validationErrors = computed(() => {
        const errors: string[] = [];
        if (this.needsContent()) errors.push('GUILD_SETTINGS.ONBOARDING.ERR_NEEDS_CONTENT');
        if (this.rulesTooLong()) errors.push('GUILD_SETTINGS.ONBOARDING.ERR_RULES_TOO_LONG');
        if (this.tooManyChannels()) errors.push('GUILD_SETTINGS.ONBOARDING.ERR_TOO_MANY_CHANNELS');
        for (const prompt of this.prompts()) {
            const issue = this.promptIssue(prompt);
            if (issue && !errors.includes(issue)) errors.push(issue);
        }
        return errors;
    });

    /** Mirrors the server's per-prompt rules so the offending row can say so itself. */
    protected promptIssue(prompt: OnboardingPrompt): string | null {
        if (prompt.options.length === 0) return 'ONBOARDING_EDIT.ERR_NO_OPTIONS';
        if (prompt.options.some(o => o.roleIds.length === 0 && o.channelIds.length === 0)) {
            return 'ONBOARDING_EDIT.ERR_OPTION_EMPTY';
        }
        return null;
    }

    protected channelName(channelId: string): string {
        return this.guild().channels.find(c => c.id === channelId)?.name ?? channelId;
    }

    constructor() {
        effect(() => this.dirtyChange.emit(this.dirty()));
    }

    ngOnInit(): void {
        this.safety.getOnboardingConfig(this.guild().id).subscribe({
            next: cfg => {
                this.enabled.set(cfg.enabled);
                this.mode.set(cfg.mode ?? OnboardingMode.Default);
                this.rulesText.set(cfg.rulesText ?? '');
                this.defaultChannelIds.set(cfg.defaultChannelIds ?? []);
                this.prompts.set([...(cfg.prompts ?? [])].sort((a, b) => a.position - b.position));
                this.configBaseline.set(this.configSnapshot());
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.ONBOARDING.LOAD_ERROR'), err);
            },
        });

        this.safety.getWelcomeScreen(this.guild().id).subscribe({
            next: screen => {
                this.welcomeEnabled.set(screen.enabled);
                this.welcomeDescription.set(screen.description ?? '');
                this.welcomeChannels.set([...(screen.channels ?? [])].sort((a, b) => a.position - b.position));
                this.welcomeBaseline.set(this.welcomeSnapshot());
            },
            // A guild that has never configured one is a normal, non-noteworthy state, and the
            // untouched baseline already matches the empty form it leaves on screen.
            error: () => undefined,
        });

        this.safety.getPendingMembers(this.guild().id).subscribe({
            next: members => {
                this.pendingMembers.set(members);
                this.pendingLoaded.set(true);
            },
            // Needs ModerateMembers/ManageGuild - a 403 here just means "don't show it".
            error: () => this.pendingLoaded.set(true),
        });
    }

    // ── Prompts ──────────────────────────────────────────────────────────────
    protected addPrompt(): void {
        if (this.atPromptCap()) return;
        this.editingPrompt.set(null);
        this.editingIndex.set(null);
        this.showPromptEditor.set(true);
    }

    protected editPrompt(index: number): void {
        this.editingPrompt.set(this.prompts()[index]);
        this.editingIndex.set(index);
        this.showPromptEditor.set(true);
    }

    protected onPromptSaved(prompt: OnboardingPrompt): void {
        const index = this.editingIndex();
        this.prompts.update(list => {
            const next = index === null ? [...list, prompt] : list.map((p, i) => i === index ? prompt : p);
            return next.map((p, position) => ({...p, position}));
        });
    }

    /**
     * Removal is local until Save - and even then, deleting a prompt does not take back
     * roles or channels it already granted. Only a member deselecting an option revokes.
     */
    protected askRemovePrompt(index: number): void {
        this.removeIndex.set(index);
        this.promptPendingRemoval.set(this.prompts()[index]);
        this.showRemovePrompt.set(true);
    }

    protected removePrompt(): void {
        const index = this.removeIndex();
        this.showRemovePrompt.set(false);
        if (index === null) return;
        this.prompts.update(list => list.filter((_, i) => i !== index).map((p, position) => ({...p, position})));
        this.removeIndex.set(null);
    }

    protected movePrompt(index: number, delta: number): void {
        const target = index + delta;
        const list = this.prompts();
        if (target < 0 || target >= list.length) return;

        const next = [...list];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        this.prompts.set(next.map((p, position) => ({...p, position})));
    }

    protected promptSummary(prompt: OnboardingPrompt): string {
        const roles = new Set<string>();
        const channels = new Set<string>();
        for (const option of prompt.options) {
            option.roleIds.forEach(id => roles.add(id));
            option.channelIds.forEach(id => channels.add(id));
        }
        return this.translate.instant('GUILD_SETTINGS.ONBOARDING.PROMPT_SUMMARY', {
            options: prompt.options.length,
            roles: roles.size,
            channels: channels.size,
        });
    }

    // ── Save ─────────────────────────────────────────────────────────────────
    protected save(): void {
        if (this.saving() || this.validationErrors().length > 0) return;

        // A full-document PUT: anything absent from this payload is deleted server-side,
        // which is why the prompt ids read back from the GET are round-tripped verbatim.
        const config: OnboardingConfig = {
            enabled: this.enabled(),
            mode: this.mode(),
            rulesText: this.rulesText().trim() ? this.rulesText() : null,
            defaultChannelIds: this.defaultChannelIds(),
            prompts: this.prompts(),
        };

        this.saving.set(true);
        this.safety.updateOnboardingConfig(this.guild().id, config).subscribe({
            next: saved => {
                this.saving.set(false);
                // Adopt the response: newly created prompts and options come back with
                // their generated ids, and dropping them would re-create them next save.
                this.prompts.set([...(saved.prompts ?? [])].sort((a, b) => a.position - b.position));
                this.configBaseline.set(this.configSnapshot());
                this.toast.success(this.translate.instant('GUILD_SETTINGS.ONBOARDING.SAVE_SUCCESS'));
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.ONBOARDING.SAVE_ERROR'), err);
            },
        });
    }

    // ── Welcome screen ───────────────────────────────────────────────────────
    protected addWelcomeChannel(channelId: string): void {
        if (!channelId || this.atWelcomeCap()) return;
        this.welcomeChannels.update(list => [
            ...list,
            {channelId, description: '', emoji: null, position: list.length},
        ]);
    }

    protected patchWelcomeChannel(index: number, patch: Partial<WelcomeChannel>): void {
        this.welcomeChannels.update(list => list.map((c, i) => i === index ? {...c, ...patch} : c));
    }

    protected removeWelcomeChannel(index: number): void {
        this.welcomeChannels.update(list =>
            list.filter((_, i) => i !== index).map((c, position) => ({...c, position})));
    }

    protected saveWelcomeScreen(): void {
        if (this.savingWelcome()) return;
        this.savingWelcome.set(true);

        const channels = this.welcomeChannels().map((c, position) => ({...c, position}));
        const screen: WelcomeScreen = {
            enabled: this.welcomeEnabled(),
            description: this.welcomeDescription().trim() ? this.welcomeDescription() : null,
            channels,
        };

        this.safety.updateWelcomeScreen(this.guild().id, screen).subscribe({
            next: () => {
                this.savingWelcome.set(false);
                // Baseline on the renumbered list that was actually sent, so the half goes
                // clean even when a removal left the local positions one step behind.
                this.welcomeChannels.set(channels);
                this.welcomeBaseline.set(this.welcomeSnapshot());
                this.toast.success(this.translate.instant('GUILD_SETTINGS.WELCOME.SAVE_SUCCESS'));
            },
            error: err => {
                this.savingWelcome.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.WELCOME.SAVE_ERROR'), err);
            },
        });
    }
}
