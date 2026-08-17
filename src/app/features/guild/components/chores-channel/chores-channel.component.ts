import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {InputNumber} from 'primeng/inputnumber';
import {DatePicker} from 'primeng/datepicker';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Tooltip} from 'primeng/tooltip';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {
    Chore,
    ChoreBalanceEntry,
    ChoreOccurrence,
    CHORE_LIMITS,
    balanceStanding,
    canNudge,
    choreAssignmentError,
    nextNudgeAt,
    occurrenceStatus,
    wasDoneByProxy,
} from '../../../../dtos/response/chore.dto';
import {CreateChoreDto, UpdateChoreDto} from '../../../../dtos/request/chore.dto';
import {ChoreService} from '../../../../services/chore.service';
import {GuildService} from '../../../../services/guild.service';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {channelIcon} from '../../channel-types';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {guildAbilities} from '../../guild-permissions';
import {defaultRotationRoleId} from '../../household-roles';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {EntitlementStore} from '../../../../stores/entitlement.store';
import {ModuleNotInPlanComponent} from '../module-not-in-plan/module-not-in-plan.component';

/** Which of the two mutually exclusive assignment fields the editor is filling in. */
type AssignmentMode = 'rotation' | 'fixed';

/** How many members to pull for the name map and the fixed-assignee picker. */
const MEMBER_PAGE = 200;

@Component({
    selector: 'app-chores-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        DatePipe,
        FormsModule,
        TranslateModule,
        Button,
        Dialog,
        InputText,
        Textarea,
        InputNumber,
        DatePicker,
        Select,
        ToggleSwitch,
        Tooltip,
        ModuleNotInPlanComponent,
    ],
    templateUrl: './chores-channel.component.html',
})
export class ChoresChannelComponent {
    readonly channel = input.required<ChannelDto>();
    back = output();

