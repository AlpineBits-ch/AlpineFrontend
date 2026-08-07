import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {DatePicker} from 'primeng/datepicker';
import {PrimeTemplate} from 'primeng/api';
import {Absence, ABSENCE_LIMITS, absenceDraftError, absenceState, AbsenceState} from '../../../../dtos/response/absence.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {AbsenceService} from '../../../../services/absence.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {GuildFeature, guildHasFeature} from '../../guild-features';

/** One page of members is plenty for a household, matching every other household panel. */
const MEMBER_PAGE_SIZE = 200;

interface AwayRow {
    absence: Absence;
    name: string;
    state: AbsenceState;
    range: string;
    isSelf: boolean;
}

/**
 * "I'm away" - who is out of the house, and until when.
 *
 * <p><b>This is not the home-status board and must not look like one.</b> Home status is a decaying
 * assertion about right now: it expires on its own, because a board still claiming somebody is
 * asleep three days later is worse than no board. An absence is a dated plan the chore rota reads,
 * still true while nobody is looking at it, and it is what stops the bins being assigned to somebody
 * on a plane. Same house, two different kinds of fact, drawn apart on purpose.</p>
 *
 * <p>Two rules the copy has to carry, because users expect the opposite of both.</p>
 *
 * <p><b>Declaring an absence hands your unfinished chores over</b>, to the lightest-loaded other
 * flatmate, and the count comes back in the response. That is worth showing before somebody leaves
 * rather than after.</p>
 *
 * <p><b>Shortening or withdrawing one does not claw them back.</b> They went to a person who has
 * since planned around having them.</p>
 */
@Component({
    selector: 'app-away-board',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, Dialog, InputText, DatePicker, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './away-board.component.html',
})
export class AwayBoardComponent {
    guildId = input.required<string>();

