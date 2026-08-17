import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {ReportEvidence, ReportEvidenceMessage} from '../models/report.model';
import {readableContent} from '../helpers/message-content.helper';

/**
 * Turning the conversation on screen into something a moderator can read. The snapshot is a window
 * around the reported message, never a whole conversation, and never exceeds
 * {@link EVIDENCE_MAX_BYTES}.
 */

/** The server's ceiling on the serialised blob. */
export const EVIDENCE_MAX_BYTES = 16 * 1024;

/** Enough to show what led up to it without lifting the whole conversation. */
export const CONTEXT_BEFORE = 10;
export const CONTEXT_AFTER = 3;

export interface BuildEvidenceOptions {
    /** Every message the client currently holds for this conversation, in any order. */
    messages: readonly MessageDto[];
    reportedMessageId: string;
    conversationId?: string;
    channelId?: string;
    /** ISO-8601. Passed in rather than read off the clock so the result is testable. */
    capturedAt: string;
}

/** Metadata only: the attachment's type and file name. */
function describeAttachment(contentType: string, fileName: string): string {
    return `[attachment: ${contentType || 'unknown'} "${fileName}"]`;
}

/** One message as staff will read it. Attachments are reduced to a type-and-name line. */
function toEvidenceMessage(msg: MessageDto, reported: boolean): ReportEvidenceMessage {
    const parts: string[] = [];
    const body = readableContent(msg);
    if (body) parts.push(body);
    for (const attachment of msg.attachments ?? []) {
        parts.push(describeAttachment(attachment.contentType, attachment.fileName));
    }

    return {
        id: msg.id,
        authorId: msg.authorId,
        sentAt: new Date(msg.createdAt).toISOString(),
        content: parts.join('\n'),
        ...(reported ? {reported: true as const} : {}),
    };
}

function serialisedBytes(evidence: ReportEvidence): number {
    return new TextEncoder().encode(JSON.stringify(evidence)).length;
}

/**
 * Builds the snapshot, or null when the reported message is not among those held. Oversize
 * snapshots are truncated from the oldest end, never dropping the reported message.
 */
export function buildReportEvidence(options: BuildEvidenceOptions): ReportEvidence | null {
    const {messages, reportedMessageId, conversationId, channelId, capturedAt} = options;

    const reported = messages.find(m => m.id === reportedMessageId);
    if (!reported) return null;

    // Scoped to the reported message's own container. Never send another conversation.
    const sameContainer = (m: MessageDto) => reported.conversationId
        ? m.conversationId === reported.conversationId
        : m.channelId === reported.channelId;

    const ordered = messages
        .filter(m => sameContainer(m) && !m.isEphemeral && !m.isBotCommandPlaceholder && !m.isPending)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const index = ordered.findIndex(m => m.id === reportedMessageId);
    if (index === -1) return null;

    // `encrypted` lets the moderation console explain why a snapshot is unverifiable.
    const encrypted = ordered[index].encryptionState === MessageEncryptionState.Encrypted;

    const window = ordered.slice(
        Math.max(0, index - CONTEXT_BEFORE),
        Math.min(ordered.length, index + CONTEXT_AFTER + 1),
    );

    const evidence: ReportEvidence = {
        capturedAt,
        ...(conversationId ? {conversationId} : {}),
        ...(channelId ? {channelId} : {}),
        encrypted,
        messages: window.map(m => toEvidenceMessage(m, m.id === reportedMessageId)),
    };

    while (serialisedBytes(evidence) > EVIDENCE_MAX_BYTES && evidence.messages.length > 1) {
        // Drop the oldest first, but never the reported message itself.
        const dropIndex = evidence.messages[0].reported ? 1 : 0;
        evidence.messages.splice(dropIndex, 1);
    }

    // One message that is on its own too long. Clipped by measuring bytes, not character count.
    const only = evidence.messages[0];
    while (serialisedBytes(evidence) > EVIDENCE_MAX_BYTES && only.content.length > 1) {
        const overflow = serialisedBytes(evidence) - EVIDENCE_MAX_BYTES;
        const keep = Math.max(0, only.content.length - Math.max(overflow, 16));
        only.content = only.content.slice(0, keep) + '…';
    }

    return evidence;
}
