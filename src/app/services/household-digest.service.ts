import {inject, Injectable, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {HouseholdDigest} from '../dtos/response/household-digest.dto';
import {HouseholdDigestApiService} from './household-digest-api.service';
import {HouseholdAlertService} from './household-alert.service';

/**
 * How long a digest is treated as current.
 *
 * <p>Short, because it is a glance at six modules that other people are editing, and long enough
 * that stepping between the house view and a channel does not re-fetch each time.</p>
 */
const STALE_MS = 60_000;

export interface HouseholdDigestState {
    /** The last digest that arrived. Kept across a failed refresh: stale beats blank. */
    digest: HouseholdDigest | null;
    loading: boolean;
    /** Epoch ms of the last successful load. `0` means never, or invalidated. */
    loadedAt: number;
    error: boolean;
    /**
     * The server answered `403`.
     *
     * <p>Held apart from `error` for the reason every household surface holds it apart: a guild
     * without the modules answers `403` to everyone including the owner, and "your house doesn't do
     * this" is a different sentence from "you're not allowed to see it".</p>
     */
    forbidden: boolean;
}

const EMPTY_STATE: HouseholdDigestState = {
    digest: null,
    loading: false,
    loadedAt: 0,
    error: false,
    forbidden: false,
};

/**
 * The home digest, per guild, with its `ETag`.
 *
 * <p>This is the only household surface that is <b>not</b> kept live by realtime events. It spans
 * six modules and every channel of each that the caller can see, so reconciling it from the
 * `guild.*Created` stream would mean re-implementing every one of those modules' aggregations here
 * - counts, previews, "mine", net balances - against events that are per-channel while the digest
 * is per-house. Refetching one cheap request is both simpler and honest.</p>
 *
 * <p>What it does listen to is {@link HouseholdAlertService.alerts$}, because an alert is by
 * definition something that happened while the user was not looking - the one case where a glance
 * surface is wrong and cannot know it.</p>
 */
@Injectable({providedIn: 'root'})
export class HouseholdDigestService {
    private api = inject(HouseholdDigestApiService);
    private alerts = inject(HouseholdAlertService);

    private readonly guilds = signal<Record<string, HouseholdDigestState>>({});

    /** Last `ETag` per guild, for the conditional refresh. Never rendered. */
    private etags = new Map<string, string | null>();

    /** One in-flight request per guild, so two panels opening at once do not both fetch. */
    private inFlight = new Map<string, Promise<void>>();

    constructor() {
        this.alerts.alerts$.pipe(takeUntilDestroyed()).subscribe(alert => {
            // Only for a house already on screen or recently looked at. Invalidating a guild that
            // was never loaded would have nothing to invalidate, and fetching one nobody is looking
            // at spends a request on a panel that will refetch when it opens anyway.
            if (!(alert.guildId in this.guilds())) return;
            void this.refresh(alert.guildId);
        });
    }

    /** Reactive: reads the backing signal, so a `computed` over this re-runs on any change. */
    stateFor(guildId: string): HouseholdDigestState {
        return this.guilds()[guildId] ?? EMPTY_STATE;
    }

    /** Loads the digest if it has never landed or has gone stale. */
    async ensureLoaded(guildId: string): Promise<void> {
        const state = this.stateFor(guildId);
        if (state.loadedAt > 0 && Date.now() - state.loadedAt <= STALE_MS) return;
        await this.refresh(guildId);
    }

    /**
     * Fetches conditionally, so an unchanged house costs a `304` and no re-render.
     *
     * <p>`loadedAt` moves on a `304` as well as on a body: the copy on screen has just been
     * confirmed current, and leaving the timestamp behind would make every later `ensureLoaded`
     * re-ask about a house the server has already said has not changed.</p>
     */
    async refresh(guildId: string): Promise<void> {
        const existing = this.inFlight.get(guildId);
        if (existing) return existing;

        const request = this.run(guildId).finally(() => this.inFlight.delete(guildId));
        this.inFlight.set(guildId, request);
        return request;
    }

    /** Drops everything held for a guild - used when its digest can no longer be trusted at all. */
    invalidate(guildId: string): void {
        this.etags.delete(guildId);
        this.patch(guildId, {loadedAt: 0});
    }

    private async run(guildId: string): Promise<void> {
        this.patch(guildId, {loading: true, error: false, forbidden: false});
        try {
            const response = await firstValueFrom(this.api.digest(guildId, this.etags.get(guildId)));
            this.etags.set(guildId, response.etag);
            this.patch(guildId, {
                // A `304` carries no body and means the one already held is current.
                digest: response.digest ?? this.stateFor(guildId).digest,
                loading: false,
                loadedAt: Date.now(),
                error: false,
                forbidden: false,
            });
        } catch (err: unknown) {
            // The digest itself is kept. A house that was drawn a minute ago is a far better answer
            // than an empty one, and the failure is surfaced alongside it rather than instead.
            this.patch(guildId, {
                loading: false,
                // Never recorded as loaded: a failure that counted as a load would block every
                // retry until STALE_MS had passed over data that was never fetched.
                loadedAt: 0,
                error: true,
                forbidden: err instanceof HttpErrorResponse && err.status === 403,
            });
        }
    }

    private patch(guildId: string, changes: Partial<HouseholdDigestState>): void {
        this.guilds.update(map => ({
            ...map,
            [guildId]: {...(map[guildId] ?? EMPTY_STATE), ...changes},
        }));
    }
}
