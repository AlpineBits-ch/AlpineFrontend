import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {forkJoin, Observable, of, tap} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {
    addPlanDays,
    CookableResult,
    MealPlanConfig,
    MealPlanEntry,
    MealPlanEntryCreated,
    MealPlanEntryDeleted,
    MealPlanEntryUpdated,
    normalizeMealPlanEntry,
    normalizeRecipe,
    Recipe,
    RecipeCreated,
    RecipeDeleted,
    RecipeUpdated,
    ShoppingListResult,
    startOfPlanWeek,
    toPlanDate,
} from '../dtos/response/meal.dto';
import {
    CreateMealPlanEntryDto,
    CreateRecipeDto,
    GenerateShoppingListDto,
    UpdateMealPlanConfigDto,
    UpdateMealPlanEntryDto,
    UpdateRecipeDto,
} from '../dtos/request/meal.dto';
import {MealApiService} from './meal-api.service';
import {ListService} from './list.service';
import {RealtimeConnectionService} from './realtime-connection.service';

export interface MealChannelState {
    recipes: Recipe[];
    /** The cursor for older recipes, or `null` at the end. */
    recipesCursor: string | null;
    /** Only the loaded week's entries. Moving the week replaces them rather than accumulating. */
    plan: MealPlanEntry[];
    /** The Monday the loaded plan starts on, as a plain date. */
    weekStart: string;
    config: MealPlanConfig | null;
    loading: boolean;
    loaded: boolean;
    /** A `403` - the house has no Meals module. Render nothing, never a denial. */
    forbidden: boolean;
    failed: boolean;
}

function emptyState(): MealChannelState {
    return {
        recipes: [],
        recipesCursor: null,
        plan: [],
        weekStart: toPlanDate(startOfPlanWeek(new Date())),
        config: null,
        loading: false,
        loaded: false,
        forbidden: false,
        failed: false,
    };
}

/**
 * The Meals module's state: the channel's recipes, one week of its plan, and the wiring that lets
 * the plan become a shopping list.
 *
 * <p><b>Only one week is held.</b> The plan endpoint caps its window at 60 days and a house reads
 * its meals a week at a time, so holding a rolling accumulation of every week anybody has paged
 * through buys nothing and makes "which entries belong to the week on screen" a question with two
 * answers. Moving the week is a fresh read.</p>
 */
@Injectable({providedIn: 'root'})
export class MealService {
    private api = inject(MealApiService);
    private lists = inject(ListService);
    private realtime = inject(RealtimeConnectionService);

    private readonly states = signal<Record<string, MealChannelState>>({});
    private readonly requested = new Set<string>();

    constructor() {
        // Registered once, here, in a root singleton - `RealtimeConnectionService.on` does not
        // deduplicate, and a plan that grew a duplicate Thursday would read as two dinners.
        this.realtime.on('guild.RecipeCreated', (d: RecipeCreated) => this.onRecipeUpserted(d));
        this.realtime.on('guild.RecipeUpdated', (d: RecipeUpdated) => this.onRecipeUpserted(d));
        this.realtime.on('guild.RecipeDeleted', (d: RecipeDeleted) => this.onRecipeDeleted(d));
        this.realtime.on('guild.MealPlanEntryCreated', (d: MealPlanEntryCreated) => this.onEntryUpserted(d));
        this.realtime.on('guild.MealPlanEntryUpdated', (d: MealPlanEntryUpdated) => this.onEntryUpserted(d));
        this.realtime.on('guild.MealPlanEntryDeleted', (d: MealPlanEntryDeleted) => this.onEntryDeleted(d));
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): MealChannelState {
        return this.states()[channelId] ?? emptyState();
    }

    /** The seven days of the loaded week, as plain dates. What the board's columns are. */
    weekDatesFor(channelId: string): string[] {
        const start = startOfPlanWeek(new Date(this.stateFor(channelId).weekStart + 'T00:00:00'));
        return Array.from({length: 7}, (_, i) => toPlanDate(addPlanDays(start, i)));
    }

    recipeById(channelId: string, recipeId: string): Recipe | null {
        return this.stateFor(channelId).recipes.find(r => r.id === recipeId) ?? null;
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        if (this.requested.has(channelId)) return;
        this.requested.add(channelId);
        this.refresh(channelId);
    }

