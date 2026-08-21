import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {Absence, AbsenceSaved} from '../dtos/response/absence.dto';
import {CreateAbsenceDto, UpdateAbsenceDto} from '../dtos/request/absence.dto';
import {AbsenceGuildState, AbsenceStore} from '../stores/absence.store';

export type {AbsenceGuildState};

/** The view-facing shape of {@link AbsenceStore}. State and realtime both live in the store. */
@Injectable({providedIn: 'root'})
export class AbsenceService {
    private store = inject(AbsenceStore);

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(guildId: string): AbsenceGuildState {
        return this.store.stateFor(guildId)();
    }

    /** Who is away right now. What a board headline says, and what a roster badge hangs off. */
    liveIn(guildId: string, now: number = Date.now()): Absence[] {
        return this.store.liveIn(guildId, now);
    }

    /** This member's own, newest plan first. What the editor lists so they can amend one. */
    forUser(guildId: string, userId: string): Absence[] {
        return this.store.forUser(guildId, userId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per guild for the session; call it on every open. */
    loadFor(guildId: string): void {
        this.store.loadFor(guildId);
    }

    refresh(guildId: string): void {
        this.store.refresh(guildId);
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Declares an absence for the caller. Callers surface `choresReassigned` from the answer: it is
     * a consequence the member should see before they leave, not after.
     */
    create(guildId: string, body: CreateAbsenceDto): Observable<AbsenceSaved> {
        return this.store.create(guildId, body);
    }

    update(guildId: string, absenceId: string, body: UpdateAbsenceDto): Observable<AbsenceSaved> {
        return this.store.update(guildId, absenceId, body);
    }

    /**
     * Withdraws one. It does not bring the handed-over chores back. The confirm copy has to say so;
     * every user expects the opposite.
     */
    remove(guildId: string, absenceId: string): Observable<void> {
        return this.store.remove(guildId, absenceId);
    }
}
