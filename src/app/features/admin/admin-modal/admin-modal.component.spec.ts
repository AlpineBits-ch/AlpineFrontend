/**
 * The admin nav renders translation keys, and this is what keeps it that way.
 *
 * <p>Same bug as the settings nav had, found the same way: `navGroups` held English string
 * literals ("Federation", "Instances", "Settings") that the template printed directly, and this
 * component did not even import `TranslateModule`. Neither half is visible at runtime - a
 * hardcoded label renders fine, and a missing key renders as the key - so only a test sees it.</p>
 */
import {ADMIN_NAV_GROUPS as navGroups} from './admin-modal.component';
import en from '../../../../assets/i18n/locales/en.json';

const translations = en as Record<string, string>;

describe('admin nav', () => {
    it('has the pages we expect, so an empty table cannot pass the tests below', () => {
        const ids = navGroups.flatMap(g => g.items.map(i => i.id));

        expect(ids).toContain('federation-instances');
        expect(ids).toContain('federation-policy');
    });

    it('names every group and page by translation key rather than by English', () => {
        for (const group of navGroups) {
            expect(group.titleKey).toMatch(/^ADMIN\.NAV\./);
            for (const item of group.items) {
                expect(item.labelKey).toMatch(/^ADMIN\.NAV\./);
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

    /** The panel title is not part of the nav table, so it needs saying separately. */
    it('has a title string', () => {
        expect(translations['ADMIN.TITLE']).toBeTruthy();
    });
});
