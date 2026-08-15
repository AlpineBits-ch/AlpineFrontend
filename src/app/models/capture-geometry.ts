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
 * Decide the fixed output size for a capture session.
 *
 * Called once when sharing starts; the result must not change for the life of the session. A
 * mid-session change to the track's dimensions forces a renegotiation and a keyframe, which is what
 * used to make resizing a shared window tear the stream - the capture canvas was created at a
 * hardcoded 1920x1080 and then resized to match whatever the first (and every subsequent) frame
 * happened to be.
 *
 * <p>Two boxes apply and the smaller wins: the preset's, and the granted rung's own `maxHeight`.
 * The second is what caps `source`, and it is the only place that can. `source` has to stay offered
 * on every rung - at picker time the display's size is genuinely unknown here, so hiding it would be
 * inventing the mapping the server publishes a ladder to keep out of this client - but by the time
 * this runs the picker has returned real dimensions, so the rung applies to a number rather than to
 * a guess. Without it a 4K display shared as `source` publishes 4K on a 720p30 rung and the server
 * cannot correct it: its clamp picks a simulcast layer, and a publisher sending a single encoding
 * has no other layer to offer.</p>
 *
 * @param ceiling the granted rung, or null when none has been resolved - which is the documented
 *        default on this whole path and must stay uncapped, since a client-side clamp is a courtesy
 *        and the server is the enforcement. Required rather than optional so that a new call site
 *        has to state which of the two it means instead of silently getting the leak back.
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
    // Zero is the `none` rung, which means audio-only rather than a very short frame. The caller
    // answers it by not publishing at all; treating it as a height here would capture 2x2.
    if (ceiling && ceiling.maxHeight > 0) scales.push(ceiling.maxHeight / sourceHeight);

    const scale = Math.min(...scales);
    return {width: toEven(sourceWidth * scale), height: toEven(sourceHeight * scale)};
}
