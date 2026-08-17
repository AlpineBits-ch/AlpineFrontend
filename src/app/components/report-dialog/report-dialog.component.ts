import {ChangeDetectionStrategy, Component, computed, effect, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ReportDialogService, ReportSubject} from '../../services/report-dialog.service';
import {reportRefusalKey, ReportService} from '../../services/report.service';
import {
    CreateReportRequest,
    REPORT_DETAILS_MAX,
    REPORT_REASONS,
    ReportEvidence,
    ReportReason,
} from '../../models/report.model';
import {buildReportEvidence, CONTEXT_BEFORE} from '../../core/report-evidence';
import {MessageStore} from '../../stores/message.store';
import {RelationshipStore} from '../../stores/relationship.store';
import {ProfileService} from '../../services/profile.service';
import {ToastService} from '../../services/toast.service';

/** Where the flow is. `sent` is a state rather than a dismissal, because the block offer follows it. */
type Stage = 'form' | 'sending' | 'sent';

/** The one report dialog, mounted once at the app shell. */
@Component({
    selector: 'app-report-dialog',
    imports: [Dialog, Button, FormsModule, TranslateModule],
    templateUrl: './report-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportDialogComponent {
    protected readonly dialog = inject(ReportDialogService);
    protected readonly reasons = REPORT_REASONS;
    protected readonly detailsMax = REPORT_DETAILS_MAX;
    protected readonly contextBefore = CONTEXT_BEFORE;

    protected readonly stage = signal<Stage>('form');
    protected readonly reason = signal<ReportReason | null>(null);
    protected readonly details = signal('');
    protected readonly evidenceExpanded = signal(false);
    /** True when the server folded this into a report already filed against the same subject. */
    protected readonly merged = signal(false);

    private readonly reports = inject(ReportService);
    private readonly messages = inject(MessageStore);
    private readonly relationships = inject(RelationshipStore);
    private readonly profiles = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly subject = this.dialog.subject;
    protected readonly visible = computed(() => this.subject() !== null);

    /** The snapshot that will be sent, or null. Recomputed, so what the user reviews is what the request carries. */
    protected readonly evidence = computed<ReportEvidence | null>(() => {
        const subject = this.subject();
        if (!subject || subject.kind !== 'Message' || !subject.subjectId) return null;

        return buildReportEvidence({
            messages: this.messages.entities(),
            reportedMessageId: subject.subjectId,
            conversationId: subject.conversationId,
            channelId: subject.channelId,
            capturedAt: new Date().toISOString(),
        });
    });

    protected readonly evidenceJson = computed(() => {
        const evidence = this.evidence();
        return evidence ? JSON.stringify(evidence, null, 2) : '';
    });

    /** Whether the block offer is worth making; it is not, if they are already blocked. */
    protected readonly alreadyBlocked = computed(() => {
        const userId = this.subject()?.targetUserId;
        return !!userId && this.relationships.blocked().some(r => r.other.userId === userId);
    });

    protected readonly canSubmit = computed(() =>
        this.reason() !== null && this.stage() === 'form'
    );

    /** `Report message` / `Report user` and so on: one key per subject kind. */
    protected readonly titleKey = computed(() => {
        switch (this.subject()?.kind) {
            case 'Message':
                return 'REPORT.TITLE_MESSAGE';
            case 'Guild':
                return 'REPORT.TITLE_GUILD';
            case 'Channel':
                return 'REPORT.TITLE_CHANNEL';
            default:
                return 'REPORT.TITLE_USER';
        }
    });

    constructor() {
        // A fresh subject is a fresh report; nothing about the last one should survive into it.
        effect(() => {
            if (this.subject()) this.resetForm();
        });
    }

    protected close(): void {
        this.dialog.close();
    }

    protected submit(): void {
        const subject = this.subject();
        const reason = this.reason();
        if (!subject || !reason || this.stage() !== 'form') return;

        this.stage.set('sending');

        const evidence = this.evidence();
        const request: CreateReportRequest = {
            targetUserId: subject.targetUserId,
            subjectKind: subject.kind,
            ...(subject.subjectId ? {subjectId: subject.subjectId} : {}),
            reason,
            ...(this.details().trim() ? {details: this.details().trim().slice(0, REPORT_DETAILS_MAX)} : {}),
            ...(evidence ? {evidence: {...evidence, capturedAt: new Date().toISOString()}} : {}),
        };

        this.reports.create(request).subscribe({
            next: response => {
                this.merged.set(response.merged);
                this.stage.set('sent');
            },
            error: err => {
                this.stage.set('form');
                const key = reportRefusalKey(err);
                this.toast.error(this.translate.instant(key ?? 'REPORT.ERROR.GENERIC'));
            },
        });
    }

    protected blockThemToo(): void {
        const subject = this.subject();
        if (!subject) return;

        this.relationships.block(subject.targetUserId).subscribe({
            next: () => {
                this.toast.success(this.translate.instant('PROFILE.BLOCK_SUCCESS', {
                    name: this.displayName(subject),
                }));
                this.close();
            },
            error: () => this.toast.error(this.translate.instant('PROFILE.BLOCK_ERROR')),
        });
    }

    protected displayName(subject: ReportSubject): string {
        return subject.targetName
            ?? this.profiles.getCachedByUserId(subject.targetUserId)?.userName
            ?? this.translate.instant('REPORT.THIS_USER');
    }

    private resetForm(): void {
        this.stage.set('form');
        this.reason.set(null);
        this.details.set('');
        this.evidenceExpanded.set(false);
        this.merged.set(false);
    }
}
