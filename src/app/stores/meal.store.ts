import {computed, inject, Signal} from '@angular/core';
import {map, Observable, tap} from 'rxjs';
import {patchState, signalStore, type, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, withEntities} from '@ngrx/signals/entities';
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
    parsePlanDate,
    Recipe,
    RecipeCreated,
    RecipeDeleted,
    RecipeUpdated,
    RecipePage,
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
import {MealApiService} from '../services/meal-api.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {ListStore} from './list.store';
import {withKeyedIndex} from './foundation/with-keyed-index';

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

function byTitle(a: Recipe, b: Recipe): number {
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function byPlanOrder(a: MealPlanEntry, b: MealPlanEntry): number {
    return a.date.localeCompare(b.date) || a.position - b.position || a.id.localeCompare(b.id);
}

/** String comparison, which is exactly right for `yyyy-MM-dd` and needs no clock. */
function isInWeek(weekStart: string, date: string): boolean {
    return date >= weekStart && date <= lastDayOf(weekStart);
}

/** Monday to Sunday inclusive, so six days on. A seventh would pull next Monday into this week. */
function lastDayOf(weekStart: string): string {
    return toPlanDate(addPlanDays(parsePlanDate(weekStart), 6));
}

function currentWeekStart(): string {
    return toPlanDate(startOfPlanWeek(new Date()));
}

// `upsertEntities` merges rather than replaces, so an optional field the server omits instead of
// nulling would survive on the old row. Both rows here are mostly optional fields, and clearing one
// is an ordinary edit, so every row is completed before it reaches the entity map.
function wholeRecipe(raw: Recipe): Recipe {
    const recipe = normalizeRecipe(raw);
    return {
        ...recipe,
        description: recipe.description ?? null,
        prepMinutes: recipe.prepMinutes ?? null,
        sourceUrl: recipe.sourceUrl ?? null,
    };
}

function wholeEntry(raw: MealPlanEntry): MealPlanEntry {
    const entry = normalizeMealPlanEntry(raw);
    return {
        ...entry,
        recipeId: entry.recipeId ?? null,
        recipeTitle: entry.recipeTitle ?? null,
        freeText: entry.freeText ?? null,
        cookUserId: entry.cookUserId ?? null,
        servings: entry.servings ?? null,
    };
}

function sameRows<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((row, index) => row === b[index]);
}

function sameState(a: MealChannelState, b: MealChannelState): boolean {
    return (
        sameRows(a.recipes, b.recipes) &&
        sameRows(a.plan, b.plan) &&
        a.recipesCursor === b.recipesCursor &&
        a.weekStart === b.weekStart &&
        a.config === b.config &&
        a.loading === b.loading &&
        a.loaded === b.loaded &&
        a.forbidden === b.forbidden &&
        a.failed === b.failed
    );
}

interface MealScopedState {
    /** The week each opened board is showing, as a plain date. */
    weekByChannel: Record<string, string>;
    configByChannel: Record<string, MealPlanConfig>;
}

/**
 * The Meals module's state: the channel's recipes, one week of its plan, and the wiring that lets
 * the plan become a shopping list.
 *
 * Only one week is held per channel. The plan endpoint caps its window at 60 days and a house reads
 * its meals a week at a time, so the week is the plan load's argument rather than part of its key:
 * keying on it would keep a request record and a memoized view for every week anybody ever paged
 * through. Entries outside the week on screen are filtered at read time, which is also what keeps a
 * response for the week the user just left from drawing under the new week's dates.
 */
