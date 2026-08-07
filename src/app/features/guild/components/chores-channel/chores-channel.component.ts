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
import {effectiveGuildPermissions} from '../../guild-permissions';
import {defaultRotationRoleId} from '../../household-roles';
import {hasPermission, Permissions} from '../../../../enums/permissions.enum';

/** Which of the two mutually exclusive assignment fields the editor is filling in. */
type AssignmentMode = 'rotation' | 'fixed';

/** How many members to pull for the name map and the fixed-assignee picker. */
const MEMBER_PAGE = 200;

/**
 * A Chores channel: the rota's turns, the chore definitions behind them, and the fairness balance.
 *
 * <p>No composer and no message history - this channel type has neither. What it has instead is a
 * board of server-generated occurrences, which is the one thing about the module that the UI must
 * not lie about: <b>the client never creates a turn</b>, so there is no "add for tomorrow" here,
 * only "add a chore" and a cadence the server steps through.</p>
 *
 * <p>The copy leans hard on two rules that a plausible-looking chores UI gets backwards. Skipping
 * is not completing - a skipped turn is drawn as outstanding work, not as a struck-through done
 * row - and the balance is a delta from the house average, so it reads "behind their share", never
 * as a total.</p>
 */
@Component({
    selector: 'app-chores-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        DatePipe, FormsModule, TranslateModule,
        Button, Dialog, InputText, Textarea, InputNumber, DatePicker, Select, ToggleSwitch, Tooltip,
    ],
    templateUrl: './chores-channel.component.html',
})
export class ChoresChannelComponent {
    channel = input.required<ChannelDto>();
    back = output();

    protected navService = inject(NavigationService);
    private choreService = inject(ChoreService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private minuteClock = inject(MinuteClockService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly limits = CHORE_LIMITS;

    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private members = signal<readonly GuildMemberDto[]>([]);

    protected icon = computed(() => channelIcon(this.channel().type) ?? 'pi pi-sync');

    private guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.channel().guildId) ?? null);

    /**
     * §13.2: a `403` from any household endpoint usually means the module is off rather than that
     * the caller lacks a bit, and the owner gets no exemption. Reading `features` first is what
     * lets the empty state say "this house doesn't do chores" instead of accusing the user.
     */
    protected moduleEnabled = computed(() => guildHasFeature(this.guild(), GuildFeature.Chores));

    // ── Permissions ─────────────────────────────────────────────────────────

    private permissions = computed(() => effectiveGuildPermissions(this.ownMember()));

    protected ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    private isOwner = computed(() => {
        const ownUserId = this.ownUserId();
        const ownerId = this.guild()?.ownerId;
        return !!ownUserId && !!ownerId && ownUserId === ownerId;
    });

    /**
     * Server-corrected now, ticking every half minute.
     *
     * <p>The nudge button's whole existence is a comparison against the clock - overdue past the
     * grace period, and outside the twelve-hour cooldown - so a frozen `Date.now()` captured at
     * render would leave the control absent for as long as the board stayed open past the moment it
     * should have appeared. Read through the server clock because both bounds are server-issued.</p>
     */
    private nowTick = computed(() => this.minuteClock.now());

    /**
     * Owner first, because `SelfGuildMemberDto.permissions` does not reliably carry Superadmin for
     * them. The module gate above is checked separately and is <b>not</b> waived by any of this -
     * an owner of a house without the Chores module has no escape hatch, and there is no point
     * building one into the client.
     */
    private can = (permission: bigint): boolean => this.isOwner()
        || hasPermission(this.permissions(), Permissions.Superadmin)
        || hasPermission(this.permissions(), permission);

    /** Create/edit/delete chores and set effort weights. */
    protected canManage = computed(() => this.moduleEnabled() && this.can(Permissions.ManageChores));
    /** Complete, skip and swap an occurrence - the collaborative half. */
    protected canComplete = computed(() => this.moduleEnabled() && this.can(Permissions.CompleteChores));

    // ── Board ───────────────────────────────────────────────────────────────

    private state = computed(() => this.choreService.stateFor(this.channel().id));

    protected loading = computed(() => this.state().loading);
    protected loadFailed = computed(() => this.state().error && !this.state().forbidden);
    protected forbidden = computed(() => this.state().forbidden);
    protected chores = computed(() =>
        [...this.state().chores].sort((a, b) => a.title.localeCompare(b.title)));
    protected hasLoaded = computed(() => this.state().loadedAt > 0);

