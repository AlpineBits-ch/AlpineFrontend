import {bitrateFor, StreamPreset} from '../models/stream-preset';

/** Voice audio is fixed, matching Discord - bitrate there is a per-channel server setting. */
export const VOICE_AUDIO_KBPS = 64;
/** Screen-share audio is fixed stereo. */
export const STREAM_AUDIO_KBPS = 128;
/** Camera video is fixed; Discord exposes no camera bitrate control either. */
export const CAMERA_KBPS = 2500;

/**
 * Fraction of the target bitrate used as the encoding floor.
 *
 * Without a floor, congestion control ramps from ~300 kbps and the first 15-30 s of every stream is
 * mush regardless of the cap - the "slowly catches itself" symptom.
 */
const MIN_BITRATE_RATIO = 0.6;

/**
 * `minBitrate` is a Chromium extension to the spec, so it is absent from `lib.dom`. It is the half
 * of the ramp fix that survives after the SDP start-bitrate has been consumed, so it is worth the
 * cast rather than dropping it.
 */
interface EncodingWithMinBitrate extends RTCRtpEncodingParameters {
    minBitrate?: number;
}

// ── Simulcast ────────────────────────────────────────────────────────────────

/**
 * RTP stream ids for the simulcast ladder, **best first**.
 *
 * <p><b>The names are a ranking, not an abbreviation of a resolution, and the alphabetical order is
 * a requirement rather than a style.</b> The server picks which layer each viewer is served and puts
 * that rid on the subscribe it makes to the SFU on our behalf (see `voice-frontend-guide.md` §6.7),
 * and Cloudflare's <i>only</i> rid-ordering vocabulary is <code>asciibetical</code> - defined as a-z
 * with "a most desirable, z least desirable". That one ordering governs two separate things: which
 * layer a congested viewer is degraded to, and which layer they fall back to when the one they were
 * on stops being published. Both are applied inside the SFU, from the names alone.</p>
 *
 * <p>So the obvious WebRTC convention - <code>q</code> quarter, <code>h</code> half, <code>f</code>
 * full - is not merely a different spelling: it sorts <em>backwards</em> against quality, and a
 * publisher using it asks the SFU to degrade congested viewers <em>up</em> to full resolution. That
 * is the opposite of the entire point. Nothing errors when the names are wrong; the egress bill
 * simply stops going down, which is exactly why this is written out rather than left to look
 * arbitrary.</p>
 *
 * <p>Mirrors `Echo.Voice.Rooms.VoiceVideoLayers` (`High = "a"`, `Medium = "b"`, `Low = "c"`), which
 * is the authority for the spelling.</p>
 */
export const VIDEO_LAYER_RIDS = ['a', 'b', 'c'] as const;
export type VideoLayerRid = typeof VIDEO_LAYER_RIDS[number];

/**
 * How far each layer is scaled down from the captured picture.
 *
 * <p>Powers of two, so the encoder resamples cleanly and the three layers land near the server's own
 * tile-height thresholds (180 / 360 device px, `VoiceSubscriptionOptions`): a 720p capture becomes
 * 720 / 360 / 180 lines, which is the same ladder read from the other end.</p>
 */
const LAYER_SCALE: Record<VideoLayerRid, number> = {a: 1, b: 2, c: 4};

/**
 * Each layer's share of the top layer's bitrate.
 *
 * <p>Bitrate does not scale with pixel count - a quarter-area picture needs far more than a quarter
 * of the bits to look the same - so these are not 1/4 and 1/16. They are the ratios every simulcast
 * ladder in the wild converges on (roughly 1 : 1/3 : 1/10), which for the 2500 kbps camera target
 * gives 2500 / 800 / 250 kbps. The whole ladder costs about 1.4x the top layer alone, and that
 * overhead is the price of not sending 2500 kbps to somebody rendering a 120px thumbnail.</p>
 */
const LAYER_BITRATE_RATIO: Record<VideoLayerRid, number> = {a: 1, b: 0.32, c: 0.1};

