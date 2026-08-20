import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {DatePicker} from 'primeng/datepicker';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {
    Decision,
    DecisionBlock,
    DecisionOption,
    DecisionStatus,
    DecisionVoteKind,
} from '../../../../dtos/response/decision.dto';
import {
    CreateDecisionDto,
    createDecisionProblem,
    DECISION_LIMITS,
    DecisionVoteDto,
    voteBodyProblem,
} from '../../../../dtos/request/decision.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {DecisionService} from '../../../../services/decision.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {guildAbilities} from '../../guild-permissions';
import {ChannelIconComponent} from '../channel-icon/channel-icon.component';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {
    blocksForOption,
    decisionResultKey,
    decisionsInDisplayOrder,
    decisionStatusTone,
    isAwaitingResolution,
    isDecisionOpen,
    optionsInDisplayOrder,
    optionStanding,
    quorumProgress,
    wholeDecisionBlocks,
} from '../../decision-outcome';
import {EntitlementStore} from '../../../../stores/entitlement.store';
import {ModuleNotInPlanComponent} from '../module-not-in-plan/module-not-in-plan.component';

/** How many options a new decision starts with, and the floor for creating one; both are the server's numbers (see {@link DECISION_LIMITS}). */
const MIN_OPTIONS = DECISION_LIMITS.minOptions;
const MAX_OPTIONS = DECISION_LIMITS.maxOptions;

/** Keeps "closes in 20 minutes" and the past-deadline notice honest without a per-second timer. */
const CLOCK_TICK_MS = 30_000;

/** What the block dialog is aimed at: one option, or the decision itself. */
interface BlockTarget {
    decision: Decision;
    /** `null` objects to the whole decision: a distinct gesture, not a fallback. */
    optionId: string | null;
}

/** Options are drawn in `position` order, never sorted or highlighted by support; a blocked option renders as out, not behind, and objections come before options. */
@Component({
    selector: 'app-decisions-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button,
        DatePicker,
        Dialog,
        InputText,
        Textarea,
        PrimeTemplate,
        FormsModule,
        TranslateModule,
        AppAvatarComponent,
        RelativeTimePipe,
        ModuleNotInPlanComponent,
        ChannelIconComponent,
    ],
    templateUrl: './decisions-channel.component.html',
})
export class DecisionsChannelComponent implements OnDestroy {
    readonly channel = input.required<ChannelDto>();
    /** Emitted from the dead ends: a guild without the module, or a channel we may not read. */
    back = output();

    protected navService = inject(NavigationService);
    private decisions = inject(DecisionService);
    private entitlements = inject(EntitlementStore);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly Status = DecisionStatus;
    protected readonly minOptions = MIN_OPTIONS;
    protected readonly maxOptions = MAX_OPTIONS;
    protected readonly limits = DECISION_LIMITS;

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    /** Ticked so deadlines age and the past-`closesAt` notice appears without reading the clock in a pipe. */
    protected readonly nowTick = signal(Date.now());
    private tickId = setInterval(() => this.nowTick.set(Date.now()), CLOCK_TICK_MS);

    // ── List ────────────────────────────────────────────────────────────────
    private readonly channelState = computed(() => this.decisions.stateFor(this.channel().id));
    protected readonly loading = computed(() => this.channelState().loading);
    protected readonly loadError = computed(() => this.channelState().error);
    protected readonly hasLoaded = computed(() => this.channelState().loadedAt > 0);
    /** Open first, then resolved; server order preserved within each group. */
    protected readonly rows = computed(() => decisionsInDisplayOrder(this.channelState().decisions));

    // ── Module gate (§13.2) ─────────────────────────────────────────────────

