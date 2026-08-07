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
    /** 0-100, of the largest bucket rather than of the total - see the class doc. */
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

/**
 * What this flat costs per month.
 *
 * <p>The first thing anybody asks about a shared household, and about the only number that changes
 * anyone's behaviour. Two breakdowns and a cash-flow strip, and deliberately no chart library: bars
 * sized against the largest bucket read as a ranking, which is the question people actually have
 * ("what is the big one"), where bars sized against the total mostly render as slivers.</p>
 *
 * <p>Two rules the shape of the data forces.</p>
 *
 * <p><b>`byPeriod` is not zero-filled.</b> A month with no spending recorded is simply absent from
 * the response, and inventing a 0.00 for it would be a claim the house spent nothing that month -
 * a different statement from "nobody wrote anything down". So the months are drawn as the rows that
 * exist, with the gap visible as a gap.</p>
 *
 * <p><b>`Uncategorized` is its own bucket</b>, never folded into `Other`. A rollup that hides the
 * size of its own gap is worse than no rollup, because the gap is the part that tells you whether to
 * trust the rest of it.</p>
 */
@Component({
    selector: 'app-ledger-summary',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    templateUrl: './ledger-summary.component.html',
})
export class LedgerSummaryComponent {
    channelId = input.required<string>();
    currency = input.required<string>();
    nameOf = input.required<(userId: string) => string>();

    private ledger = inject(LedgerService);

    protected readonly windows = SUMMARY_WINDOWS;

    protected months = signal(SUMMARY_DEFAULT_MONTHS);

    protected state = computed(() => this.ledger.summaryFor(this.channelId()));
    protected summary = computed(() => this.state().summary);

    /** Only while nothing has ever landed: a window change must not blank what it is replacing. */
    protected showSpinner = computed(() => this.state().loading && !this.summary());

    protected total = computed(() => {
        const summary = this.summary();
        return summary ? formatMinor(summary.totalMinor, summary.currency) : '';
    });

    protected myShare = computed(() => {
        const summary = this.summary();
        return summary ? formatMinor(summary.myShareMinor, summary.currency) : '';
    });

    /**
     * The house's monthly average over the window.
     *
     * <p>Integer division on minor units, so it stays in whole rappen and never becomes a float. It
     * divides by the number of months <b>asked for</b> rather than the number that came back: months
     * where nothing was spent are absent from `byPeriod`, and dividing by the present ones would
     * quietly report the average of the months the house happened to spend in.</p>
     */
    protected monthlyAverage = computed(() => {
        const summary = this.summary();
        if (!summary) return '';
        const months = Math.max(1, this.months());
        return formatMinor(Math.trunc(summary.totalMinor / months), summary.currency);
    });

    protected categoryRows = computed<CategoryRow[]>(() => {
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
    protected periodRows = computed<PeriodRow[]>(() => {
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

    /**
     * Who fronted the money.
     *
     * <p>Not a balance, and labelled so it cannot be read as one: it says who has been carrying the
     * cash flow, which is a different question from who owes whom.</p>
     */
    protected payerRows = computed<PayerRow[]>(() => {
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

    protected isEmpty = computed(() => {
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
