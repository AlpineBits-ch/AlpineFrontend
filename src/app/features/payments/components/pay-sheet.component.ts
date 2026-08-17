import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {ExternalLinkService} from '../../../services/external-link.service';
import {ToastService} from '../../../services/toast.service';
import {formatMinor} from '../../../helpers/money.helper';
import {capabilitiesOf, displayHandleValue, PaymentHandle, PaymentHandleKind} from '../payment-handle.model';
import {buildPaymentLink, PaymentLink} from '../payment-links';
import {SpcCurrency, SwissQrBillInput, swissQrUnavailableReason} from '../swiss-qr-bill';
import {PaymentHandleService} from '../payment-handle.service';
import {WalletPreferenceService} from '../wallet-preference.service';
import {formatSwissPhoneNumber, normalizeSwissPhoneNumber, TWINT_CONFIRM_NAME_ADVICE} from '../twint-assist';
import {SwissQrBillComponent} from './swiss-qr-bill.component';

interface HandleRow {
    handle: PaymentHandle;
    display: string;
    labelKey: string;
    link: PaymentLink | null;
    /** Translation keys for each warning the link carries. Rendered, never swallowed. */
    warningKeys: string[];
}

/** How to pay one housemate what you owe them. */
@Component({
    selector: 'app-pay-sheet',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, TranslateModule, SwissQrBillComponent],
    template: `
        <div class="flex flex-col gap-3" data-testid="pay-sheet">
            <div>
                <h3 class="m-0 text-sm font-semibold text-text-primary">
                    {{ 'PAY.SHEET.TITLE' | translate: {name: payeeName(), amount: amountText()} }}
                </h3>
                <p class="m-0 mt-1 text-xs text-text-muted">
                    {{ 'PAY.SHEET.NOTHING_CONFIRMS' | translate }}
                </p>
            </div>

            <!--
              The sealed half, and only the sealed half.

              Everything in here came out of a blob this device unwrapped with its own Ed25519 seed:
              the QR-bill, the provider links, the copyable account numbers, and the four sentences
              explaining why one of them is missing. None of it can exist without a keychain, so on a
              browser it is replaced by a line saying where it can be read.

              The phone-number card below is outside this on purpose - see its own comment.
            -->
            @if (available()) {
                @switch (state().status) {
                    @case ('not-shared') {
                        <!--
                      A state, not an error. Only the owner's device holds the content key, so a
                      person who joined after the last write simply has no wrap. It fixes itself the
                      next time they open their own settings.

                      Withheld when a number is on screen, because with one there it is false: this
                      sentence and "no payment details" both say there is nothing here to pay with,
                      and a number below them is a thing to pay with. The unreadable case below is
                      not withheld - that one reports a fault, and a fault stays worth saying.
                    -->
                        @if (!phoneNumber()) {
                            <p class="m-0 text-[0.8125rem] text-text-muted" data-testid="not-shared">
                                {{ 'PAY.SHEET.NOT_SHARED' | translate: {name: payeeName()} }}
                            </p>
                        }
                    }
                    @case ('none') {
                        @if (!phoneNumber()) {
                            <p class="m-0 text-[0.8125rem] text-text-muted" data-testid="no-handles">
                                {{ 'PAY.SHEET.NO_HANDLES' | translate: {name: payeeName()} }}
                            </p>
                        }
                    }
                    @case ('unreadable') {
                        <p class="m-0 text-[0.8125rem] text-amber-300" data-testid="unreadable">
                            {{ 'PAY.SHEET.UNREADABLE' | translate: {name: payeeName()} }}
                        </p>
                    }
                    @case ('available') {
                        @if (qrBill(); as bill) {
                            <div
                                class="rounded-xl border border-white/[0.08] p-3 flex flex-col gap-2"
                                data-testid="qr-section"
                            >
                                <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                                    {{ 'PAY.SHEET.QR_TITLE' | translate }}
                                </p>
                                <p class="m-0 text-xs text-text-muted">
                                    {{ 'PAY.SHEET.QR_HOW' | translate }}
                                </p>
                                <app-swiss-qr-bill [bill]="bill" />
                                <!--
                              Most Swiss bank apps expect a QR on paper or another screen. Only a
                              minority accept an image from the phone's own gallery, so a payer on
                              one device has to be told what to do rather than left staring at it.
                            -->
                                <p class="m-0 text-xs text-text-muted">
                                    {{ 'PAY.SHEET.QR_SAME_DEVICE' | translate }}
                                </p>
                            </div>
                        } @else if (qrRefusalKey(); as key) {
                            <p class="m-0 text-xs text-text-muted" data-testid="qr-unavailable">
                                {{ key | translate: {name: payeeName()} }}
                            </p>
                        }

                        @for (row of rows(); track row.handle.kind + row.handle.value) {
                            <div
                                class="rounded-xl border border-white/[0.08] p-3 flex flex-col gap-2"
                                [attr.data-testid]="'handle-' + row.handle.kind"
                            >
                                <div class="flex items-baseline justify-between gap-2">
                                    <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                                        {{ row.labelKey | translate }}
                                    </p>
                                    @if (row.handle.label) {
                                        <span class="text-xs text-text-muted">{{ row.handle.label }}</span>
                                    }
                                </div>

                                <p
                                    class="m-0 font-mono text-sm text-text-primary break-all"
                                    data-testid="handle-value"
                                >
                                    {{ row.display }}
                                </p>

                                <div class="flex gap-1 flex-wrap">
                                    <p-button
                                        (onClick)="copy(row.handle)"
                                        [text]="true"
                                        size="small"
                                        icon="pi pi-copy"
                                        [label]="'PAY.SHEET.COPY' | translate"
                                    />

                                    @if (row.link; as link) {
                                        <p-button
                                            (onClick)="open(link)"
                                            [text]="true"
                                            size="small"
                                            icon="pi pi-external-link"
                                            [label]="
                                                'PAY.SHEET.OPEN'
                                                    | translate: {provider: row.labelKey | translate}
                                            "
                                        />
                                    }
                                </div>

                                <!--
                              Rendered in full, never collapsed into an icon. The PayPal one is the
                              difference between a settle-up that costs nothing and one that quietly
                              takes about 3% off the person being repaid.
                            -->
                                @for (warning of row.warningKeys; track warning) {
                                    <p
                                        class="m-0 text-xs text-amber-300"
                                        [attr.data-testid]="'warning-' + warning"
                                    >
                                        {{ warning | translate: {name: payeeName()} }}
                                    </p>
                                }
                            </div>
                        }
                    }
                }
            } @else {
                <!--
                  Checked before every sealed state. Without this, the browser build falls through
                  to the "no handles" branch and states that a housemate has added no payment
                  details - which is not true and not something the user can act on. What is true
                  is that this device has no key to open anything with.
                -->
                <p class="m-0 text-[0.8125rem] text-text-muted" data-testid="unavailable">
                    {{ 'PAY.EDITOR.DESKTOP_ONLY' | translate }}
                </p>
            }

            <!--
              Its own card, deliberately unlike the sealed handles above it. A number is plaintext
              the server read and could log; a handle is ciphertext the server cannot open. Merging
              them into one "payment details" list is the obvious tidy-up and the wrong one, because
              after it nothing on screen can tell the viewer which protection applies to what they
              are looking at.

              Outside the gate above, and outside the switch, for the same reason it is drawn
              differently: no key opens it. It arrives in the plaintext half of the directory read
              that every host performs, so a browser has it in hand - and TWINT is the one route on
              this sheet that a browser can complete, because it is a number and a copy button
              rather than anything cryptographic. Nested inside the sealed states it was hidden
              wherever they were, which meant hidden on web entirely, and hidden on the desktop for
              a housemate who shared a number and no bank details.

              Absent, it renders nothing at all. "Anna hasn't shared her number" would assert that
              Anna has one, and the server deliberately cannot tell us.
            -->
            @if (phoneNumber(); as number) {
                <div
                    class="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-3
                            flex flex-col gap-2"
                    data-testid="phone-assist"
                >
                    <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                        {{ (twintApplies() ? 'PAY.SHEET.TWINT_TITLE' : 'PAY.SHEET.PHONE_TITLE') | translate }}
                    </p>

                    <!--
                      Large and copyable, and for TWINT that is the whole feature. TWINT cannot be
                      deep-linked or prefilled by anybody outside a merchant contract, and storing a
                      user's TWINT QR is forbidden by its own terms.
                    -->
                    <p class="m-0 font-mono text-lg text-text-primary" data-testid="phone-number">
                        {{ number }}
                    </p>

                    <div class="flex gap-1">
                        <p-button
                            (onClick)="copyText(number)"
                            [text]="true"
                            size="small"
                            icon="pi pi-copy"
                            [label]="'PAY.SHEET.COPY' | translate"
                        />
                    </div>

                    @if (twintApplies()) {
                        <!-- The only real check that exists, and it is TWINT's, not ours. -->
                        <p class="m-0 text-xs text-text-muted">{{ twintAdvice }}</p>
                    } @else {
                        <p class="m-0 text-xs text-text-muted">
                            {{ 'PAY.SHEET.PHONE_NOT_SWISS' | translate }}
                        </p>
                    }

                    <p class="m-0 text-xs text-text-muted">
                        {{ 'PAY.SHEET.PHONE_PLAINTEXT' | translate }}
                    </p>

                    @if (phoneUpdatedAt(); as entered) {
                        <p class="m-0 text-xs text-text-muted" data-testid="phone-updated">
                            {{ 'PAY.SHEET.PHONE_ENTERED' | translate: {name: payeeName(), date: entered} }}
                        </p>
                    }
                </div>
            }

            <!--
              Always offered, in every state, including the one where nothing could be opened.
              Somebody may have paid by standing order, in cash, or from a handle they know by
              heart, and the ledger has to be able to record that.
            -->
            <div class="border-t border-white/[0.06] pt-3">
                <p-button (onClick)="markPaid.emit()" [label]="'PAY.SHEET.MARK_PAID' | translate" />
                <p class="m-0 mt-1 text-xs text-text-muted">
                    {{ 'PAY.SHEET.MARK_PAID_HINT' | translate }}
                </p>
            </div>
        </div>
    `,
})
export class PaySheetComponent {
    readonly guildId = input.required<string>();
    readonly payeeUserId = input.required<string>();
    readonly payeeName = input.required<string>();
    /** Whole minor units. Never a decimal, in or out. */
    readonly amountMinor = input.required<number>();
    readonly currency = input.required<string>();
    /** What the payment is for, put in the QR-bill's unstructured message. */
    readonly reference = input('');
    /** An override for the payee's number, for a host that already holds one. */
    readonly payeePhoneNumber = input<string | null>(null);

