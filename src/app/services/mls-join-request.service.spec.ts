import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {of} from 'rxjs';
import {MlsJoinRequestDto, MlsJoinRequestService} from './mls-join-request.service';
import {ApiConfigService} from './api-config.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {DeviceIdentityService} from './device-identity.service';

const ORIGIN = 'https://api.test.example';
const CONVERSATION = 'conv-1';
const CHANNEL = 'chan-1';
const DEVICE_ID = 'device-a';

const CONVERSATION_BASE = `${ORIGIN}/api/v1/messaging/conversations/${CONVERSATION}/mls/join-requests`;
const CHANNEL_BASE = `${ORIGIN}/api/v1/messaging/channels/${CHANNEL}/mls/join-requests`;

function pendingRequest(overrides: Partial<MlsJoinRequestDto> = {}): MlsJoinRequestDto {
    return {
        id: 'req-1',
        contextId: CONVERSATION,
        conversationId: CONVERSATION,
        generation: 1,
        requesterUserId: 'user-a',
        requesterDeviceId: DEVICE_ID,
        keyPackageHash: 'hash',
        signatureKeyFingerprint: 'ABCDE-FGHIJ',
        state: 'Pending',
        createdAt: '2026-08-02T00:00:00.000Z',
        expiresAt: '2026-08-03T00:00:00.000Z',
        requiredApprovals: 1,
        approverUserIds: [],
        ...overrides,
    };
}

/** The two facts `relink` branches on: whether the server calls the context encrypted, and whether we hold a group. */
function setup(options: {
    encrypted?: boolean;
    /** Group id this device holds *after* `refreshState` has run, or null for "no leaf". */
    groupAfterRefresh?: string | null;
    floor?: number | null;
    refreshRejects?: unknown;
    locked?: boolean;
} = {}) {
    const {
        encrypted = true,
        groupAfterRefresh = null,
        floor = null,
        refreshRejects,
        locked = false,
    } = options;

    const refreshState = vi.fn(async () => {
        if (refreshRejects) throw refreshRejects;
        return {encrypted, activeGeneration: encrypted ? 1 : null} as never;
    });

    const mls = {
        keyHandle: () => (locked ? undefined : 'handle'),
        getActiveGroupId: vi.fn(async () => groupAfterRefresh),
        getEncryptionFloor: vi.fn(async () => floor),
        generateAdditionalKeyPackages: vi.fn(() =>
            of([{keyPackage: 'a2V5', initPrivateKey: 'cHJpdg=='}])),
        inspectKeyPackage: vi.fn(() => of({
            identity: 'user-a',
            signaturePublicKey: 'cHVi',
            signatureKeyFingerprint: 'ABCDE-FGHIJ',
            keyPackageHash: 'hash',
        })),
    };

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => ORIGIN}},
            {provide: MlsService, useValue: mls},
            {provide: MlsSyncService, useValue: {refreshState, publish: vi.fn()}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => DEVICE_ID}},
        ],
    });

    return {
        service: TestBed.inject(MlsJoinRequestService),
        health: TestBed.inject(MlsHealthService),
        ctrl: TestBed.inject(HttpTestingController),
        refreshState,
        mls,
    };
}

// `setup` configures a module per test, so the previous one has to be torn down first.
beforeEach(() => TestBed.resetTestingModule());

describe('MlsJoinRequestService route shape', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('lists a conversation queue from the conversation route, not the channel one', () => {
        const {service, ctrl} = setup();
        service.list(CONVERSATION, false).subscribe();
        ctrl.expectOne(CONVERSATION_BASE).flush([]);
    });

    it('lists a channel queue from the channel route', () => {
        const {service, ctrl} = setup();
        service.list(CHANNEL, true).subscribe();
        ctrl.expectOne(CHANNEL_BASE).flush([]);
    });
});

