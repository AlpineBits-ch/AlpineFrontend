import {Component, inject, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {ReportService} from '../../../../../../services/report.service';
import {FiledReport, REPORT_REASONS, ReportStatus} from '../../../../../../models/report.model';

/** The three the server returns, and the only three that may be rendered. */
const STATUS_LABEL: Record<ReportStatus, string> = {
    UnderReview: 'SETTINGS.SUPPORT.REPORT_STATUS_UNDER_REVIEW',
    ActionTaken: 'SETTINGS.SUPPORT.REPORT_STATUS_ACTION_TAKEN',
    Closed: 'SETTINGS.SUPPORT.REPORT_STATUS_CLOSED',
};

const STATUS_CLASS: Record<ReportStatus, string> = {
    UnderReview: 'bg-amber-400/[0.10] text-amber-400/90 border-amber-400/20',
    ActionTaken: 'bg-emerald-400/[0.10] text-emerald-400/90 border-emerald-400/20',
    Closed: 'bg-white/[0.05] text-white/40 border-white/[0.10]',
};

/**
 * What became of the things this account reported.
 *
 * <p>A low-traffic screen whose whole purpose is to answer "did anything happen to that thing I
 * reported six weeks ago". It is deliberately not findable from anywhere else.</p>
 *
 * <p>The server collapses its internal states into three and never returns the moderator's note or
 * who handled it. That is not an omission to work around: in a harassment case, telling the
 * reporter what was decided is a channel straight back to the person they reported.</p>
 */
@Component({
    selector: 'app-reports-filed',
    imports: [Button, DatePipe, TranslateModule],
    templateUrl: './reports-filed.component.html',
})
export class ReportsFiledComponent implements OnInit {
    private readonly reports = inject(ReportService);

    protected readonly rows = signal<FiledReport[]>([]);
    protected readonly loading = signal(false);
    protected readonly failed = signal(false);

    ngOnInit(): void {
        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.failed.set(false);
        this.reports.mine().subscribe({
            next: rows => {
                this.rows.set(rows);
                this.loading.set(false);
            },
            error: () => {
                this.loading.set(false);
                this.failed.set(true);
            },
        });
    }

    protected statusKey(status: ReportStatus): string {
        return STATUS_LABEL[status] ?? STATUS_LABEL.Closed;
    }

    protected statusClass(status: ReportStatus): string {
        return STATUS_CLASS[status] ?? STATUS_CLASS.Closed;
    }

    /** The user's words for the reason, never the enum name the row carries. */
    protected reasonKey(report: FiledReport): string {
        return REPORT_REASONS.find(r => r.value === report.reason)?.labelKey ?? 'REPORT.REASON.OTHER';
    }

    protected subjectKey(report: FiledReport): string {
        return `SETTINGS.SUPPORT.REPORT_SUBJECT_${report.subjectKind.toUpperCase()}`;
    }
}