/**
 * Build a simulcast ladder as `sendEncodings`.
 *
 * <p><b>This has to happen at `addTransceiver` time.</b> Rids are negotiated in the SDP, so
 * `setParameters` cannot add them afterwards - it can only edit encodings that already exist. A
 * track published with `addTrack`, or with an `addTransceiver` that omitted `sendEncodings`, has one
 * unnamed encoding and no layers for the server to choose between for the rest of its life.</p>
 *
 * <p>`rids` is a prefix of {@link VIDEO_LAYER_RIDS} - dropping layers off the bottom is supported
 * (see {@link screenSendEncodings}) and safe, because the SFU's `ridNotAvailable: asciibetical`
 * fallback serves the nearest layer that does exist rather than nothing.</p>
 *
 * @param kbps the target for the **top** layer; the rest are derived from it.
 */
export function simulcastEncodings(
    kbps: number,
    rids: readonly VideoLayerRid[] = VIDEO_LAYER_RIDS,
): RTCRtpEncodingParameters[] {
    return rids.map(rid => ({
        rid,
        scaleResolutionDownBy: LAYER_SCALE[rid],
        maxBitrate: Math.round(kbps * LAYER_BITRATE_RATIO[rid]) * 1000,
    }));
}

/** The camera ladder: all three layers, since a camera is cheap to encode three times. */
export function cameraSendEncodings(kbps: number = CAMERA_KBPS): RTCRtpEncodingParameters[] {
    return simulcastEncodings(kbps);
}

/**
 * The screen-share ladder: **two layers, `a` full and `b` half. Deliberately no `c`.**
 *
 * <p>Screen content is the one case where the bottom of the ladder is worth giving up:</p>
 *
 * <ul>
 *   <li><b>Legibility.</b> Everything else about this path exists to keep text readable -
 *   {@link applyScreenEncoding} sets `contentHint = 'detail'` and
 *   `degradationPreference = 'maintain-resolution'` precisely so the encoder drops frames rather
 *   than pixels. A quarter-scale layer is that decision reversed: a 1440p share at `c` is 640x360,
 *   which is not a cheaper share but an unreadable one.</li>
 *   <li><b>Encode cost.</b> Screen presets run to 1440p60 at 12 Mbps, and the machine doing the
 *   encoding is by definition the machine running whatever is being demonstrated. A third
 *   full-framerate encode there is the most expensive CPU in the room, spent on the layer with the
 *   least value.</li>
 * </ul>
 *
 * <p>The saving the contract actually names - a minimised 1080p share, §6.4 - lands on `b`, because
 * the server picks the medium layer at a tile height of 360 device px or less. `c` is only reached
 * below 180 px, where `ridNotAvailable: asciibetical` resolves the missing rid to a layer that does
 * exist. The cost of that is one thumbnail served at half resolution instead of a quarter, which is
 * today's behaviour rather than a regression - the failure mode of getting this wrong is a smaller
 * saving, never a black tile.</p>
 */
export function screenSendEncodings(preset: StreamPreset): RTCRtpEncodingParameters[] {
    return simulcastEncodings(bitrateFor(preset), ['a', 'b']);
}

/**
 * The ladder position of an encoding, for code that has to re-derive a layer's share of a target
 * from a sender it did not build. An encoding with no rid, or a rid from outside the ladder, is the
 * top layer: that is the single-encoding sender every non-simulcast publish still produces, and it
 * gets the full target exactly as it did before simulcast existed.
 */
function layerOf(encoding: RTCRtpEncodingParameters): VideoLayerRid {
    const rid = encoding.rid as VideoLayerRid | undefined;
    return rid && rid in LAYER_SCALE ? rid : 'a';
}

/**
 * Configure a screen-share sender from a preset.
 *
 * The two load-bearing settings are `contentHint = 'detail'` and
 * `degradationPreference = 'maintain-resolution'`: together they tell the encoder that this is text
 * and UI, and that under congestion it should drop frames rather than shed resolution. That is what
 * Discord does. The previous `'motion'` hint did the opposite - the encoder scaled the picture down
 * on any bandwidth dip and climbed back over tens of seconds, which is why streams looked soft.
 *
 * <p>Applied across every encoding the sender has, so it is correct for a simulcast ladder
 * ({@link screenSendEncodings}) and for the single unnamed encoding a non-simulcast publish still
 * produces. It never <i>adds</i> encodings: rids are negotiated in the SDP and can only be declared
 * at `addTransceiver` time.</p>
 */
