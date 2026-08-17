import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, tap} from 'rxjs';
import {
    Absence,
    AbsenceCreated,
    AbsenceDeleted,
    AbsenceSaved,
    absenceState,
    AbsenceUpdated,
} from '../dtos/response/absence.dto';
import {CreateAbsenceDto, UpdateAbsenceDto} from '../dtos/request/absence.dto';
import {AbsenceApiService} from './absence-api.service';
import {ChoreService} from './chore.service';
import {RealtimeConnectionService} from './realtime-connection.service';

export interface AbsenceGuildState {
    /** Everything the last fetch covered, soonest start first. */
    absences: Absence[];
    loading: boolean;
    loaded: boolean;
    /** A `403` - the house has no Presence module. Render nothing, never a denial. */
    forbidden: boolean;
    failed: boolean;
}

const EMPTY_STATE: AbsenceGuildState = {
    absences: [],
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
};

/**
 * How far either side of now the board asks for.
 *
 * <p>Back far enough that a holiday somebody has just returned from still explains their chore
 * balance; forward far enough to see the summer coming. The window matters because absences are
 * capped at 180 days each and a member may hold twenty, so "everything" is a real amount of rows
 * for a house that has been running for years.</p>
 */
const WINDOW_BACK_DAYS = 30;
const WINDOW_FORWARD_DAYS = 180;

/**
 * Who is away, per guild.
 *
 * <p>Kept apart from {@link import('./home-status.service').HomeStatusService} for the same reason
 * the two are drawn apart. Home status is a decaying assertion about this minute, held in Redis with
 * a TTL, and a stale board is worse than no board. An absence is a dated plan in Postgres that the
 * chore rota reads, and it is still true while nobody is looking at it. One cache for both would
 * have to decide which of those two behaviours to implement, and either answer is wrong for the
 * other half.</p>
 */
@Injectable({providedIn: 'root'})
export class AbsenceService {
    private api = inject(AbsenceApiService);
    private chores = inject(ChoreService);
    private realtime = inject(RealtimeConnectionService);

    private readonly states = signal<Record<string, AbsenceGuildState>>({});
    private readonly requested = new Set<string>();

    constructor() {
        // Registered once, here, in a root singleton - `RealtimeConnectionService.on` does not
        // deduplicate. Guild-scoped events, not channel ones: an absence belongs to a member.
        this.realtime.on('guild.AbsenceCreated', (d: AbsenceCreated) => this.onSaved(d));
        this.realtime.on('guild.AbsenceUpdated', (d: AbsenceUpdated) => this.onSaved(d));
        this.realtime.on('guild.AbsenceDeleted', (d: AbsenceDeleted) => this.onDeleted(d));
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(guildId: string): AbsenceGuildState {
        return this.states()[guildId] ?? EMPTY_STATE;
    }

    /** Who is away right now. What a board headline says, and what a roster badge hangs off. */
    liveIn(guildId: string, now: number = Date.now()): Absence[] {
        return this.stateFor(guildId).absences.filter(a => absenceState(a, now) === 'current');
    }

    /** This member's own, newest plan first. What the editor lists so they can amend one. */
    forUser(guildId: string, userId: string): Absence[] {
        return this.stateFor(guildId).absences.filter(a => a.userId === userId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per guild for the session; call it on every open. */
    loadFor(guildId: string): void {
        if (this.requested.has(guildId)) return;
        this.requested.add(guildId);
        this.refresh(guildId);
    }

    refresh(guildId: string): void {
        this.patch(guildId, state => ({...state, loading: true, failed: false}));

        const from = new Date(Date.now() - WINDOW_BACK_DAYS * 86_400_000);
        const to = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86_400_000);

        this.api.list(guildId, from.toISOString(), to.toISOString()).subscribe({
            next: absences =>
                this.patch(guildId, state => ({
                    ...state,
                    absences: this.sorted(absences),
                    loading: false,
                    loaded: true,
                })),
            error: err => {
                const forbidden = err instanceof HttpErrorResponse && err.status === 403;
                this.patch(guildId, state => ({
                    ...state,
                    loading: false,
                    forbidden,
                    failed: !forbidden,
                }));
            },
        });
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Declares an absence for the caller.
     *
     * <p>The chores it handed over are somebody else's board now, so this invalidates the rota the
     * same way a completion does. Callers surface `choresReassigned` from the answer - it is a
     * consequence the member should see before they leave, not after.</p>
     */
    create(guildId: string, body: CreateAbsenceDto): Observable<AbsenceSaved> {
        return this.api.create(guildId, body).pipe(tap(saved => this.applySaved(guildId, saved)));
    }

    update(guildId: string, absenceId: string, body: UpdateAbsenceDto): Observable<AbsenceSaved> {
        return this.api.update(absenceId, body).pipe(tap(saved => this.applySaved(guildId, saved)));
    }

    /**
     * Withdraws one.
     *
     * <p>It does <b>not</b> bring the handed-over chores back, which is why nothing here touches the
     * rota. The confirm copy has to say so; every user expects the opposite.</p>
     */
    remove(guildId: string, absenceId: string): Observable<void> {
        return this.api.delete(absenceId).pipe(tap(() => this.drop(guildId, absenceId)));
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    private onSaved(event: AbsenceCreated | AbsenceUpdated): void {
        this.upsert(event.guildId, event.absence, true);
        // The handover moves occurrences without emitting an occurrence event, so any board on
        // screen is now wrong about who the bins belong to - see ChoreService.invalidateAll.
        if (event.choresReassigned > 0) this.chores.invalidateAll();
    }

    private onDeleted(event: AbsenceDeleted): void {
        this.dropExisting(event.guildId, event.absenceId);
    }

    // ── State plumbing ───────────────────────────────────────────────────────

    private applySaved(guildId: string, saved: AbsenceSaved): void {
        this.upsert(guildId, saved.absence);
        if (saved.choresReassigned > 0) this.chores.invalidateAll();
    }

    private upsert(guildId: string, absence: Absence, existingOnly = false): void {
        const apply = (state: AbsenceGuildState): AbsenceGuildState => ({
            ...state,
            absences: this.sorted([...state.absences.filter(a => a.id !== absence.id), absence]),
        });
        if (existingOnly) this.patchExisting(guildId, apply);
        else this.patch(guildId, apply);
    }

    private drop(guildId: string, absenceId: string): void {
        this.patch(guildId, state => ({
            ...state,
            absences: state.absences.filter(a => a.id !== absenceId),
        }));
    }

    private dropExisting(guildId: string, absenceId: string): void {
        this.patchExisting(guildId, state => ({
            ...state,
            absences: state.absences.filter(a => a.id !== absenceId),
        }));
    }

    /** Soonest start first, so the board reads as a calendar rather than as a changelog. */
    private sorted(absences: Absence[]): Absence[] {
        return [...absences].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
    }

    private patch(guildId: string, fn: (state: AbsenceGuildState) => AbsenceGuildState): void {
        this.states.update(all => ({...all, [guildId]: fn(all[guildId] ?? EMPTY_STATE)}));
    }

    private patchExisting(guildId: string, fn: (state: AbsenceGuildState) => AbsenceGuildState): void {
        this.states.update(all => (all[guildId] ? {...all, [guildId]: fn(all[guildId])} : all));
    }
}
