import {Component, inject} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {SupportService} from '../../../../../services/support.service';
import {ReportsFiledComponent} from './reports-filed/reports-filed.component';

/**
 * Help, and the record of what this account has reported.
 *
 * <p>Its own page rather than a section of Privacy: privacy settings are switches governing what
 * others can see of you, and neither "here is how to reach a human" nor "here is what happened to
 * the thing you reported" is one of those. Both are things you come looking for, which makes them
 * a destination rather than a row.</p>
 */
@Component({
    selector: 'app-support-settings',
    imports: [Button, TranslateModule, ReportsFiledComponent],
    templateUrl: './support-settings.component.html',
})
export class SupportSettingsComponent {
    protected readonly support = inject(SupportService);

    protected open(): void {
        this.support.openSupport();
    }
}
