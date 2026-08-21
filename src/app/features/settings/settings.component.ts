import {ChangeDetectionStrategy, Component} from '@angular/core';

@Component({
    selector: 'app-settings',
    imports: [],
    templateUrl: './settings.component.html',
    styleUrl: './settings.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsComponent {}
