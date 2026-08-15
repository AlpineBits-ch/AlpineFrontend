import {computed, DestroyRef, effect, inject, Injectable, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {CaptureGeometry} from '../models/capture-geometry';
import {StreamPreset} from '../models/stream-preset';
import {captureDisplay, retargetDisplayFps, retargetDisplayGeometry} from '../platform/display-capture';
import {ScreenPublisher} from '../platform/ports/screen-publisher.port';
import {
    AudioChunk,
    hostFor,
    ScreenAudioOutcome,
    ScreenFrame,
    ScreenPublisherHost,
} from '../platform/screen-publisher-host';
import {LocalStreamRenderer, pickH264Codec} from './local-stream-render';

export interface ScreenSource {
    id: string;
    name: string;
    isMonitor: boolean;
    /** Always empty from enumeration - fetched per tile, see `captureSourceThumbnails`. */
    thumbnail: string;
    width: number;
    height: number;
}

export interface SourceThumbnail {
    id: string;
    /** base64 JPEG, or empty when the source could not be captured. */
    thumbnail: string;
}

export interface IceServerConfig {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface ScreenPublishOptions {
    /**
     * Which source to capture.
     *
     * <p>Ignored by the web publisher: `getDisplayMedia` opens the host's own picker, which is the
     * source chooser there. Empty is the honest value for that host - see `ScreenPickerService`.</p>
     */
    sourceId: string;
    shareId: string;
    width: number;
    height: number;
    fps: number;
    kbps: number;
    iceServers: IceServerConfig[];
    apiBase: string;
    token: string;
    /** Same `X-Device-Id` the webview sends; Rust must not appear as a second device. */
    deviceId: string;
    /** Guild voice supplies guildId + channelId; a DM call supplies callId instead. */
    guildId?: string;
    channelId?: string;
    callId?: string;
    /**
     * Capture and publish the system's audio alongside the picture, as a second
     * `screen-audio-{shareId}` track.
     *
     * A request, not a guarantee: a machine with no usable loopback device publishes video only, screen
     * audio in a browser is Chromium-only and tab/window-scoped, and
     * {@link ScreenPublishResult.audioTrackName} says what actually happened.
     */
    shareAudio: boolean;
    /**
     * Send a copy of the encoded stream back for the sharer's own tile to decode.
     *
     * <p>A capability answer, not a preference: true only where this webview can actually decode
     * H.264, which {@link RustMediaService.startScreenPublish} settles before the publish starts. A
     * host that cannot keeps the low-rate thumbnail, which is what every host used to get.</p>
     *
     * <p>Ignored by the web publisher, whose local tile has the display track itself.</p>
     */
    localStream?: boolean;
    /**
     * The preset the geometry and bitrate above were solved from.
     *
     * <p>Carried as well as the derived numbers because the web sender's encoding parameters are applied
     * by `applyScreenEncoding`, which takes the preset - and the point of passing the real one is that
     * the web path cannot drift from the canvas path's idea of what a preset means. Nothing derives
     * geometry from it a second time.</p>
     *
     * <p>Optional, and <b>not</b> forwarded to Rust: the native encoder is built from width, height, fps
     * and kbps, which are already here.</p>
     */
    preset?: StreamPreset;
}

/**
 * How long the local preview goes unclaimed - nobody rendering it, or the window hidden - before
 * frames stop being applied. See {@link RustMediaService.previewPaused}.
 *
 * <p>Matches Discord's own resource-saving pause: the stream keeps going, only the local render
 * stops, and there is a way back. Exported so a spec can advance fake timers by exactly this much
 * rather than a magic number that could silently drift from the real constant.</p>
 */
export const PREVIEW_IDLE_MS = 30_000;

export interface ScreenPublishResult {
    mediaSessionId: string;
    trackName: string;
    /**
     * The share's audio track, or null when it has none.
     *
     * What was *published*, not what was asked for - announce this rather than assuming
     * `shareAudio` succeeded, or viewers subscribe to a track that does not exist.
     */
    audioTrackName: string | null;
    /** Which encoder was selected - 'media-foundation', 'openh264', or 'browser' on web. */
    encoder: string;
}

/**
 * Screen capture and publishing, as the rest of the app sees it.
 *
 * <p>A <b>delegate over the {@link ScreenPublisher} port</b>. Its public surface is unchanged - the name
 * still says "Rust" because ~30 call sites and two off-limits services depend on it, and holding the
 * surface still is what let the port land without touching any of them. What changed is underneath: on
 * desktop the port is the Rust publisher, and in a browser it is `getDisplayMedia` published directly.</p>
 *
 * <p>The three singleton commands - stop, framerate, share-audio mute - take a `shareId` in the port and
 * take none here, so this holds {@link activeShareId} and supplies it. That is what makes the adapters'
 * validation useful: this service can only ever name the share it started, so a mismatch downstream is a
 * genuine mistake rather than a missing argument.</p>
 */
@Injectable({providedIn: 'root'})
export class RustMediaService {
    private readonly publisher = inject(ScreenPublisher);
    /**
     * The half of the host surface the port does not model - the canvas pipeline and the preview feed.
     *
     * <p>Null only for a stand-in that does not carry one (a spec's partial fake), which is why every
     * use of it is guarded rather than asserted.</p>
     */
    private readonly host: ScreenPublisherHost | null = hostFor(this.publisher);

    private loopbackCtx: AudioContext | null = null;
    private loopbackWorklet: AudioWorkletNode | null = null;
    private loopbackDest: MediaStreamAudioDestinationNode | null = null;

    private screenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    private screenCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    private screenStream: MediaStream | null = null;
    private latestFrame: ScreenFrame | null = null;
    private decodingFrame = false;

    /**
     * The browser display capture behind {@link startScreenCapture} on a host with no native pipeline.
     *
     * <p>Held because the video and the audio halves are asked for by two separate calls -
     * `startScreenCapture` then `startLoopbackCapture` - but a browser hands both back from one
     * `getDisplayMedia`, and there is no second picker prompt to be had.</p>
     */
    private displayCapture: {stream: MediaStream; video: MediaStreamTrack; audio: MediaStreamTrack | null} | null = null;

    private readonly _captureFps = signal(15);
    /** Currently requested capture rate (set via startScreenCapture / setCaptureFps). */
    readonly captureFps = this._captureFps.asReadonly();
    private readonly _captureGeometry = signal<CaptureGeometry>({width: 1920, height: 1080});
    /** Fixed output size for the running session. Solved once, before capture starts. */
    readonly captureGeometry = this._captureGeometry.asReadonly();
    private readonly _publishPreview = signal<string | null>(null);
    /**
     * Data URL of the sharer's own screen while the publisher owns the share.
     *
     * The publisher puts no MediaStream in the webview - neither the Rust one nor the web one - so the
     * local tile renders this instead: a low-rate thumbnail rather than the stream itself.
     */
    readonly publishPreview = this._publishPreview.asReadonly();
    private readonly _localPublishStream = signal<MediaStream | null>(null);
    /**
     * The running publish's own stream, decoded from the encoded frames Rust hands back.
     *
     * <p>The picture in the sharer's tile, and the reason {@link publishPreview} is now a fallback
     * rather than the only option: this is the H.264 the wire carries, at the share's real rate and
     * resolution, where the preview is a 480px JPEG five times a second. See
     * `local-stream-render.ts`.</p>
     *
     * <p>Null on a webview with no `VideoDecoder`, on the web publisher (whose local tile has the
     * display track itself), and between publishes. Every consumer therefore has to keep handling
     * the thumbnail - which is why the thumbnail keeps being sent.</p>
     */
    readonly localPublishStream = this._localPublishStream.asReadonly();
    /** The decoder behind {@link localPublishStream}, while a share is running. */
    private localRenderer: LocalStreamRenderer | null = null;
    /** Probed once per app lifetime: the answer cannot change, and every publish would ask again. */
    private h264Codec: Promise<string | null> | null = null;
    private localFpsInterval: ReturnType<typeof setInterval> | undefined;
    private readonly _previewPaused = signal(false);
    /**
     * Whether this window is behind another one - see {@link previewPaused}, which folds it in.
     *
     * <p>Tracked separately from the idle pause because the two are undone by different things. Idle
     * is cleared by a click on the paused card; this one is cleared by the window coming back to the
     * front, and nothing else can clear it - a click on the card is only reachable with the window
     * already focused, so the two can never disagree about what the user just did.</p>
     */
    private readonly _windowBackgrounded = signal(false);
    /**
     * True while frames are not being applied to {@link publishPreview}.
     *
     * <p>Two independent reasons, either of which is enough: nobody has been looking at the preview
     * for {@link PREVIEW_IDLE_MS}, or this window is not the one in front of the user
     * ({@link _windowBackgrounded}). The stream itself is unaffected by both - only the local render
     * stops.</p>
     *
     * <p>Gated on a preview actually existing, so the flag never claims a pause for a share with
     * nothing to freeze. Backgrounding while a share's first frame is still on its way must leave
     * that frame free to land, or the share would be frozen over nothing for its whole lifetime with
     * no card to click - the same rule {@link reconsiderPreviewIdle} follows for the idle half.</p>
     *
     * <p>{@link publishPreview} is left holding whatever frame it last had rather than being reset
     * to null, so a consumer can tell "paused" from "no share at all" and render the two
     * completely differently - a paused card only makes sense over a frozen frame, never floating
     * in a call nobody is sharing in. Frames keep crossing the IPC boundary from Rust exactly as
     * before; only whether the webview applies them changes - see {@link claimPreviewRender}.</p>
     */
    readonly previewPaused = computed(() =>
        this._publishPreview() !== null && (this._previewPaused() || this._windowBackgrounded()));
    /** Renderers currently claiming "I am showing the preview" - see {@link claimPreviewRender}. */
    private readonly previewClaimants = new Set<object>();
    private previewIdleTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _inboundFps = signal(0);
    /** Frames received from the native pipeline per second. Stays 0 where frames never enter the webview. */
    readonly inboundFps = this._inboundFps.asReadonly();
    private readonly _renderedFps = signal(0);
    /** Frames drawn to the canvas per second (after decode). */
    readonly renderedFps = this._renderedFps.asReadonly();
    private inboundFrameCount = 0;
    private renderedFrameCount = 0;
    private fpsInterval?: ReturnType<typeof setInterval>;

    /** The share {@link startScreenPublish} last opened, or null when nothing is publishing. */
    private activeShareId: string | null = null;

    private readonly _screenAudioOutcome = signal<ScreenAudioOutcome>('off');
    /**
     * Whether the running share's audio was asked for, published, or asked for and unavailable.
     *
     * <p>Three states because "not requested" and "requested and impossible" must not read the same. The
     * second one is a thing to tell the user: screen audio is Chromium-only and tab/window-scoped in a
     * browser, and needs a usable loopback device on desktop, so a share that quietly dropped the audio
     * half is exactly the failure this reports. `localScreenHasAudio` answers the narrower question of
     * whether a track exists.</p>
     */
    readonly screenAudioOutcome = this._screenAudioOutcome.asReadonly();

    private readonly publishEndedSignal = new Subject<void>();
    /**
     * The publisher's share ended without being asked to.
     *
     * <p>Fires when a web user stops the share from the browser's own capture bar - the primary way a
     * share ends in a browser, and one that does not go through the app at all.</p>
     *
     * <p>This is a singleton, so it fires for whichever publish ended rather than for any one caller's.
     * A subscriber that owns "am I sharing" UI state must therefore check that the running publish is
     * <i>its own</i> before acting - see `VoiceRTCService`, which gates the forward on `rustPublishing`.
     * <b>`call-session.service.ts` does not forward this yet:</b> a 1:1 call share stopped from the
     * browser bar still leaves that button lit while the publish is gone.</p>
     */
    readonly publishEnded$ = this.publishEndedSignal.asObservable();

    /** Bound once so it can be handed to both `addEventListener` and `removeEventListener` - see the
     *  `ngOnDestroy` cleanup this class does not have, but `DestroyRef.onDestroy` below does. */
    private readonly onVisibilityChange = (): void => this.reconsiderPreviewIdle();

    /**
     * The window went behind something else. Acted on at once rather than through the idle timer -
     * "is this window in front of you" is answered the moment it changes, and waiting
     * {@link PREVIEW_IDLE_MS} to act on it would decode thirty seconds of frames per alt-tab.
     */
    private readonly onWindowBlur = (): void => this._windowBackgrounded.set(true);

    /**
     * The window came back. Resumes on its own - the user asked for the app, not for a frozen
     * picture of their own screen - and re-arms the idle clock, which was deliberately never
     * running while backgrounded.
     */
    private readonly onWindowFocus = (): void => {
        this._windowBackgrounded.set(false);
        this.reconsiderPreviewIdle();
    };

    constructor() {
        this.host?.onPreviewFrame(dataUrl => {
            // Paused means "stop applying" specifically. The frame still crossed the IPC boundary
            // from Rust - that side is untouched, see the class doc on previewPaused - only the
            // webview declines to do anything with it.
            if (this.previewPaused()) return;
            this._publishPreview.set(dataUrl);
            // The first frame is what makes a share pausable at all - see reconsiderPreviewIdle's own
            // guard. Re-evaluating here, not just from startScreenPublish, is what starts the idle
            // clock for a share whose first frame arrives after publish already returned.
            this.reconsiderPreviewIdle();
        });
        // Registered once, for the life of the service, exactly like the preview sink above: the
        // adapter replaces its channel per publish, and a handler re-registered per share would be
        // one more thing to get wrong on the resolution-change path that stops and restarts one.
        this.host?.onPublishChunk(chunk => this.localRenderer?.push(chunk));

        this.host?.onPublishEnded(() => {
            this._publishPreview.set(null);
            this.closeLocalRenderer();
            this.activeShareId = null;
            this._screenAudioOutcome.set('off');
            this.resetPreviewPause();
            this.publishEndedSignal.next();
        });

        // The pause, applied where it actually saves something. The thumbnail's pause only stops
        // the webview *applying* frames that cross the boundary regardless - affordable at 5 fps of
        // JPEG, and not at all affordable for a feed carrying the share's whole bitrate. So this
        // one reaches back into Rust and stops the frames being sent.
        //
        // `interrupt()` before the round trip, not after: frames already queued on this side were
        // encoded against references the decoder is about to stop following.
        effect(() => {
            const paused = this.previewPaused();
            if (!this.localRenderer) return;
            if (paused) this.localRenderer.interrupt();
            void this.host?.setLocalStreamEnabled(!paused)
                .catch(e => console.warn('[screen] toggling the local stream failed', e));
        });

        // The other half of what drives the idle pause, alongside the render claims - see
        // reconsiderPreviewIdle. A root singleton lives for the app's whole lifetime in production,
        // so this never needed removing there - but ~110 TestBed instantiations across the suite each
        // leak one onto `document` without it, so it is torn down like any other listener would be.
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        // `visibilitychange` alone misses the ordinary case: on a desktop window it flips on
        // minimise, not when another window simply comes to the front. Sharing your screen and then
        // switching to the thing you are sharing is exactly that case, and it is the one moment
        // nobody can possibly be looking at the preview.
        window.addEventListener('blur', this.onWindowBlur);
        window.addEventListener('focus', this.onWindowFocus);
        inject(DestroyRef).onDestroy(() => {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
            window.removeEventListener('blur', this.onWindowBlur);
            window.removeEventListener('focus', this.onWindowFocus);
        });
    }

    /**
     * Returns true where the microphone has to be captured natively rather than with `getUserMedia` -
     * Linux, where WebKitGTK answers `getUserMedia` with a permission denial no prompt can clear.
     */
    async shouldUseRustAudio(): Promise<boolean> {
        return await this.host?.prefersNativeAudioCapture() ?? false;
    }

    // ── Screen sources ────────────────────────────────────────────────────────

    /**
     * Every shareable screen and window, without thumbnails.
     *
     * <p>Metadata only, and fast: capturing a preview of each is a full-resolution grab per source
     * and used to hold the dialog for tens of seconds on a busy desktop. Images are fetched per
     * tile - see {@link captureSourceThumbnails}. Empty in a browser, where windows cannot be
     * enumerated at all and the host's own picker is the enumerator.</p>
     */
    getScreenSources(): Promise<ScreenSource[]> {
        return this.publisher.sources();
    }

    /**
     * Thumbnails for the named sources. Batches are capped host-side; an id that could not be
     * captured comes back with an empty string rather than being dropped, so a caller can tell
     * "failed" from "not asked for yet".
     */
    captureSourceThumbnails(sourceIds: string[]): Promise<SourceThumbnail[]> {
        return this.publisher.thumbnails(sourceIds);
    }

    // ── Screen capture ────────────────────────────────────────────────────────

    /**
     * Start screen capture for the given source at a fixed output size.
     *
     * Returns a MediaStreamTrack. The geometry must already be solved (see {@link solveGeometry}) - it is
     * locked in for the life of the session.
     *
     * <p>Two pipelines behind one signature. On a host with native capture the frames arrive as JPEGs and
     * are decoded onto a canvas whose capture stream is the track. In a browser the display track *is*
     * the track, so there is no round trip - and `sourceId` is ignored, because the host picker that
     * `getDisplayMedia` opens is what chooses the source.</p>
     */
    async startScreenCapture(sourceId: string, geometry: CaptureGeometry, fps = 30): Promise<MediaStreamTrack> {
        await this.stopScreenCapture();

        this._captureFps.set(fps);
        this._captureGeometry.set(geometry);

        if (!this.host?.nativeCapture) return this.startDisplayCapture(geometry, fps);

        this.inboundFrameCount = 0;
        this.renderedFrameCount = 0;
        this.fpsInterval = setInterval(() => {
            this._inboundFps.set(this.inboundFrameCount);
            this._renderedFps.set(this.renderedFrameCount);
            this.inboundFrameCount = 0;
            this.renderedFrameCount = 0;
        }, 1000);

        // Sized once, from the solved geometry, and never resized. Resizing a canvas that
        // captureStream() is already attached to changes the track's dimensions mid-session, which
        // forces a renegotiation and a keyframe - that is what used to tear the stream whenever a
        // shared window was resized, and what made the first frame's size decide the aspect ratio.
        const canvas = document.createElement('canvas');
        canvas.width = geometry.width;
        canvas.height = geometry.height;
        const ctx = canvas.getContext('2d')!;
        this.screenCanvas = canvas;
        this.screenCtx = ctx;

        // captureStream(0) = manual control; we call requestFrame() after each draw
        // so the video track only produces a new frame when the canvas is actually updated.
        const stream = (canvas as HTMLCanvasElement).captureStream(0);
        this.screenStream = stream;

        await this.host.startNativeScreenCapture(sourceId, geometry, fps, frame => {
            this.inboundFrameCount++;
            this.queueFrame(frame);
        });

        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No video track from canvas');
        // 'detail' - screen content is text and UI. Paired with maintain-resolution degradation on
        // the sender (see applyScreenEncoding), the encoder drops frames under congestion instead
        // of shedding resolution. The old 'motion' hint did the opposite, which is why streams
        // looked soft and took tens of seconds to sharpen. That combination previously starved
        // framerate only because bitrate was chosen independently of resolution and fps; the
        // stream preset now couples all three.
        try {
            (track as {contentHint?: string}).contentHint = 'detail';
        } catch {
        }
        return track;
    }

    // ── Publishing ────────────────────────────────────────────────────────────

    /**
     * Capture, encode and publish a screen source through the host's publisher.
     *
     * Unlike {@link startScreenCapture} this returns no MediaStream: on desktop frames never enter the
     * webview at all, and the web publisher keeps its track on its own peer connection. The resolved ids
     * are what other clients subscribe to, exactly as they would for a track the webview published.
     */
    async startScreenPublish(options: ScreenPublishOptions): Promise<ScreenPublishResult> {
        // A pause from whatever previously held activeShareId must not survive into this one - without
        // this, a second publish starting while an earlier paused share was still active would begin
        // already paused, frozen over the old share's last frame.
        this.resetPreviewPause();
        // Same reasoning, one layer down: a resolution change stops and restarts the publish, and a
        // decoder still holding the old geometry would letterbox the new share into the old frame.
        this.closeLocalRenderer();

        // Settled before the publish, because the answer decides what Rust is asked to send. A host
        // that cannot decode must not be sent a feed it can only throw away.
        const codec = await (this.h264Codec ??= pickH264Codec());
        const result = await this.publisher.start({...options, localStream: codec !== null});
        this.activeShareId = options.shareId;
        if (codec !== null) this.openLocalRenderer(options, codec);
        // Derived from both halves, because that is the only place both facts are in hand: what the user
        // asked for, and what came back.
        this._screenAudioOutcome.set(
            !options.shareAudio ? 'off' : result.audioTrackName === null ? 'unavailable' : 'published',
        );
        // Usually a no-op here - reconsiderPreviewIdle's own guard holds off arming the clock until
        // publishPreview has a first frame (see onPreviewFrame). Called anyway so stale claim or
        // visibility state left over from before this publish started is picked up immediately
        // rather than waiting for whatever next touches a claim or the window's visibility.
        this.reconsiderPreviewIdle();
        return result;
    }

    /**
     * Resumes the preview after an idle pause - the button on the paused card, or any other
     * interaction with it.
     *
     * <p>Clears the paused flag only. Whether the feed goes straight back to landing frames or has
     * to wait out another idle window before it can pause again depends on the render claims and
     * window visibility exactly as it did before pausing - see {@link reconsiderPreviewIdle}.</p>
     */
    resumePreview(): void {
        this._previewPaused.set(false);
        this.reconsiderPreviewIdle();
    }

    /**
     * Declares that `token` is (or is no longer) rendering {@link publishPreview} on screen.
     *
     * <p>Idempotent, and meant to be driven from a signal effect - see the self-card, the share
     * tile and the sidebar live row, each of which owns one token for its own lifetime and calls
     * this from an `effect(onCleanup => ...)` so a renderer that stops showing the preview -
     * unmounts, or the thing it renders goes null - releases automatically rather than leaking a
     * claim that keeps the idle timer from ever starting.</p>
     */
    claimPreviewRender(token: object): void {
        this.previewClaimants.add(token);
        this.reconsiderPreviewIdle();
    }

    /** The inverse of {@link claimPreviewRender}. */
    releasePreviewRender(token: object): void {
        this.previewClaimants.delete(token);
        this.reconsiderPreviewIdle();
    }

    /**
     * Stand up the decoder for this publish and publish its stream.
     *
     * <p>Failure is not fatal and deliberately not surfaced: `onFailure` drops the stream, and every
     * consumer falls back to {@link publishPreview}, which is still arriving. A share whose local
     * decoder died is a worse preview, not a broken share.</p>
     */
    private openLocalRenderer(options: ScreenPublishOptions, codec: string): void {
        const renderer = new LocalStreamRenderer(
            options.width,
            options.height,
            codec,
            () => {
                // Only if it is still the current one: a renderer that failed after being replaced
                // must not take the replacement's stream down with it.
                if (this.localRenderer !== renderer) return;
                console.warn('[screen] the local stream decoder failed; falling back to the thumbnail');
                this.closeLocalRenderer();
            },
            () => {
                // Published only once there is a picture on the canvas. Consumers prefer the stream
                // over the thumbnail (see `localSharePicture`), so announcing it at construction
                // would swap a working thumbnail for an empty <video> for however long the first
                // keyframe takes - a black tile exactly at the moment a share starts.
                if (this.localRenderer !== renderer) return;
                this._localPublishStream.set(renderer.stream);
            },
        );
        this.localRenderer = renderer;

        // The fps readout on the local tile. Measured at the draw, not at the encoder, because what
        // it answers for the sharer is "is the picture I am looking at live" - and this is the one
        // number on this path that was previously always zero.
        this.localFpsInterval = setInterval(() => this._renderedFps.set(renderer.takeRenderedCount()), 1000);
    }

    private closeLocalRenderer(): void {
        clearInterval(this.localFpsInterval);
        this.localFpsInterval = undefined;
        if (!this.localRenderer) return;
        this.localRenderer.close();
        this.localRenderer = null;
        this._localPublishStream.set(null);
        this._renderedFps.set(0);
    }

    async stopScreenPublish(): Promise<void> {
        this._publishPreview.set(null);
        this.closeLocalRenderer();
        this._screenAudioOutcome.set('off');
        this.resetPreviewPause();
        const shareId = this.activeShareId;
        this.activeShareId = null;
        if (shareId === null) return;
        await this.publisher.stop(shareId).catch(e => console.warn('[screen] stopping the publish failed', e));
    }

    /**
     * Change the publisher's capture rate mid-stream.
     *
     * Framerate is the only part of a preset that changes without rebuilding the encoder, which is
     * fixed to one geometry and bitrate for its lifetime; a resolution change restarts the publish.
     */
    async setPublishFps(fps: number): Promise<void> {
        if (this.activeShareId === null) return;
        await this.publisher.setFps(this.activeShareId, fps)
            .catch(e => console.warn('[screen] setting the publish framerate failed', e));
    }

    /**
     * Mute the running share's own sound.
     *
     * Stops packets rather than the capture device, so unmuting is instant. A no-op on a share with
     * no audio half.
     */
    async setScreenAudioMuted(muted: boolean): Promise<void> {
        if (this.activeShareId === null) return;
        await this.publisher.setAudioMuted(this.activeShareId, muted)
            .catch(e => console.warn('[screen] muting the share audio failed', e));
    }

    /** Change capture FPS mid-stream without stopping/restarting. Takes effect within one frame. */
    async setCaptureFps(fps: number): Promise<void> {
        this._captureFps.set(fps);
        if (!this.host?.nativeCapture) {
            const video = this.displayCapture?.video;
            if (video) await retargetDisplayFps(video, Math.round(fps)).catch(() => {
            });
            return;
        }
        await this.host.setNativeCaptureFps(fps);
    }

    /**
     * Change the fixed output size mid-session.
     *
     * Unlike the per-frame resize this replaced, this is a deliberate act: it costs one
     * renegotiation and keyframe, and only happens when the user picks a different resolution.
     */
    async setCaptureGeometry(geometry: CaptureGeometry): Promise<void> {
        this._captureGeometry.set(geometry);
        if (this.screenCanvas) {
            this.screenCanvas.width = geometry.width;
            this.screenCanvas.height = geometry.height;
        }
        if (!this.host?.nativeCapture) {
            const video = this.displayCapture?.video;
            if (video) {
                await retargetDisplayGeometry(video, geometry.width, geometry.height).catch(() => {
                });
            }
            return;
        }
        await this.host.setNativeCaptureGeometry(geometry);
    }

    async stopScreenCapture(): Promise<void> {
        clearInterval(this.fpsInterval);
        this.fpsInterval = undefined;
        this._inboundFps.set(0);
        this._renderedFps.set(0);

        await this.host?.stopNativeScreenCapture();

        this.screenStream?.getTracks().forEach(t => t.stop());
        this.screenStream = null;
        this.screenCanvas = null;
        this.screenCtx = null;
        this.latestFrame = null;
        this.decodingFrame = false;

        // Both halves, because in a browser they are one capture: the audio track is not a device this
        // opened separately, it is part of the source the user picked, and it ends with the picture.
        this.displayCapture?.stream.getTracks().forEach(t => t.stop());
        this.displayCapture = null;
    }

    // ── System audio (loopback) capture ───────────────────────────────────────
    //
    // The only capture path left in the webview. The microphone moved to the Rust voice session,
    // which captures, processes, encodes and publishes without a worklet or an AudioContext; this
    // one stays because a screen share's audio is still published from here.

    async startLoopbackCapture(): Promise<MediaStreamTrack> {
        await this.stopLoopbackCapture();

        if (!this.host?.nativeCapture) {
            // A browser has no loopback device at all: the only system audio it will ever hand over is
            // the audio of the source the user picked in the display-capture prompt, which is Chromium
            // only and scoped to a tab or a window. Throwing is what makes the caller fall back to a
            // video-only share and say so - answering with a silent track would be the quiet failure.
            const audio = this.displayCapture?.audio;
            if (!audio) throw new Error('This browser did not provide audio for the captured source.');
            return audio;
        }

        const ctx = new AudioContext({sampleRate: 48_000});
        this.loopbackCtx = ctx;
        await ctx.resume();

        await ctx.audioWorklet.addModule('/assets/audio-capture-processor.js');

        const worklet = new AudioWorkletNode(ctx, 'audio-capture-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        this.loopbackWorklet = worklet;

        const destination = ctx.createMediaStreamDestination();
        this.loopbackDest = destination;
        worklet.connect(destination);

        await this.host.startNativeLoopbackCapture(chunk => this.feedLoopback(chunk));

        const track = destination.stream.getAudioTracks()[0];
        if (!track) throw new Error('No audio track from loopback worklet');
        return track;
    }

    async stopLoopbackCapture(): Promise<void> {
        await this.host?.stopNativeLoopbackCapture();
        this.loopbackWorklet?.disconnect();
        this.loopbackWorklet = null;
        this.loopbackDest = null;
        this.loopbackCtx?.close().catch(() => {
        });
        this.loopbackCtx = null;

        // The browser capture is deliberately *not* touched here. Its audio track is part of the display
        // capture rather than a device this opened, so `stopScreenCapture` owns both halves - and
        // `startLoopbackCapture` calls this first, so releasing it here would stop the very track that
        // call is about to return.
    }

    /**
     * Open the browser's display capture and keep both halves of it.
     *
     * <p>One prompt, two consumers: the video track is returned here and the audio track - if the host
     * gave one - is what {@link startLoopbackCapture} hands back afterwards. Asking twice would put a
     * second picker in front of the user for a share they already chose.</p>
     */
    private async startDisplayCapture(geometry: CaptureGeometry, fps: number): Promise<MediaStreamTrack> {
        const capture = await captureDisplay({
            width: geometry.width,
            height: geometry.height,
            fps,
            // Asked for unconditionally, because this pipeline's two halves are opened by two separate
            // calls and the audio decision is not known here. A host that offers no audio simply gives
            // none, which `startLoopbackCapture` then reports.
            audio: true,
        });
        this.displayCapture = {stream: capture.stream, video: capture.video, audio: capture.audio};
        return capture.video;
    }

    // ── Idle preview pause ───────────────────────────────────────────────────

    private isPreviewActive(): boolean {
        return !document.hidden && this.previewClaimants.size > 0;
    }

    /**
     * Re-evaluates the idle timer against the current render claims and window visibility.
     *
     * <p>Only ever schedules a pause while a share is actually publishing - {@link activeShareId}
     * null means there is nothing to pause, and letting the timer run anyway would eventually flip
     * {@link previewPaused} true with no share behind it, which no consumer could render sanely
     * (they all gate the paused card on {@link publishPreview} already being non-null, but the flag
     * itself would still be a lie).</p>
     *
     * <p>Equally, never schedules one before {@link publishPreview} holds a first frame. A share
     * whose first frame simply hasn't arrived yet - a slow encoder start, a browser publish that
     * produces no preview at all - must not have the clock ticking against it: once the timer fires,
     * `onPreviewFrame` starts dropping every frame it is handed (paused means "stop applying"), so a
     * share paused before it ever had a preview would have no frame to fall back to and no way out,
     * for its whole lifetime. See `onPreviewFrame`'s own call back into this method for the other
     * half - what (re)starts the clock once that first frame does land.</p>
     */
    private reconsiderPreviewIdle(): void {
        if (this.activeShareId === null) return;
        if (this._publishPreview() === null) return;

        if (this.isPreviewActive()) {
            this.clearPreviewIdleTimer();
            return;
        }
        // Already paused, or already counting down to it - either way there is nothing new to
        // schedule. Resuming while still inactive (resumePreview called from somewhere that is not
        // actually visible/claimed) falls through here too, and correctly starts the next countdown.
        if (this.previewPaused() || this.previewIdleTimer !== null) return;
        this.previewIdleTimer = setTimeout(() => {
            this.previewIdleTimer = null;
            this._previewPaused.set(true);
        }, PREVIEW_IDLE_MS);
    }

    private clearPreviewIdleTimer(): void {
        if (this.previewIdleTimer === null) return;
        clearTimeout(this.previewIdleTimer);
        this.previewIdleTimer = null;
    }

    /** A share starting or ending gets a clean slate - a pause from the last one must not survive
     *  into the next. */
    private resetPreviewPause(): void {
        this._previewPaused.set(false);
        this.clearPreviewIdleTimer();
    }

    // pick up the latest frame when it finishes instead of dropping it.
    private queueFrame(frame: ScreenFrame): void {
        this.latestFrame = frame;
        if (!this.decodingFrame) this.decodeNextFrame();
    }

    // ── Loopback (system audio) capture ──────────────────────────────────────

    private decodeNextFrame(): void {
        const frame = this.latestFrame;
        if (!frame || !this.screenCtx || !this.screenCanvas) {
            this.decodingFrame = false;
            return;
        }
        this.latestFrame = null;
        this.decodingFrame = true;
        createImageBitmap(base64ToBlob(frame.data, 'image/jpeg'))
            .then(bitmap => {
                if (!this.screenCtx || !this.screenCanvas) {
                    bitmap.close();
                    return;
                }
                const c = this.screenCanvas as HTMLCanvasElement;
                const ctx = this.screenCtx as CanvasRenderingContext2D;
                // The canvas size is fixed for the session. A source whose own aspect ratio drifts
                // - a window being resized or maximised mid-share - is letterboxed into the fixed
                // frame rather than changing the track's dimensions.
                const scale = Math.min(c.width / bitmap.width, c.height / bitmap.height);
                const dw = bitmap.width * scale;
                const dh = bitmap.height * scale;
                if (dw < c.width || dh < c.height) {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, c.width, c.height);
                }
                ctx.drawImage(bitmap, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
                // Signal a new frame to the video track (captureStream(0) only captures on demand).
                (this.screenStream?.getVideoTracks()[0] as any)?.requestFrame?.();
                this.renderedFrameCount++;
                bitmap.close();
                this.decodingFrame = false;
                if (this.latestFrame) this.decodeNextFrame();
            })
            .catch(() => {
                this.decodingFrame = false;
                if (this.latestFrame) this.decodeNextFrame();
            });
    }

    private feedLoopback(chunk: AudioChunk): void {
        if (!this.loopbackWorklet) return;
        try {
            const raw = base64ToArrayBuffer(chunk.data);
            this.loopbackWorklet.port.postMessage({type: 'samples', buffer: raw}, [raw]);
        } catch { /* ignore */
        }
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function base64ToArrayBuffer(b64: string): ArrayBuffer {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

function base64ToBlob(b64: string, mime: string): Blob {
    const bytes = base64ToArrayBuffer(b64);
    return new Blob([bytes], {type: mime});
}
