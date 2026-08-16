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

/**
 * The ICE path this publication is actually taking, from the succeeded candidate pair.
 *
 * <p>Deliberately shaped like `StreamTransportStats` field for field. Before this existed the
 * native payload carried a bare `rttMs` and nothing else, so a desktop sharer relaying through
 * TURN saw no Path row at all while a viewer of that same stream saw one - the two directions
 * disagreeing about what is knowable, over a difference that was only ever in the plumbing.</p>
 */
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
 * <p>`source: 'native'` is what the panel branches on to omit the rows this pipeline structurally
 * cannot fill. `qp` is the one that matters: webrtc-rs cannot report it and it lives inside Media
 * Foundation and openh264, so it is never set here. It must stay unset rather than become a zero,
 * which would read as perfect quality.</p>
 *
 * <p>`bytesSent` is carried through un-differentiated: this has one sample and no interval. The
 * service turns two of these into `kbps`.</p>
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

    // Field by field rather than a spread, so a null the Rust side could not measure stays absent
    // instead of arriving as an explicit `undefined` key - and so a genuine zero (an ICE path with
    // no measured RTT yet is not the same as one at 0 ms) survives the trip. An all-null transport
    // block yields no transport at all, which is what the panel reads as "nothing to say here".
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
 * <p>Every Tauri module is reached through {@link core}, which `import()`s on <b>first call</b>. The
 * class itself must stay constructible in a browser - `providePlatform()` builds whichever adapter the
 * host selected, and a constructor that touched the IPC module would pull it into the web bundle
 * through the very indirection meant to keep it out.</p>
 *
 * <p><b>The Rust commands behind `stop`, `setFps`, `setSpec` and `setAudioMuted` are
 * singletons</b> - they take no id and address "the share". {@link liveShareId} is what makes the
 * port's `shareId` mean something here: a caller holding a share that has already been replaced is
 * told so, rather than silently stopping the one that replaced it. That case is real - sharing a
 * different source stops one publish and starts another under a new id, and anything still holding
 * the old id (a queued UI action, a retry) would otherwise land on the new share.</p>
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

        // Always constructed, used only when `localStream` is set - Rust cannot take an optional
        // channel, so the boolean is the request and this is the pipe it would arrive on. Building
        // it either way keeps `start`'s payload one shape, which is what the spec asserts on.
        const chunks = new Channel<ArrayBuffer>();
        chunks.onmessage = buffer => {
            const chunk = parseLocalStreamChunk(buffer);
            // A truncated message is one frame lost, not a reason to stop reading the feed. The
            // decoder recovers on the next keyframe, which the encoder issues at least every two
            // seconds - see KEYFRAME_INTERVAL.
            if (chunk) this.chunkSink?.(chunk);
        };
        this.chunkChannel = chunks;

        const result = await invoke<ScreenPublishResult>('start_screen_publish', {
            onPreview: preview,
            onLocalStream: chunks,
            // Defaulted off rather than passed straight through, so a caller that builds options by
            // hand gets the thumbnail rather than a decoder it never asked for.
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
        // Rust applies it at the next frame boundary and answers immediately; a retype the driver
        // refuses is logged there and leaves the share as it was. See the port.
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
        // Deliberately NOT `assertLive`, which every other command here uses and which throws. The
        // port's contract for this one is null on a stale id: a stats poll racing a share that just
        // ended is routine, where a stale `setFps` is a bug worth surfacing loudly.
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

    onPublishChunk(handler: (chunk: LocalStreamChunk) => void): void {
        this.chunkSink = handler;
    }

    /**
     * Deliberately <b>not</b> validated against {@link liveShareId}, unlike the other three
     * singleton commands.
     *
     * <p>Those three change a share; this one changes whether this window is being shown a copy of
     * one. It is driven from window focus and an idle timer, so it fires on its own schedule - and
     * refusing it during the gap where a resolution change has torn one publish down and not yet
     * started the next would leave the new share's feed off with nothing to turn it back on. Rust
     * ignores it when nothing is publishing, which is the right answer here and the wrong one for
     * a stop.</p>
     */
    async setLocalStreamEnabled(enabled: boolean): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('set_local_stream_enabled', {enabled});
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

    private detachChunks(): void {
        if (!this.chunkChannel) return;
        this.chunkChannel.onmessage = () => {
        };
        this.chunkChannel = null;
    }
}
