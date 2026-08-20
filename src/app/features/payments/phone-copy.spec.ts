import {describe, expect, it} from 'vitest';
import en from '../../../assets/i18n/locales/en.json';
import {E164_PROBLEMS, e164ProblemKey} from '../../models/e164-phone';
import {TWINT_CONFIRM_NAME_ADVICE} from './twint-assist';

/** Guards on the phone-number copy, because the wording is the feature here. */
const COPY = en as Record<string, string>;

/** Every string that talks about the phone number, wherever it lives. */
const PHONE_KEYS = Object.keys(COPY).filter(
    key =>
        key.startsWith('PAY.PHONE.') ||
        key.startsWith('PAY.SHEET.PHONE_') ||
        key.startsWith('ACCOUNT.PHONE.') ||
        key === 'PAY.SHEET.TWINT_TITLE',
);

/** The account field, which is the only one of the three that writes anything. */
const ACCOUNT_KEYS = Object.keys(COPY).filter(key => key.startsWith('ACCOUNT.PHONE.'));

describe('phone-number copy', () => {
    it('has all of it', () => {
        // A missing key renders as the key itself, which on this card would be a raw
        // `PAY.PHONE.PLAINTEXT` where the sentence explaining the privacy difference should be.
        for (const key of [
            'PAY.PHONE.TITLE',
            'PAY.PHONE.SUBTITLE',
            'PAY.PHONE.PLAINTEXT',
            'PAY.PHONE.UNVERIFIED',
            'PAY.PHONE.SHARED_NOW',
            'PAY.PHONE.ACCOUNT_HAS_NONE',
            'PAY.PHONE.ACCOUNT_LINK',
            'PAY.PHONE.FAILED',
            'PAY.SHEET.PHONE_TITLE',
            'PAY.SHEET.PHONE_NOT_SWISS',
            'PAY.SHEET.PHONE_PLAINTEXT',
            'PAY.SHEET.PHONE_ENTERED',
            'ACCOUNT.PHONE.TITLE',
            'ACCOUNT.PHONE.PLACEHOLDER',
            'ACCOUNT.PHONE.FORMAT_HELP',
            'ACCOUNT.PHONE.PLAINTEXT',
            'ACCOUNT.PHONE.UNVERIFIED',
            'ACCOUNT.PHONE.NONE',
            'ACCOUNT.PHONE.SAVE',
            'ACCOUNT.PHONE.SAVED',
            'ACCOUNT.PHONE.SAVE_FAILED',
            'ACCOUNT.PHONE.REMOVE',
            'ACCOUNT.PHONE.REMOVE_NOTE',
            'ACCOUNT.PHONE.REMOVED',
            'ACCOUNT.PHONE.REMOVE_FAILED',
        ]) {
            expect(COPY[key], key).toBeTruthy();
        }
    });

    it('never calls a number verified, confirmed or checked', () => {
        for (const key of PHONE_KEYS) {
            expect(COPY[key].toLowerCase(), key).not.toMatch(
                /\b(verified|confirmed|validated|authenticated)\b/,
            );
        }
    });

    it('does not reach for a longer form of those words either', () => {
        // The stems, because "we will verify this" and "pending verification" are the sentences a
        // future SMS feature would arrive with, and there is still no SMS step to back them.
        for (const key of PHONE_KEYS) {
            expect(COPY[key].toLowerCase(), key).not.toMatch(/verif|confirmat|validat|authenticat/);
        }
    });

    it('says outright that nothing has checked the number', () => {
        // The absence of a "verified" badge is not the same as saying so. All three screens - the
        // person sharing, the person about to send money, and the person typing it in - are told
        // explicitly.
        expect(COPY['PAY.PHONE.UNVERIFIED'].toLowerCase()).toContain('nothing has checked');
        expect(COPY['PAY.SHEET.PHONE_ENTERED'].toLowerCase()).toContain('nothing has checked');
        expect(COPY['ACCOUNT.PHONE.UNVERIFIED'].toLowerCase()).toContain('nothing has checked');
    });

    it('never asserts that somebody has a number they have not shown', () => {
        // "Anna hasn't shared her number" is the sentence this rules out. The server cannot tell us
        // whether she has one, so no string may imply the answer either way.
        for (const key of PHONE_KEYS) {
            expect(COPY[key].toLowerCase(), key).not.toMatch(/(has|have)(n't| not) shared/);
        }
    });

    it('keeps the plaintext and ciphertext distinction visible on all three screens', () => {
        // The lists are separate in the response on purpose. If the copy stops drawing the line,
        // merging them in the UI becomes the obvious next tidy-up and nothing stops it. The account
        // field says it too, because that is where somebody first decides to hand a number over.
        expect(COPY['PAY.PHONE.PLAINTEXT'].toLowerCase()).toContain('not encrypted');
        expect(COPY['PAY.PHONE.PLAINTEXT'].toLowerCase()).toContain('plain text');
        expect(COPY['PAY.SHEET.PHONE_PLAINTEXT'].toLowerCase()).toContain('plain text');
        expect(COPY['ACCOUNT.PHONE.PLAINTEXT'].toLowerCase()).toContain('plain text');
        expect(COPY['ACCOUNT.PHONE.PLAINTEXT'].toLowerCase()).toContain('not encrypted');
        expect(COPY['ACCOUNT.PHONE.PLAINTEXT'].toLowerCase()).toContain('server can read');
    });

    it('says the sharing is for this household rather than everywhere', () => {
        // Per guild is the point of the design: a number entered once must not follow the account
        // into every server it joins.
        expect(COPY['PAY.PHONE.TITLE'].toLowerCase()).toContain('this house');
    });

    it('explains the + rather than offering to guess at a dialling plan', () => {
        // The server refuses a leading 00 instead of rewriting it, because that rewrite silently
        // produces a stranger's number in some countries. The field has to carry the reason, or the
        // refusal reads as pedantry and somebody "fixes" it by rewriting client-side.
        const help = COPY['ACCOUNT.PHONE.FORMAT_HELP'].toLowerCase();
        expect(help).toContain('+');
        expect(help).toContain('country code');
        expect(help).toContain('00');

        expect(COPY['ACCOUNT.PHONE.PROBLEM.NO_PLUS']).toContain('+');
        expect(COPY['ACCOUNT.PHONE.PLACEHOLDER']).toMatch(/^\+/);
    });

    it('has a sentence behind every reason a number can be refused', () => {
        // A missing one renders the raw key under the input, which is where the user is already
        // confused. Built from the enum so a new member cannot ship without copy.
        for (const problem of E164_PROBLEMS) {
            const key = e164ProblemKey(problem);
            expect(COPY[key], key).toBeTruthy();
            // "Invalid phone number" is the failure mode here: every one of these names what to do.
            expect(COPY[key].toLowerCase(), key).not.toMatch(/^invalid\b/);
        }
    });

    it('makes removing the number an offer, not a footnote', () => {
        // Somebody who shared a number and changed their mind must find the way out as easily as
        // they found the way in.
        expect(COPY['ACCOUNT.PHONE.REMOVE'].toLowerCase()).toContain('remove');
        expect(COPY['ACCOUNT.PHONE.REMOVE_NOTE'].toLowerCase()).toContain('everywhere');
    });

    it('offers somewhere to go when the account has no number, rather than a dead reference', () => {
        // The old wording pointed at "your account" with nothing to press, because there was no
        // screen to point at. There is one now, and this is the label on the way to it.
        expect(COPY['PAY.PHONE.ACCOUNT_LINK']).toBeTruthy();
        expect(COPY['PAY.PHONE.ACCOUNT_HAS_NONE'].toLowerCase()).toContain('no phone number');
        expect(COPY['PAY.PHONE.ACCOUNT_HAS_NONE'].toLowerCase()).toContain('your account');
    });

    it('points at the check that does exist, which is TWINT showing the recipient name', () => {
        expect(TWINT_CONFIRM_NAME_ADVICE.toLowerCase()).toContain('twint shows');
        expect(TWINT_CONFIRM_NAME_ADVICE.toLowerCase()).not.toMatch(/\bverified\b/);
    });

    it('uses no em dashes, in common with the rest of the repo', () => {
        for (const key of PHONE_KEYS) {
            expect(COPY[key], key).not.toMatch(/[\u2013\u2014]/);
        }
    });

    it('has no account string this file has not been taught about', () => {
        // Guards the lists above against drifting behind the locale file. A key added to en.json
        // and never named here is a key whose wording nothing checks, which is how a "verified"
        // creeps back in - the guards run over the keys, so an unlisted one is still swept, but the
        // sentence-level assertions are not.
        const accounted = new Set([
            'ACCOUNT.PHONE.TITLE',
            'ACCOUNT.PHONE.PLACEHOLDER',
            'ACCOUNT.PHONE.FORMAT_HELP',
            'ACCOUNT.PHONE.PLAINTEXT',
            'ACCOUNT.PHONE.UNVERIFIED',
            'ACCOUNT.PHONE.NONE',
            'ACCOUNT.PHONE.SAVE',
            'ACCOUNT.PHONE.SAVED',
            'ACCOUNT.PHONE.SAVE_FAILED',
            'ACCOUNT.PHONE.REMOVE',
            'ACCOUNT.PHONE.REMOVE_NOTE',
            'ACCOUNT.PHONE.REMOVED',
            'ACCOUNT.PHONE.REMOVE_FAILED',
            ...E164_PROBLEMS.map(e164ProblemKey),
        ]);

        expect(ACCOUNT_KEYS.filter(key => !accounted.has(key))).toEqual([]);
        expect([...accounted].filter(key => !COPY[key])).toEqual([]);
    });
});