    refresh(channelId: string): void {
        const weekStart = this.stateFor(channelId).weekStart;
        this.patch(channelId, state => ({...state, loading: true, failed: false}));

        // The week runs Monday to Sunday inclusive, so the `to` is six days on rather than seven -
        // an eighth day would pull in next Monday and draw it into this week's column count.
        const to = toPlanDate(addPlanDays(new Date(weekStart + 'T00:00:00'), 6));

        forkJoin({
            recipes: this.api.listRecipes(channelId)
                .pipe(catchError((err: unknown) => this.swallow<{items: Recipe[]; nextCursor: string | null}>(channelId, err))),
            plan: this.api.listPlan(channelId, weekStart, to)
                .pipe(catchError((err: unknown) => this.swallow<MealPlanEntry[]>(channelId, err))),
        }).subscribe(({recipes, plan}) => {
            this.patch(channelId, state => ({
                ...state,
                recipes: (recipes?.items ?? []).map(normalizeRecipe),
                recipesCursor: recipes?.nextCursor ?? null,
                // Dropped if the week moved while this was in the air: applying it would draw last
                // week's dinners under this week's dates.
                plan: state.weekStart === weekStart
                    ? (plan ?? []).map(normalizeMealPlanEntry)
                    : state.plan,
                loading: false,
                loaded: true,
                failed: !state.forbidden && recipes === null && plan === null,
            }));
        });

        this.api.getConfig(channelId).subscribe({
            // A missing config is survivable - it only decides which list and pantry the shopping
            // button defaults to - so it does not flag the channel as failed.
            next: config => this.patch(channelId, state => ({...state, config})),
            error: () => undefined,
        });
    }

    /** Moves the board a week at a time. Always a fresh read - see the class doc. */
    shiftWeek(channelId: string, weeks: number): void {
        const current = new Date(this.stateFor(channelId).weekStart + 'T00:00:00');
        this.setWeek(channelId, toPlanDate(addPlanDays(current, weeks * 7)));
    }

    setWeek(channelId: string, weekStart: string): void {
        if (this.stateFor(channelId).weekStart === weekStart) return;
        // The entries are cleared with the date rather than left in place: a board that keeps last
        // week's dinners under this week's headings for the length of a request is worse than an
        // empty one, because it is wrong rather than merely absent.
        this.patch(channelId, state => ({...state, weekStart, plan: []}));
        this.refresh(channelId);
    }

