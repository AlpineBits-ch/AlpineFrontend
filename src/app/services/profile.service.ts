import {inject, Injectable, signal, untracked} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {catchError, EMPTY, finalize, Observable, of, shareReplay, switchMap, tap} from 'rxjs';
import {environment} from '../../environments/environment';
import {OnlineStatus, ProfileDto, ProfileFont} from '../dtos/response/profile.dto';
import {ApiConfigService} from "./api-config.service";
import {BrokenImageService} from './broken-image.service';
import {cacheBustedUrl} from '../models/profile-image.model';

// ── Circuit breaker config ───────────────────────────────────────────────────

const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT = 30_000; // ms before moving to half-open

type CircuitState = 'closed' | 'open' | 'half-open';

// ── Negative cache config ────────────────────────────────────────────────────

/**
 * How long a single id that failed to resolve is left alone before it may be asked for again.
 *
 * <p>Longer than {@link RECOVERY_TIMEOUT} on purpose. The two answer different questions - the
 * breaker asks "is the profile service up", this asks "does this id resolve" - and if the cooldown
 * were the shorter of the two, every deleted user on screen would be retried the instant the
 * breaker half-opened, which is precisely the burst the breaker just finished absorbing.</p>
 *
 * <p>Short enough that it stays a cooldown rather than a tombstone: a 429 during a busy first paint
 * must not cost that person's avatar for the rest of the session.</p>
 */
const NEGATIVE_CACHE_TTL = 60_000;

const FALLBACK_PROFILE: ProfileDto = {
    id: 'unknown',
    userId: 'unknown',
    userName: 'Unknown User',
    bio: undefined,
    avatarUrl: undefined,
    bannerUrl: undefined,
    accentColor: null,
    font: ProfileFont.Default,
    createdAt: new Date(),
    updatedAt: new Date(),
    onlineStatus: OnlineStatus.Offline,
};

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({
    providedIn: 'root',
})
export class ProfileService {
    /** The authenticated user's own profile */
    public ownProfile = signal<ProfileDto | undefined>(undefined);
    private httpClient = inject(HttpClient);
    // Two indexes into the same profiles -whichever key you have, you can look up
    private byProfileId = signal<Record<string, ProfileDto>>({});
    private byUserId = signal<Record<string, ProfileDto>>({});

    /**
     * The fetch already on the wire for each id, so the second caller joins it instead of starting
     * a second one.
     *
     * <p><b>This is the whole reason the cache above was not enough.</b> The cache is only written
     * when a response lands, and on first paint every avatar, every DM row, every message header
     * and the friends list all ask for the same handful of user ids inside one change-detection
     * pass - before any response exists. Each of them looked at an empty cache, agreed there was
     * nothing there and issued its own GET, so a screen showing one person ten times fetched that
     * person ten times. Against a 50 rps bucket that is what produced the 429 storm.</p>
     *
     * <p>Entries are removed when the request settles, so this is a coalescing window and not a
     * second cache: a later {@link fetchByUserId} still refetches, which is what its callers
     * (settings tables that want fresh rows) rely on.</p>
     */
    private inFlightByProfileId = new Map<string, Observable<ProfileDto>>();
    private inFlightByUserId = new Map<string, Observable<ProfileDto>>();

    /**
     * When each id was last seen to fail, so the fire-and-forget resolvers stop asking for it.
     *
     * <p><b>The other half of the storm, and the half coalescing cannot reach.</b> A failure used to
     * leave the cache exactly as empty as it was before the request, so `resolveByUserId`'s "not
     * cached yet" test was true again the moment the request settled and the id was asked for
     * afresh on the next paint. Those repeats are sequential, never concurrent, so the in-flight map
     * above never sees two of them at once and cannot merge them - a 404'd or deleted user was
     * refetched once per repaint, forever.</p>
     *
     * <p>Consulted by {@link resolveById} and {@link resolveByUserId} only. {@link fetchById} and
     * {@link fetchByUserId} deliberately ignore it: those are the explicit asks, made by settings
     * tables that want a fresh row and by anything retrying on the user's behalf, and a cache of
     * failures that could not be overridden would turn one bad response into a dead row.</p>
     *
     * <p>Fed only by requests that actually reached the wire. A call short-circuited by an open
     * breaker is evidence about the service, not about the id, and marking those would leave every
     * id that happened to be on screen during a 30-second outage dark for a further minute after
     * recovery.</p>
     */
    private negativeByProfileId = new Map<string, number>();
    private negativeByUserId = new Map<string, number>();

