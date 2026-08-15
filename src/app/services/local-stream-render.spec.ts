import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LocalStreamRenderer, pickH264Codec} from './local-stream-render';

/**
 * The sharer's own tile, decoded from the stream that is actually going out.
 *
 * <p>Everything here is about the two rules that decide whether the picture is a picture or a
 * smear, and neither of them fails loudly: feeding a decoder anything but a keyframe first, and
 * carrying on feeding it after a gap. Both produce a tile that renders *something*, which is
 * exactly why they are worth pinning rather than eyeballing.</p>
 *
 * <p>WebCodecs and canvas capture are stubbed rather than shimmed. jsdom has neither, and the
 * behaviour under test is the sequencing above - which frames reach `decode()` and which do not -
 * not anything a real decoder would do with them.</p>
 */

interface DecodedChunk {
    type: 'key' | 'delta';
    timestamp: number;
}

/** The decoder the renderer under test built, so a test can drive and inspect it. */
let live: FakeVideoDecoder | null = null;

class FakeVideoDecoder {
    /** Codec strings this fake claims to support, newest test first. */
    static supported: string[] = ['avc1.42E034'];
    /** Set to make `isConfigSupported` throw the way a build that rejects a string outright does. */
    static throwOn: string | null = null;

    static async isConfigSupported(config: {codec: string}): Promise<{supported: boolean}> {
        if (FakeVideoDecoder.throwOn === config.codec) throw new Error('unsupported');
        return {supported: FakeVideoDecoder.supported.includes(config.codec)};
    }

    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    decodeQueueSize = 0;
    readonly decoded: DecodedChunk[] = [];

    constructor(private readonly init: {output: (frame: unknown) => void; error: (e: unknown) => void}) {
        live = this;
    }

    configure(): void {
        this.state = 'configured';
    }

    decode(chunk: DecodedChunk): void {
        this.decoded.push(chunk);
    }

    close(): void {
        this.state = 'closed';
    }

    /** Drives the decoder's own error callback, the way a stream it cannot follow would. */
    fail(): void {
        this.init.error(new Error('decode failed'));
    }

    /** Hands back a decoded frame, so the draw path can be exercised without a real decoder. */
    emit(closed = {count: 0}): {count: number} {
        this.init.output({
            displayWidth: 1920,
            displayHeight: 1080,
            close: () => closed.count++,
        });
        return closed;
    }
}

class FakeEncodedVideoChunk {
    readonly type: 'key' | 'delta';
    readonly timestamp: number;

    constructor(init: {type: 'key' | 'delta'; timestamp: number; data: BufferSource}) {
        this.type = init.type;
        this.timestamp = init.timestamp;
    }
}

const globals = globalThis as unknown as Record<string, unknown>;
let stoppedTracks = 0;

beforeEach(() => {
    live = null;
    stoppedTracks = 0;
    FakeVideoDecoder.supported = ['avc1.42E034'];
    FakeVideoDecoder.throwOn = null;
    globals['VideoDecoder'] = FakeVideoDecoder;
    globals['EncodedVideoChunk'] = FakeEncodedVideoChunk;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
        drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '',
    })) as unknown as HTMLCanvasElement['getContext'];
    (HTMLCanvasElement.prototype as unknown as {captureStream: unknown}).captureStream = vi.fn(() => ({
        getTracks: () => [{stop: () => stoppedTracks++}],
        getVideoTracks: () => [{requestFrame: vi.fn()}],
    }));
});

afterEach(() => {
    delete globals['VideoDecoder'];
    delete globals['EncodedVideoChunk'];
});

function renderer(onFailure = vi.fn(), onFirstFrame = vi.fn()): {
    r: LocalStreamRenderer;
    onFailure: ReturnType<typeof vi.fn>;
    onFirstFrame: ReturnType<typeof vi.fn>;
} {
    return {
        r: new LocalStreamRenderer(1920, 1080, 'avc1.42E034', onFailure, onFirstFrame),
        onFailure,
        onFirstFrame,
    };
}

function chunk(keyframe: boolean, timestampUs = 0): {keyframe: boolean; timestampUs: number; data: Uint8Array} {
    return {keyframe, timestampUs, data: new Uint8Array([0, 0, 0, 1, keyframe ? 0x65 : 0x41])};
}

describe('pickH264Codec', () => {
    it('answers null where there is no decoder at all - the WebKitGTK case', async () => {
        delete globals['VideoDecoder'];

        expect(await pickH264Codec()).toBeNull();
    });

    it('takes the most capable level the host accepts', async () => {
        // Descending, because a decoder that accepts 5.2 accepts everything under it - and a 4K
        // share fails a probe that only ever asked about 4.2.
        FakeVideoDecoder.supported = ['avc1.42E02A', 'avc1.42E01E'];

        expect(await pickH264Codec()).toBe('avc1.42E02A');
    });

    it('keeps asking after a codec string the host rejects outright', async () => {
        // Some builds throw on a string rather than answering `supported: false`. Stopping there
        // would drop the whole feature over the *first* entry in a list that exists to be tried.
        FakeVideoDecoder.throwOn = 'avc1.42E034';
        FakeVideoDecoder.supported = ['avc1.42E01E'];

        expect(await pickH264Codec()).toBe('avc1.42E01E');
    });

    it('answers null when the host supports none of them', async () => {
        FakeVideoDecoder.supported = [];

        expect(await pickH264Codec()).toBeNull();
    });
});

