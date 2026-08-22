import {ChangeDetectionStrategy, Component, computed, inject, input, output, Type} from '@angular/core';
import {NgComponentOutlet} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, isSpacer, normalise} from '../../models/profile-canvas';
import {definitionFor} from './widget-registry';

interface PlacedWidget {
    widget: CanvasWidgetDto;
    component: Type<unknown>;
    /** Built once per recompute. A fresh object per change detection re-sets every input. */
    inputs: Record<string, unknown>;
}

export interface WidgetSelectedEvent {
    id: string;
    element: HTMLElement;
}

/** Tailwind's `gap-2`, shared by this grid and `CanvasLatticeComponent`'s own `.grid`. */
export const GRID_GAP_PX = 8;

/** Somebody's arranged profile. Read only: the editor renders this too, from its draft. */
@Component({
    selector: 'app-profile-canvas',
    imports: [NgComponentOutlet, TranslateModule],
    templateUrl: './profile-canvas.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileCanvasComponent {
    private readonly translate = inject(TranslateService);

    readonly canvas = input.required<ProfileCanvasDto>();
    readonly owner = input.required<ProfileDto>();
    readonly columns = input<number>(CANVAS_COLUMNS);
    /** Draws only the two hover-preview widgets. The popout sets this. */
    readonly cardOnly = input(false);
    /** Off by default: the popout and the modal render someone else's canvas, read only. */
    readonly selectable = input(false);
    readonly selectedId = input<string | null>(null);
    /** Widgets hidden from the previewed viewer: dimmed, never removed from the layout. */
    readonly dimmedIds = input<ReadonlySet<string>>(new Set());
    /** Off by default: only the editor's own tiles can be picked up. */
    readonly draggable = input(false);

    readonly widgetSelected = output<WidgetSelectedEvent>();

    protected readonly placed = computed((): PlacedWidget[] => {
        const owner = this.owner();
        const packed = normalise(this.canvas(), this.columns());
        const wanted = this.cardOnly() ? packed.widgets.filter(w => w.card) : packed.widgets;

        return wanted.flatMap(widget => {
            const component = definitionFor(widget.type)?.component;
            return component ? [{widget, component, inputs: {widget, owner}}] : [];
        });
    });

    /** `minmax(CELL, auto)`: a 1x1 row is a square at the current column width, and content taller
     * than that still grows the row instead of clipping. `cqw` resolves against the nearest ancestor
     * query container, set in the template on the wrapper around this grid. */
    protected readonly gridAutoRows = computed(() => {
        const columns = this.columns();
        const gap = GRID_GAP_PX * (columns - 1);
        return `minmax(calc((100cqw - ${gap}px) / ${columns}), auto)`;
    });

    /** A spacer holds nothing a properties panel could edit, so it never becomes a tile you can pick. */
    protected tileSelectable(widget: CanvasWidgetDto): boolean {
        return this.selectable() && !isSpacer(widget);
    }

    protected tileDraggable(widget: CanvasWidgetDto): boolean {
        return this.draggable() && !isSpacer(widget);
    }

    protected isDimmed(widget: CanvasWidgetDto): boolean {
        return this.dimmedIds().has(widget.id);
    }

    protected isSpacerWidget(widget: CanvasWidgetDto): boolean {
        return isSpacer(widget);
    }

    protected tileCursorClass(widget: CanvasWidgetDto): string {
        if (this.tileDraggable(widget)) return 'cursor-grab active:cursor-grabbing';
        return this.tileSelectable(widget) ? 'cursor-pointer' : '';
    }

    protected tileLabel(widget: CanvasWidgetDto): string {
        const type = this.translate.instant(definitionFor(widget.type)?.labelKey ?? '');
        return this.translate.instant('PROFILE_PAGE.EDIT_WIDGET', {type});
    }

    protected onTileClick(widget: CanvasWidgetDto, event: MouseEvent): void {
        if (!this.tileSelectable(widget)) return;
        this.widgetSelected.emit({id: widget.id, element: event.currentTarget as HTMLElement});
    }

    protected onTileKeydown(widget: CanvasWidgetDto, event: KeyboardEvent): void {
        if (!this.tileSelectable(widget)) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.widgetSelected.emit({id: widget.id, element: event.currentTarget as HTMLElement});
    }
}
