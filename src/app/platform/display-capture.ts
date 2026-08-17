/**
 * Screen capture through the browser's own display-capture API. Host-neutral.
 *
 * There is no source id in this module: the host's own picker chooses what is shared, inside
 * {@link captureDisplay}. Nothing can be enumerated beforehand or pre-selected.
 */

/**
 * What to ask the host for.
 *
 * `width`/`height` are the already-solved output geometry, applied as a cap and never as a target:
 * an exact size would have the browser upscale a small window.
 */
export interface DisplayCaptureRequest {
    width: number;
    height: number;
    fps: number;
    /** Whether to ask the host picker to offer the source's audio as well. */
    audio: boolean;
}

export interface DisplayCapture {
    stream: MediaStream;
    video: MediaStreamTrack;
    /** The source's audio, or null - see {@link audioUnavailable}. */
    audio: MediaStreamTrack | null;
    /** True when audio was asked for and none arrived. Distinct from "audio was not asked for". */
    audioUnavailable: boolean;
}

/** The constraints for a request. Exported so a test can assert what actually reaches the browser. */
export function displayConstraints(request: DisplayCaptureRequest): MediaStreamConstraints {
    return {
        video: {
            width: {max: request.width},
            height: {max: request.height},
            // `ideal` as well as `max`: without it capture settles well below the preset's framerate.
            frameRate: {ideal: request.fps, max: request.fps},
        },
        audio: request.audio,
    };
}

/** Open the host picker and capture whatever the user chose. Rejects when the user cancels. */
export async function captureDisplay(request: DisplayCaptureRequest): Promise<DisplayCapture> {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (!media?.getDisplayMedia) {
        throw new Error('This browser cannot capture the screen (no getDisplayMedia).');
    }

    let stream: MediaStream;
    try {
        stream = await media.getDisplayMedia(displayConstraints(request));
    } catch (e) {
        // Only an audio request is worth a second attempt, and never when the user said no.
        if (!request.audio || isUserRefusal(e)) throw e;
        console.warn('[screen] display capture refused the audio request, retrying video-only', e);
        stream = await media.getDisplayMedia(displayConstraints({...request, audio: false}));
    }

    const video = stream.getVideoTracks()[0] ?? null;
    if (!video) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Display capture produced no video track.');
    }
    // An opening value only. `applyScreenEncoding` sets the hint that governs, moments later.
    try {
        video.contentHint = 'detail';
    } catch { /* contentHint unsupported */
    }

    const audio = stream.getAudioTracks()[0] ?? null;
    return {stream, video, audio, audioUnavailable: request.audio && audio === null};
}

/** Change a running capture's rate. */
export async function retargetDisplayFps(track: MediaStreamTrack, fps: number): Promise<void> {
    await track.applyConstraints({frameRate: {ideal: fps, max: fps}});
}

/** Change a running capture's output cap. Costs a keyframe downstream, and nothing else. */
export async function retargetDisplayGeometry(
    track: MediaStreamTrack,
    width: number,
    height: number,
): Promise<void> {
    await track.applyConstraints({width: {max: width}, height: {max: height}});
}

/** Whether a `getDisplayMedia` rejection was the user declining. Name-based; that is all the spec gives. */
function isUserRefusal(error: unknown): boolean {
    return (error as DOMException | null)?.name === 'NotAllowedError';
}
