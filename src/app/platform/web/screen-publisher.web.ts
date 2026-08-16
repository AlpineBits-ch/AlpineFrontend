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
 * Screen sharing in a browser: `getDisplayMedia` and a peer connection of its own.
 *
 * <p><b>This replaces the canvas pipeline rather than reusing it.</b> On desktop the picture reaches the
 * webview as base64 JPEGs that are decoded, drawn to a canvas and re-encoded by the browser; here the
 * captured track is published directly, so the JPEG round trip disappears entirely.</p>
 *
 * <p>The share gets its own media session, exactly as the Rust publisher's does, and is <b>secondary</b>
 * - `primary=false` - because the primary session is the one recorded as carrying the participant's
 * voice, and a screen share must never claim it. Viewers cannot tell the two publishers apart: they
 * resolve a stream from `{mediaSessionId, trackName}` and neither field says who produced it.</p>
 *
 * <p>Signalling is plain `fetch` against the same routes, with the same `Authorization` and
 * `X-Device-Id` headers, that `signalling.rs` uses - not `HttpClient`. The token, api base and device
 * id arrive in {@link ScreenPublishOptions} precisely so this path does not have to re-derive them, and
 * an interceptor chain built for the app's own requests is not something to inherit by accident here.
 * The device id in particular is load-bearing: an unstamped request is bucketed as `"default"` and
 * splits one user across two devices.</p>
 *
 * <p>What a web user gives up against desktop, all of it reported through {@link hasSourcePicker} and
 * {@link ScreenPublishResult.audioTrackName} rather than assumed: no in-app source list or thumbnails,
 * no whole-desktop <i>audio</i> (the host offers audio per tab or window, and only on Chromium), and no
 * choice of hardware encoder.</p>
 */
export class WebScreenPublisher extends ScreenPublisher implements ScreenPublisherHost {
    /**
     * False: `getDisplayMedia` opens the host's own picker, so the in-app one is skipped.
     *
     * <p>This is the flag the UI branches on, and it is also why {@link sources} is empty - see there.</p>
     */
    readonly hasSourcePicker = false;

    /** No Rust side at all. The browser fallback for the legacy capture surface lives in the caller. */
    readonly nativeCapture = false;

    private live: LiveShare | null = null;
    private previewSink: ((dataUrl: string) => void) | null = null;
    private endedSink: (() => void) | null = null;

    /**
     * Empty, always.
     *
     * <p>A browser cannot enumerate windows, and <b>fabricating a single "your screen" entry would be
     * worse than answering nothing</b>: the picker would offer a source whose id means nothing to
     * `start()`, and the id it produced could not be honoured. Callers learn this from
     * {@link hasSourcePicker} and skip the in-app picker entirely.</p>
     */
    async sources(): Promise<ScreenSource[]> {
        return [];
    }

    /** Empty for the same reason as {@link sources}: there are no ids to have thumbnails of. */
    async thumbnails(_ids: string[]): Promise<SourceThumbnail[]> {
        return [];
    }

