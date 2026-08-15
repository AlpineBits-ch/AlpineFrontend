import {HttpErrorResponse} from '@angular/common/http';
import {
    ENTITLEMENT_KEYS,
    ENTITLEMENT_REASON_CODES,
    ENTITLEMENT_REMEDY_CODES,
    EntitlementBoundBy,
    EntitlementDegradationDto,
    EntitlementDenialDto,
    EntitlementReason,
    EntitlementRemedy,
    EntitlementSubjectDto,
} from '../dtos/response/entitlement.dto';

/**
 * What to tell the user about a limit, and what - if anything - to offer them about it.
 *
 * <p>Four fields answer four different questions and none of them is derived from another. See
 * `Echo/docs/specs/entitlements-frontend-guide.md` section 3.1: the server computes which side
 * bound, which side of a pair it was, what would fix it, and whether this caller can do that, and
 * the client cannot answer the last three without re-implementing permission evaluation and knowing
 * whether the instance sells anything at all.</p>
 */
export interface EntitlementNotice {
    /** The sentence. Always a literal key from the tables below, never a computed one. */
    messageKey: string;
    /** The button, or null when there must not be one. */
    ctaKey: string | null;
    /** What to say instead of a button when somebody else is the one who can fix it. */
    hintKey: string | null;
    /** The party the remedy applies to, so a call to action links at the right thing. */
    subject: EntitlementSubjectDto | null;
    /** The `GuildFeatures` name, when what was refused is a module the plan does not include. */
    feature: string | null;
    retryable: boolean;
}

/** The two sentences a module empty state needs, as literal keys. */
export interface EntitlementModuleCopy {
    titleKey: string;
    bodyKey: string;
}

/**
 * What to offer about a limit: the button, or the sentence that stands in for one.
 *
 * <p>Both may be null, and that is the common answer - `remedy: "none"` on every instance that
 * sells nothing, which includes every self-hosted one.</p>
 */
export interface EntitlementRemedyCopy {
    ctaKey: string | null;
    hintKey: string | null;
}

/**
 * The reason vocabulary, as literal translation keys.
 *
 * <p><b>Literal on purpose.</b> `'ENTITLEMENT.REASON.' + code` would render raw to a user with every
 * test green: `i18n-keys.spec.ts` matches a literal followed by `| translate` and a computed key
 * matches nothing at all. `entitlement-message.spec.ts` asserts every entry in these tables resolves
 * in `en.json`, which is the guard the pipe cannot be.</p>
 *
 * <p>`paired_ceiling` is not here. It splits into two sentences driven by `boundBy`, which is the
 * cheapest possible proof that the field is needed - without it a paying member is eventually told
 * their own plan limited them, the exact error the paired rule exists to prevent.</p>
 */
const REASON_KEYS: Record<string, string> = {
    [ENTITLEMENT_REASON_CODES.guildPlanLimit]: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
    [ENTITLEMENT_REASON_CODES.userPlanLimit]: 'ENTITLEMENT.REASON.USER_PLAN_LIMIT',
    [ENTITLEMENT_REASON_CODES.operatorCeiling]: 'ENTITLEMENT.REASON.OPERATOR_CEILING',
};

const PAIRED_CEILING_KEYS: Record<string, string> = {
    guild: 'ENTITLEMENT.REASON.PAIRED_CEILING_GUILD',
    user: 'ENTITLEMENT.REASON.PAIRED_CEILING_USER',
};

/** What a client built before a code existed says about it. A raw code is never rendered. */
export const ENTITLEMENT_UNKNOWN_REASON_KEY = 'ENTITLEMENT.REASON.UNKNOWN';

const REMEDY_CTA_KEYS: Record<string, string> = {
    [ENTITLEMENT_REMEDY_CODES.upgradeGuild]: 'ENTITLEMENT.CTA.UPGRADE_SERVER',
    [ENTITLEMENT_REMEDY_CODES.upgradeUser]: 'ENTITLEMENT.CTA.UPGRADE_ACCOUNT',
};

