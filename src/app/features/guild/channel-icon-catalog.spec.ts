import {describe, expect, it} from 'vitest';
import {CHANNEL_ICON_CATALOG, CHANNEL_ICON_GROUPS, lookupChannelIcon} from './channel-icon-catalog';

const NAME_PATTERN = /^[a-z0-9-]{1,48}$/;

describe('CHANNEL_ICON_CATALOG', () => {
    it('has no duplicate names', () => {
        const names = CHANNEL_ICON_CATALOG.map(e => e.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('gives every entry a name the server will accept', () => {
        for (const entry of CHANNEL_ICON_CATALOG) {
            expect(entry.name, entry.name).toMatch(NAME_PATTERN);
        }
    });

    it('gives every entry non-empty icon data', () => {
        for (const entry of CHANNEL_ICON_CATALOG) {
            expect(entry.icon.length, entry.name).toBeGreaterThan(0);
        }
    });

    it('puts every entry in a declared group', () => {
        for (const entry of CHANNEL_ICON_CATALOG) {
            expect(CHANNEL_ICON_GROUPS, entry.name).toContain(entry.group);
        }
    });

    it('fills every declared group', () => {
        for (const group of CHANNEL_ICON_GROUPS) {
            expect(
                CHANNEL_ICON_CATALOG.some(e => e.group === group),
                group,
            ).toBe(true);
        }
    });
});

describe('lookupChannelIcon', () => {
    it('resolves a catalog name to its data', () => {
        expect(lookupChannelIcon('volume-2')).toBe(
            CHANNEL_ICON_CATALOG.find(e => e.name === 'volume-2')!.icon,
        );
    });

    it('returns null for a name it does not ship', () => {
        expect(lookupChannelIcon('not-a-real-icon')).toBeNull();
    });

    it('returns null for null, undefined and empty', () => {
        expect(lookupChannelIcon(null)).toBeNull();
        expect(lookupChannelIcon(undefined)).toBeNull();
        expect(lookupChannelIcon('')).toBeNull();
    });
});
