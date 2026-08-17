import {CategoryDto, ChannelDto, GuildDto, RoleDto} from '../dtos/response/guild.dto';

/**
 * Folds a freshly fetched guild list into the one already on screen, <b>preserving the object
 * identity of everything that did not actually change</b>.
 *
 * <p><b>Why this is not just `guilds.set(response)`.</b> Object identity is the change signal for
 * most of the guild UI, and a new object for an unchanged guild is a full teardown:</p>
 * <ul>
 *   <li>`GuildMemberListComponent.ngOnChanges(changes['guild'])` resets the roster and refetches
 *   the entire member page plus the own-member row on <i>any</i> new `guild` reference.</li>
 *   <li>Five effects in `ChannelListComponent`, and the ones in `ChannelComponent`, key off
 *   `this.guild()`.</li>
 * </ul>
 * <p>Blindly replacing the list therefore makes a layout cache cost more than it saves: the first
 * paint gets faster and then everything behind it re-requests anyway.</p>
 *
 * <p><b>It fixes a live bug too, not just a new one.</b> `ServerTaskbarComponent` handles the
 * `guildUpdated` websocket event by refetching the whole guild and republishing it, which produces
 * a fresh identity every time - including for the events where nothing any of those components
 * reads has moved. Routing that path through here collapses those into no-ops.</p>
 *
 * <p>Preservation is nested rather than per guild. A guild with one renamed channel does need a new
 * guild object, but handing all nineteen of its <i>other</i> channels new identities as collateral
 * is the same mistake one level down - not least because one of them is the channel the user is
 * currently reading.</p>
 */
export function reconcileGuilds(
    current: readonly GuildDto[],
    incoming: readonly GuildDto[],
): readonly GuildDto[] {
    return preserveIdentity(current, incoming, reconcileGuild);
}

function reconcileGuild(existing: GuildDto, fresh: GuildDto): GuildDto {
    return {
        ...fresh,
        channels: preserveIdentity(existing.channels ?? [], fresh.channels ?? []) as ChannelDto[],
        categories: preserveIdentity(existing.categories ?? [], fresh.categories ?? []) as CategoryDto[],
        roles: preserveIdentity(existing.roles ?? [], fresh.roles ?? []) as RoleDto[],
    };
}

/**
 * The generic half: walk `incoming`, and wherever an entry is structurally identical to the one
 * already held under that id, keep the one already held.
 *
 * <p>Returns `current` itself - not a copy - when every entry survived <i>in the same order</i>,
 * so a `signal.set` with the result is a no-op under Angular's default `Object.is` equality and
 * notifies nobody at all.</p>
 */
function preserveIdentity<T extends {id: string}>(
    current: readonly T[],
    incoming: readonly T[],
    merge?: (existing: T, fresh: T) => T,
): readonly T[] {
    if (current === incoming) return current;

    const byId = new Map(current.map(entry => [entry.id, entry]));
    let changed = current.length !== incoming.length;

    const next = incoming.map((fresh, index) => {
        const existing = byId.get(fresh.id);
        if (!existing) {
            changed = true;
            return fresh;
        }
        if (signatureOf(existing) === signatureOf(fresh)) {
            // Same content. Still a change to the *list* if it moved, and the list identity has to
            // say so or a reorder would never reach the rail.
            if (current[index] !== existing) changed = true;
            return existing;
        }
        changed = true;
        return merge ? merge(existing, fresh) : fresh;
    });

    return changed ? next : current;
}

/** The fields JSON round-tripping turns from `Date` into text - see `reviveGuildDates`. */
const DATE_KEYS = new Set(['createdAt', 'updatedAt']);

/**
 * A structural fingerprint, with the date fields normalized to an instant.
 *
 * <p>The normalization is what makes a warm cold start work. What is already in the signal came out
 * of the cache with revived `Date`s; what just landed off the wire carries the server's text form,
 * which is .NET's offset-bearing `2026-08-13T09:41:22.1230000+00:00` rather than an ISO `Z`. Those
 * are the same instant, and a comparison that called them different would report every guild as
 * changed on every launch - defeating the cache precisely when it matters.</p>
 *
 * <p>`JSON.stringify` calls `toJSON` before the replacer, so a `Date` reaches the replacer already
 * flattened to a string and both forms take the same path. A value that will not parse is compared
 * as itself: mapping it to `NaN` would make two different pieces of garbage look equal.</p>
 */
function signatureOf(value: unknown): string {
    return JSON.stringify(value, (key, raw) => {
        if (!DATE_KEYS.has(key) || typeof raw !== 'string') return raw;
        const instant = Date.parse(raw);
        return Number.isNaN(instant) ? raw : instant;
    });
}
