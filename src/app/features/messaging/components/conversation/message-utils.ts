import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageType} from '../../../../enums/message-type.enum';
import {DayRelation, dayKey, dayRelationOf, UNKNOWN_DAY_KEY} from '../../../../helpers/day.helper';

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
    if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('tar'))
        return 'pi-folder';
    if (contentType.startsWith('text/')) return 'pi-file-edit';
    return 'pi-file';
}

const GROUPING_WINDOW_MS = 20_000;

/** Whether a message renders as centred system copy rather than an authored message. */
export function isSystemMessageType(type: MessageType): boolean {
    return (
        type === MessageType.GuildMemberJoin ||
        type === MessageType.GuildMemberLeave ||
        type === MessageType.CallEnded ||
        type === MessageType.CallMissed ||
        type === MessageType.GroupNameChanged ||
        type === MessageType.GroupIconChanged ||
        type === MessageType.SceneCharacterJoined ||
        type === MessageType.SceneCharacterLeft
    );
}

export function isGroupedWithPrevious(current: MessageDto, previous: MessageDto | undefined): boolean {
    if (!previous) return false;
    if (previous.authorId !== current.authorId) return false;
    // One account switching character mid-scene must break the run, or the second character is
    // drawn with no name and no avatar and reads as the first one still speaking.
    if ((previous.personaId ?? null) !== (current.personaId ?? null)) return false;
    if (current.inReplyTo) return false;
    if (isSystemMessageType(previous.type)) return false;
    const gap = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime();
    return gap >= 0 && gap <= GROUPING_WINDOW_MS;
}

export interface DaySeparator {
    /** Local calendar day, `YYYY-MM-DD`. Stable enough to track a `@for` on. */
    key: string;
    date: Date;
    /** A discriminator rather than a string: the label is translated, and a pure function has no business reaching for a translation service. */
    relation: DayRelation;
}

export interface MessageRow {
    message: MessageDto;
    isGrouped: boolean;
    /** Set on the first message of a local day, including the first row of the loaded window. */
    daySeparator: DaySeparator | null;
}

/** A message whose stamp will not parse still breaks the run above it, but has no date to head it with. */
function separatorFor(key: string, date: Date, now: Date): DaySeparator | null {
    return key === UNKNOWN_DAY_KEY ? null : {key, date, relation: dayRelationOf(key, now)};
}

/**
 * Both the channel and the conversation view render their messages through this. The relation is
 * resolved once here, so an open window keeps saying "Today" past midnight until the rows rebuild.
 */
export function buildMessageRows(msgs: readonly MessageDto[], now: Date = new Date()): MessageRow[] {
    let previousKey: string | null = null;

    return msgs.map((message, i) => {
        const date = new Date(message.createdAt);
        const key = dayKey(date);
        const startsDay = key !== previousKey;
        previousKey = key;

        return {
            message,
            // A separator between two messages means they are not one group, however close the stamps.
            isGrouped: !startsDay && isGroupedWithPrevious(message, msgs[i - 1]),
            daySeparator: startsDay ? separatorFor(key, date, now) : null,
        };
    });
}
