import {computed, inject, Injectable, Injector, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {TranslateService} from '@ngx-translate/core';
import {RealtimeConnectionService} from './realtime-connection.service';
import {DeviceIdentityService} from './device-identity.service';
import {ToastService} from './toast.service';
import {MlsContextEvent, toContextEvent} from './messaging-websocket.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MasterKeyStateService} from './master-key-state.service';

/** How many of each retained security event are kept for the surface. Older ones fall off. */
const MAX_RETAINED_SECURITY_EVENTS = 20;

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

/**
 * `byte[]` as it can arrive over the hub.
 *
 * <p>System.Text.Json - which is what the SignalR JSON protocol uses - writes a `byte[]` as a
 * base64 string, and that is what every live server sends. The number array is accepted only so a
 * protocol change cannot turn a security event into a parse failure that gets swallowed: these
 * bytes are never decoded here, they are carried opaquely for display and comparison.</p>
 */
type WireBytes = string | number[] | null | undefined;

/**
 * `identity.AccountIdentityKeyRotated` (`IdentitySecurityEventHandlers.cs:79`).
 *
 * <p>The bus event behind it carries an `IsFirstPublication` flag
 * (`Identity.Contracts/Bus/Events/AccountIdentityKeyRotated.cs:35`) and the hub handler does not
 * forward it, so it is absent from the wire and derived below instead. Declared anyway, and read
 * when present, so the day the server starts sending it this stops being an inference.</p>
 */
interface AccountIdentityKeyRotatedPayload {
    previousVersion: number;
    version: number;
    publicKey: WireBytes;
    signedByOutgoingKey: boolean;
    changedByDeviceId?: string | null;
    isFirstPublication?: boolean;
    rotatedAt: string;
}

interface BackupReadPayload {
    deviceId: string;
    deviceName: string;
    readByDeviceId?: string | null;
    readAt: string;
}

interface DeviceAdmittedPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    userId: string;
    deviceId: string;
    signatureKeyFingerprint: string;
    autoAdmitted: boolean;
}

interface DeviceRegisteredPayload {
    deviceId: string;
    deviceName: string;
    identityRotated: boolean;
}

interface ProtectionLevelChangedPayload {
    previousLevel: string;
    level: string;
    version: number;
    signedAssertion: WireBytes;
    changedByDeviceId?: string | null;
    isDowngrade: boolean;
    changedAt: string;
}

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

/**
 * The account's long-lived identity key was replaced (contract §H).
 *
 * <p>Everything this device holds that was bound to the previous key - the copy of the account
 * identity keypair carried through the §D backup envelope, and any fingerprint a user compared out
 * of band - describes a key the account no longer uses. Nothing is repaired from the push: Alpine
 * does not mint account identity keys (venta-mobile does), so the only honest response is to say
 * so and let an authoritative read replace what is cached.</p>
 */
export interface AccountIdentityKeyRotatedEvent {
    previousVersion: number;
    version: number;
    /** The new public key, base64. Opaque here - nothing in Alpine verifies against it. */
    publicKey: string | null;
    /**
     * Whether the incoming key was signed by the key it replaces.
     *
     * <p>False is the loud case. A rotation chained to the outgoing key is evidence the account
     * itself performed it; an unchained one is a new key appearing with nothing tying it to the old
     * one, which is exactly what a server substituting its own key would look like. Alpine holds no
     * verifying surface for §H, so this flag is reported to the user rather than acted on - claiming
     * to have checked a signature this client cannot check would be worse than saying nothing.</p>
     */
    signedByOutgoingKey: boolean;
    /** Which device performed it, or null when the server did not attribute it. */
    changedByDeviceId: string | null;
    /**
     * True when the account had no identity key at all until this write.
     *
     * <p>Worth its own wording because "the key you pinned was replaced" is simply untrue here -
     * there was nothing to replace, and `signedByOutgoingKey` is necessarily false, which would
     * otherwise render a first publication as the loudest possible rotation. It is no less serious:
     * whoever publishes first becomes this account's identity to every peer that pins it. But a user
     * told the wrong story cannot act on it, which is the same reason
     * {@link DeviceRegisteredEvent.identityRotated} does not borrow this event's copy.</p>
     */
    isFirstPublication: boolean;
    rotatedAt: string;
}

