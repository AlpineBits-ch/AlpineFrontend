import {CategoryDto, ChannelDto, GuildDto} from '../dtos/response/guild.dto';
import {activeSlotId} from './scoped-oauth-storage';

/**
 * The last known guild layout, on disk, per account.
 *
 * <p><b>Why this exists.</b> Nothing about a guild survived a launch. `NavigationService` persisted
 * the *position* - bare ids under `alpine_nav:&lt;slot&gt;` - and the guilds those ids name were
 * fetched from scratch by `ServerTaskbarComponent.ngOnInit`, with `tryRestoreGuildNav` unable to run
 * until the response landed. So the server rail, the channel list and the channel itself were all
 * blocked on one cold network request before a single pixel of the app appeared.</p>
 *
 * <p><b>Why `localStorage` and not IndexedDB.</b> Because it is synchronous. The entire point is to
 * have the layout in hand *before* the first request is issued, from a field initializer that runs
 * during dependency construction. An async store would put the read back on the critical path and
 * reintroduce exactly the wait this removes - a smaller one, but the same shape.</p>
 *
 * <p><b>Why the scoping is not optional.</b> A guild's channel list is one account's private
 * membership. Rendering account A's cached channel names while account B is signed in is a
 * confidentiality bug, not a cosmetic one, so every entry is keyed by slot and every failure path
 * degrades to <i>showing nothing</i> rather than to showing whatever was there.</p>
 *
 * <p>The slot comes from {@link activeSlotId} rather than from
 * `AccountRegistryService.activeSlotIdSnapshot()`, which is how `NavigationService.navKey` solves
 * the same problem. Two reasons. It is the synchronous primitive - it reads `localStorage` directly
 * and answers correctly before Angular has finished booting, which is when this cache is read. And
 * it needs no injector: `GuildService` is constructed in specs with an `HttpClient` and an
 * `ApiConfigService` and nothing else, and taking a dependency on the account registry there would
 * drag the OAuth client into every one of them. `navKey`'s choice is right for `NavigationService`,
 * which already injects the registry for other reasons and only reads the key after a navigation;
 * it is the wrong one here.</p>
 */

/** Bumped when the stored shape changes. A blob from another version is discarded, not guessed at. */
const CACHE_VERSION = 1;

const KEY_PREFIX = 'alpine_guilds';

/**
 * How large the serialized blob is allowed to get, in UTF-16 code units.
 *
 * <p>Measured rather than guessed. A typical 20-channel, 10-role guild serializes to about 22 000
 * characters; twelve of them come to roughly 270 000, and a hundred to about 2 250 000. Chromium
 * bills DOM storage at two bytes per character against a ~5 MiB per-origin budget, and that budget
 * is shared with the OAuth tokens, the nav position, the theme, the keybinds and the wiki drafts.
 * An account with a large server list would therefore not merely fail to cache itself - it would
 * be the write that makes somebody else's fail.</p>
 *
 * <p>600 000 characters is ~1.2 MiB of that budget and covers roughly 26 typical guilds whole.
 * Past that the list is truncated to a <b>prefix</b>, so what is kept stays in the server's own
 * order rather than an arbitrary subset, and the remainder simply arrives with the network response
 * as it does today.</p>
 */
const MAX_CACHE_CHARS = 600_000;

/** The two fields `GuildDto` and every DTO nested in it declare as `Date` and JSON returns as text. */
const DATE_FIELDS = ['createdAt', 'updatedAt'] as const;

interface CacheEnvelope {
    v: number;
    guilds: unknown[];
}

export function guildLayoutCacheKey(slotId: string): string {
    return `${KEY_PREFIX}:${slotId}`;
}

/**
 * The stored layout for a slot, or an empty list.
 *
 * <p>Empty is the answer to every problem: no entry, a truncated blob, a blob from a future version,
 * a locked-down profile whose `localStorage` throws, a test runner whose global has no methods. All
 * of them mean "no cache, fetch from the network as before", which is the behaviour that shipped
 * before this file existed.</p>
 */
export function readGuildLayoutCache(slotId: string = activeSlotId()): GuildDto[] {
    let raw: string | null;
    try {
        raw = localStorage.getItem(guildLayoutCacheKey(slotId));
    } catch {
        return [];
    }
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw) as CacheEnvelope | null;
        if (!parsed || parsed.v !== CACHE_VERSION || !Array.isArray(parsed.guilds)) return [];
        return parsed.guilds.filter(isUsableGuild).map(reviveGuildDates);
    } catch {
        return [];
    }
}

