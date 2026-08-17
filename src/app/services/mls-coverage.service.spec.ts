import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {HttpErrorResponse} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';
import {MlsCoverageService} from './mls-coverage.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsJoinRequestService} from './mls-join-request.service';
import {DeviceIdentityService} from './device-identity.service';
import {ApiConfigService} from './api-config.service';
import {MlsCoverageDto} from '../dtos/mls.dto';

const ORIGIN = 'https://api.test.example';
const CONVERSATION = 'conv-1';
const CHANNEL = 'chan-1';
const THIS_DEVICE = 'device-here';
const OTHER_DEVICE = 'device-there';

const CONVERSATION_URL = `${ORIGIN}/api/v1/messaging/conversations/${CONVERSATION}/mls/coverage`;
const CHANNEL_URL = `${ORIGIN}/api/v1/messaging/channels/${CHANNEL}/mls/coverage`;

/** Lets the freshness check (which reads local state asynchronously) get as far as the request. */
function tick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function coverage(overrides: Partial<MlsCoverageDto> = {}): MlsCoverageDto {
    return {
        contextId: CONVERSATION,
        encrypted: true,
        generation: 2,
        ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: true}],
        unreachableDevices: [],
        coverageUnavailable: false,
        ...overrides,
    };
}

function setup(options: {
    /**
     * Which generations this device holds a group for. The cross-check asks for the one the
     * server's answer was computed against, so holding generation 1 says nothing about 2.
     */
    groupsByGeneration?: Record<number, string>;
    /** Fallback for an answer that names no generation at all. */
    activeGroupId?: string | null;
    /** The generation this device believes the context is on. */
    knownGeneration?: number | null;
} = {}) {
    const {groupsByGeneration = {2: 'group-1'}, knownGeneration = 2} = options;
    const activeGroupId = options.activeGroupId
        ?? (knownGeneration === null ? null : groupsByGeneration[knownGeneration] ?? null);

    const getActiveGroupId = vi.fn(async () => activeGroupId);
    const getGroupId = vi.fn(async (_contextId: string, generation: number) =>
        groupsByGeneration[generation] ?? null);
    const getKnownGeneration = vi.fn(async () => knownGeneration);
    const contextChanged = new Subject<{contextId: string; isChannel: boolean; selfRemoved: boolean}>();

    const joinRequests = {
        myPendingRequest: vi.fn(async () => null as unknown),
        requestAccess: vi.fn(async () => ({id: 'req-1'}) as unknown),
    };

    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => ORIGIN}},
            {provide: MlsService, useValue: {getActiveGroupId, getGroupId, getKnownGeneration}},
            {provide: MlsSyncService, useValue: {contextChanged}},
            {provide: MlsJoinRequestService, useValue: joinRequests},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => THIS_DEVICE}},
        ],
    });

    return {
        service: TestBed.inject(MlsCoverageService),
        ctrl: TestBed.inject(HttpTestingController),
        getKnownGeneration,
        contextChanged,
        joinRequests,
    };
}

