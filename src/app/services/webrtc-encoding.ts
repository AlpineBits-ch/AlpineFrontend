import {bitrateFor, StreamContent, StreamPreset} from '../models/stream-preset';

/** Voice audio is fixed, matching Discord; bitrate there is a per-channel server setting. */
export const VOICE_AUDIO_KBPS = 64;
/** Screen-share audio is fixed stereo. */
export const STREAM_AUDIO_KBPS = 128;
/** Camera video is fixed; Discord exposes no camera bitrate control either. */
export const CAMERA_KBPS = 2500;

/** Fraction of the target bitrate used as the encoding floor. */
const MIN_BITRATE_RATIO = 0.6;

/** `minBitrate` is a Chromium extension to the spec, so it is absent from `lib.dom`. */
interface EncodingWithMinBitrate extends RTCRtpEncodingParameters {
    minBitrate?: number;
}

// ── Simulcast ────────────────────────────────────────────────────────────────

/**
 * RTP stream ids for the simulcast ladder, best first.
 *
 * The names are a ranking, and the a-z order is a requirement: the SFU degrades and falls back
 * asciibetically from the names alone, so q/h/f would silently degrade viewers upward.
 */
export const VIDEO_LAYER_RIDS = ['a', 'b', 'c'] as const;
export type VideoLayerRid = typeof VIDEO_LAYER_RIDS[number];

/** How far each layer is scaled down from the captured picture. */
const LAYER_SCALE: Record<VideoLayerRid, number> = {a: 1, b: 2, c: 4};

/** Each layer's share of the top layer's bitrate. */
const LAYER_BITRATE_RATIO: Record<VideoLayerRid, number> = {a: 1, b: 0.32, c: 0.1};

/**
 * Build a simulcast ladder as `sendEncodings`, from a target for the top layer.
 *
 * Rids are negotiated in the SDP, so this must happen at `addTransceiver` time: `setParameters`
 * can only edit encodings that already exist, never add layers.
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
 * The screen-share ladder: two layers, `a` full and `b` half, no `c`.
 *
 * The ladder must stay identical in both content modes: rids are fixed at `addTransceiver` time
 * while the quality bar changes the mode live, so a mode-dependent ladder cannot be toggled.
 */
export function screenSendEncodings(preset: StreamPreset): RTCRtpEncodingParameters[] {
    return simulcastEncodings(bitrateFor(preset), ['a', 'b']);
}

/** The ladder position of an encoding; no rid, or a rid outside the ladder, is the top layer. */
function layerOf(encoding: RTCRtpEncodingParameters): VideoLayerRid {
    const rid = encoding.rid as VideoLayerRid | undefined;
    return rid && rid in LAYER_SCALE ? rid : 'a';
}

/** What each content mode sacrifices under congestion; hint and degradation are one decision, never split. */
export const CONTENT_POLICY: Record<StreamContent, {hint: string; degradation: RTCDegradationPreference}> = {
    // A game is video. Shed pixels and keep the motion smooth.
    games: {hint: 'motion', degradation: 'maintain-framerate'},
    // Text and UI. Shed frames and keep the pixels, because a downscaled document is unreadable at
    // any framerate while a 10 fps one is merely slow.
    text: {hint: 'detail', degradation: 'maintain-resolution'},
};

/**
 * Configure a screen-share sender from a preset, applied across every encoding it has.
 *
 * Never adds encodings: rids can only be declared at `addTransceiver` time.
 */
export async function applyScreenEncoding(sender: RTCRtpSender, preset: StreamPreset): Promise<void> {
    const policy = CONTENT_POLICY[preset.content];
    if (sender.track) {
        try {
            sender.track.contentHint = policy.hint;
        } catch { /* contentHint unsupported */
        }
    }
    const kbps = bitrateFor(preset);
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.degradationPreference = policy.degradation;
        for (const raw of params.encodings) {
            const encoding = raw as EncodingWithMinBitrate;
            const layer = layerOf(encoding);
            const layerKbps = Math.round(kbps * LAYER_BITRATE_RATIO[layer]);
            encoding.maxBitrate = layerKbps * 1000;
            encoding.maxFramerate = preset.framerate;
            encoding.scaleResolutionDownBy = LAYER_SCALE[layer];
            // Top layer only: a floor on every rung raises the aggregate the encoder insists on by
            // the whole ladder.
            if (layer === 'a') encoding.minBitrate = Math.round(layerKbps * MIN_BITRATE_RATIO) * 1000;
        }
        await sender.setParameters(params);
    } catch { /* setParameters unsupported, or the call already ended */
    }
}

/** Cap a non-screen sender (mic, camera): `kbps` targets the top layer, lower rungs scale from it. */
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

/** Munge `x-google-start-bitrate` into every video media section of an offer. */
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
