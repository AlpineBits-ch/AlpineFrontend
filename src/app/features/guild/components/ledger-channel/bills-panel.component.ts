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
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {
    BILL_LIMITS,
    BillOccurrence,
    billState,
    BillState,
    RecurrenceUnit,
    RecurringExpense,
    recurringExpenseError,
} from '../../../../dtos/response/bill.dto';
import {
    CreateRecurringExpenseDto,
    RecurringExpenseShareDto,
    UpdateRecurringExpenseDto,
} from '../../../../dtos/request/bill.dto';
import {
    EXPENSE_CATEGORIES,
    ExpenseCategory,
    expenseCategoryLabelKey,
    ExpenseSplitKind,
} from '../../../../dtos/response/ledger.dto';
import {formatMinor, minorToInputString, parseMinor} from '../../../../helpers/money.helper';
import {BillService} from '../../../../services/bill.service';
import {ToastService} from '../../../../services/toast.service';

interface Option {
    value: string;
    label: string;
}

interface BillRow {
    bill: BillOccurrence;
    state: BillState;
    /** Null when nobody has said what this period costs. **Never zero.** */
    amount: string | null;
    dueLabel: string;
}

interface ScheduleRow {
    schedule: RecurringExpense;
    /** Null for a bill whose amount varies; the row says so in words instead. */
    amount: string | null;
    cadenceKey: string;
    cadenceParams: {interval: number};
    payerName: string;
    categoryKey: string;
}

@Component({
    selector: 'app-bills-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button,
        Dialog,
        InputText,
        Select,
        ToggleSwitch,
        Tooltip,
        FormsModule,
        PrimeTemplate,
        TranslateModule,
    ],
    templateUrl: './bills-panel.component.html',
})
export class BillsPanelComponent {
    readonly channelId = input.required<string>();
    readonly currency = input.required<string>();
    /** Edit anyone's schedule, post and skip. */
    readonly canManage = input.required<boolean>();
    /** Post a bill you are the payer of, which is `AddExpenses` rather than `ManageLedger`. */
    readonly canAddExpense = input.required<boolean>();
    readonly ownUserId = input.required<string | null>();
    readonly memberOptions = input.required<Option[]>();
    /** Resolves a member id to a name, so this panel needs no roster of its own. */
    readonly nameOf = input.required<(userId: string) => string>();