describe('MlsJoinRequestService.relink', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('reports recovery without asking to be admitted when refreshing found a leaf', async () => {
        const {service, ctrl, refreshState} = setup({groupAfterRefresh: 'Z3JvdXA='});

        await expect(service.relink(CONVERSATION, false)).resolves.toEqual({state: 'recovered'});

        expect(refreshState).toHaveBeenCalledWith(CONVERSATION, false);
        // Nothing submitted: this device is in the group, so there is nothing to ask for.
        ctrl.expectNone(CONVERSATION_BASE);
    });

    it('submits an admission request when this device holds no leaf', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const outcome = service.relink(CONVERSATION, false);

        // Its own outstanding request is looked up first, so the UI can say "already asked".
        const list = await waitForRequest(ctrl, CONVERSATION_BASE, 'GET');
        list.flush([]);

        const submit = await waitForRequest(ctrl, CONVERSATION_BASE, 'POST');
        expect(submit.request.body).toMatchObject({
            keyPackage: 'a2V5',
            deviceId: DEVICE_ID,
            signatureKeyFingerprint: 'ABCDE-FGHIJ',
        });
        submit.flush(pendingRequest());

        expect(await outcome).toEqual({state: 'requested', request: pendingRequest()});
    });

    it('reports an already-open request rather than submitting a second one', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const outcome = service.relink(CONVERSATION, false);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([pendingRequest()]);

        expect(await outcome).toEqual({state: 'pending', request: pendingRequest()});
        ctrl.expectNone(req => req.method === 'POST');
    });

    it('leaves the context marked not-admitted when the re-link changed nothing', async () => {
        const {service, ctrl, health} = setup({groupAfterRefresh: null});

        const outcome = service.relink(CONVERSATION, false);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'POST')).flush(pendingRequest());
        await outcome;

        // The banner must not clear itself off the back of a button press that only *asked*.
        expect(health.healthOf(CONVERSATION)?.reason).toBe('not-admitted');
        expect(health.isBroken(CONVERSATION)).toBe(true);
    });

    it('surfaces the server\'s refusal instead of swallowing it', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const outcome = service.relink(CONVERSATION, false);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'POST')).flush(
            "'device-a' is not one of your registered devices. Register it first.",
            {status: 400, statusText: 'Bad Request'},
        );

        expect(await outcome).toEqual({
            state: 'failed',
            message: "'device-a' is not one of your registered devices. Register it first.",
        });
    });

    it('surfaces a locked session rather than reporting success', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null, locked: true});

        const outcome = service.relink(CONVERSATION, false);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([]);

        expect(await outcome).toEqual({state: 'failed', message: 'MLS session is locked'});
    });

    it('does not ask to be admitted to a context that is not encrypted', async () => {
        const {service, ctrl} = setup({encrypted: false, groupAfterRefresh: null, floor: null});

        await expect(service.relink(CONVERSATION, false)).resolves.toEqual({state: 'not-encrypted'});
        ctrl.expectNone(() => true);
    });

    it('still asks when the server claims plaintext below a context this device has encrypted', async () => {
        const {service, ctrl} = setup({encrypted: false, groupAfterRefresh: null, floor: 2});

        const outcome = service.relink(CONVERSATION, false);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'POST')).flush(pendingRequest());

        expect((await outcome).state).toBe('requested');
    });

    it('reports a failed catch-up instead of pressing on to an admission request', async () => {
        const {service, ctrl} = setup({refreshRejects: new Error('offline')});

        await expect(service.relink(CONVERSATION, false))
            .resolves.toEqual({state: 'failed', message: 'offline'});
        ctrl.expectNone(() => true);
    });

    it('uses the channel routes for a channel context', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const outcome = service.relink(CHANNEL, true);
        (await waitForRequest(ctrl, CHANNEL_BASE, 'GET')).flush([]);
        (await waitForRequest(ctrl, CHANNEL_BASE, 'POST')).flush(pendingRequest());

        expect((await outcome).state).toBe('requested');
    });
});

