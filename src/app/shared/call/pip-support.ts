/**
 * What picture-in-picture this environment actually offers.
 *
 * <p>Every PiP button in the call UI used to be gated on `document.pictureInPictureEnabled` alone,
 * which is unverified inside WebView2 - Tauri's webview may report it false, or true and then fail
 * every request. Centralising the check here means there is one place to correct if that turns out
 * wrong, and one place task 9's document-PiP pop-out extends rather than a second capability check
 * growing next to this one.</p>
 *
 * <p>Each function reads the ambient object at call time rather than caching a module-load snapshot,
 * so a test can stub `document`/`window` before calling in, and so a capability the webview grants
 * only after some later negotiation is not permanently remembered as absent.</p>
 */

/** Video-element PiP: `<video>.requestPictureInPicture()`. What the camera and remote-share tiles use. */
export function videoPipSupported(): boolean {
    return 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
}

/**
 * The slice of the Document Picture-in-Picture API the call UI uses.
 *
 * <p>Declared here because TypeScript's DOM lib does not ship it yet, and because one narrow local
 * shape is preferable to an `as any` at every call site. Only `requestWindow` is listed; the spec's
 * `documentPictureInPicture.window` back-reference is not used, because the pop-out keeps its own
 * handle to the window it opened.</p>
 */
export interface DocumentPictureInPicture {
    requestWindow(options?: {width?: number; height?: number}): Promise<Window>;
}

/**
 * Document PiP: `window.documentPictureInPicture`, which pops out an arbitrary DOM subtree rather
 * than a single `<video>`. The only kind that can carry the local share's `<img>` preview, since
 * that tile has no `MediaStream` to hand a video element - see `CallScreenShare.previewSrc`.
 */
export function documentPipSupported(): boolean {
    return !!documentPipApi();
}

/**
 * The Document PiP entry point, or null when this environment has none.
 *
 * <p>`requestWindow` is checked too, not just the property: an environment that exposes the object
 * without the method would pass a bare `in` check and then throw on the one call anybody makes of
 * it, which is the dead-button failure the gate exists to prevent, one level down.</p>
 */
export function documentPipApi(): DocumentPictureInPicture | null {
    const api = (window as Window & {documentPictureInPicture?: DocumentPictureInPicture})
        .documentPictureInPicture;
    return typeof api?.requestWindow === 'function' ? api : null;
}

/** True when at least one of the two PiP kinds is available. */
export function anyPipSupported(): boolean {
    return videoPipSupported() || documentPipSupported();
}
