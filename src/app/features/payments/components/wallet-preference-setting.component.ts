import {ChangeDetectionStrategy, Component, computed, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Select} from 'primeng/select';
import {PAYMENT_HANDLE_KINDS, PaymentHandleKind} from '../payment-handle.model';
import {WalletPreferenceService} from '../wallet-preference.service';

interface WalletOption {
    value: PaymentHandleKind | null;
    label: string;
}

/** The one-off "which app do you actually pay with" question. */
@Component({
    selector: 'app-wallet-preference-setting',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Select, FormsModule, TranslateModule],
    template: `
        <div class="flex flex-col gap-1">
            <label class="text-sm font-medium text-text-primary" for="wallet-preference">
                {{ 'PAY.WALLET.TITLE' | translate }}
            </label>
            <p-select
                inputId="wallet-preference"
                [options]="options()"
                optionLabel="label"
                optionValue="value"
                [ngModel]="preferred()"
                (ngModelChange)="wallets.setPreferred($event)"
                styleClass="w-64"
            />
            <p class="m-0 text-xs text-text-muted">{{ 'PAY.WALLET.HELP' | translate }}</p>
        </div>
    `,
})
export class WalletPreferenceSettingComponent {
    protected readonly wallets = inject(WalletPreferenceService);
    private readonly translate = inject(TranslateService);

    protected readonly preferred = this.wallets.preferred;

    protected readonly options = computed<WalletOption[]>(() => [
        {value: null, label: this.translate.instant('PAY.WALLET.NONE')},
        // Every kind, including the ones with no constructible link: the preference orders the
        // sheet, and somebody who settles up by bank transfer wants their IBAN at the top just as
        // much as a PayPal user wants PayPal there.
        ...PAYMENT_HANDLE_KINDS.map(kind => ({
            value: kind,
            label: this.translate.instant(`PAY.KIND.${kind.toUpperCase()}`),
        })),
    ]);
}
