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
    /** Whether the server-side key-package stock was cleared. False means packages whose private halves are gone. */
    keyPackagesReset: boolean;
}

/** The one place local MLS state is destroyed. The two operations differ in whether the signing key goes. */
@Injectable({providedIn: 'root'})
export class SessionTeardownService {
    private readonly mls = inject(MlsService);
    private readonly devices = inject(DeviceService);
    private readonly injector = inject(Injector);
    private readonly cacheStores = inject(CacheStoreFactory);

    /** Resolved on demand, not as a field: eager injection drags `OAuthService` into every teardown injector. */
    private get paymentHandles(): PaymentHandleService {
        return this.injector.get(PaymentHandleService);
    }

    /** Drops group state, keeping the identity: a fresh signing keypair orphans the device from every group. */
    async wipeEngineState(deviceId: string): Promise<TeardownOutcome> {
        await firstValueFrom(this.mls.clearStorage());
        await this.mls.clearGroupRegistry();
        await this.mls.clearMessageCache();

        // `CacheStore.clear()` drops only this device's entries, and a cache failure must not abort the wipe.
        try {
            await this.cacheStores.open(deviceId).clear();
        } catch (err) {
            console.error('Could not clear the local profile/message cache during a wipe', err);
        }

        // The write-behind hook is not uninstalled here; see {@link wipeAccount}. This path stays signed in.

        // In-memory only: this stops the next account reading the last one's handles out of a live service.
        this.paymentHandles.forgetAll();

        // Same reason as the handles above: the next account must not read the last one's device names.
        this.injector.get(MlsCoverageService).clear();

        return {keyPackagesReset: await this.resetKeyPackages(deviceId)};
    }

    /** Destroys everything for an account, identity included: the session handle goes before its key. */
    async wipeAccount(deviceId: string): Promise<TeardownOutcome> {
        const handle = this.mls.keyHandle();
        if (handle) {
            try {
                await firstValueFrom(this.mls.unloadSigningKey(handle));
            } catch (err) {
                // Failing to release the handle must not stop the deletion.
                console.error('Could not release the MLS session handle before teardown', err);
            }
        }
        this.mls.keyHandle.set(undefined);

        await firstValueFrom(this.mls.clearStoredSigningKey(deviceId));

        try {
            return await this.wipeEngineState(deviceId);
        } finally {
            // Sign-out only, and in a `finally`: the outgoing account's write-behind hook must never
            // survive into the next session, even when the wipe throws.
            this.injector.get(ProfileService).cachePersist = null;
        }
    }

    /** Contract §A. Server-side packages must go too, or Welcomes sealed to them are undecryptable for good. */
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
