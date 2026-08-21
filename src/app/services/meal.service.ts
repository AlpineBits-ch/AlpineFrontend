import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {
    CookableResult,
    MealPlanConfig,
    MealPlanEntry,
    Recipe,
    ShoppingListResult,
} from '../dtos/response/meal.dto';
import {
    CreateMealPlanEntryDto,
    CreateRecipeDto,
    GenerateShoppingListDto,
    UpdateMealPlanConfigDto,
    UpdateMealPlanEntryDto,
    UpdateRecipeDto,
} from '../dtos/request/meal.dto';
import {MealChannelState, MealStore} from '../stores/meal.store';

export type {MealChannelState};

/**
 * The view-facing shape of {@link MealStore}. State, the week and realtime all live in the store;
 * this is the call surface the Meals channel view already speaks.
 */
@Injectable({providedIn: 'root'})
export class MealService {
    private store = inject(MealStore);

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): MealChannelState {
        return this.store.stateFor(channelId)();
    }

    /** The seven days of the loaded week, as plain dates. What the board's columns are. */
    weekDatesFor(channelId: string): string[] {
        return this.store.weekDatesFor(channelId);
    }

    recipeById(channelId: string, recipeId: string): Recipe | null {
        return this.store.recipeById(channelId, recipeId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        this.store.loadFor(channelId);
    }

    refresh(channelId: string): void {
        this.store.refresh(channelId);
    }

    /** Moves the board a week at a time. Always a fresh read. */
    shiftWeek(channelId: string, weeks: number): void {
        this.store.shiftWeek(channelId, weeks);
    }

    setWeek(channelId: string, weekStart: string): void {
        this.store.setWeek(channelId, weekStart);
    }

    loadMoreRecipes(channelId: string): void {
        this.store.loadMoreRecipes(channelId);
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addRecipe(channelId: string, body: CreateRecipeDto): Observable<Recipe> {
        return this.store.addRecipe(channelId, body);
    }

    editRecipe(channelId: string, recipeId: string, body: UpdateRecipeDto): Observable<Recipe> {
        return this.store.editRecipe(channelId, recipeId, body);
    }

    removeRecipe(channelId: string, recipeId: string): Observable<void> {
        return this.store.removeRecipe(channelId, recipeId);
    }

    addEntry(channelId: string, body: CreateMealPlanEntryDto): Observable<MealPlanEntry> {
        return this.store.addEntry(channelId, body);
    }

    editEntry(channelId: string, entryId: string, body: UpdateMealPlanEntryDto): Observable<MealPlanEntry> {
        return this.store.editEntry(channelId, entryId, body);
    }

    removeEntry(channelId: string, entryId: string): Observable<void> {
        return this.store.removeEntry(channelId, entryId);
    }

    /** The plan-to-shopping-list button. The lines land on a different channel. */
    generateShoppingList(channelId: string, body: GenerateShoppingListDto): Observable<ShoppingListResult> {
        return this.store.generateShoppingList(channelId, body);
    }

    /** Uncached: the ranking moves every time anything in the pantry does. */
    cookable(
        channelId: string,
        expiringDays?: number | null,
        limit?: number | null,
    ): Observable<CookableResult> {
        return this.store.cookable(channelId, expiringDays, limit);
    }

    saveConfig(channelId: string, body: UpdateMealPlanConfigDto): Observable<MealPlanConfig> {
        return this.store.saveConfig(channelId, body);
    }
}
