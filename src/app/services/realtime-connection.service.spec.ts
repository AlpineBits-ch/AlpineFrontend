/**
 * The connection is now built lazily, because the URL needs an async-resolved device id. Every
 * consuming service relies on `.on()` being safe to call before `.start()`, so the queue-then-
 * replay behaviour is the contract under test.
 */

// `vi.hoisted` is required, not stylistic: `vi.mock` factories are hoisted above every
// declaration in the file, so a plain `const builtUrls = []` referenced inside one is still in
// its temporal dead zone when the factory runs.
const {builtUrls, connection} = vi.hoisted(() => ({
    builtUrls: [] as string[],
    connection: {
        state: 'Disconnected',
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
        withUrl: vi.fn((url: string) => {
            builtUrls.push(url);
            return builder;
        }),
        withAutomaticReconnect: vi.fn(() => builder),
        // The real builder hands both of these to `HubConnection.create` and they land on the
        // connection as properties, so the stub does the same rather than merely recording the
        // call - a test that asserts on the connection is asserting on what the hub actually uses.
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

function setup(deviceId: () => Promise<string> = async () => 'device-abc') {
    builtUrls.length = 0;
    vi.clearAllMocks();

    TestBed.configureTestingModule({
        providers: [
            {provide: DeviceIdentityService, useValue: {deviceId}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: AuthService, useValue: {ensureValidToken: async () => 'tok'}},
            {provide: NotificationService, useValue: {createNotification: async () => undefined}},
        ],
    });

    return TestBed.inject(RealtimeConnectionService);
}

it('connects with the device id as a query parameter', async () => {
    const service = setup();

    await service.start();

    expect(builtUrls[0]).toBe('https://api.venta.gg/api/v1/ws/hub?deviceId=device-abc');
});

it('replays handlers registered before start', async () => {
    const service = setup();
    const handler = vi.fn();

    service.on('call.CallEnded', handler);
    expect(connection.on).not.toHaveBeenCalled();

    await service.start();

    expect(connection.on).toHaveBeenCalledWith('call.CallEnded', handler);
});

it('registers handlers directly once the connection exists', async () => {
    const service = setup();
    await service.start();

    const handler = vi.fn();
    service.on('guild.voice.KickedByOtherDevice', handler);

    expect(connection.on).toHaveBeenCalledWith('guild.voice.KickedByOtherDevice', handler);
});

it('drops a queued handler when it is removed before start', async () => {
    const service = setup();
    const handler = vi.fn();

    service.on('call.CallEnded', handler);
    service.off('call.CallEnded');
    await service.start();

    expect(connection.on).not.toHaveBeenCalled();
});

it('connects without the parameter when the device id cannot be resolved', async () => {
    const service = setup(async () => {
        throw new Error('store locked');
    });

    await service.start();

    expect(builtUrls[0]).toBe('https://api.venta.gg/api/v1/ws/hub');
});

it('does not rebuild the connection on a second start', async () => {
    const service = setup();

    await service.start();
    await service.start();

    expect(builtUrls).toHaveLength(1);
});