    /**
     * Capture and publish, opening the host picker on the way.
     *
     * <p>`o.sourceId` is ignored - the host picker is the source chooser. Geometry, framerate and
     * bitrate are <b>not</b> re-derived: they arrive already solved by `publishOptions`/`solveGeometry`,
     * which is what makes a preset mean the same thing on both hosts.</p>
     */
    async start(o: ScreenPublishOptions): Promise<ScreenPublishResult> {
        // One share at a time, matching the Rust publisher's singleton. Awaited, not fired off: this is
        // also the resolution-change path, and the new capture must not overlap the old one.
        await this.stopLive();

        const capture = await captureDisplay({
            width: o.width,
            height: o.height,
            fps: o.fps,
            audio: o.shareAudio ?? false,
        });
        if (capture.audioUnavailable) {
            // Said, not swallowed. The result's null `audioTrackName` is what the UI reads, but a
            // user who ticked "share audio" and got none deserves the reason in the log too.
            console.warn('[screen] audio was requested but this host published none; sharing video only');
        }

        const signalling = new Signalling(o);
        let pc: RTCPeerConnection | null = null;
        try {
            const mediaSessionId = await signalling.createSession();

            pc = new RTCPeerConnection({iceServers: o.iceServers, bundlePolicy: 'max-bundle'});
            // Separate streams for the two halves, matching the Rust publisher. Sharing one would have
            // them arrive as a single MediaStream, which is what a *camera* looks like; a receiving
            // client groups a share by its track names.
            // addTransceiver for the video half, not addTrack: `sendEncodings` is only honoured when
            // the transceiver is created, and it is what names the simulcast rids the server picks
            // between on each viewer's behalf. `streams` keeps the association addTrack gave.
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

            // VP9 first: better quality-per-bit than VP8 on screen content, and the receive side
            // orders its codecs the same way.
            preferVideoCodecs(videoTransceiver, 'sender');

            const offer = await pc.createOffer();
            // Open near the target rate instead of letting congestion control ramp from ~300 kbps
            // over the first half-minute.
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

            // Both halves in one negotiation, as the contract asks: two would announce the halves of
            // one share separately, and a viewer would build the tile and then have audio arrive
            // against a share it had already laid out.
            //
            // The declared size is the solved capture geometry, not the preset's nominal height: an
            // ultrawide fitted into a 1080p box encodes 540 lines, and stating 1080 there would have
            // the server cap a share that is already well inside its rung.
            const response = await signalling.publish(
                mediaSessionId, pc.localDescription!, tracks, publishIntent(o));
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
            // What was *published*, not what was asked for: the audio half can be refused on its own,
            // and announcing a track that does not exist has every viewer subscribe to nothing.
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
            // After `live` is set: both of these can fire immediately, and both need it.
            this.watchForHostStop(capture.video, o.shareId);
            this.startPreview();

            return {
                mediaSessionId,
                trackName: videoResult.trackName,
                audioTrackName: publishedAudioName,
                // No encoder choice to report - the browser owns that. Named rather than left blank so
                // a log line reads as "the browser did it" instead of as a missing field.
                encoder: 'browser',
            };
        } catch (e) {
            // Nothing half-open: the capture is already running by this point, and a failed publish
            // that leaves it running holds the screen-capture indicator up over nothing.
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
        // Both halves. The capture constraint decides how many frames arrive; `maxFramerate` on the
        // encoding decides how many are sent, and leaving that at the old value caps a raise.
        await retargetDisplayFps(live.capture.video, rounded);
        try {
            const params = live.videoSender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            // Every rung of the ladder, not just the top one: a viewer parked on the half-scale
            // layer would otherwise keep the old cap and be the only person a framerate change did
            // not reach.
            for (const encoding of params.encodings) encoding.maxFramerate = rounded;
            await live.videoSender.setParameters(params);
        } catch { /* setParameters unsupported, or the share already ended */
        }
    }

    async setSpec(shareId: string, spec: PublishSpec): Promise<void> {
        const live = this.assertLive(shareId, 'setSpec');
        // Both halves, exactly as setFps does. The capture constraint decides what size the browser
        // hands the encoder; the encoding's bitrate is what the preset budgeted for that size, and
        // leaving it behind would either starve the new resolution or overspend on it.
        await retargetDisplayGeometry(live.capture.video, Math.round(spec.width), Math.round(spec.height));
        try {
            const params = live.videoSender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            for (const encoding of params.encodings) encoding.maxBitrate = Math.round(spec.kbps) * 1000;
            // The mode's own two settings. On this host `applyScreenEncoding` sets them too, from
            // the preset, whenever the bar changes one - but a caller reaching the port directly
            // must not be able to move the geometry while leaving the mode behind, which is the
            // whole reason these travel as one spec.
            const policy = CONTENT_POLICY[spec.content];
            params.degradationPreference = policy.degradation;
            if (live.videoSender.track) live.videoSender.track.contentHint = policy.hint;
            await live.videoSender.setParameters(params);
        } catch { /* setParameters unsupported, or the share already ended */
        }
    }

    async setAudioMuted(shareId: string, muted: boolean): Promise<void> {
        const live = this.assertLive(shareId, 'setAudioMuted');
        // Stops packets rather than the capture, so unmuting is instant. A no-op on a video-only share,
        // which is the honest answer - the UI reads `audioTrackName` to decide whether to offer this.
        if (live.capture.audio) live.capture.audio.enabled = !muted;
    }

    /**
     * Live outbound stats for the running publication, or null when `shareId` is stale.
     *
     * <p>Deliberately not routed through {@link assertLive}: that helper throws, which is right for
     * a command that changes the share and wrong here - a stats poll racing a share that just ended
     * is routine, not a bug, and the port's contract is to answer null rather than surface it as an
     * error.</p>
     *
     * <p>The video transceiver's `mid` is looked up fresh rather than reusing the one recorded at
     * publish time in {@link start}: `getTransceivers` is cheap and this stays correct across a
     * renegotiation that could in principle move it. `getTransceivers` is optional here only because
     * a test double's fake `RTCPeerConnection` has no reason to implement the full interface; the
     * real browser type always has it.</p>
     */
    async stats(shareId: string): Promise<StreamStatsSnapshot | null> {
        const live = this.live;
        if (!live || live.shareId !== shareId) return null;

        const report = await live.pc.getStats();
        const mid = live.pc.getTransceivers?.().find(t => t.sender.track?.kind === 'video')?.mid
            ?? firstOutboundVideoMid(report);
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
        // Deliberately not a throw: this one runs on teardown paths that do not know which pipeline
        // was used, and making cleanup fail is worse than making it a no-op.
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

    /**
     * Accepted and never called, and correctly so.
     *
     * <p>This feed exists because the native publisher puts no `MediaStream` in the webview. A
     * browser publish is the opposite case - the display track is right here - so the local tile
     * renders the real thing directly and there is nothing an encoded copy could add.</p>
     */
    onPublishChunk(_handler: (chunk: LocalStreamChunk) => void): void {
    }

    /** Nothing to gate: see {@link onPublishChunk}. */
    async setLocalStreamEnabled(_enabled: boolean): Promise<void> {
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    /**
     * Refuse a command aimed at a share that is not the running one, and hand back the running one.
     *
     * <p>Same contract as the Tauri adapter's: a stale id fails loudly rather than landing on whatever
     * happens to be publishing now.</p>
     */
    private assertLive(shareId: string, action: string): LiveShare {
        if (this.live && this.live.shareId === shareId) return this.live;
        throw new Error(
            `[screen] ${action}('${shareId}') refused: the live share is ` +
            `${this.live === null ? 'none' : `'${this.live.shareId}'`}`,
        );
    }

    /**
     * End the running share, in the order the SFU needs.
     *
     * <p>Tracks are closed at the SFU first, then locally: the other way round leaves viewers pulling a
     * track whose sender has gone quiet, which looks like a frozen stream rather than a stopped one.
     * The close is best-effort - the local teardown must happen even when the request fails, or the
     * capture indicator stays up on a share nobody can see.</p>
     */
    private async stopLive(): Promise<void> {
        const live = this.live;
        if (!live) return;
        this.live = null;

        if (live.previewTimer !== null) clearInterval(live.previewTimer);
        const names = [live.trackName, ...(live.audioTrackName ? [live.audioTrackName] : [])];
        await live.signalling.closeTracks(live.mediaSessionId, names).catch(e =>
            console.warn('[screen] closing the published tracks failed', e));

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
     * Notice the host's own "Stop sharing" and take the publish down with it.
     *
     * <p>The browser's capture bar is the primary way a web user ends a share, and it does not go
     * through the app at all - the track simply ends. Without this the SFU would keep a session for a
     * dead track and every viewer would sit on a frozen frame.</p>
     *
     * <p>The id is captured so a late `onended` from a share that has already been replaced cannot tear
     * down its successor.</p>
     */
    private watchForHostStop(video: MediaStreamTrack, shareId: string): void {
        video.onended = () => {
            if (this.live?.shareId !== shareId) return;
            console.info('[screen] the host ended the capture; stopping the publish');
            void this.stopLive().finally(() => this.endedSink?.());
        };
    }

    /**
     * Feed the sharer's own low-rate thumbnail, the same shape the native publisher pushes.
     *
     * <p>Deliberately a thumbnail and not the `MediaStream`: the local tile has one thing to render on
     * either host, and a full-size self-view of a screen share is a second decode of the same picture
     * for no benefit. Skipped entirely when nothing has registered a sink, so it costs nothing where it
     * is not shown.</p>
     */
    private startPreview(): void {
        const live = this.live;
        if (!live || !this.previewSink || typeof document === 'undefined') return;

        let video: HTMLVideoElement;
        let canvas: HTMLCanvasElement;
        try {
            video = document.createElement('video');
            video.muted = true;
            video.srcObject = new MediaStream([live.capture.video]);
            void video.play().catch(() => {
            });
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
            } catch { /* a frame that could not be grabbed is skipped, not fatal */
            }
        }, PREVIEW_INTERVAL_MS);
    }
}

/**
 * What this share is about to encode, or nothing when it cannot be stated.
 *
 * <p>`publishOptions` is the one place a preset becomes pixels, so these are the numbers the capture
 * constraints and the encoder both get - which is what makes the declaration true rather than a
 * restatement of what the picker offered.</p>
 */
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

/**
 * The mid of the first outgoing video stream in a report.
 *
 * <p>The fallback for when no transceiver lookup is available - a test double's fake peer
 * connection, in practice - which is also what keeps {@link WebScreenPublisher.stats} testable
 * without a real `RTCPeerConnection`.</p>
 */
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
 * The voice signalling routes, mirroring `src-tauri/src/media/publisher/signalling.rs`.
 *
 * <p>These are <b>gateway</b> paths, not the backend controllers' own routes: the proxy matches on a
 * service segment and strips it, so the segment after `v1` names the service and never appears in the
 * controller route. Deriving them from the controllers is how the DM call route came to be missing its
 * `messaging/` segment and 404'd at the gateway.</p>
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

    /**
     * Open a media session for this share alone.
     *
     * <p>`primary=false` is load-bearing: the primary session is the one the backend records as
     * carrying the participant's voice, and a screen share claiming it would have peers pull audio
     * from a session that has none.</p>
     */
    async createSession(): Promise<string> {
        const response = await this.send<{mediaSessionId: string}>('POST', `${this.base}/session?primary=false`, {});
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

    /**
     * PUT, not POST - the verb differs from the publish route.
     *
     * <p>`video` re-declares what this session now encodes, and belongs here only when this
     * renegotiation is what changed it. Absent leaves the server's recorded size alone in both
     * directions, so the renegotiation that follows a publish sends nothing new.</p>
     */
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
                // The same header the webview sends. A request without it is bucketed as "default",
                // which splits one user across two devices.
                'X-Device-Id': this.deviceId,
            },
            body: JSON.stringify(body),
            signal: typeof AbortSignal?.timeout === 'function'
                ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                : undefined,
        });
        if (!response.ok) {
            // The body is carried into the message: `staleSubscription` and `session_error` are both
            // reported in it, and a bare status code is what made these failures undiagnosable.
            const detail = await response.text().catch(() => '');
            throw new Error(`[screen] ${method} ${url} failed: ${response.status} ${detail}`.trim());
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
    }
}
