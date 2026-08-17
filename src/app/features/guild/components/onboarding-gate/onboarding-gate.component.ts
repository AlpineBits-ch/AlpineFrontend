import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {GuildOnboardingStateService} from '../../../../services/guild-onboarding-state.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {NavigationService} from '../../../main-page/navigation.service';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {OnboardingPrompt, OnboardingResponse} from '../../../../dtos/response/guild-safety.dto';
import {OnboardingPromptStepComponent} from './onboarding-prompt-step.component';

type StepKind = 'welcome' | 'rules' | 'prompt' | 'done';

interface Step {
    kind: StepKind;
    prompt?: OnboardingPrompt;
}

/** The join flow for a member who hasn't accepted yet: a non-dismissable, full-screen step-through covering the welcome, the rules, and each prompt in turn. Everything is answered locally and submitted in one `accept` call at the end: the API has no partial-progress concept, so a per-step save would leave a member who quits halfway both pending and partly granted. */
@Component({
    selector: 'app-onboarding-gate',
    imports: [Button, TranslateModule, OnboardingPromptStepComponent],
    templateUrl: './onboarding-gate.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingGateComponent {
    readonly guildId = input.required<string>();

    protected state = inject(GuildOnboardingStateService);
    private guildService = inject(GuildService);
    private navService = inject(NavigationService);
    private emojiStore = inject(GuildEmojiStore);

    /** An option's emoji is either a unicode character or a guild emoji id, with no discriminator: the step component tells them apart by looking for a hit here. */
    protected readonly emojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.guildId())) map[emoji.id] = emoji.imageUrl;
        return map;
    });

    protected readonly stepIndex = signal(0);
    /** promptId → chosen option ids. Built up across steps, sent once on finish. */
    protected readonly answers = signal<Record<string, string[]>>({});
    protected readonly showRequiredError = signal(false);

    protected readonly pending = computed(() => this.state.pendingForGuild(this.guildId()));
    protected readonly status = computed(() => this.state.statusFor(this.guildId()));
    protected readonly submitting = computed(() => this.state.isAccepting());

    // Guild name/channels come from the already-loaded workspace context rather than a fresh fetch: the gate only ever mounts for the guild currently selected in nav.
    protected readonly guildName = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && ws.guild.id === this.guildId() ? ws.guild.name : '';
    });

    protected readonly defaultChannels = computed<ChannelDto[]>(() => {
        const ids = this.status()?.defaultChannelIds ?? [];
        if (ids.length === 0) return [];
        const ws = this.navService.workspace();
        if (ws.type !== 'server' || ws.guild.id !== this.guildId()) return [];
        // Preserve the admin's ordering rather than the channel list's.
        return ids.map(id => ws.guild.channels.find(c => c.id === id)).filter((c): c is ChannelDto => !!c);
    });

    protected readonly prompts = computed(() =>
        [...(this.status()?.prompts ?? [])].sort((a, b) => a.position - b.position));

    /** The welcome step is always present so the flow opens on the server's name rather than a wall of rules; every other step is conditional on there being content. */
    protected readonly steps = computed<Step[]>(() => {
        const steps: Step[] = [{kind: 'welcome'}];
        if (this.status()?.rulesText?.trim()) steps.push({kind: 'rules'});
        for (const prompt of this.prompts()) steps.push({kind: 'prompt', prompt});
        steps.push({kind: 'done'});
        return steps;
    });

    protected readonly currentStep = computed<Step | undefined>(() => this.steps()[this.stepIndex()]);
    protected readonly isFirstStep = computed(() => this.stepIndex() === 0);
    protected readonly isLastStep = computed(() => this.stepIndex() >= this.steps().length - 1);

    /** Only prompt steps count toward the progress bar: the framing steps aren't work. */
    protected readonly promptProgress = computed(() => {
        const total = this.prompts().length;
        if (total === 0) return null;
        const step = this.currentStep();
        const answered = step?.kind === 'prompt' && step.prompt
            ? this.prompts().findIndex(p => p.id === step.prompt!.id)
            : this.isLastStep() ? total : 0;
        return {current: Math.max(0, answered), total};
    });

    protected selectedFor(promptId: string | undefined): string[] {
        return promptId ? this.answers()[promptId] ?? [] : [];
    }

    /** A required prompt blocks Continue until it has an answer, mirroring the 400. */
    protected readonly canContinue = computed(() => {
        const step = this.currentStep();
        if (step?.kind !== 'prompt' || !step.prompt?.required) return true;
        return this.selectedFor(step.prompt.id).length > 0;
    });

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.state.loadFor(guildId);
                this.emojiStore.ensureLoaded(guildId);
                // Switching servers mid-flow must not carry the previous guild's answers or leave the wizard parked on a step that no longer exists.
                this.stepIndex.set(0);
                this.answers.set({});
                this.showRequiredError.set(false);
            });
        });
    }

    protected onSelectionChange(promptId: string | undefined, optionIds: string[]): void {
        if (!promptId) return;
        this.answers.update(a => ({...a, [promptId]: optionIds}));
        if (optionIds.length > 0) this.showRequiredError.set(false);
    }

    protected next(): void {
        if (!this.canContinue()) {
            this.showRequiredError.set(true);
            return;
        }
        this.showRequiredError.set(false);
        this.stepIndex.update(i => Math.min(i + 1, this.steps().length - 1));
    }

    protected back(): void {
        this.showRequiredError.set(false);
        this.stepIndex.update(i => Math.max(0, i - 1));
    }

    protected finish(): void {
        const responses: OnboardingResponse[] = Object.entries(this.answers())
            .filter(([, optionIds]) => optionIds.length > 0)
            .map(([promptId, optionIds]) => ({promptId, optionIds}));

        this.state.accept(this.guildId(), responses, () => {
            // Roles and channel visibility both change on accept, so the cached guild is stale the instant this resolves; re-read it rather than patching guesses in.
            this.guildService.getGuild(this.guildId()).subscribe({
                next: guild => this.navService.updateCurrentGuild(guild),
                error: () => undefined,
            });
        });
    }

    protected openChannel(channel: ChannelDto): void {
        this.navService.openChannel(channel);
    }

    protected leaveServer(): void {
        // The wizard is deliberately non-dismissable so a pending member can't bypass the rules, but they still need a way out that isn't "reload the app". Switching the workspace off 'server' is what unmounts it (see main-page.component.html), so this is a navigation away, not a bypass.
        this.navService.selectDMs();
    }
}
