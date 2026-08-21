import {computed, inject, Signal} from '@angular/core';
import {Observable, tap} from 'rxjs';
import {patchState, signalStore, withHooks, withMethods} from '@ngrx/signals';
import {removeEntity, withEntities} from '@ngrx/signals/entities';
import {
    Absence,
    AbsenceCreated,
    AbsenceDeleted,
    AbsenceSaved,
    absenceState,
    AbsenceUpdated,
} from '../dtos/response/absence.dto';
import {CreateAbsenceDto, UpdateAbsenceDto} from '../dtos/request/absence.dto';
import {AbsenceApiService} from '../services/absence-api.service';
import {ChoreService} from '../services/chore.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';

export interface AbsenceGuildState {
    /** Everything the last fetch covered, soonest start first. */
    absences: Absence[];
    loading: boolean;
    loaded: boolean;
    /** A `403` - the house has no Presence module. Render nothing, never a denial. */
    forbidden: boolean;
    failed: boolean;
}

/** Handed out for guilds nobody has opened. Shared and frozen: an answer, never a working copy. */
const EMPTY_STATE: AbsenceGuildState = Object.freeze({
    absences: Object.freeze([] as Absence[]) as Absence[],
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
});

/**
 * How far either side of now the board asks for. Back far enough that a holiday somebody has just
 * returned from still explains their chore balance, forward far enough to see the summer coming.
 */
const WINDOW_BACK_DAYS = 30;
const WINDOW_FORWARD_DAYS = 180;

/** Soonest start first, so the board reads as a calendar rather than as a changelog. */
function byStart(a: Absence, b: Absence): number {
    return a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id);
}

function sameState(a: AbsenceGuildState, b: AbsenceGuildState): boolean {
    return (
        a.absences === b.absences &&
        a.loading === b.loading &&
        a.loaded === b.loaded &&
        a.forbidden === b.forbidden &&
        a.failed === b.failed
    );
}

/**
 * Who is away, per guild.
 *
 * Kept apart from `HomeStatusService` for the same reason the two are drawn apart. Home status is a
 * decaying assertion about this minute held in Redis with a TTL; an absence is a dated plan in
 * Postgres that the chore rota reads, still true while nobody is looking at it.
 */
export const AbsenceStore = signalStore(
    {providedIn: 'root'},
    withEntities<Absence>(),

    withKeyedIndex<Absence, 'absences'>({
        collection: 'absences',
        sort: byStart,
        fetch: () => {
            const api = inject(AbsenceApiService);
            return (guildId: string) => {
                const from = new Date(Date.now() - WINDOW_BACK_DAYS * 86_400_000);
                const to = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86_400_000);
                return api.list(guildId, from.toISOString(), to.toISOString());
            };
        },
    }),

    withMethods((store, api = inject(AbsenceApiService), chores = inject(ChoreService)) => {
        const views = new Map<string, Signal<AbsenceGuildState>>();

        const rowsOf = (guildId: string): Absence[] => store.absencesFor(guildId)();

        // A guild the client holds a row list for. Wider than `absencesTracked`: declaring an
        // absence in a guild whose board was never opened writes ids but no request record, and a
        // realtime event for it must still land.
        const held = (guildId: string): boolean =>
            store.absencesTracked(guildId) || guildId in store.absencesIds();

        const drop = (guildId: string, absenceId: string): void => {
            store.detachFromAbsences(guildId, absenceId);
            patchState(store, removeEntity(absenceId));
        };

        // The handover moves occurrences without emitting an occurrence event, so any board on
        // screen is now wrong about who the bins belong to. See ChoreService.invalidateAll.
        const absorb = (guildId: string, saved: AbsenceSaved): void => {
            store.attachToAbsences(guildId, saved.absence);
            if (saved.choresReassigned > 0) chores.invalidateAll();
        };

        return {
            /** Never null. A guild nobody has opened reads as the shared frozen default. */
            stateFor(guildId: string): Signal<AbsenceGuildState> {
                const cached = views.get(guildId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const absences = rowsOf(guildId);
                        if (!store.absencesTracked(guildId) && absences.length === 0) return EMPTY_STATE;
                        const error = store.absencesError(guildId);
                        return {
                            absences,
                            loading: store.absencesLoading(guildId),
                            loaded: store.absencesLoaded(guildId),
                            forbidden: error === 'forbidden',
                            failed: error === 'failed',
                        };
                    },
                    {equal: sameState},
                );

                views.set(guildId, view);
                return view;
            },

            /** Who is away right now. What a board headline says, and what a roster badge hangs off. */
            liveIn(guildId: string, now: number = Date.now()): Absence[] {
                return rowsOf(guildId).filter(a => absenceState(a, now) === 'current');
            },

            /** This member's own. What the editor lists so they can amend one. */
            forUser(guildId: string, userId: string): Absence[] {
                return rowsOf(guildId).filter(a => a.userId === userId);
            },

            /** Idempotent per guild for the session; safe on every open. */
            loadFor(guildId: string): void {
                if (store.absencesTracked(guildId)) return;
                store.loadAbsences(guildId);
            },

            refresh(guildId: string): void {
                store.loadAbsences(guildId, {force: true});
            },

            /**
             * Declares an absence for the caller. Callers surface `choresReassigned` from the answer:
             * the write hands their unfinished chores in the window to another flatmate, and the
             * member should see that before they leave rather than after.
             */
            create(guildId: string, body: CreateAbsenceDto): Observable<AbsenceSaved> {
                return api.create(guildId, body).pipe(tap(saved => absorb(guildId, saved)));
            },

            update(guildId: string, absenceId: string, body: UpdateAbsenceDto): Observable<AbsenceSaved> {
                return api.update(absenceId, body).pipe(tap(saved => absorb(guildId, saved)));
            },

            /**
             * Withdraws one. It does not bring the handed-over chores back, which is why nothing here
             * touches the rota. The confirm copy has to say so; every user expects the opposite.
             */
            remove(guildId: string, absenceId: string): Observable<void> {
                return api.delete(absenceId).pipe(tap(() => drop(guildId, absenceId)));
            },

            // ── Realtime ─────────────────────────────────────────────────────
            //
            // Created and Updated share a handler: `AbsenceUpdated` is `AbsenceCreated`, both carry
            // the whole row and both key on its id.

            applySaved(event: AbsenceCreated | AbsenceUpdated): void {
                // Guilds nobody holds anything for are dropped rather than seeded with a single row
                // that the board would then render as the whole answer.
                if (held(event.guildId)) store.attachToAbsences(event.guildId, event.absence);
                if (event.choresReassigned > 0) chores.invalidateAll();
            },

            applyDeleted(event: AbsenceDeleted): void {
                drop(event.guildId, event.absenceId);
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.AbsenceCreated').subscribe(e => store.applySaved(e));
            realtime.stream('guild.AbsenceUpdated').subscribe(e => store.applySaved(e));
            realtime.stream('guild.AbsenceDeleted').subscribe(e => store.applyDeleted(e));
        },
    }),
);
