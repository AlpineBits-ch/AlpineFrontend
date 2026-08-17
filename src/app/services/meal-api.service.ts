import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    CookableResult,
    MealPlanConfig,
    MealPlanEntry,
    Recipe,
    RecipePage,
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

/** Recipes per page. Two hundred is the whole channel's cap, so one page is usually all of it. */
export const RECIPE_PAGE_SIZE = 50;

/**
 * The Meals HTTP surface, and nothing else. {@link generateShoppingList} is the one call whose
 * negative half has to reach the screen: what it skipped, and why.
 */
@Injectable({providedIn: 'root'})
export class MealApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Recipes ──────────────────────────────────────────────────────────────

    listRecipes(channelId: string, limit = RECIPE_PAGE_SIZE, cursor?: string | null): Observable<RecipePage> {
        let params = new HttpParams().set('limit', limit);
        if (cursor) params = params.set('cursor', cursor);
        return this.http.get<RecipePage>(`${this.base}/channels/${channelId}/recipes`, {params});
    }

    getRecipe(recipeId: string): Observable<Recipe> {
        return this.http.get<Recipe>(`${this.base}/recipes/${recipeId}`);
    }

    /** `PlanMeals`. */
    createRecipe(channelId: string, body: CreateRecipeDto): Observable<Recipe> {
        return this.http.post<Recipe>(`${this.base}/channels/${channelId}/recipes`, body);
    }

    /** Your own with `PlanMeals`; anyone else's needs `ManageMeals`. */
    updateRecipe(recipeId: string, body: UpdateRecipeDto): Observable<Recipe> {
        return this.http.patch<Recipe>(`${this.base}/recipes/${recipeId}`, body);
    }

    deleteRecipe(recipeId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/recipes/${recipeId}`);
    }

    // ── The plan ─────────────────────────────────────────────────────────────

    /**
     * The plan over a window of plain dates; the server caps the window at 60 days. `from`/`to`
     * must be `yyyy-MM-dd` and never instants, or travel moves days across a date boundary.
     */
    listPlan(channelId: string, from: string, to: string): Observable<MealPlanEntry[]> {
        const params = new HttpParams().set('from', from).set('to', to);
        return this.http.get<MealPlanEntry[]>(`${this.base}/channels/${channelId}/meal-plan`, {params});
    }

    createEntry(channelId: string, body: CreateMealPlanEntryDto): Observable<MealPlanEntry> {
        return this.http.post<MealPlanEntry>(`${this.base}/channels/${channelId}/meal-plan`, body);
    }

    updateEntry(entryId: string, body: UpdateMealPlanEntryDto): Observable<MealPlanEntry> {
        return this.http.patch<MealPlanEntry>(`${this.base}/meal-plan/${entryId}`, body);
    }

    deleteEntry(entryId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/meal-plan/${entryId}`);
    }

    /**
     * Turns a window of the plan into shopping-list lines. `PlanMeals`, plus `AddListItems` on the
     * target list. Both skip lists have to be rendered, or a shopper cannot see why a line is
     * missing. Ingredients are not scaled by servings.
     */
    generateShoppingList(channelId: string, body: GenerateShoppingListDto): Observable<ShoppingListResult> {
        return this.http.post<ShoppingListResult>(
            `${this.base}/channels/${channelId}/meal-plan/shopping-list`,
            body,
        );
    }

    /**
     * Recipes ranked by how much about-to-expire stock they use up: `expiringCount` descending,
     * then `missingCount` ascending.
     */
    cookable(
        channelId: string,
        expiringDays?: number | null,
        limit?: number | null,
    ): Observable<CookableResult> {
        let params = new HttpParams();
        if (expiringDays != null) params = params.set('expiringDays', expiringDays);
        if (limit != null) params = params.set('limit', limit);
        return this.http.get<CookableResult>(`${this.base}/channels/${channelId}/recipes/cookable`, {params});
    }

    // ── Config ───────────────────────────────────────────────────────────────

    getConfig(channelId: string): Observable<MealPlanConfig> {
        return this.http.get<MealPlanConfig>(`${this.base}/channels/${channelId}/meals/config`);
    }

    /** `ManageMeals`. Full replace; use `clear*` rather than null ids, which read as "leave alone". */
    putConfig(channelId: string, body: UpdateMealPlanConfigDto): Observable<MealPlanConfig> {
        return this.http.put<MealPlanConfig>(`${this.base}/channels/${channelId}/meals/config`, body);
    }
}
