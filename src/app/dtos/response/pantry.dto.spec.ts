import {
    isRestockLoopEnabled,
    isValidExpiryWarningDays,
    PantryConfig,
    PantryItem,
    pantryExpiryState,
    pantryStockState,
} from './pantry.dto';

function item(overrides: Partial<PantryItem> = {}): PantryItem {
    return {
        id: 'pitm_1',
        channelId: 'chan_pantry',
        name: 'Milk',
        quantity: 4,
        unit: 'l',
        lowThreshold: 2,
        expiresAt: null,
        isLow: false,
        restockedAt: null,
        addedByUserId: 'user_1',
        ...overrides,
    };
}

function config(overrides: Partial<PantryConfig> = {}): PantryConfig {
    return {channelId: 'chan_pantry', restockListChannelId: 'chan_list', expiryWarningDays: 3, ...overrides};
}

describe('pantryStockState', () => {
    it('is ok while the quantity is above the threshold', () => {
        expect(pantryStockState(item({quantity: 4, lowThreshold: 2}))).toBe('ok');
    });

    it('is low at exactly the threshold - the server fires on "at or below"', () => {
        expect(pantryStockState(item({quantity: 2, lowThreshold: 2}))).toBe('low');
    });

    it('is low below the threshold', () => {
        expect(pantryStockState(item({quantity: 1, lowThreshold: 2}))).toBe('low');
    });

    it('is listed once restockedAt is stamped, not merely low', () => {
        const listed = item({quantity: 1, lowThreshold: 2, restockedAt: '2026-08-03T10:00:00Z'});
        expect(pantryStockState(listed)).toBe('listed');
    });

    it('is untracked when lowThreshold is null, however little is left', () => {
        expect(pantryStockState(item({quantity: 0, lowThreshold: null}))).toBe('untracked');
    });

    it('is untracked when lowThreshold is absent from the payload', () => {
        const bare = item();
        delete bare.lowThreshold;
        expect(pantryStockState({...bare, quantity: 0})).toBe('untracked');
    });

    // The bug this whole module fails on if it is ever written with a falsy test.
    describe('threshold 0 is a real threshold, distinct from null', () => {
        it('fires at zero quantity', () => {
            expect(pantryStockState(item({quantity: 0, lowThreshold: 0}))).toBe('low');
        });

        it('does not fire while any is left', () => {
            expect(pantryStockState(item({quantity: 1, lowThreshold: 0}))).toBe('ok');
        });

        it('is not the same as no threshold at all', () => {
            expect(pantryStockState(item({quantity: 0, lowThreshold: 0}))).not
                .toBe(pantryStockState(item({quantity: 0, lowThreshold: null})));
        });
    });

    // The loop is a cycle, not a one-way trip: nothing here may latch.
    describe('the restock cycle', () => {
        it('runs ok -> low -> listed -> ok as the server rewrites the same row', () => {
            const states = [
                item({quantity: 4, lowThreshold: 2}),
                item({quantity: 2, lowThreshold: 2, isLow: true}),
                item({quantity: 2, lowThreshold: 2, isLow: true, restockedAt: '2026-08-03T10:00:00Z'}),
                // Bought: quantity climbs back, the server releases the stamp.
                item({quantity: 6, lowThreshold: 2, isLow: false, restockedAt: null}),
            ].map(pantryStockState);

            expect(states).toEqual(['ok', 'low', 'listed', 'ok']);
        });

        it('releases back to low when the list line is cleared without restocking', () => {
            // "Cleared as bought" on the list side releases restockedAt even though the
            // quantity never moved - the item is low again and re-armed.
            const stamped = item({quantity: 1, lowThreshold: 2, restockedAt: '2026-08-03T10:00:00Z'});
            expect(pantryStockState(stamped)).toBe('listed');
            expect(pantryStockState({...stamped, restockedAt: null})).toBe('low');
        });

        it('can re-enter listed after having left it', () => {
            const row = item({quantity: 1, lowThreshold: 2});
            expect(pantryStockState({...row, restockedAt: '2026-08-01T10:00:00Z'})).toBe('listed');
            expect(pantryStockState({...row, restockedAt: null})).toBe('low');
            expect(pantryStockState({...row, restockedAt: '2026-08-05T10:00:00Z'})).toBe('listed');
        });
    });

    it('reports listed even for an item whose threshold was since cleared', () => {
        // Being on the shopping list is a fact about the house; it outranks the threshold.
        const orphan = item({lowThreshold: null, restockedAt: '2026-08-03T10:00:00Z'});
        expect(pantryStockState(orphan)).toBe('listed');
    });
});

describe('isRestockLoopEnabled', () => {
    it('is on with a list channel configured', () => {
        expect(isRestockLoopEnabled(config())).toBe(true);
    });

    it('is off when restockListChannelId is null, whatever the thresholds say', () => {
        expect(isRestockLoopEnabled(config({restockListChannelId: null}))).toBe(false);
    });

    it('is off when the config has not loaded', () => {
        expect(isRestockLoopEnabled(undefined)).toBe(false);
    });
});

describe('pantryExpiryState', () => {
    const now = new Date('2026-08-03T12:00:00Z').getTime();
    const inDays = (d: number) => new Date(now + d * 86_400_000).toISOString();

    it('is none for an item with no expiry', () => {
        expect(pantryExpiryState(item({expiresAt: null}), 3, now)).toBe('none');
    });

    it('is none beyond the warning window', () => {
        expect(pantryExpiryState(item({expiresAt: inDays(10)}), 3, now)).toBe('none');
    });

    it('is soon inside the warning window', () => {
        expect(pantryExpiryState(item({expiresAt: inDays(2)}), 3, now)).toBe('soon');
    });

    it('is expired once the instant has passed', () => {
        expect(pantryExpiryState(item({expiresAt: inDays(-1)}), 3, now)).toBe('expired');
    });

    it('widens with the window rather than with the item', () => {
        const row = item({expiresAt: inDays(10)});
        expect(pantryExpiryState(row, 3, now)).toBe('none');
        expect(pantryExpiryState(row, 30, now)).toBe('soon');
    });

    it('treats an unparseable date as no expiry rather than as expired', () => {
        expect(pantryExpiryState(item({expiresAt: 'not-a-date'}), 3, now)).toBe('none');
    });
});

describe('isValidExpiryWarningDays', () => {
    it('accepts the inclusive bounds', () => {
        expect(isValidExpiryWarningDays(1)).toBe(true);
        expect(isValidExpiryWarningDays(90)).toBe(true);
    });

    it('rejects outside the range', () => {
        expect(isValidExpiryWarningDays(0)).toBe(false);
        expect(isValidExpiryWarningDays(91)).toBe(false);
    });

    it('rejects fractions, nulls and NaN', () => {
        expect(isValidExpiryWarningDays(3.5)).toBe(false);
        expect(isValidExpiryWarningDays(null)).toBe(false);
        expect(isValidExpiryWarningDays(undefined)).toBe(false);
        expect(isValidExpiryWarningDays(Number.NaN)).toBe(false);
    });
});
