import {describe, expect, it} from 'vitest';
import en from '../../assets/i18n/locales/en.json';
import {
    ENTITLEMENT_VALUE_KEYS,
    ENTITLEMENT_VALUE_TRANSLATION_KEYS,
    entitlementValueCopy,
} from './entitlement-value';

/**
 * What a comparison table is allowed to say a plan includes.
 *
 * <p>The three shapes are the entitlement snapshot's own, which is the point: one renderer for the
 * catalogue and for the limits screen means the two cannot disagree. The cases worth asserting are
 * the ones a second renderer would get wrong - the unlimited ceiling that arrives with a null
 * value, and a payload in a shape this build cannot read.</p>
 */
describe('entitlementValueCopy - the normal shapes', () => {
    it('renders a plain count with the viewer locale grouping', () => {
        const copy = entitlementValueCopy(
            'voice.max_participants', {kind: 'numeric', value: 1500, unlimited: false}, 'en');

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.count);
        expect(copy.params['count']).toBe('1,500');
    });

    it('renders a byte ceiling as a size, never as nine digits', () => {
        const copy = entitlementValueCopy(
            'storage.upload_max_bytes', {kind: 'numeric', value: 104857600, unlimited: false}, 'en');

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.size);
        expect(copy.params['size']).toBe('100 MB');
    });

    it('renders a day ceiling as days', () => {
        const copy = entitlementValueCopy(
            'guild.audit_log_days', {kind: 'numeric', value: 90, unlimited: false}, 'en');

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.days);
        expect(copy.params['count']).toBe('90');
    });

    it('renders both sides of a flag', () => {
        expect(entitlementValueCopy('guild.vanity_url', {kind: 'flag', granted: true}).key)
            .toBe(ENTITLEMENT_VALUE_KEYS.included);
        expect(entitlementValueCopy('guild.vanity_url', {kind: 'flag', granted: false}).key)
            .toBe(ENTITLEMENT_VALUE_KEYS.notIncluded);
    });

    /** The rung the server named. Inventing a resolution mapping here is a pricing decision. */
    it('renders a ladder as the rung, not as a resolution it made up', () => {
        const copy = entitlementValueCopy(
            'voice.video_ceiling', {kind: 'ladder', rung: '2160p60', rank: 6});

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.rung);
        expect(copy.params['rung']).toBe('2160p60');
    });
});

describe('entitlementValueCopy - the edges', () => {
    /** `long.MaxValue` never crosses the wire as a number, so unlimited arrives as a null value. */
    it('says unlimited without reading the null value beside it', () => {
        const copy = entitlementValueCopy(
            'guild.bots_installed', {kind: 'numeric', value: null, unlimited: true});

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.unlimited);
    });

    /** Zero is a real ceiling that means "none of this", and it is not the same as absent. */
    it('renders a zero ceiling as a zero rather than as nothing', () => {
        const copy = entitlementValueCopy(
            'guild.emoji_slots', {kind: 'numeric', value: 0, unlimited: false}, 'en');

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.count);
        expect(copy.params['count']).toBe('0');
    });

    it('rounds a size to one digit below ten and to none above it', () => {
        expect(entitlementValueCopy(
            'user.upload_max_bytes', {kind: 'numeric', value: 1610612736, unlimited: false}, 'en')
            .params['size']).toBe('1.5 GB');
        expect(entitlementValueCopy(
            'user.upload_max_bytes', {kind: 'numeric', value: 1024, unlimited: false}, 'en')
            .params['size']).toBe('1 KB');
    });

    /** A key the catalogue added after this build was made still renders in the right units. */
    it('reads units off the key suffix, so a key added later is not a nine-digit count', () => {
        const copy = entitlementValueCopy(
            'storage.archive_quota_bytes', {kind: 'numeric', value: 5368709120, unlimited: false}, 'en');

        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.size);
        expect(copy.params['size']).toBe('5 GB');
    });
});

describe('entitlementValueCopy - what it refuses to guess', () => {
    /** A blank cell says "not included", which is a claim about a plan somebody is paying for. */
    it('says absent for a key this plan does not list, rather than leaving a blank', () => {
        expect(entitlementValueCopy('voice.max_publishers', undefined).key)
            .toBe(ENTITLEMENT_VALUE_KEYS.absent);
    });

    it('says unknown for a numeric that is neither unlimited nor a number', () => {
        const copy = entitlementValueCopy(
            'voice.max_participants', {kind: 'numeric', value: null, unlimited: false});

        // Not zero. Understating a plan somebody is being asked to pay for is the worse failure.
        expect(copy.key).toBe(ENTITLEMENT_VALUE_KEYS.unknown);
    });

    it('says unknown for a shape this build has never heard of', () => {
        const future = {kind: 'quota', value: 3} as unknown as Parameters<typeof entitlementValueCopy>[1];

        expect(entitlementValueCopy('guild.something', future).key)
            .toBe(ENTITLEMENT_VALUE_KEYS.unknown);
    });
});

/**
 * The keys here are handed to `translate` as a variable, which `i18n-keys.spec.ts` cannot see: it
 * matches a literal next to the pipe. Without this assertion a missing entry renders the raw key on
 * a paying customer's comparison table with every other test green.
 */
describe('the value keys', () => {
    it('all resolve in en.json', () => {
        const strings = en as Record<string, string>;
        const missing = ENTITLEMENT_VALUE_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(ENTITLEMENT_VALUE_TRANSLATION_KEYS.length).toBeGreaterThan(5);
        expect(missing).toEqual([]);
    });
});
