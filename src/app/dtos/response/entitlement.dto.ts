/**
 * The entitlement wire shapes, from `Echo/docs/specs/entitlements-frontend-guide.md`.
 *
 * <p>The authoritative definitions are `Echo.Entitlements/Wire/*.cs`. Everything here mirrors them
 * and nothing here infers: which side bound, what would fix it and whether this caller can do that
 * are four separate server-computed fields, and deriving any of them on this side is how a client
 * ends up drawing a buy button that 403s.</p>
 */

/**
 * Bumped by the server when a code is added to any vocabulary below. Diagnostic rather than a gate -
 * a client must render on a version it does not know, using the unknown-code fallback.
 */
export const ENTITLEMENT_VOCABULARY_VERSION = 1;

/**
 * Why a request was reduced or refused: which side bound. Deliberately not the same question as who
 * can fix it, which is {@link EntitlementRemedy}.
 *
 * <p>snake_case on the wire, matching `PRIVACY_REFUSAL_CODES`. The set is closed and versioned -
 * every code is a translation key in three clients and four locale files - but the type is open
 * because a client built today will eventually receive a code added tomorrow, and the rule for that
 * is a generic sentence with no button, not a crash.</p>
 */
export const ENTITLEMENT_REASON_CODES = {
    guildPlanLimit: 'guild_plan_limit',
    userPlanLimit: 'user_plan_limit',
    /** Both sides carry a ceiling and the lower won. Never arrives without `boundBy`. */
    pairedCeiling: 'paired_ceiling',
    /** The instance operator's own cap. Not a commercial limit, and never has a remedy. */
    operatorCeiling: 'operator_ceiling',
} as const;

export type EntitlementReason =
    | typeof ENTITLEMENT_REASON_CODES[keyof typeof ENTITLEMENT_REASON_CODES]
    | (string & {});

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
    | typeof ENTITLEMENT_REMEDY_CODES[keyof typeof ENTITLEMENT_REMEDY_CODES]
    | (string & {});

/**
 * Which side of a pair bound. Two values and no third: an operator ceiling is not a party anybody
 * can upgrade, so it carries no `boundBy` at all.
 */
export type EntitlementBoundBy = 'guild' | 'user' | (string & {});

export type EntitlementSubjectKind = 'user' | 'guild' | (string & {});

/**
 * `selfhost` has no billing service deployed at all and every key resolves to maximum. Read
 * {@link EntitlementSnapshotDto.upgradesAvailable} rather than this to decide whether to draw an
 * upgrade affordance - a hosted instance with billing not yet configured is a supported state and
 * looks like `hosted` here.
 */
export type LicenseMode = 'hosted' | 'selfhost' | (string & {});

/**
 * Whose entitlements these are, echoed on everything.
 *
 * <p>Not decoration: this client switches instance and account at runtime, so a response that does
 * not say what it is about gets filed against whatever the user has since switched to.</p>
 */
export interface EntitlementSubjectDto {
    kind: EntitlementSubjectKind;
    id: string;
}

/**
 * One entitlement value, in whichever of the three shapes its key declares. Switch on `kind` before
 * reading anything else, and read `unlimited` before `value`.
 *
 * <p>`value` is null exactly when `unlimited` is true, written explicitly so that "no ceiling" and
 * "the server forgot the field" are different bytes. The server never sends a sentinel: internally
 * unlimited is `long.MaxValue`, which is larger than `Number.MAX_SAFE_INTEGER` and would be
 * silently corrupted here.</p>
 */
export type EntitlementValueDto =
    | {kind: 'numeric'; value: number | null; unlimited: boolean}
    | {kind: 'flag'; granted: boolean}
    | {kind: 'ladder'; rung: string; rank: number; ladder?: string};

/** One rung, with what it actually permits. The metrics are the (resolution, framerate) mapping. */
export interface EntitlementRungDto {
    rung: string;
    rank: number;
    /** Tallest frame this rung permits, in pixels. Absent for a ladder whose rungs are not video. */
    maxHeight?: number;
    /** Highest framerate. A lower one is always allowed, on every rung above `none`. */
    maxFramerate?: number;
}

/**
 * One reduction, riding a `200` on the body of the operation that caused it.
 *
 * <p>A degradation is a success. Nothing here is an error path: the action worked and produced less
 * than it was asked for, and rolling back on one turns "degrade, do not deny" into a denial with
 * extra steps.</p>
 */
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
 * Which plan a subject is on, by the name a settings screen can say out loud.
 *
 * <p>The whole object is <b>absent</b> when there is no plan, and that is a real state rather than
 * a gap: an instance with no plans configured resolves every key to its catalogue default, and a
 * `selfhost` instance resolves everything to maximum with no billing service deployed. Do not
 * substitute a "Free" - nobody configured one, and inventing it puts a tier boundary on the screen
 * of a self-hoster who is not being charged for anything.</p>
 */