describe('LocalStreamRenderer', () => {
    it('drops everything until the first keyframe', () => {
        // H.264 deltas reference frames a fresh decoder has never seen. Feeding them produces
        // either an error or - worse, because it reads as a broken share - a smear of the wrong
        // pixels in the sharer's own tile.
        const {r} = renderer();

        r.push(chunk(false, 1));
        r.push(chunk(false, 2));

        expect(live?.decoded).toEqual([]);
    });

    it('starts at the first keyframe and follows the deltas after it', () => {
        const {r} = renderer();

        r.push(chunk(false, 1));
        r.push(chunk(true, 2));
        r.push(chunk(false, 3));

        expect(live?.decoded).toEqual([
            {type: 'key', timestamp: 2},
            {type: 'delta', timestamp: 3},
        ]);
    });

    it('waits for a keyframe again after an interruption', () => {
        // What `interrupt()` is for: the feed is cut while the preview is paused, so the frames
        // that arrive when it comes back reference frames this decoder was switched off for.
        const {r} = renderer();
        r.push(chunk(true, 1));

        r.interrupt();
        r.push(chunk(false, 2));

        expect(live?.decoded).toEqual([{type: 'key', timestamp: 1}]);

        r.push(chunk(true, 3));
        expect(live?.decoded).toEqual([
            {type: 'key', timestamp: 1},
            {type: 'key', timestamp: 3},
        ]);
    });

    it('drops deltas rather than queueing them once the decoder is behind', () => {
        // A local preview that has fallen behind is worth less than a current one, and the queue is
        // the only place the lag can build - the encoder does not slow down for us.
        const {r} = renderer();
        r.push(chunk(true, 1));
        live!.decodeQueueSize = 99;

        r.push(chunk(false, 2));

        expect(live?.decoded).toEqual([{type: 'key', timestamp: 1}]);
    });

    it('recovers on the next keyframe after dropping for depth', () => {
        const {r} = renderer();
        r.push(chunk(true, 1));
        live!.decodeQueueSize = 99;
        r.push(chunk(false, 2));

        live!.decodeQueueSize = 0;
        r.push(chunk(true, 3));

        expect(live?.decoded.at(-1)).toEqual({type: 'key', timestamp: 3});
    });

    it('reports a decoder failure once and releases the stream', () => {
        // The caller falls back to the thumbnail, which never stopped being sent. Retrying in place
        // would spend the share's whole bitrate rediscovering the same failure.
        const {r, onFailure} = renderer();
        r.push(chunk(true, 1));

        live!.fail();

        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(stoppedTracks).toBe(1);

        // And nothing after it: a failed renderer is finished, not degraded.
        r.push(chunk(true, 2));
        expect(live?.decoded).toEqual([{type: 'key', timestamp: 1}]);
    });

    it('stops feeding a decoder that has been closed', () => {
        const {r} = renderer();
        r.push(chunk(true, 1));

        r.close();
        r.push(chunk(true, 2));

        expect(live?.decoded).toEqual([{type: 'key', timestamp: 1}]);
    });

    it('counts drawn frames rather than decoded ones, and resets on read', () => {
        // The tile's fps readout. Measured at the draw because what it answers for the sharer is
        // "is the picture I am looking at live", not "did the decoder accept something".
        const {r} = renderer();
        r.push(chunk(true, 1));
        expect(r.takeRenderedCount()).toBe(0);

        live!.emit();
        live!.emit();

        expect(r.takeRenderedCount()).toBe(2);
        expect(r.takeRenderedCount()).toBe(0);
    });

    /**
     * The track exists from construction but produces nothing until something is drawn on the
     * canvas behind it. Consumers prefer the stream over the thumbnail, so announcing it any
     * earlier swaps a working picture for an empty `<video>` at the exact moment a share starts.
     */
    it('announces the first frame only once the canvas holds a picture', () => {
        const {r, onFirstFrame} = renderer();

        r.push(chunk(true, 1));
        expect(onFirstFrame).not.toHaveBeenCalled();

        live!.emit();
        expect(onFirstFrame).toHaveBeenCalledTimes(1);

        live!.emit();
        expect(onFirstFrame).toHaveBeenCalledTimes(1);
    });

    it('closes every frame it is handed, including after it is closed itself', () => {
        // A VideoFrame holds a decoder buffer. Leaking even a few of them stalls the decoder
        // outright, and the symptom is a preview that simply stops with no error anywhere.
        const {r} = renderer();
        r.push(chunk(true, 1));
        const closed = {count: 0};

        live!.emit(closed);
        r.close();
        live!.emit(closed);

        expect(closed.count).toBe(2);
    });
});
