import type {VideoPublishIntentDto} from '../../dtos/response/entitlement.dto';
import {DEFAULT_STREAM_PRESET} from '../../models/stream-preset';
import {
    applyScreenEncoding,
    applySimpleBitrate,
    CONTENT_POLICY,
    preferVideoCodecs,
    screenSendEncodings,
    STREAM_AUDIO_KBPS,
    withStartBitrate,
} from '../../services/webrtc-encoding';
import {
    captureDisplay,
    DisplayCapture,
    retargetDisplayFps,
    retargetDisplayGeometry,
} from '../display-capture';
import {
    PublishSpec,
    ScreenPublisher,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
} from '../ports/screen-publisher.port';
import {LocalStreamChunk, ScreenPublisherHost} from '../screen-publisher-host';
import {outboundStatsFromReport, StreamStatsSnapshot} from '../../shared/call/stream-stats';
import {trace} from '../../core/log';

/** One track in a publish request, in the neutral vocabulary the backend and Rust both speak. */
interface PublishTrackRef {
    direction: 'publish';
    mid: string;
    trackName: string;
}

interface TrackResult {
    mid?: string;
    trackName: string;
    errorCode?: string;
    errorDescription?: string;
}

interface NegotiateResponse {
    sessionDescription: RTCSessionDescriptionInit;
    tracks: TrackResult[];
    requiresImmediateRenegotiation: boolean;
}

/** How long a signalling request may take before it is a failure rather than a delay. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Width of the sharer's own preview thumbnail, in pixels. Tall enough to recognise, cheap to encode. */
const PREVIEW_WIDTH = 320;

/** How often the preview thumbnail is regrabbed. The native publisher's is about this rate too. */
const PREVIEW_INTERVAL_MS = 250;

/** What everything below holds while one share is live. */
interface LiveShare {
    shareId: string;
    mediaSessionId: string;
    pc: RTCPeerConnection;
    capture: DisplayCapture;
    videoSender: RTCRtpSender;
    trackName: string;
    audioTrackName: string | null;
    signalling: Signalling;
    previewTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Screen sharing in a browser: `getDisplayMedia` and a peer connection of its own. The share's media
 * session must stay secondary (`primary=false`), or peers pull voice from a session that has none.
 */
export class WebScreenPublisher extends ScreenPublisher implements ScreenPublisherHost {
    /** False: `getDisplayMedia` opens the host's own picker, so the in-app one is skipped. */
    readonly hasSourcePicker = false;

    /** No Rust side at all. The browser fallback for the legacy capture surface lives in the caller. */
    readonly nativeCapture = false;

    private live: LiveShare | null = null;
    private previewSink: ((dataUrl: string) => void) | null = null;
    private endedSink: (() => void) | null = null;

    /** Empty, always: a browser cannot enumerate windows. Callers branch on {@link hasSourcePicker}. */
    async sources(): Promise<ScreenSource[]> {
        return [];
    }

    /** Empty for the same reason as {@link sources}: there are no ids to have thumbnails of. */
    async thumbnails(_ids: string[]): Promise<SourceThumbnail[]> {
        return [];
    }

