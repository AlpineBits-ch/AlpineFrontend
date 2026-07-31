import {boxFor, StreamResolution} from './stream-preset';

export interface CaptureGeometry {
    width: number;
    height: number;
}

/** Rounds down to an even number, with a floor of 2 (H.264 4:2:0 needs even dimensions). */
function toEven(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Decide the fixed output size for a capture session.
 *
 * Called once when sharing starts; the result must not change for the life of the session. A
 * mid-session change to the track's dimensions forces a renegotiation and a keyframe, which is what
 * used to make resizing a shared window tear the stream — the capture canvas was created at a
 * hardcoded 1920x1080 and then resized to match whatever the first (and every subsequent) frame
 * happened to be.
 */
export function solveGeometry(
    sourceWidth: number,
    sourceHeight: number,
    resolution: StreamResolution,
): CaptureGeometry {
    const box = boxFor(resolution);
    if (!box) return {width: toEven(sourceWidth), height: toEven(sourceHeight)};

    const [maxWidth, maxHeight] = box;
    // Never upscale: a 720p source shared at 1440p stays 720p rather than being blown up.
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
    return {width: toEven(sourceWidth * scale), height: toEven(sourceHeight * scale)};
}
