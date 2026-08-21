import type {IconNode} from 'lucide';
import {ChannelType} from '../../dtos/response/guild.dto';
import {lookupChannelIcon} from './channel-icon-catalog';
import {GuildFeature} from './guild-features';

/** Resolved by {@link channelViewFor}, not a template `@switch`, so an unrecognised type is never drawn as a message. */
export type ChannelView =
    | 'voice'
    | 'forum'
    | 'message'
    | 'list'
    | 'chores'
    | 'ledger'
    | 'pantry'
    | 'decisions'
    | 'meals'
    | 'maintenance'
    | 'unsupported';

export interface ChannelTypeMeta {
    type: ChannelType;
    /** Lucide icon name, or `null` for Text - which renders a literal `#` instead. */
    icon: string | null;
    /** The module gating this type, or `null` when nothing gates it (Text and Thread). */
    feature: GuildFeature | null;
    labelKey: string;
    descKey: string;
    view: ChannelView;
    /** Contents are structured rows, not messages: no history, no composer. */
    household?: boolean;
}

/** Every channel type this build knows, in sidebar order, as one table. */
export const CHANNEL_META: readonly ChannelTypeMeta[] = [
    // ── Chat types. Their label keys predate this table, hence the GUILD.* stem. ──
    {
        type: ChannelType.Text,
        icon: null,
        feature: null,
        labelKey: 'GUILD.CHANNEL_TYPE_TEXT',
        descKey: 'GUILD.CHANNEL_TYPE_TEXT_DESC',
        view: 'message',
    },
    {
        type: ChannelType.Voice,
        icon: 'volume-2',
        feature: GuildFeature.VoiceChannels,
        labelKey: 'GUILD.CHANNEL_TYPE_VOICE',
        descKey: 'GUILD.CHANNEL_TYPE_VOICE_DESC',
        view: 'voice',
    },
    {
        // A thread is never offered in the create-channel picker (created from a message), so it borrows the text strings only to keep the table total.
        type: ChannelType.Thread,
        icon: 'messages-square',
        feature: GuildFeature.Threads,
        labelKey: 'GUILD.CHANNEL_TYPE_TEXT',
        descKey: 'GUILD.CHANNEL_TYPE_TEXT_DESC',
        view: 'message',
    },
    {
        // Shares its icon with Thread deliberately: a forum post is a thread, and the two never appear as sibling rows.
        type: ChannelType.Forum,
        icon: 'messages-square',
        feature: GuildFeature.Forums,
        labelKey: 'GUILD.CHANNEL_TYPE_FORUM',
        descKey: 'GUILD.CHANNEL_TYPE_FORUM_DESC',
        view: 'forum',
    },
    {
        type: ChannelType.Media,
        icon: 'images',
        feature: GuildFeature.Forums,
        labelKey: 'GUILD.CHANNEL_TYPE_MEDIA',
        descKey: 'GUILD.CHANNEL_TYPE_MEDIA_DESC',
        view: 'forum',
    },
    {
        // Never offered in the create-channel picker either: a scene is created from a channel,
        // with its cast, by the scene dialog.
        type: ChannelType.Scene,
        icon: 'bookmark',
        feature: GuildFeature.Scenes,
        labelKey: 'SCENE.CHANNEL_TYPE',
        descKey: 'SCENE.CHANNEL_TYPE_DESC',
        view: 'message',
    },
    {
        type: ChannelType.Announcement,
        icon: 'megaphone',
        feature: GuildFeature.Announcements,
        labelKey: 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT',
        descKey: 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT_DESC',
        view: 'message',
    },

    // ── Household types: structured rows, no messages, no composer. ──────────────
    {
        type: ChannelType.List,
        icon: 'square-check',
        feature: GuildFeature.Lists,
        labelKey: 'CHANNEL_TYPE.LIST.LABEL',
        descKey: 'CHANNEL_TYPE.LIST.DESC',
        view: 'list',
        household: true,
    },
    {
        type: ChannelType.Chores,
        icon: 'refresh-cw',
        feature: GuildFeature.Chores,
        labelKey: 'CHANNEL_TYPE.CHORES.LABEL',
        descKey: 'CHANNEL_TYPE.CHORES.DESC',
        view: 'chores',
        household: true,
    },
    {
        type: ChannelType.Ledger,
        icon: 'wallet',
        feature: GuildFeature.Ledger,
        labelKey: 'CHANNEL_TYPE.LEDGER.LABEL',
        descKey: 'CHANNEL_TYPE.LEDGER.DESC',
        view: 'ledger',
        household: true,
    },
    {
        type: ChannelType.Pantry,
        icon: 'package',
        feature: GuildFeature.Pantry,
        labelKey: 'CHANNEL_TYPE.PANTRY.LABEL',
        descKey: 'CHANNEL_TYPE.PANTRY.DESC',
        view: 'pantry',
        household: true,
    },
    {
        type: ChannelType.Decisions,
        icon: 'flag',
        feature: GuildFeature.Decisions,
        labelKey: 'CHANNEL_TYPE.DECISIONS.LABEL',
        descKey: 'CHANNEL_TYPE.DECISIONS.DESC',
        view: 'decisions',
        household: true,
    },
    {
        type: ChannelType.Meals,
        icon: 'book-open',
        feature: GuildFeature.Meals,
        labelKey: 'CHANNEL_TYPE.MEALS.LABEL',
        descKey: 'CHANNEL_TYPE.MEALS.DESC',
        view: 'meals',
        household: true,
    },
    {
        type: ChannelType.Maintenance,
        icon: 'wrench',
        feature: GuildFeature.Maintenance,
        labelKey: 'CHANNEL_TYPE.MAINTENANCE.LABEL',
        descKey: 'CHANNEL_TYPE.MAINTENANCE.DESC',
        view: 'maintenance',
        household: true,
    },
];

/** Keyed by the raw string so an off-enum value from a newer server simply misses. */
const META_BY_TYPE = new Map<string, ChannelTypeMeta>(CHANNEL_META.map(meta => [meta.type as string, meta]));

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The types whose contents are structured rows rather than messages. */
export const HOUSEHOLD_CHANNEL_META: readonly ChannelTypeMeta[] = CHANNEL_META.filter(meta => meta.household);

/** Keyed by the raw string, same as {@link META_BY_TYPE}. */
const HOUSEHOLD_TYPE_SET: ReadonlySet<string> = new Set(
    HOUSEHOLD_CHANNEL_META.map(meta => meta.type as string),
);

/** The type's default icon name; `null` means "no icon" (Text renders a literal `#`), and an unknown type gets whatever fallback the caller prefers. */
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

/** An allowlist: a type with no row (an unshipped household type, or a type from a newer server) is inert, never falls through to the message view. */
export function channelViewFor(type: ChannelType): ChannelView {
    return META_BY_TYPE.get(type as string)?.view ?? 'unsupported';
}

/** The tint a channel asks for, or null. Anything that is not #rrggbb is dropped here rather than reaching a style binding. */
export function channelIconTint(channel: {iconColor?: string}): string | null {
    const colour = channel.iconColor;
    if (!colour || !HEX_COLOUR.test(colour)) return null;
    return colour;
}

/** The icon a channel actually renders: its own if this build ships it, otherwise its type's. */
export function channelIconDataFor(channel: {type: ChannelType; icon?: string}): IconNode | null {
    return lookupChannelIcon(channel.icon) ?? lookupChannelIcon(channelIcon(channel.type));
}
