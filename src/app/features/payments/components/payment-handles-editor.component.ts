import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {SettingsUiService} from '../../../services/settings-ui.service';
import {ToastService} from '../../../services/toast.service';
import {UserService} from '../../../services/user.service';
import {SealPlan} from '../device-trust';
import {
    CreditorAddress,
    HANDLE_LIMITS,
    checkHandleValue,
    displayHandleValue,
    normalizeHandleValue,
    PAYMENT_HANDLE_KINDS,
    PaymentHandle,
    PaymentHandleKind,
    PaymentHandlePayload,
} from '../payment-handle.model';
import {PaymentHandleService} from '../payment-handle.service';
import {RecipientTrustReviewComponent} from './recipient-trust-review.component';

interface KindOption {
    value: PaymentHandleKind;
    label: string;
}

/** Where somebody records how they want to be paid back, and seals it to the house. */
@Component({
    selector: 'app-payment-handles-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button,
        InputText,
        Select,
        ToggleSwitch,
        FormsModule,
        TranslateModule,
        RecipientTrustReviewComponent,
    ],
    template: `
        <div class="flex flex-col gap-3">
            @if (available()) {
                <div>
                    <h3 class="m-0 text-sm font-semibold text-text-primary">
                        {{ 'PAY.EDITOR.TITLE' | translate }}
                    </h3>
                    <p class="m-0 mt-1 text-xs text-text-muted">
                        {{ 'PAY.EDITOR.GUARANTEE' | translate }}
                    </p>
                </div>

                @for (row of rows(); track row.index) {
                    <div
                        class="rounded-lg border border-white/[0.08] p-3 flex flex-col gap-2"
                        [attr.data-testid]="'handle-row-' + row.index"
                    >
                        <div class="flex gap-2 items-start">
                            <p-select
                                [options]="kindOptions()"
                                optionLabel="label"
                                optionValue="value"
                                [ngModel]="row.handle.kind"
                                (ngModelChange)="setKind(row.index, $event)"
                                styleClass="w-40"
                                [ariaLabel]="'PAY.EDITOR.KIND' | translate"
                            />

                            <div class="flex-1 min-w-0">
                                <input
                                    pInputText
                                    class="w-full"
                                    [ngModel]="row.raw"
                                    (ngModelChange)="setValue(row.index, $event)"
                                    (blur)="normalize(row.index)"
                                    [placeholder]="row.placeholderKey | translate"
                                    [attr.aria-invalid]="!!row.problemKey"
                                />
                                @if (row.problemKey) {
                                    <p
                                        class="m-0 mt-1 text-xs text-red-300"
                                        [attr.data-testid]="'handle-problem-' + row.index"
                                    >
                                        {{ row.problemKey | translate }}
                                    </p>
                                }
                            </div>

                            <p-button
                                (onClick)="removeRow(row.index)"
                                [text]="true"
                                size="small"
                                severity="danger"
                                icon="pi pi-times"
                                [ariaLabel]="'PAY.EDITOR.REMOVE' | translate"
                            />
                        </div>

                        <input
                            pInputText
                            class="w-full"
                            [ngModel]="row.handle.label ?? ''"
                            (ngModelChange)="setLabel(row.index, $event)"
                            [maxlength]="labelMaxLength"
                            [placeholder]="'PAY.EDITOR.LABEL_PLACEHOLDER' | translate"
                        />
                    </div>
                }

                <div>
                    <p-button
                        (onClick)="addRow()"
                        [text]="true"
                        size="small"
                        [disabled]="rows().length >= maxHandles"
                        icon="pi pi-plus"
                        [label]="'PAY.EDITOR.ADD' | translate"
                    />
                </div>

                @if (needsAddress()) {
                    <div
                        class="rounded-lg border border-white/[0.08] p-3 flex flex-col gap-2"
                        data-testid="creditor-address"
                    >
                        <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                            {{ 'PAY.EDITOR.ADDRESS_TITLE' | translate }}
                        </p>
                        <p class="m-0 text-xs text-text-muted">
                            {{ 'PAY.EDITOR.ADDRESS_WHY' | translate }}
                        </p>

                        <input
                            pInputText
                            [ngModel]="address().name"
                            (ngModelChange)="setAddress('name', $event)"
                            [placeholder]="'PAY.EDITOR.ADDRESS_NAME' | translate"
                        />
                        <div class="flex gap-2">
                            <input
                                pInputText
                                class="flex-1"
                                [ngModel]="address().street ?? ''"
                                (ngModelChange)="setAddress('street', $event)"
                                [placeholder]="'PAY.EDITOR.ADDRESS_STREET' | translate"
                            />
                            <input
                                pInputText
                                class="w-24"
                                [ngModel]="address().buildingNumber ?? ''"
                                (ngModelChange)="setAddress('buildingNumber', $event)"
                                [placeholder]="'PAY.EDITOR.ADDRESS_NUMBER' | translate"
                            />
                        </div>
                        <div class="flex gap-2">
                            <input
                                pInputText
                                class="w-28"
                                [ngModel]="address().postCode"
                                (ngModelChange)="setAddress('postCode', $event)"
                                [placeholder]="'PAY.EDITOR.ADDRESS_POSTCODE' | translate"
                            />
                            <input
                                pInputText
                                class="flex-1"
                                [ngModel]="address().town"
                                (ngModelChange)="setAddress('town', $event)"
                                [placeholder]="'PAY.EDITOR.ADDRESS_TOWN' | translate"
                            />
                            <input
                                pInputText
                                class="w-20"
                                [ngModel]="address().country"
                                (ngModelChange)="setAddress('country', $event)"
                                [placeholder]="'PAY.EDITOR.ADDRESS_COUNTRY' | translate"
                            />
                        </div>
                        @if (addressIncomplete()) {
                            <p class="m-0 text-xs text-amber-300" data-testid="address-incomplete">
                                {{ 'PAY.EDITOR.ADDRESS_INCOMPLETE' | translate }}
                            </p>
                        }
                    </div>
                }
            } @else {
                <p class="m-0 text-[0.8125rem] text-text-muted" data-testid="unavailable">
                    {{ 'PAY.EDITOR.DESKTOP_ONLY' | translate }}
                </p>
            }

            <div
                class="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3
                        flex flex-col gap-2"
                data-testid="phone-sharing"
            >
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                            {{ 'PAY.PHONE.TITLE' | translate }}
                        </p>
                        <p class="m-0 mt-0.5 text-xs text-text-muted">
                            {{ 'PAY.PHONE.SUBTITLE' | translate }}
                        </p>
                    </div>
                    <p-toggleswitch
                        (ngModelChange)="setPhoneSharing($event)"
                        [ariaLabel]="'PAY.PHONE.TITLE' | translate"
                        [disabled]="phoneBusy()"
                        [ngModel]="sharingPhone()"
                    />
                </div>

                <p class="m-0 text-xs text-text-muted">{{ 'PAY.PHONE.PLAINTEXT' | translate }}</p>
                <p class="m-0 text-xs text-text-muted">{{ 'PAY.PHONE.UNVERIFIED' | translate }}</p>

                @if (accountLoaded()) {
                    @if (accountPhoneNumber(); as number) {
                        @if (sharingPhone()) {
                            <p class="m-0 text-xs text-text-muted" data-testid="phone-shared-value">
                                {{ 'PAY.PHONE.SHARED_NOW' | translate: {number: number} }}
                            </p>
                        }
                    } @else {
                        <div class="flex flex-col gap-1.5 items-start" data-testid="phone-no-account-number">
                            <p class="m-0 text-xs text-amber-300">
                                {{ 'PAY.PHONE.ACCOUNT_HAS_NONE' | translate }}
                            </p>
                            <p-button
                                (onClick)="openAccountPhoneSettings()"
                                [text]="true"
                                size="small"
                                icon="pi pi-arrow-up-right"
                                data-testid="phone-account-link"
                                [label]="'PAY.PHONE.ACCOUNT_LINK' | translate"
                            />
                        </div>
                    }
                }
            </div>

            @if (available()) {
                @if (plan(); as sealPlan) {
                    <app-recipient-trust-review [plan]="sealPlan" [(confirmed)]="confirmedDevices" />
                }

                @if (blockedRemaining() > 0) {
                    <p class="m-0 text-xs text-amber-300" data-testid="blocked-warning">
                        {{ 'PAY.EDITOR.BLOCKED_WARNING' | translate: {count: blockedRemaining()} }}
                    </p>
                }

                <div class="flex gap-2 items-center" data-testid="seal-actions">
                    <p-button
                        (onClick)="save()"
                        [disabled]="!canSave()"
                        [loading]="busy()"
                        [label]="(plan() ? 'PAY.EDITOR.SEAL' : 'PAY.EDITOR.REVIEW') | translate"
                    />

                    @if (hasStored()) {
                        <p-button
                            (onClick)="remove()"
                            [text]="true"
                            severity="danger"
                            [disabled]="busy()"
                            [label]="'PAY.EDITOR.DELETE' | translate"
                        />
                    }
                </div>

                <p class="m-0 text-xs text-text-muted">
                    {{ 'PAY.EDITOR.FOOTNOTE' | translate }}
                </p>
            }
        </div>
    `,
})
export class PaymentHandlesEditorComponent {
    readonly guildId = input.required<string>();

