import {describe, expect, it} from 'vitest';
import {ChannelType} from '../../dtos/response/guild.dto';
import {PERM_GROUPS} from '../../enums/permissions.enum';
import {GuildFeature} from './guild-features';
import {lookupChannelIcon} from './channel-icon-catalog';
import {
    CHANNEL_META,
    ChannelView,
    channelIcon,
    channelIconDataFor,
    channelIconTint,
    channelViewFor,
    HOUSEHOLD_CHANNEL_META,
    householdChannelMeta,
    householdFeatureFor,
    isHouseholdChannel,
} from './channel-types';

const HOUSEHOLD_TYPES = [
    ChannelType.List,
    ChannelType.Chores,
    ChannelType.Ledger,
    ChannelType.Pantry,
    ChannelType.Decisions,
    ChannelType.Meals,
    ChannelType.Maintenance,
] as const;

const KNOWN_VIEWS: ReadonlySet<ChannelView> = new Set<ChannelView>([
    'voice',
    'forum',
    'message',
    'list',
    'chores',
    'ledger',
    'pantry',
    'decisions',
    'meals',
    'maintenance',
    'unsupported',
]);

describe('CHANNEL_META', () => {
    it('has exactly one entry for every ChannelType', () => {
        const allTypes = Object.values(ChannelType);
        expect(CHANNEL_META).toHaveLength(allTypes.length);
        for (const type of allTypes) {
            expect(
                CHANNEL_META.filter(m => m.type === type),
                type,
            ).toHaveLength(1);
        }
    });

    it('gives every entry translation keys, and an icon for all but Text', () => {
        for (const meta of CHANNEL_META) {
            expect(meta.labelKey, meta.type).toBeTruthy();
            expect(meta.descKey, meta.type).toBeTruthy();
            if (meta.type === ChannelType.Text) {
                expect(meta.icon).toBeNull(); // renders a literal '#'
            } else {
                expect(meta.icon, meta.type).toMatch(/^[a-z0-9-]{1,48}$/);
            }
        }
    });

    it('gives every entry a view this build knows', () => {
        for (const meta of CHANNEL_META) {
            expect(KNOWN_VIEWS.has(meta.view), `${meta.type} -> ${meta.view}`).toBe(true);
        }
    });

    it('is the only thing channelViewFor consults', () => {
        for (const meta of CHANNEL_META) {
            expect(channelViewFor(meta.type), meta.type).toBe(meta.view);
        }
    });

    it('never gives a household row the message view', () => {
        for (const meta of CHANNEL_META) {
            if (!meta.household) continue;
            expect(meta.view, meta.type).not.toBe('message');
        }
    });

    it('gives each household row a view of its own, never the placeholder', () => {
        const views = CHANNEL_META.filter(m => m.household).map(m => m.view);
        expect(views).not.toContain('unsupported');
        expect(new Set(views).size).toBe(views.length);
    });
});

describe('channelIcon', () => {
    it('is null for Text, which renders a literal #', () => {
        expect(channelIcon(ChannelType.Text)).toBeNull();
    });

    it('names a lucide icon for the other types', () => {
        expect(channelIcon(ChannelType.Voice)).toBe('volume-2');
        expect(channelIcon(ChannelType.Forum)).toBe('messages-square');
        expect(channelIcon(ChannelType.Media)).toBe('images');
        expect(channelIcon(ChannelType.Announcement)).toBe('megaphone');
        expect(channelIcon(ChannelType.List)).toBe('square-check');
        expect(channelIcon(ChannelType.Chores)).toBe('refresh-cw');
        expect(channelIcon(ChannelType.Ledger)).toBe('wallet');
        expect(channelIcon(ChannelType.Pantry)).toBe('package');
        expect(channelIcon(ChannelType.Decisions)).toBe('flag');
        expect(channelIcon(ChannelType.Meals)).toBe('book-open');
        expect(channelIcon(ChannelType.Maintenance)).toBe('wrench');
    });

    it('is null for a type this build does not know', () => {
        expect(channelIcon('Sauna' as ChannelType)).toBeNull();
    });
});

