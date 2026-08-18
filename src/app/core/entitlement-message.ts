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

/** What to tell the user about a limit, and what to offer them about it. */
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

/** What to offer about a limit: the button, or the sentence that stands in for one. */
export interface EntitlementRemedyCopy {
    ctaKey: string | null;
    hintKey: string | null;
}

/** The reason vocabulary. Keys must stay literal; `i18n-keys.spec.ts` cannot see a computed one. */
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
 * The "not in this plan" module empty state, per module. Keys must stay literal; `i18n-keys.spec.ts`
 * cannot see a computed one. Modules with no entry use {@link MODULE_NOT_IN_PLAN_FALLBACK}.
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

/** One display name per catalogue key. No two may resolve to the same words. */
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
    [ENTITLEMENT_KEYS.guildMessageMaxLength]: 'ENTITLEMENT.KEY.GUILD_MESSAGE_MAX_LENGTH',
    [ENTITLEMENT_KEYS.userMessageMaxLength]: 'ENTITLEMENT.KEY.USER_MESSAGE_MAX_LENGTH',
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

/** The sentence for a reason, falling back to the generic one for a code this build cannot name. */
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
 * What to offer about a remedy, from the two fields the server computed. Never compute
 * `actorCanRemedy` here; it is the server's answer.
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
        // Only for a server upgrade.
        hintKey:
            ctaKey === null && remedy === ENTITLEMENT_REMEDY_CODES.upgradeGuild
                ? ENTITLEMENT_ASK_OWNER_KEY
                : null,
    };
}

/** Turn a degradation or a denial into copy. An unknown reason suppresses the button. */
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
 * The entitlement refusal behind an HTTP error, if that is what it is. `403` only.
 *
 * @returns null when this is not an entitlement refusal, and the caller should fall back to its
 *          generic error handling.
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
    // `code` and `reason` are always equal and both present; other 403 bodies carry only one.
    if (typeof body.code !== 'string' || body.code !== body.reason) return null;

    return body as EntitlementDenialDto;
}

/** What to tell the user about an upload the server would not take. */
export function uploadFailureKey(err: unknown): string {
    const notice = describeEntitlementDenial(err);
    if (notice) return notice.messageKey;
    if (err instanceof HttpErrorResponse && err.status === 413) return 'COMPOSER.UPLOAD_TOO_LARGE';
    return 'COMPOSER.UPLOAD_FAILED';
}

function remedyCtaKey(remedy: EntitlementRemedy, actorCanRemedy: boolean): string | null {
    // No remedy the caller can act on renders as a sentence and no button.
    if (!actorCanRemedy) return null;
    return REMEDY_CTA_KEYS[remedy] ?? null;
}