    /**
     * The `me` request already on the wire, shared by whoever asks while it is.
     *
     * <p>The app shell, the main page and quick settings each call {@link getSelf} within a few
     * frames of launch, so the same row was pulled two or three times per start.</p>
     *
     * <p><b>Coalescing only - deliberately not cache-first.</b> Quick settings and the settings
     * pages call this precisely because they want the current row, so answering a later caller from
     * a stored copy would silently stop them ever showing a change made elsewhere. Callers that
     * overlap share one request; a caller that arrives after it settled still gets a real refetch.
     * </p>
     */
    private inFlightSelf: Observable<ProfileDto> | null = null;

    private apiConfig = inject(ApiConfigService);
    private brokenImages = inject(BrokenImageService);

    // ── Circuit breaker state ────────────────────────────────────────────────

    private circuitState: CircuitState = 'closed';
    private failureCount = 0;
    private openedAt = 0;

    /**
     * The authenticated user's own profile, always from the server.
     *
     * <p>Concurrent callers share one request (see {@link inFlightSelf}); a caller that arrives
     * after the previous one settled issues a new one. That asymmetry is the point: this is the
     * call the settings screens use to get a fresh row, so it must never answer from a cache, but
     * three components asking during the same launch is one row, not three.</p>
     */
    public getSelf(): Observable<ProfileDto> {
        const existing = this.inFlightSelf;
        if (existing) return existing;

        const shared = this.requestSelf().pipe(
            finalize(() => this.inFlightSelf = null),
            shareReplay({bufferSize: 1, refCount: false}),
        );
        this.inFlightSelf = shared;
        return shared;
    }

    /**
     * One uncoalesced `me` request.
     *
     * <p>The read-after-write path uses this rather than {@link getSelf}. An avatar upload refetches
     * the profile because the PATCH returns no body, and joining a request that was already on the
     * wire <b>before</b> the upload finished would answer it with the profile as it was a moment
     * ago - the new avatar silently missing until something else refetched. Coalescing is only safe
     * between callers that all just want "the current row"; a caller that wants "the row after my
     * write" has to ask for itself.</p>
     */
    private requestSelf(): Observable<ProfileDto> {
        return this.httpClient
            .get<ProfileDto>(this.apiConfig.baseUrl() + '/api/v1/social/profiles/me')
            .pipe(tap(p => {
                this.ownProfile.set(p);
                this.store(p);
            }));
    }