describe('channelIconDataFor', () => {
    it('prefers the channel own icon over the type default', () => {
        const data = channelIconDataFor({type: ChannelType.Text, icon: 'swords'});
        expect(data).toBe(lookupChannelIcon('swords'));
    });

    it('falls back to the type default when the channel sets none', () => {
        expect(channelIconDataFor({type: ChannelType.Voice})).toBe(lookupChannelIcon('volume-2'));
    });

    it('falls back to the type default when the stored name is not shipped', () => {
        expect(channelIconDataFor({type: ChannelType.Voice, icon: 'not-a-real-icon'})).toBe(
            lookupChannelIcon('volume-2'),
        );
    });

    it('is null for a Text channel with no icon, so the row renders its #', () => {
        expect(channelIconDataFor({type: ChannelType.Text})).toBeNull();
    });

    it('is null when neither the channel nor the type resolves', () => {
        expect(channelIconDataFor({type: 'Sauna' as ChannelType, icon: 'nope'})).toBeNull();
    });
});

describe('channelIconTint', () => {
    it('passes a well-formed hex through', () => {
        expect(channelIconTint({iconColor: '#F87171'})).toBe('#F87171');
    });

    it('is null when unset', () => {
        expect(channelIconTint({})).toBeNull();
        expect(channelIconTint({iconColor: ''})).toBeNull();
    });

    it('is null for anything that is not #rrggbb, so a bad value cannot reach a style binding', () => {
        expect(channelIconTint({iconColor: 'red'})).toBeNull();
        expect(channelIconTint({iconColor: '#fff'})).toBeNull();
        expect(channelIconTint({iconColor: 'url(javascript:alert(1))'})).toBeNull();
    });
});

describe('CHANNEL_META icons are all catalog members', () => {
    it('resolves every non-null default', () => {
        for (const meta of CHANNEL_META) {
            if (meta.icon === null) continue;
            expect(lookupChannelIcon(meta.icon), meta.type).not.toBeNull();
        }
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

// `PermGroup.feature` is a plain string (no feature-layer import), so a typo compiles silently; this is the only spec that compares both layers to catch it.
describe('PERM_GROUPS gating', () => {
    it('gates every group on a real GuildFeature', () => {
        const known = new Set<string>(Object.values(GuildFeature));
        for (const group of PERM_GROUPS) {
            if (!group.feature) continue;
            expect(known.has(group.feature), `${group.label} -> ${group.feature}`).toBe(true);
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
        expect(householdFeatureFor(ChannelType.Meals)).toBe(GuildFeature.Meals);
        expect(householdFeatureFor(ChannelType.Maintenance)).toBe(GuildFeature.Maintenance);
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
        // A scene is a thread variant, so it gets the message view and its composer.
        expect(channelViewFor(ChannelType.Scene)).toBe('message');
    });

    it('routes each household type to its own view', () => {
        expect(channelViewFor(ChannelType.List)).toBe('list');
        expect(channelViewFor(ChannelType.Chores)).toBe('chores');
        expect(channelViewFor(ChannelType.Ledger)).toBe('ledger');
        expect(channelViewFor(ChannelType.Pantry)).toBe('pantry');
        expect(channelViewFor(ChannelType.Decisions)).toBe('decisions');
        expect(channelViewFor(ChannelType.Meals)).toBe('meals');
        expect(channelViewFor(ChannelType.Maintenance)).toBe('maintenance');
    });

    /** The drift guard the view table's docblock promises: a household type added without a view silently falls through to `unsupported` instead of erroring. */
    it('gives every household type a view of its own, never the placeholder', () => {
        const views = new Set(HOUSEHOLD_TYPES.map(type => channelViewFor(type)));
        expect(views.has('unsupported')).toBe(false);
        expect(views.has('message')).toBe(false);
        // Distinct per type: a copy-paste that pointed two types at one view would otherwise
        // pass every assertion above except the count.
        expect(views.size).toBe(HOUSEHOLD_TYPES.length);
    });

    // The single most damaging failure mode (§13.1): an unknown type must never fall through to the message view, or the client renders a composer that posts into a shopping list.
    it('never routes an unknown type to the message view', () => {
        expect(channelViewFor('Sauna' as ChannelType)).toBe('unsupported');
        expect(channelViewFor('' as ChannelType)).toBe('unsupported');
    });
});
