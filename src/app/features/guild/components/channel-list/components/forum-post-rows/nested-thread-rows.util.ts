import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {ChannelReadState} from '../../../../../../services/guild-read-state.service';

/** The most rows one parent contributes to the sidebar. Visited threads are capped when recorded, but unread/mentioned ones aren't, so this caps a busy parent from burying every channel below it; the parent's rolled-up badge still reports everything, including what was cut. */
export const MAX_NESTED_THREAD_ROWS = 8;

/** Why a thread earned its place in the sidebar, ordered by how much it wants attention and used directly as the sort key, so a mention never falls off the list while a merely-glanced-at thread survives. */
enum Priority {
    Mentioned = 0,
    Unread = 1,
    Visited = 2,
}

/**
 * The threads to draw beneath a parent, whether that parent is a forum or a text channel: recently read plus ones asking for attention. Archived threads never qualify, since they've left the parent's default list and a sidebar row into one would be a dead end.
 * Ordered by attention first, recency second, since the list is capped and whatever gets cut should be the least interesting item.
 */
export function selectNestedThreads(
    parentId: string,
    allChannels: readonly ChannelDto[],
    visitedThreadIds: readonly string[],
    readStateOf: (channelId: string) => ChannelReadState,
): ChannelDto[] {
    const visited = new Set(visitedThreadIds);

    const scored: {thread: ChannelDto; priority: Priority; activity: number}[] = [];
    for (const thread of allChannels) {
        if (thread.parentChannelId !== parentId) continue;
        if (thread.isArchived) continue;

        const state = readStateOf(thread.id);
        const priority =
            state.mentionCount > 0
                ? Priority.Mentioned
                : state.isUnread
                  ? Priority.Unread
                  : visited.has(thread.id)
                    ? Priority.Visited
                    : null;
        if (priority === null) continue;

        scored.push({thread, priority, activity: activityTime(thread)});
    }

    return scored
        .sort((a, b) => a.priority - b.priority || b.activity - a.activity)
        .slice(0, MAX_NESTED_THREAD_ROWS)
        .map(entry => entry.thread);
}

/** lastActivityAt is absent until someone posts (and on every thread predating the forum-parity deploy), so createdAt is the fallback; an unparseable date sorts last rather than poisoning the comparison with NaN. */
function activityTime(thread: ChannelDto): number {
    const raw = thread.lastActivityAt ?? thread.createdAt;
    const time = new Date(raw).getTime();
    return Number.isNaN(time) ? 0 : time;
}
