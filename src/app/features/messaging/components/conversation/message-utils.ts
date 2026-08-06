import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageType} from '../../../../enums/message-type.enum';

export function decodeContent(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

export function fileIcon(contentType: string): string {
    if (contentType.startsWith('video/')) return 'pi-video';
    if (contentType.startsWith('audio/')) return 'pi-volume-up';
    if (contentType === 'application/pdf') return 'pi-file-pdf';
    if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('tar')) return 'pi-folder';
    if (contentType.startsWith('text/')) return 'pi-file-edit';
    return 'pi-file';
}

const GROUPING_WINDOW_MS = 20_000;

/**
 * Whether a message renders as centred system copy rather than an authored message.
 *
 * <p>Also what stops the next real message being grouped under it: grouping keys on the author,
 * and a call entry is authored by whoever placed the call - so without this, the caller's next
 * message would silently fold into the call notice and lose its avatar and timestamp.</p>
 */
export function isSystemMessageType(type: MessageType): boolean {
    return type === MessageType.GuildMemberJoin
        || type === MessageType.GuildMemberLeave
        || type === MessageType.CallEnded
        || type === MessageType.CallMissed;
}

export function isGroupedWithPrevious(current: MessageDto, previous: MessageDto | undefined): boolean {
    if (!previous) return false;
    if (previous.authorId !== current.authorId) return false;
    if (current.inReplyTo) return false;
    if (isSystemMessageType(previous.type)) return false;
    const gap = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime();
    return gap >= 0 && gap <= GROUPING_WINDOW_MS;
}
