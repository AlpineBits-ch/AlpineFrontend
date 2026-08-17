import {ChangeDetectionStrategy, Component, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {SupportService} from '../../../services/support.service';

/** What a restricted account sees instead of the sign-in form. */
@Component({
    selector: 'app-blocked-sign-in',
    imports: [Button, TranslateModule],
    templateUrl: './blocked-sign-in.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockedSignInComponent {
    /** The API base of the server that refused the sign-in. */
    readonly apiBase = input.required<string>();

    /** `VNT-XXXXXXXX`, when the server sends one. Rendered monospace and never lowercased. */
    readonly reference = input<string | null>(null);

    /** Back to a cleared sign-in form. */
    tryAnotherAccount = output<void>();

    private support = inject(SupportService);

    protected appeal(): void {
        this.support.openAppeal(this.apiBase());
    }

    protected contact(): void {
        this.support.openSupport(this.apiBase());
    }
}
