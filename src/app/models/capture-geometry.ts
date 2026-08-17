import {boxFor, StreamResolution, VideoCeiling} from './stream-preset';

export interface CaptureGeometry {
    width: number;
    height: number;
}

/** Rounds down to an even number, with a floor of 2 (H.264 4:2:0 needs even dimensions). */
function toEven(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Decide the fixed output size for a capture session. Called once when sharing starts; the result
 * must not change for the life of the session.
 *
 * @param ceiling the granted rung, or null when none has been resolved, which stays uncapped.
 */
export function solveGeometry(
    sourceWidth: number,
    sourceHeight: number,
    resolution: StreamResolution,
    ceiling: VideoCeiling | null | undefined,
): CaptureGeometry {
    const box = boxFor(resolution);

    // Never upscale, whichever box is doing the fitting.
    const scales = [1];
    if (box) scales.push(box[0] / sourceWidth, box[1] / sourceHeight);
    // Zero is the `none` rung, which means audio-only rather than a very short frame.
    if (ceiling && ceiling.maxHeight > 0) scales.push(ceiling.maxHeight / sourceHeight);

    const scale = Math.min(...scales);
    return {width: toEven(sourceWidth * scale), height: toEven(sourceHeight * scale)};
}
