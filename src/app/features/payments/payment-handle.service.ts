import {inject, Injectable, Injector, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {isTauri} from '@tauri-apps/api/core';
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
import {
    openPaymentHandles,
    PaymentCryptoError,
    sealPaymentHandles,
} from './payment-handle-crypto';
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

/**
 * Why a housemate's payment details are not on screen.
 *
 * <p><b>`not-shared` is a state, not an error, and the distinction is the whole point.</b> Only the
 * owner's device holds the content key, so somebody who joined the house after the last write
 * simply has no wrap - there is nothing broken, nobody did anything wrong, and the honest sentence
 * is "Anna hasn't shared how to pay her with you yet". Rendering that as a failure would send
 * people to support for a thing that fixes itself the next time Anna opens her settings.</p>
 */
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
    /**
     * Plaintext numbers, keyed by user id, kept in their own map.
     *
     * <p><b>Never folded into {@link members}.</b> A number is plaintext the server read and could
     * log; a handle is ciphertext it cannot open. Merging them is the obvious tidy-up and it is the
     * wrong one, because after it the UI has no way left to tell a user which protection applies to
     * what they are looking at.</p>
     */
    phoneNumbers: Record<string, SharedPhoneNumber>;
    /** The caller's own opt-in for this household. Off is where everybody starts. */
    sharingPhoneNumber: boolean;
}

const EMPTY: GuildPaymentState = {
    loaded: false, loading: false, forbidden: false, failed: false,
    rosterVersion: 0, members: {}, ownRosterVersion: null,
    phoneNumbers: {}, sharingPhoneNumber: false,
};

/**
 * The sealed payment handles: reading everybody's, writing your own, and deciding whose devices are
 * worth sealing to.
 *
 * <p><b>What the encryption is for, so the copy this service drives can be honest.</b> The server
 * stores ciphertext it has no key for, so a database disclosure - a dump, a backup, a curious query
 * - yields nothing. That is the guarantee and the whole of it. It does not defend against a
 * malicious or compromised server, because the same operator serves the device-key directory this
 * service seals against and could return a key they hold. `device-trust.ts` is the mitigation:
 * attestation state is read and acted on, keys are pinned on first use, and the fingerprint shown
 * is the same string the MLS review screens print for the same key.</p>
 *
 * <p><b>Desktop only, for now.</b> Opening a blob needs this device's Ed25519 seed, which lives in
 * the OS keychain behind the Tauri secure-storage plugin. In the browser build there is no keychain
 * and no seed, so {@link isAvailable} is false and the UI renders nothing rather than an empty
 * list - the same line `MasterKeyService` draws, and for the same reason: a platform with no engine
 * is not a failure worth retrying.</p>
 */
@Injectable({providedIn: 'root'})
export class PaymentHandleService {
    private readonly injector = inject(Injector);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly pins = inject(DevicePinStore);

    /**
     * Everything that reaches the network, resolved on demand rather than as fields.
     *
     * <p><b>Because {@link forgetAll} must cost nothing to reach.</b> Constructing this service
     * eagerly pulled `PaymentHandleApiService`, `RealtimeConnectionService` and `ProfileService` in
     * with it, and through each of them `ApiConfigService` and `OAuthService` - so wiring the
     * one-line "drop the decrypted payloads" call into `SessionTeardownService` made ten tests of a
     * pure Tauri harness fail on `No provider found for OAuthService`. Clearing two in-memory
     * fields has no business requiring an authentication stack in scope, and a teardown is exactly
     * the moment when that stack is least likely to be intact. Same reasoning, and the same remedy,
     * as `DeviceIdentityService` reaching for `DeviceService` this way.</p>
     */
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

    /**
     * The decrypted payloads, in memory only.
     *
     * <p>Never written to disk, never to a store, never to a log. The blob is the durable copy and
     * it is sealed; a cache of the plaintext beside it would be the one artefact on this machine
     * that undoes the whole design.</p>
     */
    private readonly opened = new Map<string, PaymentHandlePayload>();

    /**
     * Attaches the realtime handler, once, on the first read.
     *
     * <p>Owned here rather than in `GuildWebsocketService` so this feature keeps its own
     * subscription. It is state replication and must never raise a notification: the payload
     * carries no readable content, and alerting on it would tell the whole house the moment
     * somebody edited their bank details.</p>
     *
     * <p>Deferred to the first {@link load} rather than done in the constructor, because there is
     * nothing to replicate before anything has asked for a directory - and because a constructor
     * that touches the socket is a constructor that cannot run without one.</p>
     */
    private subscribeOnce(): void {
        if (this.subscribed) return;
        this.subscribed = true;

        this.realtime.on('guild.PaymentHandlesChanged', (data: PaymentHandlesChanged) => {
            if (data?.guildId) void this.load(data.guildId, true);
        });
    }

    /** False in the browser build, where there is no keychain to read this device's seed from. */
    isAvailable(): boolean {
        return isTauri();
    }

    stateFor(guildId: string): GuildPaymentState {
        return this.states()[guildId] ?? EMPTY;
    }

    /** One member's handles, or the reason they are not there. */
    handlesFor(guildId: string, userId: string): MemberHandleState {
        return this.stateFor(guildId).members[userId] ?? {status: 'none'};
    }

