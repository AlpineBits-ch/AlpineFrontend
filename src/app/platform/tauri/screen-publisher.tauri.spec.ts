/**
 * The shape of the `start_screen_publish` invocation, and what the port's `shareId` buys.
 *
 * <p>Bug the payload assertions cover: it is assembled key by key, and Tauri's `invoke` takes a loose
 * record, so nothing type-checks it against the Rust command. Adding `shareAudio` to
 * `ScreenPublishOptions` and to the Rust signature compiled cleanly on both sides while the call itself
 * never passed it - every screen share failed at runtime with "missing required key shareAudio". These
 * cannot know if Rust renames one, but they do catch the case that actually happened: a field added to
 * the options type and to Rust, and forgotten in the middle. They moved here from
 * `rust-media.service.spec.ts` with the payload itself.</p>
 *
 * <p>No `vi.mock('@tauri-apps/api/core')`: the adapter takes its module loader as a constructor
 * argument, so the fake below is <b>provided</b> rather than registered globally. Several specs mock
 * that module and only one registration wins per run - a spec relying on its own factory passes or fails
 * on file ordering.</p>
 */
import {ScreenPublishOptions} from '../ports/screen-publisher.port';
import {TauriScreenPublisher} from './screen-publisher.tauri';

/** Stands in for Tauri's `Channel`: the adapter only ever assigns `onmessage`. */
class FakeChannel<T> {
    onmessage: (message: T) => void = () => {
    };
}

interface FakeCore {
    invoke: ReturnType<typeof vi.fn>;
    Channel: typeof FakeChannel;
}

function fakeCore(): FakeCore {
    return {
        invoke: vi.fn(async (command: string) =>
            command === 'start_screen_publish'
                ? {mediaSessionId: 'cf-1', trackName: 'screen-abc', audioTrackName: null, encoder: 'openh264'}
                : undefined),
        Channel: FakeChannel,
    };
}

function publisher(core: FakeCore): TauriScreenPublisher {
    return new TauriScreenPublisher(async () => core as never);
}

function options(over: Partial<ScreenPublishOptions> = {}): ScreenPublishOptions {
    return {
        sourceId: 'src-1',
        shareId: 'abc',
        width: 1280,
        height: 720,
        fps: 30,
        kbps: 2500,
        iceServers: [],
        livekit: {url: 'wss://sfu.test', token: 'lk-tok'},
        apiBase: 'https://api.test',
        token: 'tok',
        deviceId: 'dev-1',
        guildId: 'guild-1',
        channelId: 'chan-1',
        shareAudio: true,
        content: 'text',
        ...over,
    };
}

function payload(core: FakeCore): Record<string, unknown> {
    const call = core.invoke.mock.calls.filter((c: unknown[]) => c[0] === 'start_screen_publish').at(-1);
    expect(call, 'start_screen_publish was never invoked').toBeDefined();
    return call?.[1] as Record<string, unknown>;
}

describe('TauriScreenPublisher.start', () => {
    /**
     * Every parameter the Rust command declares. Listed explicitly rather than checked loosely:
     * a missing key is not a soft failure, it rejects the whole publish.
     */
    it('sends every key the command requires', async () => {
        const core = fakeCore();

        await publisher(core).start(options());

        expect(Object.keys(payload(core)).sort()).toEqual([
            'apiBase', 'callId', 'channelId', 'content', 'deviceId', 'fps', 'guildId', 'height',
            'iceServers', 'kbps', 'livekitToken', 'livekitUrl', 'localStream', 'onLocalStream',
            'onPreview', 'shareAudio', 'shareId', 'sourceId', 'token', 'width',
        ]);
    });

    /**
     * The mode reaches Rust as a bare string because `preset` is not forwarded. Pinned separately
     * from the key set above: a payload carrying the key with `undefined` would satisfy that
     * assertion and still fail the command's deserialisation.
     */
    it('sends the content mode as a value, not just as a key', async () => {
        const core = fakeCore();

        await publisher(core).start(options({content: 'games'}));

        expect(payload(core)['content']).toBe('games');
    });

    /**
     * `onLocalStream` is the channel the encoded stream comes back on and `localStream` is whether
     * it is wanted - two keys rather than an optional channel, because `Channel` is not
     * `Deserialize` on the Rust side and so cannot be an `Option` argument. The channel therefore
     * travels on every publish, wanted or not, and this pins that: an adapter that sent it only
     * when asked would fail every thumbnail-only publish on a missing argument.
     */
    it('sends the local-stream channel whether or not one was asked for', async () => {
        const core = fakeCore();
        const adapter = publisher(core);

        await adapter.start(options({localStream: true}));
        expect(payload(core)['onLocalStream']).toBeDefined();
        expect(payload(core)['localStream']).toBe(true);

        await adapter.start(options({localStream: false}));
        expect(payload(core)['onLocalStream']).toBeDefined();
        expect(payload(core)['localStream']).toBe(false);
    });

    /** As with the audio choice: a caller predating the field gets the thumbnail, not a failure. */
    it('defaults the local-stream request off rather than omitting the key', async () => {
        const core = fakeCore();
        const withoutLocalStream = options();
        delete (withoutLocalStream as Partial<ScreenPublishOptions>).localStream;

        await publisher(core).start(withoutLocalStream);

        expect(payload(core)['localStream']).toBe(false);
    });

    /**
     * The preset travels in the options for the web sender's encoding parameters and means nothing to
     * Rust, whose encoder is built from the geometry and bitrate. Forwarding it would add an unknown
     * key, and Tauri rejects the whole command for one of those.
     */
    it('does not forward the preset to Rust', async () => {
        const core = fakeCore();

        await publisher(core).start(options({preset: {resolution: '720p', framerate: 30, content: 'text'}}));

        expect(payload(core)).not.toHaveProperty('preset');
    });

    it('passes the audio choice through', async () => {
        const core = fakeCore();
        const adapter = publisher(core);

        await adapter.start(options({shareAudio: true}));
        expect(payload(core)['shareAudio']).toBe(true);

        await adapter.start(options({shareAudio: false}));
        expect(payload(core)['shareAudio']).toBe(false);
    });

    /**
     * Sharing without audio beats failing the publish outright, for a caller that built its options
     * by hand and predates the field.
     */
    it('defaults the audio choice rather than omitting the key', async () => {
        const core = fakeCore();
        const withoutAudio = options();
        delete (withoutAudio as Partial<ScreenPublishOptions>).shareAudio;

        await publisher(core).start(withoutAudio);

        expect(payload(core)['shareAudio']).toBe(false);
    });

    /** A DM call sends `callId` and no guild; the other two must still be present as nulls. */
    it('sends the unused target keys as null rather than omitting them', async () => {
        const core = fakeCore();

        await publisher(core).start(
            options({guildId: undefined, channelId: undefined, callId: 'call-1'}));

        expect(payload(core)['callId']).toBe('call-1');
        expect(payload(core)['guildId']).toBeNull();
        expect(payload(core)['channelId']).toBeNull();
    });

    /**
     * The geometry the caller solved, verbatim.
     *
     * <p>Asserted at the boundary rather than on `publishOptions`' return value: a test that only checks
     * the solver proves the numbers were computed, not that they were the ones handed to the encoder.</p>
     */
    it('passes the solved geometry to the encoder unchanged', async () => {
        const core = fakeCore();

        await publisher(core).start(options({width: 1920, height: 1080, fps: 60, kbps: 8000}));

        expect(payload(core)).toMatchObject({width: 1920, height: 1080, fps: 60, kbps: 8000});
    });
});

