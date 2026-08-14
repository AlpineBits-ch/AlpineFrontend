/**
 * The guild settings nav.
 *
 * <p>Unlike the settings and admin navs, this one was never rendering English - it always held
 * `GUILD_SETTINGS.NAV.*` keys and the template always translated them. Only the field names lied
 * (`label` holding a key), and that is exactly what made the other two navs look correct at a
 * glance. So this file is a regression test rather than a fix: it pins the naming, and it checks
 * the thing the other two navs cannot have wrong - <b>feature-gated</b> items, which only appear
 * for some guilds and are therefore the ones whose keys nobody notices are missing.</p>
 */
import {buildGuildNavGroups} from './guild-settings-modal.component';
import {GuildFeature} from '../../guild-features';
import en from '../../../../../assets/i18n/locales/en.json';

const translations = en as Record<string, string>;

/** `GuildDto.features` is a comma-separated string; `undefined` means the community preset. */
function guild(...features: string[]) {
    return {features: features.length ? features.join(', ') : 'None'};
}

/** Every gated item, so a new one added without a key fails here. */
const EVERY_FEATURE = guild(...Object.values(GuildFeature));

/** Everything a guild can show at once: every module, on an instance that sells something. */
const EVERY_PAGE = buildGuildNavGroups(EVERY_FEATURE, true);

describe('guild settings nav', () => {
    it('names every group and page by translation key rather than by English', () => {
        for (const group of EVERY_PAGE) {
            expect(group.titleKey).toMatch(/^GUILD_SETTINGS\.NAV\./);
            for (const item of group.items) {
                expect(item.labelKey).toMatch(/^GUILD_SETTINGS\.NAV\./);
            }
        }
    });

    it('has an English string behind every key, including the feature-gated ones', () => {
        for (const group of EVERY_PAGE) {
            expect(translations[group.titleKey], group.titleKey).toBeTruthy();
            for (const item of group.items) {
                expect(translations[item.labelKey], item.labelKey).toBeTruthy();
            }
        }
    });

    it('gives every page a distinct id and a distinct label key', () => {
        const items = EVERY_PAGE.flatMap(g => g.items);
        const ids = items.map(i => i.id);
        const keys = items.map(i => i.labelKey);

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(keys).size).toBe(keys.length);
    });

    // ── The gating itself, which the extraction to a free function made testable ──

    it('always offers the ungated pages, even for a guild with no modules at all', () => {
        const ids = buildGuildNavGroups(guild()).flatMap(g => g.items.map(i => i.id));

        // `modules` in particular is never gated: it is how a module gets switched back on, so
        // hiding it would be a one-way door.
        expect(ids).toEqual(expect.arrayContaining(['overview', 'modules', 'members', 'roles', 'invites']));
    });

    it('hides a module page rather than disabling it', () => {
        const ids = buildGuildNavGroups(guild()).flatMap(g => g.items.map(i => i.id));

        expect(ids).not.toContain('bans');
        expect(ids).not.toContain('emojis');
        expect(ids).not.toContain('quiet-hours');
    });

    it('shows Bans and Audit Log together, since both ride on Moderation', () => {
        const ids = buildGuildNavGroups(guild(GuildFeature.Moderation)).flatMap(g => g.items.map(i => i.id));

        expect(ids).toContain('bans');
        expect(ids).toContain('audit-log');
        expect(ids).not.toContain('moderation');
    });

    it('drops a group entirely once it has no items, rather than leaving an empty heading', () => {
        const community = buildGuildNavGroups(guild(GuildFeature.Moderation));

        expect(community.map(g => g.titleKey)).not.toContain('GUILD_SETTINGS.NAV.GROUP_HOUSEHOLD');
    });

    it('brings the household group back for a guild that has those modules', () => {
        const household = buildGuildNavGroups(guild(GuildFeature.QuietHours, GuildFeature.GuestAccess));
        const group = household.find(g => g.titleKey === 'GUILD_SETTINGS.NAV.GROUP_HOUSEHOLD');

        expect(group?.items.map(i => i.id)).toEqual(['quiet-hours', 'guest-access']);
    });

    /**
     * The plan is not a module, and it is not gated on one: what a guild *is on* and what it *has*
     * are different questions, and folding the first into the modules list is what makes "the owner
     * turned Forums off" and "Forums is not in this plan" look like one thing.
     */
    it('offers the plan page for any guild, on an instance that sells something', () => {
        const bare = buildGuildNavGroups(guild(), true);

        expect(bare.flatMap(g => g.items.map(i => i.id))).toContain('plan');
    });

    /** Hidden, not disabled: a self-hoster shown a plan page has hit a paywall for nothing. */
    it('hides it entirely where nothing can be bought', () => {
        const groups = buildGuildNavGroups(EVERY_FEATURE);

        expect(groups.flatMap(g => g.items.map(i => i.id))).not.toContain('plan');
        expect(groups.map(g => g.titleKey)).not.toContain('GUILD_SETTINGS.NAV.GROUP_PLAN');
    });

    /** A caller that has read nothing yet must not draw a billing surface on the guess. */
    it('draws nothing before the instance has been asked', () => {
        expect(buildGuildNavGroups(EVERY_FEATURE).flatMap(g => g.items.map(i => i.id)))
            .not.toContain('plan');
    });
});
