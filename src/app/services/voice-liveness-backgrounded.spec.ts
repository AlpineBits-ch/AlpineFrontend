/**
 * Liveness while the app is in the background: what went wrong, and where the assertion lives now.
 *
 * <h3>The report</h3>
 *
 * <p>Alt-tab away from the app while screen sharing and the *other participant's* tile of your
 * stream disappears, permanently, while your own client shows nothing wrong.</p>
 *
 * <h3>Why losing focus could end a share at all</h3>
 *
 * <p>Room membership is asserted by a heartbeat, and the heartbeat was only ever a bare
 * <code>setInterval(..., 30_000)</code> living in the webview - `voice-channel.service.ts` for a
 * guild channel, `call-webrtc.service.ts` for a DM call. Behind that sat the hub, whose ping is
 * also a renderer timer. A backgrounded window is exactly where a webview timer stops being
 * dependable: once a page has been hidden for a few minutes Chromium's intensive throttling aligns
 * wake-ups to one-minute boundaries regardless of the delay the page asked for, and page freezing
 * can withhold them for longer still.</p>
 *
 * <p>So the chain was: throttled ping misses SignalR's default 30s `ClientTimeoutInterval`, the hub
 * declares the client gone, the server shortens the voice liveness key to a 45s grace window, the
 * equally throttled `voice.Heartbeat` misses that too, and the 60s sweep evicts the participant,
 * removes their shares and tells every peer they left.</p>
 *
 * <p>This codebase already said twice that a hidden window has no dependable clock, in the two
 * other places that needed one:</p>
 *
 * <ul>
 *   <li>`voice-activity.service.ts` - "a hidden tab does not get animation frames at all ... and
 *   'hidden' is the <i>normal</i> case for this feature, since the reason VAD exists at all is that
 *   the game, not the tab, has focus."</li>
 *   <li>`spatial-audio.service.ts` - "while the game is focused this window is backgrounded, which
 *   pauses rAF entirely but only throttles timers."</li>
 * </ul>
 *
 * <p>Both chose a timer over rAF <em>and accepted degraded resolution</em>. Liveness cannot accept
 * degraded resolution: it is a deadline, not a meter.</p>
 *
 * <h3>Why the sharer saw nothing wrong</h3>
 *
 * <p>On desktop the screen share is published entirely from Rust (`publishScreenFromRust`), outside
 * the webview, so capture and RTP carried on regardless and the local tile stayed live.</p>
 *
 * <h3>The design that replaced it</h3>
 *
 * <p>Neither half of the fix tries to make a renderer timer punctual, because it cannot be made
 * punctual. Both move the deadline off it:</p>
 *
 * <ol>
 *   <li><b>The hub no longer dies.</b> `realtime-connection.service.ts` sets an explicit 120s server
 *   timeout and 30s keep-alive instead of SignalR's foreground-tab defaults, so three consecutive
 *   throttled or frozen wake-ups still leave the connection up and the liveness window never
 *   shortens to the 45s grace value. That is the one thing this spec still checks, below.</li>
 *   <li><b>Room liveness is asserted by Rust.</b> `src-tauri/src/media/voice/liveness.rs` POSTs to
 *   `<voiceBase>/alive` every 30s for exactly as long as the voice publication is held. Rust holds
 *   that publication for as long as the user is in the room and the OS never freezes it, so this
 *   assertion cannot be throttled at all.</li>
 * </ol>
 *
 * <p>The webview `voice.Heartbeat` stays exactly as it was. It is no longer the thing keeping the
 * participant alive, but it is still the repair and version-sync channel, and on web builds - which
 * have no Rust side - it is still the only one. Deliberately no TypeScript fallback ping was added
 * on desktop: that would put the assertion back on the throttled timer, which is the defect.</p>
 *
 * <p>The tests that used to live here and measured the webview heartbeat's gap against the server's
 * liveness window are gone rather than loosened. They pinned the wrong owner: under this design the
 * webview timer is *expected* to fall behind while backgrounded, and a test that forbids it would
 * fail for the right reason. Two further tests that asserted a re-assert on `focus` are gone for the
 * same reason - they were a proposed client-side mitigation this design supersedes.</p>
 *
 * <p><b>Not the Task 10 resource-saving pause.</b> That was the first suspect and it is not the
 * cause: `RustMediaService`'s blur handler only stops the webview <i>applying</i> preview frames,
 * `StreamSrcDirective` only pauses `<video>` elements, and every `previewPaused` template branch is
 * gated on `isLocal && !stream`. None of them can reach the publish or the roster. Kept written down
 * here so the next person does not re-investigate it.</p>
 */

// `vi.hoisted` is required, not stylistic: `vi.mock` factories are hoisted above every declaration
// in the file, so a plain `const connection = {...}` referenced inside one is still in its temporal
// dead zone when the factory runs.
const {connection} = vi.hoisted(() => ({
    connection: {
        state: 'Disconnected',
        // SignalR's own defaults, so a service that forgot to override them would leave these in
        // place and the assertions below would catch it rather than reading a bare `undefined`.
        serverTimeoutInMilliseconds: 30_000,
        keepAliveIntervalInMilliseconds: 15_000,
        on: vi.fn(),
        off: vi.fn(),
        invoke: vi.fn(),
        start: vi.fn(async () => undefined),
        onreconnecting: vi.fn(),
        onreconnected: vi.fn(),
        onclose: vi.fn(),
    },
}));

