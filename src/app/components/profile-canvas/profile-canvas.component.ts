import {ChangeDetectionStrategy, Component, computed, input, Type} from '@angular/core';
import {NgComponentOutlet} from '@angular/common';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, normalise} from '../../models/profile-canvas';
import {definitionFor} from './widget-registry';

interface PlacedWidget {
    widget: CanvasWidgetDto;
    component: Type<unknown>;
    /** Built once per recompute. A fresh object per change detection re-sets every input. */
    inputs: Record<string, unknown>;
}

/** Somebody's arranged profile. Read only: the editor renders this too, from its draft. */
@Component({
    selector: 'app-profile-canvas',
    imports: [NgComponentOutlet],
    templateUrl: './profile-canvas.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileCanvasComponent {
    readonly canvas = input.required<ProfileCanvasDto>();
    readonly owner = input.required<ProfileDto>();
    readonly columns = input<number>(CANVAS_COLUMNS);
    /** Draws only the two hover-preview widgets. The popout sets this. */
    readonly cardOnly = input(false);

    protected readonly placed = computed((): PlacedWidget[] => {
        const owner = this.owner();
        const packed = normalise(this.canvas(), this.columns());
        const wanted = this.cardOnly() ? packed.widgets.filter(w => w.card) : packed.widgets;

        return wanted.flatMap(widget => {
            const component = definitionFor(widget.type)?.component;
            return component ? [{widget, component, inputs: {widget, owner}}] : [];
        });
    });
}
