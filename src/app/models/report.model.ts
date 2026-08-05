/**
 * The wire shapes for `POST /api/v1/reports` and `GET /api/v1/reports/mine`.
 */

export type ReportSubjectKind = 'User' | 'Message' | 'Channel' | 'Guild';

/**
 * The enum values the server takes. <b>Never render these</b> - each one has a label key below,
 * because "ViolentThreats" is a database column and not something to put in front of someone
 * reporting a threat.
 */
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
    /**
     * Triaged Critical server-side. Used only to keep these three near the top and out from under
     * "Something else" - <b>never</b> to promise the user a response time, which the client is in
     * no position to make good on.
     */
    critical?: boolean;
}

/**
 * Reason order as shown.
 *
 * <p>Harassment first because it is the common case; the three Critical reasons sit high rather
 * than buried at the bottom; `Other` last because a list that opens with an escape hatch is a list
 * nobody reads.</p>
 */
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

/**
 * The snapshot attached to a report.
 *
 * <p><b>This is the only thing a moderator will ever see of an encrypted conversation.</b> The
 * server holds ciphertext for DMs and cannot read a reported message, so a report with no evidence
 * is decided on the reporter's free-text description alone.</p>
 */
export interface ReportEvidence {
    /** ISO-8601, stamped when the snapshot was taken. */
    capturedAt: string;
    conversationId?: string;
    channelId?: string;
    /** Whether this came out of an E2EE conversation. Set honestly - see the evidence builder. */
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
     * hours. The confirmation has to say so - a second "Report submitted" would be a lie about a
     * queue entry that does not exist.
     */
    merged: boolean;
}

/**
 * The only three the server returns.
 *
 * <p>It collapses its internal states down to these on purpose and never returns the moderator's
 * note or who handled it: in a harassment case, telling the reporter what was decided is a channel
 * straight back to the person they reported.</p>
 */
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