vi.mock('@microsoft/signalr', () => {
    const builder = {
        withUrl: vi.fn(() => builder),
        withAutomaticReconnect: vi.fn(() => builder),
        // The real builder passes both of these to `HubConnection.create`, which assigns them to
        // the connection. The stub does the same rather than merely recording that the call
        // happened, so the test below asserts on the values the hub will actually run with.
        withServerTimeout: vi.fn((ms: number) => {
            connection.serverTimeoutInMilliseconds = ms;
            return builder;
        }),
        withKeepAliveInterval: vi.fn((ms: number) => {
            connection.keepAliveIntervalInMilliseconds = ms;
            return builder;
        }),
        build: vi.fn(() => connection),
    };
    return {
        // A regular function, not an arrow: the service calls `new HubConnectionBuilder()`, and
        // arrow functions are not constructors.
        HubConnectionBuilder: vi.fn(function () {
            return builder;
        }),
        HubConnectionState: {Connected: 'Connected', Disconnected: 'Disconnected'},
    };
});

import {TestBed} from '@angular/core/testing';
import {RealtimeConnectionService} from './realtime-connection.service';
import {DeviceIdentityService} from './device-identity.service';
import {ApiConfigService} from './api-config.service';
import {AuthService} from './auth.service';
import {NotificationService} from './notification.service';

/**
 * Chromium's intensive throttling period: once a page has been hidden for a few minutes, timer
 * wake-ups are aligned to one-minute boundaries regardless of the delay the page asked for. This is
 * the number every threshold below is derived from, because it is the number the platform imposes.
 */
const INTENSIVE_THROTTLE_MS = 60_000;

async function startedConnection(): Promise<typeof connection> {
    connection.serverTimeoutInMilliseconds = 30_000;
    connection.keepAliveIntervalInMilliseconds = 15_000;
    vi.clearAllMocks();

    TestBed.configureTestingModule({
        providers: [
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-abc'}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: AuthService, useValue: {ensureValidToken: async () => 'tok'}},
            {provide: NotificationService, useValue: {createNotification: async () => undefined}},
        ],
    });

    await TestBed.inject(RealtimeConnectionService).start();
    return connection;
}

describe('the hub connection survives background throttling', () => {
    afterEach(() => {
        TestBed.resetTestingModule();
    });

    /**
     * Asserted on the configuration rather than on elapsed time on purpose. The behaviour this
     * guards takes minutes of hidden-page wall clock to reproduce and depends on a throttling
     * policy no test environment implements; the *setting* is the whole fix, and it is exact.
     *
     * <p>The threshold is derived, not copied from the service: a timeout has to outlast one
     * throttled period with a whole second period spare, because page freezing can withhold a
     * wake-up entirely rather than merely delay it. Anything shorter and a hidden window is
     * disconnected while its media is still flowing.</p>
     */
    it('allows the server to hear nothing for longer than a throttled window can withhold', async () => {
        const hub = await startedConnection();

        expect(hub.serverTimeoutInMilliseconds).toBeGreaterThanOrEqual(2 * INTENSIVE_THROTTLE_MS);
    });

    /**
     * The other half of the pair. A long timeout on its own is not enough if the ping that refreshes
     * it is rare: the client has to get several attempts inside one window so that consecutive
     * missed wake-ups still land one ping in time.
     */
    it('pings often enough that several attempts fit inside the timeout', async () => {
        const hub = await startedConnection();

        expect(hub.keepAliveIntervalInMilliseconds).toBeLessThanOrEqual(hub.serverTimeoutInMilliseconds / 3);
    });

    /**
     * Guards against the settings being dropped rather than changed. SignalR's defaults (30s / 15s)
     * are tuned for a foreground browser tab; leaving them is precisely the reported defect, and a
     * builder chain is easy to lose in a merge without any test noticing.
     */
    it('does not run on SignalR defaults', async () => {
        const hub = await startedConnection();

        expect(hub.serverTimeoutInMilliseconds).not.toBe(30_000);
        expect(hub.keepAliveIntervalInMilliseconds).not.toBe(15_000);
    });
});

describe('a client that was evicted for any reason', () => {
    /**
     * A separate, still-open defect, kept here because this investigation is where it was found.
     *
     * <p>The webview heartbeat is the repair channel: the server reconciles in both directions from
     * it and re-announces our media to peers. But the state it carries is the microphone alone -
     * `VoiceHeartbeatState` is `{knownInstanceId, knownVersion, mediaSessionId, audioTrackName}`,
     * built from `VoiceRtcService.publishedMedia`, which knows nothing about the share. So a room
     * that has forgotten our screen share can never be corrected by it: the share was announced
     * exactly once by `invokeVoiceScreenShareStarted` and is never re-announced. `syncLocal` even
     * paints the local row back to `isScreenSharing: true` from local state, which is why the sharer
     * sees no problem. Feed such a client a snapshot in which it is not streaming while it believes
     * it is, and nothing re-announces the share.</p>
     *
     * <p>Out of scope here deliberately. Backgrounding is no longer a way to reach this state, but
     * it was never the only one - a genuine network outage long enough to be swept produces exactly
     * the same permanent loss, and fixing that means making the share part of what the heartbeat
     * reconciles, which is a contract change on both sides rather than a client fix.</p>
     */
    it.todo('re-announces the share when the server says it is no longer streaming');
});
