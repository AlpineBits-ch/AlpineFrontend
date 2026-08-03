import {Injectable, signal} from '@angular/core';
import {Channel, invoke, isTauri} from '@tauri-apps/api/core';
import {platform} from '@tauri-apps/plugin-os';
import {CaptureGeometry} from '../models/capture-geometry';

export interface ScreenSource {
    id: string;
    name: string;
    isMonitor: boolean;
    thumbnail: string; // base64 JPEG
    width: number;
    height: number;
}

export interface IceServerConfig {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface ScreenPublishOptions {
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
}

interface PreviewFrame {
    /** base64 JPEG. */
    data: string;
    width: number;
    height: number;
}

export interface ScreenPublishResult {
    cfSessionId: string;
    trackName: string;
    /** Which encoder was selected - 'media-foundation' or 'openh264'. */
    encoder: string;
}

interface AudioChunk {
    data: string;        // base64 f32-LE PCM
    sampleRate: number;
    channels: number;
}

interface ScreenFrame {
    data: string;        // base64 JPEG
    width: number;
    height: number;
    timestampMs: number;
}

@Injectable({providedIn: 'root'})
export class RustMediaService {
    private loopbackCtx: AudioContext | null = null;
    private loopbackWorklet: AudioWorkletNode | null = null;
    private loopbackDest: MediaStreamAudioDestinationNode | null = null;
    private loopbackChannel: Channel<AudioChunk> | null = null;

    private screenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    private screenCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    private screenStream: MediaStream | null = null;
    private screenChannel: Channel<ScreenFrame> | null = null;
    private latestFrame: ScreenFrame | null = null;
    private decodingFrame = false;

    private _isLinux: boolean | null = null;
    private readonly _captureFps = signal(15);
    /** Currently requested capture rate (set via startScreenCapture / setCaptureFps). */
    readonly captureFps = this._captureFps.asReadonly();
    private readonly _captureGeometry = signal<CaptureGeometry>({width: 1920, height: 1080});
    /** Fixed output size for the running session. Solved once, before capture starts. */
    readonly captureGeometry = this._captureGeometry.asReadonly();
    private readonly _publishPreview = signal<string | null>(null);
    /**
     * Data URL of the sharer's own screen while the Rust publisher owns the share.
     *
     * The publisher puts no MediaStream in the webview, so the local tile renders this instead -
     * a ~5 fps thumbnail rather than the stream itself.
     */
    readonly publishPreview = this._publishPreview.asReadonly();
    private publishPreviewChannel: Channel<PreviewFrame> | null = null;
    private readonly _inboundFps = signal(0);
    /** Frames received from Rust per second. */
    readonly inboundFps = this._inboundFps.asReadonly();
    private readonly _renderedFps = signal(0);
    /** Frames drawn to the canvas per second (after decode). */
    readonly renderedFps = this._renderedFps.asReadonly();
    private inboundFrameCount = 0;
    private renderedFrameCount = 0;
    private fpsInterval?: ReturnType<typeof setInterval>;

    /**
     * Returns true on Linux, where WebKitGTK getUserMedia() is permission-denied
     * and the Rust cpal pipeline must be used instead.
     */
    async shouldUseRustAudio(): Promise<boolean> {
        if (!isTauri()) return false;
        if (this._isLinux === null) {
            try {
                this._isLinux = (await platform()) === 'linux';
            } catch {
                this._isLinux = false;
            }
        }
        return this._isLinux;
    }

    // ── Screen sources ────────────────────────────────────────────────────────

    async getScreenSources(): Promise<ScreenSource[]> {
        if (!isTauri()) return [];
        try {
            return await invoke<ScreenSource[]>('enumerate_screen_sources');
        } catch (e) {
            console.warn('[RustMedia] enumerate_screen_sources failed', e);
            return [];
        }
    }

    // ── Screen capture ────────────────────────────────────────────────────────

    /**
     * Start Rust screen capture for the given source at a fixed output size.
     *
     * Returns a MediaStreamTrack backed by a canvas capture stream. The geometry must already be
     * solved (see {@link solveGeometry}) - it is locked in for the life of the session.
     */
    async startScreenCapture(sourceId: string, geometry: CaptureGeometry, fps = 30): Promise<MediaStreamTrack> {
        await this.stopScreenCapture();

        this._captureFps.set(fps);
        this._captureGeometry.set(geometry);
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

        const channel = new Channel<ScreenFrame>();
        this.screenChannel = channel;

        channel.onmessage = (frame) => {
            this.inboundFrameCount++;
            this.queueFrame(frame);
        };

        await invoke('set_screen_capture_geometry', {
            width: geometry.width,
            height: geometry.height,
        }).catch(() => {
        });
        await invoke('start_screen_capture', {sourceId, fps, onFrame: channel});

        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No video track from canvas');
        // 'detail' - screen content is text and UI. Paired with maintain-resolution degradation on
        // the sender (see applyScreenEncoding), the encoder drops frames under congestion instead
        // of shedding resolution. The old 'motion' hint did the opposite, which is why streams
        // looked soft and took tens of seconds to sharpen. That combination previously starved
        // framerate only because bitrate was chosen independently of resolution and fps; the
        // stream preset now couples all three.
        try {
            (track as { contentHint?: string }).contentHint = 'detail';
        } catch {
        }
        return track;
    }

