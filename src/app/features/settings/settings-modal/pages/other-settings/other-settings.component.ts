import {Component, inject} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Select} from 'primeng/select';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {UserSettingsService} from '../../../../../services/user-settings.service';
import {AppInfoService} from '../../../../../services/app-info.service';

@Component({
    selector: 'app-other-settings',
    imports: [ToggleSwitch, Select, FormsModule, TranslateModule],
    templateUrl: './other-settings.component.html',
    styleUrl: './other-settings.component.css',
})
export class OtherSettingsComponent {
    selectedLanguage = 'en-us';
    public readonly languages = [
        {label: 'English (US)', value: 'en-us'},
    ];
    public readonly systemToggles = [
        {label: 'Minimize to tray', desc: 'Keep Alpine running in the system tray when closed.'},
        {label: 'Run in background', desc: 'Continue receiving notifications when minimized.'},
    ];
    public readonly advancedToggles = [
        {label: 'Hardware acceleration', desc: 'Use GPU rendering for smoother performance.'},
        {label: 'Developer mode', desc: 'Show additional debug information and tools.'},
    ];
    protected readonly userSettings = inject(UserSettingsService);
    protected readonly appInfo = inject(AppInfoService);
}
