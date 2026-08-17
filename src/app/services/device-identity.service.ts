import {inject, Injectable, Injector} from '@angular/core';
import {firstValueFrom, from, Observable, switchMap} from 'rxjs';
import {SecureStore} from '../platform/ports/secure-store.port';
import {DeviceService} from './device.service';
import {describeCurrentDevice} from './device-description';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from './account-registry.service';
import {SETTINGS_FILE} from './settings-store';
import {SettingsStore, SettingsStoreFactory} from '../platform/ports/settings-store.port';

/** Pre-slot single id. Read for migration, and still written for the bootstrap slot. */
const LEGACY_DEVICE_ID_KEY = 'mls_device_id';
/** `slotId -> deviceId`. */
const DEVICE_IDS_KEY = 'mls_device_ids';

interface StoredId {value: string}

/**
 * The device identity of whichever account is live - the id the backend validates as `X-Device-Id`,
 * attributes push tokens to, and links login sessions against.
 *
 * <p><b>One per account, not one per installation.</b> Every piece of local MLS state is named
 * after it: the keychain entries are `alpine_mls_{deviceId}_{field}`, the engine state file is
 * `mls_state_{deviceId}.json`, and the group registry and message cache carry it in their
 * filenames. Making the id per-account is therefore the whole of the isolation - two accounts on
 * one machine cannot see each other's keys because they never resolve to the same name.</p>
 *
 * <p>Before that isolation existed, signing out through a path that did not wipe (which was most of
 * them) and signing in as someone else loaded the previous account's signing key, groups, registry
 * and plaintext message cache into the new session, and nothing compared the stored identity
 * against the user who was actually signed in.</p>
 */
@Injectable({providedIn: 'root'})
export class DeviceIdentityService {
    private readonly injector = inject(Injector);
    private readonly registry = inject(AccountRegistryService);

    /**
     * The settings backend.
     *
     * <p>A field injection, unlike {@link devices} and {@link secureStore}: this one is what *every*
     * caller of this service ends up needing, so deferring it would buy nothing, and neither adapter
     * does any work while being constructed. It replaces a free `openSettingsStore()` that asked
     * `detectHost()` per call.</p>
     */
    private readonly settings = inject(SettingsStoreFactory);

    /** Keyed by slot, because the live slot can change without the service being rebuilt. */
    private readonly cached = new Map<string, Promise<string>>();

    /**
     * Resolved on demand, not as a field.
     *
     * Reading the device id needs no HTTP at all - only registration does. Injecting
     * `DeviceService` eagerly would drag `ApiConfigService` and `OAuthService` into every
     * consumer's injector, which is how this first broke `MlsService`: 250 tests of a pure Tauri
     * adapter suddenly needed an OAuth provider.
     */
    private get devices(): DeviceService {
        return this.injector.get(DeviceService);
    }

    /**
     * The keychain on desktop, IndexedDB on web - resolved on demand, for the same reason as
     * {@link devices}.
     *
     * <p>Only {@link ensureRegistered} reads it. Every other caller of this service - the device-id
     * interceptor, the account switch, `MlsService` - wants an id and nothing else, and a field
     * injection would make all of them require a `SecureStore` provider to construct a service that
     * would never touch it.</p>
     */
    private get secureStore(): SecureStore {
        return this.injector.get(SecureStore);
    }

    /** This account's device id, minted on first use. */
    async deviceId(): Promise<string> {
        const slotId = await this.registry.activeSlotId();
        return this.forSlot(slotId);
    }

    /**
     * Adopts an id this account already used on another install or device.
     *
     * <p>The restore path's one irreplaceable step. A reinstall mints a fresh id, so a §D backup
     * taken before it reports `engineRestored: false` and the ratchet state - and with it every
     * message from before the reinstall - stays unreadable, on what is physically the same machine.
     * Adopting the backup's id first is what `import_backup` assumes the caller has done.</p>
     *
     * <p>Destructive by nature: the id it replaces names key material that nothing will look up
     * again. Callers must confirm with the user, and must be sure the device the id came from is
     * signed out - two live devices on one MLS leaf reuse sender-ratchet generations, which breaks
     * sending for both and voids forward secrecy for that leaf.</p>
     */
    async adopt(deviceId: string): Promise<void> {
        const slotId = await this.registry.activeSlotId();
        await this.write(slotId, deviceId);
        this.cached.set(slotId, Promise.resolve(deviceId));
    }

    /**
     * Whether this account is the one that inherited the pre-scope installation id.
     *
     * <p>That slot, and only that slot, owns the unscoped `mls_state.json` and the keychain
     * entries named after it. The engine needs to be told, because the file is the account's whole
     * group state and moving the wrong one would hand it to the wrong account.</p>
     */
    async ownsLegacyState(): Promise<boolean> {
        const legacy = await this.store().get<StoredId>(LEGACY_DEVICE_ID_KEY);
        if (!legacy?.value) return false;
        return (await this.deviceId()) === legacy.value;
    }