    private bills = inject(BillService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly RecurrenceUnit = RecurrenceUnit;
    protected readonly categories = EXPENSE_CATEGORIES;
    protected readonly descriptionMaxLength = BILL_LIMITS.descriptionMaxLength;
    protected readonly skipReasonMaxLength = BILL_LIMITS.skipReasonMaxLength;

    protected readonly state = computed(() => this.bills.stateFor(this.channelId()));

    /** What is still owed, soonest first; posted and skipped periods are excluded (posted ones are on the ledger, skipped ones are already decided). */
    protected readonly upcoming = computed<BillRow[]>(() =>
        this.bills.upcomingFor(this.channelId()).map(bill => ({
            bill,
            state: billState(bill),
            amount: bill.amountMinor == null ? null : formatMinor(bill.amountMinor, this.currency()),
            dueLabel: this.day(bill.dueAt),
        })),
    );

    protected readonly overdueCount = computed(
        () => this.upcoming().filter(r => r.state === 'overdue').length,
    );
    protected readonly needsAmountCount = computed(
        () => this.upcoming().filter(r => r.state === 'needs-amount').length,
    );

    protected readonly scheduleRows = computed<ScheduleRow[]>(() =>
        this.state().schedules.map(schedule => ({
            schedule,
            amount: schedule.amountMinor == null ? null : formatMinor(schedule.amountMinor, this.currency()),
            cadenceKey: `BILLS.CADENCE_${schedule.recurrenceUnit.toUpperCase()}`,
            cadenceParams: {interval: schedule.recurrenceInterval},
            payerName: this.nameOf()(schedule.payerUserId),
            categoryKey: expenseCategoryLabelKey(schedule.category),
        })),
    );

    protected readonly showSchedules = signal(false);

    // ── Schedule editor ──────────────────────────────────────────────────────
    protected readonly showEditor = signal(false);
    protected readonly editingId = signal<string | null>(null);
    protected readonly saving = signal(false);
    protected readonly confirmDeleteId = signal<string | null>(null);

    protected readonly formDescription = signal('');
    /** Text, not a number: the string is the only thing that survives to `parseMinor` intact. */
    protected readonly formAmount = signal('');
    /** Off means the amount varies and each period waits for a figure. */
    protected readonly formHasFixedAmount = signal(true);
    protected readonly formPayerUserId = signal<string | null>(null);
    protected readonly formCategory = signal<ExpenseCategory>(ExpenseCategory.Uncategorized);
    protected readonly formUnit = signal<RecurrenceUnit>(RecurrenceUnit.Month);
    protected readonly formInterval = signal(1);
    protected readonly formAnchorAt = signal('');
    protected readonly formLeadDays = signal(3);
    protected readonly formAutoPost = signal(false);
    protected readonly formPaused = signal(false);

    protected readonly formAmountMinor = computed(() =>
        this.formHasFixedAmount() ? parseMinor(this.formAmount(), this.currency()) : null,
    );

    protected readonly formAmountInvalid = computed(() => {
        if (!this.formHasFixedAmount()) return false;
        const raw = this.formAmount().trim();
        if (!raw) return false;
        const minor = this.formAmountMinor();
        return minor === null || minor <= 0;
    });

    /** The one combination the server refuses outright, checked here so the switch can explain itself instead of collecting a `400` from an already-pressed Save. */
    protected readonly autoPostBlocked = computed(
        () =>
            recurringExpenseError({
                amountMinor: this.formAmountMinor(),
                autoPost: this.formAutoPost(),
            }) === 'auto-post-needs-amount',
    );

    protected readonly formValid = computed(() => {
        const description = this.formDescription().trim();
        if (!description || description.length > this.descriptionMaxLength) return false;
        if (this.formHasFixedAmount()) {
            const minor = this.formAmountMinor();
            if (minor === null || minor <= 0) return false;
        }
        if (this.autoPostBlocked()) return false;
        const interval = this.formInterval();
        if (!Number.isInteger(interval) || interval < BILL_LIMITS.recurrenceIntervalMin) return false;
        const lead = this.formLeadDays();
        return Number.isInteger(lead) && lead >= BILL_LIMITS.leadDaysMin && lead <= BILL_LIMITS.leadDaysMax;
    });

    protected readonly unitOptions = computed<Option[]>(() =>
        [RecurrenceUnit.Day, RecurrenceUnit.Week, RecurrenceUnit.Month, RecurrenceUnit.Year].map(unit => ({
            value: unit,
            label: this.translate.instant(`BILLS.UNIT_${unit.toUpperCase()}`),
        })),
    );

    protected readonly categoryOptions = computed<Option[]>(() =>
        this.categories.map(category => ({
            value: category,
            label: this.translate.instant(expenseCategoryLabelKey(category)),
        })),
    );

    // ── Post dialog ──────────────────────────────────────────────────────────
    protected readonly showPostDialog = signal(false);
    protected readonly postingBill = signal<BillOccurrence | null>(null);
    protected readonly postAmount = signal('');
    protected readonly postAmountMinor = computed(() => parseMinor(this.postAmount(), this.currency()));

    /** A blank box is legal only when the bill already carries an amount (posts what the schedule says); a variable bill has nothing to fall back on. */
    protected readonly postValid = computed(() => {
        const bill = this.postingBill();
        if (!bill) return false;
        const raw = this.postAmount().trim();
        if (!raw) return bill.amountMinor != null;
        const minor = this.postAmountMinor();
        return minor !== null && minor > 0;
    });

    // ── Skip dialog ──────────────────────────────────────────────────────────
    protected readonly showSkipDialog = signal(false);
    protected readonly skippingBill = signal<BillOccurrence | null>(null);
    protected readonly skipReason = signal('');

    constructor() {
        effect(() => {
            const channelId = this.channelId();
            untracked(() => this.bills.loadFor(channelId));
        });
    }

    // ── Formatting ───────────────────────────────────────────────────────────

    protected money(amountMinor: number): string {
        return formatMinor(amountMinor, this.currency());
    }

    protected day(iso: string): string {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'}).format(date);
    }

    protected stateClass(state: BillState): string {
        switch (state) {
            case 'overdue':
                return 'bg-rose-500/10 text-rose-300 border-rose-500/25';
            case 'needs-amount':
                return 'bg-amber-400/10 text-amber-300 border-amber-400/25';
            case 'skipped':
                return 'bg-white/[0.04] text-text-muted border-border-subtle';
            case 'posted':
                return 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25';
            default:
                return 'bg-brand/15 text-brand-dim border-brand/30';
        }
    }

    protected stateLabelKey(state: BillState): string {
        return `BILLS.STATE_${state.replace('-', '_').toUpperCase()}`;
    }

    // ── Permissions per row ──────────────────────────────────────────────────

    /** `ManageLedger`, or `AddExpenses` when the caller is the payer; the payer lives on the schedule, not the occurrence, so this resolves it. */
    protected canPost(bill: BillOccurrence): boolean {
        if (this.canManage()) return true;
        if (!this.canAddExpense()) return false;
        const schedule = this.bills.scheduleFor(this.channelId(), bill.recurringExpenseId);
        return !!schedule && !!this.ownUserId() && schedule.payerUserId === this.ownUserId();
    }

    // ── Schedule editor ──────────────────────────────────────────────────────

    protected openAdd(): void {
        this.editingId.set(null);
        this.formDescription.set('');
        this.formAmount.set('');
        this.formHasFixedAmount.set(true);
        this.formPayerUserId.set(this.ownUserId());
        this.formCategory.set(ExpenseCategory.Uncategorized);
        this.formUnit.set(RecurrenceUnit.Month);
        this.formInterval.set(1);
        this.formAnchorAt.set(this.todayInputValue());
        this.formLeadDays.set(3);
        this.formAutoPost.set(false);
        this.formPaused.set(false);
        this.showEditor.set(true);
    }

    protected openEdit(schedule: RecurringExpense): void {
        this.editingId.set(schedule.id);
        this.formDescription.set(schedule.description);
        this.formHasFixedAmount.set(schedule.amountMinor != null);
        this.formAmount.set(
            schedule.amountMinor == null ? '' : minorToInputString(schedule.amountMinor, this.currency()),
        );
        this.formPayerUserId.set(schedule.payerUserId);
        this.formCategory.set(schedule.category);
        this.formUnit.set(schedule.recurrenceUnit);
        this.formInterval.set(schedule.recurrenceInterval);
        this.formAnchorAt.set(schedule.anchorAt.slice(0, 10));
        this.formLeadDays.set(schedule.leadDays);
        this.formAutoPost.set(schedule.autoPost);
        this.formPaused.set(schedule.isPaused);
        this.showEditor.set(true);
    }

    /** Turning the fixed amount off also turns auto-post off: the pair is illegal server-side. */
    protected setHasFixedAmount(value: boolean): void {
        this.formHasFixedAmount.set(value);
        if (!value) this.formAutoPost.set(false);
    }

    protected submitSchedule(): void {
        if (this.saving() || !this.formValid()) return;

        const channelId = this.channelId();
        const editingId = this.editingId();
        const amountMinor = this.formAmountMinor();
        const description = this.formDescription().trim();

        this.saving.set(true);

        const request$ = editingId
            ? this.bills.editSchedule(channelId, editingId, {
                  description,
                  // The pair that expresses "this bill's amount varies now"; a bare null would read as "leave the amount alone" instead.
                  ...(amountMinor == null ? {clearAmount: true} : {amountMinor}),
                  payerUserId: this.formPayerUserId() ?? undefined,
                  category: this.formCategory(),
                  recurrenceUnit: this.formUnit(),
                  recurrenceInterval: this.formInterval(),
                  anchorAt: this.anchorIso(),
                  leadDays: this.formLeadDays(),
                  autoPost: this.formAutoPost(),
                  isPaused: this.formPaused(),
              } satisfies UpdateRecurringExpenseDto)
            : this.bills.addSchedule(channelId, {
                  description,
                  ...(amountMinor == null ? {} : {amountMinor}),
                  payerUserId: this.formPayerUserId() ?? undefined,
                  // Equal over an empty shares array, which the server reads as everyone in the guild; the only split that stays correct when a flatmate moves in.
                  splitKind: ExpenseSplitKind.Equal,
                  shares: [] as RecurringExpenseShareDto[],
                  category: this.formCategory(),
                  recurrenceUnit: this.formUnit(),
                  recurrenceInterval: this.formInterval(),
                  anchorAt: this.anchorIso(),
                  leadDays: this.formLeadDays(),
                  autoPost: this.formAutoPost(),
              } satisfies CreateRecurringExpenseDto);

        request$.subscribe({
            next: () => {
                this.saving.set(false);
                this.showEditor.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('BILLS.SAVE_FAILED'), err);
            },
        });
    }

