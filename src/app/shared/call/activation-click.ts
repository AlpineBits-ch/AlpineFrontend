import {DestroyRef, inject} from '@angular/core';

/** How long after the window regains focus a press still counts as the one that brought it back. */
export const ACTIVATION_CLICK_MS = 300;

/**
 * Tells an activation press apart from a command: the press that brings the app back is not a command.
 * Must be called from an injection context.
 */
export function trackActivationClick(): () => boolean {
    let lastFocusAt = Number.NEGATIVE_INFINITY;
    const onFocus = (): void => void (lastFocusAt = Date.now());

    window.addEventListener('focus', onFocus);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('focus', onFocus));

    return () => Date.now() - lastFocusAt < ACTIVATION_CLICK_MS;
}
