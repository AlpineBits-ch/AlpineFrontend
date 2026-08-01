import {HttpErrorResponse} from '@angular/common/http';
import {ChannelDto, ChannelType, isForumLike} from '../../../../dtos/response/guild.dto';

/**
 * Classifies a send failure as an auto-mod refusal.
 *
 * Auto-mod refusals come back as a 403 with a structured body
 * `{ error: 'automod_blocked', reason: 'blocked_word' | 'rate_limited' }`. Ordinary permission
 * failures are also 403s but carry no such body, so only a 403 with `error: 'automod_blocked'`
 * counts — everything else (including other 403s) yields `null`.
 */
export function classifyAutoModError(err: HttpErrorResponse | null | undefined): 'blocked_word' | 'rate_limited' | null {
    if (!err || err.status !== 403) return null;
    const body = err.error as { error?: string; reason?: string } | null;
    if (body?.error !== 'automod_blocked') return null;
    return body.reason === 'rate_limited' ? 'rate_limited' : 'blocked_word';
}

/** What this device knows about a channel's encryption, from its own point of view. */
export type ChannelEncryptionState = 'plain' | 'joined' | 'locked-out';

/**
 * Whether a message may be posted to this channel as cleartext.
 *
 * <p>"This device holds no MLS generation for the channel" and "the channel is not encrypted" are
 * different statements, and treating the first as the second put plaintext on the wire into a
 * channel that is encrypted server-side. The server refuses it - but only after the plaintext has
 * already left the machine, which is the part that cannot be taken back.</p>
 *
 * <p>By the time this is consulted the encryption state has been resolved and any waiting Welcome
 * joined, so anything other than `plain` means this device genuinely cannot participate.</p>
 */
export function mayPostCleartext(
    localGeneration: number | null,
    state: ChannelEncryptionState,
): boolean {
    // Holding a generation means the channel is encrypted for us, whatever the resolved state says.
    if (localGeneration !== null) return false;
    return state === 'plain';
}

/**
 * The forum a post belongs to, or null if this channel isn't a forum post.
 *
 * A forum post is an ordinary Thread whose parent happens to be a Forum or Media
 * channel, so "is this a post?" and "which forum?" are the same lookup. A dangling
 * parentChannelId - the parent not yet in the cached channel list - is a null rather
 * than a throw, because both callers run during render of the main view.
 */
export function forumParentOf(
    channel: ChannelDto,
    channels: readonly ChannelDto[],
): ChannelDto | null {
    if (channel.type !== ChannelType.Thread) return null;
    const parentId = channel.parentChannelId;
    if (!parentId) return null;
    return channels.find(c => c.id === parentId && isForumLike(c.type)) ?? null;
}
