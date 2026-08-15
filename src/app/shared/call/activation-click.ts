import {DestroyRef, inject} from '@angular/core';

/**
 * How long after the window regains focus a press still counts as the one that brought it back.
 *
 * <p>Long enough to cover the gap between the activation and the `click` the same press produces
 * (the browser fires `focus` on mousedown and `click` on mouseup), short enough that a deliberate
 * second press is never swallowed. Exported so a spec can step exactly this far rather than guess.</p>
 */
export const ACTIVATION_CLICK_MS = 300;

/**
 * Tells an activation press apart from a command.
 *
 * <p>Clicking an app that is not in front of you does two things at once on Windows: it activates
 * the window <em>and</em> delivers the click to whatever is under the cursor. Usually harmless -
 * until what is under the cursor is a control about the window's own absence. That is exactly the
 * call stage: after two minutes in the background the local preview pauses
 * (see `RustMediaService.previewPaused`) and the paused card is what sits where the picture was, so
 * the press that brings the app back lands on "resume preview" - or, in the version of this that
 * shipped first, on the live picture that focus had just restored, opening it full-stage.</p>
 *
 * <p>So the rule is simply that the press which brings the app back is not also a command. That is
 * the same thing macOS does for background windows, and the same thing every user already expects
 * from the click they use to come back to an app.</p>
 *
 * <p>Must be called from an injection context - a field initialiser - like the other trackers in
 * this directory. Returns a predicate rather than a signal because it answers a question about the
 * event being handled right now, not a piece of state anything renders.</p>
 */
export function trackActivationClick(): () => boolean {
    let lastFocusAt = Number.NEGATIVE_INFINITY;
    const onFocus = (): void => void (lastFocusAt = Date.now());

    window.addEventListener('focus', onFocus);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('focus', onFocus));

    return () => Date.now() - lastFocusAt < ACTIVATION_CLICK_MS;
}
