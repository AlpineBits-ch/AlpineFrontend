/**
 * What picture-in-picture this environment actually offers. Every function must read the ambient
 * object at call time, never cache a module-load snapshot.
 */

/** Video-element PiP: `<video>.requestPictureInPicture()`. What the camera and remote-share tiles use. */
export function videoPipSupported(): boolean {
    return 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
}

/** The slice of the Document Picture-in-Picture API the call UI uses. */
export interface DocumentPictureInPicture {
    requestWindow(options?: {width?: number; height?: number}): Promise<Window>;
}

/** Document PiP: pops out an arbitrary DOM subtree rather than a single `<video>`. */
export function documentPipSupported(): boolean {
    return !!documentPipApi();
}

/** The Document PiP entry point, or null when this environment has none. `requestWindow` must be
 *  checked too: an object without the method passes a bare `in` check and then throws. */
export function documentPipApi(): DocumentPictureInPicture | null {
    const api = (window as Window & {documentPictureInPicture?: DocumentPictureInPicture})
        .documentPictureInPicture;
    return typeof api?.requestWindow === 'function' ? api : null;
}

/** True when at least one of the two PiP kinds is available. */
export function anyPipSupported(): boolean {
    return videoPipSupported() || documentPipSupported();
}