    private readonly guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.channel().guildId),
    );

    /** A `403` here usually means the house doesn't do house votes, not that you aren't allowed; a guild that hasn't loaded yet is treated as enabled to avoid flashing "module off". */
    protected readonly moduleEnabled = computed(() => {
        const guild = this.guild();
        return !guild || guildHasFeature(guild, GuildFeature.Decisions);
    });

    /** The channel's own guild id, which is known before the guild list is. */
    protected readonly guildId = computed(() => this.channel().guildId);

    /** Off because the guild's plan doesn't cover it; false until a resolution actually arrives, since absence is not evidence. */
    protected readonly moduleWithheld = computed(
        () => this.entitlements.moduleStanding(this.guildId(), GuildFeature.Decisions) === 'withheld',
    );

    // ── Permissions ─────────────────────────────────────────────────────────

    private readonly ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    private readonly abilities = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.ownUserId()),
    );

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** Opening a decision, and closing or cancelling one. */
    protected readonly canCreate = computed(() => this.can(ModulePermissions.CreateDecisions));
    /** Support, abstain, block. Distinct from CreateDecisions: most of the house votes, few open. */
    protected readonly canVote = computed(() => this.can(ModulePermissions.VoteDecisions));

    // ── Create dialog ───────────────────────────────────────────────────────
    protected readonly showCreate = signal(false);
    protected readonly draftTitle = signal('');
    protected readonly draftDescription = signal('');
    protected readonly draftQuorum = signal<number | null>(null);
    /** Optional. The server resolves the decision within five minutes of this passing. */
    protected readonly draftClosesAt = signal<Date | null>(null);
    protected readonly draftOptions = signal<string[]>(Array(MIN_OPTIONS).fill(''));
    protected readonly creating = signal(false);

    /** The draft exactly as it would go on the wire, so the checks below run over the body actually sent. */
    private readonly draftBody = computed<CreateDecisionDto>(() => ({
        title: this.draftTitle().trim(),
        description: this.draftDescription().trim() || null,
        closesAt: this.draftClosesAt()?.toISOString() ?? null,
        quorum: this.normalizedQuorum(),
        options: this.draftOptions()
            .map(o => o.trim())
            .filter(Boolean),
    }));

    /** Every `400` `CreateAsync` can answer with, evaluated up front: two options is the floor, a past `closesAt` is refused before sending, and the clock tick keeps a stale dialog invalid on its own. */
    protected readonly createProblem = computed(() =>
        createDecisionProblem(this.draftBody(), this.nowTick()),
    );

    protected readonly canSubmitCreate = computed(() => this.createProblem() === null);

    // ── Block dialog ────────────────────────────────────────────────────────
    protected readonly blockTarget = signal<BlockTarget | null>(null);
    protected readonly blockReason = signal('');
    protected readonly blocking = signal(false);

    /** Mirrors the server's `400` for a block with no reason, so a veto's reasoning is never silently unreadable. */
    protected readonly canSubmitBlock = computed(() => {
        const target = this.blockTarget();
        if (!target) return false;
        return (
            voteBodyProblem({
                kind: DecisionVoteKind.Block,
                optionId: target.optionId,
                reason: this.blockReason(),
            }) === null
        );
    });

    /** Which decision is mid-vote, so its buttons can spin without freezing the whole list. */
    protected readonly busyDecisionId = signal<string | null>(null);

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => void this.decisions.loadFor(channelId));
        });

        // Only once the module reads as off. A house that votes pays nothing for the distinction.
        effect(() => {
            if (!this.moduleEnabled()) this.entitlements.ensureFeaturesLoaded(this.guildId());
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() =>
                this.guildService
                    .getOwnMember(guildId)
                    .subscribe({next: m => this.ownMember.set(m), error: () => this.ownMember.set(null)}),
            );
        });

        // Block authors are named in the objections panel; the profile cache is a signal, so filling it re-renders the rows waiting on it.
        effect(() => {
            for (const decision of this.rows()) {
                for (const block of decision.blocks) this.profileService.resolveByUserId(block.userId);
                this.profileService.resolveByUserId(decision.createdByUserId);
            }
        });
    }

    ngOnDestroy(): void {
        clearInterval(this.tickId);
    }

    // ── Template helpers. Thin delegates to decision-outcome.ts, which the specs own. ──

    protected options(decision: Decision): DecisionOption[] {
        return optionsInDisplayOrder(decision);
    }

    protected standing(decision: Decision, option: DecisionOption) {
        return optionStanding(decision, option);
    }

    protected optionBlocks(decision: Decision, optionId: string): DecisionBlock[] {
        return blocksForOption(decision, optionId);
    }

    protected decisionBlocks(decision: Decision): DecisionBlock[] {
        return wholeDecisionBlocks(decision);
    }

    protected quorum(decision: Decision) {
        return quorumProgress(decision);
    }

    protected isOpen(decision: Decision): boolean {
        return isDecisionOpen(decision);
    }

    /** Past its deadline but not yet resolved; never flips the badge: the server owns the status. */
    protected awaitingResolution(decision: Decision): boolean {
        return isAwaitingResolution(decision, this.nowTick());
    }

    protected resultKey(decision: Decision): string {
        return decisionResultKey(decision);
    }

    protected statusTone(decision: Decision) {
        return decisionStatusTone(decision.status);
    }

    protected outcomeTitle(decision: Decision): string | null {
        return decision.options.find(o => o.id === decision.outcomeOptionId)?.title ?? null;
    }

    protected userName(userId: string): string {
        return this.profileService.getCachedByUserId(userId)?.userName ?? '';
    }

    /** The caller's current pick, so the option row reads "your choice" rather than offering it again. */
    protected isMyChoice(decision: Decision, option: DecisionOption): boolean {
        return decision.myVoteKind === DecisionVoteKind.Support && decision.myVoteOptionId === option.id;
    }

    // ── Voting ──────────────────────────────────────────────────────────────

    /** Offered on blocked options too, deliberately: supporting a vetoed option is legitimate, it just cannot carry it. */
    protected support(decision: Decision, option: DecisionOption): void {
        void this.submitVote(decision, {kind: DecisionVoteKind.Support, optionId: option.id});
    }

    /** Present, but not counted toward quorum: which is why a house of abstainers expires. */
    protected abstain(decision: Decision): void {
        void this.submitVote(decision, {kind: DecisionVoteKind.Abstain});
    }

    protected openBlock(decision: Decision, optionId: string | null): void {
        this.blockReason.set('');
        this.blockTarget.set({decision, optionId});
    }

    /** The dialog's own dismiss paths (escape, mask, ✕) all arrive here as `false`. */
    protected onBlockDialogVisible(visible: boolean): void {
        if (!visible) this.blockTarget.set(null);
    }

    protected async submitBlock(): Promise<void> {
        const target = this.blockTarget();
        if (!target || !this.canSubmitBlock()) return;
        this.blocking.set(true);
        const ok = await this.submitVote(target.decision, {
            kind: DecisionVoteKind.Block,
            optionId: target.optionId,
            reason: this.blockReason().trim(),
        });
        this.blocking.set(false);
        if (ok) this.blockTarget.set(null);
    }

    private async submitVote(decision: Decision, body: DecisionVoteDto): Promise<boolean> {
        this.busyDecisionId.set(decision.id);
        try {
            await this.decisions.vote(this.channel().id, decision.id, body);
            return true;
        } catch (err) {
            this.toast.httpError(this.translate.instant('DECISIONS.VOTE_FAILED'), err);
            return false;
        } finally {
            this.busyDecisionId.set(null);
        }
    }

    // ── Opening, closing, cancelling ────────────────────────────────────────

    protected openCreate(): void {
        this.draftTitle.set('');
        this.draftDescription.set('');
        this.draftQuorum.set(null);
        this.draftClosesAt.set(null);
        this.draftOptions.set(Array(MIN_OPTIONS).fill(''));
        this.showCreate.set(true);
    }

    protected setOption(index: number, value: string): void {
        this.draftOptions.update(list => list.map((o, i) => (i === index ? value : o)));
    }

    protected addOption(): void {
        this.draftOptions.update(list => (list.length >= MAX_OPTIONS ? list : [...list, '']));
    }

    protected removeOption(index: number): void {
        this.draftOptions.update(list =>
            list.length <= MIN_OPTIONS ? list : list.filter((_, i) => i !== index),
        );
    }

    /** A whole number of votes, or null for "no threshold"; zero and negatives collapse to null since the server refuses a quorum below one. */
    private normalizedQuorum(): number | null {
        const quorum = Math.trunc(this.draftQuorum() ?? 0);
        return Number.isFinite(quorum) && quorum >= DECISION_LIMITS.quorumMin ? quorum : null;
    }

    protected async createDecision(): Promise<void> {
        if (!this.canSubmitCreate() || this.creating()) return;
        this.creating.set(true);
        const dto: CreateDecisionDto = this.draftBody();
        try {
            await this.decisions.create(this.channel().id, dto);
            this.showCreate.set(false);
        } catch (err) {
            this.toast.httpError(this.translate.instant('DECISIONS.CREATE_FAILED'), err);
        } finally {
            this.creating.set(false);
        }
    }

    /** Resolves now. The outcome is the server's: closing a fully blocked decision yields Blocked. */
    protected async closeDecision(decision: Decision): Promise<void> {
        this.busyDecisionId.set(decision.id);
        try {
            await this.decisions.close(this.channel().id, decision.id);
        } catch (err) {
            this.toast.httpError(this.translate.instant('DECISIONS.CLOSE_FAILED'), err);
        } finally {
            this.busyDecisionId.set(null);
        }
    }

    protected async cancelDecision(decision: Decision): Promise<void> {
        this.busyDecisionId.set(decision.id);
        try {
            await this.decisions.cancel(this.channel().id, decision.id);
        } catch (err) {
            this.toast.httpError(this.translate.instant('DECISIONS.CANCEL_FAILED'), err);
        } finally {
            this.busyDecisionId.set(null);
        }
    }

    protected retry(): void {
        void this.decisions.loadFor(this.channel().id, true);
    }
}
