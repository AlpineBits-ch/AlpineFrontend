import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule} from '@ngx-translate/core';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';
import {WikiAiService} from '../../../../guild/components/wiki/wiki-ai.service';

/** Where an AI provider account is connected from settings. */
@Component({
    selector: 'app-ai-settings',
    imports: [TranslateModule, AiConnectFormComponent, FormsModule, ToggleSwitch],
    templateUrl: './ai-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiSettingsComponent {
    /**
     * Ghost text is the one AI feature that spends the user's credit without being asked for each
     * time, so it is off until switched on here - and this is the only switch, which is why the
     * setting lives in settings rather than behind the wiki's edit chrome.
     */
    protected readonly ai = inject(WikiAiService);
}
