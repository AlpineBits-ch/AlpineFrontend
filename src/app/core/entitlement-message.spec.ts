import {HttpErrorResponse} from '@angular/common/http';
import {describe, expect, it} from 'vitest';
import {
    describeEntitlementDenial,
    describeEntitlementLimit,
    ENTITLEMENT_TRANSLATION_KEYS,
    entitlementKeyNameKey,
    entitlementReasonKey,
    entitlementRemedyCopy,
    MODULE_NOT_IN_PLAN_FALLBACK,
    moduleNotInPlanCopy,
    uploadFailureKey,
} from './entitlement-message';
import {EntitlementDegradationDto, EntitlementDenialDto} from '../dtos/response/entitlement.dto';

function degradation(over: Partial<EntitlementDegradationDto> = {}): EntitlementDegradationDto {
    return {
        key: 'voice.video_ceiling',
        requested: {kind: 'ladder', rung: '1080p60', rank: 4, ladder: 'video_quality'},
        granted: {kind: 'ladder', rung: '720p30', rank: 2, ladder: 'video_quality'},
        reason: 'guild_plan_limit',
        boundBy: 'guild',
        remedy: 'upgrade_guild',
        actorCanRemedy: false,
        subject: {kind: 'guild', id: 'guild-1'},
        ...over,
    };
}

function denialBody(over: Partial<EntitlementDenialDto> = {}): EntitlementDenialDto {
    return {
        code: 'guild_plan_limit',
        key: 'guild.emoji_slots',
        requested: {kind: 'numeric', value: 51, unlimited: false},
        granted: {kind: 'numeric', value: 50, unlimited: false},
        reason: 'guild_plan_limit',
        boundBy: 'guild',
        remedy: 'upgrade_guild',
        actorCanRemedy: true,
        subject: {kind: 'guild', id: 'guild-1'},
        retryable: false,
        ...over,
    };
}

