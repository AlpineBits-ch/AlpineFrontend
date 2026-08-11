/**
 * The two things the Rust presence module changed about this service.
 *
 * <p><b>1. The arbiter is the only writer once it speaks.</b> `rich_presence.rs` now feeds
 * `scan_game_process` into the arbiter, which merges RPC, process detection and media by priority
 * and emits `presence://changed`. A poll that also called `setLocal` would bypass that merge - and
 * because a bare `ProcessScan` sighting has no `details`/`state`, `activitiesEqual` treats it as a
 * different activity from the rich RPC report of the same game, so it overwrote the rich one every
 * 30 s and the presence visibly flapped.</p>
 *
 * <p><b>2. The RPC server binds nothing until asked.</b> `presence::init` installs the arbiter only;
 * taking `discord-ipc-0` is the user's decision, so the stored toggle has to drive
 * `presence_rpc_start`/`presence_rpc_stop` - including on launch, so an enabled setting survives a
 * restart.</p>
 *
 * <p><b>On the fakes.</b> This used to be three `vi.mock('@tauri-apps/…')` blocks reaching into the
 * plugin modules. It is now two provided fake adapters, which is better than a like-for-like port:
 * `vi.mock` is module-global, so several spec files registering a mock for `@tauri-apps/api/core`
 * fought over one registration per run - the note about that is still in
 * `game-catalog.service.spec.ts`'s history. A fake in `providers` is scoped to this TestBed and
 * nothing else can see it.</p>
 */
import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Presence} from '../platform/ports/presence.port';
import {WindowChrome} from '../platform/ports/window-chrome.port';
import {FakePresence} from '../platform/testing/fake-presence';
import {FakeWindowChrome} from '../platform/testing/fake-window-chrome';
import {RichPresenceService} from './rich-presence.service';
import {ApiConfigService} from './api-config.service';
import {GameCatalogService} from './game-catalog.service';
import {PlatformService} from './platform.service';
import {PrivacySettingsService} from './privacy-settings.service';
import {UserSettingsService} from './user-settings.service';
import {Activity} from '../models/activity.model';

const activitySettings = signal({hiddenGames: [] as string[], discordIntegration: false});
const privacySettings = signal({shareActivity: true});

let presence: FakePresence;
let windowChrome: FakeWindowChrome;

function setup(): RichPresenceService {
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: PlatformService, useValue: {isMobile: false}},
            {provide: PrivacySettingsService, useValue: {settings: privacySettings}},
            {provide: UserSettingsService, useValue: {activitySettings}},
            {provide: Presence, useValue: presence},
            {provide: WindowChrome, useValue: windowChrome},
            // `start()` fires this off and sequences nothing behind it. Stubbed at the service rather
            // than at its `PresenceCatalog` port so the real one's own HTTP round trip stays out of
            // `HttpTestingController` - the activity-write assertions below match on every open request.
            {provide: GameCatalogService, useValue: {sync: async () => undefined}},
        ],
    });
    return TestBed.inject(RichPresenceService);
}

/** Lets the service's floating promises settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    TestBed.tick();
}

/** Every call to `method`, as its argument list. */
const calls = (method: string): unknown[][] => presence.callsTo(method);

/** Fires `presence://changed`. */
const emit = (activities: Activity[]): void => presence.change(activities);

beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    vi.useFakeTimers();

    presence = new FakePresence();
    windowChrome = new FakeWindowChrome();
    activitySettings.set({hiddenGames: [], discordIntegration: false});
    privacySettings.set({shareActivity: true});

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('RichPresenceService fallback poll', () => {
    it('reports a scanned game while the arbiter has never spoken', async () => {
        presence.game = 'Overwatch';
        const service = setup();

        service.start();
        await settle();

        expect(service.detected().map(a => a.name)).toEqual(['Overwatch']);
        expect(service.detected()[0].source).toBe('ProcessScan');
    });

    /**
     * The regression. The poll would otherwise replace "Competitive - Mirage" with a bare sighting
     * of the same game every 30 s, because the two are not equal by `activitiesEqual`.
     */
    it('never overwrites a rich RPC activity with a bare process-scan sighting', async () => {
        const service = setup();
        service.start();
        await settle();

        emit([{
            type: 'Playing',
            name: 'Counter-Strike 2',
            details: 'Competitive - Mirage',
            state: 'In Queue',
            source: 'Rpc',
            startedAt: 1_000,
        }]);
        await settle();

        // The same game is running, so the scan would happily report it - without the guard this is
        // the tick that flattened the activity.
        presence.game = 'Counter-Strike 2';
        await vi.advanceTimersByTimeAsync(31_000);
        await settle();

        expect(service.detected()[0].details).toBe('Competitive - Mirage');
        expect(service.detected()[0].source).toBe('Rpc');
    });

    /**
     * The case retiring the interval cannot cover, and the reason the guard is re-checked after the
     * await: a scan dispatched before the first event resolves after it. A cold start with a game
     * already running is exactly this race.
     */
    it('does not let a scan already in flight land on top of an arriving event', async () => {
        presence.holdScan = true;

        const service = setup();
        service.start();
        await settle();

        emit([{
            type: 'Playing',
            name: 'Counter-Strike 2',
            details: 'Competitive - Mirage',
            source: 'Rpc',
        }]);
        await settle();

        // The scan that was dispatched at `start()` only now answers, with the bare sighting.
        presence.resolveScan('Counter-Strike 2');
        await settle();

        expect(service.detected()[0].source).toBe('Rpc');
        expect(service.detected()[0].details).toBe('Competitive - Mirage');
    });

    it('stops polling at all once an event has arrived', async () => {
        const service = setup();
        service.start();
        await settle();
        emit([]);
        await settle();

        const before = calls('scan').length;
        await vi.advanceTimersByTimeAsync(120_000);
        await settle();

        expect(calls('scan').length).toBe(before);
    });

    it('lets the arbiter clear activity, which the poll must not undo', async () => {
        const service = setup();
        service.start();
        await settle();

        emit([{type: 'Playing', name: 'Factorio', source: 'Rpc'}]);
        await settle();
        emit([]);
        await settle();

        presence.game = 'Factorio';
        await vi.advanceTimersByTimeAsync(31_000);
        await settle();

        expect(service.detected()).toEqual([]);
    });
});

/**
 * The host half of the guard, which used to be `isTauri()` and is now `Presence.supported`.
 *
 * <p>Worth its own case because the web adapter behind an unsupported host <i>rejects</i> rather than
 * no-opping: if this guard ever comes off, the symptom is a console full of rejected promises instead
 * of a client that quietly publishes nothing.</p>
 */
describe('RichPresenceService on a host that cannot detect', () => {
    it('does not start, subscribe or bind the socket', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        presence.supported = false;
        const service = setup();

        service.start();
        await settle();

        expect(presence.calls).toEqual([]);
        expect(service.detected()).toEqual([]);
        expect(service.rpcStatus()).toBeNull();
    });
});

describe('RichPresenceService Discord RPC integration', () => {
    it('does not bind the socket when the setting is off', async () => {
        const service = setup();

        service.start();
        await settle();

        expect(calls('rpcStart')).toHaveLength(0);
    });

    /** A user who enabled it last session must not have to re-toggle it. */
    it('applies a stored enabled setting on launch', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        const service = setup();

        service.start();
        await settle();

        expect(calls('rpcStart')).toEqual([['proxy']]);
        expect(service.rpcStatus()?.running).toBe(true);
    });

    /**
     * The ordering the effect alone cannot catch. `RichPresenceService` is a root service, so it can
     * be constructed - and its effects flushed - long before `MainPageComponent` calls `start()`. By
     * then `activitySettings` has not changed, so nothing re-triggers the effect and only the
     * explicit apply in `start()` binds the socket.
     */
    it('applies the stored setting when settings loaded before the service started', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        const service = setup();

        await settle();
        // Nothing yet: not started, so the socket is not ours to take.
        expect(calls('rpcStart')).toHaveLength(0);

        service.start();
        await settle();

        expect(calls('rpcStart')).toEqual([['proxy']]);
    });

    it('starts the server when the toggle is turned on while running', async () => {
        setup();
        TestBed.inject(RichPresenceService).start();
        await settle();

        activitySettings.set({hiddenGames: [], discordIntegration: true});
        await settle();

        expect(calls('rpcStart')).toEqual([['proxy']]);
    });

    it('stops the server when the toggle is turned off again', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        setup().start();
        await settle();

        activitySettings.set({hiddenGames: [], discordIntegration: false});
        await settle();

        expect(calls('rpcStop')).toHaveLength(1);
    });

    it('does not reissue the same state, so a settings refetch is not a restart', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        setup().start();
        await settle();

        // Same values, new object - which is what a settings refetch produces.
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        await settle();

        expect(calls('rpcStart')).toHaveLength(1);
    });

    it('hands the socket back on sign-out', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        const service = setup();
        service.start();
        await settle();

        service.stop();
        await settle();

        expect(calls('rpcStop')).toHaveLength(1);
    });

    it('retries after a failed start rather than believing a state Rust never reached', async () => {
        presence.rpcStartFails = true;
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        const service = setup();
        service.start();
        await settle();

        expect(service.rpcStatus()).toBeNull();

        activitySettings.set({hiddenGames: [], discordIntegration: true, retry: true} as never);
        await settle();

        expect(calls('rpcStart').length).toBeGreaterThan(1);
    });
});

