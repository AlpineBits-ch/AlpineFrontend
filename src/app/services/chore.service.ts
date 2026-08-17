import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, defer, forkJoin, Observable, tap, throwError} from 'rxjs';
import {
    Chore,
    ChoreBalanceEntry,
    ChoreCreated,
    ChoreDeleted,
    ChoreOccurrence,
    ChoreOccurrenceCreated,
    ChoreOccurrenceNudged,
    ChoreOccurrenceUpdated,
    ChoreUpdated,
    CHORE_LIMITS,
    carriesOccurrence,
} from '../dtos/response/chore.dto';
import {CreateChoreDto, UpdateChoreDto} from '../dtos/request/chore.dto';
import {ChoreApiService, ChoreNudgeResult} from './chore-api.service';
import {ProfileService} from './profile.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * How far either side of now the board asks for.
 *
 * <p>Backwards far enough that a fortnight away still shows what was missed; forwards far enough
 * to see next month's deep clean coming. Unbounded would drag in every occurrence a weekly chore
 * has generated since it was anchored, none of which anybody is going to act on.</p>
 */
const WINDOW_BACK_DAYS = 14;
const WINDOW_FORWARD_DAYS = 28;

/**
 * SignalR replays nothing across a reconnect, so a disconnect window leaves a channel's board
 * permanently stale with nothing left to invalidate it. Re-entering the channel past this refetches.
 */
const STALE_MS = 2 * 60 * 1000;

/**
 * How long completions are allowed to pile up before the balance is refetched.
 *
 * <p>The server's reconcile sweep can emit a burst, and every completion in it moves everyone's
 * delta - the balance is relative to the house average, so one person finishing a chore changes
 * every other row too. One request per burst is the right price for that.</p>
 */
const BALANCE_COALESCE_MS = 400;

export interface ChoreChannelState {
    chores: readonly Chore[];
    /** The window described by {@link WINDOW_BACK_DAYS}/{@link WINDOW_FORWARD_DAYS}, unsorted. */
    occurrences: readonly ChoreOccurrence[];
    balance: readonly ChoreBalanceEntry[];
    loading: boolean;
    /** Epoch ms of the last successful load. `0` means never, failed, or invalidated. */
    loadedAt: number;
    error: boolean;
    /**
     * The server answered `403`.
     *
     * <p>Held separately from `error` because it is usually not a permission problem at all: every
     * household endpoint is gated on the guild's `Chores` module, and a guild without it returns
     * `403` to everyone including the owner. "Your house doesn't do chores" and "you're not allowed
     * to see the chores" are different sentences and the UI has to be able to pick one.</p>
     */
    forbidden: boolean;
}

const EMPTY_STATE: ChoreChannelState = {
    chores: [],
    occurrences: [],
    balance: [],
    loading: false,
    loadedAt: 0,
    error: false,
    forbidden: false,
};

/**
 * Chores state for every channel the user has opened, plus the five realtime listeners.
 *
 * <p>Keyed by channel because a household has one Chores channel per rota and each is its own
 * board, balance and permission scope - the household permissions resolve per channel, so a role
 * granting control of the kitchen rota grants nothing over the garden one.</p>
 *
 * <p>Occurrences are never synthesized here. There is no client-side cadence arithmetic in this
 * service: a turn exists because the server generated one and said so over
 * `guild.ChoreOccurrenceCreated`. The only local writes are optimistic echoes of the four verbs,
 * and each one is rolled back if its request fails.</p>
 */
@Injectable({providedIn: 'root'})
export class ChoreService {
    private api = inject(ChoreApiService);
    private profileService = inject(ProfileService);
    private realtime = inject(RealtimeConnectionService);

    private readonly channels = signal<Record<string, ChoreChannelState>>({});