/** Somebody read the encrypted key backup belonging to a device on this account (§D). */
export interface BackupReadEvent {
    /** The device whose backup blob was read. */
    deviceId: string;
    /** That device's name, as it named itself. Display only. */
    deviceName: string;
    /** The device that did the reading, or null when the server did not attribute it. */
    readByDeviceId: string | null;
    readAt: string;
    /** True when this installation is the one that read it - see the notice rule in the service. */
    readByThisDevice: boolean;
}

/**
 * A device was admitted to a context's MLS group (contract §G).
 *
 * <p><b>Not an account-roster event, however much the `identity.` prefix suggests one.</b> It is
 * emitted by the group service at the moment an Add commit lands, and names the context the leaf
 * was added to. It therefore changes nothing about the account's registered devices and everything
 * about what this device can read.</p>
 */
export interface DeviceAdmittedEvent extends MlsContextEvent {
    /** The account the admitted device belongs to. */
    userId: string;
    /** The admitted device's client device id. */
    deviceId: string;
    /** The admitted leaf's identity fingerprint - the value compared out of band on review. */
    signatureKeyFingerprint: string;
    /**
     * True when no human reviewed it, because policy did not require one (§J.4).
     *
     * <p>In practice always true on this event: `MlsGroupService.AnnounceAdmissionsAsync` sends
     * `identity.DeviceAdmitted` <i>only</i> for the auto-admitted ones (`MlsGroupService.cs:1059`) -
     * a human-approved admission goes out as `conversation.MlsDeviceAdmitted` and nothing else,
     * because somebody on the account already saw and allowed it. So this flag is not a question the
     * push answers so much as the reason the push exists, which is why a missing one reads as
     * true.</p>
     */
    autoAdmitted: boolean;
    /** True when the admitted device is this installation. */
    isOwnDevice: boolean;
}

/** A device was registered against this account. */
export interface DeviceRegisteredEvent {
    deviceId: string;
    /** Chosen by that device, verified by nobody. Display only. */
    deviceName: string;
    /**
     * True when an <b>existing</b> device re-registered under a different signing key.
     *
     * <p><b>This is the device's own MLS identity key, not the account identity key of §H.</b> The
     * two were conflated here, and it matters in both directions: the write is to
     * `UserDevice.IdentityPublicKey` for one row (`MlsDeviceEndpoint.cs:151`), so nothing about the
     * account key moved and {@link IdentityWebsocketService.identityKeyStale} must not be set from
     * it - while the consequence for that device is worse than a stale cache. Its key packages were
     * purged, so it is handed out to nobody, and the leaf it already holds in every group is one it
     * can no longer sign for: it has to be re-admitted, not topped up.</p>
     *
     * <p>The normal cause is a keychain miss or a local state wipe on that device. The abnormal one
     * is somebody else re-registering a device id on this account with a key they hold, which is why
     * this is announced rather than recorded.</p>
     */
    identityRotated: boolean;
    /** True when the registered device is this installation. */
    isOwnDevice: boolean;
}

/**
 * The account's protection level changed.
 *
 * <p>`level` and `previousLevel` stay strings on purpose. Alpine implements no part of §G/§H - the
 * Rust engine deliberately leaves device certificates, admission proofs and protection levels out
 * (`crypto/mls.rs`) - so a local enum would be a list of the levels that existed when this was
 * written, and a level added later would render as an unknown member of a closed set rather than as
 * the name the server actually sent.</p>
 */
