import {describe, expect, it} from 'vitest';
import en from '../../../../../../../assets/i18n/locales/en.json';
import de from '../../../../../../../assets/i18n/locales/de.json';
import fr from '../../../../../../../assets/i18n/locales/fr.json';

const LOCALES: Record<string, Record<string, string>> = {en, de, fr};
const TYPES = ['GUILD_MEMBER_JOIN', 'GUILD_MEMBER_LEAVE'];

describe('system message locale keys', () => {
    for (const [localeName, locale] of Object.entries(LOCALES)) {
        for (const type of TYPES) {
            for (let i = 0; i < 10; i++) {
                const key = `MESSAGE.SYSTEM.${type}.${i}`;
                it(`${localeName} defines ${key} with a %USER% placeholder`, () => {
                    expect(locale[key]).toBeTruthy();
                    expect(locale[key]).toContain('%USER%');
                });
            }
        }
    }
});
