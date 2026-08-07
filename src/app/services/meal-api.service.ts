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
 * The Meals HTTP surface, and nothing else.
 *
 * <p>The one call worth reading twice is {@link generateShoppingList}. Everything else here is
 * bookkeeping that exists to make it possible, and its answer is the only one in the module whose
 * <i>negative</i> half has to reach the screen: what it skipped, and why.</p>
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
     * The plan over a window of plain dates. The server caps the window at 60 days.
     *
     * <p>`from`/`to` are `yyyy-MM-dd`, not instants: "Thursday dinner" is Thursday dinner wherever
     * the phone is, and sending an ISO instant would move a quarter of the week across a date
     * boundary for anybody travelling.</p>
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
     * target list.
     *
     * <p>It collects the window's ingredients, drops what the pantry already has and what is already
     * on the list, and appends the rest with `section` set to the recipe's title. <b>Both skip
     * lists have to be rendered</b>: a shopper who cannot see why "onions" is missing will not press
     * the button twice, and the whole module is worth having only if that button is trusted.</p>
     *
     * <p>Ingredients are deliberately not scaled by servings - a recipe for four does not need eight
     * onions to feed eight, and guessing which lines scale is how a list stops being useful.</p>
     */
    generateShoppingList(channelId: string, body: GenerateShoppingListDto): Observable<ShoppingListResult> {
        return this.http.post<ShoppingListResult>(
            `${this.base}/channels/${channelId}/meal-plan/shopping-list`, body);
    }

    /**
     * Recipes ranked by how much about-to-expire stock they use up.
     *
     * <p>`expiringCount` descending, then `missingCount` ascending. Two sort keys somebody can
     * predict, which is why there is no weighting to configure.</p>
     */
    cookable(channelId: string, expiringDays?: number | null, limit?: number | null): Observable<CookableResult> {
        let params = new HttpParams();
        if (expiringDays != null) params = params.set('expiringDays', expiringDays);
        if (limit != null) params = params.set('limit', limit);
        return this.http.get<CookableResult>(`${this.base}/channels/${channelId}/recipes/cookable`, {params});
    }

    // ── Config ───────────────────────────────────────────────────────────────

    getConfig(channelId: string): Observable<MealPlanConfig> {
        return this.http.get<MealPlanConfig>(`${this.base}/channels/${channelId}/meals/config`);
    }

    /** `ManageMeals`. Full replace; `clear*` rather than null ids - null reads as "leave alone". */
    putConfig(channelId: string, body: UpdateMealPlanConfigDto): Observable<MealPlanConfig> {
        return this.http.put<MealPlanConfig>(`${this.base}/channels/${channelId}/meals/config`, body);
    }
}
