import {CaptureGeometry} from '../../models/capture-geometry';
import {
    PublishSpec,
    ScreenPublisher,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
    StreamStatsSnapshot,
} from '../ports/screen-publisher.port';
import {AudioChunk, LocalStreamChunk, ScreenFrame, ScreenPublisherHost} from '../screen-publisher-host';
import {parseLocalStreamChunk} from './local-stream-framing';
import {StreamLayerSample, StreamStatsSample, StreamTransportStats} from '../../shared/call/stream-stats';

/** The preview frames the Rust publisher pushes back while it owns the share. */
interface PreviewFrame {
    /** base64 JPEG. */
    data: string;
    width: number;
    height: number;
}

type TauriCore = typeof import('@tauri-apps/api/core');

/** The `publish_stats` payload. Mirrors `PublishStats` in `src-tauri/src/media/publisher/mod.rs`. */
export interface PublishStatsPayload {
    codec: string | null;
    profileLevelId: string | null;
    transport: PublishTransportPayload | null;
    layers: PublishLayerPayload[];
    audio: {packetsEncoded: number; packetsDropped: number} | null;
}

/** The ICE path this publication is taking, from the succeeded candidate pair. */
export interface PublishTransportPayload {
    rttMs: number | null;
    localCandidateType: string | null;
    remoteCandidateType: string | null;
    protocol: string | null;
    availableOutgoingKbps: number | null;
}

export interface PublishLayerPayload {
    rid: string | null;
    ssrc: number | null;
    mid: string | null;
    width: number;
    height: number;
    fps: number;
    targetKbps: number;
    bytesSent: number;
    packetsSent: number;
    packetsLost: number | null;
    nackCount: number;
    pliCount: number | null;
    firCount: number | null;
    framesEncoded: number;
    keyframes: number;
    framesDropped: number;
    encoder: string;
}

/**
 * The native payload as a snapshot.
 *
 * `qp` must stay unset rather than become a zero, which would read as perfect quality.
 */
export function publishStatsToSnapshot(payload: PublishStatsPayload): StreamStatsSample {
    const snapshot = {
        direction: 'outbound' as const,
        source: 'native' as const,
        capturedAt: Date.now(),
        layers: payload.layers.map(l => {
            const layer: StreamLayerSample = {
                width: l.width,
                height: l.height,
                fps: l.fps,
                targetKbps: l.targetKbps,
                framesEncoded: l.framesEncoded,
                keyFrames: l.keyframes,
                framesDropped: l.framesDropped,
                packets: l.packetsSent,
                nackCount: l.nackCount,
                encoder: l.encoder,
                bytesSent: l.bytesSent,
            };
            if (l.rid !== null) layer.rid = l.rid;
            if (l.ssrc !== null) layer.ssrc = l.ssrc;
            if (l.mid !== null) layer.mid = l.mid;
            if (l.packetsLost !== null) layer.packetsLost = l.packetsLost;
            if (l.pliCount !== null) layer.pliCount = l.pliCount;
            if (l.firCount !== null) layer.firCount = l.firCount;
            return layer;
        }),
    } as StreamStatsSample;

    if (payload.codec !== null) snapshot.codec = payload.codec;
    if (payload.profileLevelId !== null) snapshot.profileLevelId = payload.profileLevelId;

    // Field by field rather than a spread, so an unmeasurable null stays absent and a genuine zero
    // survives the trip.
    const t = payload.transport;
    if (t) {
        const transport: StreamTransportStats = {};
        if (t.rttMs !== null) transport.rttMs = t.rttMs;
        if (t.localCandidateType !== null) transport.localCandidateType = t.localCandidateType;
        if (t.remoteCandidateType !== null) transport.remoteCandidateType = t.remoteCandidateType;
        if (t.protocol !== null) transport.protocol = t.protocol;
        if (t.availableOutgoingKbps !== null) transport.availableOutgoingKbps = t.availableOutgoingKbps;
        if (Object.keys(transport).length) snapshot.transport = transport;
    }

    if (payload.audio) {
        snapshot.audio = {
            packets: payload.audio.packetsEncoded,
            packetsDropped: payload.audio.packetsDropped,
        };
    }

    return snapshot;
}

/**
 * Screen capture and publishing on the desktop host: Rust does all of it.
 *
 * Every Tauri module is reached through {@link core}, which `import()`s on first call. The class
 * must stay constructible in a browser, so the constructor must never touch the IPC module.
 *
 * The Rust commands behind `stop`, `setFps`, `setSpec` and `setAudioMuted` are singletons that take
 * no id, so {@link liveShareId} is what makes the port's `shareId` mean anything here.
 */
export class TauriScreenPublisher extends ScreenPublisher implements ScreenPublisherHost {
    /** The in-app picker: the desktop host can enumerate windows, so it does. */
    readonly hasSourcePicker = true;
    readonly nativeCapture = true;

    private core: Promise<TauriCore> | null = null;

    /** The share `start()` last returned for, or null when nothing is publishing. */
    private liveShareId: string | null = null;

