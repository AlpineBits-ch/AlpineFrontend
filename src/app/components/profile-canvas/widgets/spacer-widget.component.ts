import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';

/** Renders nothing. Exists so the registry resolves a component and the grid reserves the cell. */
@Component({
    selector: 'app-spacer-widget',
    template: '',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpacerWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();
}