export async function applyScreenEncoding(sender: RTCRtpSender, preset: StreamPreset): Promise<void> {
    if (sender.track) {
        try {
            sender.track.contentHint = 'detail';
        } catch { /* contentHint unsupported */
        }
    }
    const kbps = bitrateFor(preset);
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.degradationPreference = 'maintain-resolution';
        for (const raw of params.encodings) {
            const encoding = raw as EncodingWithMinBitrate;
            const layer = layerOf(encoding);
            const layerKbps = Math.round(kbps * LAYER_BITRATE_RATIO[layer]);
            encoding.maxBitrate = layerKbps * 1000;
            encoding.maxFramerate = preset.framerate;
            encoding.scaleResolutionDownBy = LAYER_SCALE[layer];
            // The floor is the top layer's alone. It exists to stop the picture the viewer is
            // actually looking at full size opening as mush and climbing for half a minute; a lower
            // layer that ramps is being watched in a thumbnail, where nobody can see it happen.
            // Putting a floor on every rung would also raise the aggregate the encoder insists on
            // by the whole ladder, which is a real risk on a 12 Mbps 1440p60 share.
            if (layer === 'a') encoding.minBitrate = Math.round(layerKbps * MIN_BITRATE_RATIO) * 1000;
        }
        await sender.setParameters(params);
    } catch { /* setParameters unsupported, or the call already ended */
    }
}

/**
 * Cap a non-screen sender (mic, camera) at a fixed bitrate.
 *
 * <p>`kbps` is the target for the **top** layer. On a simulcast camera sender the lower rungs are
 * scaled from it by {@link LAYER_BITRATE_RATIO}, so this stays the one place a camera's bitrate is
 * stated even though the ladder was built at `addTransceiver` time. On the single-encoding senders
 * everything else uses - the microphone, screen-share audio - there is one rung, it is the top one,
 * and the behaviour is unchanged.</p>
 */
export async function applySimpleBitrate(sender: RTCRtpSender | null | undefined, kbps: number): Promise<void> {
    if (!sender) return;
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        for (const encoding of params.encodings) {
            encoding.maxBitrate = Math.round(kbps * LAYER_BITRATE_RATIO[layerOf(encoding)]) * 1000;
        }
        await sender.setParameters(params);
    } catch { /* setParameters unsupported, or the call already ended */
    }
}

/** Prefer VP9, then H.264, for better quality-per-bit on screen content. */
export function preferVideoCodecs(transceiver: RTCRtpTransceiver, side: 'sender' | 'receiver'): void {
    const caps = (side === 'sender' ? RTCRtpSender : RTCRtpReceiver).getCapabilities('video')?.codecs ?? [];
    if (!caps.length) return;
    const ordered = [
        ...caps.filter(c => c.mimeType === 'video/VP9'),
        ...caps.filter(c => c.mimeType === 'video/H264'),
        ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
    ];
    try {
        transceiver.setCodecPreferences(ordered);
    } catch { /* codec preferences unsupported */
    }
}

/**
 * Munge `x-google-start-bitrate` into every video media section of an offer.
 *
 * `minBitrate` alone is not honoured until the first bandwidth estimate arrives; the start bitrate
 * is what stops the stream opening at a few hundred kbps and crawling upward.
 */
export function withStartBitrate(sdp: string, kbps: number): string {
    if (!sdp.includes('m=video')) return sdp;

    const lines = sdp.split(/\r\n|\n/);
    const out: string[] = [];
    let inVideo = false;

    for (const line of lines) {
        if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
        out.push(line);
        if (!inVideo) continue;
        const match = /^a=rtpmap:(\d+) /.exec(line);
        if (match) out.push(`a=fmtp:${match[1]} x-google-start-bitrate=${kbps}`);
    }
    return out.join('\r\n');
}