    /**
     * Capture and publish, opening the host picker on the way. `o.sourceId` is ignored, and geometry,
     * framerate and bitrate must not be re-derived: they arrive already solved.
     */
    async start(o: ScreenPublishOptions): Promise<ScreenPublishResult> {
        // Must be awaited: this is also the resolution-change path, and the captures must not overlap.
        await this.stopLive();

        const capture = await captureDisplay({
            width: o.width,
            height: o.height,
            fps: o.fps,
            audio: o.shareAudio ?? false,
        });
        if (capture.audioUnavailable) {
            console.warn('[screen] audio was requested but this host published none; sharing video only');
        }

        const signalling = new Signalling(o);
        let pc: RTCPeerConnection | null = null;
        try {
            const mediaSessionId = await signalling.createSession();

            pc = new RTCPeerConnection({iceServers: o.iceServers, bundlePolicy: 'max-bundle'});
            // Separate streams for the two halves; sharing one makes the share look like a camera.
            // Must be addTransceiver, not addTrack: `sendEncodings` is only honoured at creation.
            const preset = o.preset ?? DEFAULT_STREAM_PRESET;
            const videoTransceiver = pc.addTransceiver(capture.video, {
                direction: 'sendonly',
                streams: [new MediaStream([capture.video])],
                sendEncodings: screenSendEncodings(preset),
            });
            const videoSender = videoTransceiver.sender;
            const audioSender = capture.audio
                ? pc.addTrack(capture.audio, new MediaStream([capture.audio]))
                : null;

            // VP9 first: better quality-per-bit than VP8 on screen content.
            preferVideoCodecs(videoTransceiver, 'sender');

            const offer = await pc.createOffer();
            // Open near the target rate rather than letting congestion control ramp up from ~300 kbps.
            await pc.setLocalDescription({
                type: offer.type,
                sdp: withStartBitrate(offer.sdp ?? '', o.kbps),
            });

            const videoName = `screen-${o.shareId}`;
            const audioName = audioSender ? `screen-audio-${o.shareId}` : null;
            const tracks: PublishTrackRef[] = [
                {direction: 'publish', mid: midOf(pc, videoSender, '0'), trackName: videoName},
            ];
            if (audioSender && audioName) {
                tracks.push({direction: 'publish', mid: midOf(pc, audioSender, '1'), trackName: audioName});
            }

            // Both halves must go in one negotiation, and the declared size must be the solved capture
            // geometry rather than the preset's nominal height.
            const response = await signalling.publish(
                mediaSessionId,
                pc.localDescription!,
                tracks,
                publishIntent(o),
            );
            await pc.setRemoteDescription(response.sessionDescription);
            if (response.requiresImmediateRenegotiation) {
                await this.renegotiate(pc, signalling, mediaSessionId);
            }

            const videoResult = resultFor(response, videoName);
            if (!videoResult || videoResult.errorCode) {
                throw new Error(
                    `[screen] the SFU refused the video track: ` +
                        `${videoResult?.errorCode ?? 'no result'} ${videoResult?.errorDescription ?? ''}`.trim(),
                );
            }
            // What was published, not what was asked for: the audio half can be refused on its own.
            const audioResult = audioName ? resultFor(response, audioName) : null;
            const publishedAudioName = audioResult && !audioResult.errorCode ? audioResult.trackName : null;
            if (audioName && !publishedAudioName) {
                console.warn('[screen] the SFU refused the audio track; sharing video only', audioResult);
            }

            await applyScreenEncoding(videoSender, preset);
            if (audioSender && publishedAudioName) await applySimpleBitrate(audioSender, STREAM_AUDIO_KBPS);

            this.live = {
                shareId: o.shareId,
                mediaSessionId,
                pc,
                capture,
                videoSender,
                trackName: videoResult.trackName,
                audioTrackName: publishedAudioName,
                signalling,
                previewTimer: null,
            };
            // Must run after `live` is set: both of these can fire immediately, and both need it.
            this.watchForHostStop(capture.video, o.shareId);
            this.startPreview();

            return {
                mediaSessionId,
                trackName: videoResult.trackName,
                audioTrackName: publishedAudioName,
                // No encoder choice to report; the browser owns that.
                encoder: 'browser',
            };
        } catch (e) {
            // Must stop the capture, or a failed publish leaves the screen-capture indicator up.
            capture.stream.getTracks().forEach(t => t.stop());
            pc?.close();
            throw e;
        }
    }

    async stop(shareId: string): Promise<void> {
        this.assertLive(shareId, 'stop');
        await this.stopLive();
    }

    async setFps(shareId: string, fps: number): Promise<void> {
        const live = this.assertLive(shareId, 'setFps');
        const rounded = Math.round(fps);
        // Both the capture constraint and `maxFramerate` must move, or the old value caps a raise.
        await retargetDisplayFps(live.capture.video, rounded);
        try {
            const params = live.videoSender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            // Every rung of the ladder, not just the top one.
            for (const encoding of params.encodings) encoding.maxFramerate = rounded;
            await live.videoSender.setParameters(params);
        } catch {
            /* setParameters unsupported, or the share already ended */
        }
    }

    async setSpec(shareId: string, spec: PublishSpec): Promise<void> {
        const live = this.assertLive(shareId, 'setSpec');
        // Both halves, exactly as setFps does: geometry and the encoding's bitrate move together.
        await retargetDisplayGeometry(live.capture.video, Math.round(spec.width), Math.round(spec.height));
        try {
            const params = live.videoSender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            for (const encoding of params.encodings) encoding.maxBitrate = Math.round(spec.kbps) * 1000;
            // The mode's own two settings; geometry must never move without them.
            const policy = CONTENT_POLICY[spec.content];
            params.degradationPreference = policy.degradation;
            if (live.videoSender.track) live.videoSender.track.contentHint = policy.hint;
            await live.videoSender.setParameters(params);
        } catch {
            /* setParameters unsupported, or the share already ended */
        }
    }