describe('MlsJoinRequestService.sweepForAdmission', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    const conversation = (id: string, serverSaysEncrypted = true) =>
        ({contextId: id, isChannel: false, serverSaysEncrypted});

    const routeFor = (id: string) =>
        `${ORIGIN}/api/v1/messaging/conversations/${id}/mls/join-requests`;

    it('asks to be admitted to a conversation this device holds no group for', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const sweep = service.sweepForAdmission([conversation('c1')]);
        (await waitForRequest(ctrl, routeFor('c1'), 'GET')).flush([]);
        (await waitForRequest(ctrl, routeFor('c1'), 'POST')).flush(pendingRequest());

        expect(await sweep).toMatchObject({probed: 1, requested: 1, failed: 0});
    });

    it('does not re-request for a conversation that already has an open request', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const sweep = service.sweepForAdmission([conversation(CONVERSATION)]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([pendingRequest()]);

        expect(await sweep).toMatchObject({probed: 1, requested: 0, alreadyPending: 1});
        // The dedupe is the point: a resubmitting sweep files one request per launch into a human's queue.
        ctrl.expectNone(req => req.method === 'POST');
    });

    it('costs nothing at all when this device is in every group', async () => {
        const {service, ctrl, refreshState} = setup({groupAfterRefresh: 'Z3JvdXA='});

        const outcome = await service.sweepForAdmission(
            [conversation('c1'), conversation('c2'), conversation('c3')]);

        expect(outcome.probed).toBe(0);
        expect(refreshState).not.toHaveBeenCalled();
        ctrl.expectNone(() => true);
    });

    it('skips a plaintext conversation without a round trip', async () => {
        const {service, ctrl, refreshState} = setup({groupAfterRefresh: null, floor: null});

        const outcome = await service.sweepForAdmission([conversation('c1', false)]);

        expect(outcome.probed).toBe(0);
        expect(refreshState).not.toHaveBeenCalled();
        ctrl.expectNone(() => true);
    });

    it('still probes one the server calls plaintext below this device\'s floor', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null, encrypted: false, floor: 2});

        const sweep = service.sweepForAdmission([conversation(CONVERSATION, false)]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'POST')).flush(pendingRequest());

        expect((await sweep).requested).toBe(1);
    });

    it('does not ask to be let back into a context it was deliberately removed from', async () => {
        const {service, ctrl, health} = setup({groupAfterRefresh: null});
        health.recordFailure(CONVERSATION, false, 'removed');

        const outcome = await service.sweepForAdmission([conversation(CONVERSATION)]);

        expect(outcome.probed).toBe(0);
        ctrl.expectNone(() => true);
    });

    it('stops after the per-launch cap and defers the rest', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});
        const cap = MlsJoinRequestService.MAX_CONTEXTS_PER_SWEEP;

        const ids = Array.from({length: cap + 3}, (_, i) => `c${i}`);
        const sweep = service.sweepForAdmission(ids.map(id => conversation(id)));

        for (let i = 0; i < cap; i++) {
            (await waitForRequest(ctrl, routeFor(ids[i]), 'GET')).flush([]);
            (await waitForRequest(ctrl, routeFor(ids[i]), 'POST')).flush(pendingRequest());
        }

        const outcome = await sweep;
        expect(outcome.probed).toBe(cap);
        expect(outcome.deferred).toBe(3);
        // Nothing fired for the deferred ones: they wait for the next launch.
        ctrl.expectNone(() => true);
    });

    it('does nothing while the MLS session is locked', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null, locked: true});

        const outcome = await service.sweepForAdmission([conversation(CONVERSATION)]);

        // Every request would fail for want of a key package, leaving a wall of failures behind.
        expect(outcome).toMatchObject({probed: 0, requested: 0, failed: 0});
        ctrl.expectNone(() => true);
    });

    it('leaves the outcome where the banner will find it', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const sweep = service.sweepForAdmission([conversation(CONVERSATION)]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'GET')).flush([]);
        (await waitForRequest(ctrl, CONVERSATION_BASE, 'POST')).flush(pendingRequest());
        await sweep;

        // A sweep nobody can see is as silent as the exclusion it is fixing.
        expect(service.statusOf(CONVERSATION)).toEqual({
            tone: 'pending',
            message: expect.stringContaining('Asked to be admitted'),
        });
    });

    it('carries on past a conversation whose request is refused', async () => {
        const {service, ctrl} = setup({groupAfterRefresh: null});

        const sweep = service.sweepForAdmission([conversation('c1'), conversation('c2')]);

        (await waitForRequest(ctrl, routeFor('c1'), 'GET')).flush(
            'nope', {status: 500, statusText: 'Server Error'});
        (await waitForRequest(ctrl, routeFor('c2'), 'GET')).flush([]);
        (await waitForRequest(ctrl, routeFor('c2'), 'POST')).flush(pendingRequest());

        expect(await sweep).toMatchObject({probed: 2, failed: 1, requested: 1});
    });
});

/** `relink` awaits several promises between HTTP calls, so this yields until the request is open. */
async function waitForRequest(ctrl: HttpTestingController, url: string, method: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const matches = ctrl.match(req => req.url === url && req.method === method);
        if (matches.length > 0) return matches[0];
        await Promise.resolve();
    }
    throw new Error(`No ${method} to ${url} was made`);
}