    // ── Rust-native publishing ────────────────────────────────────────────────

    /**
     * Capture, encode and publish a screen source entirely in Rust.
     *
     * Unlike {@link startScreenCapture} this returns no MediaStream: frames never enter the
     * webview at all. The resolved ids are what other clients subscribe to, exactly as they would
     * for a track the webview published.
     */
    async startScreenPublish(options: ScreenPublishOptions): Promise<ScreenPublishResult> {
        const preview = new Channel<PreviewFrame>();
        preview.onmessage = frame => this._publishPreview.set(`data:image/jpeg;base64,${frame.data}`);
        this.publishPreviewChannel = preview;

        return invoke<ScreenPublishResult>('start_screen_publish', {
            onPreview: preview,
            sourceId: options.sourceId,
            shareId: options.shareId,
            width: options.width,
            height: options.height,
            fps: options.fps,
            kbps: options.kbps,
            iceServers: options.iceServers,
            apiBase: options.apiBase,
            token: options.token,
            deviceId: options.deviceId,
            guildId: options.guildId ?? null,
            channelId: options.channelId ?? null,
            callId: options.callId ?? null,
        });
    }

    async stopScreenPublish(): Promise<void> {
        if (this.publishPreviewChannel) {
            this.publishPreviewChannel.onmessage = () => {
            };
            this.publishPreviewChannel = null;
        }
        this._publishPreview.set(null);
        if (!isTauri()) return;
        await invoke('stop_screen_publish').catch(() => {
        });
    }

    /**
     * Change the publisher's capture rate mid-stream.
     *
     * Framerate is the only part of a preset that changes without rebuilding the encoder, which is
     * fixed to one geometry and bitrate for its lifetime; a resolution change restarts the publish.
     */
    async setPublishFps(fps: number): Promise<void> {
        if (!isTauri()) return;
        await invoke('set_publish_fps', {fps: Math.round(fps)}).catch(() => {
        });
    }

    /** Change capture FPS mid-stream without stopping/restarting. Takes effect within one frame. */
    async setCaptureFps(fps: number): Promise<void> {
        this._captureFps.set(fps);
        if (!isTauri()) return;
        await invoke('set_screen_capture_fps', {fps: Math.round(fps)}).catch(() => {
        });
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
        if (!isTauri()) return;
        await invoke('set_screen_capture_geometry', {
            width: geometry.width,
            height: geometry.height,
        }).catch(() => {
        });
    }

    async stopScreenCapture(): Promise<void> {
        clearInterval(this.fpsInterval);
        this.fpsInterval = undefined;
        this._inboundFps.set(0);
        this._renderedFps.set(0);

        if (this.screenChannel) {
            this.screenChannel.onmessage = () => {
            };
            this.screenChannel = null;
        }
        if (isTauri()) {
            await invoke('stop_screen_capture').catch(() => {
            });
        }
        this.screenStream?.getTracks().forEach(t => t.stop());
        this.screenStream = null;
        this.screenCanvas = null;
        this.screenCtx = null;
        this.latestFrame = null;
        this.decodingFrame = false;
    }

    // ── System audio (loopback) capture ───────────────────────────────────────
    //
    // The only capture path left in the webview. The microphone moved to the Rust voice session,
    // which captures, processes, encodes and publishes without a worklet or an AudioContext; this
    // one stays because a screen share's audio is still published from here.

    async startLoopbackCapture(): Promise<MediaStreamTrack> {
        await this.stopLoopbackCapture();

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

        const channel = new Channel<AudioChunk>();
        this.loopbackChannel = channel;
        channel.onmessage = (chunk) => this.feedLoopback(chunk);

        await invoke('start_loopback_capture', {onChunk: channel});

        const track = destination.stream.getAudioTracks()[0];
        if (!track) throw new Error('No audio track from loopback worklet');
        return track;
    }

    async stopLoopbackCapture(): Promise<void> {
        if (this.loopbackChannel) {
            this.loopbackChannel.onmessage = () => {
            };
            this.loopbackChannel = null;
        }
        if (isTauri()) {
            await invoke('stop_loopback_capture').catch(() => {
            });
        }
        this.loopbackWorklet?.disconnect();
        this.loopbackWorklet = null;
        this.loopbackDest = null;
        this.loopbackCtx?.close().catch(() => {
        });
        this.loopbackCtx = null;
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
