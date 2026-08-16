import {inject, Injectable, Injector} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {MlsService} from './mls.service';
import {DeviceService} from './device.service';
import {PaymentHandleService} from '../features/payments';
import {MlsCoverageService} from './mls-coverage.service';
import {ProfileService} from './profile.service';
import {CacheStoreFactory} from '../platform/cache-store';

/** What a teardown managed to do, so the caller can report the parts that matter to it. */
export interface TeardownOutcome {
    /**
     * Whether the server-side key-package stock was cleared.
     *
     * <p>False is not fatal to the teardown - everything local is gone either way - but it does
     * mean the server keeps handing out packages whose private halves no longer exist, so callers
     * that have somewhere to record device health should.</p>
     */
    keyPackagesReset: boolean;
}

/**
 * The one place local MLS state is destroyed.
 *
 * <p><b>It exists because there were three copies and they disagreed.</b> The logout dialog wiped
 * everything; the launch sequence's corruption recovery wiped everything except the signing key;
 * and the third path - `MainPageComponent.logout`, which is also the `Ctrl+Shift+L` handler - wiped
 * <i>nothing at all</i> and simply dropped the OAuth token. Signing out that way and signing in as
 * somebody else left the previous account's signing key, groups, registry and plaintext message
 * history on disk and readable, because the cache seal key is derived per device rather than per
 * account.</p>
 *
 * <p>The two operations differ in exactly one thing - whether the signing key goes - and that is
 * the distinction worth naming. A corrupt state file must not cost the account its identity on this
 * machine; signing out must.</p>
 */
@Injectable({providedIn: 'root'})
export class SessionTeardownService {
    private readonly mls = inject(MlsService);
    private readonly devices = inject(DeviceService);
    private readonly injector = inject(Injector);
    private readonly cacheStores = inject(CacheStoreFactory);

    /**
     * Resolved on demand, not as a field.
     *
     * <p>Same reason `DeviceIdentityService` reaches for `DeviceService` this way. Injecting it
     * eagerly drags `PaymentHandleApiService`, `ApiConfigService` and `OAuthService` into every
     * injector that builds a teardown - and this service's own spec is a pure Tauri harness with
     * none of them, so ten tests of MLS state handling started failing on
     * `No provider found for OAuthService`. Forgetting decrypted handles is a one-line courtesy at
     * the end of a wipe; it has no business dictating what a teardown needs in scope.</p>
     */
    private get paymentHandles(): PaymentHandleService {
        return this.injector.get(PaymentHandleService);
    }

    /**
     * Drops this device's group state, keeping its identity.
     *
     * <p>For recovering from a state file this device can no longer read. Re-registering would mint
     * a fresh signing keypair and orphan the device from every group it belongs to, so the
     * keychain entries are deliberately left alone: the device rejoins with the identity it
     * already has.</p>
     */
    async wipeEngineState(deviceId: string): Promise<TeardownOutcome> {
        await firstValueFrom(this.mls.clearStorage());
        await this.mls.clearGroupRegistry();
        await this.mls.clearMessageCache();

        // Cached profiles and message metadata are refetchable; the signing key, group state and
        // key packages this method already dropped are not. A wipe that stopped here to guard a
        // cache would leave the far more sensitive material gone while failing partway through -
        // worse than a cache that outlives the wipe by one launch. `CacheStore.clear()` drops only
        // this device's entries, so a failure here never reaches another account's data either way.
        try {
            await this.cacheStores.open(deviceId).clear();
        } catch (err) {
            console.error('Could not clear the local profile/message cache during a wipe', err);
        }

        // The write-behind hook is deliberately *not* uninstalled here - see {@link wipeAccount}.
        // This method is also the launch sequence's corruption recovery, which keeps the account
        // signed in and carries on rendering; taking the hook down on that path meant no profile
        // was cached again for the rest of the session, and the next launch was the cold start
        // showing raw `user_...` ids that this cache exists to remove.

        // Decrypted payment handles are in-memory only and never reach disk, so this is not a wipe
        // of anything persistent - it is making sure the next account signed in on this machine
        // cannot read the last one's flatmates' bank details out of a live service. Included in the
        // engine-state path as well as the account path because both end a session's right to them.
        this.paymentHandles.forgetAll();

        // Coverage answers are a list of one account's device names, held in memory. The group
        // registry they were cross-checked against has just gone, so they are stale anyway - but
        // the reason to drop them here is the same as for the handles above: the next account
        // signed in on this machine must not read the last one's hardware out of a live service.
        this.injector.get(MlsCoverageService).clear();

        return {keyPackagesReset: await this.resetKeyPackages(deviceId)};
    }

    /**
     * Destroys everything this device holds for an account, identity included.
     *
     * <p>For signing out and for removing an account. Ordered so the session handle is released
     * before the key it refers to is deleted, and so the local wipe completes even when the server
     * call at the end does not - a teardown that stopped early would leave exactly the residue it
     * exists to remove.</p>
     */
    async wipeAccount(deviceId: string): Promise<TeardownOutcome> {
        const handle = this.mls.keyHandle();
        if (handle) {
            try {
                await firstValueFrom(this.mls.unloadSigningKey(handle));
            } catch (err) {
                // The handle is a session-scoped reference to a key that is about to be deleted
                // anyway. Failing to release it must not stop the deletion.
                console.error('Could not release the MLS session handle before teardown', err);
            }
        }
        this.mls.keyHandle.set(undefined);

        await firstValueFrom(this.mls.clearStoredSigningKey(deviceId));

        try {
            return await this.wipeEngineState(deviceId);
        } finally {
            // Uninstalled after the clear, not instead of it, and on this path only.
            // `ProfileCacheService.hydrate` installs a write-behind hook on `ProfileService` and
            // nothing ever took it down; a sign-out is an in-document `router.navigate`, so the
            // hook the outgoing account installed would stay live and keep writing every profile
            // the *next* account resolves, from the moment it signs in until its own hydration
            // replaces it.
            //
            // Here rather than in `wipeEngineState` because only this method ends a session. Its
            // three callers - `runSignOut` via `MainPageComponent.goToLogin`,
            // `AccountSwitchService.signOutOf` and `EmailVerificationDialog.signOutToLogin` - all
            // drop the tokens and navigate to `/authentication` immediately afterwards.
            // `wipeEngineState`'s other caller, `MainPageComponent.wipeLocalMlsState`, is
            // corruption recovery: the account stays signed in and the launch continues, so the
            // hook has to survive it.
            //
            // In a `finally` because `runSignOut` deliberately carries on to the login screen when
            // the wipe throws - a failed wipe must not be what leaves the previous account's hook
            // writing into the next one's session. Resolved through the injector for the same
            // reason `paymentHandles` is: this service's spec is a bare Tauri harness.
            this.injector.get(ProfileService).cachePersist = null;
        }
    }

    /**
     * Contract §A.
     *
     * <p>The step that is easy to miss and expensive to omit. The replenish count is derived purely
     * from server rows while the private init keys live only on this device, so wiping locally and
     * leaving unconsumed packages on the server means the server answers "you have plenty", nothing
     * is re-uploaded, and every Welcome sealed to one of those packages is undecryptable by the very
     * device it was addressed to - silently, and for good.</p>
     */
    private async resetKeyPackages(deviceId: string): Promise<boolean> {
        try {
            await firstValueFrom(this.devices.resetKeyPackages(deviceId));
            return true;
        } catch (err) {
            console.error('Could not reset server-side key packages after a local wipe', err);
            return false;
        }
    }
}