    async setAudioMuted(shareId: string, muted: boolean): Promise<void> {
        const live = this.assertLive(shareId, 'setAudioMuted');
        // Stops packets rather than the capture, so unmuting is instant.
        if (live.capture.audio) live.capture.audio.enabled = !muted;
    }

    /**
     * Live outbound stats for the running publication, or null when `shareId` is stale. Must answer
     * null rather than route through {@link assertLive}, which throws.
     */
    async stats(shareId: string): Promise<StreamStatsSnapshot | null> {
        const live = this.live;
        if (!live || live.shareId !== shareId) return null;

        const report = await live.pc.getStats();
        const mid =
            live.pc.getTransceivers?.().find(t => t.sender.track?.kind === 'video')?.mid ??
            firstOutboundVideoMid(report);
        if (!mid) return null;

        return outboundStatsFromReport(report, mid);
    }

    // ── ScreenPublisherHost ───────────────────────────────────────────────────

    async startNativeScreenCapture(): Promise<void> {
        throw new Error('[screen] there is no native screen capture in a browser');
    }

    async setNativeCaptureFps(): Promise<void> {
        throw new Error('[screen] there is no native screen capture in a browser');
    }

    async setNativeCaptureGeometry(): Promise<void> {
        throw new Error('[screen] there is no native screen capture in a browser');
    }

    async stopNativeScreenCapture(): Promise<void> {
        // Not a throw: this runs on teardown paths that do not know which pipeline was used.
    }

    async startNativeLoopbackCapture(): Promise<void> {
        throw new Error('[screen] there is no loopback capture in a browser');
    }

    async stopNativeLoopbackCapture(): Promise<void> {
        // As above.
    }

    /** Never: `getUserMedia` is the only microphone a browser has. */
    async prefersNativeAudioCapture(): Promise<boolean> {
        return false;
    }

    onPreviewFrame(handler: (dataUrl: string) => void): void {
        this.previewSink = handler;
    }

    onPublishEnded(handler: () => void): void {
        this.endedSink = handler;
    }

    /** Accepted and never called: a browser publish renders its local tile from the display track. */
    onPublishChunk(_handler: (chunk: LocalStreamChunk) => void): void {}

    /** Nothing to gate: see {@link onPublishChunk}. */
    async setLocalStreamEnabled(_enabled: boolean): Promise<void> {}

    // ── Internals ─────────────────────────────────────────────────────────────

    /** Refuse a command aimed at a share that is not the running one, and hand back the running one. */
    private assertLive(shareId: string, action: string): LiveShare {
        if (this.live && this.live.shareId === shareId) return this.live;
        throw new Error(
            `[screen] ${action}('${shareId}') refused: the live share is ` +
                `${this.live === null ? 'none' : `'${this.live.shareId}'`}`,
        );
    }

    /**
     * End the running share. Tracks must be closed at the SFU before they are stopped locally, and
     * the local teardown must run even when that request fails.
     */
    private async stopLive(): Promise<void> {
        const live = this.live;
        if (!live) return;
        this.live = null;

        if (live.previewTimer !== null) clearInterval(live.previewTimer);
        const names = [live.trackName, ...(live.audioTrackName ? [live.audioTrackName] : [])];
        await live.signalling
            .closeTracks(live.mediaSessionId, names)
            .catch(e => console.warn('[screen] closing the published tracks failed', e));

        live.capture.video.onended = null;
        live.capture.stream.getTracks().forEach(t => t.stop());
        live.pc.close();
    }

    private async renegotiate(
        pc: RTCPeerConnection,
        signalling: Signalling,
        mediaSessionId: string,
    ): Promise<void> {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const response = await signalling.renegotiate(mediaSessionId, pc.localDescription!);
        await pc.setRemoteDescription(response.sessionDescription);
    }

    /**
     * Notice the host's own "Stop sharing" and take the publish down with it. The id is captured so
     * a late `onended` cannot tear down a successor share.
     */
    private watchForHostStop(video: MediaStreamTrack, shareId: string): void {
        video.onended = () => {
            if (this.live?.shareId !== shareId) return;
            trace('[screen] the host ended the capture; stopping the publish');
            void this.stopLive().finally(() => this.endedSink?.());
        };
    }