describe('entitlementReasonKey', () => {
    it('names the side that bound', () => {
        expect(entitlementReasonKey('guild_plan_limit')).toBe('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
        expect(entitlementReasonKey('user_plan_limit')).toBe('ENTITLEMENT.REASON.USER_PLAN_LIMIT');
        expect(entitlementReasonKey('operator_ceiling')).toBe('ENTITLEMENT.REASON.OPERATOR_CEILING');
    });

    /** Without `boundBy` there is one sentence for two opposite facts. */
    it('splits a paired ceiling by the side that bound', () => {
        expect(entitlementReasonKey('paired_ceiling', 'guild')).toBe(
            'ENTITLEMENT.REASON.PAIRED_CEILING_GUILD',
        );
        expect(entitlementReasonKey('paired_ceiling', 'user')).toBe('ENTITLEMENT.REASON.PAIRED_CEILING_USER');
    });

    it('falls back rather than guessing which side of a pair bound', () => {
        expect(entitlementReasonKey('paired_ceiling')).toBe('ENTITLEMENT.REASON.UNKNOWN');
        expect(entitlementReasonKey('paired_ceiling', 'operator')).toBe('ENTITLEMENT.REASON.UNKNOWN');
    });

    /** A client built today will receive a code added tomorrow, and must say something honest. */
    it('falls back for a code this build has never heard of', () => {
        expect(entitlementReasonKey('trial_expired')).toBe('ENTITLEMENT.REASON.UNKNOWN');
    });
});

describe('describeEntitlementLimit', () => {
    it('offers the server upgrade to a caller who can buy it', () => {
        const notice = describeEntitlementLimit(degradation({actorCanRemedy: true}));

        expect(notice.messageKey).toBe('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
        expect(notice.ctaKey).toBe('ENTITLEMENT.CTA.UPGRADE_SERVER');
        expect(notice.hintKey).toBeNull();
    });

    /** A button that would 403 is worse than a sentence saying who to ask. */
    it('explains rather than offering a button the caller cannot press', () => {
        const notice = describeEntitlementLimit(degradation({actorCanRemedy: false}));

        expect(notice.ctaKey).toBeNull();
        expect(notice.hintKey).toBe('ENTITLEMENT.CTA.ASK_OWNER');
    });

    it('offers the account upgrade for a user-side limit', () => {
        const notice = describeEntitlementLimit(
            degradation({
                reason: 'user_plan_limit',
                boundBy: 'user',
                remedy: 'upgrade_user',
                actorCanRemedy: true,
                subject: {kind: 'user', id: 'user-1'},
            }),
        );

        expect(notice.ctaKey).toBe('ENTITLEMENT.CTA.UPGRADE_ACCOUNT');
    });

    /** Nothing that can be bought moves an operator ceiling. */
    it('draws no button for an operator ceiling', () => {
        const notice = describeEntitlementLimit(
            degradation({
                reason: 'operator_ceiling',
                boundBy: undefined,
                remedy: 'none',
                actorCanRemedy: false,
            }),
        );

        expect(notice.messageKey).toBe('ENTITLEMENT.REASON.OPERATOR_CEILING');
        expect(notice.ctaKey).toBeNull();
        expect(notice.hintKey).toBeNull();
    });

    /** A remedy this build does not understand is a remedy it should not offer. */
    it('suppresses the button for an unknown reason whatever the remedy says', () => {
        const notice = describeEntitlementLimit(
            degradation({
                reason: 'trial_expired',
                remedy: 'upgrade_guild',
                actorCanRemedy: true,
            }),
        );

        expect(notice.messageKey).toBe('ENTITLEMENT.REASON.UNKNOWN');
        expect(notice.ctaKey).toBeNull();
        expect(notice.hintKey).toBeNull();
    });

    it('suppresses the button for a remedy it does not recognise', () => {
        const notice = describeEntitlementLimit(
            degradation({
                remedy: 'trade_favours',
                actorCanRemedy: true,
            }),
        );

        expect(notice.messageKey).toBe('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
        expect(notice.ctaKey).toBeNull();
    });

    it('carries the subject so a call to action can link at the right thing', () => {
        expect(describeEntitlementLimit(degradation()).subject).toEqual({kind: 'guild', id: 'guild-1'});
    });

    it('names the module for an out-of-plan refusal', () => {
        const notice = describeEntitlementLimit(
            denialBody({
                key: 'guild.features',
                feature: 'Forums',
                requested: undefined,
                granted: undefined,
            }),
        );

        expect(notice.feature).toBe('Forums');
    });
});

describe('describeEntitlementDenial', () => {
    it('reads a 403 entitlement refusal', () => {
        const err = new HttpErrorResponse({status: 403, error: denialBody()});

        expect(describeEntitlementDenial(err)?.messageKey).toBe('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
    });

    /** A permission refusal is a different sentence, and must not render as "buy more". */
    it('ignores a 403 that is not an entitlement refusal', () => {
        const err = new HttpErrorResponse({status: 403, error: {code: 'blocked'}});

        expect(describeEntitlementDenial(err)).toBeNull();
    });

    it('ignores a body whose code and reason disagree', () => {
        const err = new HttpErrorResponse({
            status: 403,
            error: denialBody({code: 'user_plan_limit'}),
        });

        expect(describeEntitlementDenial(err)).toBeNull();
    });

    /** The server never uses 401 or 429 for this. */
    it('ignores every status but 403', () => {
        for (const status of [401, 402, 429, 500]) {
            const err = new HttpErrorResponse({status, error: denialBody()});
            expect(describeEntitlementDenial(err)).toBeNull();
        }
    });

    it('ignores something that is not an HTTP error at all', () => {
        expect(describeEntitlementDenial(new Error('offline'))).toBeNull();
        expect(describeEntitlementDenial(null)).toBeNull();
    });

    it('survives a 403 with no body', () => {
        expect(describeEntitlementDenial(new HttpErrorResponse({status: 403}))).toBeNull();
    });
});

describe('uploadFailureKey', () => {
    it('names the limit when the server named one', () => {
        const err = new HttpErrorResponse({
            status: 403,
            error: denialBody({
                key: 'storage.upload_max_bytes',
                reason: 'paired_ceiling',
                code: 'paired_ceiling',
                boundBy: 'user',
            }),
        });

        expect(uploadFailureKey(err)).toBe('ENTITLEMENT.REASON.PAIRED_CEILING_USER');
    });

    /** A 413 is the same fact one layer lower down. */
    it('distinguishes too-large from a generic failure', () => {
        expect(uploadFailureKey(new HttpErrorResponse({status: 413}))).toBe('COMPOSER.UPLOAD_TOO_LARGE');
        expect(uploadFailureKey(new HttpErrorResponse({status: 500}))).toBe('COMPOSER.UPLOAD_FAILED');
        expect(uploadFailureKey(new Error('offline'))).toBe('COMPOSER.UPLOAD_FAILED');
    });
});

describe('the key catalogue', () => {
    it('names every key the guide enumerates', () => {
        expect(entitlementKeyNameKey('voice.max_participants')).toBe(
            'ENTITLEMENT.KEY.VOICE_MAX_PARTICIPANTS',
        );
        expect(entitlementKeyNameKey('user.max_devices')).toBe('ENTITLEMENT.KEY.USER_MAX_DEVICES');
    });

    it('has no name for a key added after this build', () => {
        expect(entitlementKeyNameKey('guild.stickers')).toBeNull();
    });

    /** The export `i18n-keys.spec.ts` checks against en.json; the count is asserted too. */
    it('exports every literal key its tables can produce', () => {
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('ENTITLEMENT.REASON.UNKNOWN');
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('ENTITLEMENT.CTA.ASK_OWNER');
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('ENTITLEMENT.KEY.GUILD_VANITY_URL');
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('CHORES.NOT_IN_PLAN_TITLE');
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('GUILD_SETTINGS.MODULES.NOT_IN_PLAN_BODY');
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('ENTITLEMENT.KEY.GUILD_MESSAGE_MAX_LENGTH');
        expect(ENTITLEMENT_TRANSLATION_KEYS).toContain('ENTITLEMENT.KEY.USER_MESSAGE_MAX_LENGTH');
        expect(new Set(ENTITLEMENT_TRANSLATION_KEYS).size).toBe(ENTITLEMENT_TRANSLATION_KEYS.length);
        expect(ENTITLEMENT_TRANSLATION_KEYS.length).toBe(31);
    });
});

describe('moduleNotInPlanCopy', () => {
    it('names the module where this build has copy for it', () => {
        expect(moduleNotInPlanCopy('Chores')).toEqual({
            titleKey: 'CHORES.NOT_IN_PLAN_TITLE',
            bodyKey: 'CHORES.NOT_IN_PLAN_BODY',
        });
    });

    /** A module added after this build still has to render a sentence. */
    it('falls back for a module this build has never heard of', () => {
        expect(moduleNotInPlanCopy('Podcasts')).toBe(MODULE_NOT_IN_PLAN_FALLBACK);
    });

    /** Keys must stay literal; `i18n-keys.spec.ts` cannot see a computed one. */
    it('produces only keys the exported table covers', () => {
        for (const module of ['Chores', 'Pantry', 'Decisions', 'Podcasts']) {
            const copy = moduleNotInPlanCopy(module);
            expect(ENTITLEMENT_TRANSLATION_KEYS).toContain(copy.titleKey);
            expect(ENTITLEMENT_TRANSLATION_KEYS).toContain(copy.bodyKey);
        }
    });
});

describe('entitlementRemedyCopy', () => {
    it('offers the server upgrade to a caller who can buy it', () => {
        expect(entitlementRemedyCopy('upgrade_guild', true)).toEqual({
            ctaKey: 'ENTITLEMENT.CTA.UPGRADE_SERVER',
            hintKey: null,
        });
    });

    it('names who can act instead of offering a button that would 403', () => {
        expect(entitlementRemedyCopy('upgrade_guild', false)).toEqual({
            ctaKey: null,
            hintKey: 'ENTITLEMENT.CTA.ASK_OWNER',
        });
    });

    /** "Ask an admin" is nonsense against a limit on the reader's own account. */
    it('says nothing about asking somebody else for an account limit', () => {
        expect(entitlementRemedyCopy('upgrade_user', false)).toEqual({ctaKey: null, hintKey: null});
    });

    /** `none` is what every limit on an instance that sells nothing arrives as. */
    it('offers nothing where there is nothing to buy', () => {
        expect(entitlementRemedyCopy('none', false)).toEqual({ctaKey: null, hintKey: null});
    });

    it('offers nothing at all while no set is held', () => {
        expect(entitlementRemedyCopy(undefined, false)).toEqual({ctaKey: null, hintKey: null});
    });

    /** A remedy this build does not understand is a remedy it should not offer. */
    it('suppresses everything for a reason it could not read', () => {
        expect(entitlementRemedyCopy('upgrade_guild', true, false)).toEqual({ctaKey: null, hintKey: null});
    });
});
