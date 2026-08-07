/**
 * The shape of the `start_screen_publish` invocation.
 *
 * Bug this covers: the payload is assembled key by key, and Tauri's `invoke` takes a loose record,
 * so nothing type-checks it against the Rust command. Adding `shareAudio` to `ScreenPublishOptions`
 * and to the Rust signature compiled cleanly on both sides while the call itself never passed it -
 * every screen share failed at runtime with "missing required key shareAudio".
 *
 * These assert the payload against the command's parameters. They cannot know if Rust renames one,
 * but they do catch the case that actually happened: a field added to the options type and to Rust,
 * and forgotten in the middle.
 */
import {TestBed} from '@angular/core/testing';
import {invoke} from '@tauri-apps/api/core';
import {RustMediaService} from './rust-media.service';
import {ScreenPublishOptions} from './rust-media.service';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async () => ({mediaSessionId: 'cf-1', trackName: 'screen-abc', audioTrackName: null, encoder: 'openh264'})),
    isTauri: vi.fn(() => true),
    Channel: class {
        onmessage: unknown = null;
    },
}));

function options(over: Partial<ScreenPublishOptions> = {}): ScreenPublishOptions {
    return {
        sourceId: 'src-1',
        shareId: 'abc',
        width: 1280,
        height: 720,
        fps: 30,
        kbps: 2500,
        iceServers: [],
        apiBase: 'https://api.test',
        token: 'tok',
        deviceId: 'dev-1',
        guildId: 'guild-1',
        channelId: 'chan-1',
        shareAudio: true,
        ...over,
    };
}

function payload(): Record<string, unknown> {
    const call = vi.mocked(invoke).mock.calls.at(-1);
    expect(call?.[0]).toBe('start_screen_publish');
    return call?.[1] as Record<string, unknown>;
}

describe('startScreenPublish', () => {
    beforeEach(() => vi.mocked(invoke).mockClear());

    /**
     * Every parameter the Rust command declares. Listed explicitly rather than checked loosely:
     * a missing key is not a soft failure, it rejects the whole publish.
     */
    it('sends every key the command requires', async () => {
        const service = TestBed.inject(RustMediaService);

        await service.startScreenPublish(options());

        expect(Object.keys(payload()).sort()).toEqual([
            'apiBase', 'callId', 'channelId', 'deviceId', 'fps', 'guildId', 'height',
            'iceServers', 'kbps', 'onPreview', 'shareAudio', 'shareId', 'sourceId', 'token', 'width',
        ]);
    });

    it('passes the audio choice through', async () => {
        const service = TestBed.inject(RustMediaService);

        await service.startScreenPublish(options({shareAudio: true}));
        expect(payload()['shareAudio']).toBe(true);

        await service.startScreenPublish(options({shareAudio: false}));
        expect(payload()['shareAudio']).toBe(false);
    });

    /**
     * Sharing without audio beats failing the publish outright, for a caller that built its options
     * by hand and predates the field.
     */
    it('defaults the audio choice rather than omitting the key', async () => {
        const service = TestBed.inject(RustMediaService);
        const withoutAudio = options();
        delete (withoutAudio as Partial<ScreenPublishOptions>).shareAudio;

        await service.startScreenPublish(withoutAudio);

        expect(payload()['shareAudio']).toBe(false);
    });

    /** A DM call sends `callId` and no guild; the other two must still be present as nulls. */
    it('sends the unused target keys as null rather than omitting them', async () => {
        const service = TestBed.inject(RustMediaService);

        await service.startScreenPublish(
            options({guildId: undefined, channelId: undefined, callId: 'call-1'}));

        expect(payload()['callId']).toBe('call-1');
        expect(payload()['guildId']).toBeNull();
        expect(payload()['channelId']).toBeNull();
    });
});
