/** The entitlement wire shapes, from `Echo/docs/specs/entitlements-frontend-guide.md`. */

/** Bumped by the server when a code is added to any vocabulary below. Diagnostic, not a gate. */
export const ENTITLEMENT_VOCABULARY_VERSION = 1;

/** Why a request was reduced or refused: which side bound. snake_case on the wire; unknown codes must still render. */
export const ENTITLEMENT_REASON_CODES = {
    guildPlanLimit: 'guild_plan_limit',
    userPlanLimit: 'user_plan_limit',
    /** Both sides carry a ceiling and the lower won. Never arrives without `boundBy`. */
    pairedCeiling: 'paired_ceiling',
    /** The instance operator's own cap. Not a commercial limit, and never has a remedy. */
    operatorCeiling: 'operator_ceiling',
} as const;

export type EntitlementReason =
    (typeof ENTITLEMENT_REASON_CODES)[keyof typeof ENTITLEMENT_REASON_CODES] | (string & {});

/** What would fix it, which is what the button says. */
export const ENTITLEMENT_REMEDY_CODES = {
    upgradeGuild: 'upgrade_guild',
    upgradeUser: 'upgrade_user',
    /** Reserved for boosts. Nothing emits it yet, and a remedy we cannot route is not a button. */
    boostGuild: 'boost_guild',
    /** An operator ceiling, and every limit on an instance that sells nothing. */
    none: 'none',
} as const;

export type EntitlementRemedy =
    (typeof ENTITLEMENT_REMEDY_CODES)[keyof typeof ENTITLEMENT_REMEDY_CODES] | (string & {});

/** Which side of a pair bound. An operator ceiling carries no `boundBy` at all. */
export type EntitlementBoundBy = 'guild' | 'user' | (string & {});

export type EntitlementSubjectKind = 'user' | 'guild' | (string & {});

/** `selfhost` resolves every key to maximum. Branch on {@link EntitlementSnapshotDto.upgradesAvailable}, not this. */
export type LicenseMode = 'hosted' | 'selfhost' | (string & {});

/** Whose entitlements these are, echoed on everything. */
export interface EntitlementSubjectDto {
    kind: EntitlementSubjectKind;
    id: string;
}

/**
 * One entitlement value, in whichever of the three shapes its key declares. Switch on `kind` first.
 * `value` is null exactly when `unlimited` is true; the server never sends a sentinel.
 */
export type EntitlementValueDto =
    | {kind: 'numeric'; value: number | null; unlimited: boolean}
    | {kind: 'flag'; granted: boolean}
    | {kind: 'ladder'; rung: string; rank: number; ladder?: string};

/** The rung that means audio-only. A real rung on the wire, never an absence. */
export const AUDIO_ONLY_RUNG = 'none';

/** One rung, with what it actually permits. The metrics are the (resolution, framerate) mapping. */
export interface EntitlementRungDto {
    rung: string;
    rank: number;
    /** Tallest frame this rung permits, in pixels. Absent for a ladder whose rungs are not video. */
    maxHeight?: number;
    /** Highest framerate. A lower one is always allowed, on every rung above `none`. */
    maxFramerate?: number;
}

/** One reduction, riding a `200` on the body of the operation that caused it. Not an error path. */
export interface EntitlementDegradationDto {
    key: string;
    requested: EntitlementValueDto;
    granted: EntitlementValueDto;
    reason: EntitlementReason;
    /** Present for every reason but `operator_ceiling`, and mandatory for `paired_ceiling`. */
    boundBy?: EntitlementBoundBy;
    remedy: EntitlementRemedy;
    /** Whether *this* caller can perform that remedy. Never compute it here. */
    actorCanRemedy: boolean;
    /** The party the remedy applies to, so a call to action links at the right guild or account. */
    subject: EntitlementSubjectDto;
}

/**
 * A refusal that could not degrade, on a `403`. Same field names and same vocabulary as a
 * degradation, so one lookup table serves both.
 */
export interface EntitlementDenialDto {
    /** The one field name for the code, and always equal to {@link reason}. */
    code: EntitlementReason;
    key: string;
    /** Absent when what was refused has no countable ceiling, which today is an out-of-plan module. */
    requested?: EntitlementValueDto;
    granted?: EntitlementValueDto;
    reason: EntitlementReason;
    boundBy?: EntitlementBoundBy;
    remedy: EntitlementRemedy;
    actorCanRemedy: boolean;
    subject: EntitlementSubjectDto;
    /** The `GuildFeatures` name, when what was refused is a module the plan does not include. */
    feature?: string;
    /** Always false. Retrying an entitlement refusal turns one refusal into three. */
    retryable: boolean;
}

/**
 * Which plan a subject is on, by the name a settings screen can say out loud. Absent when there is
 * no plan, which is a real state; do not substitute a "Free".
 */
export interface EntitlementPlanDto {
    /** The key. Stable, and the thing to branch on. Never rendered. */
    name: string;
    /** The copy. Never null; a plan with no display name of its own reports {@link name}. */
    displayName: string;
    /**
     * The plan version this subject's limits came from. Grandfathered, so not necessarily the
     * newest on sale. Absent is not "version 0".
     */
    version?: number;
}