/** Rendered in place of the button when the remedy is a server upgrade this caller cannot buy. */
export const ENTITLEMENT_ASK_OWNER_KEY = 'ENTITLEMENT.CTA.ASK_OWNER';

/** The neutral secondary action, for a surface that has somewhere to send a reader. */
export const ENTITLEMENT_LEARN_MORE_KEY = 'ENTITLEMENT.CTA.LEARN_MORE';

/**
 * The third module empty state, as literal keys per module.
 *
 * <p>"The owner turned Forums off" and "Forums is not in this plan" are the same absence from
 * `effective` and different sentences, and only one of them has an upgrade next to it. The
 * owner-turned-it-off copy already exists per module as `<MODULE>.MODULE_OFF_*`; this is its
 * counterpart.</p>
 *
 * <p><b>Literal, like every other table in this file.</b> `` `${module}.NOT_IN_PLAN_TITLE` `` is
 * the obvious spelling and is exactly what `i18n-keys.spec.ts` cannot see - it would render raw to
 * a user with every test green. Modules with no entry fall back to
 * {@link MODULE_NOT_IN_PLAN_FALLBACK}, which is written to be true of any module rather than
 * pretending this build knows what the module is.</p>
 */
const MODULE_NOT_IN_PLAN_KEYS: Record<string, EntitlementModuleCopy> = {
    Chores: {titleKey: 'CHORES.NOT_IN_PLAN_TITLE', bodyKey: 'CHORES.NOT_IN_PLAN_BODY'},
    Pantry: {titleKey: 'PANTRY.NOT_IN_PLAN_TITLE', bodyKey: 'PANTRY.NOT_IN_PLAN_BODY'},
    Decisions: {titleKey: 'DECISIONS.NOT_IN_PLAN_TITLE', bodyKey: 'DECISIONS.NOT_IN_PLAN_BODY'},
};

/** The module-agnostic version, and what an unknown-to-this-build module gets. */
export const MODULE_NOT_IN_PLAN_FALLBACK: EntitlementModuleCopy = {
    titleKey: 'GUILD_SETTINGS.MODULES.NOT_IN_PLAN_TITLE',
    bodyKey: 'GUILD_SETTINGS.MODULES.NOT_IN_PLAN_BODY',
};

/**
 * One display name per catalogue key, so a limit can be named without switching on eleven strings.
 *
 * <p><b>No two of these may resolve to the same words.</b> The comparison table draws one row per
 * key, so a shared label is two rows a reader cannot tell apart - and they do not stay equal:
 * `storage.upload_max_bytes` is a paired ceiling on uploads into a guild while
 * `user.upload_max_bytes` is the user-scoped one for direct messages and avatars, and they showed
 * the same figure only because the plan seed happened to set both to the same bytes. Exported so
 * `i18n-keys.spec.ts` can assert the labels are distinct, because the day the two values diverge is
 * the day the duplicate becomes actively misleading rather than merely redundant.</p>
 */
export const ENTITLEMENT_KEY_NAME_KEYS: Record<string, string> = {
    [ENTITLEMENT_KEYS.voiceMaxParticipants]: 'ENTITLEMENT.KEY.VOICE_MAX_PARTICIPANTS',
    [ENTITLEMENT_KEYS.voiceVideoCeiling]: 'ENTITLEMENT.KEY.VOICE_VIDEO_CEILING',
    [ENTITLEMENT_KEYS.voiceMaxPublishers]: 'ENTITLEMENT.KEY.VOICE_MAX_PUBLISHERS',
    [ENTITLEMENT_KEYS.storageUploadMaxBytes]: 'ENTITLEMENT.KEY.STORAGE_UPLOAD_MAX_BYTES',
    [ENTITLEMENT_KEYS.storageGuildQuotaBytes]: 'ENTITLEMENT.KEY.STORAGE_GUILD_QUOTA_BYTES',
    [ENTITLEMENT_KEYS.guildEmojiSlots]: 'ENTITLEMENT.KEY.GUILD_EMOJI_SLOTS',
    [ENTITLEMENT_KEYS.guildBotsInstalled]: 'ENTITLEMENT.KEY.GUILD_BOTS_INSTALLED',
    [ENTITLEMENT_KEYS.guildVanityUrl]: 'ENTITLEMENT.KEY.GUILD_VANITY_URL',
    [ENTITLEMENT_KEYS.guildAuditLogDays]: 'ENTITLEMENT.KEY.GUILD_AUDIT_LOG_DAYS',
    [ENTITLEMENT_KEYS.userUploadMaxBytes]: 'ENTITLEMENT.KEY.USER_UPLOAD_MAX_BYTES',
    [ENTITLEMENT_KEYS.userMaxDevices]: 'ENTITLEMENT.KEY.USER_MAX_DEVICES',
};