    /** Feed the sharer's own low-rate thumbnail, the same shape the native publisher pushes. */
    private startPreview(): void {
        const live = this.live;
        if (!live || !this.previewSink || typeof document === 'undefined') return;

        let video: HTMLVideoElement;
        let canvas: HTMLCanvasElement;
        try {
            video = document.createElement('video');
            video.muted = true;
            video.srcObject = new MediaStream([live.capture.video]);
            void video.play().catch(() => {});
            canvas = document.createElement('canvas');
        } catch {
            return;
        }

        live.previewTimer = setInterval(() => {
            const sink = this.previewSink;
            if (!sink || this.live?.shareId !== live.shareId) return;
            if (!video.videoWidth || !video.videoHeight) return;
            try {
                const scale = PREVIEW_WIDTH / video.videoWidth;
                canvas.width = PREVIEW_WIDTH;
                canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                sink(canvas.toDataURL('image/jpeg', 0.6));
            } catch {
                /* a frame that could not be grabbed is skipped, not fatal */
            }
        }, PREVIEW_INTERVAL_MS);
    }
}

/** What this share is about to encode, or nothing when it cannot be stated. */
function publishIntent(o: ScreenPublishOptions): VideoPublishIntentDto | undefined {
    if (o.height <= 0 || o.fps <= 0) return undefined;
    return {height: Math.round(o.height), framerate: Math.round(o.fps)};
}

/** The mid a sender ended up on, with the same fallback the webview publish path uses. */
function midOf(pc: RTCPeerConnection, sender: RTCRtpSender, fallback: string): string {
    return pc.getTransceivers().find(t => t.sender === sender)?.mid ?? fallback;
}

function resultFor(response: NegotiateResponse, trackName: string): TrackResult | null {
    return response.tracks?.find(t => t.trackName === trackName) ?? null;
}

/** The mid of the first outgoing video stream in a report, for when no transceiver lookup exists. */
function firstOutboundVideoMid(report: RTCStatsReport): string | undefined {
    let mid: string | undefined;
    report.forEach(stat => {
        const s = stat as unknown as Record<string, unknown>;
        if (mid === undefined && s['type'] === 'outbound-rtp' && s['kind'] === 'video') {
            mid = s['mid'] as string | undefined;
        }
    });
    return mid;
}

/**
 * The voice signalling routes, mirroring `src-tauri/src/media/publisher/signalling.rs`. These are
 * gateway paths: the segment after `v1` names the service and never appears in the controller route.
 */
class Signalling {
    private readonly base: string;
    private readonly token: string;
    private readonly deviceId: string;

    constructor(o: ScreenPublishOptions) {
        const apiBase = o.apiBase.replace(/\/+$/, '');
        if (o.guildId && o.channelId) {
            this.base = `${apiBase}/api/v1/guild/guilds/${o.guildId}/channels/${o.channelId}/voice`;
        } else if (o.callId) {
            this.base = `${apiBase}/api/v1/messaging/voice/calls/${o.callId}`;
        } else {
            throw new Error('[screen] a publish needs either guildId+channelId or callId');
        }
        this.token = o.token;
        this.deviceId = o.deviceId;
    }

    /** Open a media session for this share alone. `primary=false` is load-bearing. */
    async createSession(): Promise<string> {
        const response = await this.send<{mediaSessionId: string}>(
            'POST',
            `${this.base}/session?primary=false`,
            {},
        );
        return response.mediaSessionId;
    }

    publish(
        mediaSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
        tracks: PublishTrackRef[],
        video?: VideoPublishIntentDto,
    ): Promise<NegotiateResponse> {
        return this.send<NegotiateResponse>('POST', `${this.base}/tracks`, {
            mediaSessionId,
            sessionDescription,
            tracks,
            ...(video ? {video} : {}),
        });
    }

    /** PUT, not POST: the verb differs from the publish route. `video` belongs here only when it changed. */
    renegotiate(
        mediaSessionId: string,
        sessionDescription: RTCSessionDescriptionInit,
        video?: VideoPublishIntentDto,
    ): Promise<{sessionDescription: RTCSessionDescriptionInit}> {
        return this.send('PUT', `${this.base}/negotiate`, {
            mediaSessionId,
            sessionDescription,
            ...(video ? {video} : {}),
        });
    }

    closeTracks(mediaSessionId: string, trackNames: string[]): Promise<unknown> {
        return this.send('POST', `${this.base}/tracks/close`, {mediaSessionId, trackNames});
    }

    private async send<T>(method: string, url: string, body: unknown): Promise<T> {
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.token}`,
                // Load-bearing: a request without it is bucketed as "default" and splits one user
                // across two devices.
                'X-Device-Id': this.deviceId,
            },
            body: JSON.stringify(body),
            signal:
                typeof AbortSignal?.timeout === 'function'
                    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                    : undefined,
        });
        if (!response.ok) {
            // The body must be carried into the message: `staleSubscription` and `session_error`
            // are only reported there.
            const detail = await response.text().catch(() => '');
            throw new Error(`[screen] ${method} ${url} failed: ${response.status} ${detail}`.trim());
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
    }
}
