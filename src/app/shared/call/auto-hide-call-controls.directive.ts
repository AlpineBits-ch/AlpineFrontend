import {Directive, HostListener, OnDestroy, signal} from '@angular/core';

/**
 * How long the pointer may sit idle over the stage before the floating controls bar fades out.
 *
 * <p>Named rather than inlined: the specs pin behaviour to this constant directly, so advancing
 * fake timers by anything else would make a failing test's intent unclear.</p>
 */
export const CONTROLS_IDLE_MS = 3000;

/**
 * Hides the floating call-controls bar by default and reveals it on pointer activity over the
 * stage, fading it out again after `CONTROLS_IDLE_MS` of no activity - Discord-style, so the bar
 * is not permanently sitting over whatever is on screen.
 *
 * <p>Lives on the stage container, not on `CallControlsBarComponent` itself: the bar is also used
 * in places that should never hide it, and a component that hides itself is harder to reason
 * about than a container that reveals it. Apply it to the stage element and read `revealed()` plus
 * call the `onControls*` methods (bound on the bar's own wrapper) via an `#autoHide="appAutoHideCallControls"`
 * template reference - see voice-channel.component.html / call-panel.component.html.</p>
 *
 * <p>The bar starts hidden unconditionally - there used to be a `hasVideo` gate that kept it
 * permanently visible whenever the stage had no share and no camera, on the reasoning that the
 * participant grid was the content and hiding controls over it removed function for no gain. Real
 * usage overturned that: the bar hides on every stage now, video or not.</p>
 *
 * <p>Two things keep this from becoming a trap, in order of how the brief ranked them:</p>
 * <ol>
 *   <li><b>Hovering or focusing the bar suspends the countdown outright</b>, not merely resets it -
 *   see `onControlsPointerEnter`/`onControlsFocusIn`. A pointer resting still over a button, or a
 *   control that already has focus, would otherwise still lose to the clock.</li>
 *   <li><b>The hidden state is opacity + `pointer-events`, never `display`/`visibility`</b> - that
 *   is the caller's job in the template (see the components above), but it is why this directive
 *   exposes a boolean rather than toggling a class itself: `display:none`/`visibility:hidden` both
 *   drop an element from the tab order, which turns a cosmetic feature into an accessibility
 *   regression. Because the bar never leaves the tab order, Tab still reaches it while hidden, and
 *   arriving by Tab fires `onControlsFocusIn`, which reveals it.</li>
 * </ol>
 */
@Directive({
    selector: '[appAutoHideCallControls]',
    exportAs: 'appAutoHideCallControls',
})
export class AutoHideCallControlsDirective implements OnDestroy {
    /** Whether the bar should be visible right now. Read from the template, not written to. Starts
     *  hidden: the bar only appears once the pointer actually reaches the stage or the bar. */
    readonly revealed = signal(false);

    /** True while the pointer sits over the bar itself, independent of movement. */
    private pointerOverBar = false;
    /** True while a control inside the bar holds keyboard focus. */
    private focusWithinBar = false;
    private idleTimer?: ReturnType<typeof setTimeout>;

    @HostListener('pointermove')
    protected onStagePointerMove(): void {
        this.revealed.set(true);
        this.scheduleHide();
    }

    /** Entering the stage without moving the pointer must still reveal the bar - a user who lands
     *  on the stage and holds still should not have to jiggle the mouse to find the controls. */
    @HostListener('pointerenter')
    protected onStagePointerEnter(): void {
        this.revealed.set(true);
        this.scheduleHide();
    }

    /** Bind on the bar's own wrapper, not the stage - entering it must suspend the countdown
     *  outright, not merely reset it, or a pointer resting still over a button loses to the clock. */
    onControlsPointerEnter(): void {
        this.pointerOverBar = true;
        this.clearTimer();
    }

    onControlsPointerLeave(): void {
        this.pointerOverBar = false;
        this.scheduleHide();
    }

    /** Also how Tab reveals the bar: focus lands on a control inside it before any pointer moves. */
    onControlsFocusIn(): void {
        this.focusWithinBar = true;
        this.revealed.set(true);
        this.clearTimer();
    }

    /** `focusin`/`focusout` bubble, and fire in that order even when focus merely moves between two
     *  buttons inside the bar - the `focusin` that follows this synchronously undoes the
     *  `scheduleHide` below before its timer ever runs, so there is no flicker between controls. */
    onControlsFocusOut(): void {
        this.focusWithinBar = false;
        this.scheduleHide();
    }

    ngOnDestroy(): void {
        this.clearTimer();
    }

    private scheduleHide(): void {
        this.clearTimer();
        if (this.pointerOverBar || this.focusWithinBar) return;
        this.idleTimer = setTimeout(() => this.revealed.set(false), CONTROLS_IDLE_MS);
    }

    private clearTimer(): void {
        if (this.idleTimer === undefined) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
    }
}
