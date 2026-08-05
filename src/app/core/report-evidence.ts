import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {ReportEvidence, ReportEvidenceMessage} from '../models/report.model';
import {readableContent} from '../helpers/message-content.helper';

/**
 * Turning the conversation on screen into something a moderator can read.
 *
 * <p><b>Direct messages are end-to-end encrypted; the server holds ciphertext and cannot read a
 * reported DM.</b> Whatever this function produces is the entire basis on which a moderator will
 * decide - if it returns nothing, the report is judged on the reporter's free text alone. That is
 * the reason it exists and the reason the caller shows the user what is being attached.</p>
 *
 * <p>Two rules it enforces rather than trusts callers with: the snapshot is a <em>window</em>
 * around the reported message, never a whole conversation, and it never exceeds
 * {@link EVIDENCE_MAX_BYTES} - the server refuses anything larger with `evidence_too_large`, so
 * silently over-filling it would turn every long-message report into an unexplained failure.</p>
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

/**
 * Metadata only. The byte size the spec's example carries is not on the client's attachment DTO,
 * so the type and the file name are all there is to say - which is still enough for a moderator to
 * know something was attached and what kind of thing it was.
 */
function describeAttachment(contentType: string, fileName: string): string {
    return `[attachment: ${contentType || 'unknown'} "${fileName}"]`;
}

/**
 * One message as staff will read it.
 *
 * <p>Attachments are reduced to a type-and-name line. Base64-ing them would blow the 16 KB budget
 * on the first image and push the actual conversation out of the snapshot.</p>
 */
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
 * Builds the snapshot, or returns null when there is nothing honest to send.
 *
 * <p>Null when the reported message is not among those held - which happens on a report opened
 * from a search result or a notification, where the surrounding conversation was never loaded.
 * Sending a lone message with no context would be worse than sending none: it reads as "this is
 * everything there was".</p>
 *
 * <p>Oversize snapshots are truncated <b>from the oldest end</b>, so what survives is the reported
 * message and what immediately surrounds it. If even that does not fit, the reported message alone
 * is returned with its body clipped, because a moderator with one over-long message still has more
 * than a moderator with nothing.</p>
 */
export function buildReportEvidence(options: BuildEvidenceOptions): ReportEvidence | null {
    const {messages, reportedMessageId, conversationId, channelId, capturedAt} = options;

    const reported = messages.find(m => m.id === reportedMessageId);
    if (!reported) return null;

    // <b>Scoped to the reported message's own container, and taken from the message rather than
    // from the caller.</b> Callers hand in whatever store they have, which for a signal store of
    // entities is every message this client holds - so without this the "context" window would
    // splice in whichever unrelated conversations happen to sit next to it in time. Never send
    // another conversation; this is where that is enforced rather than trusted.
    const sameContainer = (m: MessageDto) => reported.conversationId
        ? m.conversationId === reported.conversationId
        : m.channelId === reported.channelId;

    const ordered = messages
        .filter(m => sameContainer(m) && !m.isEphemeral && !m.isBotCommandPlaceholder && !m.isPending)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const index = ordered.findIndex(m => m.id === reportedMessageId);
    if (index === -1) return null;

    // Honest rather than assumed: `encrypted` is what lets the moderation console explain *why* a
    // snapshot is unverifiable, and a false negative there is a claim we can read the original.
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

    // One message that is on its own too long. Clipped by measuring rather than by arithmetic on
    // the character count - a body of emoji is four bytes a character and the sum would be wrong
    // in the direction that gets the whole report refused.
    const only = evidence.messages[0];
    while (serialisedBytes(evidence) > EVIDENCE_MAX_BYTES && only.content.length > 1) {
        const overflow = serialisedBytes(evidence) - EVIDENCE_MAX_BYTES;
        const keep = Math.max(0, only.content.length - Math.max(overflow, 16));
        only.content = only.content.slice(0, keep) + '…';
    }

    return evidence;
}
