/**
 * The settings nav renders translation keys, and this is what keeps it that way.
 *
 * <p>The bug being locked out: the `SETTINGS.NAV.*` keys existed and were translated into de and
 * fr, while `navGroups` held English string literals that the template printed directly. The nav
 * was therefore English in every language, nothing failed, and every page added made it worse. A
 * missing key is invisible at runtime too - ngx-translate renders the key itself - so only a test
 * can see either half of this.</p>
 */
import {SETTINGS_NAV_GROUPS as navGroups, visibleSettingsNavGroups} from './settings-modal.component';
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

/**
 * Hidden, not disabled.
 *
 * <p>A self-hoster shown a Billing page has hit a paywall for a product nobody is charging them
 * for, and a hosted instance whose billing is not configured yet reads exactly the same way. Both
 * answer `upgradesAvailable` false, which is why that is the one thing branched on - the same
 * "omit rather than explain" rule `capabilities.ts` applies to a control that cannot work.</p>
 */
describe('the billing page', () => {
    it('is offered where something can actually be bought', () => {
        const ids = visibleSettingsNavGroups(true).flatMap(g => g.items.map(i => i.id));

        expect(ids).toContain('billing');
    });

    it('is absent, not disabled, where nothing can be', () => {
        const ids = visibleSettingsNavGroups(false).flatMap(g => g.items.map(i => i.id));

        expect(ids).not.toContain('billing');
    });

    /** Hiding one page must not take the group it lives in with it. */
    it('leaves the rest of the nav alone', () => {
        const ids = visibleSettingsNavGroups(false).flatMap(g => g.items.map(i => i.id));

        expect(ids).toEqual(expect.arrayContaining(['profile', 'privacy', 'devices', 'about']));
    });
});
