import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../../../../dtos/response/profile-canvas.dto';

// Task 11 replaces this with the real properties panel.
@Component({
    selector: 'app-widget-properties',
    template: '',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetPropertiesComponent {
    readonly widget = input.required<CanvasWidgetDto>();
}