/** Every literal key these tables can produce, for the spec that checks they all resolve. */
export const ENTITLEMENT_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(REASON_KEYS),
    ...Object.values(PAIRED_CEILING_KEYS),
    ...Object.values(REMEDY_CTA_KEYS),
    ...Object.values(ENTITLEMENT_KEY_NAME_KEYS),
    ...Object.values(MODULE_NOT_IN_PLAN_KEYS).flatMap(copy => [copy.titleKey, copy.bodyKey]),
    MODULE_NOT_IN_PLAN_FALLBACK.titleKey,
    MODULE_NOT_IN_PLAN_FALLBACK.bodyKey,
    ENTITLEMENT_UNKNOWN_REASON_KEY,
    ENTITLEMENT_ASK_OWNER_KEY,
    ENTITLEMENT_LEARN_MORE_KEY,
];

/**
 * The sentence for a reason, with the mandated fallback for one this build has never heard of.
 *
 * <p>An unrecognised reason, an unrecognised `boundBy`, and a `paired_ceiling` that arrived without
 * one all land on the generic sentence. There is no honest alternative: the copy is the client's,
 * so a code with no copy has no rendering, and guessing between "your account" and "this server" is
 * the one mistake the paired vocabulary exists to make impossible.</p>
 */
export function entitlementReasonKey(reason: EntitlementReason, boundBy?: EntitlementBoundBy): string {
    if (reason === ENTITLEMENT_REASON_CODES.pairedCeiling) {
        return (boundBy && PAIRED_CEILING_KEYS[boundBy]) ?? ENTITLEMENT_UNKNOWN_REASON_KEY;
    }
    return REASON_KEYS[reason] ?? ENTITLEMENT_UNKNOWN_REASON_KEY;
}

/** The display name for a catalogue key, or null for a key this build does not know. */
export function entitlementKeyNameKey(key: string): string | null {
    return ENTITLEMENT_KEY_NAME_KEYS[key] ?? null;
}

/** The "not in this plan" copy for a module, falling back to the module-agnostic pair. */
export function moduleNotInPlanCopy(feature: string): EntitlementModuleCopy {
    return MODULE_NOT_IN_PLAN_KEYS[feature] ?? MODULE_NOT_IN_PLAN_FALLBACK;
}

/**
 * What to offer about a remedy, from the two fields the server computed.
 *
 * <p>The pair a snapshot carries is the same pair a degradation carries (guide section 5.1), which
 * is why the upgrade prompt on a settings screen and the one in a degradation banner come from this
 * one function. <b>Never compute `actorCanRemedy`</b>: re-implementing ManageGuild here is how a
 * buy button that 403s gets drawn.</p>
 *
 * @param understood false when the reason behind this remedy is a code this build has never heard
 *        of, which suppresses the button whatever the remedy says.
 */
