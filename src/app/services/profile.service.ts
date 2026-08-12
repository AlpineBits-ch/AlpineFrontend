import {inject, Injectable, signal} from '@angular/core';
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

    private apiConfig = inject(ApiConfigService);
    private brokenImages = inject(BrokenImageService);

    // ── Circuit breaker state ────────────────────────────────────────────────

    private circuitState: CircuitState = 'closed';
    private failureCount = 0;
    private openedAt = 0;

    public getSelf(): Observable<ProfileDto> {
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
        return this.coalesce(this.inFlightByProfileId, profileId, () =>
            this.httpClient
                .get<ProfileDto>(this.apiConfig.baseUrl() + `/api/v1/social/profiles/${profileId}`)
                .pipe(tap(p => this.store(p))),
        );
    }

    // ── Own profile ──────────────────────────────────────────────────────────

    public fetchByUserId(userId: string): Observable<ProfileDto> {
        return this.coalesce(this.inFlightByUserId, userId, () =>
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

    public resolveById(profileId: string): void {
        if (!this.byProfileId()[profileId]) {
            this.fetchById(profileId).subscribe();
        }
    }

    public resolveByUserId(userId: string): void {
        if (!this.byUserId()[userId]) {
            this.fetchByUserId(userId).subscribe();
        }
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
            .pipe(switchMap(() => this.getSelf()), tap(p => this.retryImages(p)));
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
            .pipe(switchMap(() => this.getSelf()), tap(p => this.retryImages(p)));
    }

    public removeAvatar(): Observable<ProfileDto> {
        const current = this.ownProfile();
        if (!current) return EMPTY;
        return this.httpClient
            .delete(
                `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/avatar`,
                {responseType: 'text'},
            )
            .pipe(switchMap(() => this.getSelf()), tap(p => this.retryImages(p)));
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
     * nothing behind and the next caller may retry - the circuit breaker, not this map, is what
     * stops a persistently failing id from being asked for forever.</p>
     */
    private coalesce(
        inFlight: Map<string, Observable<ProfileDto>>,
        key: string,
        request: () => Observable<ProfileDto>,
    ): Observable<ProfileDto> {
        const existing = inFlight.get(key);
        if (existing) return existing;

        const shared = this.protect(request()).pipe(
            finalize(() => inFlight.delete(key)),
            shareReplay({bufferSize: 1, refCount: false}),
        );
        inFlight.set(key, shared);
        return shared;
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

    private store(profile: ProfileDto): void {
        this.byProfileId.update(c => ({...c, [profile.id]: profile}));
        this.byUserId.update(c => ({...c, [profile.userId]: profile}));
    }

}
