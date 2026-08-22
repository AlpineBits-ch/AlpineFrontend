import {
    afterRenderEffect,
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {definitionFor} from '../../../components/profile-canvas/widget-registry';
import {Placement, placePopout, POPOUT_MARGIN} from '../../../components/profile-popout/place-popout';
import {WidgetPropertiesComponent} from './widget-properties.component';

/** Matches the `w-80` on the card. */
const CARD_WIDTH = 320;

/** A widget's editor, anchored to the tile it edits. Positioning follows `place-popout.ts`. */
@Component({
    selector: 'app-widget-editor-popover',
    imports: [TranslateModule, WidgetPropertiesComponent],
    templateUrl: './widget-editor-popover.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetEditorPopoverComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly anchor = input.required<HTMLElement>();

    /** Escape: hide only. The caller keeps the selection so a keyboard user does not lose their place. */
    readonly escaped = output<void>();
    /** A pointerdown outside both the card and the anchor: hide and clear the selection. */
    readonly dismissed = output<void>();
    readonly deleted = output<void>();

    private readonly editor = inject(CanvasEditorService);
    private readonly destroyRef = inject(DestroyRef);

    private readonly card = viewChild<ElementRef<HTMLElement>>('card');

    protected readonly placement = signal<Placement | null>(null, {
        equal: (a, b) => a?.left === b?.left && a?.top === b?.top,
    });

    protected readonly maxHeight = signal(0);

    protected readonly titleKey = computed(() => definitionFor(this.widget().type)?.labelKey ?? '');

    // A plain equality check, not the object identity of widget(): a field edit hands this a new
    // object with the same id on every keystroke, and that must not steal focus back mid-type.
    private readonly widgetId = computed(() => this.widget().id);

    constructor() {
        // Height comes from the widget's own fields, so every render re-measures before placing the card.
        afterRenderEffect(() => {
            this.widget();
            this.anchor();
            this.reposition();
        });

        // Runs on mount and again whenever the selection moves to a different widget, so an
        // already-open editor still receives focus when the tile selection changes under it.
        afterRenderEffect(() => {
            this.widgetId();
            this.card()?.nativeElement.focus();
        });

        const onScroll = (event: Event) => {
            if (this.card()?.nativeElement.contains(event.target as Node)) return;
            this.reposition();
        };
        const onResize = () => this.reposition();
        const onPointerDown = (event: PointerEvent) => this.dismissIfOutside(event);

        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        document.addEventListener('pointerdown', onPointerDown, true);

        this.destroyRef.onDestroy(() => {
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
            document.removeEventListener('pointerdown', onPointerDown, true);
        });
    }

    protected onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') this.escaped.emit();
    }

    protected removeWidget(): void {
        this.editor.remove(this.widget().id);
        this.deleted.emit();
    }

    private reposition(): void {
        const element = this.card()?.nativeElement;
        const anchorEl = this.anchor();
        if (!element) return;

        this.maxHeight.set(Math.max(0, window.innerHeight - 2 * POPOUT_MARGIN));

        const rect = anchorEl.getBoundingClientRect();
        this.placement.set(
            placePopout(
                {left: rect.left, right: rect.right, top: rect.top},
                {width: CARD_WIDTH, height: element.offsetHeight},
                {width: window.innerWidth, height: window.innerHeight},
            ),
        );
    }

    private dismissIfOutside(event: PointerEvent): void {
        const node = event.target as Node;
        if (this.card()?.nativeElement.contains(node)) return;
        if (this.anchor().contains(node)) return;
        this.dismissed.emit();
    }
}
