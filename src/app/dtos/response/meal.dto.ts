import {ListItem} from './list.dto';

/**
 * Meals: recipes, the week's plan, and the button the module exists for.
 *
 * <p><b>`POST /meal-plan/shopping-list` is the point of all of it.</b> Everything else here is
 * bookkeeping that earns its keep by making that one action possible: collect the window's
 * ingredients, drop what the pantry already has and what is already on the list, and append the
 * rest. Which is also why {@link ShoppingListResult} carries both skip reasons - a shopper who
 * opens the list and finds no onions has no way to tell a working pantry check from a broken button,
 * and will not press it twice.</p>
 */

/** Which meal of the day. `Other` covers what a three-slot day cannot: brunch, a birthday cake. */
export enum MealSlot {
    Breakfast = 'Breakfast',
    Lunch = 'Lunch',
    Dinner = 'Dinner',
    Other = 'Other',
}

const SLOT_BY_ORDINAL: readonly MealSlot[] = [
    MealSlot.Breakfast,
    MealSlot.Lunch,
    MealSlot.Dinner,
    MealSlot.Other,
];

/** In the order a day runs, which is also the order the board draws them within a date. */
export const MEAL_SLOTS: readonly MealSlot[] = SLOT_BY_ORDINAL;

export function mealSlotLabelKey(slot: MealSlot): string {
    return `MEALS.SLOT_${slot.toUpperCase()}`;
}

export interface RecipeIngredient {
    position: number;
    /** As the cook would write it on a shopping list: "2 onions". */
    text: string;
    /**
     * The noun the pantry and list checks match on, derived server-side from {@link text} unless
     * overridden. Shown nowhere; it exists so "2 onions" and "onions" are the same thing.
     */
    matchName?: string | null;
    /** Garnish. Excluded from the shopping list unless asked for, and from the cookable count. */
    isOptional: boolean;
}

export interface Recipe {
    id: string;
    channelId: string;
    title: string;
    description?: string | null;
    servings: number;
    prepMinutes?: number | null;
    sourceUrl?: string | null;
    createdByUserId: string;
    ingredients: RecipeIngredient[];
    createdAt: string;
}

/** Cursor-paged, like the expense list. `nextCursor: null` is the end and nothing else is. */
export interface RecipePage {
    items: Recipe[];
    nextCursor: string | null;
}

/**
 * One entry on the plan.
 *
 * <p>{@link date} is a **plain date** - `"2026-08-13"`, no time and no zone. "Thursday dinner" is
 * Thursday dinner wherever your phone happens to be, and putting an instant here would move a
 * quarter of the week's meals across a date boundary for anybody travelling.</p>
 */
export interface MealPlanEntry {
    id: string;
    channelId: string;
    /** `yyyy-MM-dd`. Never parsed with `new Date(iso)` - see {@link parsePlanDate}. */
    date: string;
    slot: MealSlot;
    recipeId?: string | null;
    /** Denormalized, so a week renders without fetching every recipe it names. */
    recipeTitle?: string | null;
    /** At least one of this and {@link recipeId} is always set. */
    freeText?: string | null;
    cookUserId?: string | null;
    servings?: number | null;
    position: number;
}

export interface MealPlanConfig {
    channelId: string;
    /** Where {@link ShoppingListResult} lines are appended. Must be a `List` channel in this guild. */
    shoppingListChannelId?: string | null;
    /** Which pantry the "do we already have this" check reads. Null switches the check off. */
    pantryChannelId?: string | null;
}

/**
 * What the plan-to-shopping-list button did, **including what it chose not to do**.
 *
 * <p>Both skip lists are rendered. See the file doc: the value of the feature is entirely in the
 * shopper trusting it, and a silent omission is what destroys that.</p>
 */
export interface ShoppingListResult {
    added: ListItem[];
    /** Dropped because the configured pantry already has them. */
    skippedInPantry: string[];
    /** Dropped because an unchecked line on the target list already covers them. */
    skippedOnList: string[];
    /** The per-call cap was hit. Offer "run it again for the rest" rather than shipping half a week. */
    truncated: boolean;
}

