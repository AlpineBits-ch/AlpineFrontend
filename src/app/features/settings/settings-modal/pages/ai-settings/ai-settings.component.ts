import {Component} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';

/**
 * Where an AI provider account is connected from settings.
 *
 * Thin on purpose: the form is shared with the connect panel inside the wiki's draft dialog, so
 * that nothing about how a key is taken or stored depends on which door the user came through.
 */
@Component({
    selector: 'app-ai-settings',
    imports: [TranslateModule, AiConnectFormComponent],
    templateUrl: './ai-settings.component.html',
})
export class AiSettingsComponent {
}