    private absences = inject(AbsenceService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly noteMaxLength = ABSENCE_LIMITS.noteMaxLength;
    protected readonly maxDays = ABSENCE_LIMITS.maxDays;

    private members = signal<GuildMemberDto[]>([]);
    private memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    private guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.guildId()) ?? null);

    /**
     * Whether to draw the board at all.
     *
     * <p>Absences are gated on Presence, exactly as the home-status board is - a house that does not
     * track who is in does not track who is away either. A guild that has not resolved yet counts as
     * enabled, so the panel does not flash on load; the `403` path catches the rest.</p>
     */
    protected hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Presence);
        return moduleOff || this.state().forbidden;
    });

    protected state = computed(() => this.absences.stateFor(this.guildId()));

    protected rows = computed<AwayRow[]>(() => {
        const now = Date.now();
        const ownUserId = this.ownUserId();
        return this.state().absences
            .map(absence => ({
                absence,
                name: this.nameOf(absence.userId),
                state: absenceState(absence, now),
                range: this.rangeLabel(absence),
                isSelf: absence.userId === ownUserId,
            }))
            // Past absences last but not dropped: they are what explains a chore balance somebody
            // is about to argue with, and the balance window reaches back further than today.
            .sort((a, b) => this.stateRank(a.state) - this.stateRank(b.state)
                || a.absence.startAt.localeCompare(b.absence.startAt));
    });

    protected liveRows = computed(() => this.rows().filter(r => r.state === 'current'));
    protected hasAny = computed(() => this.rows().length > 0);

    // ── Editor ───────────────────────────────────────────────────────────────
    protected showEditor = signal(false);
    protected editingId = signal<string | null>(null);
    protected saving = signal(false);
    protected confirmDeleteId = signal<string | null>(null);

    protected draftStart = signal<Date | null>(null);
    protected draftEnd = signal<Date | null>(null);
    protected draftNote = signal('');

    protected draftError = computed(() => absenceDraftError(this.draftStart(), this.draftEnd()));
    protected draftValid = computed(() => this.draftError() === null);

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.absences.loadFor(guildId);
                this.guildService.getMembers(guildId, 0, MEMBER_PAGE_SIZE).subscribe({
                    next: members => this.members.set(members),
                    error: () => undefined,
                });
            });
        });
    }

    // ── Editor ───────────────────────────────────────────────────────────────

    protected openAdd(): void {
        this.editingId.set(null);
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        this.draftStart.set(start);
        this.draftEnd.set(end);
        this.draftNote.set('');
        this.showEditor.set(true);
    }

    protected openEdit(absence: Absence): void {
        this.editingId.set(absence.id);
        this.draftStart.set(new Date(absence.startAt));
        this.draftEnd.set(new Date(absence.endAt));
        this.draftNote.set(absence.note ?? '');
        this.showEditor.set(true);
    }

    /**
     * Who may write this row.
     *
     * <p>Your own always. Anyone else's only to amend or withdraw, and only with `ManageGuild` -
     * which the server enforces, so this only decides whether to offer the control. Creating one for
     * somebody else is not possible at all, by design.</p>
     */
    protected canEdit(absence: Absence): boolean {
        return absence.userId === this.ownUserId();
    }

    protected submit(): void {
        const start = this.draftStart();
        const end = this.draftEnd();
        if (this.saving() || !this.draftValid() || !start || !end) return;

        const note = this.draftNote().trim();
        const editingId = this.editingId();
        this.saving.set(true);

        const request$ = editingId
            ? this.absences.update(this.guildId(), editingId, {
                startAt: start.toISOString(),
                endAt: end.toISOString(),
                // The same flag rule as everywhere else: a bare null would read as "leave it alone".
                ...(note ? {note} : {clearNote: true}),
            })
            : this.absences.create(this.guildId(), {
                startAt: start.toISOString(),
                endAt: end.toISOString(),
                ...(note ? {note} : {}),
            });

        request$.subscribe({
            next: saved => {
                this.saving.set(false);
                this.showEditor.set(false);
                // The consequence on other people's boards, said out loud. Silence here is what
                // makes somebody discover it from a chore they did not expect to have.
                if (saved.choresReassigned > 0) {
                    this.toast.success(this.translate.instant(
                        'AWAY.CHORES_REASSIGNED', {count: saved.choresReassigned}));
                }
            },
            error: err => {
                this.saving.set(false);
                // The overlap `400` names the collision in its body, and that sentence is the whole
                // explanation - a generic failure next to two valid-looking dates says nothing.
                this.toast.httpError(this.translate.instant('AWAY.SAVE_FAILED'), err);
            },
        });
    }

    /** First press arms, second withdraws. The chores stay where they went - see the class doc. */
    protected remove(absence: Absence): void {
        if (this.confirmDeleteId() !== absence.id) {
            this.confirmDeleteId.set(absence.id);
            return;
        }
        this.confirmDeleteId.set(null);
        this.absences.remove(this.guildId(), absence.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('AWAY.DELETE_FAILED'), err),
        });
    }

    // ── Presentation ─────────────────────────────────────────────────────────

    protected nameOf(userId: string): string {
        const member = this.memberById().get(userId);
        return member?.nickname ?? member?.profile?.userName ?? this.translate.instant('AWAY.SOMEONE');
    }

    protected initialOf(userId: string): string {
        return this.nameOf(userId).trim().charAt(0).toUpperCase() || '?';
    }

    protected stateClass(state: AbsenceState): string {
        switch (state) {
            case 'current':
                // Deliberately not the home-status palette. An absence is a plan, not a presence
                // claim, and the two sitting side by side in the same colour is how they get read
                // as the same thing.
                return 'bg-indigo-400/10 text-indigo-300 border-indigo-400/25';
            case 'upcoming':
                return 'bg-white/[0.04] text-text-secondary border-border-subtle';
            default:
                return 'bg-white/[0.02] text-text-muted border-border-subtle';
        }
    }

    protected stateLabelKey(state: AbsenceState): string {
        return `AWAY.STATE_${state.toUpperCase()}`;
    }

    private stateRank(state: AbsenceState): number {
        if (state === 'current') return 0;
        return state === 'upcoming' ? 1 : 2;
    }

    /**
     * `13 - 27 Aug`.
     *
     * <p>The end is drawn as the last day someone is away rather than as the exclusive boundary the
     * row carries: "away until the 28th" for an absence that ends at midnight on the 28th is a day
     * longer than anybody means by it.</p>
     */
    private rangeLabel(absence: Absence): string {
        const start = new Date(absence.startAt);
        const end = new Date(new Date(absence.endAt).getTime() - 1);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';

        const format = new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'});
        const startLabel = format.format(start);
        const endLabel = format.format(end);
        return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
    }
}