    loadMoreRecipes(channelId: string): void {
        const state = this.stateFor(channelId);
        if (!state.recipesCursor || state.loading) return;

        const cursor = state.recipesCursor;
        this.api.listRecipes(channelId, undefined, cursor).subscribe({
            next: page => this.patch(channelId, current => {
                if (current.recipesCursor !== cursor) return current;
                const held = new Set(current.recipes.map(r => r.id));
                return {
                    ...current,
                    recipes: [...current.recipes, ...page.items.filter(r => !held.has(r.id)).map(normalizeRecipe)],
                    recipesCursor: page.nextCursor ?? null,
                };
            }),
            error: () => undefined,
        });
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addRecipe(channelId: string, body: CreateRecipeDto): Observable<Recipe> {
        return this.api.createRecipe(channelId, body)
            .pipe(tap(recipe => this.upsertRecipe(channelId, recipe)));
    }

    editRecipe(channelId: string, recipeId: string, body: UpdateRecipeDto): Observable<Recipe> {
        return this.api.updateRecipe(recipeId, body)
            .pipe(tap(recipe => this.upsertRecipe(channelId, recipe)));
    }

    removeRecipe(channelId: string, recipeId: string): Observable<void> {
        return this.api.deleteRecipe(recipeId).pipe(tap(() => this.dropRecipe(channelId, recipeId)));
    }

    addEntry(channelId: string, body: CreateMealPlanEntryDto): Observable<MealPlanEntry> {
        return this.api.createEntry(channelId, body)
            .pipe(tap(entry => this.upsertEntry(channelId, entry)));
    }

    editEntry(channelId: string, entryId: string, body: UpdateMealPlanEntryDto): Observable<MealPlanEntry> {
        return this.api.updateEntry(entryId, body)
            .pipe(tap(entry => this.upsertEntry(channelId, entry)));
    }

    removeEntry(channelId: string, entryId: string): Observable<void> {
        return this.api.deleteEntry(entryId).pipe(tap(() => this.dropEntry(channelId, entryId)));
    }

    /**
     * The plan-to-shopping-list button.
     *
     * <p>The lines land on a <b>different channel</b>, which is why this reaches across to
     * {@link ListService}: the shopper may well have the list open on another device, and it also
     * arrives there as `guild.ListItemCreated` - but the person who pressed the button should not
     * have to wait for their own socket echo to see that it worked.</p>
     */
    generateShoppingList(channelId: string, body: GenerateShoppingListDto): Observable<ShoppingListResult> {
        return this.api.generateShoppingList(channelId, body).pipe(tap(result => {
            const listChannelId = body.listChannelId ?? this.stateFor(channelId).config?.shoppingListChannelId;
            if (listChannelId && result.added.length > 0) this.lists.reload(listChannelId);
        }));
    }

    /** Uncached: the ranking moves every time anything in the pantry does. */
    cookable(channelId: string, expiringDays?: number | null, limit?: number | null): Observable<CookableResult> {
        return this.api.cookable(channelId, expiringDays, limit);
    }

    saveConfig(channelId: string, body: UpdateMealPlanConfigDto): Observable<MealPlanConfig> {
        return this.api.putConfig(channelId, body)
            .pipe(tap(config => this.patch(channelId, state => ({...state, config}))));
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    private onRecipeUpserted(event: RecipeCreated | RecipeUpdated): void {
        this.upsertRecipe(event.channelId, event.recipe, true);
    }

    private onRecipeDeleted(event: RecipeDeleted): void {
        this.patchExisting(event.channelId, state => ({
            ...state,
            recipes: state.recipes.filter(r => r.id !== event.recipeId),
            // Entries pointing at it go too. The server deletes them; without this the board would
            // draw a dinner whose title has just become unresolvable.
            plan: state.plan.filter(e => e.recipeId !== event.recipeId),
        }));
    }

    private onEntryUpserted(event: MealPlanEntryCreated | MealPlanEntryUpdated): void {
        this.upsertEntry(event.channelId, event.entry, true);
    }

    private onEntryDeleted(event: MealPlanEntryDeleted): void {
        this.patchExisting(event.channelId, state => ({
            ...state,
            plan: state.plan.filter(e => e.id !== event.entryId),
        }));
    }

    // ── State plumbing ───────────────────────────────────────────────────────

    private upsertRecipe(channelId: string, raw: Recipe, existingOnly = false): void {
        const recipe = normalizeRecipe(raw);
        const apply = (state: MealChannelState): MealChannelState => ({
            ...state,
            recipes: [...state.recipes.filter(r => r.id !== recipe.id), recipe]
                .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
        });
        if (existingOnly) this.patchExisting(channelId, apply); else this.patch(channelId, apply);
    }

    private dropRecipe(channelId: string, recipeId: string): void {
        this.patch(channelId, state => ({
            ...state,
            recipes: state.recipes.filter(r => r.id !== recipeId),
            plan: state.plan.filter(e => e.recipeId !== recipeId),
        }));
    }

    /**
     * Applies one entry, and drops it if it has moved out of the loaded week.
     *
     * <p>Dragging Thursday's dinner to next Monday arrives as an `Updated` carrying a date this
     * board is not showing - keeping it would put next week's meal in this week's column, since the
     * board groups by date and every date it does not recognise falls off the end.</p>
     */
    private upsertEntry(channelId: string, raw: MealPlanEntry, existingOnly = false): void {
        const entry = normalizeMealPlanEntry(raw);
        const apply = (state: MealChannelState): MealChannelState => {
            const rest = state.plan.filter(e => e.id !== entry.id);
            const inWeek = this.isInWeek(state.weekStart, entry.date);
            return {
                ...state,
                plan: inWeek ? this.sortedPlan([...rest, entry]) : rest,
            };
        };
        if (existingOnly) this.patchExisting(channelId, apply); else this.patch(channelId, apply);
    }

    private dropEntry(channelId: string, entryId: string): void {
        this.patch(channelId, state => ({
            ...state,
            plan: state.plan.filter(e => e.id !== entryId),
        }));
    }

    /** String comparison, which is exactly right for `yyyy-MM-dd` and needs no clock. */
    private isInWeek(weekStart: string, date: string): boolean {
        const end = toPlanDate(addPlanDays(new Date(weekStart + 'T00:00:00'), 6));
        return date >= weekStart && date <= end;
    }

    /** By date, then by the order a day runs, then by the position the user chose. */
    private sortedPlan(plan: MealPlanEntry[]): MealPlanEntry[] {
        return [...plan].sort((a, b) =>
            a.date.localeCompare(b.date)
            || a.position - b.position
            || a.id.localeCompare(b.id));
    }

    private patch(channelId: string, fn: (state: MealChannelState) => MealChannelState): void {
        this.states.update(all => ({...all, [channelId]: fn(all[channelId] ?? emptyState())}));
    }

    private patchExisting(channelId: string, fn: (state: MealChannelState) => MealChannelState): void {
        this.states.update(all => all[channelId] ? {...all, [channelId]: fn(all[channelId])} : all);
    }

    private swallow<T>(channelId: string, err: unknown): Observable<T | null> {
        if (err instanceof HttpErrorResponse && err.status === 403) {
            this.patch(channelId, state => ({...state, forbidden: true}));
        }
        return of(null);
    }
}
