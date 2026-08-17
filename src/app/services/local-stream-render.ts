import {LocalStreamChunk} from '../platform/screen-publisher-host';

/**
 * The sharer's own tile, decoded from the stream that is actually going out.
 *
 * <p><b>What this replaces.</b> The native publisher captures, encodes and publishes entirely in
 * Rust, so no `MediaStream` for the local share has ever existed in the webview. The tile therefore
 * showed a stand-in: a 480px JPEG at five frames a second, pushed over IPC by
 * `FramePump::emit_preview`. It reads as a broken stream, because at tile size that is exactly what
 * a blurry 5 fps picture looks like - while the stream itself was going out sharp at full rate the
 * whole time.</p>
 *
 * <p><b>Why decode rather than subscribe.</b> The other honest answer is to pull your own track back
 * down from the SFU like any other viewer, which is the most faithful picture there is. It also
 * re-downloads your own stream and puts a server round trip between you and your own screen. The
 * encoder's output is already in the process; handing a copy to a `VideoDecoder` costs roughly the
 * share's bitrate over IPC - less than the JPEG thumbnail cost at any rate worth watching - and the
 * picture is the same bytes, one frame behind.</p>
 *
 * <p><b>What it does not prove.</b> This is the encoder's output, not the network's. A share that
 * encodes perfectly and reaches nobody looks identical here, exactly as the thumbnail did. The
 * viewer-side counters remain the only evidence that anything arrived.</p>
 */

/**
 * Codec strings to offer the decoder, most capable first.
 *
 * <p>All Constrained Baseline (`42E0`), which is what both encoders produce - see the profile note
 * in `encoder_mf.rs`. They differ only in the level byte, and the list is descending because a
 * decoder that accepts 5.2 accepts everything below it; a 4K share would fail a 4.2-only probe.
 * The declared level is a ceiling for the probe, not a claim about the stream: the bitstream is
 * Annex-B with in-band parameter sets, so the real geometry arrives with the first keyframe.</p>
 */
const CODECS = ['avc1.42E034', 'avc1.42E02A', 'avc1.42E01F', 'avc1.42E01E'];

/**
 * How many access units may be waiting on the decoder before deltas start being dropped.
 *
 * <p>A local preview that has fallen behind is worth less than a current one, and the queue is the
 * only place the lag can accumulate: the encoder does not slow down for us. Dropping deltas costs a
 * frozen picture until the next keyframe, which is why the ceiling is loose enough that only a
 * genuinely overloaded decoder reaches it.</p>
 */
const MAX_QUEUE = 6;

/**
 * Whether this webview can decode the publisher's H.264, and with which codec string.
 *
 * <p>Asked before the publish starts, because the answer decides whether Rust sends the feed at
 * all - starting it and discovering the decoder is missing would mean paying the share's bitrate
 * over IPC for frames nothing can read.</p>
 *
 * <p>Null on a host with no `VideoDecoder` (WebKitGTK, notably, which is the Linux desktop webview)
 * and on one that has the API but supports no configuration we can offer. Both fall back to the
 * thumbnail.</p>
 */
export async function pickH264Codec(): Promise<string | null> {
    if (typeof VideoDecoder === 'undefined') return null;
    for (const codec of CODECS) {
        try {
            const support = await VideoDecoder.isConfigSupported({codec});
            if (support.supported) return codec;
        } catch {
            // A codec string this build rejects outright. Not a reason to stop asking about the
            // rest - the list descends through levels precisely because support does.
        }
    }
    return null;
}

/**
 * Decodes access units onto a canvas and exposes the result as a `MediaStream`.
 *
 * <p>A stream rather than a canvas the tiles render directly, so the local share becomes just
 * another `CallScreenShare.stream`: the same `<video>` branch every remote tile uses, and with it
 * fullscreen, pop-out and picture-in-picture, none of which the `<img>` thumbnail could offer. The
 * canvas is the same trick the JPEG capture pipeline uses one layer down in `RustMediaService`.</p>
 */
export class LocalStreamRenderer {
    /** What the tiles bind to. One stream, safe to attach to several `<video>` elements at once. */
    readonly stream: MediaStream;

    /** Frames actually drawn since the last {@link takeRenderedCount}. */
    private rendered = 0;

    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private decoder: VideoDecoder | null = null;
    private closed = false;
    /** Whether the canvas has ever held a picture - see the `onFirstFrame` parameter. */
    private drawnOnce = false;

    /**
     * Whether the decoder is waiting for a point it can start from.
     *
     * <p>True from construction and after every interruption. H.264 deltas are meaningless without
     * the frames they reference, so feeding a fresh decoder mid-GOP produces either an error or -
     * worse, because it looks like a bug in the share - a smear of the wrong pixels.</p>
     */
    private awaitingKeyframe = true;