/**
 * Closing the window tears the webview down before an ordinary teardown would run, so the clear has to
 * hang off the close request itself - and that listener takes ownership of the close.
 */
describe('RichPresenceService window close hook', () => {
    it('clears the presence when the window is closing, without letting a throw escape', async () => {
        activitySettings.set({hiddenGames: [], discordIntegration: true});
        const service = setup();
        service.start();
        await settle();

        expect(windowChrome.hasCloseHandler).toBe(true);
        expect(() => windowChrome.requestClose()).not.toThrow();
        await settle();

        expect(calls('rpcStop')).toHaveLength(1);
    });
});

/**
 * A `SET_ACTIVITY` payload carries an application id and, by Discord's protocol, no name - the name
 * is resolved centrally from the application. So the client publishes an activity it cannot itself
 * name, and the server's response is the only place the real one appears.
 */
describe('RichPresenceService canonical names', () => {
    /**
     * Starts the service and clears the outbound throttle window.
     *
     * <p>Without this the empty push a fresh service sends is still inside its 15 s window, so the
     * first real activity is queued on a timer rather than sent - and a test asserting "nothing more
     * went out" would be measuring the queue, not the behaviour.</p>
     */
    async function startPastTheThrottleWindow(): Promise<RichPresenceService> {
        const service = setup();
        service.start();
        await settle();

        flushPushes();
        vi.advanceTimersByTime(20_000);
        await settle();

        return service;
    }

    function pendingPushes() {
        return TestBed.inject(HttpTestingController).match(
            req => req.url === 'https://api.test.example/api/v1/social/profiles/me/activity',
        );
    }

    /** Answers every open activity write with `activities`, or an empty list when omitted. */
    function flushPushes(activities: Activity[] = []): number {
        const requests = pendingPushes();
        for (const request of requests) request.flush({activities});
        return requests.length;
    }

    const VOLANTA: Activity = {
        type: 'Playing',
        name: 'Volanta',
        applicationId: '1293582351376584824',
        details: 'Idle',
        source: 'Rpc',
        startedAt: 1_000,
    };

    /** What the arbiter produces for an RPC connection that sent no name. */
    const UNNAMED: Activity = {...VOLANTA, name: 'Game'};

    it('renames a placeholder activity to the name the server published', async () => {
        const service = await startPastTheThrottleWindow();

        emit([UNNAMED]);
        await settle();
        expect(service.detected()[0].name).toBe('Game');

        expect(flushPushes([VOLANTA])).toBe(1);
        await settle();

        expect(service.detected()[0].name).toBe('Volanta');
    });

    /**
     * The correction must not read as a change and bounce straight back out - otherwise every newly
     * seen application would cost an extra write, forever.
     */
    it('does not re-publish after adopting a name', async () => {
        await startPastTheThrottleWindow();

        emit([UNNAMED]);
        await settle();

        expect(flushPushes([VOLANTA])).toBe(1);
        await settle();

        vi.advanceTimersByTime(60_000);
        await settle();

        expect(pendingPushes()).toEqual([]);
    });

    /** A name is only ever taken for an activity the server vouched for by application id. */
    it('never renames an activity that carries no application id', async () => {
        const service = await startPastTheThrottleWindow();

        emit([{type: 'Playing', name: 'Overwatch', source: 'ProcessScan', startedAt: 1_000}]);
        await settle();

        flushPushes([{type: 'Playing', name: 'Something Else', source: 'ProcessScan', startedAt: 1_000}]);
        await settle();

        expect(service.detected()[0].name).toBe('Overwatch');
    });
});