    /** Pressed when the payer says they have paid. The host records the settlement. */
    readonly markPaid = output<void>();

    private readonly handles = inject(PaymentHandleService);
    private readonly wallets = inject(WalletPreferenceService);
    private readonly links = inject(ExternalLinkService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly twintAdvice = TWINT_CONFIRM_NAME_ADVICE;

    /** Whether the sealed half of this sheet can exist here. */
    protected readonly available = computed(() => this.handles.isAvailable());

    protected readonly state = computed(() => this.handles.handlesFor(this.guildId(), this.payeeUserId()));

    protected readonly amountText = computed(() => formatMinor(this.amountMinor(), this.currency()));

    private readonly payload = computed(() => {
        const state = this.state();
        return state.status === 'available' ? state.payload : null;
    });

    protected readonly rows = computed<HandleRow[]>(() => {
        const payload = this.payload();
        if (!payload) return [];

        const amountMinor = this.amountMinor();
        const currency = this.currency();

        // The viewer's own wallet first. A stable sort, so everything else keeps the order the
        // owner listed it in, which is the order they thought about.
        return this.wallets.order(payload.handles).map(handle => {
            const link = capabilitiesOf(handle.kind).linkable
                ? buildPaymentLink(handle, amountMinor, currency)
                : null;

            return {
                handle,
                display: displayHandleValue(handle),
                labelKey: `PAY.KIND.${handle.kind.toUpperCase()}`,
                link,
                warningKeys: (link?.warnings ?? []).map(
                    w => `PAY.WARNING.${w.toUpperCase().replace(/-/g, '_')}`,
                ),
            };
        });
    });

    /** The QR-bill input, or null when this pairing cannot produce one. */
    protected readonly qrBill = computed<SwissQrBillInput | null>(() => {
        const payload = this.payload();
        const iban = payload?.handles.find(h => h.kind === PaymentHandleKind.Iban);
        const creditor = payload?.creditor;
        if (!iban || !creditor) return null;

        const currency = this.currency().toUpperCase();
        if (swissQrUnavailableReason(iban.value, currency) !== 'ok') return null;

        return {
            creditor: {
                iban: iban.value,
                name: creditor.name,
                street: creditor.street,
                buildingNumber: creditor.buildingNumber,
                postCode: creditor.postCode,
                town: creditor.town,
                country: creditor.country,
            },
            amountMinor: this.amountMinor(),
            currency: currency as SpcCurrency,
            message: this.reference().slice(0, 140),
        };
    });

    /** Why there is no QR, when there is an IBAN but no bill. */
    protected readonly qrRefusalKey = computed<string | null>(() => {
        const payload = this.payload();
        const iban = payload?.handles.find(h => h.kind === PaymentHandleKind.Iban);
        if (!iban) return null;
        if (this.qrBill()) return null;

        if (!payload?.creditor) return 'PAY.SHEET.QR_NO_ADDRESS';

        switch (swissQrUnavailableReason(iban.value, this.currency().toUpperCase())) {
            case 'iban-not-swiss':
                return 'PAY.SHEET.QR_FOREIGN_IBAN';
            case 'iban-invalid':
                return 'PAY.SHEET.QR_BAD_IBAN';
            case 'currency':
                return 'PAY.SHEET.QR_CURRENCY';
            default:
                return null;
        }
    });

    /** The payee's shared number, or null. */
    private readonly sharedPhone = computed(() =>
        this.handles.phoneNumberFor(this.guildId(), this.payeeUserId()),
    );

    /** The number to show, E.164 from the server, grouped for reading aloud when it is Swiss. */
    protected readonly phoneNumber = computed(() => {
        const raw = this.payeePhoneNumber() ?? this.sharedPhone()?.phoneNumber ?? '';
        if (!raw) return null;

        const swiss = normalizeSwissPhoneNumber(raw);
        return swiss ? formatSwissPhoneNumber(swiss) : raw;
    });

    /** Whether the TWINT wording applies, which is only when the number is a Swiss mobile. */
    protected readonly twintApplies = computed(() => {
        const raw = this.payeePhoneNumber() ?? this.sharedPhone()?.phoneNumber ?? '';
        return normalizeSwissPhoneNumber(raw) !== null;
    });

    /** When the owner last wrote the number. */
    protected readonly phoneUpdatedAt = computed(() => {
        const updatedAt = this.sharedPhone()?.updatedAt;
        if (!updatedAt) return null;

        const date = new Date(updatedAt);
        return Number.isNaN(date.getTime())
            ? null
            : new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', year: 'numeric'}).format(
                  date,
              );
    });

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => void this.handles.load(guildId));
        });
    }

    protected copy(handle: PaymentHandle): void {
        void this.copyText(displayHandleValue(handle));
    }

    protected async copyText(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            this.toast.success(this.translate.instant('PAY.SHEET.COPIED'));
        } catch {
            this.toast.error(this.translate.instant('PAY.SHEET.COPY_FAILED'));
        }
    }

    /** Hands the link to the operating system and does not wait for an answer. */
    protected open(link: PaymentLink): void {
        void this.links.openExternalLink(link.url);
    }
}