    /** One pending balance refetch per channel; see {@link BALANCE_COALESCE_MS}. */
    private balanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor() {
        // Registered exactly once, here, because `RealtimeConnectionService.on` does not
        // deduplicate - a second registration delivers every chore event twice, which for the
        // skip marker would mean two local patches of a row the server described once. This is a
        // root singleton, and `on` is safe before `start`.
        this.realtime.on('guild.ChoreCreated', (d: ChoreCreated) => this.upsertChore(d.channelId, d.chore));
        this.realtime.on('guild.ChoreUpdated', (d: ChoreUpdated) => this.upsertChore(d.channelId, d.chore));
        this.realtime.on('guild.ChoreDeleted', (d: ChoreDeleted) => this.removeChore(d.channelId, d.choreId));
        this.realtime.on('guild.ChoreOccurrenceCreated', (d: ChoreOccurrenceCreated) =>
            this.onOccurrenceCreated(d),
        );
        this.realtime.on('guild.ChoreOccurrenceUpdated', (d: ChoreOccurrenceUpdated) =>
            this.onOccurrenceUpdated(d),
        );
        this.realtime.on('guild.ChoreOccurrenceNudged', (d: ChoreOccurrenceNudged) =>
            this.onOccurrenceNudged(d),
        );
        // The due-date reminder is not registered here. It arrives as `guild.HouseholdAlert` now,
        // and is handled by `HouseholdAlertService`, which the shell constructs at launch - this
        // service only exists once somebody has opened a chores board, which is precisely the
        // person a reminder does not need to reach.
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /** Reactive: reads the backing signal, so a `computed` over this re-runs on any change. */
    stateFor(channelId: string): ChoreChannelState {
        return this.channels()[channelId] ?? EMPTY_STATE;
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /**
     * Loads (or refreshes) one channel's board.
     *
     * <p>All three reads go together: the board is chores × occurrences and the balance panel
     * heads it, so landing them one at a time would draw a board whose totals disagree with its
     * rows for as long as the slowest request took.</p>
     */
    loadFor(channelId: string, force = false): void {
        const state = this.stateFor(channelId);
        if (state.loading) return;
        if (!force && state.loadedAt > 0 && Date.now() - state.loadedAt <= STALE_MS) return;

        this.patch(channelId, {loading: true, error: false, forbidden: false});

        const now = Date.now();
        const from = new Date(now - WINDOW_BACK_DAYS * 86_400_000).toISOString();
        const to = new Date(now + WINDOW_FORWARD_DAYS * 86_400_000).toISOString();

        forkJoin({
            chores: this.api.listChores(channelId),
            occurrences: this.api.listOccurrences(channelId, from, to),
            balance: this.api.balance(channelId, CHORE_LIMITS.balanceDefaultDays),
        }).subscribe({
            next: ({chores, occurrences, balance}) =>
                this.patch(channelId, {
                    chores,
                    occurrences,
                    balance,
                    loading: false,
                    loadedAt: Date.now(),
                    error: false,
                    forbidden: false,
                }),
            error: (err: unknown) =>
                this.patch(channelId, {
                    loading: false,
                    // Never recorded as loaded: a failure that counted as a load would block every
                    // retry until STALE_MS had passed over data that was never fetched.
                    loadedAt: 0,
                    error: true,
                    forbidden: err instanceof HttpErrorResponse && err.status === 403,
                }),
        });
    }

    /**
     * Marks every loaded board out of date, so the next open re-reads it.
     *
     * <p>For the one thing that moves occurrences without emitting an occurrence event: declaring an
     * absence hands unfinished chores over in bulk, and the server reports only <i>how many</i> plus
     * a `chore.reassigned` alert to each new assignee. Nobody else is told which rows moved.</p>
     *
     * <p>Guild-wide because it has to be. This service is keyed by channel and holds no guild ids,
     * and a house may have a rota per room - so the honest granularity is "the boards you have open
     * may be wrong", which is what this says. It deliberately does not refetch: the reassignment
     * usually concerns a board nobody is looking at, and spending a request per rota on that is
     * worse than re-reading the one that is actually opened next.</p>
     */
    invalidateAll(): void {
        this.channels.update(all =>
            Object.fromEntries(
                Object.entries(all).map(([channelId, state]) => [channelId, {...state, loadedAt: 0}]),
            ),
        );
    }

    // ── Chore definitions ───────────────────────────────────────────────────

    /**
     * Cold: nothing is sent until the caller subscribes, matching the rest of the app's
     * create/update methods. The realtime echo upserts the same chore a moment later; upserting
     * from the response too means the dialog can close on the response rather than on the socket.
     */
    createChore(channelId: string, dto: CreateChoreDto): Observable<Chore> {
        return this.api
            .createChore(channelId, dto)
            .pipe(tap(chore => this.upsertChore(channelId, chore, true)));
    }

    updateChore(channelId: string, choreId: string, dto: UpdateChoreDto): Observable<Chore> {
        return this.api
            .updateChore(choreId, dto)
            .pipe(tap(chore => this.upsertChore(channelId, chore, true)));
    }

    /**
     * Pauses or resumes a chore, and touches nothing else.
     *
     * <p>Its own method rather than a trip through the editor because the PATCH body genuinely is
     * one field: the server applies only what it receives, so re-sending the title and cadence to
     * flip a boolean would overwrite whatever a flatmate changed in between. A paused chore keeps
     * its occurrences - it stops generating new ones, it does not forget the ones it owes.</p>
     */
    setPaused(channelId: string, choreId: string, isPaused: boolean): Observable<Chore> {
        return this.api
            .updateChore(choreId, {isPaused})
            .pipe(tap(chore => this.upsertChore(channelId, chore, true)));
    }

    deleteChore(channelId: string, choreId: string): Observable<void> {
        return this.api.deleteChore(choreId).pipe(tap(() => this.removeChore(channelId, choreId)));
    }

    // ── The four verbs ──────────────────────────────────────────────────────

    /**
     * Marks a turn done, optimistically.
     *
     * <p>The optimistic row names *this* user as `completedByUserId` while leaving
     * `assignedUserId` alone, because that is what the server is about to record: doing someone
     * else's turn is a supported gesture, and the credit still goes to the assignee. Collapsing
     * the two here would make "Ben did Anna's washing-up" flicker through "Ben's washing-up".</p>
     */
    complete(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return defer(() => {
            const before = this.occurrenceById(occurrence.channelId, occurrence.id) ?? occurrence;
            const doerId = this.profileService.ownProfile()?.userId ?? before.assignedUserId;

            this.replaceOccurrence({
                ...before,
                completedAt: new Date().toISOString(),
                completedByUserId: doerId,
                // Done and skipped are mutually exclusive states of one turn.
                skippedAt: null,
            });

            return this.api.complete(before.id).pipe(
                tap(fresh => {
                    if (fresh) this.replaceOccurrence(fresh);
                    this.scheduleBalanceRefresh(before.channelId);
                }),
                catchError(err => this.rollback(before, err)),
            );
        });
    }

    /** The undo for a mis-tap. Withdraws the credit, so the balance is refetched. */
    unComplete(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return defer(() => {
            const before = this.occurrenceById(occurrence.channelId, occurrence.id) ?? occurrence;
            this.replaceOccurrence({...before, completedAt: null, completedByUserId: null});

            return this.api.unComplete(before.id).pipe(
                tap(fresh => {
                    if (fresh) this.replaceOccurrence(fresh);
                    this.scheduleBalanceRefresh(before.channelId);
                }),
                catchError(err => this.rollback(before, err)),
            );
        });
    }

    /**
     * Skips a turn - which is <b>not</b> completing it.
     *
     * <p>Two consequences, both deliberate. The completion stamps are cleared rather than kept, so
     * nothing downstream can read the row as done. And the balance is <b>not</b> refetched: a skip
     * credits nobody, so there is nothing to refetch - the work stays owed and the rota, which
     * hands the next turn to whoever has done the fewest weighted minutes, comes back round to the
     * same person. Scheduling a refresh here would be harmless but would quietly imply otherwise
     * to the next reader.</p>
     */
    skip(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return defer(() => {
            const before = this.occurrenceById(occurrence.channelId, occurrence.id) ?? occurrence;

            this.replaceOccurrence({
                ...before,
                skippedAt: new Date().toISOString(),
                completedAt: null,
                completedByUserId: null,
            });

            return this.api.skip(before.id).pipe(
                tap(fresh => {
                    if (fresh) this.replaceOccurrence(fresh);
                }),
                catchError(err => this.rollback(before, err)),
            );
        });
    }

    /**
     * Passes a turn to the lightest-loaded *other* member of the rotation.
     *
     * <p>Not optimistic: who it lands on is the server's answer, and guessing "the person with the
     * lowest balance we happen to have fetched" would name the wrong flatmate often enough to
     * matter. `400` here means nobody else is in the rotation and is the caller's to explain.</p>
     */
    swap(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return this.api.swap(occurrence.id).pipe(
            tap(fresh => {
                if (fresh) this.replaceOccurrence(fresh);
                // A swap moves no minutes - nothing was completed - so the balance is untouched.
                // The board still needs the new assignee, which the response or the realtime
                // snapshot supplies.
            }),
        );
    }

    /**
     * Asks the assignee to get on with an overdue chore.
     *
     * <p>Deliberately not optimistic. `nudgedAt` is what greys the button, so stamping it before the
     * server agrees would hide the control on a nudge that was in fact refused - and both refusals
     * worth acting on are `409`s the caller has to read. The field is applied from the response.</p>
     *
     * <p><b>Nothing here records who sent it</b>, because nothing is told: the payload carries no
     * sender, by design. See {@link ChoreApiService.nudge}.</p>
     */
    nudge(occurrence: ChoreOccurrence): Observable<ChoreNudgeResult> {
        return this.api.nudge(occurrence.id).pipe(
            tap(result => {
                const current = this.occurrenceById(occurrence.channelId, occurrence.id);
                if (current) this.replaceOccurrence({...current, nudgedAt: result.nudgedAt});
            }),
        );
    }

    // ── Realtime ────────────────────────────────────────────────────────────

    /**
     * `guild.ChoreOccurrenceNudged` - a stamp, not an occurrence.
     *
     * <p>The one household event that carries a fragment rather than the whole row, and that is not
     * an oversight: a whole row would have to name a sender to be complete, and there deliberately
     * is not one. So this patches the single field onto whatever is held rather than replacing it,
     * and drops the event entirely for a row this board has never seen - there is nothing to patch,
     * and inventing a stub occurrence out of two fields would put a blank chore on the board.</p>
     */
    private onOccurrenceNudged(payload: ChoreOccurrenceNudged): void {
        if (!this.isTracked(payload.channelId)) return;
        const current = this.occurrenceById(payload.channelId, payload.occurrenceId);
        if (!current) return;
        this.replaceOccurrence({...current, nudgedAt: payload.nudgedAt});
    }

    private onOccurrenceCreated(payload: ChoreOccurrenceCreated): void {
        if (!this.isTracked(payload.channelId)) return;
        this.replaceOccurrence(payload.occurrence);
    }

    /**
     * `guild.ChoreOccurrenceUpdated` - one shape for all four verbs, a full occurrence every time.
     *
     * <p>Skip used to broadcast a bare `{occurrenceId, skipped}` marker instead, which this had to
     * reconcile against the row already held. It no longer does; {@link carriesOccurrence} is all
     * that remains of that, and it only drops a payload from a server that has not rolled forward
     * rather than letting it throw inside the SignalR callback.</p>
     */
    private onOccurrenceUpdated(payload: ChoreOccurrenceUpdated): void {
        if (!this.isTracked(payload.channelId)) return;
        if (!carriesOccurrence(payload)) return;

        const previous = this.occurrenceById(payload.channelId, payload.occurrence.id);
        this.replaceOccurrence(payload.occurrence);

        // Only a change in completion moves minutes. Skip and swap arrive through this same path
        // and must not trigger a refetch: a skip credits nobody - that is the whole point of it -
        // and a swap moves a turn without completing anything.
        if ((previous?.completedAt ?? null) !== (payload.occurrence.completedAt ?? null)) {
            this.scheduleBalanceRefresh(payload.channelId);
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * A channel the user has actually opened. Events for anything else are dropped: otherwise
     * every chore completed anywhere in the house would accumulate rows for boards nobody is
     * looking at, and opening one later loads it from scratch regardless.
     */
    private isTracked(channelId: string): boolean {
        return channelId in this.channels();
    }

    private patch(channelId: string, changes: Partial<ChoreChannelState>): void {
        this.channels.update(map => ({
            ...map,
            [channelId]: {...(map[channelId] ?? EMPTY_STATE), ...changes},
        }));
    }

    private occurrenceById(channelId: string, occurrenceId: string): ChoreOccurrence | undefined {
        return this.stateFor(channelId).occurrences.find(o => o.id === occurrenceId);
    }

    /** Upsert by id, preserving list position so a completed row does not jump under the cursor. */
    private replaceOccurrence(occurrence: ChoreOccurrence): void {
        const channelId = occurrence.channelId;
        const current = this.stateFor(channelId).occurrences;
        const index = current.findIndex(o => o.id === occurrence.id);
        const next =
            index === -1 ? [...current, occurrence] : current.map((o, i) => (i === index ? occurrence : o));
        this.patch(channelId, {occurrences: next});
    }

    /** Restores a row after a failed verb and rethrows, so the caller can still raise a toast. */
    private rollback(before: ChoreOccurrence, err: unknown): Observable<never> {
        this.replaceOccurrence(before);
        return throwError(() => err);
    }

    /**
     * `fromResponse` skips the tracking guard: a chore the user just created lands before any
     * realtime echo, and on a channel that is by definition on screen.
     */
    private upsertChore(channelId: string, chore: Chore, fromResponse = false): void {
        if (!fromResponse && !this.isTracked(channelId)) return;
        const current = this.stateFor(channelId).chores;
        const index = current.findIndex(c => c.id === chore.id);
        this.patch(channelId, {
            chores: index === -1 ? [...current, chore] : current.map((c, i) => (i === index ? chore : c)),
        });
    }

    /**
     * Drops the chore and every occurrence it generated. The delete event names only the chore, so
     * the occurrences have to be swept by `choreId` - leaving them would strand rows that can no
     * longer be completed, skipped or swapped.
     */
    private removeChore(channelId: string, choreId: string): void {
        if (!this.isTracked(channelId)) return;
        const state = this.stateFor(channelId);
        this.patch(channelId, {
            chores: state.chores.filter(c => c.id !== choreId),
            occurrences: state.occurrences.filter(o => o.choreId !== choreId),
        });
    }

    private scheduleBalanceRefresh(channelId: string): void {
        if (!this.isTracked(channelId)) return;
        if (this.balanceTimers.has(channelId)) return;
        this.balanceTimers.set(
            channelId,
            setTimeout(() => {
                this.balanceTimers.delete(channelId);
                this.api.balance(channelId, CHORE_LIMITS.balanceDefaultDays).subscribe({
                    next: balance => this.patch(channelId, {balance}),
                    // The panel keeps the numbers it had. A stale balance is a far better answer than
                    // an empty one, and the next load corrects it.
                    error: () => undefined,
                });
            }, BALANCE_COALESCE_MS),
        );
    }
}
