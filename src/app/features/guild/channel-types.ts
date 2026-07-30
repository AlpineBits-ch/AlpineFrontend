import {ChannelType, isForumLike} from '../../dtos/response/guild.dto';
import {GuildFeature} from './guild-features';

/**
 * How a channel should be drawn. Resolved by {@link channelViewFor} rather than by a
 * template `@switch`, so "an unrecognised type is never a message view" is something a
 * test asserts instead of something a reviewer has to notice.
 */
export type ChannelView = 'voice' | 'forum' | 'message' | 'unsupported';

export interface ChannelTypeMeta {
    type: ChannelType;
    /** PrimeIcons class, or `null` for Text - which renders a literal `#` instead. */
    icon: string | null;
    /** The module gating this type, or `null` when nothing gates it (Text and Thread). */
    feature: GuildFeature | null;
    labelKey: string;
    descKey: string;
}

/**
 * The types whose contents are structured rows rather than messages. Declared as raw
 * strings ahead of the table so the table can be filtered by it at module init.
 */
const HOUSEHOLD_TYPE_SET: ReadonlySet<string> = new Set([
    ChannelType.List, ChannelType.Chores, ChannelType.Ledger,
    ChannelType.Pantry, ChannelType.Decisions,
]);

/**
 * Every channel type this build knows, in sidebar order. One table, because the
 * leading icon for a type was previously chosen by an `@if` ladder in the sidebar row
 * *and* independently again in the create-channel modal - at eleven types those stop
 * agreeing with each other. {@link channelIcon} is the only icon lookup in the app.
 */
export const CHANNEL_META: readonly ChannelTypeMeta[] = [
    // ── Chat types. Their label keys predate this table, hence the GUILD.* stem. ──
    {
        type: ChannelType.Text,
        icon: null,
        feature: null,
        labelKey: 'GUILD.CHANNEL_TYPE_TEXT',
        descKey: 'GUILD.CHANNEL_TYPE_TEXT_DESC',
    },
    {
        type: ChannelType.Voice,
        icon: 'pi pi-volume-up',
        feature: GuildFeature.VoiceChannels,
        labelKey: 'GUILD.CHANNEL_TYPE_VOICE',
        descKey: 'GUILD.CHANNEL_TYPE_VOICE_DESC',
    },
    {
        // A thread is never offered in the create-channel picker - it is created from a
        // message - so it borrows the text strings purely to keep the table total.
        type: ChannelType.Thread,
        icon: 'pi pi-comments',
        feature: GuildFeature.Threads,
        labelKey: 'GUILD.CHANNEL_TYPE_TEXT',
        descKey: 'GUILD.CHANNEL_TYPE_TEXT_DESC',
    },
    {
        type: ChannelType.Forum,
        icon: 'pi pi-align-left',
        feature: GuildFeature.Forums,
        labelKey: 'GUILD.CHANNEL_TYPE_FORUM',
        descKey: 'GUILD.CHANNEL_TYPE_FORUM_DESC',
    },
    {
        type: ChannelType.Media,
        icon: 'pi pi-images',
        feature: GuildFeature.Forums,
        labelKey: 'GUILD.CHANNEL_TYPE_MEDIA',
        descKey: 'GUILD.CHANNEL_TYPE_MEDIA_DESC',
    },
    {
        type: ChannelType.Announcement,
        icon: 'pi pi-megaphone',
        feature: GuildFeature.Announcements,
        labelKey: 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT',
        descKey: 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT_DESC',
    },

    // ── Household types: structured rows, no messages, no composer. ──────────────
    {
        type: ChannelType.List,
        icon: 'pi pi-check-square',
        feature: GuildFeature.Lists,
        labelKey: 'CHANNEL_TYPE.LIST.LABEL',
        descKey: 'CHANNEL_TYPE.LIST.DESC',
    },
    {
        type: ChannelType.Chores,
        icon: 'pi pi-sync',
        feature: GuildFeature.Chores,
        labelKey: 'CHANNEL_TYPE.CHORES.LABEL',
        descKey: 'CHANNEL_TYPE.CHORES.DESC',
    },
    {
        type: ChannelType.Ledger,
        icon: 'pi pi-wallet',
        feature: GuildFeature.Ledger,
        labelKey: 'CHANNEL_TYPE.LEDGER.LABEL',
        descKey: 'CHANNEL_TYPE.LEDGER.DESC',
    },
    {
        type: ChannelType.Pantry,
        icon: 'pi pi-box',
        feature: GuildFeature.Pantry,
        labelKey: 'CHANNEL_TYPE.PANTRY.LABEL',
        descKey: 'CHANNEL_TYPE.PANTRY.DESC',
    },
    {
        type: ChannelType.Decisions,
        icon: 'pi pi-flag',
        feature: GuildFeature.Decisions,
        labelKey: 'CHANNEL_TYPE.DECISIONS.LABEL',
        descKey: 'CHANNEL_TYPE.DECISIONS.DESC',
    },
];

/** Keyed by the raw string so an off-enum value from a newer server simply misses. */
const META_BY_TYPE = new Map<string, ChannelTypeMeta>(
    CHANNEL_META.map(meta => [meta.type as string, meta]),
);

/** The five whose contents are structured rows rather than messages. */
export const HOUSEHOLD_CHANNEL_META: readonly ChannelTypeMeta[] = CHANNEL_META.filter(
    meta => HOUSEHOLD_TYPE_SET.has(meta.type as string),
);

/**
 * The leading glyph for a channel type. `null` means "no icon" - Text renders a literal
 * `#`, and an unknown type gets whatever fallback the caller prefers. The single icon
 * lookup in the app: the sidebar row and the create-channel picker both call this.
 */
export function channelIcon(type: ChannelType): string | null {
    return META_BY_TYPE.get(type as string)?.icon ?? null;
}

export function householdChannelMeta(type: ChannelType): ChannelTypeMeta | null {
    if (!HOUSEHOLD_TYPE_SET.has(type as string)) return null;
    return META_BY_TYPE.get(type as string) ?? null;
}

export function isHouseholdChannel(type: ChannelType): boolean {
    return HOUSEHOLD_TYPE_SET.has(type as string);
}

export function householdFeatureFor(type: ChannelType): GuildFeature | null {
    return householdChannelMeta(type)?.feature ?? null;
}

/** The types this build can render as a message view - the only ones that get a composer. */
const MESSAGE_TYPES: readonly string[] = [
    ChannelType.Text, ChannelType.Announcement, ChannelType.Thread,
];

/**
 * Deliberately an allowlist. The previous template `@else` sent every unrecognised type
 * to the message view, which is how a household channel ends up offering a composer that
 * posts nowhere. Anything not named here - a household type whose module has not shipped,
 * or a type from a newer server - is inert.
 */
export function channelViewFor(type: ChannelType): ChannelView {
    if (type === ChannelType.Voice) return 'voice';
    if (isForumLike(type)) return 'forum';
    if (MESSAGE_TYPES.includes(type as string)) return 'message';
    return 'unsupported';
}
