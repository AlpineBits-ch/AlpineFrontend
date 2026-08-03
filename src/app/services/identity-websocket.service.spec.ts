/**
 * The `identity.*` events: what another device on this account did, and what this one is allowed
 * to do about it.
 *
 * <p>Three properties are asserted throughout, because they are the ones that would be quietly lost
 * in a refactor. Nothing here writes group state - the only MLS calls a push may make are the
 * ordered fetch and the Welcome sweep, both of which are reads. Nothing security-relevant is
 * silenced by a missing field: every boolean fails towards the alarming answer, so a payload that
 * lost one cannot turn a warning into silence. And no handler is quiet on the assumption that
 * another event covers it - the `identityRotated` case below is there because exactly that
 * assumption was made and was false.</p>
 */
import {TestBed} from '@angular/core/testing';
import {
    BackupReadEvent,
    DeviceAdmittedEvent,
    IdentityWebsocketService,
    toBase64Bytes,
} from './identity-websocket.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {DeviceIdentityService} from './device-identity.service';
import {ToastService} from './toast.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MasterKeyStateService} from './master-key-state.service';
import {TranslateService} from '@ngx-translate/core';

const OWN_DEVICE = 'device-a';
const OTHER_DEVICE = 'device-b';
const CTX = 'conv-1';

