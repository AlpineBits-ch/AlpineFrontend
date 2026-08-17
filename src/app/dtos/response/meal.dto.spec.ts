import {describe, expect, it} from 'vitest';
import {
    addPlanDays,
    MealPlanEntry,
    MealSlot,
    normalizeMealPlanEntry,
    normalizeMealSlot,
    normalizeRecipe,
    parsePlanDate,
    Recipe,
    startOfPlanWeek,
    toPlanDate,
} from './meal.dto';

describe('parsePlanDate', () => {
    /**
     * `new Date("2026-08-13")` parses as UTC midnight, which is the day before in every negative
     * offset - so a plan built that way puts Thursday's dinner on Wednesday for half the world.
     */
    it('reads a plain date as a local calendar date, not as UTC midnight', () => {
        const date = parsePlanDate('2026-08-13');
        expect(date.getFullYear()).toBe(2026);
        expect(date.getMonth()).toBe(7);
        expect(date.getDate()).toBe(13);
    });

    it('round-trips through toPlanDate unchanged', () => {
        expect(toPlanDate(parsePlanDate('2026-02-29'.replace('29', '28')))).toBe('2026-02-28');
        expect(toPlanDate(parsePlanDate('2026-01-01'))).toBe('2026-01-01');
    });
});

describe('startOfPlanWeek', () => {
    it('gives the Monday of the week a Wednesday falls in', () => {
        // 2026-08-12 is a Wednesday.
        expect(toPlanDate(startOfPlanWeek(new Date(2026, 7, 12)))).toBe('2026-08-10');
    });

    it('leaves a Monday where it is', () => {
        expect(toPlanDate(startOfPlanWeek(new Date(2026, 7, 10)))).toBe('2026-08-10');
    });

    /** Sunday is the last day of the week here, not the first - so it looks backwards, not ahead. */
    it('treats Sunday as the end of its week', () => {
        expect(toPlanDate(startOfPlanWeek(new Date(2026, 7, 16)))).toBe('2026-08-10');
    });
});

describe('addPlanDays', () => {
    it('crosses a month boundary', () => {
        expect(toPlanDate(addPlanDays(new Date(2026, 7, 30), 3))).toBe('2026-09-02');
    });

    it('goes backwards', () => {
        expect(toPlanDate(addPlanDays(new Date(2026, 7, 2), -3))).toBe('2026-07-30');
    });
});

describe('normalizeMealSlot', () => {
    it('accepts both the name and the ordinal', () => {
        expect(normalizeMealSlot('Lunch')).toBe(MealSlot.Lunch);
        expect(normalizeMealSlot(0)).toBe(MealSlot.Breakfast);
    });

    it('falls back to Dinner for anything unrecognised', () => {
        expect(normalizeMealSlot('Elevenses')).toBe(MealSlot.Dinner);
        expect(normalizeMealSlot(null)).toBe(MealSlot.Dinner);
    });
});

describe('normalizeMealPlanEntry', () => {
    function entry(overrides: Partial<MealPlanEntry> = {}): MealPlanEntry {
        return {
            id: 'e1',
            channelId: 'c1',
            date: '2026-08-13',
            slot: MealSlot.Dinner,
            position: 0,
            ...overrides,
        };
    }

    /** A DateOnly can serialize as an instant; the board keys on the plain date either way. */
    it('cuts a serialized instant back to a plain date', () => {
        expect(normalizeMealPlanEntry(entry({date: '2026-08-13T00:00:00Z'})).date).toBe('2026-08-13');
    });

    it('survives an absent date rather than throwing', () => {
        expect(normalizeMealPlanEntry(entry({date: undefined as unknown as string})).date).toBe('');
    });
});

describe('normalizeRecipe', () => {
    it('orders ingredients by position and survives an absent list', () => {
        const recipe: Recipe = {
            id: 'r1',
            channelId: 'c1',
            title: 'Soup',
            servings: 2,
            createdByUserId: 'u1',
            createdAt: '2026-08-01T00:00:00Z',
            ingredients: [
                {position: 2, text: 'lentils', isOptional: false},
                {position: 1, text: 'onions', isOptional: false},
            ],
        };

        expect(normalizeRecipe(recipe).ingredients.map(i => i.text)).toEqual(['onions', 'lentils']);
        expect(normalizeRecipe({...recipe, ingredients: undefined as unknown as []}).ingredients).toEqual([]);
    });
});
