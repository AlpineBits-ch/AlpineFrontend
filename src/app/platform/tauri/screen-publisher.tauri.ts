import {CaptureGeometry} from '../../models/capture-geometry';
import {
    ScreenPublisher,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
} from '../ports/screen-publisher.port';
import {AudioChunk, ScreenFrame, ScreenPublisherHost} from '../screen-publisher-host';

/** The preview frames the Rust publisher pushes back while it owns the share. */
interface PreviewFrame {
    /** base64 JPEG. */
    data: string;
    width: number;
    height: number;
}

type TauriCore = typeof import('@tauri-apps/api/core');

/**
 * Screen capture and publishing on the desktop host: Rust does all of it.
 *
 * <p>Every Tauri module is reached through {@link core}, which `import()`s on <b>first call</b>. The
 * class itself must stay constructible in a browser - `providePlatform()` builds whichever adapter the
 * host selected, and a constructor that touched the IPC module would pull it into the web bundle
 * through the very indirection meant to keep it out.</p>
 *
 * <p><b>The Rust commands behind `stop`, `setFps` and `setAudioMuted` are singletons</b> - they take no
 * id and address "the share". {@link liveShareId} is what makes the port's `shareId` mean something
 * here: a caller holding a share that has already been replaced is told so, rather than silently
 * stopping the one that replaced it. That case is real - a resolution change tears the publish down
 * and starts a new one with a new id, and anything still holding the old id (a queued UI action, a
 * retry) would otherwise land on the new share.</p>
 */
export class TauriScreenPublisher extends ScreenPublisher implements ScreenPublisherHost {
    /** The in-app picker: the desktop host can enumerate windows, so it does. */
    readonly hasSourcePicker = true;
    readonly nativeCapture = true;

    private core: Promise<TauriCore> | null = null;

    /** The share `start()` last returned for, or null when nothing is publishing. */
    private liveShareId: string | null = null;

    /**
     * @param load how the Tauri IPC module is obtained. Defaulted to the real `import()`, and
     * overridable so a spec can drive this adapter with a recording fake instead of
     * `vi.mock('@tauri-apps/api/core')`. That matters beyond taste: several specs mock that module and
     * only one registration wins per run, so a spec that depended on its own factory would pass or fail
     * on file ordering.
     */
    constructor(private readonly load: () => Promise<TauriCore> = () => import('@tauri-apps/api/core')) {
        super();
    }

    private previewChannel: {onmessage: (frame: PreviewFrame) => void} | null = null;
    private previewSink: ((dataUrl: string) => void) | null = null;
    private frameChannel: {onmessage: (frame: ScreenFrame) => void} | null = null;
    private loopbackChannel: {onmessage: (chunk: AudioChunk) => void} | null = null;

    // ── Sources ───────────────────────────────────────────────────────────────

    async sources(): Promise<ScreenSource[]> {
        try {
            const {invoke} = await this.tauri();
            return await invoke<ScreenSource[]>('enumerate_screen_sources');
        } catch (e) {
            console.warn('[screen] enumerate_screen_sources failed', e);
            return [];
        }
    }

    async thumbnails(ids: string[]): Promise<SourceThumbnail[]> {
        if (ids.length === 0) return [];
        try {
            const {invoke} = await this.tauri();
            return await invoke<SourceThumbnail[]>('capture_source_thumbnails', {sourceIds: ids});
        } catch (e) {
            console.warn('[screen] capture_source_thumbnails failed', e);
            return [];
        }
    }

    // ── Publishing ────────────────────────────────────────────────────────────

    /**
     * Capture, encode and publish a source entirely in Rust.
     *
     * <p>No `MediaStream` comes back: frames never enter the webview. The resolved ids are what other
     * clients subscribe to, exactly as they would for a track the webview published.</p>
     *
     * <p>The payload is assembled key by key against the command's parameters, and `invoke` takes a
     * loose record - so nothing type-checks it. `screen-publisher.tauri.spec.ts` asserts the key set,
     * because a field added to `ScreenPublishOptions` and to Rust and forgotten in the middle compiles
     * cleanly on both sides and fails every share at runtime. `preset` is deliberately <b>not</b>
     * forwarded: it exists for the web sender's encoding parameters, and Rust builds its encoder from
     * the width/height/fps/kbps it already has.</p>
     */
    async start(o: ScreenPublishOptions): Promise<ScreenPublishResult> {
        const {invoke, Channel} = await this.tauri();

        const preview = new Channel<PreviewFrame>();
        preview.onmessage = frame => this.previewSink?.(`data:image/jpeg;base64,${frame.data}`);
        this.previewChannel = preview;

        const result = await invoke<ScreenPublishResult>('start_screen_publish', {
            onPreview: preview,
            sourceId: o.sourceId,
            shareId: o.shareId,
            width: o.width,
            height: o.height,
            fps: o.fps,
            kbps: o.kbps,
            iceServers: o.iceServers,
            apiBase: o.apiBase,
            token: o.token,
            deviceId: o.deviceId,
            guildId: o.guildId ?? null,
            channelId: o.channelId ?? null,
            callId: o.callId ?? null,
            // Defaulted rather than passed straight through: the picker is the only thing that sets
            // it, and a caller that builds options by hand would otherwise fail the whole publish on
            // a missing key rather than simply sharing without audio.
            shareAudio: o.shareAudio ?? false,
        });

        this.liveShareId = o.shareId;
        return result;
    }

