import {CaptureGeometry} from '../models/capture-geometry';
import {ScreenPublisher} from './ports/screen-publisher.port';

/**
 * One JPEG frame of a screen source, as the native capture pipeline delivers them.
 *
 * <p>Declared here rather than in `rust-media.service.ts` because both sides of that pipeline now
 * need the shape: the adapter receives the frames and the service decodes them onto its canvas.</p>
 */
export interface ScreenFrame {
    /** base64 JPEG. */
    data: string;
    width: number;
    height: number;
    timestampMs: number;
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