    private byDueAsc = (a: ChoreOccurrence, b: ChoreOccurrence) =>
        new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();

    /**
     * The four buckets, resolved through {@link occurrenceStatus} rather than by testing
     * `completedAt` inline - which is how a skipped turn ends up in the Done column.
     */
    private buckets = computed(() => {
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

    /**
     * The board, as rendered: only non-empty buckets, in the order they demand attention.
     *
     * <p>Skipped is its own section between the outstanding work and the done pile - never merged
     * into Done and never quietly dropped. A skip is a thing that happened to work that still
     * needs doing, and hiding it is what makes the rota's behaviour look arbitrary when the same
     * turn comes back to the same person.</p>
     */
    protected sections = computed(() => {
        const {overdue, upcoming, skipped, done} = this.buckets();
        return ([
            {key: 'overdue', titleKey: 'CHORES.SECTION_OVERDUE', hintKey: null, tone: 'overdue', items: overdue},
            {key: 'upcoming', titleKey: 'CHORES.SECTION_UPCOMING', hintKey: null, tone: 'due', items: upcoming},
            {key: 'skipped', titleKey: 'CHORES.SECTION_SKIPPED', hintKey: 'CHORES.SKIPPED_HINT', tone: 'skipped', items: skipped},
            {key: 'done', titleKey: 'CHORES.SECTION_DONE', hintKey: null, tone: 'done', items: done},
        ] as const).filter(section => section.items.length > 0);
    });

    protected boardEmpty = computed(() =>
        this.hasLoaded() && this.state().chores.length === 0);

    protected noTurns = computed(() =>
        this.hasLoaded() && this.state().chores.length > 0 && this.state().occurrences.length === 0);

    // ── Balance ─────────────────────────────────────────────────────────────

    /** Furthest behind their share first: that is the row the rota is about to act on. */
    protected balance = computed(() =>
        [...this.state().balance].sort((a, b) => a.balanceMinutes - b.balanceMinutes));

    protected standing = (entry: ChoreBalanceEntry) => balanceStanding(entry);

    /** Always the magnitude - the sign is carried by which sentence {@link standing} picks. */
    protected balanceMagnitude = (entry: ChoreBalanceEntry) => Math.abs(entry.balanceMinutes);

    /** Widest bar in the panel, so the bars compare members to each other and not to nothing. */
    private balanceScale = computed(() =>
        Math.max(1, ...this.balance().map(e => Math.abs(e.balanceMinutes))));

    protected balanceWidth = (entry: ChoreBalanceEntry): number =>
        Math.round(Math.abs(entry.balanceMinutes) / this.balanceScale() * 100);

    /**
     * How many days of the balance window this member was actually here.
     *
     * <p>The balance is weighted by it, so a fortnight in Lisbon no longer reads as being behind -
     * and surfacing the number is what lets the board <i>explain</i> itself rather than only assert.
     * "40 minutes light over the 16 days you were here" is a sentence people accept; the bare number
     * is the thing they argue with.</p>
     *
     * <p>Null on a server that predates absences, in which case the board says less rather than
     * inventing a window.</p>
     */
    protected presentDaysOf = (entry: ChoreBalanceEntry): number | null => entry.presentDays ?? null;

    /** The window the balance spans, so "16 of 30 days" has a denominator to name. */
    protected readonly balanceWindowDays = CHORE_LIMITS.balanceDefaultDays;

    /** Somebody was away for part of it, so the weighting is worth explaining at all. */
    protected anyPartialPresence = computed(() => this.balance().some(entry =>
        entry.presentDays != null && entry.presentDays < this.balanceWindowDays));

    // ── Names ───────────────────────────────────────────────────────────────

    private memberNames = computed(() => {
        const map = new Map<string, string>();
        for (const member of this.members()) {
            const name = member.nickname ?? member.profile?.userName;
            if (name) map.set(member.userId, name);
        }
        return map;
    });

    /** Falls back through the profile cache, then to a neutral noun - never to a raw id. */
    protected nameOf(userId: string | null | undefined): string {
        if (!userId) return this.translate.instant('CHORES.UNKNOWN_MEMBER');
        return this.memberNames().get(userId)
            ?? this.profileService.getCachedByUserId(userId)?.userName
            ?? this.translate.instant('CHORES.UNKNOWN_MEMBER');
    }

    protected roleNameOf(roleId: string | null | undefined): string {
        if (!roleId) return this.translate.instant('CHORES.UNKNOWN_ROLE');
        return this.guild()?.roles.find(r => r.id === roleId)?.name
            ?? this.translate.instant('CHORES.UNKNOWN_ROLE');
    }

    protected choreTitleFor(occurrence: ChoreOccurrence): string {
        // Denormalized onto the occurrence at generation time, so a renamed chore keeps the title
        // its old turns were actually assigned under.
        return occurrence.title;
    }

    /** "Ben did Anna's washing-up" - both names, because the balance credits only one of them. */
    protected isProxyCompletion = (occurrence: ChoreOccurrence) => wasDoneByProxy(occurrence);

    // ── Editor ──────────────────────────────────────────────────────────────

    protected showEditor = signal(false);
    protected editing = signal<Chore | null>(null);
    protected saving = signal(false);

    protected formTitle = signal('');
    protected formDescription = signal('');
    protected formIntervalDays = signal<number>(7);
    protected formAnchorAt = signal<Date | null>(null);
    protected formEffortMinutes = signal<number>(15);
    protected formGraceHours = signal<number>(12);
    protected formMode = signal<AssignmentMode>('rotation');
    protected formRotationRoleId = signal<string | null>(null);
    protected formFixedAssigneeUserId = signal<string | null>(null);
    protected formPaused = signal(false);
    /** Raised once Save has been pressed, so the form does not scold a half-filled draft. */
    protected showValidation = signal(false);

    protected roleOptions = computed(() =>
        (this.guild()?.roles ?? []).map(r => ({label: r.name, value: r.id})));

    protected memberOptions = computed(() =>
        this.members().map(m => ({label: this.nameOf(m.userId), value: m.userId})));

    /**
     * The assignment the draft would send. Only the field belonging to the selected mode is
     * populated, so the "both are set" case cannot be produced by the UI at all - it is still
     * checked, because a future third mode would otherwise reintroduce it silently.
     */
    private draftAssignment = computed(() => this.formMode() === 'rotation'
        ? {rotationRoleId: this.formRotationRoleId(), fixedAssigneeUserId: null}
        : {rotationRoleId: null, fixedAssigneeUserId: this.formFixedAssigneeUserId()});

    protected assignmentError = computed(() => choreAssignmentError(this.draftAssignment()));

    protected titleValid = computed(() => {
        const title = this.formTitle().trim();
        return title.length > 0 && title.length <= CHORE_LIMITS.titleMaxLength;
    });
    protected intervalValid = computed(() => {
        const days = this.formIntervalDays();
        return Number.isFinite(days)
            && days >= CHORE_LIMITS.intervalDaysMin && days <= CHORE_LIMITS.intervalDaysMax;
    });
    protected effortValid = computed(() => {
        const minutes = this.formEffortMinutes();
        return Number.isFinite(minutes)
            && minutes >= CHORE_LIMITS.effortMinutesMin && minutes <= CHORE_LIMITS.effortMinutesMax;
    });
    /** 0-336. The upper bound is the server's and is easy to blow past with a "grace of a month". */
    protected graceValid = computed(() => {
        const hours = this.formGraceHours();
        return Number.isFinite(hours)
            && hours >= CHORE_LIMITS.graceHoursMin && hours <= CHORE_LIMITS.graceHoursMax;
    });

    /**
     * No anchor check: the server anchors an omitted `anchorAt` at *now*, so a cleared date picker
     * means "starting today" rather than an incomplete draft.
     */
    protected canSave = computed(() =>
        !this.saving()
        && this.titleValid()
        && this.intervalValid()
        && this.effortValid()
        && this.graceValid()
        && this.assignmentError() === null);

    // ── Delete confirmation ─────────────────────────────────────────────────

    protected pendingDelete = signal<Chore | null>(null);
    protected deleting = signal(false);

    /** The chore whose pause toggle is mid-flight, so one row spins rather than the whole list. */
    protected pausing = signal<string | null>(null);

    constructor() {
        // The nudge button appears and greys itself purely by the passage of time, so the board
        // needs a clock that ticks rather than one sampled at render.
        this.minuteClock.retain();

        // Membership is keyed on the guild alone. Kept out of the load effect below because that
        // one also depends on `guilds()` - folding them together would re-issue two member
        // requests every time anything anywhere refreshed the guild list.
        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => {
                this.guildService.getOwnMember(guildId).subscribe({
                    next: member => this.ownMember.set(member),
                    // Permissions fail closed while unknown, which is the right way round: an
                    // action is never briefly offered to someone who turns out not to have it.
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
            // §13.2: with the module off, nothing is fetched at all. Firing the requests anyway
            // would trade three guaranteed 403s for an error state that says the wrong thing about
            // a house that simply doesn't run a rota. Re-runs when `guilds()` lands, which is when
            // the answer to this stops being "not yet"; `loadFor` is TTL-guarded, so the repeats
            // that come with that are no-ops.
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

    /**
     * Whether the nudge button belongs on this row at all.
     *
     * <p>Every clause mirrors a way the endpoint refuses, so the control is absent rather than
     * offered and then explained: not your own row, not done or skipped, and genuinely past the
     * chore's grace period. A nudge about something not yet overdue is not a reminder, it is a
     * person leaning over your shoulder - and that is what gets the whole feature muted.</p>
     */
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

    /**
     * Nudges the assignee.
     *
     * <p><b>Nothing in this flow names the sender</b>, here or in what the assignee receives. The
     * app does the asking so that nobody in the house has to be the person who nags; attributing it
     * hands the social cost straight back, and the feature is worth nothing after that.</p>
     *
     * <p>The two `409`s get their own sentences. One means somebody already asked and the chore has
     * not moved; the other means the house is asleep, and it is <b>rejected rather than deferred</b>
     * - a nudge arriving seven hours late about a bin that may well have been taken out is not the
     * message anybody sent.</p>
     */
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

    /**
     * `400` from `/swap` is the ordinary "there is nobody else in this rotation" case - a
     * fixed-assignee chore, or a rotation role with one member in it. It gets its own sentence
     * telling the user what would fix it, rather than a bare `[400]` toast.
     */
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
        // Households are seeded with a Flatmates role whose membership *is* the rota, so defaulting
        // to it is the answer in every ordinary case. Null in a guild that has none - the picker
        // then asks, rather than guessing at whichever role happens to sort first.
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

        /** Shared by both verbs. `anchorAt` is not in here - see below. */
        const common = {
            title: this.formTitle().trim(),
            description: this.formDescription().trim() || null,
            intervalDays: this.formIntervalDays(),
            effortMinutes: this.formEffortMinutes(),
            graceHours: this.formGraceHours(),
            // Both sent, one of them null. The null is inert on PATCH - the server applies each
            // field only when it is non-null - so it exists to keep the create body unambiguous,
            // not to clear anything.
            rotationRoleId: assignment.rotationRoleId,
            fixedAssigneeUserId: assignment.fixedAssigneeUserId,
        };

        const request = existing
            // No `anchorAt`: `UpdateChoreDto` has no such field server-side, so sending one is
            // dropped in silence rather than refused - which reads, from the dialog, exactly like
            // a re-phase that worked.
            ? this.choreService.updateChore(this.channel().id, existing.id,
                {...common, isPaused: this.formPaused()} satisfies UpdateChoreDto)
            // Omitted rather than sent as null when the picker is empty: the server's default is
            // "now", and an explicit null would deserialize to the same thing but say less.
            : this.choreService.createChore(this.channel().id, {
                ...common,
                ...(anchorAt ? {anchorAt: anchorAt.toISOString()} : {}),
            } satisfies CreateChoreDto);

        request.subscribe({
            next: () => {
                this.saving.set(false);
                this.showEditor.set(false);
                // The first occurrence is generated server-side on creation and arrives over
                // `guild.ChoreOccurrenceCreated`; nothing is computed here.
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('CHORES.SAVE_ERROR'), err);
            },
        });
    }

    // ── Pause ───────────────────────────────────────────────────────────────

    /**
     * Flips the chore between running and paused with a one-field PATCH.
     *
     * <p>Its own affordance because it is the answer to "we're away for a fortnight", which nobody
     * reaches for by opening an edit dialog. The row updates from the response; the realtime echo
     * arrives after and is an upsert on the same id.</p>
     */
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

    /** Tomorrow at 09:00 local - "the first time this is due", not "right now". */
    private tomorrowMorning(): Date {
        const date = new Date();
        date.setDate(date.getDate() + 1);
        date.setHours(9, 0, 0, 0);
        return date;
    }
}
