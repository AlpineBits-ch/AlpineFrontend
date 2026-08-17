/**
 * The wire shapes for `POST /api/v1/reports` and `GET /api/v1/reports/mine`.
 */

export type ReportSubjectKind = 'User' | 'Message' | 'Channel' | 'Guild';

/** The enum values the server takes. Never render these; each one has a label key below. */
export type ReportReason =
    | 'Spam'
    | 'Harassment'
    | 'HateSpeech'
    | 'ViolentThreats'
    | 'SelfHarm'
    | 'SexualContent'
    | 'ChildSafety'
    | 'Impersonation'
    | 'Malware'
    | 'IllegalContent'
    | 'Other';

export interface ReportReasonOption {
    value: ReportReason;
    labelKey: string;
    /** Triaged Critical server-side. Used only for ordering, never to promise a response time. */
    critical?: boolean;
}

/** Reason order as shown. */
export const REPORT_REASONS: readonly ReportReasonOption[] = [
    {value: 'Harassment', labelKey: 'REPORT.REASON.HARASSMENT'},
    {value: 'Spam', labelKey: 'REPORT.REASON.SPAM'},
    {value: 'HateSpeech', labelKey: 'REPORT.REASON.HATE_SPEECH'},
    {value: 'ViolentThreats', labelKey: 'REPORT.REASON.VIOLENT_THREATS', critical: true},
    {value: 'ChildSafety', labelKey: 'REPORT.REASON.CHILD_SAFETY', critical: true},
    {value: 'SelfHarm', labelKey: 'REPORT.REASON.SELF_HARM', critical: true},
    {value: 'SexualContent', labelKey: 'REPORT.REASON.SEXUAL_CONTENT'},
    {value: 'Impersonation', labelKey: 'REPORT.REASON.IMPERSONATION'},
    {value: 'Malware', labelKey: 'REPORT.REASON.MALWARE'},
    {value: 'IllegalContent', labelKey: 'REPORT.REASON.ILLEGAL_CONTENT'},
    {value: 'Other', labelKey: 'REPORT.REASON.OTHER'},
];

/** The server's ceiling on free text. */
export const REPORT_DETAILS_MAX = 4000;

/** One decrypted message, as this client rendered it, attached so a moderator can see context. */
export interface ReportEvidenceMessage {
    id: string;
    authorId: string;
    /** ISO-8601. */
    sentAt: string;
    /** Plaintext, or a short metadata stand-in for an attachment. Never base64, never key material. */
    content: string;
    /** Exactly one entry carries this. */
    reported?: true;
}

/** The snapshot attached to a report, and the only thing a moderator sees of an encrypted conversation. */
export interface ReportEvidence {
    /** ISO-8601, stamped when the snapshot was taken. */
    capturedAt: string;
    conversationId?: string;
    channelId?: string;
    /** Whether this came out of an E2EE conversation. Set honestly; see the evidence builder. */
    encrypted: boolean;
    messages: ReportEvidenceMessage[];
}

export interface CreateReportRequest {
    /** Always the account being reported, whatever the subject is. */
    targetUserId: string;
    subjectKind: ReportSubjectKind;
    /** Required unless `subjectKind` is `User`. */
    subjectId?: string;
    reason: ReportReason;
    details?: string;
    evidence?: ReportEvidence;
}

export interface CreateReportResponse {
    id: string;
    status: ReportStatus;
    /**
     * True when this folded into a report the same user filed against the same subject inside 24
     * hours. The confirmation has to say so.
     */
    merged: boolean;
}

/** The only three statuses the server returns. */
export type ReportStatus = 'UnderReview' | 'ActionTaken' | 'Closed';

export interface FiledReport {
    id: string;
    subjectKind: ReportSubjectKind;
    reason: ReportReason;
    createdAt: string;
    status: ReportStatus;
    resolved: string | null;
}

/** Refusals worth saying something specific about. Anything else is a generic failure. */
export const REPORT_REFUSAL_CODES = {
    selfReport: 'self_report',
    subjectIdRequired: 'subject_id_required',
    evidenceTooLarge: 'evidence_too_large',
    reasonInvalid: 'reason_invalid',
} as const;