    /**
     * One member's shared phone number, or null.
     *
     * <p><b>Null carries no information beyond "there is nothing to show".</b> It means that member
     * has not opted in for this household <i>or</i> has no number on their account, and the server
     * deliberately makes those two indistinguishable - somebody who has not consented is never even
     * named on the bus to Identity. Nothing may be rendered that implies which it is: "Anna has not
     * shared her number" asserts that Anna has one.</p>
     */
    phoneNumberFor(guildId: string, userId: string): SharedPhoneNumber | null {
        return this.stateFor(guildId).phoneNumbers[userId] ?? null;
    }

    /** Whether the caller has opted their own number in to this household. */
    isSharingPhoneNumber(guildId: string): boolean {
        return this.stateFor(guildId).sharingPhoneNumber;
    }

    /**
     * Turns the caller's own number on or off for this household.
     *
     * <p>The new state is taken from the server's echo rather than from the value sent, so a write
     * the server declined cannot leave the toggle showing something that is not true. A re-read
     * follows, because switching on is what makes the number appear in the directory.</p>
     */
    async setPhoneSharing(guildId: string, share: boolean): Promise<void> {
        const result = await firstValueFrom(this.api.setPhoneSharing(guildId, share));
        this.patch(guildId, {sharingPhoneNumber: result.sharingPhoneNumber});
        await this.load(guildId, true);
    }

    /**
     * Whether the signed-in member should be prompted to re-seal.
     *
     * <p>True when our own blob names an older roster than the guild has now, which is exactly the
     * situation in which somebody who has joined cannot read it. Only the owner can fix it, because
     * only the owner's devices hold the content key.</p>
     */
    needsResealFor(guildId: string): boolean {
        const state = this.stateFor(guildId);
        return state.loaded
            && state.ownRosterVersion !== null
            && state.ownRosterVersion < state.rosterVersion;
    }

    /**
     * Loads and opens every blob this device can read.
     *
     * @param force re-reads even when the directory is already loaded. Used by the realtime hook.
     */
    async load(guildId: string, force = false): Promise<void> {
        if (!this.isAvailable()) return;

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

    /**
     * Works out who a seal would reach, so the user can be shown it before anything is written.
     *
     * <p>Called before every seal, not once at load: the roster and the attestation state can both
     * have moved since the page opened, and a plan computed against a stale directory is a plan
     * that seals to a device the user was never shown.</p>
     */
    async planSealFor(guildId: string, confirmedDeviceIds: ReadonlySet<string>): Promise<SealPlan> {
        const ownUserId = this.ownUserId();
        const response = await firstValueFrom(this.api.recipients(guildId));
        const pins = this.pins.read(ownUserId, guildId);

        const trusts = await Promise.all(
            response.recipients.map(recipient => this.classify(recipient, pins)));

        return planSeal(trusts, confirmedDeviceIds, response.unresolvedMemberIds ?? []);
    }

    /**
     * Seals the caller's own handles and replaces whatever was stored.
     *
     * <p><b>Wholesale, never a merge.</b> A fresh content key is minted, so the plan's `included`
     * list is the complete set of devices that will be able to read what is written - anybody left
     * out is silently revoked, which is why {@link planSealFor} is shown to the user first.</p>
     *
     * <p>Pins are written only after the server has accepted the write, and only for the devices
     * actually included. Pinning a key we declined to seal to would quietly accept a key the user
     * refused.</p>
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

        await firstValueFrom(this.api.seal(guildId, {
            ciphertext: envelope.ciphertext,
            nonce: envelope.nonce,
            version: envelope.version,
            wraps: envelope.wraps,
        }));

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

    private async classify(
        recipient: PaymentHandleRecipient,
        pins: DevicePins,
    ): Promise<RecipientTrust> {
        const fingerprint = await fingerprintOf(recipient.publicKey);
        const pinned = pins[recipient.deviceId] ?? null;
        // Only computed when it is going to be shown, which is when the key has actually moved.
        const previous = pinned && pinned.publicKey !== recipient.publicKey
            ? await fingerprintOf(pinned.publicKey)
            : null;

        return classifyRecipient(recipient, fingerprint, pins, previous);
    }

    private async absorb(guildId: string, directory: PaymentHandleDirectory): Promise<void> {
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
                        blob, blob.wrappedKey, privateKey, ownDeviceId, guildId, blob.userId)
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
            ownRosterVersion: directory.members
                .find(m => m.userId === ownUserId)?.memberRosterVersion ?? null,
            // Kept in their own map rather than attached to the member states above. See
            // `GuildPaymentState.phoneNumbers` for why merging the two would be the wrong tidy-up.
            phoneNumbers: Object.fromEntries(
                (directory.phoneNumbers ?? []).map(entry => [entry.userId, entry])),
            sharingPhoneNumber: directory.sharingPhoneNumber ?? false,
        });
    }

    /**
     * This device's Ed25519 seed, from the OS keychain.
     *
     * <p>The same entry MLS loads its signing key from, because it is the same key: the value
     * registered as the device's `identityPublicKey` is `batch.signingPublicKey`, so the key the
     * directory serves for this device and the key stored here are two halves of one pair. Reading
     * it rather than minting anything matters - generating a fresh keypair here would orphan this
     * device from every MLS group it belongs to.</p>
     *
     * @returns null when there is no key, which presents as every blob being unreadable rather than
     *          as a crash. That is a device that never completed registration, and the existing
     *          device-registration flow is the repair.
     */
    private async ownPrivateKey(deviceId: string): Promise<string | null> {
        try {
            return await secureStorage.getItem(`alpine_mls_${deviceId}_priv`);
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

/** Convenience for a template that only needs "is there anything to show". */
export function hasHandles(state: MemberHandleState): boolean {
    return state.status === 'available' && state.payload.handles.length > 0;
}
