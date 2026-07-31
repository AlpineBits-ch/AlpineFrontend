/** Output resolution for a screen share. 'source' keeps the source's own dimensions. */
export type StreamResolution = '720p' | '1080p' | '1440p' | 'source';

/** The three framerates Discord offers. */
export type StreamFramerate = 15 | 30 | 60;

/**
 * Resolution and framerate are chosen together, and bitrate is derived from the pair.
 *
 * Coupling them is what makes `degradationPreference: 'maintain-resolution'` safe: the encoder is
 * never asked to hold a high resolution on a bitrate budget picked for a lower one. Exposing
 * bitrate as its own setting (as this app used to) let users starve the encoder into single-digit
 * fps, which is why the framerate used to be inferred from the bitrate instead of chosen.
 */
export interface StreamPreset {
    resolution: StreamResolution;
    framerate: StreamFramerate;
}

const BITRATES: Record<StreamResolution, Record<StreamFramerate, number>> = {
    '720p': {15: 1500, 30: 2500, 60: 4000},
    '1080p': {15: 2500, 30: 4500, 60: 8000},
    '1440p': {15: 4000, 30: 8000, 60: 12000},
    source: {15: 6000, 30: 10000, 60: 18000},
};

const BOXES: Record<StreamResolution, [number, number] | null> = {
    '720p': [1280, 720],
    '1080p': [1920, 1080],
    '1440p': [2560, 1440],
    source: null,
};

export const RESOLUTION_LABELS: Record<StreamResolution, string> = {
    '720p': '720p',
    '1080p': '1080p',
    '1440p': '1440p',
    source: 'Source',
};

export const FRAMERATE_OPTIONS: StreamFramerate[] = [15, 30, 60];

export const DEFAULT_STREAM_PRESET: StreamPreset = {resolution: '1080p', framerate: 30};

/** Target bitrate in kbps for a preset. */
export function bitrateFor(preset: StreamPreset): number {
    return BITRATES[preset.resolution][preset.framerate];
}

/** The pixel box a resolution fits into, or null for 'source' (use the source's own size). */
export function boxFor(resolution: StreamResolution): [number, number] | null {
    return BOXES[resolution];
}