/** Lets the awaits inside a fire-and-forget handler settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(options: {keyHandle?: string | null} = {}) {
    // `?? 'handle'` would defeat the point: `null` is the state under test.
    const keyHandle = 'keyHandle' in options ? options.keyHandle ?? null : 'handle';
    const handlers = new Map<string, (payload: never) => void>();
    const registered: string[] = [];

    const sync = {
        processPendingWelcomes: vi.fn(async () => undefined),
        syncContext: vi.fn(async (_contextId: string, _isChannel: boolean) => undefined),
    };
    const masterKeyState = {refresh: vi.fn(async () => 'ok' as const)};
    const toast = {warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), httpError: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            IdentityWebsocketService,
            {
                provide: RealtimeConnectionService, useValue: {
                    on: vi.fn((event: string, handler: (payload: never) => void) => {
                        registered.push(event);
                        handlers.set(event, handler);
                    }),
                },
            },
            {provide: DeviceIdentityService, useValue: {deviceId: async () => OWN_DEVICE}},
            {provide: ToastService, useValue: toast},
            {
                provide: MlsService,
                useValue: {keyHandle: () => keyHandle},
            },
            {provide: MlsSyncService, useValue: sync},
            {provide: MasterKeyStateService, useValue: masterKeyState},
            {
                provide: TranslateService,
                // Returns the key, so an assertion can name the string the user is shown without
                // depending on the locale submodule.
                useValue: {instant: (key: string) => key},
            },
        ],
    });

    const service = TestBed.inject(IdentityWebsocketService);
    const fire = async (event: string, payload: unknown) => {
        handlers.get(event)!(payload as never);
        await flush();
    };

    return {service, handlers, registered, sync, masterKeyState, toast, fire};
}

describe('toBase64Bytes', () => {
    it('passes a base64 string through, which is what System.Text.Json actually sends', () => {
        expect(toBase64Bytes('YWJj')).toBe('YWJj');
    });

    it('encodes the number-array shape rather than dropping the bytes', () => {
        expect(toBase64Bytes([97, 98, 99])).toBe('YWJj');
    });

    it('is null for an absent value, not an empty string that would render as "supplied"', () => {
        expect(toBase64Bytes(null)).toBeNull();
        expect(toBase64Bytes(undefined)).toBeNull();
    });
});

describe('IdentityWebsocketService registration', () => {
    it('registers all five identity events exactly once', () => {
        const {registered} = setup();

        expect(registered).toEqual([
            'identity.DeviceRegistered',
            'identity.DeviceAdmitted',
            'identity.AccountIdentityKeyRotated',
            'identity.ProtectionLevelChanged',
            'identity.BackupRead',
        ]);
        // `on` does not deduplicate, so a duplicate registration would double every notice.
        expect(new Set(registered).size).toBe(registered.length);
    });
});

describe('identity.DeviceRegistered', () => {
    it('re-reads the device roster rather than patching it from the push', async () => {
        const {service, fire} = setup();
        let changes = 0;
        service.deviceRosterChanged$.subscribe(() => changes++);

        await fire('identity.DeviceRegistered',
            {deviceId: OTHER_DEVICE, deviceName: 'Laptop', identityRotated: false});

        expect(changes).toBe(1);
        expect(service.deviceRosterRevision()).toBe(1);
    });

    // The regression this file exists to stop. `identity.AccountIdentityKeyRotated` comes from a
    // different endpoint and is not emitted for this, so anything that stops warning here stops
    // warning at all.
    it('warns, stickily and in its own words, when a device re-registered under a new key', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.DeviceRegistered',
            {deviceId: OTHER_DEVICE, deviceName: 'Laptop', identityRotated: true});

        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.DEVICE_IDENTITY_ROTATED',
            expect.objectContaining({
                detail: 'IDENTITY.SECURITY.DEVICE_IDENTITY_ROTATED_DETAIL',
                sticky: true,
            }),
        );
        expect(service.deviceIdentityRotations().length).toBe(1);
        expect(service.deviceIdentityRotations()[0].deviceId).toBe(OTHER_DEVICE);
    });

    it('does not borrow the account-key wording for a device key', async () => {
        const {toast, fire} = setup();

        await fire('identity.DeviceRegistered',
            {deviceId: OTHER_DEVICE, deviceName: 'Laptop', identityRotated: true});

        // Different keys, different endpoints, different remedies - a user shown "re-verify your
        // fingerprints" for this cannot act on it.
        expect(toast.warn).not.toHaveBeenCalledWith(
            'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED', expect.anything());
    });

    it('leaves the account identity key alone - that is a different key on a different endpoint',
        async () => {
            const {service, fire} = setup();

            await fire('identity.DeviceRegistered',
                {deviceId: OTHER_DEVICE, deviceName: 'Laptop', identityRotated: true});

            // `identityKeyStale` has no way to be cleared, so setting it from a device's own key
            // rotation would be a permanent false alarm about the §D envelope.
            expect(service.identityKeyStale()).toBe(false);
        });

    it('stays quiet when the re-registration was this installation', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.DeviceRegistered',
            {deviceId: OWN_DEVICE, deviceName: 'This', identityRotated: true});

        // Recorded, not shouted - the user is on the screen that caused it.
        expect(toast.warn).not.toHaveBeenCalled();
        expect(service.deviceIdentityRotations().length).toBe(1);
    });

    it('treats a missing identityRotated as a rotation rather than a plain registration', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.DeviceRegistered', {deviceId: OTHER_DEVICE, deviceName: 'Laptop'});

        expect(service.deviceIdentityRotations().length).toBe(1);
        expect(toast.warn).toHaveBeenCalled();
    });

    it('says nothing about an ordinary registration', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.DeviceRegistered',
            {deviceId: OTHER_DEVICE, deviceName: 'Laptop', identityRotated: false});

        expect(toast.warn).not.toHaveBeenCalled();
        expect(service.deviceIdentityRotations().length).toBe(0);
    });

    it('knows its own registration from another machine\'s', async () => {
        const {service, fire} = setup();
        const seen: boolean[] = [];
        service.deviceRegistered$.subscribe(e => seen.push(e.isOwnDevice));

        await fire('identity.DeviceRegistered',
            {deviceId: OWN_DEVICE, deviceName: 'This', identityRotated: false});
        await fire('identity.DeviceRegistered',
            {deviceId: OTHER_DEVICE, deviceName: 'That', identityRotated: false});

        expect(seen).toEqual([true, false]);
    });
});

describe('identity.DeviceAdmitted', () => {
    const admitted = (overrides: Record<string, unknown> = {}) => ({
        contextId: CTX,
        conversationId: CTX,
        channelId: null,
        generation: 3,
        userId: 'user-1',
        deviceId: OTHER_DEVICE,
        signatureKeyFingerprint: 'FP',
        autoAdmitted: false,
        ...overrides,
    });

    it('prompts the ordered fetch and never applies anything itself', async () => {
        const {sync, fire} = setup();

        await fire('identity.DeviceAdmitted', admitted());

        expect(sync.syncContext).toHaveBeenCalledWith(CTX, false);
        // Not our device, so there is no Welcome addressed here to take.
        expect(sync.processPendingWelcomes).not.toHaveBeenCalled();
    });

    it('takes the Welcome first when the admitted leaf is this device', async () => {
        const {sync, fire} = setup();

        await fire('identity.DeviceAdmitted', admitted({deviceId: OWN_DEVICE}));

        expect(sync.processPendingWelcomes).toHaveBeenCalled();
        expect(sync.syncContext).toHaveBeenCalledWith(CTX, false);
        // Order is load-bearing: without the Welcome this device holds no group, so the catch-up
        // would find nothing and return.
        expect(sync.processPendingWelcomes.mock.invocationCallOrder[0])
            .toBeLessThan(sync.syncContext.mock.invocationCallOrder[0]);
    });

    it('takes the context kind from which id came with it', async () => {
        const {sync, fire} = setup();

        await fire('identity.DeviceAdmitted',
            admitted({contextId: 'chan-1', conversationId: null, channelId: 'chan-1'}));

        expect(sync.syncContext).toHaveBeenCalledWith('chan-1', true);
    });

    it('does nothing over the network while the MLS session is locked', async () => {
        const {sync, fire} = setup({keyHandle: null});

        await fire('identity.DeviceAdmitted', admitted({deviceId: OWN_DEVICE}));

        expect(sync.processPendingWelcomes).not.toHaveBeenCalled();
        expect(sync.syncContext).not.toHaveBeenCalled();
    });

    it('does not touch the device roster - admission is to a group, not to the account', async () => {
        const {service, fire} = setup();

        await fire('identity.DeviceAdmitted', admitted());

        expect(service.deviceRosterRevision()).toBe(0);
    });

    it('re-emits the fingerprint a human is meant to compare', async () => {
        const {service, fire} = setup();
        const seen: DeviceAdmittedEvent[] = [];
        service.deviceAdmitted$.subscribe(e => seen.push(e));

        await fire('identity.DeviceAdmitted', admitted({autoAdmitted: true}));

        expect(seen[0].signatureKeyFingerprint).toBe('FP');
        expect(seen[0].autoAdmitted).toBe(true);
        expect(seen[0].generation).toBe(3);
    });

    it('reads a missing autoAdmitted as "nobody reviewed this"', async () => {
        const {service, fire} = setup();
        const seen: DeviceAdmittedEvent[] = [];
        service.deviceAdmitted$.subscribe(e => seen.push(e));

        await fire('identity.DeviceAdmitted', admitted({autoAdmitted: undefined}));

        // The server only pushes this event for admissions no human approved, so defaulting the
        // flag to false would invent a review that never happened.
        expect(seen[0].autoAdmitted).toBe(true);
    });
});

describe('identity.AccountIdentityKeyRotated', () => {
    const rotated = (overrides: Record<string, unknown> = {}) => ({
        previousVersion: 1,
        version: 2,
        publicKey: 'cHVi',
        signedByOutgoingKey: true,
        changedByDeviceId: OTHER_DEVICE,
        rotatedAt: '2026-08-03T10:00:00Z',
        ...overrides,
    });

    it('records the rotation and marks everything bound to the old key stale', async () => {
        const {service, fire} = setup();

        await fire('identity.AccountIdentityKeyRotated', rotated());

        expect(service.identityKeyStale()).toBe(true);
        expect(service.lastIdentityKeyRotation()?.version).toBe(2);
        expect(service.lastIdentityKeyRotation()?.publicKey).toBe('cHVi');
        // Device rows advertise `identityPublicKey`, so any list of them is now out of date.
        expect(service.deviceRosterRevision()).toBe(1);
    });

    it('treats a missing signedByOutgoingKey as unchained, not as chained', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.AccountIdentityKeyRotated', rotated({signedByOutgoingKey: undefined}));

        expect(service.lastIdentityKeyRotation()?.signedByOutgoingKey).toBe(false);
        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED',
            expect.objectContaining({detail: 'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED_UNSIGNED_DETAIL'}),
        );
    });

    it('uses the ordinary wording when the rotation was chained to the outgoing key', async () => {
        const {toast, fire} = setup();

        await fire('identity.AccountIdentityKeyRotated', rotated());

        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED',
            expect.objectContaining({detail: 'IDENTITY.SECURITY.IDENTITY_KEY_ROTATED_DETAIL'}),
        );
    });

    it('calls a first publication what it is instead of an unsigned rotation', async () => {
        const {service, toast, fire} = setup();

        // The hub handler drops the bus event's `isFirstPublication`, so v0 -> v1 with no rotation
        // signature is what the wire actually carries for a first publication - and it is exactly
        // the shape that used to render as "the key you pinned was replaced, and unverifiably".
        await fire('identity.AccountIdentityKeyRotated',
            rotated({previousVersion: 0, version: 1, signedByOutgoingKey: false}));

        expect(service.lastIdentityKeyRotation()?.isFirstPublication).toBe(true);
        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.IDENTITY_KEY_PUBLISHED',
            expect.objectContaining({
                detail: 'IDENTITY.SECURITY.IDENTITY_KEY_PUBLISHED_DETAIL',
                sticky: true,
            }),
        );
    });

    it('prefers the server\'s own isFirstPublication once it sends one', async () => {
        const {service, fire} = setup();

        await fire('identity.AccountIdentityKeyRotated',
            rotated({previousVersion: 0, version: 1, isFirstPublication: false}));

        expect(service.lastIdentityKeyRotation()?.isFirstPublication).toBe(false);
    });
});

describe('identity.ProtectionLevelChanged', () => {
    const changed = (overrides: Record<string, unknown> = {}) => ({
        previousLevel: 'Standard',
        level: 'Enhanced',
        version: 4,
        signedAssertion: [1, 2, 3],
        changedByDeviceId: OTHER_DEVICE,
        isDowngrade: false,
        changedAt: '2026-08-03T10:00:00Z',
        ...overrides,
    });

    it('re-reads the master key envelope so its surface catches up without a restart', async () => {
        const {service, masterKeyState, fire} = setup();

        await fire('identity.ProtectionLevelChanged', changed());

        expect(masterKeyState.refresh).toHaveBeenCalled();
        expect(service.protectionLevelName()).toBe('Enhanced');
        // Carried, not verified - there is no §G verifying surface on this client.
        expect(service.protectionLevel()?.signedAssertion).toBe('AQID');
    });

    it('warns on a downgrade', async () => {
        const {toast, fire} = setup();

        await fire('identity.ProtectionLevelChanged',
            changed({previousLevel: 'Enhanced', level: 'Standard', isDowngrade: true}));

        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.PROTECTION_DOWNGRADED',
            expect.objectContaining({sticky: true}),
        );
    });

    it('treats a missing isDowngrade as a downgrade rather than staying silent', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.ProtectionLevelChanged', changed({isDowngrade: undefined}));

        expect(service.protectionLevel()?.isDowngrade).toBe(true);
        expect(toast.warn).toHaveBeenCalled();
    });

    it('does not warn when protection went up', async () => {
        const {toast, fire} = setup();

        await fire('identity.ProtectionLevelChanged', changed());

        expect(toast.warn).not.toHaveBeenCalled();
    });
});

describe('identity.BackupRead', () => {
    const read = (overrides: Record<string, unknown> = {}) => ({
        deviceId: OTHER_DEVICE,
        deviceName: 'Old laptop',
        readByDeviceId: OTHER_DEVICE,
        readAt: '2026-08-03T10:00:00Z',
        ...overrides,
    });

    it('announces a read performed by another device', async () => {
        const {service, toast, fire} = setup();

        await fire('identity.BackupRead', read());

        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.BACKUP_READ',
            expect.objectContaining({
                detail: 'IDENTITY.SECURITY.BACKUP_READ_DETAIL',
                sticky: true,
            }),
        );
        expect(service.foreignBackupReads().length).toBe(1);
    });

    it('always announces a read the server did not attribute', async () => {
        const {toast, fire} = setup();

        await fire('identity.BackupRead', read({readByDeviceId: null}));

        expect(toast.warn).toHaveBeenCalledWith(
            'IDENTITY.SECURITY.BACKUP_READ',
            expect.objectContaining({detail: 'IDENTITY.SECURITY.BACKUP_READ_UNATTRIBUTED_DETAIL'}),
        );
    });

    it('records this device reading its own backup without alarming about it', async () => {
        const {service, toast, fire} = setup();
        const seen: BackupReadEvent[] = [];
        service.backupRead$.subscribe(e => seen.push(e));

        await fire('identity.BackupRead', read({readByDeviceId: OWN_DEVICE}));

        // Surfaced, not swallowed: it is on the stream and in the list, just not shouted about.
        expect(seen.length).toBe(1);
        expect(service.backupReads().length).toBe(1);
        expect(service.foreignBackupReads().length).toBe(0);
        expect(toast.warn).not.toHaveBeenCalled();
    });

    it('keeps the newest reads first and bounds the list', async () => {
        const {service, fire} = setup();

        for (let i = 0; i < 25; i++) {
            await fire('identity.BackupRead', read({deviceName: `dev-${i}`}));
        }

        expect(service.backupReads().length).toBe(20);
        expect(service.backupReads()[0].deviceName).toBe('dev-24');
    });
});
