import {MealSlot} from '../response/meal.dto';

export interface RecipeIngredientInputDto {
    text: string;
    /** Left off, the server derives the match noun from `text`. Normalized either way. */
    matchName?: string;
    isOptional?: boolean;
}

export interface CreateRecipeDto {
    title: string;
    description?: string;
    servings?: number;
    prepMinutes?: number;
    sourceUrl?: string;
    ingredients?: RecipeIngredientInputDto[];
}

/**
 * A partial patch, except for {@link ingredients}, which **replaces the whole list** when present.
 *
 * <p>Wholesale rather than per-line: an ingredient list is edited as a block in every client that
 * will ever exist, and a per-line protocol would need stable ids that mean nothing to the person
 * reordering them.</p>
 */
export interface UpdateRecipeDto {
    title?: string;
    description?: string;
    servings?: number;
    prepMinutes?: number;
    sourceUrl?: string;
    ingredients?: RecipeIngredientInputDto[];
    clearDescription?: boolean;
    clearPrepMinutes?: boolean;
    clearSourceUrl?: boolean;
}

export interface CreateMealPlanEntryDto {
    /** `yyyy-MM-dd`. A plain date - see `parsePlanDate`. */
    date: string;
    slot: MealSlot;
    /** At least one of this and {@link freeText} is required. */
    recipeId?: string;
    freeText?: string;
    cookUserId?: string;
    servings?: number;
}

export interface UpdateMealPlanEntryDto {
    date?: string;
    slot?: MealSlot;
    recipeId?: string;
    freeText?: string;
    cookUserId?: string;
    servings?: number;
    position?: number;
    clearRecipe?: boolean;
    clearFreeText?: boolean;
    clearCook?: boolean;
    clearServings?: boolean;
}

/**
 * The plan-to-shopping-list request.
 *
 * <p>The window is required and explicit. "This week" means different things on a Sunday night and
 * a Monday morning, and letting the server guess would silently shop for the wrong one.</p>
 */
export interface GenerateShoppingListDto {
    from: string;
    to: string;
    /** Falls back to the channel's `shoppingListChannelId`; with neither, the request is a `400`. */
    listChannelId?: string;
    /** Garnish included. Off by default, because most optional lines are things a house has. */
    includeOptional?: boolean;
    /** Skips the "do we already have this" check, for a house that knows its pantry is stale. */
    skipPantry?: boolean;
}

/** Full replace. `clear*` rather than null ids, for the usual reason - null reads as "leave alone". */
export interface UpdateMealPlanConfigDto {
    shoppingListChannelId?: string;
    pantryChannelId?: string;
    clearShoppingList?: boolean;
    clearPantry?: boolean;
}