export interface ProtectionLevelChangedEvent {
    previousLevel: string;
    level: string;
    version: number;
    /**
     * The server's signed assertion of the new level, base64.
     *
     * <p>Carried, never checked. There is no verifying key on this client, so this exists so a
     * surface can show that an assertion was supplied - it is not evidence of anything here.</p>
     */
    signedAssertion: string | null;
    changedByDeviceId: string | null;
    /** The server's own verdict that protection was weakened rather than strengthened. */
    isDowngrade: boolean;
    changedAt: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Base64 for whichever of the two shapes a `byte[]` arrived in; null when it was absent. */
export function toBase64Bytes(value: WireBytes): string | null {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return null;

    let binary = '';
    for (const byte of value) binary += String.fromCharCode(Number(byte) & 0xff);
    return btoa(binary);
}

export function toAccountIdentityKeyRotatedEvent(
    payload: AccountIdentityKeyRotatedPayload,
): AccountIdentityKeyRotatedEvent {
    return {
        previousVersion: payload.previousVersion,
        version: payload.version,
        publicKey: toBase64Bytes(payload.publicKey),
        // Fails closed. An absent flag is an older server or a payload that lost the field, and
        // "we could not tell whether this rotation was chained" must not read as "it was".
        signedByOutgoingKey: payload.signedByOutgoingKey === true,
        changedByDeviceId: payload.changedByDeviceId ?? null,
        // Derived, because the hub handler drops the flag the bus event carries. `previousVersion`
        // is the account's stored version read before the write, and the endpoint refuses anything
        // that does not exceed it - so zero is the server saying there was no key here before.
        // Trusted from the payload the moment the server starts sending it.
        isFirstPublication: payload.isFirstPublication ?? payload.previousVersion <= 0,
        rotatedAt: payload.rotatedAt,
    };
}

export function toProtectionLevelChangedEvent(
    payload: ProtectionLevelChangedPayload,
): ProtectionLevelChangedEvent {
    return {
        previousLevel: payload.previousLevel,
        level: payload.level,
        version: payload.version,
        signedAssertion: toBase64Bytes(payload.signedAssertion),
        changedByDeviceId: payload.changedByDeviceId ?? null,
        // Same rule as `signedByOutgoingKey`: an unstated verdict on a security-relevant change is
        // taken as the alarming one, so a dropped field cannot silence the notice.
        isDowngrade: payload.isDowngrade !== false,
        changedAt: payload.changedAt,
    };
}

/**
 * The `identity.*` events: what other devices on this account did, and what it invalidates here.
 *
 * <p><b>None of these mutate crypto state.</b> Every one of them is a statement by the server about
 * something that happened elsewhere, and the local consequence is always either an ordered fetch of
 * authoritative state or a notice to the user - never a write to the group registry, the keychain or
 * the master-key envelope. That is the same rule `MessagingWebsocketService` follows for
 * `conversation.MlsCommit`, and for the same reason: applying a change in push-arrival order forks
 * this device from the group permanently, and there is no push a client can trust enough to be the
 * sole basis for re-keying an account.</p>
 *
 * <p><b>No two of these describe the same thing, and none of them may be assumed to arrive
 * together.</b> They come from four unrelated call sites - `MlsDeviceEndpoint` (POST /devices),
 * `AccountIdentityKeyEndpoint` (PUT /users/identity-key), `MlsGroupService` and the backup read - and
 * nothing sequences them. This was got wrong once, in the direction that costs the most: a device
 * re-registering under a new signing key was recorded silently on the belief that
 * `identity.AccountIdentityKeyRotated` would announce the same rotation. It never does; the two are
 * different keys changed by different requests, and the result was the one security event on this
 * service that reached the user as nothing at all. Every handler below therefore stands on its own
 * payload, with its own wording, and no handler is quiet because another one is expected.</p>
 *
 * <p>Registered in the constructor of a root singleton, exactly once.
 * {@link RealtimeConnectionService.on} does not deduplicate, so a second registration would deliver
 * every security notice twice - and a duplicated "your key backup was read" is not a cosmetic
 * bug.</p>
 */
@Injectable({providedIn: 'root'})
export class IdentityWebsocketService {
    // ── Event streams ───────────────────────────────────────────────────────
    /** A device was registered against this account. */
    readonly deviceRegistered$ = new Subject<DeviceRegisteredEvent>();
    /** A device was admitted to a context's MLS group. */
    readonly deviceAdmitted$ = new Subject<DeviceAdmittedEvent>();
    /** The account identity key was replaced. */
    readonly accountIdentityKeyRotated$ = new Subject<AccountIdentityKeyRotatedEvent>();
    /** The account protection level changed. */
    readonly protectionLevelChanged$ = new Subject<ProtectionLevelChangedEvent>();
    /** Somebody read a device's encrypted key backup. */
    readonly backupRead$ = new Subject<BackupReadEvent>();