/** One subject's effective ceilings. Ceilings only; usage is a separate payload. */
export interface EntitlementSnapshotDto {
    licenseMode: LicenseMode;
    /** The one to branch on before drawing any upgrade affordance. */
    upgradesAvailable: boolean;
    vocabularyVersion: number;
    subject: EntitlementSubjectDto;
    resolvedAt: string;
    /** Monotonic per subject. Zero until Billing owns a counter; compare it anyway. */
    version: number;
    /** How long this may be cached. Never cache longer, and never to disk. */
    ttlSeconds: number;
    entitlements: Record<string, EntitlementValueDto>;
    /** Every ladder the keys above reference, lowest rung first. Never hardcode a copy. */
    ladders: Record<string, EntitlementRungDto[]>;
    remedy: EntitlementRemedy;
    actorCanRemedy: boolean;
    /** Which plan resolved these numbers. Absent when none did; see {@link EntitlementPlanDto}. */
    plan?: EntitlementPlanDto;
    /** This instance's own Stripe publishable key. Absent unless the operator configured one. */
    stripePublishableKey?: string;
}

/**
 * What a voice room will carry, riding the room snapshot rather than an event. Every field is
 * optional and the whole block can be absent; absent means "no limit information", not "no limits".
 */
export interface VoiceRoomLimitsDto {
    /** People in one room. */
    maxParticipants?: EntitlementValueDto;
    /** Publish quality, as a rung on `video_quality`. `none` means audio-only. */
    videoCeiling?: EntitlementValueDto;
    /** Concurrent video publishers. */
    maxPublishers?: EntitlementValueDto;
    /** How many of those slots are taken right now. Room state, not entitlement state. */
    publisherCount?: number;
}

/** What this client intends to send, stated on a publish so the server can clamp it. Optional. */
export interface VideoPublishIntentDto {
    height: number;
    framerate: number;
}

/** The realtime envelope for `entitlements.Changed`, and only an envelope. */
export interface EntitlementsChangedDto {
    subjectKind: EntitlementSubjectKind;
    subjectId: string;
    version: number;
    /** Advisory, and can be empty. Use it to skip a refetch when nothing relevant is open. */
    changedKeys?: string[];
}

/**
 * Guild feature state as three lists plus the result. `withheldByPlan` is the only list separating
 * an out-of-plan module from one the owner turned off. Names on the wire, never bitmask numbers.
 */
export interface GuildFeatureResolutionDto {
    chosen: string[];
    includedByPlan: string[];
    withheldByPlan: string[];
    effective: string[];
}

/** The catalogue keys, as named on the wire. */
export const ENTITLEMENT_KEYS = {
    voiceMaxParticipants: 'voice.max_participants',
    voiceVideoCeiling: 'voice.video_ceiling',
    voiceMaxPublishers: 'voice.max_publishers',
    storageUploadMaxBytes: 'storage.upload_max_bytes',
    storageGuildQuotaBytes: 'storage.guild_quota_bytes',
    guildEmojiSlots: 'guild.emoji_slots',
    guildBotsInstalled: 'guild.bots_installed',
    guildVanityUrl: 'guild.vanity_url',
    guildAuditLogDays: 'guild.audit_log_days',
    guildPublicListing: 'guild.public_listing',
    userUploadMaxBytes: 'user.upload_max_bytes',
    userMaxDevices: 'user.max_devices',
    /** Characters, not bytes. Read against the guild subject: the ceiling is plan-derived. */
    guildMessageMaxLength: 'guild.message_max_length',
    userMessageMaxLength: 'user.message_max_length',
} as const;

/** The ceiling to enforce, or null when there is none: unlimited, absent key, or wrong shape. */
export function numericCeiling(value: EntitlementValueDto | undefined): number | null {
    if (!value || value.kind !== 'numeric' || value.unlimited) return null;
    return value.value ?? null;
}

/** Whether a flag key is granted. False for an absent key, which is what an unbuilt capability is. */
export function isGranted(value: EntitlementValueDto | undefined): boolean {
    return value?.kind === 'flag' && value.granted;
}

/** What the granted rung permits, from the ladder the snapshot published. Null when unmapped. */
export function rungMetrics(
    ladder: EntitlementRungDto[] | undefined,
    value: EntitlementValueDto | undefined,
): {maxHeight: number; maxFramerate: number} | null {
    if (!ladder || value?.kind !== 'ladder') return null;
    const rung = ladder.find(r => r.rung === value.rung);
    if (!rung || rung.maxHeight === undefined || rung.maxFramerate === undefined) return null;
    return {maxHeight: rung.maxHeight, maxFramerate: rung.maxFramerate};
}

/** The degradations on a response, if it carried any. Absent and empty mean the same thing. */
export function degradationsOf(body: unknown): EntitlementDegradationDto[] {
    if (!body || typeof body !== 'object') return [];
    const list = (body as {degradations?: unknown}).degradations;
    return Array.isArray(list) ? (list as EntitlementDegradationDto[]) : [];
}

/** Why a module is not usable, from the three lists. */
export function moduleStandingOf(
    resolution: GuildFeatureResolutionDto | null | undefined,
    feature: string,
): 'on' | 'off' | 'withheld' | 'unknown' {
    if (!resolution) return 'unknown';
    if (resolution.effective.includes(feature)) return 'on';
    if (resolution.withheldByPlan.includes(feature)) return 'withheld';
    return 'off';
}
