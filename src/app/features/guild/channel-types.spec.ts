import {describe, expect, it} from 'vitest';
import {ChannelType} from '../../dtos/response/guild.dto';
import {GuildFeature} from './guild-features';
import {
    CHANNEL_META,
    channelIcon,
    channelViewFor,
    HOUSEHOLD_CHANNEL_META,
    householdChannelMeta,
    householdFeatureFor,
    isHouseholdChannel,
} from './channel-types';

const HOUSEHOLD_TYPES = [
    ChannelType.List, ChannelType.Chores, ChannelType.Ledger,
    ChannelType.Pantry, ChannelType.Decisions,
] as const;

describe('CHANNEL_META', () => {
    it('has exactly one entry for every ChannelType', () => {
        const allTypes = Object.values(ChannelType);
        expect(CHANNEL_META).toHaveLength(allTypes.length);
        for (const type of allTypes) {
            expect(CHANNEL_META.filter(m => m.type === type), type).toHaveLength(1);
        }
    });

    it('gives every entry translation keys, and an icon for all but Text', () => {
        for (const meta of CHANNEL_META) {
            expect(meta.labelKey, meta.type).toBeTruthy();
            expect(meta.descKey, meta.type).toBeTruthy();
            if (meta.type === ChannelType.Text) {
                expect(meta.icon).toBeNull();  // renders a literal '#'
            } else {
                expect(meta.icon, meta.type).toMatch(/^pi pi-/);
            }
        }
    });
});

describe('channelIcon', () => {
    it('returns null for Text, which renders a hash instead', () => {
        expect(channelIcon(ChannelType.Text)).toBeNull();
    });

    it('returns the icon for every other known type', () => {
        expect(channelIcon(ChannelType.Voice)).toBe('pi pi-volume-up');
        expect(channelIcon(ChannelType.Forum)).toBe('pi pi-align-left');
        expect(channelIcon(ChannelType.Media)).toBe('pi pi-images');
        expect(channelIcon(ChannelType.Announcement)).toBe('pi pi-megaphone');
        expect(channelIcon(ChannelType.List)).toBe('pi pi-check-square');
        expect(channelIcon(ChannelType.Chores)).toBe('pi pi-sync');
        expect(channelIcon(ChannelType.Ledger)).toBe('pi pi-wallet');
        expect(channelIcon(ChannelType.Pantry)).toBe('pi pi-box');
        expect(channelIcon(ChannelType.Decisions)).toBe('pi pi-flag');
    });

    it('returns null for an unknown type rather than throwing', () => {
        expect(channelIcon('Sauna' as ChannelType)).toBeNull();
    });
});

describe('HOUSEHOLD_CHANNEL_META', () => {
    it('is exactly the household subset of CHANNEL_META', () => {
        expect(HOUSEHOLD_CHANNEL_META.map(m => m.type)).toEqual([...HOUSEHOLD_TYPES]);
    });

    it('gives every household entry a gating module and CHANNEL_TYPE.* keys', () => {
        for (const meta of HOUSEHOLD_CHANNEL_META) {
            expect(meta.feature, meta.type).not.toBeNull();
            expect(meta.labelKey).toMatch(/^CHANNEL_TYPE\./);
            expect(meta.descKey).toMatch(/^CHANNEL_TYPE\./);
        }
    });
});

describe('householdFeatureFor', () => {
    it('maps each household type to its gating module', () => {
        expect(householdFeatureFor(ChannelType.List)).toBe(GuildFeature.Lists);
        expect(householdFeatureFor(ChannelType.Chores)).toBe(GuildFeature.Chores);
        expect(householdFeatureFor(ChannelType.Ledger)).toBe(GuildFeature.Ledger);
        expect(householdFeatureFor(ChannelType.Pantry)).toBe(GuildFeature.Pantry);
        expect(householdFeatureFor(ChannelType.Decisions)).toBe(GuildFeature.Decisions);
    });

    it('returns null for the chat types', () => {
        expect(householdFeatureFor(ChannelType.Text)).toBeNull();
        expect(householdFeatureFor(ChannelType.Voice)).toBeNull();
        expect(householdFeatureFor(ChannelType.Forum)).toBeNull();
    });
});

describe('isHouseholdChannel', () => {
    it('agrees with the metadata table', () => {
        for (const type of HOUSEHOLD_TYPES) expect(isHouseholdChannel(type)).toBe(true);
        expect(isHouseholdChannel(ChannelType.Text)).toBe(false);
        expect(isHouseholdChannel(ChannelType.Announcement)).toBe(false);
    });
});

describe('householdChannelMeta', () => {
    it('returns the entry for a household type and null otherwise', () => {
        expect(householdChannelMeta(ChannelType.Ledger)?.feature).toBe(GuildFeature.Ledger);
        expect(householdChannelMeta(ChannelType.Text)).toBeNull();
    });
});

describe('channelViewFor', () => {
    it('routes voice to the voice view', () => {
        expect(channelViewFor(ChannelType.Voice)).toBe('voice');
    });

    it('routes both forum-like types to the forum view', () => {
        expect(channelViewFor(ChannelType.Forum)).toBe('forum');
        expect(channelViewFor(ChannelType.Media)).toBe('forum');
    });

    it('routes the message-bearing types to the message view', () => {
        expect(channelViewFor(ChannelType.Text)).toBe('message');
        expect(channelViewFor(ChannelType.Announcement)).toBe('message');
        expect(channelViewFor(ChannelType.Thread)).toBe('message');
    });

    it('routes every household type to the unsupported view for now', () => {
        for (const type of HOUSEHOLD_TYPES) expect(channelViewFor(type)).toBe('unsupported');
    });

    // The single most damaging failure mode in the integration guide (§10.1): a type this
    // build has never heard of must not fall through to the message view, or the client
    // renders a composer that posts into a shopping list.
    it('never routes an unknown type to the message view', () => {
        expect(channelViewFor('Sauna' as ChannelType)).toBe('unsupported');
        expect(channelViewFor('' as ChannelType)).toBe('unsupported');
    });
});
