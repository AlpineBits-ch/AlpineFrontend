/** Output resolution for a screen share. 'source' keeps the source's own dimensions. */
export type StreamResolution = '720p' | '1080p' | '1440p' | '2160p' | 'source';

/** The three framerates Discord offers. */
export type StreamFramerate = 15 | 30 | 60;

/**
 * What is being shared, which decides what gets sacrificed when there is not enough bandwidth.
 * `games` sheds pixels and holds the framerate; `text` sheds frames and holds the pixels.
 */
export type StreamContent = 'games' | 'text';

/** Resolution and framerate are chosen together, and bitrate is derived from the pair. */
export interface StreamPreset {
    resolution: StreamResolution;
    framerate: StreamFramerate;
    content: StreamContent;
}

/** Target bitrate per (resolution, framerate), in kbps. */
const BITRATES: Record<StreamResolution, Record<StreamFramerate, number>> = {
    '720p': {15: 1500, 30: 2500, 60: 4000},
    '1080p': {15: 2500, 30: 4500, 60: 8000},
    '1440p': {15: 4000, 30: 8000, 60: 12000},
    '2160p': {15: 5000, 30: 10000, 60: 16000},
    source: {15: 6000, 30: 10000, 60: 18000},
};

/** The pixel box each resolution fits into. Every edge must stay divisible by four. */
const BOXES: Record<StreamResolution, [number, number] | null> = {
    '720p': [1280, 720],
    '1080p': [1920, 1080],
    '1440p': [2560, 1440],
    '2160p': [3840, 2160],
    source: null,
};

export const RESOLUTION_LABELS: Record<StreamResolution, string> = {
    '720p': '720p',
    '1080p': '1080p',
    '1440p': '1440p',
    '2160p': '2160p',
    source: 'Source',
};

export const FRAMERATE_OPTIONS: StreamFramerate[] = [15, 30, 60];

export const CONTENT_OPTIONS: StreamContent[] = ['games', 'text'];

export const DEFAULT_STREAM_PRESET: StreamPreset = {resolution: '1080p', framerate: 30, content: 'text'};

/** Target bitrate in kbps for a preset. The content mode has no bitrate axis. */
export function bitrateFor(preset: Pick<StreamPreset, 'resolution' | 'framerate'>): number {
    return BITRATES[preset.resolution][preset.framerate];
}

/** The pixel box a resolution fits into, or null for 'source' (use the source's own size). */
export function boxFor(resolution: StreamResolution): [number, number] | null {
    return BOXES[resolution];
}

// ── Entitlement ceiling ──────────────────────────────────────────────────────

/** What the granted rung permits. Both numbers zero is the `none` rung, which is audio-only. */
export interface VideoCeiling {
    maxHeight: number;
    maxFramerate: number;
}

/** The pixel height behind each option. Null on `source`, whose height this client cannot know. */
const RESOLUTION_HEIGHTS: Record<StreamResolution, number | null> = {
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '2160p': 2160,
    source: null,
};

/** Known heights, ascending, for picking the tallest option a ceiling still permits. */
const MEASURED_RESOLUTIONS: StreamResolution[] = ['720p', '1080p', '1440p', '2160p'];

export function resolutionHeight(resolution: StreamResolution): number | null {
    return RESOLUTION_HEIGHTS[resolution];
}

/** Whether a ceiling forbids video outright, which is the `none` rung and nothing else. */
export function isAudioOnlyCeiling(ceiling: VideoCeiling | null | undefined): boolean {
    return !!ceiling && ceiling.maxHeight <= 0;
}

/** Whether a resolution is inside the granted rung. True for everything when no ceiling is held. */
export function isResolutionAllowed(
    resolution: StreamResolution,
    ceiling: VideoCeiling | null | undefined,
): boolean {
    if (!ceiling) return true;
    if (isAudioOnlyCeiling(ceiling)) return false;
    const height = RESOLUTION_HEIGHTS[resolution];
    return height === null || height <= ceiling.maxHeight;
}

/** Whether a framerate is inside the granted rung. A lower framerate is always allowed. */
export function isFramerateAllowed(
    framerate: StreamFramerate,
    ceiling: VideoCeiling | null | undefined,
): boolean {
    if (!ceiling) return true;
    if (isAudioOnlyCeiling(ceiling)) return false;
    return framerate <= ceiling.maxFramerate;
}

/**
 * The preset this client should actually ask for, given what it was granted.
 * Returns the input untouched when there is no ceiling and when the ceiling is `none`.
 */
export function clampPreset(preset: StreamPreset, ceiling: VideoCeiling | null | undefined): StreamPreset {
    if (!ceiling || isAudioOnlyCeiling(ceiling)) return preset;

    const resolution = isResolutionAllowed(preset.resolution, ceiling)
        ? preset.resolution
        : tallestAllowed(ceiling) ?? preset.resolution;

    const framerate = isFramerateAllowed(preset.framerate, ceiling)
        ? preset.framerate
        : fastestAllowed(ceiling);

    return resolution === preset.resolution && framerate === preset.framerate
        ? preset
        : {...preset, resolution, framerate};
}

function tallestAllowed(ceiling: VideoCeiling): StreamResolution | null {
    let best: StreamResolution | null = null;
    for (const resolution of MEASURED_RESOLUTIONS) {
        if (RESOLUTION_HEIGHTS[resolution]! <= ceiling.maxHeight) best = resolution;
    }
    return best;
}

function fastestAllowed(ceiling: VideoCeiling): StreamFramerate {
    let best: StreamFramerate = FRAMERATE_OPTIONS[0];
    for (const fps of FRAMERATE_OPTIONS) {
        if (fps <= ceiling.maxFramerate) best = fps;
    }
    return best;
}
