import {
    COMMUNITY_MODULES,
    GuildFeature,
    guildHasFeature,
    guildKindOf,
    parseGuildFeatures,
    serializeGuildFeatures,
    withGuildFeature,
} from './guild-features';
import {GuildDto, GuildKind} from '../../dtos/response/guild.dto';

function guild(features?: string, kind?: GuildKind): GuildDto {
    return {features, kind} as GuildDto;
}

describe('parseGuildFeatures', () => {
    it('splits a comma-separated name list', () => {
        const set = parseGuildFeatures('VoiceChannels, Threads, Wiki');

        expect([...set]).toEqual(['VoiceChannels', 'Threads', 'Wiki']);
    });

    it('tolerates missing spaces and stray whitespace', () => {
        expect([...parseGuildFeatures('VoiceChannels,Threads ,  Wiki ')])
            .toEqual(['VoiceChannels', 'Threads', 'Wiki']);
    });

    it('treats "None" and empty as no modules', () => {
        expect(parseGuildFeatures('None').size).toBe(0);
        expect(parseGuildFeatures('').size).toBe(0);
    });

    // Absent is not the same as empty: guilds that predate the modules layer are
    // Communities with everything on, and blanking their UI would be a regression.
    it('falls back to the full community preset when the field is absent', () => {
        for (const raw of [undefined, null]) {
            const set = parseGuildFeatures(raw);
            for (const module of COMMUNITY_MODULES) expect(set.has(module)).toBe(true);
        }
    });

    it('keeps names it does not recognise', () => {
        expect(parseGuildFeatures('Wiki, SomethingNewer').has('SomethingNewer')).toBe(true);
    });
});

describe('serializeGuildFeatures', () => {
    it('joins names the way the server does', () => {
        expect(serializeGuildFeatures(['Wiki', 'Lists'])).toBe('Wiki, Lists');
    });

    it('emits "None" for an empty set', () => {
        expect(serializeGuildFeatures([])).toBe('None');
    });

    it('round-trips an unknown module untouched', () => {
        const parsed = parseGuildFeatures('Wiki, SomethingNewer');

        expect(serializeGuildFeatures(parsed)).toBe('Wiki, SomethingNewer');
    });
});

describe('withGuildFeature', () => {
    it('adds and removes without mutating the source set', () => {
        const base = parseGuildFeatures('Wiki');

        expect([...withGuildFeature(base, GuildFeature.Lists, true)]).toEqual(['Wiki', 'Lists']);
        expect([...withGuildFeature(base, GuildFeature.Wiki, false)]).toEqual([]);
        expect([...base]).toEqual(['Wiki']);
    });
});

describe('guildHasFeature', () => {
    it('reads the guild\'s own set', () => {
        expect(guildHasFeature(guild('Wiki'), GuildFeature.Wiki)).toBe(true);
        expect(guildHasFeature(guild('Wiki'), GuildFeature.Events)).toBe(false);
    });

    it('grants the community preset to a guild with no features field', () => {
        expect(guildHasFeature(guild(), GuildFeature.Moderation)).toBe(true);
    });

    it('grants the community preset for a guild that has not loaded', () => {
        expect(guildHasFeature(null, GuildFeature.Moderation)).toBe(true);
    });

    it('denies a household module the community preset never included', () => {
        expect(guildHasFeature(guild(), GuildFeature.Lists)).toBe(false);
    });
});

describe('guildKindOf', () => {
    it('defaults to Community', () => {
        expect(guildKindOf(guild())).toBe(GuildKind.Community);
        expect(guildKindOf(null)).toBe(GuildKind.Community);
        expect(guildKindOf(guild(undefined, GuildKind.Household))).toBe(GuildKind.Household);
    });
});
