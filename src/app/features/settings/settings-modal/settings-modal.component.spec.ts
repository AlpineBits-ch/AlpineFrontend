/**
 * The settings nav renders translation keys, and this is what keeps it that way.
 *
 * <p>The bug being locked out: the `SETTINGS.NAV.*` keys existed and were translated into de and
 * fr, while `navGroups` held English string literals that the template printed directly. The nav
 * was therefore English in every language, nothing failed, and every page added made it worse. A
 * missing key is invisible at runtime too - ngx-translate renders the key itself - so only a test
 * can see either half of this.</p>
 */
import {SETTINGS_NAV_GROUPS as navGroups} from './settings-modal.component';
import en from '../../../../assets/i18n/locales/en.json';

const translations = en as Record<string, string>;

describe('settings nav', () => {
    it('has at least the pages we expect, so an empty table cannot pass the tests below', () => {
        const ids = navGroups.flatMap(g => g.items.map(i => i.id));

        expect(ids).toContain('profile');
        expect(ids).toContain('activity');
        expect(ids.length).toBeGreaterThanOrEqual(11);
    });

    it('names every group and page by translation key rather than by English', () => {
        for (const group of navGroups) {
            expect(group.titleKey).toMatch(/^SETTINGS\.NAV\./);
            for (const item of group.items) {
                expect(item.labelKey).toMatch(/^SETTINGS\.NAV\./);
            }
        }
    });

    it('has an English string behind every one of those keys', () => {
        for (const group of navGroups) {
            expect(translations[group.titleKey], group.titleKey).toBeTruthy();
            for (const item of group.items) {
                expect(translations[item.labelKey], item.labelKey).toBeTruthy();
            }
        }
    });

    it('gives every page a distinct id and a distinct label key', () => {
        const items = navGroups.flatMap(g => g.items);
        const ids = items.map(i => i.id);
        const keys = items.map(i => i.labelKey);

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
