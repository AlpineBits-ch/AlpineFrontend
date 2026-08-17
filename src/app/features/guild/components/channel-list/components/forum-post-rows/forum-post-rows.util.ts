import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {ChannelReadState} from '../../../../../../services/guild-read-state.service';

/** The most rows one forum contributes to the sidebar. Visited posts are capped when recorded, but unread/mentioned ones aren't, so this caps a busy forum from burying every channel below it; the forum's rolled-up badge still reports everything, including what was cut. */
export const MAX_NESTED_POST_ROWS = 8;

/** Why a post earned its place in the sidebar, ordered by how much it wants attention and used directly as the sort key, so a mention never falls off the list while a merely-glanced-at post survives. */
enum Priority {
    Mentioned = 0,
    Unread = 1,
    Visited = 2,
}

/**
 * The posts to draw beneath a forum: recently read plus ones asking for attention. Archived posts never qualify, since they've left the forum's default list and a sidebar row into one would be a dead end.
 * Ordered by attention first, recency second, since the list is capped and whatever gets cut should be the least interesting item.
 */
export function selectNestedPosts(
    forumId: string,
    allChannels: readonly ChannelDto[],
    visitedPostIds: readonly string[],
    readStateOf: (channelId: string) => ChannelReadState,
): ChannelDto[] {
    const visited = new Set(visitedPostIds);

    const scored: {post: ChannelDto; priority: Priority; activity: number}[] = [];
    for (const post of allChannels) {
        if (post.parentChannelId !== forumId) continue;
        if (post.isArchived) continue;

        const state = readStateOf(post.id);
        const priority = state.mentionCount > 0 ? Priority.Mentioned
            : state.isUnread ? Priority.Unread
                : visited.has(post.id) ? Priority.Visited
                    : null;
        if (priority === null) continue;

        scored.push({post, priority, activity: activityTime(post)});
    }

    return scored
        .sort((a, b) => a.priority - b.priority || b.activity - a.activity)
        .slice(0, MAX_NESTED_POST_ROWS)
        .map(entry => entry.post);
}

/** lastActivityAt is absent until someone posts (and on every thread predating the forum-parity deploy), so createdAt is the fallback; an unparseable date sorts last rather than poisoning the comparison with NaN. */
function activityTime(post: ChannelDto): number {
    const raw = post.lastActivityAt ?? post.createdAt;
    const time = new Date(raw).getTime();
    return Number.isNaN(time) ? 0 : time;
}
