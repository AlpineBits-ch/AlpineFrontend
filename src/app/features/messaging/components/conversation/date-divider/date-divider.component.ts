import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {DaySeparator} from '../message-utils';

@Component({
    selector: 'app-date-divider',
    imports: [DatePipe, TranslateModule],
    templateUrl: './date-divider.component.html',
    styleUrl: './date-divider.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateDividerComponent {
    public readonly separator = input.required<DaySeparator>();
}