export interface EntitlementPlanDto {
    /** The key. Stable, and the thing to branch on. Never rendered. */
    name: string;
    /** The copy. Never null - a plan with no display name of its own reports {@link name}. */
    displayName: string;
    /**
     * The version of the plan this subject resolves against.
     *
     * <p>Plans are grandfathered: a subject who bought version 2 keeps version 2's numbers when the
     * plan's numbers move, so this is the version their limits actually came from and not
     * necessarily the newest one on sale. Absent when the instance publishes no versioned entries
     * for the plan at all, which is every instance whose plans are configuration rather than rows -
     * absent is not "version 0".</p>
     *
     * <p><b>The snapshot does not say which version is current</b>, so this client cannot tell a
     * pinned subject from one on the newest version. It renders the number and what being on it
     * means; see `PlanPanelComponent`.</p>
     */
    version?: number;
}

/**
 * One subject's effective ceilings. Ceilings only: how much of one has been used is a separate
 * payload with opposite caching properties (guide section 6, not built server-side yet).
 */
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
    /**
     * Which plan resolved these numbers. Absent when none did - see {@link EntitlementPlanDto}.
     */
    plan?: EntitlementPlanDto;
    /**
     * This instance's own Stripe publishable key, when it has one.
     *
     * <p>Absent unless the operator configured one, which is the normal case, and read here rather
     * than from a second endpoint because this payload is already the one a client reads before it
     * draws any billing surface. It has to come from the instance: a key compiled into the build
     * belongs to one Stripe account, and this client is pointed at arbitrary instances at runtime.
     * The environment value is the development fallback.</p>
     */
    stripePublishableKey?: string;
}

/** The realtime envelope, and only an envelope - `entitlements.Changed`. */
export interface EntitlementsChangedDto {
    subjectKind: EntitlementSubjectKind;
    subjectId: string;
    version: number;
    /** Advisory, and can be empty. Use it to skip a refetch when nothing relevant is open. */
    changedKeys?: string[];
}

/**
 * Guild feature state as three lists plus the result, rather than one.
 *
 * <p><b>`withheldByPlan` is the upgrade prompt</b> - "the owner asked for this and is not getting
 * it" - and it is the only list that distinguishes an out-of-plan module from one the owner turned
 * off. Deriving it from `effective` is exactly what the three lists exist to stop.</p>
 *
 * <p>Names, never numbers: the underlying representation is a bitmask and an unconstrained plan is
 * all bits set, which would cross the wire as a nonsense-looking 18446744073709551615. Unknown names
 * survive a round trip, so do not filter to the ones this build recognises.</p>
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
    userUploadMaxBytes: 'user.upload_max_bytes',
    userMaxDevices: 'user.max_devices',
} as const;

/**
 * The ceiling to enforce, or null when there is none to enforce.
 *
 * <p>Null covers three cases that a caller has to treat identically anyway: the key is unlimited,
 * the key is absent from this subject's set, and the value arrived in a shape this key does not
 * declare. A client-side check is a courtesy, not the enforcement, so "no number to check against"
 * has to mean "let it through and let the server answer".</p>
 */
export function numericCeiling(value: EntitlementValueDto | undefined): number | null {
    if (!value || value.kind !== 'numeric' || value.unlimited) return null;
    return value.value ?? null;
}

/** Whether a flag key is granted. False for an absent key, which is what an unbuilt capability is. */
export function isGranted(value: EntitlementValueDto | undefined): boolean {
    return value?.kind === 'flag' && value.granted;
}

/**
 * What the granted rung permits, from the ladder the snapshot published.
 *
 * <p>Null when the rung is not on the ladder or carries no metrics, and the caller then clamps
 * nothing: inventing the mapping from a picker's (resolution, framerate) to a rung is a pricing
 * decision, and one made in a `.ts` file is one nobody can change later.</p>
 */
export function rungMetrics(
    ladder: EntitlementRungDto[] | undefined,
    value: EntitlementValueDto | undefined,
): {maxHeight: number; maxFramerate: number} | null {
    if (!ladder || value?.kind !== 'ladder') return null;
    const rung = ladder.find(r => r.rung === value.rung);
    if (!rung || rung.maxHeight === undefined || rung.maxFramerate === undefined) return null;
    return {maxHeight: rung.maxHeight, maxFramerate: rung.maxFramerate};
}

/**
 * The degradations on a response, if it carried any.
 *
 * <p>Absent and empty mean the same thing, and both are the normal case. A response with nothing
 * reduced is byte-identical to what a v1 client already receives, which is the whole reason this is
 * safe to read off responses that are years old.</p>
 */
export function degradationsOf(body: unknown): EntitlementDegradationDto[] {
    if (!body || typeof body !== 'object') return [];
    const list = (body as {degradations?: unknown}).degradations;
    return Array.isArray(list) ? list as EntitlementDegradationDto[] : [];
}

/**
 * Why a module is not usable, from the three lists.
 *
 * <p>Three answers, not two. "The owner turned it off" and "the plan does not include it" are
 * different sentences and only one of them has an upgrade next to it, and neither is the third one -
 * "you cannot see this" - which arrives as a permission refusal at the call site rather than here.
 * </p>
 */
export function moduleStandingOf(
    resolution: GuildFeatureResolutionDto | null | undefined,
    feature: string,
): 'on' | 'off' | 'withheld' | 'unknown' {
    if (!resolution) return 'unknown';
    if (resolution.effective.includes(feature)) return 'on';
    if (resolution.withheldByPlan.includes(feature)) return 'withheld';
    return 'off';
}
