import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {
    LedgerCategoryTotal,
    LedgerPeriodTotal,
    SUMMARY_DEFAULT_MONTHS,
    SUMMARY_WINDOWS,
} from '../../../../dtos/response/ledger-insight.dto';
import {expenseCategoryLabelKey} from '../../../../dtos/response/ledger.dto';
import {formatMinor} from '../../../../helpers/money.helper';
import {LedgerService} from '../../../../services/ledger.service';

interface CategoryRow {
    total: LedgerCategoryTotal;
    labelKey: string;
    amount: string;
    myShare: string;
    /** 0-100 of the largest bucket, not the total, so bars read as a ranking rather than mostly-slivers. */
    barPercent: number;
}

interface PeriodRow {
    total: LedgerPeriodTotal;
    /** `"2026-07"` rendered as a month in the viewer's locale. */
    label: string;
    amount: string;
    myShare: string;
    barPercent: number;
}

interface PayerRow {
    userId: string;
    name: string;
    amount: string;
}

@Component({
    selector: 'app-ledger-summary',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    templateUrl: './ledger-summary.component.html',
})
export class LedgerSummaryComponent {
    readonly channelId = input.required<string>();
    readonly currency = input.required<string>();
    readonly nameOf = input.required<(userId: string) => string>();

    private ledger = inject(LedgerService);

    protected readonly windows = SUMMARY_WINDOWS;

    protected readonly months = signal(SUMMARY_DEFAULT_MONTHS);

    protected readonly state = computed(() => this.ledger.summaryFor(this.channelId()));
    protected readonly summary = computed(() => this.state().summary);

    /** Only while nothing has ever landed: a window change must not blank what it is replacing. */
    protected readonly showSpinner = computed(() => this.state().loading && !this.summary());

    protected readonly total = computed(() => {
        const summary = this.summary();
        return summary ? formatMinor(summary.totalMinor, summary.currency) : '';
    });

    protected readonly myShare = computed(() => {
        const summary = this.summary();
        return summary ? formatMinor(summary.myShareMinor, summary.currency) : '';
    });

    /** Integer division on minor units, so it stays whole rappen; divides by the months asked for, not the months present, since empty months are absent from `byPeriod`. */
    protected readonly monthlyAverage = computed(() => {
        const summary = this.summary();
        if (!summary) return '';
        const months = Math.max(1, this.months());
        return formatMinor(Math.trunc(summary.totalMinor / months), summary.currency);
    });

    protected readonly categoryRows = computed<CategoryRow[]>(() => {
        const summary = this.summary();
        if (!summary) return [];
        const rows = [...summary.byCategory].sort((a, b) => b.totalMinor - a.totalMinor);
        const largest = rows[0]?.totalMinor ?? 0;
        return rows.map(total => ({
            total,
            labelKey: expenseCategoryLabelKey(total.category),
            amount: formatMinor(total.totalMinor, summary.currency),
            myShare: formatMinor(total.myShareMinor, summary.currency),
            barPercent: largest > 0 ? Math.round((total.totalMinor / largest) * 100) : 0,
        }));
    });

    /** Oldest first, so the strip reads left to right as time does. Absent months stay absent. */
    protected readonly periodRows = computed<PeriodRow[]>(() => {
        const summary = this.summary();
        if (!summary) return [];
        const rows = [...summary.byPeriod].sort((a, b) => a.period.localeCompare(b.period));
        const largest = rows.reduce((max, row) => Math.max(max, row.totalMinor), 0);
        return rows.map(total => ({
            total,
            label: this.monthLabel(total.period),
            amount: formatMinor(total.totalMinor, summary.currency),
            myShare: formatMinor(total.myShareMinor, summary.currency),
            barPercent: largest > 0 ? Math.round((total.totalMinor / largest) * 100) : 0,
        }));
    });

    /** Who fronted the money; not a balance, since it is cash flow, not who owes whom. */
    protected readonly payerRows = computed<PayerRow[]>(() => {
        const summary = this.summary();
        if (!summary) return [];
        return [...summary.byPayer]
            .sort((a, b) => b.paidMinor - a.paidMinor)
            .map(entry => ({
                userId: entry.userId,
                name: this.nameOf()(entry.userId),
                amount: formatMinor(entry.paidMinor, summary.currency),
            }));
    });

    protected readonly isEmpty = computed(() => {
        const summary = this.summary();
        return !!summary && summary.totalMinor === 0 && summary.byCategory.length === 0;
    });

    constructor() {
        effect(() => {
            const channelId = this.channelId();
            const months = this.months();
            untracked(() => this.ledger.loadSummary(channelId, months));
        });
    }

    protected setMonths(months: number): void {
        this.months.set(months);
    }

    protected windowLabelKey(months: number): string {
        return months >= 12 ? 'LEDGER.SUMMARY.WINDOW_YEARS' : 'LEDGER.SUMMARY.WINDOW_MONTHS';
    }

    protected windowLabelParams(months: number): {count: number} {
        return {count: months >= 12 ? Math.round(months / 12) : months};
    }

    /** `"2026-07"` -> `"Jul 2026"`, in the viewer's locale. Day 1 at noon dodges any zone shift. */
    private monthLabel(period: string): string {
        const [year, month] = period.split('-').map(Number);
        if (!year || !month) return period;
        const date = new Date(year, month - 1, 1, 12);
        return new Intl.DateTimeFormat(undefined, {month: 'short', year: 'numeric'}).format(date);
    }
}
