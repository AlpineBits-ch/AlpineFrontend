/**
 * The floating call-controls bar hides itself after an idle pointer, Discord-style, so it does not
 * sit permanently over whatever is being watched. These specs render the exact binding pattern the
 * two call surfaces use (`opacity-0` / `pointer-events-*` classes driven by `revealed()`) rather than
 * asserting on the directive's internal signal, so a test would fail if the template binding were
 * ever deleted - not just if the directive's own bookkeeping broke.
 */
import {Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {AutoHideCallControlsDirective, CONTROLS_IDLE_MS} from './auto-hide-call-controls.directive';

@Component({
    imports: [AutoHideCallControlsDirective],
    template: `
        <div [appAutoHideCallControls]="hasVideo" #autoHide="appAutoHideCallControls" class="stage">
            <div class="bar"
                 (focusin)="autoHide.onControlsFocusIn()"
                 (focusout)="autoHide.onControlsFocusOut()"
                 (pointerenter)="autoHide.onControlsPointerEnter()"
                 (pointerleave)="autoHide.onControlsPointerLeave()"
                 [class.opacity-0]="!autoHide.revealed()"
                 [class.pointer-events-auto]="autoHide.revealed()"
                 [class.pointer-events-none]="!autoHide.revealed()">
                <button>Mute</button>
            </div>
        </div>
    `,
})
class HostComponent {
    hasVideo = true;
}

describe('AutoHideCallControlsDirective', () => {
    let fixture: ComponentFixture<HostComponent>;

    beforeEach(() => {
        TestBed.resetTestingModule();
        vi.useFakeTimers();
        fixture = TestBed.createComponent(HostComponent);
        // Real, connected to the document - not just constructed - so that `button().focus()` below
        // is genuine keyboard-reachability, not a synthetic event dispatched at a detached node.
        // jsdom only moves `document.activeElement` for elements that are actually in the document.
        document.body.appendChild(fixture.nativeElement);
    });

    afterEach(() => {
        vi.useRealTimers();
        fixture.nativeElement.remove();
    });

    function stage(): HTMLElement {
        return fixture.nativeElement.querySelector('.stage');
    }

    function bar(): HTMLElement {
        return fixture.nativeElement.querySelector('.bar');
    }

    function button(): HTMLButtonElement {
        return fixture.nativeElement.querySelector('.bar button');
    }

    /** Real DOM state, not the directive's internal signal - see file header. */
    function isHidden(): boolean {
        const el = bar();
        return el.classList.contains('opacity-0') && el.classList.contains('pointer-events-none');
    }

    function tick(): void {
        fixture.detectChanges();
        TestBed.tick();
    }

    it('hides the bar after the idle window when the stage has video', () => {
        fixture.componentInstance.hasVideo = true;
        tick();
        expect(isHidden()).toBe(false);

        vi.advanceTimersByTime(CONTROLS_IDLE_MS - 1);
        tick();
        expect(isHidden()).toBe(false);

        vi.advanceTimersByTime(1);
        tick();
        expect(isHidden()).toBe(true);
    });

    it('never hides when the stage has no video to protect', () => {
        fixture.componentInstance.hasVideo = false;
        tick();

        vi.advanceTimersByTime(CONTROLS_IDLE_MS * 5);
        tick();

        expect(isHidden()).toBe(false);
    });

    it('stays up while the pointer sits over the bar itself', () => {
        fixture.componentInstance.hasVideo = true;
        tick();

        // A pointermove over the stage first, as if the user had just reached for the bar.
        stage().dispatchEvent(new Event('pointermove', {bubbles: true}));
        bar().dispatchEvent(new Event('pointerenter'));
        tick();

        // The pointer never moves again, but it is still resting over the bar - the idle window
        // must not fire just because no further pointermove events arrived.
        vi.advanceTimersByTime(CONTROLS_IDLE_MS * 5);
        tick();

        expect(isHidden()).toBe(false);
    });

    it('stays up while a control inside the bar has focus', () => {
        fixture.componentInstance.hasVideo = true;
        tick();

        // A real focus, not a synthetic `focusin` dispatched at the wrapper - this must fail if the
        // button ever became genuinely unfocusable (`disabled`, `inert`, or the hidden state
        // regressing to `display`/`visibility`), not just if the directive's own bookkeeping broke.
        // (A stray `tabindex="-1"` would not trip this: it only drops an element from *sequential*
        // Tab order, which `.focus()` does not exercise - jsdom has no Tab-key traversal to test
        // that against, so it stays an accessibility-review concern, not a unit-test one.)
        button().focus();
        tick();
        expect(document.activeElement).toBe(button());

        vi.advanceTimersByTime(CONTROLS_IDLE_MS * 5);
        tick();

        expect(isHidden()).toBe(false);
    });

    it('reveals when focus arrives by keyboard after the bar has faded out', () => {
        fixture.componentInstance.hasVideo = true;
        tick();

        vi.advanceTimersByTime(CONTROLS_IDLE_MS);
        tick();
        expect(isHidden()).toBe(true);

        // Tabbing to a control inside the (invisible but still focusable) bar must bring it back.
        // `.focus()` proves the button is genuinely still reachable while faded out - `display:none`
        // or `visibility:hidden` would make this a no-op, and the assertion below would catch it.
        button().focus();
        tick();

        expect(document.activeElement).toBe(button());
        expect(isHidden()).toBe(false);
    });
});
