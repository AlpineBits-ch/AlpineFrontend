import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {ChannelReadState} from '../../../../../../services/guild-read-state.service';

/**
 * The most rows one forum will ever contribute to the sidebar. Visited posts are already
 * capped when they are recorded, but unread and mentioned ones are not - a busy forum
 * could otherwise push twenty rows into the sidebar and bury every channel below it. The
 * forum's own rolled-up badge still reports everything, including what was cut.
 */
export const MAX_NESTED_POST_ROWS = 8;

/**
 * Why a post earned its place in the sidebar. Ordered by how much it wants attention,
 * and used directly as the sort key, so a mention never falls off the end of the list
 * while a post you merely glanced at survives.
 */
enum Priority {
    Mentioned = 0,
    Unread = 1,
    Visited = 2,
}

/**
 * The posts to draw beneath a forum: the ones you were just reading, plus the ones asking
 * for you. Archived posts never qualify - they have left the forum's default list, and a
 * sidebar row pointing into a filtered-out post is a dead end.
 *
 * Ordering is by claim on your attention first and recency second, because the list is
 * capped: whatever is cut should be the least interesting thing, not whatever happened to
 * sort last.
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

/**
 * lastActivityAt is absent until someone posts, and on every thread predating the
 * forum-parity deploy, so createdAt is the documented fallback. An unparseable date sorts
 * last rather than poisoning the comparison with NaN.
 */
function activityTime(post: ChannelDto): number {
    const raw = post.lastActivityAt ?? post.createdAt;
    const time = new Date(raw).getTime();
    return Number.isNaN(time) ? 0 : time;
}
