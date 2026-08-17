import {HttpErrorResponse} from '@angular/common/http';
import {ChannelDto, ChannelType, isForumLike} from '../../../../dtos/response/guild.dto';

/** Classifies a send failure as an auto-mod refusal: only a 403 with body `{ error: 'automod_blocked', reason: ... }` counts; everything else (including other 403s) yields `null`. */
export function classifyAutoModError(err: HttpErrorResponse | null | undefined): 'blocked_word' | 'rate_limited' | null {
    if (!err || err.status !== 403) return null;
    const body = err.error as { error?: string; reason?: string } | null;
    if (body?.error !== 'automod_blocked') return null;
    return body.reason === 'rate_limited' ? 'rate_limited' : 'blocked_word';
}

/** What this device knows about a channel's encryption, from its own point of view. */
export type ChannelEncryptionState = 'plain' | 'joined' | 'locked-out' | 'downgraded';

/**
 * Whether a message may be posted to this channel as cleartext.
 * @param encryptionFloor highest generation this device has ever held here; non-null vetoes everything else, even a resolved state of `plain`, since that state is a server field the server could otherwise reset while a generation was held.
 */
export function mayPostCleartext(
    localGeneration: number | null,
    state: ChannelEncryptionState,
    encryptionFloor: number | null = null,
): boolean {
    if (encryptionFloor !== null) return false;
    // Holding a generation means the channel is encrypted for us, whatever the resolved state says.
    if (localGeneration !== null) return false;
    return state === 'plain';
}

/** The forum a post belongs to, or null if this channel isn't a forum post; a dangling parentChannelId returns null rather than throwing, since both callers run during render of the main view. */
export function forumParentOf(
    channel: ChannelDto,
    channels: readonly ChannelDto[],
): ChannelDto | null {
    if (channel.type !== ChannelType.Thread) return null;
    const parentId = channel.parentChannelId;
    if (!parentId) return null;
    return channels.find(c => c.id === parentId && isForumLike(c.type)) ?? null;
}