    async stop(shareId: string): Promise<void> {
        this.assertLive(shareId, 'stop');
        this.detachPreview();
        this.liveShareId = null;
        const {invoke} = await this.tauri();
        await invoke('stop_screen_publish');
    }

    async setFps(shareId: string, fps: number): Promise<void> {
        this.assertLive(shareId, 'setFps');
        const {invoke} = await this.tauri();
        await invoke('set_publish_fps', {fps: Math.round(fps)});
    }

    async setAudioMuted(shareId: string, muted: boolean): Promise<void> {
        this.assertLive(shareId, 'setAudioMuted');
        const {invoke} = await this.tauri();
        await invoke('set_screen_audio_muted', {muted});
    }

    // ── The canvas pipeline (ScreenPublisherHost) ─────────────────────────────

    async startNativeScreenCapture(
        sourceId: string,
        geometry: CaptureGeometry,
        fps: number,
        onFrame: (frame: ScreenFrame) => void,
    ): Promise<void> {
        const {invoke, Channel} = await this.tauri();

        const channel = new Channel<ScreenFrame>();
        channel.onmessage = onFrame;
        this.frameChannel = channel;

        // Before `start_screen_capture`, not after: the receiving canvas is sized once from this same
        // geometry, and a first frame at some other size would decide the track's aspect ratio.
        await invoke('set_screen_capture_geometry', {
            width: geometry.width,
            height: geometry.height,
        }).catch(() => {
        });
        await invoke('start_screen_capture', {sourceId, fps, onFrame: channel});
    }

    async setNativeCaptureFps(fps: number): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('set_screen_capture_fps', {fps: Math.round(fps)}).catch(() => {
        });
    }

    async setNativeCaptureGeometry(geometry: CaptureGeometry): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('set_screen_capture_geometry', {
            width: geometry.width,
            height: geometry.height,
        }).catch(() => {
        });
    }

    async stopNativeScreenCapture(): Promise<void> {
        if (this.frameChannel) {
            this.frameChannel.onmessage = () => {
            };
            this.frameChannel = null;
        }
        const {invoke} = await this.tauri();
        await invoke('stop_screen_capture').catch(() => {
        });
    }

    async startNativeLoopbackCapture(onChunk: (chunk: AudioChunk) => void): Promise<void> {
        const {invoke, Channel} = await this.tauri();
        const channel = new Channel<AudioChunk>();
        channel.onmessage = onChunk;
        this.loopbackChannel = channel;
        await invoke('start_loopback_capture', {onChunk: channel});
    }

    async stopNativeLoopbackCapture(): Promise<void> {
        if (this.loopbackChannel) {
            this.loopbackChannel.onmessage = () => {
            };
            this.loopbackChannel = null;
        }
        const {invoke} = await this.tauri();
        await invoke('stop_loopback_capture').catch(() => {
        });
    }

    /** True on Linux, where WebKitGTK's `getUserMedia` is permission-denied and cannot be granted. */
    async prefersNativeAudioCapture(): Promise<boolean> {
        try {
            const {platform} = await import('@tauri-apps/plugin-os');
            return platform() === 'linux';
        } catch {
            return false;
        }
    }

    onPreviewFrame(handler: (dataUrl: string) => void): void {
        this.previewSink = handler;
    }

    /**
     * Accepted and never called.
     *
     * <p>Rust reports nothing when a shared window closes, so there is no event to forward. Recorded
     * as a known gap rather than papered over: a handler registered here on desktop is simply never
     * invoked, and a caller must not read "no ended event" as "the share is still up".</p>
     */
    onPublishEnded(_handler: () => void): void {
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private tauri(): Promise<TauriCore> {
        return this.core ??= this.load();
    }

    /**
     * Refuse a command aimed at a share that is not the running one.
     *
     * <p>Throws rather than no-ops, in both directions - a stale id and an id sent when nothing is
     * publishing are both a caller that has lost track of the share, and the singleton commands
     * underneath cannot tell the difference. Swallowing it is how one caller's stop lands on another
     * caller's stream.</p>
     */
    private assertLive(shareId: string, action: string): void {
        if (this.liveShareId === shareId) return;
        throw new Error(
            `[screen] ${action}('${shareId}') refused: the live share is ` +
            `${this.liveShareId === null ? 'none' : `'${this.liveShareId}'`}`,
        );
    }

    private detachPreview(): void {
        if (!this.previewChannel) return;
        this.previewChannel.onmessage = () => {
        };
        this.previewChannel = null;
    }
}