export const MealStore = signalStore(
    {providedIn: 'root'},
    withEntities<Recipe, 'recipe'>({entity: type<Recipe>(), collection: 'recipe'}),
    withEntities<MealPlanEntry, 'entry'>({entity: type<MealPlanEntry>(), collection: 'entry'}),
    withState<MealScopedState>({weekByChannel: {}, configByChannel: {}}),

    withKeyedIndex<Recipe, 'recipes', 'recipe', never, RecipePage>({
        collection: 'recipes',
        entities: 'recipe',
        sort: byTitle,
        // The socket replays nothing across a reconnect, so a board left open through a drop has
        // nothing left to invalidate it. Two minutes, checked when the channel is opened again.
        staleMs: 120_000,
        fetch: () => {
            const api = inject(MealApiService);
            return (channelId: string) => api.listRecipes(channelId);
        },
        rows: page => page.items.map(wholeRecipe),
        paging: {
            cursorOf: page => page.nextCursor ?? null,
            fetch: () => {
                const api = inject(MealApiService);
                return (channelId: string, cursor: string) => api.listRecipes(channelId, undefined, cursor);
            },
        },
    }),

    withKeyedIndex<MealPlanEntry, 'plan', 'entry', string>({
        collection: 'plan',
        entities: 'entry',
        sort: byPlanOrder,
        staleMs: 120_000,
        fetch: () => {
            const api = inject(MealApiService);
            return (channelId: string, weekStart?: string) => {
                const from = weekStart ?? currentWeekStart();
                return api
                    .listPlan(channelId, from, lastDayOf(from))
                    .pipe(map(entries => entries.map(wholeEntry)));
            };
        },
    }),

    withMethods((store, api = inject(MealApiService), lists = inject(ListStore)) => {
        const views = new Map<string, Signal<MealChannelState>>();

        const weekOf = (channelId: string): string => store.weekByChannel()[channelId] ?? currentWeekStart();

        const rememberWeek = (channelId: string, weekStart: string): void => {
            patchState(store, {weekByChannel: {...store.weekByChannel(), [channelId]: weekStart}});
        };

        const putConfig = (channelId: string, config: MealPlanConfig): void => {
            patchState(store, {configByChannel: {...store.configByChannel(), [channelId]: config}});
        };

        const fetchConfig = (channelId: string): void => {
            // It only decides which list and pantry the shopping button defaults to, so its
            // failure must not flag the channel.
            api.getConfig(channelId).subscribe({
                next: config => putConfig(channelId, config),
                error: () => undefined,
            });
        };

        const reload = (channelId: string, force: boolean): void => {
            const weekStart = weekOf(channelId);
            // The config is read on the first open and on an explicit refresh only; a re-open
            // inside the cache window has nothing to ask it.
            const first = !store.recipesTracked(channelId);
            rememberWeek(channelId, weekStart);
            store.loadRecipes(channelId, {force});
            store.loadPlan(channelId, {arg: weekStart, force});
            if (first || force) fetchConfig(channelId);
        };

        const setWeek = (channelId: string, weekStart: string): void => {
            if (weekOf(channelId) === weekStart) return;
            // The board reads the week off the state, so entries outside it stop being drawn
            // the moment this lands rather than a request later.
            rememberWeek(channelId, weekStart);
            reload(channelId, true);
        };

        const planRows = (channelId: string): MealPlanEntry[] => store.planFor(channelId)();

        // A write can reach a channel no fetch ever did, so the guard is `Held` and not
        // `Tracked`: the latter would call that channel unopened and go on ignoring every event
        // for the rows already on screen.
        const upsertRecipe = (channelId: string, raw: Recipe, existingOnly = false): void => {
            if (existingOnly && !store.recipesHeld(channelId)) return;
            store.attachToRecipes(channelId, wholeRecipe(raw));
        };

        const dropRecipe = (channelId: string, recipeId: string): void => {
            store.detachFromRecipes(channelId, recipeId);
            // The server deletes the entries naming it; without this the board would draw a
            // dinner whose title has just become unresolvable.
            for (const entry of planRows(channelId)) {
                if (entry.recipeId !== recipeId) continue;
                store.detachFromPlan(channelId, entry.id);
                patchState(store, removeEntity(entry.id, {collection: 'entry'}));
            }
            patchState(store, removeEntity(recipeId, {collection: 'recipe'}));
        };

        const upsertEntry = (channelId: string, raw: MealPlanEntry, existingOnly = false): void => {
            if (existingOnly && !store.planHeld(channelId)) return;
            store.attachToPlan(channelId, wholeEntry(raw));
        };

        const dropEntry = (channelId: string, entryId: string): void => {
            store.detachFromPlan(channelId, entryId);
            patchState(store, removeEntity(entryId, {collection: 'entry'}));
        };

        return {
            stateFor(channelId: string): Signal<MealChannelState> {
                const cached = views.get(channelId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const weekStart = weekOf(channelId);
                        const recipesError = store.recipesError(channelId);
                        const planError = store.planError(channelId);
                        const loading = store.recipesLoading(channelId) || store.planLoading(channelId);
                        const tracked = store.recipesTracked(channelId) || store.planTracked(channelId);
                        const forbidden = recipesError === 'forbidden' || planError === 'forbidden';

                        return {
                            recipes: store.recipesFor(channelId)(),
                            recipesCursor: store.recipesCursor(channelId),
                            plan: planRows(channelId).filter(entry => isInWeek(weekStart, entry.date)),
                            weekStart,
                            config: store.configByChannel()[channelId] ?? null,
                            loading,
                            // Sticky once anything has come back, so a refresh does not put the
                            // spinner back over a board that already has a week on it.
                            loaded:
                                store.recipesLoaded(channelId) ||
                                store.planLoaded(channelId) ||
                                (tracked && !loading),
                            forbidden,
                            failed: !forbidden && recipesError !== null && planError !== null,
                        };
                    },
                    {equal: sameState},
                );

                views.set(channelId, view);
                return view;
            },

            /** The seven days of the loaded week, as plain dates. What the board's columns are. */
            weekDatesFor(channelId: string): string[] {
                const start = startOfPlanWeek(parsePlanDate(weekOf(channelId)));
                return Array.from({length: 7}, (_, i) => toPlanDate(addPlanDays(start, i)));
            },

            recipeById(channelId: string, recipeId: string): Recipe | null {
                return (
                    store
                        .recipesFor(channelId)()
                        .find(recipe => recipe.id === recipeId) ?? null
                );
            },

            /** Cheap on every open: the indexes answer from cache until their window is out. */
            loadFor(channelId: string): void {
                reload(channelId, false);
            },

            refresh(channelId: string): void {
                reload(channelId, true);
            },

            setWeek,

            shiftWeek(channelId: string, weeks: number): void {
                const moved = addPlanDays(parsePlanDate(weekOf(channelId)), weeks * 7);
                setWeek(channelId, toPlanDate(moved));
            },

            addRecipe(channelId: string, body: CreateRecipeDto): Observable<Recipe> {
                return api.createRecipe(channelId, body).pipe(tap(recipe => upsertRecipe(channelId, recipe)));
            },

            editRecipe(channelId: string, recipeId: string, body: UpdateRecipeDto): Observable<Recipe> {
                return api.updateRecipe(recipeId, body).pipe(tap(recipe => upsertRecipe(channelId, recipe)));
            },

            removeRecipe(channelId: string, recipeId: string): Observable<void> {
                return api.deleteRecipe(recipeId).pipe(tap(() => dropRecipe(channelId, recipeId)));
            },

            addEntry(channelId: string, body: CreateMealPlanEntryDto): Observable<MealPlanEntry> {
                return api.createEntry(channelId, body).pipe(tap(entry => upsertEntry(channelId, entry)));
            },

            editEntry(
                channelId: string,
                entryId: string,
                body: UpdateMealPlanEntryDto,
            ): Observable<MealPlanEntry> {
                return api.updateEntry(entryId, body).pipe(tap(entry => upsertEntry(channelId, entry)));
            },

            removeEntry(channelId: string, entryId: string): Observable<void> {
                return api.deleteEntry(entryId).pipe(tap(() => dropEntry(channelId, entryId)));
            },

            /**
             * The plan-to-shopping-list button. The lines land on a different channel, which is
             * why this reaches across to {@link ListStore}: they also arrive there as
             * `guild.ListItemCreated`, but the person who pressed the button should not have to
             * wait for their own socket echo to see that it worked.
             */
            generateShoppingList(
                channelId: string,
                body: GenerateShoppingListDto,
            ): Observable<ShoppingListResult> {
                return api.generateShoppingList(channelId, body).pipe(
                    tap(result => {
                        const listChannelId =
                            body.listChannelId ?? store.configByChannel()[channelId]?.shoppingListChannelId;
                        if (listChannelId && result.added.length > 0) lists.reload(listChannelId);
                    }),
                );
            },

            /** Uncached: the ranking moves every time anything in the pantry does. */
            cookable(
                channelId: string,
                expiringDays?: number | null,
                limit?: number | null,
            ): Observable<CookableResult> {
                return api.cookable(channelId, expiringDays, limit);
            },

            saveConfig(channelId: string, body: UpdateMealPlanConfigDto): Observable<MealPlanConfig> {
                return api.putConfig(channelId, body).pipe(tap(config => putConfig(channelId, config)));
            },

            // ── Realtime ─────────────────────────────────────────────────
            //
            // Every handler bails on a channel nobody has opened. Accumulating events into a
            // channel that was never fetched produces a board showing only what happened since
            // the socket connected, which is worse than a spinner until it is opened.

            applyRecipeUpserted(event: RecipeCreated | RecipeUpdated): void {
                upsertRecipe(event.channelId, event.recipe, true);
            },

            applyRecipeDeleted(event: RecipeDeleted): void {
                if (!store.recipesTracked(event.channelId)) return;
                dropRecipe(event.channelId, event.recipeId);
            },

            applyEntryUpserted(event: MealPlanEntryCreated | MealPlanEntryUpdated): void {
                upsertEntry(event.channelId, event.entry, true);
            },

            applyEntryDeleted(event: MealPlanEntryDeleted): void {
                if (!store.planTracked(event.channelId)) return;
                dropEntry(event.channelId, event.entryId);
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.RecipeCreated').subscribe(e => store.applyRecipeUpserted(e));
            realtime.stream('guild.RecipeUpdated').subscribe(e => store.applyRecipeUpserted(e));
            realtime.stream('guild.RecipeDeleted').subscribe(e => store.applyRecipeDeleted(e));
            realtime.stream('guild.MealPlanEntryCreated').subscribe(e => store.applyEntryUpserted(e));
            realtime.stream('guild.MealPlanEntryUpdated').subscribe(e => store.applyEntryUpserted(e));
            realtime.stream('guild.MealPlanEntryDeleted').subscribe(e => store.applyEntryDeleted(e));
        },
    }),
);
