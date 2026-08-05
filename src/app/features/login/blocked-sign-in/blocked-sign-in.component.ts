import {ChangeDetectionStrategy, Component, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {SupportService} from '../../../services/support.service';

/**
 * What a restricted account sees instead of the sign-in form.
 *
 * <p>A full replacement of the form, not a toast and not a red line under the password field: the
 * user cannot proceed and retrying is not the answer. There is deliberately no "try again" and no
 * "reset password" here - neither helps, and both read as the client not understanding its own
 * state.</p>
 *
 * <p>It says "restricted" rather than "banned" because the `403` covers five different account
 * states and the client is not told which one; see `sign-in-blocked.ts`. It also does not offer a
 * "request another review" button: there is one appeal per decision, a second attempt is a `409`,
 * and staff lifting a restriction afterwards is a thing that may happen to someone rather than a
 * thing they can ask for.</p>
 */
@Component({
    selector: 'app-blocked-sign-in',
    imports: [Button, TranslateModule],
    templateUrl: './blocked-sign-in.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockedSignInComponent {
    /**
     * The API base of the server that refused the sign-in.
     *
     * <p>Passed in rather than read off {@link ApiConfigService}: on a self-hosted identity the
     * support site has to be derived from <em>that</em> server, and a user who has never signed in
     * successfully would otherwise be sent to ours.</p>
     */
    apiBase = input.required<string>();

    /** `VNT-XXXXXXXX`, when the server sends one. Rendered monospace and never lowercased. */
    reference = input<string | null>(null);

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