describe('MlsCoverageService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    describe('reading the server\'s answer', () => {
        it('separates this device, the account\'s other devices and other people\'s', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {}});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                ownDevices: [
                    {deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false},
                    {deviceId: OTHER_DEVICE, deviceName: 'Pixel 8', covered: false},
                    {deviceId: 'device-fine', deviceName: 'iPad', covered: true},
                ],
                unreachableDevices: [{userId: 'usr-2', deviceId: 'device-peer', deviceName: 'iPhone 15'}],
            }));
            await pending;

            const view = service.coverageOf(CONVERSATION)!;
            expect(view.thisDeviceExcluded).toBe(true);
            expect(view.otherOwnDevices.map(d => d.deviceName)).toEqual(['Pixel 8']);
            expect(view.peerDevices.map(d => d.deviceName)).toEqual(['iPhone 15']);
            expect(view.generation).toBe(2);
        });

        it('reports no exclusion at all when every device is covered', async () => {
            const {service, ctrl} = setup();

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await pending;

            const view = service.coverageOf(CONVERSATION)!;
            expect(view.thisDeviceExcluded).toBe(false);
            expect(view.otherOwnDevices).toEqual([]);
            expect(service.hasDeviceReport(CONVERSATION)).toBe(false);
        });

        it('uses the channel route for a channel', async () => {
            const {service, ctrl} = setup();

            const pending = service.refresh(CHANNEL, true);
            ctrl.expectOne(CHANNEL_URL).flush(coverage({contextId: CHANNEL}));
            await pending;

            expect(service.coverageOf(CHANNEL)?.isChannel).toBe(true);
        });

        /**
         * The server declines to report on the caller's own devices when it cannot tell which one
         * is asking - which is what happens if `X-Device-Id` went missing on enable. Absence of a
         * verdict is not a verdict, and must not read as exclusion.
         */
        it('claims nothing about a device the answer does not mention', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {}});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({ownDevices: []}));
            await pending;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(false);
        });
    });

    describe('the local cross-check', () => {
        /**
         * The whole reason `covered: false` is evidence rather than proof. A device that joined by
         * external commit leaves none of the three traces the server counts, so it reads as
         * uncovered while decrypting perfectly - and a permanent notice on a working conversation
         * is worse than the silence this feature replaces.
         */
        it('suppresses the notice when this device holds a group despite the verdict', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {2: 'group-1'}});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
            }));
            await pending;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(false);
        });

        it('shows it when the verdict and the empty local store agree', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {}});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
            }));
            await pending;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(true);
        });

        /**
         * The case an "has this device ever held a group here" test waves straight through. Keys
         * for generation 1 are still on disk and still needed for that era's history, and they do
         * nothing whatsoever for what is being sent now.
         */
        it('does not let keys from a previous era vouch for the current one', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {1: 'group-old'}, knownGeneration: 1});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                generation: 2,
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
            }));
            await pending;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(true);
        });

        it('accepts keys for exactly the era the answer is about', async () => {
            const {service, ctrl} = setup({
                groupsByGeneration: {1: 'group-old', 2: 'group-now'},
                knownGeneration: 1,
            });

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                generation: 2,
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
            }));
            await pending;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(false);
        });

        /** Refusing to claim exclusion is the safer default when there is no era to check against. */
        it('falls back to the live group when the answer names no era', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {2: 'group-now'}, knownGeneration: 2});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                generation: null,
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
            }));
            await pending;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(false);
        });
    });

    describe('encrypted: false', () => {
        /** Both lists are empty because there is nothing to be outside of - not because everybody
         * is outside. */
        it('produces nothing to render', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {}, knownGeneration: null});

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                encrypted: false,
                generation: null,
                // Deliberately non-empty: even if the server sent verdicts, an unencrypted context
                // has nothing anyone can be excluded from.
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
                unreachableDevices: [{userId: 'usr-2', deviceId: 'd', deviceName: 'iPhone 15'}],
            }));
            await pending;

            const view = service.coverageOf(CONVERSATION)!;
            expect(view.encrypted).toBe(false);
            expect(view.thisDeviceExcluded).toBe(false);
            expect(view.otherOwnDevices).toEqual([]);
            expect(view.peerDevices).toEqual([]);
            expect(service.hasDeviceReport(CONVERSATION)).toBe(false);
        });
    });

    describe('coverageUnavailable', () => {
        it('leaves an existing warning exactly as it was', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {}});

            const first = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
                unreachableDevices: [{userId: 'usr-2', deviceId: 'd', deviceName: 'iPhone 15'}],
            }));
            await first;

            const second = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                coverageUnavailable: true,
                ownDevices: [],
                unreachableDevices: [],
            }));
            await second;

            const view = service.coverageOf(CONVERSATION)!;
            expect(view.thisDeviceExcluded).toBe(true);
            expect(view.peerDevices.map(d => d.deviceName)).toEqual(['iPhone 15']);
            expect(view.unavailable).toBe(true);
        });

        it('never reads as all-clear when nothing was known before', async () => {
            const {service, ctrl} = setup();

            const pending = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                coverageUnavailable: true, ownDevices: [], unreachableDevices: [],
            }));
            await pending;

            const view = service.coverageOf(CONVERSATION)!;
            expect(view.thisDeviceExcluded).toBe(false);
            expect(view.unavailable).toBe(true);
            // "Could not check" is worth a line on the screen the user came to ask on, which is
            // what this gate feeds. It is not worth a warning anywhere else.
            expect(service.hasDeviceReport(CONVERSATION)).toBe(true);
        });

        it('treats a failed request the same way', async () => {
            const {service, ctrl} = setup({groupsByGeneration: {}});
            vi.spyOn(console, 'warn').mockImplementation(() => undefined);

            const first = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                ownDevices: [{deviceId: THIS_DEVICE, deviceName: 'This laptop', covered: false}],
            }));
            await first;

            const second = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush('nope', {status: 503, statusText: 'Unavailable'});
            await second;

            expect(service.coverageOf(CONVERSATION)?.thisDeviceExcluded).toBe(true);
            expect(service.coverageOf(CONVERSATION)?.unavailable).toBe(true);
        });

        /** §6: retry no sooner than the next natural trigger. An outage must not count as having
         * asked, or one 503 silences the question for the rest of the session. */
        it('does not count as having asked, so the next trigger tries again', async () => {
            const {service, ctrl} = setup();

            const first = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({
                coverageUnavailable: true, ownDevices: [], unreachableDevices: [],
            }));
            await first;

            const second = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await second;

            expect(service.coverageOf(CONVERSATION)?.unavailable).toBe(false);
        });
    });

    describe('caching', () => {
        it('asks once per context while the group has not moved', async () => {
            const {service, ctrl} = setup();

            const first = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await first;

            await service.ensure(CONVERSATION, false);
            await tick();
            ctrl.expectNone(CONVERSATION_URL);
        });

        it('asks again once this device knows a different generation', async () => {
            const {service, ctrl, getKnownGeneration} = setup({knownGeneration: 2});

            const first = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({generation: 2}));
            await first;

            // A Welcome for the next era landed, so everything known about generation 2 is about a
            // group that no longer decides anything.
            getKnownGeneration.mockResolvedValue(3);

            const second = service.ensure(CONVERSATION, false);
            await tick();
            ctrl.expectOne(CONVERSATION_URL).flush(coverage({generation: 3}));
            await second;

            expect(service.coverageOf(CONVERSATION)?.generation).toBe(3);
        });

        it('asks again after a commit changed the group', async () => {
            const {service, ctrl, contextChanged} = setup();

            const first = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await first;

            contextChanged.next({contextId: CONVERSATION, isChannel: false, selfRemoved: false});

            const second = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await second;
        });

        it('leaves other contexts alone when one is invalidated', async () => {
            const {service, ctrl, contextChanged} = setup();

            const first = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await first;

            contextChanged.next({contextId: CHANNEL, isChannel: true, selfRemoved: false});

            await service.ensure(CONVERSATION, false);
            await tick();
            ctrl.expectNone(CONVERSATION_URL);
        });

        it('refresh ignores the cache entirely', async () => {
            const {service, ctrl} = setup();

            const first = service.ensure(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await first;

            const second = service.refresh(CONVERSATION, false);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await second;
        });

        it('collapses two triggers landing together into one request', async () => {
            const {service, ctrl} = setup();

            const both = Promise.all([
                service.refresh(CONVERSATION, false),
                service.refresh(CONVERSATION, false),
            ]);
            ctrl.expectOne(CONVERSATION_URL).flush(coverage());
            await both;
        });
    });

    describe('requesting access', () => {
        it('submits through the join-request service and waits', async () => {
            const {service, joinRequests} = setup();

            await service.requestAccess(CONVERSATION, false);

            expect(joinRequests.requestAccess).toHaveBeenCalledWith(CONVERSATION, false);
            expect(service.requestStateOf(CONVERSATION)).toEqual({state: 'waiting'});
        });

        /**
         * The launch-time admission sweep may well have asked for this context minutes ago. A
         * second request for the same device is one more thing for a human to review to no effect.
         */
        it('does not submit a second request when one is already open', async () => {
            const {service, joinRequests} = setup();
            joinRequests.myPendingRequest.mockResolvedValue({id: 'req-1', state: 'Pending'});

            await service.requestAccess(CONVERSATION, false);

            expect(joinRequests.requestAccess).not.toHaveBeenCalled();
            expect(service.requestStateOf(CONVERSATION)).toEqual({state: 'waiting'});
        });

        it('submits again when the earlier request was denied rather than pending', async () => {
            const {service, joinRequests} = setup();
            joinRequests.myPendingRequest.mockResolvedValue({id: 'req-1', state: 'Denied'});

            await service.requestAccess(CONVERSATION, false);

            expect(joinRequests.requestAccess).toHaveBeenCalledTimes(1);
        });

        it('reports the server\'s own refusal rather than a generic failure', async () => {
            const {service, joinRequests} = setup();
            joinRequests.requestAccess.mockRejectedValue(new HttpErrorResponse({
                status: 400,
                error: {detail: "'device-here' is not one of your registered devices."},
            }));

            await service.requestAccess(CONVERSATION, false);

            expect(service.requestStateOf(CONVERSATION)).toEqual({
                state: 'failed',
                message: "'device-here' is not one of your registered devices.",
            });
        });

        it('ignores a second press while the first is still going', async () => {
            const {service, joinRequests} = setup();
            let release = () => undefined as void;
            joinRequests.requestAccess.mockImplementation(
                () => new Promise(resolve => (release = () => resolve({id: 'req-1'}))));

            const first = service.requestAccess(CONVERSATION, false);
            await Promise.resolve();
            const second = service.requestAccess(CONVERSATION, false);

            release();
            await Promise.all([first, second]);

            expect(joinRequests.requestAccess).toHaveBeenCalledTimes(1);
        });
    });

    it('forgets everything on clear', async () => {
        const {service, ctrl} = setup();

        const pending = service.ensure(CONVERSATION, false);
        ctrl.expectOne(CONVERSATION_URL).flush(coverage());
        await pending;

        service.clear();

        expect(service.coverageOf(CONVERSATION)).toBeNull();

        const again = service.ensure(CONVERSATION, false);
        ctrl.expectOne(CONVERSATION_URL).flush(coverage());
        await again;
    });
});
