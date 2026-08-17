import {Component, inject} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {SupportService} from '../../../../../services/support.service';
import {ReportsFiledComponent} from './reports-filed/reports-filed.component';

/** Help, and the record of what this account has reported. */
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
