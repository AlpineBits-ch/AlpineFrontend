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

// ── Entitlement ceiling ──────────────────────────────────────────────────────

/**
 * What the granted rung permits, in the two numbers the server publishes for it.
 *
 * <p>Both zero is the `none` rung, which is audio-only and not a ceiling to clamp against - it is a
 * state in which there is no picker at all.</p>
 */
export interface VideoCeiling {
    maxHeight: number;
    maxFramerate: number;
}

/**
 * The pixel height behind each option, or null where this client genuinely cannot know it.
 *
 * <p>`source` is the null, and it stays offered whatever the ceiling says. Guessing a height for it
 * would be inventing the (resolution, framerate) to rung mapping the server publishes precisely so
 * that nobody invents it - and a pricing decision made in this file is one nobody can change later.
 * The server clamps it and says so with a `voice.video_ceiling` degradation, which is exactly what
 * guide section 9 rule 4 asks for.</p>
 */
const RESOLUTION_HEIGHTS: Record<StreamResolution, number | null> = {
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    source: null,
};

/** Known heights, ascending, for picking the tallest option a ceiling still permits. */
const MEASURED_RESOLUTIONS: StreamResolution[] = ['720p', '1080p', '1440p'];

export function resolutionHeight(resolution: StreamResolution): number | null {
    return RESOLUTION_HEIGHTS[resolution];
}

/** Whether a ceiling forbids video outright, which is the `none` rung and nothing else. */
export function isAudioOnlyCeiling(ceiling: VideoCeiling | null | undefined): boolean {
    return !!ceiling && ceiling.maxHeight <= 0;
}

/**
 * Whether a resolution is inside the granted rung.
 *
 * <p>True for everything when no ceiling is held: a client-side clamp is a courtesy, so "nothing
 * says otherwise" has to mean "offer it and let the server answer".</p>
 */
export function isResolutionAllowed(
    resolution: StreamResolution,
    ceiling: VideoCeiling | null | undefined,
): boolean {
    if (!ceiling) return true;
    if (isAudioOnlyCeiling(ceiling)) return false;
    const height = RESOLUTION_HEIGHTS[resolution];
    return height === null || height <= ceiling.maxHeight;
}

/**
 * Whether a framerate is inside the granted rung.
 *
 * <p><b>A lower framerate is always allowed</b> - guide section 9 rule 2 - so every 15 fps option
 * is legal on every rung above `none`, including rungs whose name only mentions 30 or 60.</p>
 */
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
 *
 * <p>Returns the input untouched when there is no ceiling and when the ceiling is `none`: audio-only
 * is answered by not publishing at all rather than by publishing something tiny, and the caller that
 * knows that is not this function.</p>
 *
 * <p>An option this client cannot measure - `source` - survives clamping on purpose. So does a
 * resolution below every measured option, which cannot happen against the published ladder but would
 * otherwise silently become a resolution nobody chose.</p>
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
        : {resolution, framerate};
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