/**
 * The three singleton commands underneath - `stop_screen_publish`, `set_publish_fps`,
 * `set_screen_audio_muted` - take no id and address "the share". The port's `shareId` is only worth
 * carrying if a stale one is refused here, so this is where that is pinned.
 */
describe('TauriScreenPublisher share ids', () => {
    it('stops the share it started', async () => {
        const core = fakeCore();
        const adapter = publisher(core);

        await adapter.start(options({shareId: 'live'}));
        await adapter.stop('live');

        expect(core.invoke).toHaveBeenCalledWith('stop_screen_publish');
    });

    it('refuses to stop a live share on behalf of a stale id', async () => {
        const core = fakeCore();
        const adapter = publisher(core);
        await adapter.start(options({shareId: 'live'}));

        await expect(adapter.stop('replaced')).rejects.toThrow(/refused/);
        // The point of the throw: the live share is still running.
        expect(core.invoke).not.toHaveBeenCalledWith('stop_screen_publish');
    });

    it('refuses a framerate change and an audio mute aimed at a stale id', async () => {
        const core = fakeCore();
        const adapter = publisher(core);
        await adapter.start(options({shareId: 'live'}));

        await expect(adapter.setFps('replaced', 15)).rejects.toThrow(/refused/);
        await expect(adapter.setAudioMuted('replaced', true)).rejects.toThrow(/refused/);

        expect(core.invoke).not.toHaveBeenCalledWith('set_publish_fps', expect.anything());
        expect(core.invoke).not.toHaveBeenCalledWith('set_screen_audio_muted', expect.anything());
    });

    it('refuses any of the three when nothing is publishing', async () => {
        const adapter = publisher(fakeCore());

        await expect(adapter.stop('gone')).rejects.toThrow(/the live share is none/);
        await expect(adapter.setFps('gone', 30)).rejects.toThrow(/the live share is none/);
        await expect(adapter.setAudioMuted('gone', true)).rejects.toThrow(/the live share is none/);
    });

    /** A restart at a new resolution is stop-then-start, and the new id is the one that then works. */
    it('follows the share id across a restart', async () => {
        const core = fakeCore();
        const adapter = publisher(core);

        await adapter.start(options({shareId: 'first'}));
        await adapter.stop('first');
        await adapter.start(options({shareId: 'second'}));

        await expect(adapter.setFps('first', 15)).rejects.toThrow(/refused/);
        await adapter.setFps('second', 15);
        expect(core.invoke).toHaveBeenCalledWith('set_publish_fps', {fps: 15});
    });
});

describe('TauriScreenPublisher sources', () => {
    it('reports the in-app picker as available', () => {
        expect(publisher(fakeCore()).hasSourcePicker).toBe(true);
    });

    it('asks for nothing when no thumbnails were requested', async () => {
        const core = fakeCore();

        expect(await publisher(core).thumbnails([])).toEqual([]);

        expect(core.invoke).not.toHaveBeenCalled();
    });

    /**
     * An enumeration failure is a picker with no tiles, not a screen share that throws out of the UI.
     * The empty list is what the overlay renders as "nothing to share".
     */
    it('answers with an empty list when enumeration fails', async () => {
        const core = fakeCore();
        core.invoke.mockRejectedValue(new Error('no capture permission'));

        expect(await publisher(core).sources()).toEqual([]);
    });
});