    /**
     * The account's registered-device set changed and any list of it is stale.
     *
     * <p>An event rather than the data: the push names one device, and a surface that patched its
     * list from it would be reconciling a partial view against a server-owned one. The list is
     * re-read instead, which is the same trade `InboxService` makes on `ReadStateChanged`.</p>
     */
    readonly deviceRosterChanged$ = new Subject<void>();

    // ── State ───────────────────────────────────────────────────────────────
    /** Bumped with every {@link deviceRosterChanged$}, for surfaces that would rather `effect`. */
    readonly deviceRosterRevision = signal(0);

    private readonly _lastIdentityKeyRotation = signal<AccountIdentityKeyRotatedEvent | null>(null);
    private readonly _identityKeyStale = signal(false);
    private readonly _protectionLevel = signal<ProtectionLevelChangedEvent | null>(null);
    private readonly _backupReads = signal<BackupReadEvent[]>([]);
    private readonly _deviceIdentityRotations = signal<DeviceRegisteredEvent[]>([]);

    /** The last rotation this device was told about, with its details. */
    readonly lastIdentityKeyRotation = this._lastIdentityKeyRotation.asReadonly();

    /**
     * True once the server has said the <b>account</b> identity key moved past what this device
     * holds - which only `identity.AccountIdentityKeyRotated` can say.
     *
     * <p>Deliberately has no way to be cleared. Alpine never mints or fetches an account identity
     * key - it only carries one through the §D backup envelope - so nothing that happens in this
     * process makes the stored copy current again, and a dismiss button would be a way to hide a
     * real staleness rather than to fix it.</p>
     *
     * <p>And deliberately <b>not</b> set from `identity.DeviceRegistered`. A device rotating its own
     * signing key leaves the account key untouched, so raising this from it would light a permanent,
     * unclearable warning about the §D envelope on a path that says nothing about it - and the
     * commonest cause of that push is another device's ordinary keychain miss. See
     * {@link deviceIdentityRotations} for what that event does mean.</p>
     */
    readonly identityKeyStale = this._identityKeyStale.asReadonly();

    /** The last protection-level change pushed, or null if none has been this session. */
    readonly protectionLevel = this._protectionLevel.asReadonly();

    /** The level the server last named, for a surface that only wants the string. */
    readonly protectionLevelName = computed(() => this._protectionLevel()?.level ?? null);

    /** Key-backup reads seen this session, newest first. */
    readonly backupReads = this._backupReads.asReadonly();

    /** Reads that were not performed by this installation - the ones worth explaining. */
    readonly foreignBackupReads = computed(() => this._backupReads().filter(read => !read.readByThisDevice));

    /**
     * Devices seen re-registering under a new signing key this session, newest first.
     *
     * <p>Each of these is a device whose leaf in every encrypted context is now unsignable and whose
     * key packages are gone, so a device list that shows it as healthy is wrong until it has been
     * re-admitted. Kept as the events rather than as a flag because, unlike
     * {@link identityKeyStale}, this is per device and does resolve - the device comes back.</p>
     */
    readonly deviceIdentityRotations = this._deviceIdentityRotations.asReadonly();