    private readonly handles = inject(PaymentHandleService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly users = inject(UserService);
    private readonly settingsUi = inject(SettingsUiService);

    protected readonly maxHandles = HANDLE_LIMITS.maxHandles;
    protected readonly labelMaxLength = HANDLE_LIMITS.maxLabelLength;

    protected readonly available = computed(() => this.handles.isAvailable());

    /** The draft. `raw` is what is in the box; `handle.value` is what would be stored. */
    private readonly draft = signal<{handle: PaymentHandle; raw: string}[]>([]);
    private readonly creditor = signal<CreditorAddress>(emptyAddress());

    protected readonly busy = signal(false);
    protected readonly hasStored = signal(false);

    /** The phone opt-in, held separately from {@link busy} so a slow toggle does not disable Save. */
    protected readonly phoneBusy = signal(false);
    protected readonly sharingPhone = computed(() => this.handles.isSharingPhoneNumber(this.guildId()));

    /** The number on the caller's own account, or null when there is none. */
    protected readonly accountPhoneNumber = computed(() => this.users.self()?.phoneNumber || null);

    /** False until the self record has arrived, so nothing below asserts an absence it cannot see. */
    protected readonly accountLoaded = computed(() => this.users.self() !== null);

    /** The seal plan, once it has been worked out. Null until the user presses Review. */
    protected readonly plan = signal<SealPlan | null>(null);
    protected readonly confirmedDevices = signal<ReadonlySet<string>>(new Set<string>());

    protected readonly kindOptions = computed<KindOption[]>(() =>
        PAYMENT_HANDLE_KINDS.map(kind => ({
            value: kind,
            label: this.translate.instant(`PAY.KIND.${kind.toUpperCase()}`),
        })),
    );

    protected readonly rows = computed(() =>
        this.draft().map((entry, index) => {
            const check = checkHandleValue(entry.handle.kind, entry.raw);
            return {
                index,
                handle: entry.handle,
                raw: entry.raw,
                placeholderKey: `PAY.EDITOR.PLACEHOLDER_${entry.handle.kind.toUpperCase()}`,
                // An empty row is not yet wrong; it just cannot be saved.
                problemKey:
                    entry.raw.trim() && check.problem
                        ? `PAY.PROBLEM.${check.problem.toUpperCase().replace(/-/g, '_')}`
                        : null,
            };
        }),
    );

    protected readonly address = computed(() => this.creditor());

    /** An IBAN is the only kind that needs a structured address, and it needs all of it. */
    protected readonly needsAddress = computed(() =>
        this.draft().some(entry => entry.handle.kind === PaymentHandleKind.Iban),
    );

    protected readonly addressIncomplete = computed(() => {
        if (!this.needsAddress()) return false;
        const a = this.creditor();
        return (
            !a.name.trim() || !a.postCode.trim() || !a.town.trim() || !/^[A-Za-z]{2}$/.test(a.country.trim())
        );
    });

    /** Devices still held back after everything the user has confirmed. */
    protected readonly blockedRemaining = computed(() => {
        const current = this.plan();
        if (!current) return 0;
        const confirmed = this.confirmedDevices();
        return current.blocked.filter(t => !confirmed.has(t.attestation.deviceId)).length;
    });

    protected readonly canSave = computed(() => {
        if (this.busy()) return false;
        if (this.addressIncomplete()) return false;

        const entries = this.draft();
        if (entries.length === 0) return false;

        return entries.every(entry => checkHandleValue(entry.handle.kind, entry.raw).valid);
    });

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => void this.hydrate(guildId));
        });

        // The card below the switch states whether the account has a number at all, so it needs the
        // self record. Fetched only when nothing has fetched it yet - the same guard the quick
        // settings strip and the security page use, and for the same reason: one read, wherever the
        // user happened to enter from.
        if (!this.users.self()) this.users.getSelf().subscribe({error: () => void 0});
    }

    /** Sends the user to the field this card is about. */
    protected openAccountPhoneSettings(): void {
        this.settingsUi.open('profile', 'phone');
    }

    // ── Rows ─────────────────────────────────────────────────────────────────

    protected addRow(): void {
        if (this.draft().length >= HANDLE_LIMITS.maxHandles) return;
        this.invalidatePlan();
        this.draft.update(rows => [
            ...rows,
            {
                handle: {kind: PaymentHandleKind.Iban, value: ''},
                raw: '',
            },
        ]);
    }

    protected removeRow(index: number): void {
        this.invalidatePlan();
        this.draft.update(rows => rows.filter((_, i) => i !== index));
    }

    protected setKind(index: number, kind: PaymentHandleKind): void {
        this.invalidatePlan();
        this.draft.update(rows =>
            rows.map((row, i) =>
                i === index
                    ? // The raw text is kept: switching kind after pasting is common, and clearing the box
                      // would make the person retype something they had already got right.
                      {...row, handle: {...row.handle, kind}}
                    : row,
            ),
        );
    }

    protected setValue(index: number, raw: string): void {
        this.invalidatePlan();
        this.draft.update(rows => rows.map((row, i) => (i === index ? {...row, raw} : row)));
    }

    /** On blur, so the value settles into its stored form without fighting the caret mid-type. */
    protected normalize(index: number): void {
        this.draft.update(rows =>
            rows.map((row, i) => {
                if (i !== index) return row;
                const value = normalizeHandleValue(row.handle.kind, row.raw);
                return {raw: value, handle: {...row.handle, value}};
            }),
        );
    }

    protected setLabel(index: number, label: string): void {
        this.invalidatePlan();
        this.draft.update(rows =>
            rows.map((row, i) =>
                i === index
                    ? {...row, handle: {...row.handle, label: label.slice(0, HANDLE_LIMITS.maxLabelLength)}}
                    : row,
            ),
        );
    }

    protected setAddress(field: keyof CreditorAddress, value: string): void {
        this.invalidatePlan();
        this.creditor.update(current => ({...current, [field]: value}));
    }

    // ── Saving ───────────────────────────────────────────────────────────────

    /** First press works out the plan; second press writes. */
    protected async save(): Promise<void> {
        if (!this.canSave()) return;
        this.busy.set(true);

        try {
            const guildId = this.guildId();
            const plan = await this.handles.planSealFor(guildId, this.confirmedDevices());
            this.plan.set(plan);

            // Anything still held back is a question that has not been answered. Writing now would
            // silently revoke those devices, which is the outcome this whole step exists to avoid.
            if (plan.blocked.length > 0) {
                this.busy.set(false);
                return;
            }

            await this.handles.seal(guildId, this.payload(), plan);
            this.hasStored.set(true);
            this.plan.set(null);
            this.toast.success(this.translate.instant('PAY.EDITOR.SAVED'));
        } catch (err) {
            this.toast.httpError(this.translate.instant('PAY.EDITOR.SAVE_FAILED'), err);
        } finally {
            this.busy.set(false);
        }
    }

    /** Turns the caller's own number on or off for this household. */
    protected async setPhoneSharing(share: boolean): Promise<void> {
        if (this.phoneBusy()) return;
        this.phoneBusy.set(true);

        try {
            await this.handles.setPhoneSharing(this.guildId(), share);
        } catch (err) {
            this.toast.httpError(this.translate.instant('PAY.PHONE.FAILED'), err);
        } finally {
            this.phoneBusy.set(false);
        }
    }

    protected async remove(): Promise<void> {
        this.busy.set(true);
        try {
            await this.handles.remove(this.guildId());
            this.draft.set([]);
            this.creditor.set(emptyAddress());
            this.hasStored.set(false);
            this.plan.set(null);
        } catch (err) {
            this.toast.httpError(this.translate.instant('PAY.EDITOR.DELETE_FAILED'), err);
        } finally {
            this.busy.set(false);
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private payload(): PaymentHandlePayload {
        const handles = this.draft().map(entry => ({
            ...entry.handle,
            value: normalizeHandleValue(entry.handle.kind, entry.raw),
        }));

        return {
            version: 1,
            handles,
            ...(this.needsAddress() ? {creditor: this.creditor()} : {}),
        };
    }

    /** Drops a plan the moment the draft changes. */
    private invalidatePlan(): void {
        if (this.plan()) this.plan.set(null);
    }

    private async hydrate(guildId: string): Promise<void> {
        await this.handles.load(guildId);

        const stored = this.handles.ownPayload(guildId);
        if (!stored) return;

        this.hasStored.set(true);
        this.draft.set(
            stored.handles.map(handle => ({
                handle,
                raw: displayHandleValue(handle),
            })),
        );
        if (stored.creditor) this.creditor.set(stored.creditor);
    }
}

function emptyAddress(): CreditorAddress {
    return {name: '', street: '', buildingNumber: '', postCode: '', town: '', country: 'CH'};
}