    protected navService = inject(NavigationService);
    private choreService = inject(ChoreService);
    private entitlements = inject(EntitlementStore);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private minuteClock = inject(MinuteClockService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    // A getter, not a field: a class field initialised from an imported const reads undefined
    // under Vite in full-suite runs. Passes solo, so it looks like flake.
    protected get limits() {
        return CHORE_LIMITS;
    }

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    private readonly members = signal<readonly GuildMemberDto[]>([]);

    protected readonly icon = computed(() => channelIcon(this.channel().type) ?? 'pi pi-sync');

    private readonly guild = computed(
        () => this.guildService.guilds().find(g => g.id === this.channel().guildId) ?? null,
    );

    /** The channel's own guild id, which is known before the guild list is. */
    protected readonly guildId = computed(() => this.channel().guildId);

    /** §13.2: a 403 from a household endpoint usually means the module is off, not a missing permission (no owner exemption); features must be read first or the empty state accuses the user instead. */
    protected readonly moduleEnabled = computed(() => guildHasFeature(this.guild(), GuildFeature.Chores));

    /** False while no resolution is held ("not loaded" is not evidence); a different remedy from {@link moduleEnabled}, since nobody in-house can toggle a plan limit away. */
    protected readonly moduleWithheld = computed(
        () => this.entitlements.moduleStanding(this.guildId(), GuildFeature.Chores) === 'withheld',
    );

    // ── Permissions ─────────────────────────────────────────────────────────

    protected readonly ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    /** Server-corrected, ticking every half minute; must be read live, never a frozen Date.now(), or the nudge button silently goes stale. */
    private readonly nowTick = computed(() => this.minuteClock.now());

    /** Owner checked first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them; the module gate above is separate and is never waived by this. */
    private readonly abilities = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.ownUserId()),
    );

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** Create/edit/delete chores and set effort weights. */
    protected readonly canManage = computed(
        () => this.moduleEnabled() && this.can(ModulePermissions.ManageChores),
    );
    /** Complete, skip and swap an occurrence: the collaborative half. */
    protected readonly canComplete = computed(
        () => this.moduleEnabled() && this.can(ModulePermissions.CompleteChores),
    );

    // ── Board ───────────────────────────────────────────────────────────────

    private readonly state = computed(() => this.choreService.stateFor(this.channel().id));

    protected readonly loading = computed(() => this.state().loading);
    protected readonly loadFailed = computed(() => this.state().error && !this.state().forbidden);
    protected readonly forbidden = computed(() => this.state().forbidden);
    protected readonly chores = computed(() =>
        [...this.state().chores].sort((a, b) => a.title.localeCompare(b.title)),
    );
    protected readonly hasLoaded = computed(() => this.state().loadedAt > 0);

    private byDueAsc = (a: ChoreOccurrence, b: ChoreOccurrence) =>
        new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();

    /** The four buckets, resolved through {@link occurrenceStatus} rather than by testing `completedAt` inline: that inline check is how a skipped turn ends up in the Done column. */
    private readonly buckets = computed(() => {
        const out = {
            overdue: [] as ChoreOccurrence[],
            upcoming: [] as ChoreOccurrence[],
            done: [] as ChoreOccurrence[],
            skipped: [] as ChoreOccurrence[],
        };
        for (const occurrence of this.state().occurrences) {
            switch (occurrenceStatus(occurrence)) {
                case 'skipped':
                    out.skipped.push(occurrence);
                    break;
                case 'done':
                    out.done.push(occurrence);
                    break;
                case 'overdue':
                    out.overdue.push(occurrence);
                    break;
                default:
                    out.upcoming.push(occurrence);
            }
        }

        out.overdue.sort(this.byDueAsc);
        out.upcoming.sort(this.byDueAsc);
        // Finished work reads newest-first; nobody scrolls to last fortnight's washing-up.
        out.done.sort((a, b) => -this.byDueAsc(a, b));
        out.skipped.sort((a, b) => -this.byDueAsc(a, b));
        return out;
    });

    /** Only non-empty buckets, in the order they demand attention; Skipped stays its own section, never merged into Done. */
    protected readonly sections = computed(() => {
        const {overdue, upcoming, skipped, done} = this.buckets();
        return (
            [
                {
                    key: 'overdue',
                    titleKey: 'CHORES.SECTION_OVERDUE',
                    hintKey: null,
                    tone: 'overdue',
                    items: overdue,
                },
                {
                    key: 'upcoming',
                    titleKey: 'CHORES.SECTION_UPCOMING',
                    hintKey: null,
                    tone: 'due',
                    items: upcoming,
                },
                {
                    key: 'skipped',
                    titleKey: 'CHORES.SECTION_SKIPPED',
                    hintKey: 'CHORES.SKIPPED_HINT',
                    tone: 'skipped',
                    items: skipped,
                },
                {key: 'done', titleKey: 'CHORES.SECTION_DONE', hintKey: null, tone: 'done', items: done},
            ] as const
        ).filter(section => section.items.length > 0);
    });

    protected readonly boardEmpty = computed(() => this.hasLoaded() && this.state().chores.length === 0);

    protected readonly noTurns = computed(
        () => this.hasLoaded() && this.state().chores.length > 0 && this.state().occurrences.length === 0,
    );

    // ── Balance ─────────────────────────────────────────────────────────────

    /** Furthest behind their share first: that is the row the rota is about to act on. */
    protected readonly balance = computed(() =>
        [...this.state().balance].sort((a, b) => a.balanceMinutes - b.balanceMinutes),
    );

    protected standing = (entry: ChoreBalanceEntry) => balanceStanding(entry);

    /** Always the magnitude; the sign is carried by which sentence {@link standing} picks. */
    protected balanceMagnitude = (entry: ChoreBalanceEntry) => Math.abs(entry.balanceMinutes);

    /** Widest bar in the panel, so the bars compare members to each other and not to nothing. */
    private readonly balanceScale = computed(() =>
        Math.max(1, ...this.balance().map(e => Math.abs(e.balanceMinutes))),
    );

    protected balanceWidth = (entry: ChoreBalanceEntry): number =>
        Math.round((Math.abs(entry.balanceMinutes) / this.balanceScale()) * 100);

    /** Null on a server that predates absences: the board then says less, rather than inventing a window. */
    protected presentDaysOf = (entry: ChoreBalanceEntry): number | null => entry.presentDays ?? null;

    /** The window the balance spans, so "16 of 30 days" has a denominator to name. */
    protected get balanceWindowDays() {
        return CHORE_LIMITS.balanceDefaultDays;
    }

    /** Somebody was away for part of it, so the weighting is worth explaining at all. */
    protected readonly anyPartialPresence = computed(() =>
        this.balance().some(entry => entry.presentDays != null && entry.presentDays < this.balanceWindowDays),
    );

    // ── Names ───────────────────────────────────────────────────────────────

    private readonly memberNames = computed(() => {
        const map = new Map<string, string>();
        for (const member of this.members()) {
            const name = member.nickname ?? member.profile?.userName;
            if (name) map.set(member.userId, name);
        }
        return map;
    });

    /** Falls back through the profile cache, then to a neutral noun; never to a raw id. */
    protected nameOf(userId: string | null | undefined): string {
        if (!userId) return this.translate.instant('CHORES.UNKNOWN_MEMBER');
        return (
            this.memberNames().get(userId) ??
            this.profileService.getCachedByUserId(userId)?.userName ??
            this.translate.instant('CHORES.UNKNOWN_MEMBER')
        );
    }

    protected roleNameOf(roleId: string | null | undefined): string {
        if (!roleId) return this.translate.instant('CHORES.UNKNOWN_ROLE');
        return (
            this.guild()?.roles.find(r => r.id === roleId)?.name ??
            this.translate.instant('CHORES.UNKNOWN_ROLE')
        );
    }

    protected choreTitleFor(occurrence: ChoreOccurrence): string {
        // Denormalized onto the occurrence at generation time, so a renamed chore keeps the title its old turns were assigned under.
        return occurrence.title;
    }

    /** "Ben did Anna's washing-up": both names, because the balance credits only one of them. */
    protected isProxyCompletion = (occurrence: ChoreOccurrence) => wasDoneByProxy(occurrence);

    // ── Editor ──────────────────────────────────────────────────────────────

    protected readonly showEditor = signal(false);
    protected readonly editing = signal<Chore | null>(null);
    protected readonly saving = signal(false);

    protected readonly formTitle = signal('');
    protected readonly formDescription = signal('');
    protected readonly formIntervalDays = signal<number>(7);
    protected readonly formAnchorAt = signal<Date | null>(null);
    protected readonly formEffortMinutes = signal<number>(15);
    protected readonly formGraceHours = signal<number>(12);
    protected readonly formMode = signal<AssignmentMode>('rotation');
    protected readonly formRotationRoleId = signal<string | null>(null);
    protected readonly formFixedAssigneeUserId = signal<string | null>(null);
    protected readonly formPaused = signal(false);
    /** Raised once Save has been pressed, so the form does not scold a half-filled draft. */
    protected readonly showValidation = signal(false);

    protected readonly roleOptions = computed(() =>
        (this.guild()?.roles ?? []).map(r => ({label: r.name, value: r.id})),
    );

    protected readonly memberOptions = computed(() =>
        this.members().map(m => ({label: this.nameOf(m.userId), value: m.userId})),
    );

    /** Only the field for the selected mode is populated; the "both set" case is still checked, since a future third mode could reintroduce it silently. */
    private readonly draftAssignment = computed(() =>
        this.formMode() === 'rotation'
            ? {rotationRoleId: this.formRotationRoleId(), fixedAssigneeUserId: null}
            : {rotationRoleId: null, fixedAssigneeUserId: this.formFixedAssigneeUserId()},
    );

    protected readonly assignmentError = computed(() => choreAssignmentError(this.draftAssignment()));

    protected readonly titleValid = computed(() => {
        const title = this.formTitle().trim();
        return title.length > 0 && title.length <= CHORE_LIMITS.titleMaxLength;
    });
    protected readonly intervalValid = computed(() => {
        const days = this.formIntervalDays();
        return (
            Number.isFinite(days) &&
            days >= CHORE_LIMITS.intervalDaysMin &&
            days <= CHORE_LIMITS.intervalDaysMax
        );
    });
    protected readonly effortValid = computed(() => {
        const minutes = this.formEffortMinutes();
        return (
            Number.isFinite(minutes) &&
            minutes >= CHORE_LIMITS.effortMinutesMin &&
            minutes <= CHORE_LIMITS.effortMinutesMax
        );
    });
    /** 0-336. The upper bound is the server's and is easy to blow past with a "grace of a month". */
    protected readonly graceValid = computed(() => {
        const hours = this.formGraceHours();
        return (
            Number.isFinite(hours) &&
            hours >= CHORE_LIMITS.graceHoursMin &&
            hours <= CHORE_LIMITS.graceHoursMax
        );
    });

    /** No anchor check: the server anchors an omitted `anchorAt` at *now*, so a cleared date picker means "starting today" rather than an incomplete draft. */
    protected readonly canSave = computed(
        () =>
            !this.saving() &&
            this.titleValid() &&
            this.intervalValid() &&
            this.effortValid() &&
            this.graceValid() &&
            this.assignmentError() === null,
    );

    // ── Delete confirmation ─────────────────────────────────────────────────

    protected readonly pendingDelete = signal<Chore | null>(null);
    protected readonly deleting = signal(false);

    /** The chore whose pause toggle is mid-flight, so one row spins rather than the whole list. */
    protected readonly pausing = signal<string | null>(null);

    constructor() {
        // The nudge button greys itself purely by the passage of time, so the board needs a clock that ticks rather than one sampled at render.
        this.minuteClock.retain();

        // Only fired once the module reads as off: a house with it on would pay for the request every open for nothing.
        effect(() => {
            if (!this.moduleEnabled()) this.entitlements.ensureFeaturesLoaded(this.guildId());
        });

        // Kept separate from the load effect below, which also depends on guilds(): folding them together would re-issue member requests on every guild-list refresh.
        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => {
                this.guildService.getOwnMember(guildId).subscribe({
                    next: member => this.ownMember.set(member),
                    // Permissions fail closed while unknown: an action is never briefly offered to someone who turns out not to have it.
                    error: () => this.ownMember.set(null),
                });
                this.guildService.getMembers(guildId, 0, MEMBER_PAGE).subscribe({
                    next: members => this.members.set(members),
                    // Names degrade to the profile cache; the board is still usable without them.
                    error: () => undefined,
                });
            });
        });

        effect(() => {
            const channelId = this.channel().id;
            // §13.2: fetched only once the module reads enabled, to avoid three guaranteed 403s; re-runs when guilds() lands, and loadFor is TTL-guarded so repeats are no-ops.
            const enabled = this.moduleEnabled();
            untracked(() => {
                if (enabled) this.choreService.loadFor(channelId);
            });
        });
    }

    protected reload(): void {
        this.choreService.loadFor(this.channel().id, true);
    }

    // ── Verbs ───────────────────────────────────────────────────────────────

    protected onComplete(occurrence: ChoreOccurrence): void {
        this.choreService.complete(occurrence).subscribe({
            error: err => this.toastService.httpError(this.translate.instant('CHORES.COMPLETE_ERROR'), err),
        });
    }

    protected onUnComplete(occurrence: ChoreOccurrence): void {
        this.choreService.unComplete(occurrence).subscribe({
            error: err => this.toastService.httpError(this.translate.instant('CHORES.UNCOMPLETE_ERROR'), err),
        });
    }

    protected onSkip(occurrence: ChoreOccurrence): void {
        this.choreService.skip(occurrence).subscribe({
            error: err => this.toastService.httpError(this.translate.instant('CHORES.SKIP_ERROR'), err),
        });
    }

    /** Every clause here mirrors a way the endpoint refuses, so the control is absent rather than offered and then explained. */
    protected canNudgeOccurrence(occurrence: ChoreOccurrence): boolean {
        const chore = this.state().chores.find(c => c.id === occurrence.choreId);
        if (!chore) return false;
        return canNudge(occurrence, chore.graceHours, this.ownUserId(), this.nowTick());
    }

    /** Somebody has nudged inside the cooldown, so the button is greyed rather than removed. */
    protected nudgeOnCooldown(occurrence: ChoreOccurrence): boolean {
        const next = nextNudgeAt(occurrence);
        return !!next && next.getTime() > this.nowTick();
    }

    /** Nothing here names the sender; the app does the asking. The two 409s (already nudged vs quiet hours) get separate messages, and quiet-hours is rejected rather than deferred. */
    protected onNudge(occurrence: ChoreOccurrence): void {
        this.choreService.nudge(occurrence).subscribe({
            next: () => this.toastService.success(this.translate.instant('CHORES.NUDGE_SENT')),
            error: err => {
                if (err instanceof HttpErrorResponse && err.status === 409) {
                    const body = err.error as {quietUntil?: string; nextNudgeAt?: string} | null;
                    if (body?.quietUntil) {
                        this.toastService.warn(this.translate.instant('CHORES.NUDGE_QUIET_TITLE'), {
                            detail: this.translate.instant('CHORES.NUDGE_QUIET_BODY', {
                                time: this.timeLabel(body.quietUntil),
                            }),
                            life: 8000,
                        });
                        return;
                    }
                    this.toastService.warn(this.translate.instant('CHORES.NUDGE_COOLDOWN_TITLE'), {
                        detail: this.translate.instant('CHORES.NUDGE_COOLDOWN_BODY'),
                        life: 8000,
                    });
                    return;
                }
                this.toastService.httpError(this.translate.instant('CHORES.NUDGE_ERROR'), err);
            },
        });
    }

    private timeLabel(iso: string): string {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'}).format(date);
    }

    /** 400 from /swap is the ordinary "nobody else in this rotation" case (fixed assignee, or a one-member role); it gets its own sentence rather than a bare [400] toast. */
    protected onSwap(occurrence: ChoreOccurrence): void {
        this.choreService.swap(occurrence).subscribe({
            error: err => {
                if (err instanceof HttpErrorResponse && err.status === 400) {
                    this.toastService.warn(this.translate.instant('CHORES.SWAP_NOBODY_TITLE'), {
                        detail: this.translate.instant('CHORES.SWAP_NOBODY_BODY'),
                        life: 8000,
                    });
                    return;
                }
                this.toastService.httpError(this.translate.instant('CHORES.SWAP_ERROR'), err);
            },
        });
    }

    // ── Editor ──────────────────────────────────────────────────────────────

    protected openCreate(): void {
        this.editing.set(null);
        this.formTitle.set('');
        this.formDescription.set('');
        this.formIntervalDays.set(7);
        this.formAnchorAt.set(this.tomorrowMorning());
        this.formEffortMinutes.set(15);
        this.formGraceHours.set(12);
        this.formMode.set('rotation');
        // Households are seeded with a Flatmates role, so defaulting to it fits the ordinary case; null when a guild has none, so the picker asks rather than guessing.
        this.formRotationRoleId.set(defaultRotationRoleId(this.guild()));
        this.formFixedAssigneeUserId.set(null);
        this.formPaused.set(false);
        this.showValidation.set(false);
        this.showEditor.set(true);
    }

    protected openEdit(chore: Chore): void {
        this.editing.set(chore);
        this.formTitle.set(chore.title);
        this.formDescription.set(chore.description ?? '');
        this.formIntervalDays.set(chore.intervalDays);
        this.formAnchorAt.set(new Date(chore.anchorAt));
        this.formEffortMinutes.set(chore.effortMinutes);
        this.formGraceHours.set(chore.graceHours);
        this.formMode.set(chore.fixedAssigneeUserId ? 'fixed' : 'rotation');
        this.formRotationRoleId.set(chore.rotationRoleId ?? null);
        this.formFixedAssigneeUserId.set(chore.fixedAssigneeUserId ?? null);
        this.formPaused.set(chore.isPaused);
        this.showValidation.set(false);
        this.showEditor.set(true);
    }

    protected setMode(mode: AssignmentMode): void {
        this.formMode.set(mode);
    }

    protected closeEditor(): void {
        this.showEditor.set(false);
        // Also runs from (onHide): dismissing mid-save must not leave Save stuck spinning next time.
        this.saving.set(false);
    }

    protected save(): void {
        this.showValidation.set(true);
        if (!this.canSave()) return;
        this.saving.set(true);

        const assignment = this.draftAssignment();
        const anchorAt = this.formAnchorAt();
        const existing = this.editing();

        /** Shared by both verbs; `anchorAt` is not in here, see below. */
        const common = {
            title: this.formTitle().trim(),
            description: this.formDescription().trim() || null,
            intervalDays: this.formIntervalDays(),
            effortMinutes: this.formEffortMinutes(),
            graceHours: this.formGraceHours(),
            // Both sent, one null: inert on PATCH (server applies a field only when non-null), so it exists to keep the create body unambiguous, not to clear anything.
            rotationRoleId: assignment.rotationRoleId,
            fixedAssigneeUserId: assignment.fixedAssigneeUserId,
        };

        const request = existing
            ? // No anchorAt: UpdateChoreDto has no such field server-side, so sending one is silently dropped, not refused; from the dialog it looks like a re-phase that worked.
              this.choreService.updateChore(this.channel().id, existing.id, {
                  ...common,
                  isPaused: this.formPaused(),
              } satisfies UpdateChoreDto)
            : // Omitted rather than null when the picker is empty: the server defaults to "now," and an explicit null would say less for the same effect.
              this.choreService.createChore(this.channel().id, {
                  ...common,
                  ...(anchorAt ? {anchorAt: anchorAt.toISOString()} : {}),
              } satisfies CreateChoreDto);

        request.subscribe({
            next: () => {
                this.saving.set(false);
                this.showEditor.set(false);
                // The first occurrence is generated server-side and arrives over guild.ChoreOccurrenceCreated; nothing is computed here.
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('CHORES.SAVE_ERROR'), err);
            },
        });
    }

    // ── Pause ───────────────────────────────────────────────────────────────

    /** One-field PATCH; the row updates from the response, and the realtime echo that follows is an upsert on the same id. */
    protected togglePause(chore: Chore): void {
        if (this.pausing() === chore.id) return;
        this.pausing.set(chore.id);
        this.choreService.setPaused(this.channel().id, chore.id, !chore.isPaused).subscribe({
            next: () => this.pausing.set(null),
            error: err => {
                this.pausing.set(null);
                this.toastService.httpError(this.translate.instant('CHORES.SAVE_ERROR'), err);
            },
        });
    }

    // ── Delete ──────────────────────────────────────────────────────────────

    protected askDelete(chore: Chore): void {
        this.pendingDelete.set(chore);
    }

    protected confirmDelete(): void {
        const chore = this.pendingDelete();
        if (!chore || this.deleting()) return;
        this.deleting.set(true);

        this.choreService.deleteChore(this.channel().id, chore.id).subscribe({
            next: () => {
                this.deleting.set(false);
                this.pendingDelete.set(null);
            },
            error: err => {
                this.deleting.set(false);
                this.pendingDelete.set(null);
                this.toastService.httpError(this.translate.instant('CHORES.DELETE_ERROR'), err);
            },
        });
    }

    /** Tomorrow at 09:00 local: "the first time this is due," not "right now". */
    private tomorrowMorning(): Date {
        const date = new Date();
        date.setDate(date.getDate() + 1);
        date.setHours(9, 0, 0, 0);
        return date;
    }
}
