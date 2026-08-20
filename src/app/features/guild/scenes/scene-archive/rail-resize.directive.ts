import {Directive, ElementRef, inject, input, OnDestroy, OnInit, signal} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';

import {SceneRailStateService} from '../../../../services/scene-rail-state.service';

const CSS_VAR = '--rail-width';

/**
 * A resize strip. Apply the directive to a small element placed inside the box you want resizable
 * (typically its last child); it drags, arrow-keys, and double-clicks a width onto `target` as
 * `--rail-width`, in pixels, and persists it through `SceneRailStateService`. Written for the scene
 * archive's folder rail; the scene board can point it at its own rail without a second
 * implementation.
 *
 * Resetting removes the custom property rather than writing a literal width, so the default lives
 * once, in the CSS `var(--rail-width, ...)` fallback the caller declares on `target`.
 */
@Directive({
    selector: '[appRailResize]',
    host: {
        role: 'separator',
        'aria-orientation': 'vertical',
        tabindex: '0',
        '[attr.aria-label]': 'label()',
        '[class.is-dragging]': 'dragging()',
        '(pointerdown)': 'onPointerDown($event)',
        '(pointermove)': 'onPointerMove($event)',
        '(pointerup)': 'onPointerUp($event)',
        '(pointercancel)': 'onPointerUp($event)',
        '(dblclick)': 'onDoubleClick()',
        '(keydown)': 'onKeydown($event)',
    },
})
export class RailResizeDirective implements OnInit, OnDestroy {
    /** The element whose width this strip controls. */
    readonly target = input.required<HTMLElement>();
    readonly minRem = input(11);
    readonly maxRem = input(26);

    private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
    private readonly railState = inject(SceneRailStateService);
    private readonly translate = inject(TranslateService);

    protected readonly label = signal('');
    protected readonly dragging = signal(false);

    private dragStartX = 0;
    private dragStartWidth = 0;
    private readonly langSub = this.translate.onLangChange.subscribe(() => this.updateLabel());

    ngOnInit(): void {
        this.updateLabel();

        const stored = this.railState.railWidth();
        if (stored !== null) this.setWidthPx(this.clamp(stored));
    }

    ngOnDestroy(): void {
        this.langSub.unsubscribe();
        // A destroy mid-drag would otherwise leave the whole page unselectable.
        if (this.dragging()) document.body.style.removeProperty('user-select');
    }

    protected onPointerDown(event: PointerEvent): void {
        event.preventDefault();
        this.dragging.set(true);
        // Capture means the drag survives the pointer leaving the strip. Not every environment
        // implements it (this repo's test runner does not), so it is a courtesy, not a dependency.
        this.host.setPointerCapture?.(event.pointerId);
        this.dragStartX = event.clientX;
        this.dragStartWidth = this.target().getBoundingClientRect().width;
        document.body.style.userSelect = 'none';
    }

    protected onPointerMove(event: PointerEvent): void {
        if (!this.dragging()) return;
        this.applyDragPosition(event.clientX);
    }

    protected onPointerUp(event: PointerEvent): void {
        if (!this.dragging()) return;
        this.dragging.set(false);
        // The release position is authoritative even if the browser never fires a pointermove
        // exactly there.
        this.applyDragPosition(event.clientX);
        if (this.host.hasPointerCapture?.(event.pointerId)) this.host.releasePointerCapture(event.pointerId);
        document.body.style.removeProperty('user-select');
        this.persist();
    }

    protected onDoubleClick(): void {
        this.reset();
    }

    protected onKeydown(event: KeyboardEvent): void {
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            this.nudge(-this.remToPx(1));
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            this.nudge(this.remToPx(1));
        } else if (event.key === 'Home') {
            event.preventDefault();
            this.reset();
        }
    }

    private applyDragPosition(clientX: number): void {
        this.setWidthPx(this.clamp(this.dragStartWidth + (clientX - this.dragStartX)));
    }

    private nudge(deltaPx: number): void {
        this.setWidthPx(this.clamp(this.target().getBoundingClientRect().width + deltaPx));
        this.persist();
    }

    private reset(): void {
        this.target().style.removeProperty(CSS_VAR);
        this.railState.setRailWidth(null);
    }

    private setWidthPx(widthPx: number): void {
        this.target().style.setProperty(CSS_VAR, `${widthPx}px`);
    }

    private persist(): void {
        this.railState.setRailWidth(Math.round(this.target().getBoundingClientRect().width));
    }

    private clamp(widthPx: number): number {
        return Math.min(Math.max(widthPx, this.remToPx(this.minRem())), this.remToPx(this.maxRem()));
    }

    /** Root font size can change with the user's zoom or OS text scaling, so 16px is never assumed. */
    private remToPx(rem: number): number {
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        return rem * rootPx;
    }

    private updateLabel(): void {
        this.label.set(this.translate.instant('SCENE.ARCHIVE.RESIZE_RAIL'));
    }
}