/**
 * One recipe ranked by how much about-to-expire stock it uses up.
 *
 * <p>The sort is `expiringCount` descending, then `missingCount` ascending - two keys a person can
 * predict, which is why there is no scoring slider.</p>
 */
export interface CookableRecipe {
    recipe: Recipe;
    /** Ingredients the pantry can cover, optional ones included. */
    haveCount: number;
    /** **Required** ingredients the pantry cannot cover. Optional lines are excluded deliberately. */
    missingCount: number;
    /** How many of the covering items are inside the expiry horizon. The primary sort key. */
    expiringCount: number;
    expiringNames: string[];
    missing: string[];
}

/**
 * The cookable ranking, or why there is not one.
 *
 * <p>{@link reason} is set when the list is empty for a *configuration* rather than a culinary
 * reason - no pantry module, no configured pantry, nothing in stock. A bare empty array would leave
 * the house believing the feature is broken when it is merely unwired.</p>
 */
export interface CookableResult {
    items: CookableRecipe[];
    reason?: string | null;
}

export const MEAL_LIMITS = {
    titleMaxLength: 200,
    /** `MaxIngredients`. */
    ingredientsMax: 60,
    /** `MaxRecipesPerChannel`. */
    recipesPerChannelMax: 200,
    /** The `?from=&to=` window the plan endpoint accepts, in days. */
    planWindowMaxDays: 60,
    servingsMin: 1,
    servingsMax: 100,
    freeTextMaxLength: 200,
} as const;

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * A `yyyy-MM-dd` as a local calendar date.
 *
 * <p>`new Date("2026-08-13")` parses as **UTC midnight**, which is the day before in every negative
 * offset - so a plan built that way puts Thursday's dinner on Wednesday for half the world. Naming
 * the parts explicitly is the only spelling that keeps a plain date plain.</p>
 */
export function parsePlanDate(date: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** The inverse. Local parts, for the same reason - `toISOString` would shift the day back. */
export function toPlanDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The Monday of the week `date` falls in. Weeks start on Monday; a meal plan is a working week. */
export function startOfPlanWeek(date: Date): Date {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    // getDay() is 0 for Sunday, which is the last day of the week here rather than the first.
    const offset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - offset);
    return start;
}

export function addPlanDays(date: Date, days: number): Date {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + days);
    return next;
}

// ── Realtime (server → client) ──────────────────────────────────────────────

export interface RecipeCreated {
    guildId: string;
    channelId: string;
    recipe: Recipe;
}

export type RecipeUpdated = RecipeCreated;

export interface RecipeDeleted {
    guildId: string;
    channelId: string;
    recipeId: string;
}

export interface MealPlanEntryCreated {
    guildId: string;
    channelId: string;
    entry: MealPlanEntry;
}

export type MealPlanEntryUpdated = MealPlanEntryCreated;

export interface MealPlanEntryDeleted {
    guildId: string;
    channelId: string;
    entryId: string;
}

// ── Normalization ───────────────────────────────────────────────────────────

export function normalizeMealSlot(value: MealSlot | number | string | null | undefined): MealSlot {
    if (typeof value === 'number') return SLOT_BY_ORDINAL[value] ?? MealSlot.Dinner;
    return (SLOT_BY_ORDINAL as readonly string[]).includes(value as string)
        ? (value as MealSlot)
        : MealSlot.Dinner;
}

export function normalizeMealPlanEntry(raw: MealPlanEntry): MealPlanEntry {
    return {
        ...raw,
        slot: normalizeMealSlot(raw.slot),
        // A DateOnly can serialize as an instant if the host is configured for it; the board keys
        // on the plain date, so anything with a time on it is cut back to one.
        date: (raw.date ?? '').slice(0, 10),
    };
}

export function normalizeRecipe(raw: Recipe): Recipe {
    return {
        ...raw,
        ingredients: [...(raw.ingredients ?? [])].sort((a, b) => a.position - b.position),
    };
}
