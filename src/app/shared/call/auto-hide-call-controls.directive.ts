import {Directive, HostListener, OnDestroy, signal} from '@angular/core';

/** How long the pointer may sit idle over the stage before the floating controls bar fades out. */
export const CONTROLS_IDLE_MS = 3000;

/**
 * Hides the floating call-controls bar and reveals it on pointer activity over the stage. Applied to
 * the stage container. The caller must hide with opacity plus `pointer-events`, never `display` or
 * `visibility`, or the bar leaves the tab order and Tab can no longer reveal it.
 */
@Directive({
    selector: '[appAutoHideCallControls]',
    exportAs: 'appAutoHideCallControls',
})
export class AutoHideCallControlsDirective implements OnDestroy {
    /** Whether the bar should be visible right now. Read from the template, not written to. */
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

    /** Entering the stage without moving the pointer must still reveal the bar. */
    @HostListener('pointerenter')
    protected onStagePointerEnter(): void {
        this.revealed.set(true);
        this.scheduleHide();
    }

    /** Bind on the bar's own wrapper, not the stage. Entering must suspend the countdown, not reset it. */
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

    /** `focusin` fires after `focusout`, so moving focus between two buttons undoes this hide first. */
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
