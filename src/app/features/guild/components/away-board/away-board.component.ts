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

/** Not the home-status board: an absence is a dated plan the chore rota reads and stays true until edited, unlike a presence claim that expires on its own; declaring one reassigns your unfinished chores, and shortening or withdrawing does not claw them back. */
@Component({
    selector: 'app-away-board',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, Dialog, InputText, DatePicker, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './away-board.component.html',
})
export class AwayBoardComponent {
    readonly guildId = input.required<string>();

    private absences = inject(AbsenceService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly noteMaxLength = ABSENCE_LIMITS.noteMaxLength;
    protected readonly maxDays = ABSENCE_LIMITS.maxDays;

    private readonly members = signal<GuildMemberDto[]>([]);
    private readonly memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected readonly ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    private readonly guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.guildId()) ?? null);

    /** Absences are gated on Presence, like the home-status board; a guild that hasn't resolved yet counts as enabled so the panel doesn't flash on load. */
    protected readonly hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Presence);
        return moduleOff || this.state().forbidden;
    });

    protected readonly state = computed(() => this.absences.stateFor(this.guildId()));

    protected readonly rows = computed<AwayRow[]>(() => {
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
            // Past absences last but not dropped: they explain a chore balance somebody might argue with, and the balance window reaches back further than today.
            .sort((a, b) => this.stateRank(a.state) - this.stateRank(b.state)
                || a.absence.startAt.localeCompare(b.absence.startAt));
    });

    protected readonly liveRows = computed(() => this.rows().filter(r => r.state === 'current'));
    protected readonly hasAny = computed(() => this.rows().length > 0);

    // ── Editor ───────────────────────────────────────────────────────────────
    protected readonly showEditor = signal(false);
    protected readonly editingId = signal<string | null>(null);
    protected readonly saving = signal(false);
    protected readonly confirmDeleteId = signal<string | null>(null);

    protected readonly draftStart = signal<Date | null>(null);
    protected readonly draftEnd = signal<Date | null>(null);
    protected readonly draftNote = signal('');

    protected readonly draftError = computed(() => absenceDraftError(this.draftStart(), this.draftEnd()));
    protected readonly draftValid = computed(() => this.draftError() === null);

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

    /** Your own always; anyone else's only to amend or withdraw with `ManageGuild` (server-enforced; this only decides whether to offer the control). Creating one for somebody else isn't possible at all. */
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
                // The consequence on other people's boards, said out loud, so nobody discovers it from a chore they didn't expect to have.
                if (saved.choresReassigned > 0) {
                    this.toast.success(this.translate.instant(
                        'AWAY.CHORES_REASSIGNED', {count: saved.choresReassigned}));
                }
            },
            error: err => {
                this.saving.set(false);
                // The overlap `400` names the collision in its body; a generic failure next to two valid-looking dates would say nothing.
                this.toast.httpError(this.translate.instant('AWAY.SAVE_FAILED'), err);
            },
        });
    }

    /** First press arms, second withdraws; the chores stay where they went. */
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
                // Deliberately not the home-status palette: an absence is a plan, not a presence claim, and sharing a color would read them as the same thing.
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

    /** `13 - 27 Aug`: the end is drawn as the last day away, not the exclusive boundary the row carries, since "until the 28th" would be a day longer than meant. */
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
