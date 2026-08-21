import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';

import {ProfileDto} from '../../dtos/response/profile.dto';
import {CacheStore, CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {ProfileService} from '../profile.service';
import {RevalidationQueue} from './revalidation-queue';
import {trace} from '../../core/log';

/** Four at a time, 50ms apart. Slow enough to stay behind the app's own requests. */
const REVALIDATE_CONCURRENCY = 4;
const REVALIDATE_GAP_MS = 50;

/**
 * Keeps resolved profiles across restarts, which is the whole of the reported bug.
 *
 * <p>Without this the maps in `ProfileService` are empty at every launch, every visible user costs
 * a round trip, and the rate limiter answers the resulting burst by tripping the circuit breaker -
 * which hands back `FALLBACK_PROFILE`. That is what puts a raw `user_...` id under a message from
 * someone the client has resolved hundreds of times.</p>
 */
@Injectable({providedIn: 'root'})
export class ProfileCacheService {
    readonly queue = new RevalidationQueue(REVALIDATE_CONCURRENCY, REVALIDATE_GAP_MS);

    private readonly profiles = inject(ProfileService);
    private readonly stores = inject(CacheStoreFactory);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    private hydrated: string[] = [];

    async remember(profile: ProfileDto): Promise<void> {
        await (await this.cache()).set('profile', profile.userId, profile);
    }

    /**
     * Loads every cached profile into {@link ProfileService} and installs the write-behind hook.
     *
     * @returns how many were loaded, so the caller can log a cold start honestly.
     */
    async hydrate(): Promise<number> {
        const store = await this.cache();
        const entries = await store.all<ProfileDto>('profile');

        const profiles = entries.map(([, value]) => revive(value));
        this.profiles.hydrateFrom(profiles);
        this.hydrated = profiles.map(p => p.userId);

        // Installed after hydration, so replaying the disk copy back onto disk is not the first
        // thing this does.
        this.profiles.cachePersist = profile => this.persist(profile);

        return profiles.length;
    }

    /**
     * The write-behind hook's body, which is why the rejection is swallowed here.
     *
     * <p>`CacheStore.set` rejects on `quota`, `unavailable`, `blocked` and `version`. Discarding
     * that promise sends the rejection to `provideBrowserGlobalErrorListeners()` and on to
     * `GlobalErrorHandler`, which counts three unhandled errors in five seconds as a crash and
     * reloads the window - and with the quota exhausted, {@link revalidateAll} produces three in
     * well under a second. A cache that is full or unavailable is an expected state, not a fault:
     * a failed cache write is a no-op, never something the user is shown.</p>
     */
    private persist(profile: ProfileDto): void {
        void this.remember(profile).catch((err: unknown) => {
            trace('Profile not cached; the cache is full or unavailable', err);
        });
    }

    /**
     * Refreshes every hydrated id in the background.
     *
     * <p>Through `fetchByUserId`, so the existing coalescing and circuit breaker still apply, and
     * through the queue, so this never becomes the burst those exist to absorb. With the server's
     * `ETag` in place each of these is a 304.</p>
     */
    revalidateAll(): void {
        for (const userId of this.hydrated) {
            this.queue.push(async () => {
                await firstValueFrom(this.profiles.fetchByUserId(userId));
            });
        }
    }

    /**
     * The store for whichever account is signed in <i>now</i>.
     *
     * <p><b>Resolved on every operation, never memoised.</b> Signing out is an in-document
     * `router.navigate(['/authentication'])` and signing in is a `router.navigate(['/overview'])`;
     * no injector is destroyed in between, so this service outlives the account it first ran for. A
     * memoised store would put the next account's profiles under the previous account's device id -
     * where its next launch would hydrate them as its own contact graph.
     * {@link CacheStoreFactory.open} memoises per device id, so this costs one map lookup.</p>
     */
    private async cache(): Promise<CacheStore> {
        return this.stores.open(await this.deviceIdentity.deviceId());
    }
}

/**
 * Puts the `Date`s back.
 *
 * <p>JSON has no date type, so `createdAt` and `updatedAt` come back as strings. `cacheBustedUrl`
 * calls `.getTime()` on `updatedAt`, so a string there is a crash on the avatar path rather than a
 * cosmetic wrong type.</p>
 */
function revive(profile: ProfileDto): ProfileDto {
    return {
        ...profile,
        createdAt: new Date(profile.createdAt),
        updatedAt: new Date(profile.updatedAt),
    };
}