    /** Drops this account's id so the next {@link deviceId} call mints a fresh one. */
    async reset(): Promise<void> {
        const slotId = await this.registry.activeSlotId();
        this.cached.delete(slotId);

        const store = this.store();
        const map = (await store.get<Record<string, string>>(DEVICE_IDS_KEY)) ?? {};
        delete map[slotId];
        await store.set(DEVICE_IDS_KEY, map);
        if (slotId === BOOTSTRAP_SLOT_ID) await store.delete(LEGACY_DEVICE_ID_KEY);
        await store.save();
    }

    /**
     * Idempotently (re)creates this device's server-side record.
     *
     * Deliberately re-registers with the signing key already in secure storage instead of
     * generating a batch: `MlsService.generateKeyPackages` mints a *fresh* Ed25519 keypair, which
     * would silently orphan this device from every MLS group it belongs to. Recovering a deleted
     * device row must not cost the account its message history on this machine.
     *
     * @returns false when it could not register - the caller should fall through to its normal
     *          error path rather than retry. The interactive `DeviceRegistrationModalComponent`
     *          remains the only correct recovery when no signing key is stored at all.
     */
    async ensureRegistered(): Promise<boolean> {
        try {
            const deviceId = await this.deviceId();
            const identityPublicKey = await this.secureStore.getItem(`alpine_mls_${deviceId}_pub`);
            if (!identityPublicKey) return false;

            const {deviceName, deviceType} = describeCurrentDevice();
            await firstValueFrom(this.devices.registerDevice({
                clientDeviceId: deviceId,
                deviceName,
                deviceType,
                identityPublicKey,
            }));
            return true;
        } catch (err) {
            console.error('Device re-registration failed', err);
            return false;
        }
    }

    /** "Forget this device" - see {@link DeviceService.deleteDevice} for what this destroys. */
    unregister(): Observable<void> {
        return from(this.deviceId()).pipe(
            switchMap(deviceId => this.devices.deleteDevice(deviceId)),
        );
    }

    private forSlot(slotId: string): Promise<string> {
        const hit = this.cached.get(slotId);
        if (hit) return hit;

        // A rejected promise left in the cache would fail every later caller for the whole
        // session, turning one transient store error into a permanently header-less client.
        const pending = this.resolve(slotId).catch((err: unknown) => {
            this.cached.delete(slotId);
            throw err;
        });
        this.cached.set(slotId, pending);
        return pending;
    }

    /** A handle on the shared settings file, opened per use. See {@link SettingsStoreFactory}. */
    private store(): SettingsStore {
        return this.settings.open(SETTINGS_FILE);
    }

    private async resolve(slotId: string): Promise<string> {
        const store = this.store();
        const map = (await store.get<Record<string, string>>(DEVICE_IDS_KEY)) ?? {};

        const existing = map[slotId];
        if (existing) return existing;

        const adopted = await this.claimLegacyId(store, map, slotId);
        const value = adopted ?? crypto.randomUUID();

        await this.write(slotId, value, store, map);
        return value;
    }

    /**
     * Hands the pre-slot `mls_device_id` to the first slot that asks for one.
     *
     * <p><b>The upgrade path, and it is load-bearing.</b> Everything this installation already
     * holds - the keychain entries, `mls_state.json`, the registry and the cache - is named after
     * that id. Minting a fresh one instead would leave all of it addressed to a slot nothing looks
     * up, which presents to the user exactly as this device being silently ejected from every group
     * it belongs to.</p>
     *
     * <p>Claimed once. A second slot asking gets a fresh id, because the first one's key material is
     * now legitimately in use and two accounts sharing a device id is the confidentiality failure
     * this whole change exists to close.</p>
     */
    private async claimLegacyId(
        store: SettingsStore,
        map: Record<string, string>,
        slotId: string,
    ): Promise<string | null> {
        const legacy = await store.get<StoredId>(LEGACY_DEVICE_ID_KEY);
        if (!legacy?.value) return null;

        // The bootstrap slot *is* the legacy id - it is what the pre-login paths were already
        // using, and re-minting here would change the id mid-flight on the login request.
        if (slotId === BOOTSTRAP_SLOT_ID) return legacy.value;

        const claimed = Object.values(map).includes(legacy.value);
        return claimed ? null : legacy.value;
    }

    private async write(
        slotId: string,
        deviceId: string,
        store: SettingsStore = this.store(),
        map?: Record<string, string>,
    ): Promise<void> {
        const current = map ?? (await store.get<Record<string, string>>(DEVICE_IDS_KEY)) ?? {};
        await store.set(DEVICE_IDS_KEY, {...current, [slotId]: deviceId});

        // Kept in step so a downgrade, or any code still reading the old key, sees the id the
        // bootstrap paths use rather than nothing at all.
        if (slotId === BOOTSTRAP_SLOT_ID) {
            await store.set(LEGACY_DEVICE_ID_KEY, {value: deviceId} satisfies StoredId);
        }
        await store.save();
    }
}