    /** First press arms, second deletes: it takes every future period with it. */
    protected deleteSchedule(schedule: RecurringExpense): void {
        if (this.confirmDeleteId() !== schedule.id) {
            this.confirmDeleteId.set(schedule.id);
            return;
        }
        this.confirmDeleteId.set(null);
        this.bills.removeSchedule(this.channelId(), schedule.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('BILLS.DELETE_FAILED'), err),
        });
    }

    // ── Post and skip ────────────────────────────────────────────────────────

    protected openPost(bill: BillOccurrence): void {
        this.postingBill.set(bill);
        // Seeded with the schedule's figure when there is one, so the ordinary case is one tap.
        this.postAmount.set(
            bill.amountMinor == null ? '' : minorToInputString(bill.amountMinor, this.currency()),
        );
        this.showPostDialog.set(true);
    }

    protected submitPost(): void {
        const bill = this.postingBill();
        if (this.saving() || !bill || !this.postValid()) return;

        const typed = this.postAmount().trim();
        const amountMinor = typed ? this.postAmountMinor() : null;

        this.saving.set(true);
        this.bills
            .postBill(this.channelId(), bill.id, {
                ...(amountMinor == null ? {} : {amountMinor}),
            })
            .subscribe({
                next: () => {
                    this.saving.set(false);
                    this.showPostDialog.set(false);
                },
                error: err => {
                    this.saving.set(false);
                    this.toast.httpError(this.translate.instant('BILLS.POST_FAILED'), err);
                },
            });
    }

    protected openSkip(bill: BillOccurrence): void {
        this.skippingBill.set(bill);
        this.skipReason.set('');
        this.showSkipDialog.set(true);
    }

    protected submitSkip(): void {
        const bill = this.skippingBill();
        if (this.saving() || !bill) return;

        const reason = this.skipReason().trim();
        this.saving.set(true);
        this.bills.skipBill(this.channelId(), bill.id, reason ? {reason} : {}).subscribe({
            next: () => {
                this.saving.set(false);
                this.showSkipDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('BILLS.SKIP_FAILED'), err);
            },
        });
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** A `yyyy-MM-dd` from the date input back to an instant the server will accept. */
    private anchorIso(): string | undefined {
        const value = this.formAnchorAt().trim();
        if (!value) return undefined;
        const date = new Date(`${value}T12:00:00`);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    private todayInputValue(): string {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
}
