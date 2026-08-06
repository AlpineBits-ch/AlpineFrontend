import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {Chore, ChoreBalanceEntry, ChoreOccurrence} from '../dtos/response/chore.dto';
import {CreateChoreDto, UpdateChoreDto} from '../dtos/request/chore.dto';

/**
 * The Chores HTTP surface, and nothing else. State, optimism and realtime reconciliation live in
 * {@link import('./chore.service').ChoreService}.
 *
 * <p>Two path shapes, matching the gateway: collection routes hang off a channel
 * (`/channels/{channelId}/chores`), while routes acting on one row address it directly
 * (`/chores/{choreId}`, `/chore-occurrences/{id}/...`). The doubled `guild` segment in
 * `/api/v1/guild/...` is correct - the gateway strips it before forwarding.</p>
 *
 * <p>There is <b>no method to create an occurrence</b>, because there is no endpoint. The server
 * generates them from the chore's cadence and broadcasts `guild.ChoreOccurrenceCreated`; a client
 * that computes due dates itself will disagree with the rota within one interval.</p>
 */
@Injectable({providedIn: 'root'})
export class ChoreApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Chore definitions ───────────────────────────────────────────────────

    /** Every chore in the channel, paused ones included - a paused chore is still a chore. */
    listChores(channelId: string): Observable<Chore[]> {
        return this.http.get<Chore[]>(`${this.base}/channels/${channelId}/chores`);
    }

    /** Needs `ManageChores`. `400` if neither or both of the two assignment fields are set. */
    createChore(channelId: string, dto: CreateChoreDto): Observable<Chore> {
        return this.http.post<Chore>(`${this.base}/channels/${channelId}/chores`, dto);
    }

    updateChore(choreId: string, dto: UpdateChoreDto): Observable<Chore> {
        return this.http.patch<Chore>(`${this.base}/chores/${choreId}`, dto);
    }

    /** Takes the chore's generated occurrences with it; the delete event names only the chore. */
    deleteChore(choreId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/chores/${choreId}`);
    }

    // ── Occurrences ─────────────────────────────────────────────────────────

    /**
     * The board window. Both bounds are optional and both are ISO-8601.
     *
     * <p>Asked for around *now* rather than unbounded: a weekly chore anchored a year ago has
     * fifty-odd occurrences behind it, none of which anyone is going to act on.</p>
     */
    listOccurrences(channelId: string, from?: string | null, to?: string | null): Observable<ChoreOccurrence[]> {
        let params = new HttpParams();
        if (from) params = params.set('from', from);
        if (to) params = params.set('to', to);
        return this.http.get<ChoreOccurrence[]>(
            `${this.base}/channels/${channelId}/chores/occurrences`, {params});
    }

    /**
     * Marks the occurrence done. Needs `CompleteChores`.
     *
     * <p>Credits the <b>assignee</b>, not the caller - doing someone else's turn is supported and
     * does not move your own balance.</p>
     *
     * <p>Typed nullable because these four verbs are only contractually guaranteed to have
     * broadcast; whether they also echo the row back is not something the guide states, and a
     * `204` deserializes to `null`. Callers treat a null as "the realtime event is the source of
     * truth" rather than as a failure.</p>
     */
    complete(occurrenceId: string): Observable<ChoreOccurrence | null> {
        return this.http.post<ChoreOccurrence | null>(
            `${this.base}/chore-occurrences/${occurrenceId}/complete`, null);
    }

    /** Un-completes it - the undo for a mis-tap. Same permission, and the credit is withdrawn. */
    unComplete(occurrenceId: string): Observable<ChoreOccurrence | null> {
        return this.http.delete<ChoreOccurrence | null>(
            `${this.base}/chore-occurrences/${occurrenceId}/complete`);
    }

    /**
     * Skips it. <b>Not a completion.</b> Nothing is credited, the work stays owed, and the rota
     * consequently comes back round to the same person.
     *
     * <p>Returns the updated occurrence. It used to answer an empty `200` and broadcast a bare
     * `{occurrenceId, skipped}` marker, which is why this is still typed nullable - the store
     * applies a body when it gets one and otherwise waits for the realtime snapshot.</p>
     */
    skip(occurrenceId: string): Observable<ChoreOccurrence | null> {
        return this.http.post<ChoreOccurrence | null>(
            `${this.base}/chore-occurrences/${occurrenceId}/skip`, null);
    }

    /**
     * Hands the turn to the lightest-loaded *other* member of the rotation - the one-tap answer to
     * "I can't do the bins tonight".
     *
     * <p>`400` when nobody else is in the rotation, which is an ordinary state for a house of one
     * or a fixed-assignee chore, not an error to surface raw.</p>
     */
    swap(occurrenceId: string): Observable<ChoreOccurrence | null> {
        return this.http.post<ChoreOccurrence | null>(
            `${this.base}/chore-occurrences/${occurrenceId}/swap`, null);
    }

    // ── Balance ─────────────────────────────────────────────────────────────

    /**
     * Weighted minutes per member over `days`, and each member's delta from the house average.
     *
     * <p>The same 30-day window the rotation itself reasons over, which is why the default is not
     * a rounded-up "month".</p>
     */
    balance(channelId: string, days = 30): Observable<ChoreBalanceEntry[]> {
        return this.http.get<ChoreBalanceEntry[]>(
            `${this.base}/channels/${channelId}/chores/balance`,
            {params: new HttpParams().set('days', days)},
        );
    }
}
