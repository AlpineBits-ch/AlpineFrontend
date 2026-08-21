import {ChangeDetectionStrategy, Component, inject, OnInit, signal} from '@angular/core';
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
    Closed: 'bg-white/[0.05] text-text-muted border-white/[0.10]',
};

/** What became of the things this account reported. */
@Component({
    selector: 'app-reports-filed',
    imports: [Button, DatePipe, TranslateModule],
    templateUrl: './reports-filed.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
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
