import {GuildDto, GuildKind} from '../../dtos/response/guild.dto';

/**
 * Which modules a guild has. Deliberately a **set of flag names**, not a bitmask:
 * the wire format is a comma-separated string of names - the same shape `permissions`
 * already uses on roles - and the server accepts names on write too. Keeping names
 * end-to-end means a flag being renumbered server-side can't silently change what
 * this client sends.
 */
export const GuildFeature = {
    VoiceChannels: 'VoiceChannels',
    Threads: 'Threads',
    /** Gates Forum **and** Media channels alike. */
    Forums: 'Forums',
    Announcements: 'Announcements',
    Tickets: 'Tickets',
    Moderation: 'Moderation',
    AutoMod: 'AutoMod',
    Onboarding: 'Onboarding',
    Emojis: 'Emojis',
    Bots: 'Bots',
    Wiki: 'Wiki',
    Events: 'Events',

    // Household modules. Each one gates real endpoints, and the first five gate a channel
    // type apiece - a guild without the module answers `403` to every call behind it and
    // refuses to create the channel, for everybody including the owner.
    Lists: 'Lists',
    Chores: 'Chores',
    Ledger: 'Ledger',
    Pantry: 'Pantry',
    Decisions: 'Decisions',
    Presence: 'Presence',
    QuietHours: 'QuietHours',
    GuestAccess: 'GuestAccess',
    Meals: 'Meals',
    Maintenance: 'Maintenance',
} as const;

export type GuildFeature = typeof GuildFeature[keyof typeof GuildFeature];

/**
 * Plain strings rather than `GuildFeature`, because unknown names must survive a
 * round trip: the modules page sends the *exact* set back, so a module this build
 * predates would otherwise be switched off by saving an unrelated toggle.
 */
export type GuildFeatureSet = ReadonlySet<string>;

export const COMMUNITY_MODULES: readonly GuildFeature[] = [
    GuildFeature.VoiceChannels,
    GuildFeature.Threads,
    GuildFeature.Forums,
    GuildFeature.Announcements,
    GuildFeature.Tickets,
    GuildFeature.Moderation,
    GuildFeature.AutoMod,
    GuildFeature.Onboarding,
    GuildFeature.Emojis,
    GuildFeature.Bots,
    GuildFeature.Wiki,
    GuildFeature.Events,
];

export const HOUSEHOLD_MODULES: readonly GuildFeature[] = [
    GuildFeature.Lists,
    GuildFeature.Chores,
    GuildFeature.Ledger,
    GuildFeature.Pantry,
    GuildFeature.Decisions,
    GuildFeature.Presence,
    GuildFeature.QuietHours,
    GuildFeature.GuestAccess,
    GuildFeature.Meals,
    GuildFeature.Maintenance,
];

/**
 * The modules the home digest can actually describe.
 *
 * <p>Not all ten: Quiet Hours and Guest Access are settings rather than content, so a house with
 * only those has nothing for a glance to show. These eight have a section of
 * `GET /guilds/{id}/home` apiece - Ledger has two of them, since bills are a section beside
 * expenses, and Presence covers both the home-status board and the away board.</p>
 */
const DIGEST_MODULES: readonly GuildFeature[] = [
    GuildFeature.Lists,
    GuildFeature.Chores,
    GuildFeature.Ledger,
    GuildFeature.Pantry,
    GuildFeature.Decisions,
    GuildFeature.Presence,
    GuildFeature.Meals,
    GuildFeature.Maintenance,
];

/**
 * What a guild has when the server doesn't report `features` at all - an older
 * backend, or a payload that predates the field. Every guild that existed before
 * modules landed is a Community with the full community preset, so assuming
 * "everything on" keeps those guilds behaving exactly as they did. The opposite
 * default would blank out most of the UI.
 */
const COMMUNITY_PRESET: GuildFeatureSet = new Set<string>(COMMUNITY_MODULES);

/**
 * `"VoiceChannels, Threads"` -> the set. `"None"` and `""` both mean no modules,
 * which is distinct from *absent* - see {@link COMMUNITY_PRESET}.
 */
export function parseGuildFeatures(raw: string | null | undefined): GuildFeatureSet {
    if (raw === null || raw === undefined) return COMMUNITY_PRESET;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'None') return new Set<string>();
    return new Set(trimmed.split(',').map(name => name.trim()).filter(Boolean));
}

/** Emits `"None"` for an empty set, matching what the server serializes. */
export function serializeGuildFeatures(features: Iterable<string>): string {
    const names = [...features];
    return names.length ? names.join(', ') : 'None';
}

export function guildFeatures(guild: Pick<GuildDto, 'features'> | null | undefined): GuildFeatureSet {
    return parseGuildFeatures(guild?.features);
}

export function guildHasFeature(guild: Pick<GuildDto, 'features'> | null | undefined, feature: GuildFeature): boolean {
    return guildFeatures(guild).has(feature);
}

/**
 * Whether the house view has anything to offer for this guild.
 *
 * <p>Any one of the six digest modules is enough: the digest nulls the sections it cannot answer,
 * so a house that only does chores gets a chores-only glance rather than nothing. The entry point
 * is hidden - never disabled - when none of them is on, exactly like every other module link.</p>
 */
export function hasHouseholdModule(guild: Pick<GuildDto, 'features'> | null | undefined): boolean {
    const features = guildFeatures(guild);
    return DIGEST_MODULES.some(feature => features.has(feature));
}

