import {bitrateFor, StreamPreset} from '../models/stream-preset';

/** Voice audio is fixed, matching Discord — bitrate there is a per-channel server setting. */
export const VOICE_AUDIO_KBPS = 64;
/** Screen-share audio is fixed stereo. */
export const STREAM_AUDIO_KBPS = 128;
/** Camera video is fixed; Discord exposes no camera bitrate control either. */
export const CAMERA_KBPS = 2500;

/**
 * Fraction of the target bitrate used as the encoding floor.
 *
 * Without a floor, congestion control ramps from ~300 kbps and the first 15-30 s of every stream is
 * mush regardless of the cap — the "slowly catches itself" symptom.
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

/**
 * Configure a screen-share sender from a preset.
 *
 * The two load-bearing settings are `contentHint = 'detail'` and
 * `degradationPreference = 'maintain-resolution'`: together they tell the encoder that this is text
 * and UI, and that under congestion it should drop frames rather than shed resolution. That is what
 * Discord does. The previous `'motion'` hint did the opposite — the encoder scaled the picture down
 * on any bandwidth dip and climbed back over tens of seconds, which is why streams looked soft.
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
        const encoding = params.encodings[0] as EncodingWithMinBitrate;
        encoding.maxBitrate = kbps * 1000;
        encoding.minBitrate = Math.round(kbps * MIN_BITRATE_RATIO) * 1000;
        encoding.maxFramerate = preset.framerate;
        encoding.scaleResolutionDownBy = 1;
        await sender.setParameters(params);
    } catch { /* setParameters unsupported, or the call already ended */
    }
}

/** Cap a non-screen sender (mic, camera) at a fixed bitrate. */
export async function applySimpleBitrate(sender: RTCRtpSender | null | undefined, kbps: number): Promise<void> {
    if (!sender) return;
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = kbps * 1000;
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