/**
 * Replaces this slot's stored layout.
 *
 * <p>Never throws. A full quota leaves the previous snapshot in place - older than what we have in
 * memory, but structurally valid, and the network response corrects it on the next launch inside one
 * request. Deleting it on a failed write would trade a slightly stale first paint for a blank
 * one.</p>
 */
export function writeGuildLayoutCache(guilds: readonly GuildDto[], slotId: string = activeSlotId()): void {
    try {
        localStorage.setItem(guildLayoutCacheKey(slotId), serialize(guilds));
    } catch {
        // See above, and see `setActiveSlotId`: a cache that cannot be written is a cache miss on
        // the next launch, and a cache miss is the behaviour this whole file is an optimisation of.
    }
}

/**
 * Forgets a slot's layout.
 *
 * <p>Called when the session behind it ends - see `runSignOut`, which is the single ordered
 * description of that, and `AccountSwitchService.signOutOf`, which does it for a slot that may not
 * be the live one.</p>
 */
export function clearGuildLayoutCache(slotId: string = activeSlotId()): void {
    try {
        localStorage.removeItem(guildLayoutCacheKey(slotId));
    } catch {
        // Nothing useful to do. The next read of a slot nobody is signed into is scoped away anyway.
    }
}

/**
 * Serializes, trimming to {@link MAX_CACHE_CHARS} by dropping from the end of the list.
 *
 * <p>Sized per guild first so the trim costs one extra pass rather than one re-serialization per
 * candidate length.</p>
 */
function serialize(guilds: readonly GuildDto[]): string {
    const whole = JSON.stringify({v: CACHE_VERSION, guilds});
    if (whole.length <= MAX_CACHE_CHARS) return whole;

    let budget = MAX_CACHE_CHARS - 32; // the envelope, plus the separators between entries
    const kept: GuildDto[] = [];
    for (const guild of guilds) {
        const size = JSON.stringify(guild).length + 1;
        if (size > budget) break;
        budget -= size;
        kept.push(guild);
    }
    return JSON.stringify({v: CACHE_VERSION, guilds: kept});
}

/**
 * Whether an entry is shaped enough to hand to a consumer.
 *
 * <p>Consumers index straight into these arrays - `serverIcons` does `g.channels.reduce(...)` with
 * no guard - so a half-written or hand-edited entry has to be dropped here rather than turned into
 * a `TypeError` inside a computed signal.</p>
 */
function isUsableGuild(value: unknown): value is GuildDto {
    const g = value as Partial<GuildDto> | null;
    return (
        !!g &&
        typeof g.id === 'string' &&
        Array.isArray(g.channels) &&
        Array.isArray(g.categories) &&
        Array.isArray(g.roles)
    );
}

/**
 * Turns the date fields back into `Date`s, in place.
 *
 * <p><b>The trap this closes.</b> `GuildDto.createdAt` and `.updatedAt` are declared `Date`;
 * `JSON.parse` returns strings; TypeScript goes on insisting they are `Date`s. The mismatch does not
 * fail here, it fails wherever something first calls a `Date` method on one - `cacheBustedUrl` is
 * the shape of call site that would - and by then nothing points back at this file.</p>
 *
 * <p>Only the fields the DTOs actually declare as `Date` are touched. `ChannelDto.lastActivityAt`
 * and `.autoArchiveAt` are declared `string` and are deliberately left as text: "revive everything
 * that looks like a date" would make those disagree with their own type in the other direction.</p>
 *
 * <p>A value that will not parse is left exactly as it was. An `Invalid Date` passes `instanceof`
 * and then poisons every comparison it reaches, which is strictly worse than the string.</p>
 */
export function reviveGuildDates(guild: GuildDto): GuildDto {
    reviveOn(guild);
    for (const channel of guild.channels ?? []) reviveChannel(channel);
    for (const category of guild.categories ?? []) reviveCategory(category);
    for (const role of guild.roles ?? []) reviveOn(role as unknown as Record<string, unknown>);
    return guild;
}

function reviveChannel(channel: ChannelDto): void {
    reviveOn(channel as unknown as Record<string, unknown>);
    for (const permission of channel.permissions ?? []) {
        reviveOn(permission as unknown as Record<string, unknown>);
    }
}

function reviveCategory(category: CategoryDto): void {
    reviveOn(category as unknown as Record<string, unknown>);
    for (const permission of category.permissions ?? []) {
        reviveOn(permission as unknown as Record<string, unknown>);
    }
}

function reviveOn(target: unknown): void {
    const record = target as Record<string, unknown> | null;
    if (!record || typeof record !== 'object') return;
    for (const field of DATE_FIELDS) {
        const value = record[field];
        if (typeof value !== 'string') continue;
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) record[field] = parsed;
    }
}