export function withGuildFeature(features: GuildFeatureSet, feature: string, enabled: boolean): Set<string> {
    const next = new Set(features);
    if (enabled) next.add(feature); else next.delete(feature);
    return next;
}

export function guildKindOf(guild: Pick<GuildDto, 'kind'> | null | undefined): GuildKind {
    return guild?.kind ?? GuildKind.Community;
}

// ── Presentation metadata ───────────────────────────────────────────────────

export interface GuildKindMeta {
    kind: GuildKind;
    icon: string;
    labelKey: string;
    descriptionKey: string;
    /** The noun this kind's members would use for the guild itself. */
    nounKey: string;
    namePlaceholderKey: string;
}

export const GUILD_KIND_META: readonly GuildKindMeta[] = [
    {
        kind: GuildKind.Community,
        icon: 'pi pi-users',
        labelKey: 'GUILD_KIND.COMMUNITY.LABEL',
        descriptionKey: 'GUILD_KIND.COMMUNITY.DESC',
        nounKey: 'GUILD_KIND.COMMUNITY.NOUN',
        namePlaceholderKey: 'GUILD_KIND.COMMUNITY.NAME_PLACEHOLDER',
    },
    {
        kind: GuildKind.Household,
        icon: 'pi pi-home',
        labelKey: 'GUILD_KIND.HOUSEHOLD.LABEL',
        descriptionKey: 'GUILD_KIND.HOUSEHOLD.DESC',
        nounKey: 'GUILD_KIND.HOUSEHOLD.NOUN',
        namePlaceholderKey: 'GUILD_KIND.HOUSEHOLD.NAME_PLACEHOLDER',
    },
    {
        kind: GuildKind.Team,
        icon: 'pi pi-briefcase',
        labelKey: 'GUILD_KIND.TEAM.LABEL',
        descriptionKey: 'GUILD_KIND.TEAM.DESC',
        nounKey: 'GUILD_KIND.TEAM.NOUN',
        namePlaceholderKey: 'GUILD_KIND.TEAM.NAME_PLACEHOLDER',
    },
    {
        kind: GuildKind.Study,
        icon: 'pi pi-graduation-cap',
        labelKey: 'GUILD_KIND.STUDY.LABEL',
        descriptionKey: 'GUILD_KIND.STUDY.DESC',
        nounKey: 'GUILD_KIND.STUDY.NOUN',
        namePlaceholderKey: 'GUILD_KIND.STUDY.NAME_PLACEHOLDER',
    },
    {
        kind: GuildKind.Event,
        icon: 'pi pi-sparkles',
        labelKey: 'GUILD_KIND.EVENT.LABEL',
        descriptionKey: 'GUILD_KIND.EVENT.DESC',
        nounKey: 'GUILD_KIND.EVENT.NOUN',
        namePlaceholderKey: 'GUILD_KIND.EVENT.NAME_PLACEHOLDER',
    },
];

export function guildKindMeta(kind: GuildKind | undefined): GuildKindMeta {
    return GUILD_KIND_META.find(m => m.kind === kind) ?? GUILD_KIND_META[0];
}

/**
 * Translation-key stems for the modules page. A module with no entry falls back to
 * its raw flag name, which is what an unknown-to-this-build module gets.
 */
export const GUILD_FEATURE_LABEL_KEY: Readonly<Record<string, string>> = {
    [GuildFeature.VoiceChannels]: 'GUILD_MODULE.VOICE_CHANNELS',
    [GuildFeature.Threads]: 'GUILD_MODULE.THREADS',
    [GuildFeature.Forums]: 'GUILD_MODULE.FORUMS',
    [GuildFeature.Announcements]: 'GUILD_MODULE.ANNOUNCEMENTS',
    [GuildFeature.Tickets]: 'GUILD_MODULE.TICKETS',
    [GuildFeature.Moderation]: 'GUILD_MODULE.MODERATION',
    [GuildFeature.AutoMod]: 'GUILD_MODULE.AUTOMOD',
    [GuildFeature.Onboarding]: 'GUILD_MODULE.ONBOARDING',
    [GuildFeature.Emojis]: 'GUILD_MODULE.EMOJIS',
    [GuildFeature.Bots]: 'GUILD_MODULE.BOTS',
    [GuildFeature.Wiki]: 'GUILD_MODULE.WIKI',
    [GuildFeature.Events]: 'GUILD_MODULE.EVENTS',
    [GuildFeature.Lists]: 'GUILD_MODULE.LISTS',
    [GuildFeature.Chores]: 'GUILD_MODULE.CHORES',
    [GuildFeature.Ledger]: 'GUILD_MODULE.LEDGER',
    [GuildFeature.Pantry]: 'GUILD_MODULE.PANTRY',
    [GuildFeature.Decisions]: 'GUILD_MODULE.DECISIONS',
    [GuildFeature.Presence]: 'GUILD_MODULE.PRESENCE',
    [GuildFeature.QuietHours]: 'GUILD_MODULE.QUIET_HOURS',
    [GuildFeature.GuestAccess]: 'GUILD_MODULE.GUEST_ACCESS',
    [GuildFeature.Meals]: 'GUILD_MODULE.MEALS',
    [GuildFeature.Maintenance]: 'GUILD_MODULE.MAINTENANCE',
};

/** A module's name for a reader. Unknown-to-this-build modules have no key and show their flag. */
export function guildFeatureLabelKey(module: string): string {
    const stem = GUILD_FEATURE_LABEL_KEY[module];
    return stem ? `${stem}.LABEL` : module;
}
