import {inject, Injectable, signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {catchError, EMPTY, Observable, of, tap} from 'rxjs';
import {environment} from '../../environments/environment';
import {OnlineStatus, ProfileDto} from '../dtos/response/profile.dto';
import {ApiConfigService} from "./api-config.service";

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
    // Two indexes into the same profiles — whichever key you have, you can look up
    private byProfileId = signal<Record<string, ProfileDto>>({});
    private byUserId = signal<Record<string, ProfileDto>>({});

    private apiConfig = inject(ApiConfigService);

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

    public getCachedById(profileId: string): ProfileDto | undefined {
        return this.byProfileId()[profileId];
    }

    public getCachedByUserId(userId: string): ProfileDto | undefined {
        return this.byUserId()[userId];
    }

    public fetchById(profileId: string): Observable<ProfileDto> {
        return this.protect(
            this.httpClient
                .get<ProfileDto>(this.apiConfig.baseUrl() + `/api/v1/social/profiles/${profileId}`)
                .pipe(tap(p => this.store(p))),
        );
    }

    // ── Own profile ──────────────────────────────────────────────────────────

    public fetchByUserId(userId: string): Observable<ProfileDto> {
        return this.protect(
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

    // ── Fetches — circuit-breaker protected ─────────────────────────────────

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
            .patch<ProfileDto>(
                `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/avatar`,
                form,
            )
            .pipe(tap(p => {
                this.ownProfile.set(p);
                this.store(p);
            }));
    }

    public removeAvatar(): Observable<ProfileDto> {
        const current = this.ownProfile();
        if (!current) return EMPTY;
        return this.httpClient
            .delete<ProfileDto>(
                `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/avatar`,
            )
            .pipe(tap(p => {
                this.ownProfile.set(p);
                this.store(p);
            }));
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
        // Open — check if recovery window has elapsed
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
            console.warn('[ProfileService] Circuit breaker tripped — returning fallback profiles');
        }
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
