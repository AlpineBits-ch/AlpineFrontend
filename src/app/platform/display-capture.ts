/**
 * Screen capture through the browser's own display-capture API.
 *
 * <p>Host-neutral on purpose: `getDisplayMedia` is a browser API, not a native one, and both the web
 * publisher and the browser fallback of the legacy capture surface go through here. One place builds
 * the constraints, so the geometry a preset solved to cannot mean two different things depending on
 * which of them opened the picker.</p>
 *
 * <p>There is no source id anywhere in this module, and that is the whole difference from the native
 * path: the host's own picker chooses what is shared, and it does so <i>inside</i>
 * {@link captureDisplay}. Nothing can be enumerated beforehand and nothing can be pre-selected.</p>
 */

/**
 * What to ask the host for.
 *
 * <p>`width`/`height` are the already-solved output geometry - see `solveGeometry`. They are applied
 * as a <b>cap</b>, never as a target: the solver never upscales, so asking for an exact size would
 * have the browser stretch a small window up to it and undo that rule.</p>
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
    /**
     * True when audio was asked for and none arrived.
     *
     * <p>Distinguished from "audio was not asked for" because it is a thing to tell the user: screen
     * audio is Chromium-only and tab/window-scoped, so a Firefox or Safari user who ticked the box
     * gets a video-only share and has to be told, not left to discover it from a viewer.</p>
     */
    audioUnavailable: boolean;
}

/**
 * The constraints for a request.
 *
 * <p>Exported so the geometry a preset solved to can be asserted at the point it reaches the browser,
 * rather than at the point it was computed. A test that only checks the solver proves nothing about
 * what was actually captured - see `project_media_e2e_test_traps`.</p>
 */
export function displayConstraints(request: DisplayCaptureRequest): MediaStreamConstraints {
    return {
        video: {
            width: {max: request.width},
            height: {max: request.height},
            // `ideal` as well as `max`: display capture otherwise settles at whatever rate the host
            // feels like, which on a static desktop is far below the preset's framerate.
            frameRate: {ideal: request.fps, max: request.fps},
        },
        audio: request.audio,
    };
}

/**
 * Open the host picker and capture whatever the user chose.
 *
 * <p>Rejects when the user cancels, which is a normal outcome and the caller's cue to leave the UI
 * exactly as it was.</p>
 */
export async function captureDisplay(request: DisplayCaptureRequest): Promise<DisplayCapture> {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (!media?.getDisplayMedia) {
        throw new Error('This browser cannot capture the screen (no getDisplayMedia).');
    }

    let stream: MediaStream;
    try {
        stream = await media.getDisplayMedia(displayConstraints(request));
    } catch (e) {
        // Only an *audio* request is worth a second attempt, and only when the failure was not the
        // user saying no. Retrying a cancelled capture would put the picker straight back up, which
        // reads as the app refusing to take no for an answer; retrying a rejected audio constraint is
        // the difference between a video-only share and no share at all on the engines that treat
        // `audio: true` as unsupported rather than as unavailable.
        if (!request.audio || isUserRefusal(e)) throw e;
        console.warn('[screen] display capture refused the audio request, retrying video-only', e);
        stream = await media.getDisplayMedia(displayConstraints({...request, audio: false}));
    }

    const video = stream.getVideoTracks()[0] ?? null;
    if (!video) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Display capture produced no video track.');
    }
    // 'detail' - screen content is text and UI. Paired with maintain-resolution degradation on the
    // sender (see `applyScreenEncoding`), the encoder drops frames under congestion instead of
    // shedding resolution.
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

/**
 * Whether a `getDisplayMedia` rejection was the user declining.
 *
 * <p>Name-based, because that is all the spec gives: a cancelled picker and a permissions-policy
 * block are both `NotAllowedError`, and neither is worth retrying. Everything else - `TypeError` for
 * an audio constraint the engine will not parse, `NotSupportedError`, `NotFoundError` - is a
 * capability problem the video-only retry can still get past.</p>
 */
function isUserRefusal(error: unknown): boolean {
    return (error as DOMException | null)?.name === 'NotAllowedError';
}