    /** @param load how the Tauri IPC module is obtained. Defaults to the real `import()`. */
    constructor(private readonly load: () => Promise<TauriCore> = () => import('@tauri-apps/api/core')) {
        super();
    }

    private previewChannel: {onmessage: (frame: PreviewFrame) => void} | null = null;
    private previewSink: ((dataUrl: string) => void) | null = null;
    private chunkChannel: {onmessage: (buffer: ArrayBuffer) => void} | null = null;
    private chunkSink: ((chunk: LocalStreamChunk) => void) | null = null;
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
     * Capture, encode and publish a source entirely in Rust. No `MediaStream` comes back.
     *
     * Nothing type-checks the invoke payload, so a new option must be added here too. `preset` is
     * not forwarded: Rust builds its encoder from width/height/fps/kbps.
     */
    async start(o: ScreenPublishOptions): Promise<ScreenPublishResult> {
        const {invoke, Channel} = await this.tauri();

        const preview = new Channel<PreviewFrame>();
        preview.onmessage = frame => this.previewSink?.(`data:image/jpeg;base64,${frame.data}`);
        this.previewChannel = preview;

        // Always constructed, even when `localStream` is off: Rust cannot take an optional channel,
        // and building it either way keeps `start`'s payload one shape.
        const chunks = new Channel<ArrayBuffer>();
        chunks.onmessage = buffer => {
            const chunk = parseLocalStreamChunk(buffer);
            // A truncated message is one frame lost; the decoder recovers on the next keyframe.
            if (chunk) this.chunkSink?.(chunk);
        };
        this.chunkChannel = chunks;

        const result = await invoke<ScreenPublishResult>('start_screen_publish', {
            onPreview: preview,
            onLocalStream: chunks,
            // Defaulted off, so hand-built options get the thumbnail rather than a decoder.
            localStream: o.localStream ?? false,
            sourceId: o.sourceId,
            shareId: o.shareId,
            width: o.width,
            height: o.height,
            fps: o.fps,
            kbps: o.kbps,
            content: o.content,
            iceServers: o.iceServers,
            livekitUrl: o.livekit.url,
            livekitToken: o.livekit.token,
            apiBase: o.apiBase,
            token: o.token,
            deviceId: o.deviceId,
            guildId: o.guildId ?? null,
            channelId: o.channelId ?? null,
            callId: o.callId ?? null,
            // Defaulted, so hand-built options share without audio rather than failing the publish.
            shareAudio: o.shareAudio ?? false,
        });

        this.liveShareId = o.shareId;
        return result;
    }

    async stop(shareId: string): Promise<void> {
        this.assertLive(shareId, 'stop');
        this.detachPreview();
        this.detachChunks();
        this.liveShareId = null;
        const {invoke} = await this.tauri();
        await invoke('stop_screen_publish');
    }

    async setFps(shareId: string, fps: number): Promise<void> {
        this.assertLive(shareId, 'setFps');
        const {invoke} = await this.tauri();
        await invoke('set_publish_fps', {fps: Math.round(fps)});
    }

    async setSpec(shareId: string, spec: PublishSpec): Promise<void> {
        this.assertLive(shareId, 'setSpec');
        const {invoke} = await this.tauri();
        // Rust applies it at the next frame boundary and answers immediately. See the port.
        await invoke('set_publish_spec', {
            width: Math.round(spec.width),
            height: Math.round(spec.height),
            kbps: Math.round(spec.kbps),
            content: spec.content,
        });
    }

    async setAudioMuted(shareId: string, muted: boolean): Promise<void> {
        this.assertLive(shareId, 'setAudioMuted');
        const {invoke} = await this.tauri();
        await invoke('set_screen_audio_muted', {muted});
    }

    async stats(shareId: string): Promise<StreamStatsSnapshot | null> {
        // Not `assertLive`: the port's contract for this one is null on a stale id, not a throw.
        if (this.liveShareId !== shareId) return null;
        const {invoke} = await this.tauri();
        const payload = await invoke<PublishStatsPayload | null>('publish_stats');
        return payload ? publishStatsToSnapshot(payload) : null;
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

        // Must run before `start_screen_capture`: the first frame's size decides the track's aspect ratio.
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

    onPublishChunk(handler: (chunk: LocalStreamChunk) => void): void {
        this.chunkSink = handler;
    }

    /** Not validated against {@link liveShareId}: it toggles this window's copy, not the share. */
    async setLocalStreamEnabled(enabled: boolean): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('set_local_stream_enabled', {enabled});
    }

    /** Accepted and never called: Rust reports nothing when a shared window closes. */
    onPublishEnded(_handler: () => void): void {
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private tauri(): Promise<TauriCore> {
        return this.core ??= this.load();
    }

    /** Refuse a command aimed at a share that is not the running one. Throws, never no-ops. */
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

    private detachChunks(): void {
        if (!this.chunkChannel) return;
        this.chunkChannel.onmessage = () => {
        };
        this.chunkChannel = null;
    }
}