    private readonly realtime = inject(RealtimeConnectionService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    /**
     * Resolved on demand, not as fields.
     *
     * <p>This service is constructed at bootstrap so it can hear a security event that arrives
     * before anything relevant is on screen. Injecting the MLS stack and the backup HTTP client
     * eagerly would drag the Tauri engine and `OAuthService` into that moment - the same trap
     * {@link DeviceIdentityService} documents, where a pure adapter's tests suddenly needed an OAuth
     * provider. Nothing below is touched until an event actually names it.</p>
     */
    private readonly injector = inject(Injector);

    /** This installation's device id. Resolved once; a failure is retried on the next event. */
    private ownDeviceId: Promise<string | null> | null = null;

    constructor() {
        this.realtime.on(
            'identity.DeviceRegistered',
            (d: DeviceRegisteredPayload) =>
                void this.onDeviceRegistered(d).catch(logHandlerError('identity.DeviceRegistered')),
        );

        this.realtime.on(
            'identity.DeviceAdmitted',
            (d: DeviceAdmittedPayload) =>
                void this.onDeviceAdmitted(d).catch(logHandlerError('identity.DeviceAdmitted')),
        );

        this.realtime.on('identity.AccountIdentityKeyRotated', (d: AccountIdentityKeyRotatedPayload) =>
            this.onAccountIdentityKeyRotated(d),
        );

        this.realtime.on(
            'identity.ProtectionLevelChanged',
            (d: ProtectionLevelChangedPayload) =>
                void this.onProtectionLevelChanged(d).catch(
                    logHandlerError('identity.ProtectionLevelChanged'),
                ),
        );

        this.realtime.on(
            'identity.BackupRead',
            (d: BackupReadPayload) => void this.onBackupRead(d).catch(logHandlerError('identity.BackupRead')),
        );
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    /**
     * A device was registered, or an existing one re-registered under a new signing key.
     *
     * <p>The plain registration is a roster change and nothing more: the server cannot admit the new
     * device to anything - only a member's client can produce an Add commit - so the whole local
     * consequence is that any list of the account's devices is now out of date.</p>
     *
     * <p>A <b>rotated</b> re-registration is a security event and gets said out loud. It was
     * previously recorded in silence on the belief that `identity.AccountIdentityKeyRotated` would
     * cover the same rotation; the two come from different endpoints and describe different keys
     * (see {@link DeviceRegisteredEvent.identityRotated}), so nothing covered it and the user was
     * told nothing. The copy is this event's own for the same reason - "your account identity key
     * changed" would send someone to re-verify fingerprints when what they need to do is check that
     * they recognise a device that just re-appeared with a new key.</p>
     *
     * <p>Not announced when it is this installation, on the {@link onBackupRead} rule: the user is
     * looking at the screen that caused it, and an unresolvable device id counts as foreign so the
     * failure mode is an extra notice rather than a missing one.</p>
     */
    private async onDeviceRegistered(payload: DeviceRegisteredPayload): Promise<void> {
        const event: DeviceRegisteredEvent = {
            deviceId: payload.deviceId,
            deviceName: payload.deviceName,
            // Fails toward the alarming answer, like every other boolean here: a payload that lost
            // the flag must not turn a re-key into a routine registration.
            identityRotated: payload.identityRotated !== false,
            isOwnDevice: payload.deviceId === (await this.resolveOwnDeviceId()),
        };

        // Recorded before the fan-out so a subscriber that reads the signal sees the same account
        // state the event describes.
        if (event.identityRotated) {
            this._deviceIdentityRotations.update(rotations =>
                [event, ...rotations].slice(0, MAX_RETAINED_SECURITY_EVENTS),
            );
        }

        this.deviceRegistered$.next(event);
        this.bumpDeviceRoster();

        if (!event.identityRotated || event.isOwnDevice) return;

        this.toast.warn(this.translate.instant('IDENTITY.SECURITY.DEVICE_IDENTITY_ROTATED'), {
            detail: this.translate.instant('IDENTITY.SECURITY.DEVICE_IDENTITY_ROTATED_DETAIL', {
                device: event.deviceName,
            }),
            sticky: true,
        });
    }

    /**
     * A leaf was added to a group. Prompts an ordered catch-up, and nothing else.
     *
     * <p>The push carries a generation and a fingerprint but no commit, which is the same design as
     * `conversation.MlsCommit` and for the same reason - the membership change is only real once it
     * has been fetched and applied in epoch order. {@link MlsSyncService.syncContext} is the only
     * thing that advances group state here; it queues per context, so arriving alongside the
     * `conversation.*` push for the same commit costs a no-op rather than a race.</p>
     *
     * <p>When the admitted leaf is <b>this</b> device, the catch-up is preceded by a Welcome sweep.
     * The admission is what caused a member's client to mint a Welcome addressed to us, and until
     * that is taken this device holds no group for the context at all - so `syncContext` would find
     * nothing to catch up and return, leaving the §G ceremony finished on the server and invisible
     * here until the next launch.</p>
     */
    private async onDeviceAdmitted(payload: DeviceAdmittedPayload): Promise<void> {
        const event: DeviceAdmittedEvent = {
            ...toContextEvent(payload),
            userId: payload.userId,
            deviceId: payload.deviceId,
            signatureKeyFingerprint: payload.signatureKeyFingerprint,
            // `=== true` here read "a human approved it" out of a dropped field, on the one event the
            // server only ever sends when none did. Same rule as everywhere else: unstated is the
            // alarming answer.
            autoAdmitted: payload.autoAdmitted !== false,
            isOwnDevice: payload.deviceId === (await this.resolveOwnDeviceId()),
        };

        this.deviceAdmitted$.next(event);

        // Deliberately does not bump the device roster: admission is to an MLS group, not to the
        // account, so the registered-device list is exactly as current as it was a moment ago.
        if (!event.contextId) return;

        // No signing key loaded means no group to catch up and no Welcome that could be opened.
        // Asking anyway would be a request per admission for a device that cannot use the answer.
        if (!this.injector.get(MlsService).keyHandle()) return;

        const sync = this.injector.get(MlsSyncService);

        if (event.isOwnDevice) {
            try {
                await sync.processPendingWelcomes();
            } catch (err) {
                console.error(
                    'Failed to take the Welcome for an admission of this device',
                    event.contextId,
                    err,
                );
            }
        }

        try {
            await sync.syncContext(event.contextId, event.isChannel);
        } catch (err) {
            console.error('Failed to catch up after a device admission', event.contextId, err);
        }
    }

    /**
     * The account identity key was replaced by another device - or published for the first time,
     * which arrives on the same event and is told apart on {@link AccountIdentityKeyRotatedEvent
     * .isFirstPublication}.
     *
     * <p>Records and reports. The stored copy of the keypair is left exactly as it is: replacing it
     * would need the new private half, which only the device that performed the rotation holds, and
     * deleting it would destroy the only copy this installation has of a key it is required to carry
     * through the §D export unchanged.</p>
     */
    private onAccountIdentityKeyRotated(payload: AccountIdentityKeyRotatedPayload): void {
        const event = toAccountIdentityKeyRotatedEvent(payload);

        this._lastIdentityKeyRotation.set(event);
        this._identityKeyStale.set(true);
        this.accountIdentityKeyRotated$.next(event);

        // The device rows carry `identityPublicKey`, so every list of them now shows a key the
        // account has moved past.
        this.bumpDeviceRoster();

        // A first publication is not a rotation and must not be described as one: there was no
        // outgoing key, so `signedByOutgoingKey` is false for a reason that has nothing to do with
        // continuity, and the unsigned copy would tell the user to distrust a fingerprint they have
        // never seen. Just as serious - whoever publishes first is who every peer pins - and said so.
        this.toast.warn(
            this.translate.instant(
                event.isFirstPublication
                    ? 'IDENTITY.SECURITY.IDENTITY_KEY_PUBLISHED'
                    : 'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED',
            ),
            {
                detail: this.translate.instant(
                    event.isFirstPublication
                        ? 'IDENTITY.SECURITY.IDENTITY_KEY_PUBLISHED_DETAIL'
                        : event.signedByOutgoingKey
                          ? 'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED_DETAIL'
                          : 'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED_UNSIGNED_DETAIL',
                    {version: event.version},
                ),
                sticky: true,
            },
        );
    }

    /**
     * Protection level moved. Re-reads the master-key envelope so the surface that acts on it
     * catches up without a restart.
     *
     * <p>The pushed level is kept for display and the authoritative state comes from
     * {@link MasterKeyStateService.refresh}, which is a read of the account envelope. Setting
     * `MasterKeyStateService`'s verdict from this payload instead would let a push decide whether
     * the account's backups are recoverable, which is the one question that must always be answered
     * by asking.</p>
     */
    private async onProtectionLevelChanged(payload: ProtectionLevelChangedPayload): Promise<void> {
        const event = toProtectionLevelChangedEvent(payload);

        this._protectionLevel.set(event);
        this.protectionLevelChanged$.next(event);

        if (event.isDowngrade) {
            this.toast.warn(this.translate.instant('IDENTITY.SECURITY.PROTECTION_DOWNGRADED'), {
                detail: this.translate.instant('IDENTITY.SECURITY.PROTECTION_DOWNGRADED_DETAIL', {
                    previous: event.previousLevel,
                    level: event.level,
                }),
                sticky: true,
            });
        }

        try {
            await this.injector.get(MasterKeyStateService).refresh();
        } catch (err) {
            // `refresh` already keeps the previous verdict standing on a failed read, so the worst
            // case is a stale surface rather than a wrong one.
            console.error('Could not re-read master key state after a protection level change', err);
        }
    }

    /**
     * Somebody read a device's encrypted key backup.
     *
     * <p>Announced rather than logged. The blob is the account's whole ratchet state for that
     * device, and a read of it by something that is not its owner is the single most useful signal
     * this client gets that an account has been taken over - a console line ships to nobody.</p>
     *
     * <p>The one read that does not raise a notice is this installation reading its own backup,
     * which is what {@link KeyBackupRestoreComponent} does on the restore path: the user is looking
     * at the screen that caused it. It is still recorded and still on {@link backupRead$}, so it is
     * surfaced, not swallowed. An unattributed read - `readByDeviceId` null - always raises one,
     * because "we do not know who read it" is strictly more alarming than knowing.</p>
     */
    private async onBackupRead(payload: BackupReadPayload): Promise<void> {
        const own = await this.resolveOwnDeviceId();
        const event: BackupReadEvent = {
            deviceId: payload.deviceId,
            deviceName: payload.deviceName,
            readByDeviceId: payload.readByDeviceId ?? null,
            readAt: payload.readAt,
            readByThisDevice: !!own && payload.readByDeviceId === own,
        };

        this._backupReads.update(reads => [event, ...reads].slice(0, MAX_RETAINED_SECURITY_EVENTS));
        this.backupRead$.next(event);

        if (event.readByThisDevice) return;

        this.toast.warn(this.translate.instant('IDENTITY.SECURITY.BACKUP_READ'), {
            detail: this.translate.instant(
                event.readByDeviceId
                    ? 'IDENTITY.SECURITY.BACKUP_READ_DETAIL'
                    : 'IDENTITY.SECURITY.BACKUP_READ_UNATTRIBUTED_DETAIL',
                {device: event.deviceName},
            ),
            sticky: true,
        });
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private bumpDeviceRoster(): void {
        this.deviceRosterRevision.update(revision => revision + 1);
        this.deviceRosterChanged$.next();
    }

    /**
     * @returns this installation's device id, or null when it could not be resolved.
     *
     * <p>A failure is not cached. Every "is this us?" decision here only ever widens what the user
     * is told - an unresolvable id means a self-read is announced as a foreign one - so retrying is
     * cheap and being permanently wrong in the quiet direction is not acceptable.</p>
     */
    private resolveOwnDeviceId(): Promise<string | null> {
        return (this.ownDeviceId ??= this.deviceIdentity.deviceId().catch((err: unknown) => {
            console.error('Identity events: could not resolve this device id', err);
            this.ownDeviceId = null;
            return null;
        }));
    }
}

function logHandlerError(event: string): (err: unknown) => void {
    return err => console.error(`Failed to handle ${event}`, err);
}