    /**
     * @param width  the publish geometry, which is fixed for the life of a share. The canvas is
     *               sized once from it and never resized: `captureStream` is already attached, and
     *               changing a live canvas's dimensions changes the track's.
     * @param height as above.
     * @param codec  a string {@link pickH264Codec} has already confirmed.
     * @param onFailure called when the decoder gives up, so the caller can fall back to the
     *                  thumbnail rather than leaving a tile frozen on its last good frame.
     * @param onFirstFrame called once the canvas actually holds a picture. This is what a caller
     *                  waits for before showing {@link stream} anywhere: the track exists from
     *                  construction but produces nothing until the first keyframe is decoded, and a
     *                  `<video>` bound to it in the meantime is a black tile where the thumbnail
     *                  would have been.
     */
    constructor(
        width: number,
        height: number,
        private readonly codec: string,
        private readonly onFailure: () => void,
        private readonly onFirstFrame: () => void = () => void 0,
    ) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d')!;
        // captureStream(0) is manual: the track produces a frame only when requestFrame() is called
        // after a draw, so a decoder that stalls shows its last picture rather than a black tile.
        this.stream = this.canvas.captureStream(0);
        this.configure();
    }

    /**
     * Feed one access unit.
     *
     * <p>Every drop path here ends in {@link awaitingKeyframe}, which is what keeps a dropped frame
     * from turning into a corrupted picture: whatever the reason, the decoder is not fed again
     * until something it can start from arrives. The encoder issues one at least every two seconds
     * unprompted, and immediately when the feed is turned back on.</p>
     */
    push(chunk: LocalStreamChunk): void {
        const decoder = this.decoder;
        if (this.closed || !decoder || decoder.state !== 'configured') return;

        if (this.awaitingKeyframe) {
            if (!chunk.keyframe) return;
            this.awaitingKeyframe = false;
        }

        // Behind, and only the deltas are droppable - a keyframe is the thing that ends the drop.
        if (decoder.decodeQueueSize > MAX_QUEUE && !chunk.keyframe) {
            this.awaitingKeyframe = true;
            return;
        }

        try {
            decoder.decode(
                new EncodedVideoChunk({
                    type: chunk.keyframe ? 'key' : 'delta',
                    timestamp: chunk.timestampUs,
                    // Copied, not passed by reference: `data` is a view over the buffer the IPC layer
                    // handed us and `decode` may hold it past this call.
                    data: chunk.data.slice(),
                }),
            );
        } catch {
            // A malformed unit, or a decoder that errored between the state check and here.
            this.awaitingKeyframe = true;
        }
    }

    /**
     * Declare the stream interrupted, so nothing is decoded until the next keyframe.
     *
     * <p>Called when the feed is turned off - the frames that arrive after it comes back reference
     * ones this decoder never saw.</p>
     */
    interrupt(): void {
        this.awaitingKeyframe = true;
    }

    /** Frames drawn since the last call, and resets the count. Drives the tile's fps readout. */
    takeRenderedCount(): number {
        const count = this.rendered;
        this.rendered = 0;
        return count;
    }

    close(): void {
        this.closed = true;
        try {
            this.decoder?.close();
        } catch {
            // Already closed, or closed by its own error handler. Nothing left to release.
        }
        this.decoder = null;
        this.stream.getTracks().forEach(track => track.stop());
    }

    private configure(): void {
        try {
            const decoder = new VideoDecoder({
                output: frame => this.draw(frame),
                error: () => this.fail(),
            });
            decoder.configure({
                codec: this.codec,
                // No `description`: the stream is Annex-B, so the parameter sets arrive in band
                // with every keyframe and there is nothing to hand over up front.
                optimizeForLatency: true,
            });
            this.decoder = decoder;
        } catch {
            this.fail();
        }
    }

    /**
     * A decoder error is terminal for this renderer.
     *
     * <p>Deliberately not retried in place. The failures that reach here are a codec the host
     * turned out not to support and a stream it cannot follow, and both would fail again on the
     * next keyframe - a retry loop would spend the share's whole bitrate discovering that
     * repeatedly. The caller falls back to the thumbnail, which never stopped being sent.</p>
     */
    private fail(): void {
        if (this.closed) return;
        this.close();
        this.onFailure();
    }

    private draw(frame: VideoFrame): void {
        if (this.closed) {
            frame.close();
            return;
        }
        try {
            const {width, height} = this.canvas;
            // Rust fits every frame to the publish geometry before encoding, so this is normally a
            // 1:1 blit. Letterboxed anyway rather than stretched, because "normally" is doing work
            // here: the first frames of a share can arrive before a geometry change has taken.
            const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
            const dw = frame.displayWidth * scale;
            const dh = frame.displayHeight * scale;
            if (dw < width || dh < height) {
                this.ctx.fillStyle = '#000';
                this.ctx.fillRect(0, 0, width, height);
            }
            this.ctx.drawImage(frame, (width - dw) / 2, (height - dh) / 2, dw, dh);
            this.rendered++;
            // captureStream(0) captures on demand only.
            (this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame();
            // After the draw and the requestFrame, so a caller acting on this synchronously finds a
            // track that already has a frame to give rather than one still about to.
            if (!this.drawnOnce) {
                this.drawnOnce = true;
                this.onFirstFrame();
            }
        } finally {
            // A VideoFrame holds a decoder buffer. Leaking even a few stalls the decoder outright,
            // so this is a finally rather than a line at the end of the happy path.
            frame.close();
        }
    }
}
