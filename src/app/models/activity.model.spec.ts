import {
    ACTIVITY_TYPE_ICONS,
    ACTIVITY_TYPE_KEYS,
    Activity,
    ActivityType,
    activitiesEqual,
    activityKey,
    customActivity,
    primaryActivity,
} from './activity.model';

function game(overrides: Partial<Activity> = {}): Activity {
    return {type: 'Playing', name: 'Overwatch', source: 'ProcessScan', ...overrides};
}

const ALL_TYPES: ActivityType[] = ['Playing', 'Streaming', 'Listening', 'Watching', 'Competing', 'Custom'];

describe('primaryActivity', () => {
    it('returns nothing for an empty or absent list', () => {
        expect(primaryActivity([])).toBeNull();
        expect(primaryActivity(null)).toBeNull();
        expect(primaryActivity(undefined)).toBeNull();
    });

    it('takes the first entry, because the arbiter already ordered them by priority', () => {
        const rpc = game({name: 'Counter-Strike 2', source: 'Rpc'});
        const scanned = game({name: 'Steam'});

        expect(primaryActivity([rpc, scanned])).toBe(rpc);
    });

    /**
     * A custom status is a user-authored sentence, not a detected game. It has its own render and
     * must never take the game slot on a one-line surface.
     */
    it('skips a custom status when looking for the game line', () => {
        const custom = game({type: 'Custom', name: 'brb'});
        const playing = game();

        expect(primaryActivity([custom, playing])).toBe(playing);
        expect(primaryActivity([custom])).toBeNull();
    });

    it('finds the custom status separately', () => {
        const custom = game({type: 'Custom', name: 'brb'});

        expect(customActivity([custom, game()])).toBe(custom);
        expect(customActivity([game()])).toBeNull();
    });
});

describe('activityKey', () => {
    it('is the same triple the server uses to decide whether startedAt is preserved', () => {
        expect(activityKey(game({applicationId: '123'})))
            .toBe(activityKey(game({applicationId: '123', startedAt: 999})));
    });

    it('separates two games that differ only by application id', () => {
        expect(activityKey(game({applicationId: '1'}))).not.toBe(activityKey(game({applicationId: '2'})));
    });
});

describe('activitiesEqual', () => {
    it('treats absent and empty as the same nothing', () => {
        expect(activitiesEqual(null, [])).toBe(true);
        expect(activitiesEqual(undefined, null)).toBe(true);
    });

    /**
     * The point of this function: a poll every 30 s re-reports the same game, and re-sending it
     * would burn the one-write-per-15 s budget on nothing.
     */
    it('ignores a changed startedAt, which the server owns anyway', () => {
        expect(activitiesEqual([game({startedAt: 1})], [game({startedAt: 999})])).toBe(true);
    });

    it('notices a different game', () => {
        expect(activitiesEqual([game()], [game({name: 'Deep Rock Galactic'})])).toBe(false);
    });

    it('notices details, state and party changing under the same game', () => {
        expect(activitiesEqual([game()], [game({details: 'Competitive'})])).toBe(false);
        expect(activitiesEqual([game()], [game({state: 'In Queue'})])).toBe(false);
        expect(activitiesEqual(
            [game({party: {size: 2, max: 5}})],
            [game({party: {size: 3, max: 5}})],
        )).toBe(false);
    });

    it('notices a game stopping', () => {
        expect(activitiesEqual([game()], [])).toBe(false);
    });

    it('is order-sensitive, because order is the arbiter s priority', () => {
        const a = game({name: 'A'});
        const b = game({name: 'B'});

        expect(activitiesEqual([a, b], [b, a])).toBe(false);
    });
});

describe('activity type tables', () => {
    // Both are Records keyed by the union, so a missing member is a compile error - these guard
    // against the other half: a key present but empty.
    it('has a translation key and an icon for every type', () => {
        for (const type of ALL_TYPES) {
            expect(ACTIVITY_TYPE_KEYS[type]).toMatch(/^ACTIVITY\./);
            expect(ACTIVITY_TYPE_ICONS[type]).toMatch(/^pi-/);
        }
    });
});
