import {
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenPublisher,
    ScreenSource,
    SourceThumbnail,
} from '../ports/screen-publisher.port';

/** A monitor, with the geometry fields filled in so a spec names only what it cares about. */
export function screenSource(id: string, name = id, overrides: Partial<ScreenSource> = {}): ScreenSource {
    return {id, name, isMonitor: true, thumbnail: '', width: 1920, height: 1080, ...overrides};
}

/**
 * A {@link ScreenPublisher} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/api/core')` in the screen-share specs. Publishes nothing, opens
 * no `RTCPeerConnection` and never calls `getDisplayMedia` - which on web would put a host picker in front
 * of whoever is running the suite.</p>
 *
 * <p>Defaults to a <b>desktop host with no shareable sources</b>: `hasSourcePicker` true, an empty
 * enumeration. Empty rather than invented, because "the picker had nothing to show" is a real state and a
 * spec that is about the picker seeds {@link sourceList} in one line.</p>
 *
 * <p>{@link result} answers `audioTrackName: null` by default however `shareAudio` was asked for, which is
 * the port's contract and the trap it warns about: screen audio is a *request*, and a caller that assumes
 * `shareAudio` succeeded has viewers subscribing to a track that does not exist. A spec that wants the
 * audio path sets it.</p>
 */
export class FakeScreenPublisher extends ScreenPublisher {
    /** Mutable so one spec covers both hosts. False is the browser: its own picker chooses the source. */
    hasSourcePicker = true;

    /** What {@link sources} enumerates. */
    sourceList: ScreenSource[] = [];

    /** Thumbnails by source id. An id absent here comes back with an empty one, as the port requires. */
    readonly thumbnailsById = new Map<string, string>();

    /** What {@link start} resolves to. */
    result: ScreenPublishResult = {
        mediaSessionId: 'fake-media-session',
        trackName: 'screen-fake',
        audioTrackName: null,
        encoder: 'fake',
    };

    /** Every publish asked for, in order, with the options exactly as the caller built them. */
    readonly started: ScreenPublishOptions[] = [];

    /** Every `shareId` stopped, in order. */
    readonly stopped: string[] = [];

    /** Every framerate change, as `[shareId, fps]`. */
    readonly fpsChanges: [string, number][] = [];

    /**
     * Every resolution change, as `[shareId, width, height, kbps]`.
     *
     * <p>What a spec asserts on to prove a resolution change did <b>not</b> restart the publish: a
     * change that lands here and leaves {@link stopped} and {@link started} untouched is one no
     * viewer was ever told about.</p>
     */
    readonly geometryChanges: [string, number, number, number][] = [];

    /** Every share-audio mute, as `[shareId, muted]`. */
    readonly audioMutes: [string, boolean][] = [];

    /** How many times sources were enumerated, so a caller's caching is assertable. */
    sourceCalls = 0;

    /** Every thumbnail request, as the id list it was asked for. */
    readonly thumbnailRequests: string[][] = [];

    /** Set to make {@link start} reject - no encoder, or a capture the OS refused. */
    startError: Error | null = null;

    /** Set to make {@link stop} reject, the way a stale `shareId` does on the desktop adapter. */
    stopError: Error | null = null;

    async sources(): Promise<ScreenSource[]> {
        this.sourceCalls++;
        return [...this.sourceList];
    }

    async thumbnails(ids: string[]): Promise<SourceThumbnail[]> {
        this.thumbnailRequests.push([...ids]);
        // An id that could not be captured comes back empty rather than being dropped, so a caller can
        // tell "failed" from "not asked for yet" - the port's contract, and worth honouring in the fake
        // because the difference drives whether a tile shows a placeholder or retries forever.
        return ids.map(id => ({id, thumbnail: this.thumbnailsById.get(id) ?? ''}));
    }

    async start(options: ScreenPublishOptions): Promise<ScreenPublishResult> {
        this.started.push(options);
        if (this.startError) throw this.startError;
        return this.result;
    }

    async stop(shareId: string): Promise<void> {
        this.stopped.push(shareId);
        if (this.stopError) throw this.stopError;
    }

    async setFps(shareId: string, fps: number): Promise<void> {
        this.fpsChanges.push([shareId, fps]);
    }

    async setGeometry(shareId: string, width: number, height: number, kbps: number): Promise<void> {
        this.geometryChanges.push([shareId, width, height, kbps]);
    }

    async setAudioMuted(shareId: string, muted: boolean): Promise<void> {
        this.audioMutes.push([shareId, muted]);
    }

    /** The single recorded publish, for the common case. Throws if there was not exactly one. */
    get onlyStart(): ScreenPublishOptions {
        if (this.started.length !== 1) {
            throw new Error(`expected exactly one publish, saw ${this.started.length}`);
        }
        return this.started[0]!;
    }
}