    public setSelfStatus(status: OnlineStatus): Observable<ProfileDto> {
        return this.httpClient
            .patch<ProfileDto>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/me/status`, {status})
            .pipe(tap(p => {
                this.ownProfile.set(p);
                this.store(p);
            }));
    }

    public updateProfile(patch: { bio?: string; accentColor?: string; font?: ProfileFont }): Observable<ProfileDto> {
        return this.httpClient
            .patch<ProfileDto>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/me`, patch)
            .pipe(tap(p => {
                this.ownProfile.set(p);
                this.store(p);
            }));
    }

    public getCachedById(profileId: string): ProfileDto | undefined {
        return this.byProfileId()[profileId];
    }

    public getCachedByUserId(userId: string): ProfileDto | undefined {
        return this.byUserId()[userId];
    }

    public fetchById(profileId: string): Observable<ProfileDto> {
        return this.coalesce(this.inFlightByProfileId, this.negativeByProfileId, profileId, () =>
            this.httpClient
                .get<ProfileDto>(this.apiConfig.baseUrl() + `/api/v1/social/profiles/${profileId}`)
                .pipe(tap(p => this.store(p))),
        );
    }

    // ── Own profile ──────────────────────────────────────────────────────────

    public fetchByUserId(userId: string): Observable<ProfileDto> {
        return this.coalesce(this.inFlightByUserId, this.negativeByUserId, userId, () =>
            this.httpClient
                .get<ProfileDto>(this.apiConfig.baseUrl() + `/api/v1/social/profiles/by-user/${userId}`)
                .pipe(tap(p => this.store(p))),
        );
    }

    // ── Sync cache reads ─────────────────────────────────────────────────────

    public getById(profileId: string): Observable<ProfileDto> {
        const cached = this.byProfileId()[profileId];
        return cached ? of(cached) : this.fetchById(profileId);
    }

    public getByUserId(userId: string): Observable<ProfileDto> {
        const cached = this.byUserId()[userId];
        return cached ? of(cached) : this.fetchByUserId(userId);
    }

    // ── Fetches -circuit-breaker protected ─────────────────────────────────

    /**
     * Asks for a profile if we do not have it, and says nothing about the result.
     *
     * <p><b>The cache read is untracked, and that is load-bearing.</b> Every caller - the avatar,
     * the message header, the system message - calls this from inside an `effect`, and those effects
     * <i>should</i> re-run when the map changes: that is how an avatar repaints once its profile
     * lands. What they must not do is subscribe to the map <b>through this call</b>. {@link store}
     * replaces the whole `Record` on every profile that arrives, so a tracked read here made one
     * profile landing re-run every avatar and message effect on screen, and each re-run re-asked for
     * any id the cache still lacked. The callers keep their own dependency on the map by reading it
     * themselves (`getCachedByUserId` in a `computed`); this resolver just stops being a second,
     * invisible subscription that nobody asked for.</p>
     *
     * <p>Ids that recently failed are skipped for {@link NEGATIVE_CACHE_TTL} - without that, the
     * "not cached" test below is true again the moment a failed request settles.</p>
     */
    public resolveById(profileId: string): void {
        if (untracked(() => this.byProfileId()[profileId])) return;
        if (this.recentlyFailed(this.negativeByProfileId, profileId)) return;
        this.fetchById(profileId).subscribe();
    }

    /** By user id. See {@link resolveById} for why the cache read is untracked. */
    public resolveByUserId(userId: string): void {
        if (untracked(() => this.byUserId()[userId])) return;
        if (this.recentlyFailed(this.negativeByUserId, userId)) return;
        this.fetchByUserId(userId).subscribe();
    }

    // ── Cache-first getters ──────────────────────────────────────────────────

    public uploadAvatar(file: File): Observable<ProfileDto> {
        const current = this.ownProfile();
        if (!current) return EMPTY;
        const form = new FormData();
        form.append('file', file, file.name);
        return this.httpClient
            .patch(
                `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/avatar`,
                form,
                {responseType: 'text'},
            )
            .pipe(switchMap(() => this.requestSelf()), tap(p => this.retryImages(p)));
    }

    public uploadBanner(file: File): Observable<ProfileDto> {
        const current = this.ownProfile();
        if (!current) return EMPTY;
        const form = new FormData();
        form.append('file', file, file.name);
        return this.httpClient
            .patch(
                `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/banner`,
                form,
                {responseType: 'text'},
            )
            .pipe(switchMap(() => this.requestSelf()), tap(p => this.retryImages(p)));
    }

    public removeAvatar(): Observable<ProfileDto> {
        const current = this.ownProfile();
        if (!current) return EMPTY;
        return this.httpClient
            .delete(
                `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/avatar`,
                {responseType: 'text'},
            )
            .pipe(switchMap(() => this.requestSelf()), tap(p => this.retryImages(p)));
    }

    /**
     * Lets the profile's images be requested again after the user changed one.
     *
     * <p>An avatar or banner URL is derived from the profile id, so it does not change when the
     * image behind it does. Without this, a profile that had no banner - and whose URL is
     * therefore recorded as serving nothing - would keep showing the accent colour after an
     * upload, because nothing about the URL says it now resolves.</p>
     */
    private retryImages(profile: ProfileDto): void {
        for (const url of [profile.avatarUrl, profile.bannerUrl]) {
            this.brokenImages.clear(url);
            this.brokenImages.clear(cacheBustedUrl(url, profile.updatedAt));
        }
    }

    // ── Fire-and-forget resolvers ────────────────────────────────────────────

    public setOnlineStatus(userId: string, status: OnlineStatus): void {
        const cached = this.byUserId()[userId];
        if (!cached) return;
        this.store({...cached, onlineStatus: status});
    }

    public getOnlineStatus(userId: string): OnlineStatus {
        return this.byUserId()[userId]?.onlineStatus ?? OnlineStatus.Offline;
    }

    // ── Avatar ───────────────────────────────────────────────────────────────

    private isAvailable(): boolean {
        if (this.circuitState === 'closed' || this.circuitState === 'half-open') return true;
        // Open -check if recovery window has elapsed
        if (Date.now() - this.openedAt >= RECOVERY_TIMEOUT) {
            this.circuitState = 'half-open';
            return true;
        }
        return false;
    }

    private onSuccess(): void {
        this.failureCount = 0;
        this.circuitState = 'closed';
    }

    // ── Online status ────────────────────────────────────────────────────────

    private onFailure(): void {
        this.failureCount++;
        if (this.failureCount >= FAILURE_THRESHOLD) {
            this.circuitState = 'open';
            this.openedAt = Date.now();
            console.warn('[ProfileService] Circuit breaker tripped -returning fallback profiles');
        }
    }

    /**
     * Hands every caller asking for the same id the one request, until that request settles.
     *
     * <p>The map is written <b>before</b> anything is subscribed, which is the part that matters:
     * callers arrive synchronously within a single change-detection pass, so a window that only
     * opened once the first response came back would never catch any of them.</p>
     *
     * <p>`shareReplay` with `refCount: false` is deliberate. With ref counting, a caller that
     * unsubscribes before the response lands - an avatar for a row that scrolled away, say - would
     * tear the shared request down and leave the next caller to start a fresh one, which is the
     * duplicate this exists to prevent. The subscription is bounded anyway: an HTTP observable
     * completes after one response.</p>
     *
     * <p>`finalize` runs on the source, so the entry is dropped as soon as the response (or error)
     * arrives rather than being held for the lifetime of the app. A failed fetch therefore leaves
     * nothing behind here and an explicit {@link fetchByUserId} may retry immediately - it is the
     * negative cache, consulted only by the resolvers, that stops a persistently failing id from
     * being asked for on every repaint.</p>
     *
     * <p>The failure is recorded on the <b>inner</b> request, before {@link protect} turns it into a
     * fallback profile. That placement is what keeps the negative cache honest: a call the breaker
     * refused never subscribes to this observable, so an open breaker cannot mark ids it never
     * asked about.</p>
     */
    private coalesce(
        inFlight: Map<string, Observable<ProfileDto>>,
        negative: Map<string, number>,
        key: string,
        request: () => Observable<ProfileDto>,
    ): Observable<ProfileDto> {
        const existing = inFlight.get(key);
        if (existing) return existing;

        const attempt = request().pipe(
            tap({error: () => negative.set(key, Date.now())}),
        );
        const shared = this.protect(attempt).pipe(
            finalize(() => inFlight.delete(key)),
            shareReplay({bufferSize: 1, refCount: false}),
        );
        inFlight.set(key, shared);
        return shared;
    }

    /**
     * Whether this id failed recently enough that the resolvers should leave it alone.
     *
     * <p>Expired entries are dropped on read rather than swept: the map only ever holds ids someone
     * asked for, and an id nobody asks for again costs one number until the next reload.</p>
     */
    private recentlyFailed(negative: Map<string, number>, key: string): boolean {
        const failedAt = negative.get(key);
        if (failedAt === undefined) return false;
        if (Date.now() - failedAt < NEGATIVE_CACHE_TTL) return true;
        negative.delete(key);
        return false;
    }

    /** Wraps an HTTP call with circuit breaker logic */
    private protect(request: Observable<ProfileDto>): Observable<ProfileDto> {
        if (!this.isAvailable()) {
            return of(FALLBACK_PROFILE);
        }
        return request.pipe(
            tap(() => this.onSuccess()),
            catchError(() => {
                this.onFailure();
                return of(FALLBACK_PROFILE);
            }),
        );
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Indexes a profile under both keys and forgets any failure recorded against them.
     *
     * <p>The clear matters for an id that was refetched explicitly after a 404 - a restored account,
     * or a routing blip - so that if the profile is ever dropped from the cache it can be resolved
     * again rather than sitting out the rest of a cooldown nothing is still true about.</p>
     */
    private store(profile: ProfileDto): void {
        this.negativeByProfileId.delete(profile.id);
        this.negativeByUserId.delete(profile.userId);
        this.byProfileId.update(c => ({...c, [profile.id]: profile}));
        this.byUserId.update(c => ({...c, [profile.userId]: profile}));
    }

}
