import {Injectable, signal} from '@angular/core';
import {ReportSubjectKind} from '../models/report.model';

/**
 * What is being reported, as the surface that opened the dialog understands it.
 *
 * <p>`targetUserId` is always the account being reported, whatever `kind` says - a reported message
 * is a report against its author, and the server reads it that way.</p>
 */
export interface ReportSubject {
    kind: ReportSubjectKind;
    /** The message / channel / guild id. Omitted only when `kind` is `User`. */
    subjectId?: string;
    targetUserId: string;
    /** For the dialog header, so it says who rather than which id. */
    targetName?: string;
    /** Where the reported message lives, so evidence can be gathered around it. */
    conversationId?: string;
    channelId?: string;
}

/**
 * Opens the one report dialog, which is mounted once at the app shell.
 *
 * <p>Same shape as {@link ProfilePopoutService}: the surfaces that offer "Report" are context
 * menus and hover toolbars scattered across the app, and none of them is a sensible place to own a
 * modal.</p>
 */
@Injectable({providedIn: 'root'})
export class ReportDialogService {
    readonly subject = signal<ReportSubject | null>(null);

    open(subject: ReportSubject): void {
        this.subject.set(subject);
    }

    close(): void {
        this.subject.set(null);
    }
}
