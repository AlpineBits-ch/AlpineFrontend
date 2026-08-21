import {computed, DestroyRef, effect, inject, Injectable, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {CaptureGeometry} from '../models/capture-geometry';
import {StreamContent, StreamPreset} from '../models/stream-preset';
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
import {kbpsBetween, StreamLayerSample, StreamStatsSnapshot} from '../shared/call/stream-stats';

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

/** The retypeable half of a publish: everything {@link ScreenPublisher.setSpec} can change without ending it. */
export interface PublishSpec {
    width: number;
    height: number;
    kbps: number;
    content: StreamContent;
}

export interface ScreenPublishOptions {
    /** Which source to capture. Ignored by the web publisher, whose own `getDisplayMedia` picker chooses the source. */
    sourceId: string;
    shareId: string;
    width: number;
    height: number;
    fps: number;
    kbps: number;
    /** What is being shared, which decides what the encoder gives up under pressure. */
    content: StreamContent;
    iceServers: IceServerConfig[];
    /** The SFU connection the share publishes on: the microphone's own, so the share lands on the same participant rather than a second identity. */
    livekit: {url: string; token: string};
    apiBase: string;
    token: string;
    /** Same `X-Device-Id` the webview sends; Rust must not appear as a second device. */
    deviceId: string;
    /** Guild voice supplies guildId + channelId; a DM call supplies callId instead. */
    guildId?: string;
    channelId?: string;
    callId?: string;
    /** Capture the system's audio too, as a second `screen-audio-{shareId}` track. A request, not a guarantee: {@link ScreenPublishResult.audioTrackName} says what actually happened. */
    shareAudio: boolean;
    /** Send a copy of the encoded stream back for the sharer's own tile to decode. A capability answer, not a preference: true only where this webview can decode H.264. */
    localStream?: boolean;
    /** The preset the geometry and bitrate above were solved from. Not forwarded to Rust, and nothing derives geometry from it a second time. */
    preset?: StreamPreset;
}

/** How long the local preview goes unclaimed, with nobody rendering it, before frames stop being applied. */
export const PREVIEW_IDLE_MS = 30_000;

/** How long the preview keeps running after this window goes behind another one. */
export const BACKGROUND_IDLE_MS = 120_000;

export interface ScreenPublishResult {
    mediaSessionId: string;
    trackName: string;
    /** The share's audio track, or null when it has none: what was published, not what was asked for, so viewers never subscribe to a track that does not exist. */
    audioTrackName: string | null;
    /** Which encoder was selected: 'media-foundation', 'openh264', or 'browser' on web. */
    encoder: string;
}

/** Screen capture and publishing, as the rest of the app sees it: a delegate over the {@link ScreenPublisher} port. */
@Injectable({providedIn: 'root'})
export class RustMediaService {
    private readonly publisher = inject(ScreenPublisher);
    /** The half of the host surface the port does not model: the canvas pipeline and the preview feed. Null for a spec's partial fake, so every use is guarded. */
    private readonly host: ScreenPublisherHost | null = hostFor(this.publisher);

    private loopbackCtx: AudioContext | null = null;
    private loopbackWorklet: AudioWorkletNode | null = null;
    private loopbackDest: MediaStreamAudioDestinationNode | null = null;

    private screenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    private screenCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    private screenStream: MediaStream | null = null;
    private latestFrame: ScreenFrame | null = null;
    private decodingFrame = false;

    /** The browser display capture behind {@link startScreenCapture} on a host with no native pipeline. Both halves are held because one `getDisplayMedia` serves two separate calls. */
    private displayCapture: {
        stream: MediaStream;
        video: MediaStreamTrack;
        audio: MediaStreamTrack | null;
    } | null = null;

    private readonly _captureFps = signal(15);
    /** Currently requested capture rate (set via startScreenCapture / setCaptureFps). */
    readonly captureFps = this._captureFps.asReadonly();
    private readonly _captureGeometry = signal<CaptureGeometry>({width: 1920, height: 1080});
    /** Fixed output size for the running session. Solved once, before capture starts. */
    readonly captureGeometry = this._captureGeometry.asReadonly();
    private readonly _publishPreview = signal<string | null>(null);
    /** Data URL of the sharer's own screen while the publisher owns the share: a low-rate thumbnail rather than the stream itself. */
    readonly publishPreview = this._publishPreview.asReadonly();
    private readonly _localPublishStream = signal<MediaStream | null>(null);
    /** The running publish's own stream, decoded from the encoded frames Rust hands back. Null with no `VideoDecoder`, on the web publisher, and between publishes, so every consumer must still handle the thumbnail. */
    readonly localPublishStream = this._localPublishStream.asReadonly();
    /** The decoder behind {@link localPublishStream}, while a share is running. */
    private localRenderer: LocalStreamRenderer | null = null;
    /** Probed once per app lifetime: the answer cannot change, and every publish would ask again. */
    private h264Codec: Promise<string | null> | null = null;
    private localFpsInterval: ReturnType<typeof setInterval> | undefined;
    private readonly _previewPaused = signal(false);
    /** Whether this window is behind another one. */
    private windowBlurred = false;
    /** True while frames are not being applied to {@link publishPreview}: a latch, and only {@link resumePreview} clears it. */
    readonly previewPaused = computed(() => this._publishPreview() !== null && this._previewPaused());
    /** Renderers currently claiming "I am showing the preview" - see {@link claimPreviewRender}. */
    private readonly previewClaimants = new Set<object>();
    private previewIdleTimer: ReturnType<typeof setTimeout> | null = null;
    /** When {@link previewIdleTimer} is due, as a wall-clock instant: a backgrounded renderer's `setTimeout` wakes at minute granularity, so the timer alone cannot be trusted. */
    private previewPauseAt: number | null = null;
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

    private readonly _outboundStats = signal<StreamStatsSnapshot | null>(null);
    /** Live statistics for this client's own publish, or null when nothing is being inspected. */
    readonly outboundStats = this._outboundStats.asReadonly();
    private outboundInterval?: ReturnType<typeof setInterval>;
    /** The previous sample's cumulative bytes, by rid, so a rate can be differentiated out. */
    private prevOutboundBytes = new Map<string, number>();
    private prevOutboundAt = 0;

    /** What the running publish was opened with, kept so the local decoder can be rebuilt against it. */
    private lastPublishOptions: ScreenPublishOptions | null = null;

    private readonly _screenAudioOutcome = signal<ScreenAudioOutcome>('off');
    /** Whether the running share's audio was asked for, published, or asked for and unavailable. Three states, because "not requested" and "requested and impossible" must not read the same. */
    readonly screenAudioOutcome = this._screenAudioOutcome.asReadonly();

    private readonly publishEndedSignal = new Subject<void>();
    /** The publisher's share ended without being asked to. A singleton, so a subscriber must check the ended publish is its own before acting. */
    readonly publishEnded$ = this.publishEndedSignal.asObservable();

    /** Bound once so the same reference reaches both `addEventListener` and `removeEventListener`. */
    private readonly onVisibilityChange = (): void => this.reconsiderPreviewIdle();

    /** The window went behind something else. Starts the {@link BACKGROUND_IDLE_MS} countdown rather than pausing on the spot. */
    private readonly onWindowBlur = (): void => {
        this.windowBlurred = true;
        this.reconsiderPreviewIdle();
    };

    /** The window came back. Cancels a countdown that has not fired yet; a pause that already latched stays until {@link resumePreview}. */
    private readonly onWindowFocus = (): void => {
        this.windowBlurred = false;
        this.reconsiderPreviewIdle();
    };

    constructor() {
        this.host?.onPreviewFrame(dataUrl => {
            // Paused means "stop applying" specifically: the frame still crosses the IPC boundary.
            if (this.previewPaused()) return;
            this._publishPreview.set(dataUrl);
            // The first frame is what makes a share pausable at all, so this starts the idle clock for a share whose first frame arrives after publish returned.
            this.reconsiderPreviewIdle();
        });
        // Registered once for the life of the service; the adapter replaces its channel per publish.
        this.host?.onPublishChunk(chunk => this.localRenderer?.push(chunk));

        this.host?.onPublishEnded(() => {
            this._publishPreview.set(null);
            this.closeLocalRenderer();
            this.activeShareId = null;
            this.lastPublishOptions = null;
            this._screenAudioOutcome.set('off');
            this.resetPreviewPause();
            this.inspectOutbound(false);
            this.publishEndedSignal.next();
        });

        // Unlike the thumbnail's pause, this reaches back into Rust and stops the frames being sent.
        // `interrupt()` before the round trip, not after: frames already queued on this side were encoded against references the decoder is about to stop following.
        effect(() => {
            const paused = this.previewPaused();
            if (!this.localRenderer) return;
            if (paused) this.localRenderer.interrupt();
            void this.host
                ?.setLocalStreamEnabled(!paused)
                .catch(e => console.warn('[screen] toggling the local stream failed', e));
        });

        // Torn down below because ~110 TestBed instantiations across the suite each leak one onto `document` otherwise.
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        // `visibilitychange` alone misses a window merely going behind another one: it flips on minimise only.
        window.addEventListener('blur', this.onWindowBlur);
        window.addEventListener('focus', this.onWindowFocus);
        inject(DestroyRef).onDestroy(() => {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
            window.removeEventListener('blur', this.onWindowBlur);
            window.removeEventListener('focus', this.onWindowFocus);
        });
    }

    /** True where the microphone must be captured natively: Linux, where WebKitGTK answers `getUserMedia` with a permission denial no prompt can clear. */
    async shouldUseRustAudio(): Promise<boolean> {
        return (await this.host?.prefersNativeAudioCapture()) ?? false;
    }

    // ── Screen sources ────────────────────────────────────────────────────────

    /** Every shareable screen and window, without thumbnails. Empty in a browser, where the host's own picker is the enumerator. */
    getScreenSources(): Promise<ScreenSource[]> {
        return this.publisher.sources();
    }

    /** Thumbnails for the named sources; an id that could not be captured comes back with an empty string rather than being dropped. */
    captureSourceThumbnails(sourceIds: string[]): Promise<SourceThumbnail[]> {
        return this.publisher.thumbnails(sourceIds);
    }

    // ── Screen capture ────────────────────────────────────────────────────────

    /** Start screen capture for the given source at a fixed output size. The geometry must already be solved and is locked in for the life of the session. */
    async startScreenCapture(
        sourceId: string,
        geometry: CaptureGeometry,
        fps = 30,
    ): Promise<MediaStreamTrack> {
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

        // Sized once from the solved geometry and never resized: resizing a canvas `captureStream()` is attached to changes the track's dimensions mid-session and forces a renegotiation and a keyframe.
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
        // An opening value only: `applyScreenEncoding` sets the governing hint from the share's content mode on this same track once the sender exists.
        try {
            (track as {contentHint?: string}).contentHint = 'detail';
        } catch {
            // Not every engine exposes contentHint; the sender-side hint is applied regardless.
        }
        return track;
    }

    // ── Publishing ────────────────────────────────────────────────────────────

    /** Capture, encode and publish a screen source through the host's publisher. Unlike {@link startScreenCapture} this returns no MediaStream. */
    async startScreenPublish(options: ScreenPublishOptions): Promise<ScreenPublishResult> {
        // A pause from the previous share must not survive into this one, or the new publish begins already frozen over the old share's last frame.
        this.resetPreviewPause();
        // Same reasoning one layer down: a decoder still holding the previous share's geometry would letterbox this one into the old frame.
        this.closeLocalRenderer();

        // Settled before the publish, because the answer decides what Rust is asked to send.
        const codec = await (this.h264Codec ??= pickH264Codec());
        const result = await this.publisher.start({...options, localStream: codec !== null});
        this.activeShareId = options.shareId;
        this.lastPublishOptions = options;
        if (codec !== null) this.openLocalRenderer(options, codec);
        // Derived from both halves: what the user asked for, and what came back.
        this._screenAudioOutcome.set(
            !options.shareAudio ? 'off' : result.audioTrackName === null ? 'unavailable' : 'published',
        );
        // Usually a no-op, but called anyway so stale claim or visibility state from before this publish is picked up immediately.
        this.reconsiderPreviewIdle();
        return result;
    }

    /** Resumes the preview. The only thing that lifts the pause latch. */
    resumePreview(): void {
        this._previewPaused.set(false);
        this.reconsiderPreviewIdle();
    }

    /** Declares that `token` is (or is no longer) rendering {@link publishPreview}. Idempotent; drive it from an `effect(onCleanup => ...)` so a claim is never leaked and the idle timer can start. */
    claimPreviewRender(token: object): void {
        this.previewClaimants.add(token);
        this.reconsiderPreviewIdle();
    }

    /** The inverse of {@link claimPreviewRender}. */
    releasePreviewRender(token: object): void {
        this.previewClaimants.delete(token);
        this.reconsiderPreviewIdle();
    }

    /** Stand up the decoder for this publish and publish its stream. Failure is not fatal: consumers fall back to {@link publishPreview}. */
    private openLocalRenderer(options: ScreenPublishOptions, codec: string): void {
        const renderer = new LocalStreamRenderer(
            options.width,
            options.height,
            codec,
            () => {
                // Only if it is still the current one: a replaced renderer must not take its replacement's stream down with it.
                if (this.localRenderer !== renderer) return;
                console.warn('[screen] the local stream decoder failed; falling back to the thumbnail');
                this.closeLocalRenderer();
            },
            () => {
                // Published only once there is a picture on the canvas; announcing at construction would show a black tile until the first keyframe lands.
                if (this.localRenderer !== renderer) return;
                this._localPublishStream.set(renderer.stream);
            },
        );
        this.localRenderer = renderer;

        // The fps readout on the local tile, measured at the draw rather than at the encoder.
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
        this.lastPublishOptions = null;
        if (shareId === null) return;
        await this.publisher
            .stop(shareId)
            .catch(e => console.warn('[screen] stopping the publish failed', e));
    }

    /** Change the publisher's capture rate mid-stream. Lands within one frame. */
    async setPublishFps(fps: number): Promise<void> {
        if (this.activeShareId === null) return;
        await this.publisher
            .setFps(this.activeShareId, fps)
            .catch(e => console.warn('[screen] setting the publish framerate failed', e));
    }

    /** Retype the running publish: resolution, bitrate and content mode. The publish is not restarted, and the local decoder is rebuilt here because one holding the old geometry letterboxes the new picture. */
    async setPublishSpec(spec: PublishSpec): Promise<void> {
        const shareId = this.activeShareId;
        if (shareId === null) return;

        await this.publisher
            .setSpec(shareId, spec)
            .catch(e => console.warn('[screen] retyping the publish failed', e));

        // Only where one was open; the thumbnail carries its own dimensions per frame.
        const options = this.lastPublishOptions;
        if (!this.localRenderer || !options) return;
        const codec = await this.h264Codec;
        if (!codec) return;

        const updated = {...options, ...spec};
        this.lastPublishOptions = updated;
        // A mode change moves no dimension, so rebuilding would blank the sharer's own tile until the next keyframe for nothing.
        if (spec.width === options.width && spec.height === options.height) return;
        this.closeLocalRenderer();
        this.openLocalRenderer(updated, codec);
    }

    /** Mute the running share's own sound. Stops packets rather than the capture device, so unmuting is instant. */
    async setScreenAudioMuted(muted: boolean): Promise<void> {
        if (this.activeShareId === null) return;
        await this.publisher
            .setAudioMuted(this.activeShareId, muted)
            .catch(e => console.warn('[screen] muting the share audio failed', e));
    }

    /** Start or stop polling the running publish's statistics. Stopping clears the snapshot and the previous sample, so a reopened panel differentiates from a fresh baseline. */
    inspectOutbound(on: boolean): void {
        clearInterval(this.outboundInterval);
        this.outboundInterval = undefined;
        this.prevOutboundBytes.clear();
        this.prevOutboundAt = 0;
        this._outboundStats.set(null);
        if (on) this.outboundInterval = setInterval(() => void this.pollOutbound(), 1000);
    }

    private async pollOutbound(): Promise<void> {
        const shareId = this.activeShareId;
        if (!shareId || !this.host) return;

        const snapshot = await this.publisher.stats(shareId);
        if (!snapshot) {
            this._outboundStats.set(null);
            return;
        }

        const now = Date.now();
        const dt = this.prevOutboundAt ? (now - this.prevOutboundAt) / 1000 : 0;

        // Host-agnostic on purpose: both publishers hand back the same layer shape, so this needs no branch of its own.
        for (const layer of snapshot.layers as StreamLayerSample[]) {
            const key = layer.rid ?? '';
            const bytes = layer.bytesSent;
            if (bytes === undefined) continue;
            const rate = kbpsBetween(bytes, this.prevOutboundBytes.get(key), dt);
            if (rate !== undefined) layer.kbps = rate;
            this.prevOutboundBytes.set(key, bytes);
        }
        this.prevOutboundAt = now;

        this._outboundStats.set(snapshot);
    }

    /** Change capture FPS mid-stream without stopping/restarting. Takes effect within one frame. */
    async setCaptureFps(fps: number): Promise<void> {
        this._captureFps.set(fps);
        if (!this.host?.nativeCapture) {
            const video = this.displayCapture?.video;
            if (video) await retargetDisplayFps(video, Math.round(fps)).catch(() => {});
            return;
        }
        await this.host.setNativeCaptureFps(fps);
    }

    /** Change the fixed output size mid-session. Costs one renegotiation and keyframe, so it only happens when the user picks a different resolution. */
    async setCaptureGeometry(geometry: CaptureGeometry): Promise<void> {
        this._captureGeometry.set(geometry);
        if (this.screenCanvas) {
            this.screenCanvas.width = geometry.width;
            this.screenCanvas.height = geometry.height;
        }
        if (!this.host?.nativeCapture) {
            const video = this.displayCapture?.video;
            if (video) {
                await retargetDisplayGeometry(video, geometry.width, geometry.height).catch(() => {});
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

        // Both halves, because in a browser they are one capture: the audio track is part of the source the user picked, and it ends with the picture.
        this.displayCapture?.stream.getTracks().forEach(t => t.stop());
        this.displayCapture = null;
    }

    // ── System audio (loopback) capture ───────────────────────────────────────
    //
    // The only capture path left in the webview; the microphone moved to the Rust voice session.

    async startLoopbackCapture(): Promise<MediaStreamTrack> {
        await this.stopLoopbackCapture();

        if (!this.host?.nativeCapture) {
            // A browser has no loopback device: throwing is what makes the caller fall back to a video-only share and say so, where a silent track would fail quietly.
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
        this.loopbackCtx?.close().catch(() => {});
        this.loopbackCtx = null;

        // The browser capture is deliberately not touched here: `stopScreenCapture` owns both halves, and `startLoopbackCapture` calls this first, so releasing it would stop the track that call is about to return.
    }

    /** Open the browser's display capture and keep both halves: one prompt, two consumers, because asking twice would put a second picker in front of the user. */
    private async startDisplayCapture(geometry: CaptureGeometry, fps: number): Promise<MediaStreamTrack> {
        const capture = await captureDisplay({
            width: geometry.width,
            height: geometry.height,
            fps,
            // Asked for unconditionally, because the audio decision is not known here; a host that offers none simply gives none.
            audio: true,
        });
        this.displayCapture = {stream: capture.stream, video: capture.video, audio: capture.audio};
        return capture.video;
    }

    // ── Idle preview pause ───────────────────────────────────────────────────

    /** Somebody is rendering the preview, in a window that is on screen and in front. */
    private isPreviewActive(): boolean {
        return !document.hidden && !this.windowBlurred && this.previewClaimants.size > 0;
    }

    /** How long the preview may keep running, given why it is inactive. Zero means pause now, and the reasons are tested strongest-first so the shorter delay wins when two apply at once. */
    private previewPauseDelay(): number {
        if (document.hidden) return 0;
        if (this.previewClaimants.size === 0) return PREVIEW_IDLE_MS;
        return BACKGROUND_IDLE_MS;
    }

    /** Re-evaluates the pause countdown; never schedules one before a share is publishing and {@link publishPreview} holds a first frame, or the share would pause with no frame to fall back to and no way out. */
    private reconsiderPreviewIdle(): void {
        if (this.activeShareId === null) return;
        if (this._publishPreview() === null) return;

        if (this.isPreviewActive()) {
            this.clearPreviewIdleTimer();
            return;
        }
        // Already paused. The latch is only ever lifted by resumePreview, so there is nothing to schedule.
        if (this._previewPaused()) return;

        const delay = this.previewPauseDelay();
        if (delay === 0) {
            this.pausePreviewNow();
            return;
        }

        const deadline = Date.now() + delay;
        if (this.previewPauseAt !== null) {
            // A countdown already due at or before this one stays as it is, so a second reason cannot push the deadline out.
            if (this.previewPauseAt <= deadline) {
                // Unless it is already overdue: a backgrounded renderer's setTimeout wakes at minute granularity, so the IPC feed is what lands the pause on time.
                if (Date.now() >= this.previewPauseAt) this.pausePreviewNow();
                return;
            }
            // The new reason is more urgent than the pending one.
        }
        this.clearPreviewIdleTimer();
        this.previewPauseAt = deadline;
        this.previewIdleTimer = setTimeout(() => this.pausePreviewNow(), delay);
    }

    private pausePreviewNow(): void {
        this.clearPreviewIdleTimer();
        this._previewPaused.set(true);
    }

    private clearPreviewIdleTimer(): void {
        this.previewPauseAt = null;
        if (this.previewIdleTimer === null) return;
        clearTimeout(this.previewIdleTimer);
        this.previewIdleTimer = null;
    }

    /** A share starting or ending gets a clean slate: a pause from the last one must not survive into the next. */
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
                // The canvas size is fixed for the session, so a source whose aspect ratio drifts is letterboxed rather than changing the track's dimensions.
                const scale = Math.min(c.width / bitmap.width, c.height / bitmap.height);
                const dw = bitmap.width * scale;
                const dh = bitmap.height * scale;
                if (dw < c.width || dh < c.height) {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, c.width, c.height);
                }
                ctx.drawImage(bitmap, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
                // Signal a new frame to the video track (captureStream(0) only captures on demand).
                (
                    this.screenStream?.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
                )?.requestFrame();
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
        } catch {
            /* ignore */
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
