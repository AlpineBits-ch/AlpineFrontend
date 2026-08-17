import {inject, Injectable, Injector, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {PlatformCapabilities} from '../../platform/capabilities';
import {SecureStore} from '../../platform/ports/secure-store.port';
import {DeviceIdentityService} from '../../services/device-identity.service';
import {ProfileService} from '../../services/profile.service';
import {RealtimeConnectionService} from '../../services/realtime-connection.service';
import {PaymentHandleApiService} from './payment-handle-api.service';
import {
    PaymentHandleDirectory,
    PaymentHandleRecipient,
    PaymentHandlesChanged,
    SharedPhoneNumber,
} from './payment-handle.dto';
import {openPaymentHandles, PaymentCryptoError, sealPaymentHandles} from './payment-handle-crypto';
import {
    classifyRecipient,
    DevicePins,
    fingerprintOf,
    pinsAfterSeal,
    planSeal,
    RecipientTrust,
    SealPlan,
} from './device-trust';
import {DevicePinStore} from './device-pin.store';
import {parsePayload, PaymentHandlePayload, serializePayload} from './payment-handle.model';

/** Why a housemate's payment details are not on screen. */
export type MemberHandleState =
    /** Opened, and the handles are available. */
    | {status: 'available'; payload: PaymentHandlePayload; updatedAt: string; stale: boolean}
    /** No wrap for this device. The ordinary case for a new flatmate. */
    | {status: 'not-shared'}
    /** A wrap exists but would not open. Rare, and worth saying plainly rather than hiding. */
    | {status: 'unreadable'}
    /** This member has never recorded any details. */
    | {status: 'none'};

interface GuildPaymentState {
    loaded: boolean;
    loading: boolean;
    /** A `403` means the household has no Ledger module, not that this member lacks a role. */
    forbidden: boolean;
    failed: boolean;
    /** The roster version the server reports right now. */
    rosterVersion: number;
    /** Keyed by user id. */
    members: Record<string, MemberHandleState>;
    /** Our own last-sealed roster version, or null when we have never sealed. */
    ownRosterVersion: number | null;
    /** Plaintext numbers, keyed by user id, kept in their own map. */
    phoneNumbers: Record<string, SharedPhoneNumber>;
    /** The caller's own opt-in for this household. Off is where everybody starts. */
    sharingPhoneNumber: boolean;
}

const EMPTY: GuildPaymentState = {
    loaded: false,
    loading: false,
    forbidden: false,
    failed: false,
    rosterVersion: 0,
    members: {},
    ownRosterVersion: null,
    phoneNumbers: {},
    sharingPhoneNumber: false,
};

/**
 * The sealed payment handles: reading everybody's, writing your own, and deciding whose devices are
 * worth sealing to.
 */
@Injectable({providedIn: 'root'})
export class PaymentHandleService {
    private readonly injector = inject(Injector);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly pins = inject(DevicePinStore);
    /**
     * Injected as a field, unlike everything below: it is root-provided with a default factory of
     * its own, so it resolves in any injector - including the bare harnesses that reach this service
     * through `SessionTeardownService.forgetAll()` and must not need a platform provider to do it.
     */
    private readonly capabilities = inject(PlatformCapabilities);

    /** Everything that reaches the network, resolved on demand rather than as fields. */
    private get api(): PaymentHandleApiService {
        return this.injector.get(PaymentHandleApiService);
    }

    private get realtime(): RealtimeConnectionService {
        return this.injector.get(RealtimeConnectionService);
    }

    private get profiles(): ProfileService {
        return this.injector.get(ProfileService);
    }

    private readonly states = signal<Record<string, GuildPaymentState>>({});

    /** Whether the realtime handler has been attached. See {@link subscribeOnce}. */
    private subscribed = false;

    /** The decrypted payloads, in memory only. */
    private readonly opened = new Map<string, PaymentHandlePayload>();

    /** Attaches the realtime handler, once, on the first read. */
    private subscribeOnce(): void {
        if (this.subscribed) return;
        this.subscribed = true;

        this.realtime.on('guild.PaymentHandlesChanged', (data: PaymentHandlesChanged) => {
            if (data?.guildId) void this.load(data.guildId, true);
        });
    }

    /**
     * Whether sealed handles can be read or written here. False wherever this device's seed
     * would not be behind an OS keychain.
     */
    isAvailable(): boolean {
        return this.capabilities.hardwareBackedKeys;
    }

    stateFor(guildId: string): GuildPaymentState {
        return this.states()[guildId] ?? EMPTY;
    }

    /** One member's handles, or the reason they are not there. */
    handlesFor(guildId: string, userId: string): MemberHandleState {
        return this.stateFor(guildId).members[userId] ?? {status: 'none'};
    }

    /** One member's shared phone number, or null. */
    phoneNumberFor(guildId: string, userId: string): SharedPhoneNumber | null {
        return this.stateFor(guildId).phoneNumbers[userId] ?? null;
    }

    /** Whether the caller has opted their own number in to this household. */
    isSharingPhoneNumber(guildId: string): boolean {
        return this.stateFor(guildId).sharingPhoneNumber;
    }

    /** Turns the caller's own number on or off for this household. */
    async setPhoneSharing(guildId: string, share: boolean): Promise<void> {
        const result = await firstValueFrom(this.api.setPhoneSharing(guildId, share));
        this.patch(guildId, {sharingPhoneNumber: result.sharingPhoneNumber});
        await this.load(guildId, true);
    }

    /** Whether the signed-in member should be prompted to re-seal. */
    needsResealFor(guildId: string): boolean {
        const state = this.stateFor(guildId);
        return (
            state.loaded && state.ownRosterVersion !== null && state.ownRosterVersion < state.rosterVersion
        );
    }

    /**
     * Loads the directory and opens every blob this device can read.
     *
     * @param force re-reads even when the directory is already loaded. Used by the realtime hook.
     */
    async load(guildId: string, force = false): Promise<void> {
        const current = this.stateFor(guildId);
        if (current.loading || (current.loaded && !force)) return;

        this.subscribeOnce();
        this.patch(guildId, {loading: true, failed: false});

        try {
            const directory = await firstValueFrom(this.api.directory(guildId));
            await this.absorb(guildId, directory);
        } catch (err) {
            const status = (err as {status?: number}).status;
            this.patch(guildId, {
                loading: false,
                loaded: true,
                // A 403 here almost always means the household has no Ledger module. The owner gets
                // the same 403, so it must hide the UI rather than claim a missing permission.
                forbidden: status === 403,
                failed: status !== 403,
            });
        }
    }

    /** Works out who a seal would reach, so the user can be shown it before anything is written. */
    async planSealFor(guildId: string, confirmedDeviceIds: ReadonlySet<string>): Promise<SealPlan> {
        const ownUserId = this.ownUserId();
        const response = await firstValueFrom(this.api.recipients(guildId));
        const pins = this.pins.read(ownUserId, guildId);

        const trusts = await Promise.all(
            response.recipients.map(recipient => this.classify(recipient, pins)),
        );

        return planSeal(trusts, confirmedDeviceIds, response.unresolvedMemberIds ?? []);
    }

    /**
     * Seals the caller's own handles and replaces whatever was stored.
     *
     * @throws the API error unchanged, so a caller can distinguish a rejected write from a crypto
     *         failure. Nothing is pinned when the write does not land.
     */
    async seal(guildId: string, payload: PaymentHandlePayload, plan: SealPlan): Promise<void> {
        const ownUserId = this.ownUserId();

        const envelope = await sealPaymentHandles(
            serializePayload(payload),
            plan.included.map(trust => ({
                userId: trust.attestation.userId,
                deviceId: trust.attestation.deviceId,
                publicKey: trust.attestation.publicKey,
            })),
            guildId,
            ownUserId,
        );

        await firstValueFrom(
            this.api.seal(guildId, {
                ciphertext: envelope.ciphertext,
                nonce: envelope.nonce,
                version: envelope.version,
                wraps: envelope.wraps,
            }),
        );

        this.pins.write(ownUserId, guildId, pinsAfterSeal(plan, this.pins.read(ownUserId, guildId)));

        // Our own plaintext is already in hand, so hold it rather than round-tripping a decrypt of
        // something we just encrypted.
        this.opened.set(`${guildId}:${ownUserId}`, payload);
        await this.load(guildId, true);
    }

    /** Removes the caller's own blob and every wrap of it. */
    async remove(guildId: string): Promise<void> {
        await firstValueFrom(this.api.remove(guildId));
        this.opened.delete(`${guildId}:${this.ownUserId()}`);
        await this.load(guildId, true);
    }

    /** The caller's own handles, for seeding the editor. */
    ownPayload(guildId: string): PaymentHandlePayload | null {
        return this.opened.get(`${guildId}:${this.ownUserId()}`) ?? null;
    }

    /** Drops every decrypted payload. Called on sign-out and on account switch. */
    forgetAll(): void {
        this.opened.clear();
        this.states.set({});
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private async classify(recipient: PaymentHandleRecipient, pins: DevicePins): Promise<RecipientTrust> {
        const fingerprint = await fingerprintOf(recipient.publicKey);
        const pinned = pins[recipient.deviceId] ?? null;
        // Only computed when it is going to be shown, which is when the key has actually moved.
        const previous =
            pinned && pinned.publicKey !== recipient.publicKey ? await fingerprintOf(pinned.publicKey) : null;

        return classifyRecipient(recipient, fingerprint, pins, previous);
    }

    private async absorb(guildId: string, directory: PaymentHandleDirectory): Promise<void> {
        // No keychain, so nothing here is opened and the seed must never be reached for: these blobs
        // hold other people's bank details. Ciphertext is dropped and only the plaintext half kept.
        // `members` stays empty rather than `unreadable`: we did not try, which is not a failure.
        if (!this.isAvailable()) {
            this.patch(guildId, {
                loading: false,
                loaded: true,
                forbidden: false,
                failed: false,
                rosterVersion: directory.memberRosterVersion,
                members: {},
                ownRosterVersion: null,
                phoneNumbers: phoneNumbersOf(directory),
                sharingPhoneNumber: directory.sharingPhoneNumber ?? false,
            });
            return;
        }

        const ownUserId = this.ownUserId();
        const ownDeviceId = await this.deviceIdentity.deviceId();

        // The server echoes the device it selected wraps for. A mismatch means this client sent a
        // header for a device that is not the one it thinks it is, and every "not shared" below
        // would be a lie - so it is reported as a failure rather than as an empty house.
        if (directory.deviceId && directory.deviceId !== ownDeviceId) {
            this.patch(guildId, {loading: false, loaded: true, failed: true});
            return;
        }

        const privateKey = await this.ownPrivateKey(ownDeviceId);
        const members: Record<string, MemberHandleState> = {};

        for (const blob of directory.members) {
            if (!blob.wrappedKey) {
                members[blob.userId] = {status: 'not-shared'};
                continue;
            }

            try {
                const json = privateKey
                    ? await openPaymentHandles(
                          blob,
                          blob.wrappedKey,
                          privateKey,
                          ownDeviceId,
                          guildId,
                          blob.userId,
                      )
                    : null;

                if (json === null) {
                    members[blob.userId] = {status: 'unreadable'};
                    continue;
                }

                const payload = parsePayload(json);
                this.opened.set(`${guildId}:${blob.userId}`, payload);

                members[blob.userId] = {
                    status: 'available',
                    payload,
                    updatedAt: blob.updatedAt,
                    // Their blob predates the current roster, so somebody in the house cannot read
                    // it. Not our problem to fix - only they hold the key - but worth showing.
                    stale: blob.memberRosterVersion < directory.memberRosterVersion,
                };
            } catch (err) {
                if (!(err instanceof PaymentCryptoError)) throw err;
                members[blob.userId] = {status: 'unreadable'};
            }
        }

        this.patch(guildId, {
            loading: false,
            loaded: true,
            forbidden: false,
            failed: false,
            rosterVersion: directory.memberRosterVersion,
            members,
            ownRosterVersion:
                directory.members.find(m => m.userId === ownUserId)?.memberRosterVersion ?? null,
            // Kept in their own map rather than attached to the member states above. See
            // `GuildPaymentState.phoneNumbers` for why merging the two would be the wrong tidy-up.
            phoneNumbers: phoneNumbersOf(directory),
            sharingPhoneNumber: directory.sharingPhoneNumber ?? false,
        });
    }

    /**
     * This device's Ed25519 seed, from the OS keychain.
     *
     * @returns null when there is no key, which presents as every blob being unreadable rather than
     *          as a crash. That is a device that never completed registration, and the existing
     *          device-registration flow is the repair.
     */
    private async ownPrivateKey(deviceId: string): Promise<string | null> {
        try {
            // Resolved here rather than as a field, for the same reason as `api` above: only this
            // path needs it, and it is only reached after `isAvailable()` has already said yes.
            return await this.injector.get(SecureStore).getItem(`alpine_mls_${deviceId}_priv`);
        } catch {
            return null;
        }
    }

    private ownUserId(): string {
        const userId = this.profiles.ownProfile()?.userId;
        if (!userId) throw new Error('No signed-in account');
        return userId;
    }

    private patch(guildId: string, partial: Partial<GuildPaymentState>): void {
        this.states.update(all => ({
            ...all,
            [guildId]: {...(all[guildId] ?? EMPTY), ...partial},
        }));
    }
}

/** The plaintext half of a directory read, keyed by user id. Needs no key and no host. */
function phoneNumbersOf(directory: PaymentHandleDirectory): Record<string, SharedPhoneNumber> {
    return Object.fromEntries((directory.phoneNumbers ?? []).map(entry => [entry.userId, entry]));
}

/** Convenience for a template that only needs "is there anything to show". */
export function hasHandles(state: MemberHandleState): boolean {
    return state.status === 'available' && state.payload.handles.length > 0;
}