export function entitlementRemedyCopy(
    remedy: EntitlementRemedy | null | undefined,
    actorCanRemedy: boolean,
    understood = true,
): EntitlementRemedyCopy {
    if (!understood || remedy == null) return {ctaKey: null, hintKey: null};

    const ctaKey = remedyCtaKey(remedy, actorCanRemedy);
    return {
        ctaKey,
        // Only for a server upgrade. "Ask an admin" is nonsense against a limit on the reader's own
        // account, and against an operator ceiling nobody can move it at all.
        hintKey: ctaKey === null && remedy === ENTITLEMENT_REMEDY_CODES.upgradeGuild
            ? ENTITLEMENT_ASK_OWNER_KEY
            : null,
    };
}

/**
 * Turn a degradation or a denial into copy.
 *
 * <p>One function for both because they carry the same fields and the same codes: writing the
 * sentence twice is how the two drift. The only asymmetry is `retryable`, which a denial states and
 * a degradation has no use for - it succeeded.</p>
 *
 * <p><b>An unknown reason suppresses the button, whatever `remedy` says.</b> A remedy this build
 * does not understand is a remedy it should not offer, and the same goes for an unrecognised remedy
 * against a reason it does know.</p>
 */
export function describeEntitlementLimit(
    limit: EntitlementDegradationDto | EntitlementDenialDto,
): EntitlementNotice {
    const messageKey = entitlementReasonKey(limit.reason, limit.boundBy);
    const understood = messageKey !== ENTITLEMENT_UNKNOWN_REASON_KEY;
    const {ctaKey, hintKey} = entitlementRemedyCopy(limit.remedy, limit.actorCanRemedy, understood);

    return {
        messageKey,
        ctaKey,
        hintKey,
        subject: limit.subject ?? null,
        feature: ('feature' in limit ? limit.feature : undefined) ?? null,
        retryable: 'retryable' in limit ? limit.retryable === true : false,
    };
}

/**
 * The entitlement refusal behind an HTTP error, if that is what it is.
 *
 * <p>`403` and no other status. `429` is retried three times by the rate-limit interceptor with the
 * body long gone by the time anything reads it, and `401` signs the user out - which is why the
 * server never uses either for this, and why looking for one here would be looking for something
 * that cannot arrive.</p>
 *
 * @returns null when this is not an entitlement refusal, and the caller should fall back to its
 *          generic error handling. A permission refusal carries its own codes and lands here as
 *          null, which is what keeps "you cannot see this" from rendering as "buy more".
 */
export function describeEntitlementDenial(err: unknown): EntitlementNotice | null {
    const denial = entitlementDenialOf(err);
    return denial ? describeEntitlementLimit(denial) : null;
}

/** The parsed denial body, for a caller that needs the numbers rather than the sentence. */
export function entitlementDenialOf(err: unknown): EntitlementDenialDto | null {
    if (!(err instanceof HttpErrorResponse) || err.status !== 403) return null;

    const body = err.error as Partial<EntitlementDenialDto> | null | undefined;
    if (!body || typeof body !== 'object') return null;
    // `code` and `reason` are always equal and both are always present. Requiring the pair is what
    // separates this from the several other 403 bodies in the API that carry only one of them.
    if (typeof body.code !== 'string' || body.code !== body.reason) return null;

    return body as EntitlementDenialDto;
}

/**
 * What to tell the user about an upload the server would not take.
 *
 * <p>A `413` is the same fact as an entitlement refusal arriving one layer lower down, and the
 * sentence is the same one. Anything else is the generic failure, which is all the composer could
 * ever say before: one toast that could not tell "too large" from "the network died".</p>
 */
export function uploadFailureKey(err: unknown): string {
    const notice = describeEntitlementDenial(err);
    if (notice) return notice.messageKey;
    if (err instanceof HttpErrorResponse && err.status === 413) return 'COMPOSER.UPLOAD_TOO_LARGE';
    return 'COMPOSER.UPLOAD_FAILED';
}

function remedyCtaKey(remedy: EntitlementRemedy, actorCanRemedy: boolean): string | null {
    // The server sends `none` for an operator ceiling and for every limit on an instance that sells
    // nothing, which includes every self-hosted one. Both must render as a sentence and no button.
    if (!actorCanRemedy) return null;
    return REMEDY_CTA_KEYS[remedy] ?? null;
}
