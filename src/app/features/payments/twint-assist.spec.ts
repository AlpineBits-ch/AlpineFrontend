import {describe, expect, it} from 'vitest';
import {
    canOfferTwintAssist,
    formatSwissPhoneNumber,
    normalizeSwissPhoneNumber,
    TWINT_CONFIRM_NAME_ADVICE,
} from './twint-assist';

describe('normalizeSwissPhoneNumber', () => {
    it('accepts the three ways a Swiss number gets written', () => {
        for (const written of ['079 123 45 67', '+41 79 123 45 67', '0041 79 123 45 67',
            '079/123 45 67', '+41791234567']) {
            expect(normalizeSwissPhoneNumber(written)).toBe('+41791234567');
        }
    });

    it('rejects something that is not a Swiss subscriber number', () => {
        expect(normalizeSwissPhoneNumber('12345')).toBeNull();
        expect(normalizeSwissPhoneNumber('+49 30 12345678')).toBeNull();
        expect(normalizeSwissPhoneNumber('')).toBeNull();
        expect(normalizeSwissPhoneNumber('not a number')).toBeNull();
    });

    it('is idempotent, so the stored form survives being normalised again', () => {
        expect(normalizeSwissPhoneNumber('+41791234567')).toBe('+41791234567');
    });
});

describe('formatSwissPhoneNumber', () => {
    it('groups the number the way it is read aloud and checked', () => {
        expect(formatSwissPhoneNumber('+41791234567')).toBe('+41 79 123 45 67');
    });

    it('returns anything it does not recognise unchanged rather than mangling it', () => {
        expect(formatSwissPhoneNumber('+49301234567')).toBe('+49301234567');
    });
});

describe('canOfferTwintAssist', () => {
    it('is true only when there is a number to show', () => {
        expect(canOfferTwintAssist('079 123 45 67')).toBe(true);
        expect(canOfferTwintAssist(null)).toBe(false);
        expect(canOfferTwintAssist(undefined)).toBe(false);
        expect(canOfferTwintAssist('  ')).toBe(false);
    });
});

describe('TWINT_CONFIRM_NAME_ADVICE', () => {
    /**
     * The number is not SMS-verified - there is no SMS budget, so nothing proves it belongs to the
     * person who typed it. The check that actually catches a typo is the one TWINT already does:
     * it shows the recipient's name once a number is entered. Our copy has to point at that and
     * must never imply we established anything.
     */
    it('tells the payer to check the name TWINT shows', () => {
        expect(TWINT_CONFIRM_NAME_ADVICE).toContain('name');
        expect(TWINT_CONFIRM_NAME_ADVICE.toLowerCase()).toContain('twint shows');
    });

    it('never claims the number is verified or confirmed by us', () => {
        expect(TWINT_CONFIRM_NAME_ADVICE.toLowerCase()).not.toMatch(/\bverified\b/);
        expect(TWINT_CONFIRM_NAME_ADVICE.toLowerCase()).toContain('nothing in this app has confirmed');
    });
});
