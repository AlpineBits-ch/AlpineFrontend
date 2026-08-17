import {CaptureGeometry} from '../models/capture-geometry';
import {ScreenPublisher} from './ports/screen-publisher.port';

/** One JPEG frame of a screen source, as the native capture pipeline delivers them. */
export interface ScreenFrame {
    /** base64 JPEG. */
    data: string;
    width: number;
    height: number;
    timestampMs: number;
}

/**
 * One access unit of the running publish's own encoded video, for the sharer's tile to decode. The
 * same H.264 the wire carries, not a re-encode.
 *
 * Annex-B framed, Constrained Baseline, with in-band parameter sets, so a decoder needs no
 * `description`.
 */
export interface LocalStreamChunk {
    /** An IDR, and therefore a point a decoder can start or recover at. */
    keyframe: boolean;
    /** Microseconds since the share's first frame. */
    timestampUs: number;
    /** A view over the received buffer, valid only for the duration of the handler. */
    data: Uint8Array;
}

/** One block of loopback audio: base64 f32-LE PCM, as the native capture pipeline delivers it. */
export interface AudioChunk {
    data: string;
    sampleRate: number;
    channels: number;
}

/**
 * What actually happened to a share's audio, as opposed to what was asked for.
 *
 * <p>Three states rather than a boolean, because "the user did not ask for audio" and "the user asked
 * and this host could not give it" must not read the same. The second one is a thing to <b>say</b>:
 * screen audio is Chromium-only and tab/window-scoped on web, and needs a usable loopback device on
 * desktop, so a share that silently dropped the audio half is the failure this exists to prevent.</p>
 */
export type ScreenAudioOutcome = 'off' | 'published' | 'unavailable';

/**
 * The rest of a host's screen surface - everything {@link ScreenPublisher} deliberately does not model.
 *
 * <p>This is not a second port and it is not injected. It is the shape both adapters happen to have,
 * declared in one place so `RustMediaService` can keep its present public API - `startScreenCapture`,
 * the loopback pair, the preview signal - without either re-opening the port contract or importing a
 * Tauri module. Reach it with {@link hostFor}.</p>
 *
 * <p>Why it is separate from the port at all: the port is the surface a <i>migrated caller</i> depends
 * on, and a migrated caller has no business with the canvas pipeline - that pipeline exists because
 * Rust hands the webview JPEGs, which is a fact about one host and one rollback path. Putting it in
 * the port would make every future adapter implement a shape that only means something to Tauri.</p>
 */
export interface ScreenPublisherHost {
    /**
     * Whether frames and loopback audio come from the host rather than from the browser.
     *
     * <p>False in a browser, where {@link startNativeScreenCapture} and its siblings throw. A caller
     * branches on this <b>before</b> calling them - the alternative would be a capture that returns a
     * track producing nothing, which is exactly the "enabled control over a no-op" this codebase
     * keeps banning.</p>
     */
    readonly nativeCapture: boolean;

    /**
     * Start native capture of one source, delivering frames to `onFrame` until stopped.
     *
     * <p>Geometry is applied to the capture side before the first frame arrives, so the receiving
     * canvas can be sized once and never resized.</p>
     */
    startNativeScreenCapture(
        sourceId: string,
        geometry: CaptureGeometry,
        fps: number,
        onFrame: (frame: ScreenFrame) => void,
    ): Promise<void>;

    setNativeCaptureFps(fps: number): Promise<void>;

    setNativeCaptureGeometry(geometry: CaptureGeometry): Promise<void>;

    stopNativeScreenCapture(): Promise<void>;

    /** Start native loopback (system audio) capture, delivering PCM blocks to `onChunk`. */
    startNativeLoopbackCapture(onChunk: (chunk: AudioChunk) => void): Promise<void>;

    stopNativeLoopbackCapture(): Promise<void>;

    /**
     * Whether the microphone has to be captured natively rather than with `getUserMedia`.
     *
     * <p>True only on Linux, where WebKitGTK answers `getUserMedia` with a permission denial no
     * prompt can clear.</p>
     */
    prefersNativeAudioCapture(): Promise<boolean>;

    /**
     * Register the sink for the sharer's own low-rate preview of a running publish.
     *
     * <p>One handler, replaced on each call; there is exactly one consumer. The frames are a
     * thumbnail rather than the stream: a native publish puts no `MediaStream` in the webview at all,
     * and the web adapter deliberately matches that shape rather than exposing its stream, so the
     * local tile has one thing to render on both hosts.</p>
     */
    onPreviewFrame(handler: (dataUrl: string) => void): void;

    /**
     * Register the sink for the running publish's own encoded video - see {@link LocalStreamChunk}.
     *
     * <p>Only ever fed when the publish was started with `localStream: true`, which the caller sets
     * from whether this webview can actually decode H.264. A host with no such feed simply never
     * calls the handler, and the {@link onPreviewFrame} thumbnail remains what the tile shows.</p>
     */
    onPublishChunk(handler: (chunk: LocalStreamChunk) => void): void;

    /**
     * Start or stop the {@link onPublishChunk} feed for the running publish.
     *
     * <p>The lever behind the idle preview pause. The thumbnail's pause only stops the webview
     * *applying* frames - frames it costs almost nothing to keep receiving - but this feed carries
     * the share's entire bitrate, so an unwatched preview has to be stopped at the source. Turning
     * it back on asks the encoder for a keyframe, since a decoder that missed the gap cannot use
     * the deltas that follow it.</p>
     *
     * <p>Safe to call when nothing is publishing, and safe to call with the state it already has -
     * callers drive it from a signal and re-assert far more often than it changes.</p>
     */
    setLocalStreamEnabled(enabled: boolean): Promise<void>;

    /**
     * Register the sink for "the share stopped without being asked to".
     *
     * <p>Fires on web when the user stops the share from the browser's own capture bar, which is the
     * primary way a web user ends a share. Never fires on the native publisher, which has no signal
     * for its source going away - that gap predates the port and is not introduced by it.</p>
     */
    onPublishEnded(handler: () => void): void;
}

/**
 * The host surface behind a publisher, or null for a stand-in that does not carry one.
 *
 * <p>A structural check rather than a cast, so a spec can provide a partial fake of the port without
 * having to implement a capture pipeline it does not exercise - and so a caller that needs the host
 * half finds out by getting null, not by a `TypeError` three frames deeper.</p>
 */
export function hostFor(publisher: ScreenPublisher): ScreenPublisherHost | null {
    const candidate = publisher as unknown as Partial<ScreenPublisherHost>;
    return typeof candidate.nativeCapture === 'boolean' ? candidate as ScreenPublisherHost : null;
}
