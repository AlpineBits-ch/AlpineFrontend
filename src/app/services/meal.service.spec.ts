import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting, TestRequest} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {Observable, Subject} from 'rxjs';

import {MealService} from './meal.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {
    addPlanDays,
    MealPlanConfig,
    MealPlanEntry,
    MealSlot,
    Recipe,
    startOfPlanWeek,
    toPlanDate,
} from '../dtos/response/meal.dto';

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;
const CHANNEL = 'chan_meals';
const GUILD_ID = 'gild_1';
const LIST_CHANNEL = 'chan_list';

/** The Monday the board opens on. Derived the same way the module does, so the spec has no clock of its own. */
const MONDAY = toPlanDate(startOfPlanWeek(new Date()));
const SUNDAY = toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 6));

const RECIPES_URL = `${GUILD}/channels/${CHANNEL}/recipes`;
const PLAN_URL = `${GUILD}/channels/${CHANNEL}/meal-plan`;
const CONFIG_URL = `${GUILD}/channels/${CHANNEL}/meals/config`;
const COOKABLE_URL = `${GUILD}/channels/${CHANNEL}/recipes/cookable`;

/**
 * Captures what subscribed at startup so the spec can push events at it. Speaks both conventions:
 * `on` for a service that never moved, `stream` for one that became a store.
 */
class FakeRealtime {
    readonly registrations: string[] = [];
    private readonly subjects = new Map<string, Subject<any>>();

    stream(event: string): Observable<unknown> {
        this.registrations.push(event);
        return this.subjectFor(event).asObservable();
    }

    on(event: string, handler: (payload: unknown) => void): void {
        this.registrations.push(event);
        this.subjectFor(event).subscribe(payload => handler(payload));
    }

    emit(event: string, payload: unknown): void {
        this.subjectFor(event).next(payload);
    }

    /** How many subscribers a name got. Two would deliver every event twice. */
    countFor(event: string): number {
        return this.registrations.filter(name => name === event).length;
    }

    private subjectFor(event: string): Subject<any> {
        let subject = this.subjects.get(event);
        if (!subject) {
            subject = new Subject<any>();
            this.subjects.set(event, subject);
        }
        return subject;
    }
}

function setup() {
    const realtime = new FakeRealtime();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: RealtimeConnectionService, useValue: realtime},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
        ],
    });

    return {
        service: TestBed.inject(MealService),
        ctrl: TestBed.inject(HttpTestingController),
        realtime,
    };
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
    return {
        id: 'rcp_1',
        channelId: CHANNEL,
        title: 'Chili',
        servings: 2,
        createdByUserId: 'user_1',
        ingredients: [],
        createdAt: '2026-08-01T00:00:00Z',
        ...overrides,
    };
}

function entry(overrides: Partial<MealPlanEntry> = {}): MealPlanEntry {
    return {
        id: 'mpe_1',
        channelId: CHANNEL,
        date: MONDAY,
        slot: MealSlot.Dinner,
        recipeTitle: 'Chili',
        position: 0,
        ...overrides,
    };
}

function config(overrides: Partial<MealPlanConfig> = {}): MealPlanConfig {
    return {
        channelId: CHANNEL,
        shoppingListChannelId: LIST_CHANNEL,
        pantryChannelId: 'chan_pantry',
        ...overrides,
    };
}

/** The row as a server that drops a cleared field would send it, rather than nulling it. */
function without<T extends object>(row: T, ...fields: (keyof T)[]): Partial<T> {
    const copy = {...row};
    for (const field of fields) delete copy[field];
    return copy;
}

function expectOne(ctrl: HttpTestingController, url: string, method?: string): TestRequest {
    return ctrl.expectOne(r => r.url === url && (method === undefined || r.method === method));
}

interface LoadPayload {
    recipes?: Recipe[];
    cursor?: string | null;
    plan?: MealPlanEntry[];
    config?: MealPlanConfig;
}

/** Opens the channel and answers all three of `refresh`'s requests. */
function load(service: MealService, ctrl: HttpTestingController, payload: LoadPayload = {}) {
    service.loadFor(CHANNEL);
    settle(ctrl, payload);
}

/** Answers the three requests a refresh puts on the wire, whoever started it. */
function settle(ctrl: HttpTestingController, payload: LoadPayload = {}) {
    expectOne(ctrl, RECIPES_URL, 'GET').flush({
        items: payload.recipes ?? [],
        nextCursor: payload.cursor ?? null,
    });
    expectOne(ctrl, PLAN_URL, 'GET').flush(payload.plan ?? []);
    expectOne(ctrl, CONFIG_URL, 'GET').flush(payload.config ?? config());
}

function planIds(service: MealService): string[] {
    return service.stateFor(CHANNEL).plan.map(e => e.id);
}

function recipeIds(service: MealService): string[] {
    return service.stateFor(CHANNEL).recipes.map(r => r.id);
}

function scoped(extra: Record<string, unknown>) {
    return {guildId: GUILD_ID, channelId: CHANNEL, ...extra};
}

describe('MealService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('realtime registration', () => {
        it('registers each of the six meal events exactly once', () => {
            const {realtime} = setup();
            for (const event of [
                'guild.RecipeCreated',
                'guild.RecipeUpdated',
                'guild.RecipeDeleted',
                'guild.MealPlanEntryCreated',
                'guild.MealPlanEntryUpdated',
                'guild.MealPlanEntryDeleted',
            ]) {
                expect(realtime.countFor(event)).toBe(1);
            }
        });

        // An automatic restock emits it too, so a second subscriber here would double every row.
        it('leaves guild.ListItemCreated to the Lists module', () => {
            const {realtime} = setup();
            expect(realtime.countFor('guild.ListItemCreated')).toBe(1);
        });
    });

    describe('loading', () => {
        it('reads recipes, the week and the config on the first open', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()], plan: [entry()]});

            expect(recipeIds(service)).toEqual(['rcp_1']);
            expect(planIds(service)).toEqual(['mpe_1']);
            expect(service.stateFor(CHANNEL).config?.shoppingListChannelId).toBe(LIST_CHANNEL);
            expect(service.stateFor(CHANNEL).loaded).toBe(true);
            expect(service.stateFor(CHANNEL).loading).toBe(false);
        });

        it('asks for the plan Monday to Sunday inclusive', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);

            expectOne(ctrl, RECIPES_URL, 'GET').flush({items: [], nextCursor: null});
            const plan = expectOne(ctrl, PLAN_URL, 'GET');
            expect(plan.request.params.get('from')).toBe(MONDAY);
            expect(plan.request.params.get('to')).toBe(SUNDAY);
            plan.flush([]);
            expectOne(ctrl, CONFIG_URL, 'GET').flush(config());
        });

        it('is idempotent per channel however often loadFor is called', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()]});
            service.loadFor(CHANNEL);
            ctrl.expectNone(r => r.url === RECIPES_URL);
            expect(recipeIds(service)).toEqual(['rcp_1']);
        });

        it('reads the board again when it is opened after the cache window', () => {
            vi.useFakeTimers();
            try {
                const {service, ctrl} = setup();
                load(service, ctrl, {recipes: [recipe()]});

                vi.advanceTimersByTime(200_000);
                service.loadFor(CHANNEL);

                expectOne(ctrl, RECIPES_URL, 'GET').flush({items: [recipe()], nextCursor: null});
                expectOne(ctrl, PLAN_URL, 'GET').flush([]);
                // The config is not part of the window; it only names the default list and pantry.
                ctrl.expectNone(r => r.url === CONFIG_URL);
            } finally {
                vi.useRealTimers();
            }
        });

        it('refetches on an explicit refresh', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()]});
            service.refresh(CHANNEL);
            settle(ctrl, {recipes: [recipe({id: 'rcp_2', title: 'Curry'})]});
            expect(recipeIds(service)).toEqual(['rcp_2']);
        });

        it('reports loading until the reads come back', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expect(service.stateFor(CHANNEL).loading).toBe(true);
            expect(service.stateFor(CHANNEL).loaded).toBe(false);
            settle(ctrl);
            expect(service.stateFor(CHANNEL).loading).toBe(false);
        });

        // The board keeps drawing what it has; the spinner is for a channel with nothing on it yet.
        it('stays loaded across a refresh', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()]});
            service.refresh(CHANNEL);

            expect(service.stateFor(CHANNEL).loaded).toBe(true);
            expect(service.stateFor(CHANNEL).loading).toBe(true);
            settle(ctrl, {recipes: [recipe()]});
        });

        it('hands an unopened channel an empty state rather than null', () => {
            const {service} = setup();
            const state = service.stateFor('chan_never_opened');
            expect(state.recipes).toEqual([]);
            expect(state.plan).toEqual([]);
            expect(state.loaded).toBe(false);
            expect(state.weekStart).toBe(MONDAY);
        });

        it('flags forbidden on a 403, which is what a house without the module gets', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expectOne(ctrl, RECIPES_URL, 'GET').flush('no', {status: 403, statusText: 'Forbidden'});
            expectOne(ctrl, PLAN_URL, 'GET').flush('no', {status: 403, statusText: 'Forbidden'});
            expectOne(ctrl, CONFIG_URL, 'GET').flush('no', {status: 403, statusText: 'Forbidden'});

            expect(service.stateFor(CHANNEL).forbidden).toBe(true);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('flags failed only when both reads fail for a reason other than permission', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expectOne(ctrl, RECIPES_URL, 'GET').flush('no', {status: 500, statusText: 'Server Error'});
            expectOne(ctrl, PLAN_URL, 'GET').flush('no', {status: 500, statusText: 'Server Error'});
            expectOne(ctrl, CONFIG_URL, 'GET').flush('no', {status: 500, statusText: 'Server Error'});

            expect(service.stateFor(CHANNEL).failed).toBe(true);
            expect(service.stateFor(CHANNEL).forbidden).toBe(false);
        });

        it('keeps the week when only the recipe read fails', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expectOne(ctrl, RECIPES_URL, 'GET').flush('no', {status: 500, statusText: 'Server Error'});
            expectOne(ctrl, PLAN_URL, 'GET').flush([entry()]);
            expectOne(ctrl, CONFIG_URL, 'GET').flush(config());

            expect(planIds(service)).toEqual(['mpe_1']);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        // The config only decides which list and pantry the shopping button defaults to.
        it('survives a config read that fails on its own', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expectOne(ctrl, RECIPES_URL, 'GET').flush({items: [recipe()], nextCursor: null});
            expectOne(ctrl, PLAN_URL, 'GET').flush([]);
            expectOne(ctrl, CONFIG_URL, 'GET').flush('no', {status: 500, statusText: 'Server Error'});

            expect(recipeIds(service)).toEqual(['rcp_1']);
            expect(service.stateFor(CHANNEL).config).toBeNull();
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });
    });

    describe('the week', () => {
        it('lists the seven days of the loaded week', () => {
            const {service} = setup();
            const dates = service.weekDatesFor(CHANNEL);
            expect(dates.length).toBe(7);
            expect(dates[0]).toBe(MONDAY);
            expect(dates[6]).toBe(SUNDAY);
        });

        it('moves a week at a time and reads the new window', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry()]});

            service.shiftWeek(CHANNEL, 1);
            const nextMonday = toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 7));
            expect(service.stateFor(CHANNEL).weekStart).toBe(nextMonday);

            expectOne(ctrl, RECIPES_URL, 'GET').flush({items: [], nextCursor: null});
            const plan = expectOne(ctrl, PLAN_URL, 'GET');
            expect(plan.request.params.get('from')).toBe(nextMonday);
            expect(plan.request.params.get('to')).toBe(
                toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 13)),
            );
            plan.flush([entry({id: 'mpe_next', date: nextMonday})]);
            expectOne(ctrl, CONFIG_URL, 'GET').flush(config());

            expect(planIds(service)).toEqual(['mpe_next']);
        });

        it('goes back a week too', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);
            service.shiftWeek(CHANNEL, -1);
            expect(service.stateFor(CHANNEL).weekStart).toBe(
                toPlanDate(addPlanDays(startOfPlanWeek(new Date()), -7)),
            );
            settle(ctrl);
        });

        // Last week's dinners under this week's headings is worse than an empty board.
        it('clears the entries the moment the week moves', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry()]});
            expect(planIds(service)).toEqual(['mpe_1']);

            service.shiftWeek(CHANNEL, 1);
            expect(planIds(service)).toEqual([]);
            settle(ctrl);
        });

        it('does nothing when asked for the week already on screen', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry()]});
            service.setWeek(CHANNEL, MONDAY);
            ctrl.expectNone(r => r.url === PLAN_URL);
            expect(planIds(service)).toEqual(['mpe_1']);
        });

        it('snaps a mid-week date back to its Monday when listing the days', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);
            const wednesday = toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 9));
            service.setWeek(CHANNEL, wednesday);
            settle(ctrl);

            expect(service.stateFor(CHANNEL).weekStart).toBe(wednesday);
            expect(service.weekDatesFor(CHANNEL)[0]).toBe(
                toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 7)),
            );
        });
    });

    describe('recipe paging', () => {
        it('appends the next page and carries the new cursor', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()], cursor: 'cur_1'});

            service.loadMoreRecipes(CHANNEL);
            const page = expectOne(ctrl, RECIPES_URL, 'GET');
            expect(page.request.params.get('cursor')).toBe('cur_1');
            page.flush({items: [recipe({id: 'rcp_2', title: 'Curry'})], nextCursor: null});

            expect(recipeIds(service)).toEqual(['rcp_1', 'rcp_2']);
            expect(service.stateFor(CHANNEL).recipesCursor).toBeNull();
        });

        it('does not re-add a row the first page already held', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()], cursor: 'cur_1'});

            service.loadMoreRecipes(CHANNEL);
            expectOne(ctrl, RECIPES_URL, 'GET').flush({items: [recipe()], nextCursor: null});

            expect(recipeIds(service)).toEqual(['rcp_1']);
        });

        it('stops at the end of the list', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()], cursor: null});
            service.loadMoreRecipes(CHANNEL);
            ctrl.expectNone(r => r.url === RECIPES_URL);
        });

        it('does not page while the channel is still loading', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()], cursor: 'cur_1'});
            service.refresh(CHANNEL);
            service.loadMoreRecipes(CHANNEL);

            // Only the refresh's own read, never a second one carrying the cursor.
            expectOne(ctrl, RECIPES_URL, 'GET').flush({items: [recipe()], nextCursor: null});
            expectOne(ctrl, PLAN_URL, 'GET').flush([]);
            expectOne(ctrl, CONFIG_URL, 'GET').flush(config());
        });
    });

    describe('recipe writes', () => {
        it('applies the server echo without waiting for the broadcast', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.addRecipe(CHANNEL, {title: 'Curry'}).subscribe();
            expectOne(ctrl, RECIPES_URL, 'POST').flush(recipe({id: 'rcp_2', title: 'Curry'}));

            expect(recipeIds(service)).toEqual(['rcp_2']);
        });

        it('holds recipes in title order', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.addRecipe(CHANNEL, {title: 'Stew'}).subscribe();
            expectOne(ctrl, RECIPES_URL, 'POST').flush(recipe({id: 'rcp_s', title: 'Stew'}));
            service.addRecipe(CHANNEL, {title: 'Curry'}).subscribe();
            expectOne(ctrl, RECIPES_URL, 'POST').flush(recipe({id: 'rcp_c', title: 'Curry'}));

            expect(service.stateFor(CHANNEL).recipes.map(r => r.title)).toEqual(['Curry', 'Stew']);
        });

        it('replaces rather than duplicates on an edit', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()]});

            service.editRecipe(CHANNEL, 'rcp_1', {title: 'Chili sin carne'}).subscribe();
            expectOne(ctrl, `${GUILD}/recipes/rcp_1`, 'PATCH').flush(recipe({title: 'Chili sin carne'}));

            expect(service.stateFor(CHANNEL).recipes.map(r => r.title)).toEqual(['Chili sin carne']);
        });

        it('sorts a recipe ingredient list by position', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {
                recipes: [
                    recipe({
                        ingredients: [
                            {position: 2, text: 'rice', isOptional: false},
                            {position: 1, text: 'beans', isOptional: false},
                        ],
                    }),
                ],
            });

            expect(service.stateFor(CHANNEL).recipes[0].ingredients.map(i => i.text)).toEqual([
                'beans',
                'rice',
            ]);
        });

        it('takes the entries naming a recipe with it when the recipe goes', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {
                recipes: [recipe()],
                plan: [entry({recipeId: 'rcp_1'}), entry({id: 'mpe_2', recipeId: null})],
            });

            service.removeRecipe(CHANNEL, 'rcp_1').subscribe();
            expectOne(ctrl, `${GUILD}/recipes/rcp_1`, 'DELETE').flush(null);

            expect(recipeIds(service)).toEqual([]);
            expect(planIds(service)).toEqual(['mpe_2']);
        });

        it('clears a recipe field the edit response omits rather than nulls', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe({sourceUrl: 'https://example.test/chili'})]});

            service.editRecipe(CHANNEL, 'rcp_1', {clearSourceUrl: true}).subscribe();
            expectOne(ctrl, `${GUILD}/recipes/rcp_1`, 'PATCH').flush(without(recipe(), 'sourceUrl'));

            expect(service.stateFor(CHANNEL).recipes[0].sourceUrl).toBeFalsy();
        });

        it('looks a recipe up by id, and answers null for one it does not hold', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {recipes: [recipe()]});
            expect(service.recipeById(CHANNEL, 'rcp_1')?.title).toBe('Chili');
            expect(service.recipeById(CHANNEL, 'ghost')).toBeNull();
        });
    });

    describe('plan writes', () => {
        it('adds the entry the server echoes back', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service
                .addEntry(CHANNEL, {date: MONDAY, slot: MealSlot.Dinner, freeText: 'Leftovers'})
                .subscribe();
            expectOne(ctrl, PLAN_URL, 'POST').flush(entry({id: 'mpe_new', freeText: 'Leftovers'}));

            expect(planIds(service)).toEqual(['mpe_new']);
        });

        it('orders the week by date, then by the position the user chose', () => {
            const {service, ctrl} = setup();
            const tuesday = toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 1));
            load(service, ctrl);

            const push = (id: string, date: string, slot: MealSlot, position: number) => {
                service.addEntry(CHANNEL, {date, slot}).subscribe();
                expectOne(ctrl, PLAN_URL, 'POST').flush(entry({id, date, slot, position}));
            };

            push('tue_dinner', tuesday, MealSlot.Dinner, 0);
            push('mon_dinner', MONDAY, MealSlot.Dinner, 1);
            push('mon_lunch', MONDAY, MealSlot.Lunch, 0);

            expect(planIds(service)).toEqual(['mon_lunch', 'mon_dinner', 'tue_dinner']);
        });

        // Dragging Thursday's dinner to next Monday must not leave it in this week's column.
        it('drops an entry an edit moved out of the loaded week', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry()]});

            const nextWeek = toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 7));
            service.editEntry(CHANNEL, 'mpe_1', {date: nextWeek}).subscribe();
            expectOne(ctrl, `${GUILD}/meal-plan/mpe_1`, 'PATCH').flush(entry({date: nextWeek}));

            expect(planIds(service)).toEqual([]);
        });

        it('keeps an entry an edit moved within the loaded week', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry()]});

            service.editEntry(CHANNEL, 'mpe_1', {slot: MealSlot.Lunch}).subscribe();
            expectOne(ctrl, `${GUILD}/meal-plan/mpe_1`, 'PATCH').flush(
                entry({date: SUNDAY, slot: MealSlot.Lunch}),
            );

            expect(planIds(service)).toEqual(['mpe_1']);
            expect(service.stateFor(CHANNEL).plan[0].slot).toBe(MealSlot.Lunch);
        });

        // The server can omit a field it has cleared rather than sending an explicit null, and a
        // row that merged instead of replacing would keep drawing the recipe the edit just removed.
        it('clears a field the edit response omits rather than nulls', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry({recipeId: 'rcp_1', recipeTitle: 'Chili'})]});

            service.editEntry(CHANNEL, 'mpe_1', {clearRecipe: true, freeText: 'Leftovers'}).subscribe();
            expectOne(ctrl, `${GUILD}/meal-plan/mpe_1`, 'PATCH').flush({
                ...without(entry(), 'recipeId', 'recipeTitle'),
                freeText: 'Leftovers',
            });

            expect(service.stateFor(CHANNEL).plan[0].recipeId).toBeFalsy();
            expect(service.stateFor(CHANNEL).plan[0].recipeTitle).toBeFalsy();
            expect(service.stateFor(CHANNEL).plan[0].freeText).toBe('Leftovers');
        });

        it('removes the entry on a successful delete', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {plan: [entry()]});
            service.removeEntry(CHANNEL, 'mpe_1').subscribe();
            expectOne(ctrl, `${GUILD}/meal-plan/mpe_1`, 'DELETE').flush(null);
            expect(planIds(service)).toEqual([]);
        });

        it('reads a numeric slot ordinal and an instant-shaped date back to their plain forms', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, {
                plan: [{...entry(), slot: 1 as unknown as MealSlot, date: `${MONDAY}T00:00:00Z`}],
            });

            expect(service.stateFor(CHANNEL).plan[0].slot).toBe(MealSlot.Lunch);
            expect(service.stateFor(CHANNEL).plan[0].date).toBe(MONDAY);
        });
    });

    describe('realtime events', () => {
        it('adds a recipe broadcast into an open channel', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl);
            realtime.emit('guild.RecipeCreated', scoped({recipe: recipe({id: 'rcp_live'})}));
            expect(recipeIds(service)).toEqual(['rcp_live']);
        });

        it('patches a recipe an update names', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl, {recipes: [recipe()]});
            realtime.emit('guild.RecipeUpdated', scoped({recipe: recipe({title: 'Chili verde'})}));
            expect(service.stateFor(CHANNEL).recipes.map(r => r.title)).toEqual(['Chili verde']);
        });

        it('ignores a channel nobody has opened rather than seeding a partial state', () => {
            const {service, realtime} = setup();
            realtime.emit('guild.RecipeCreated', {
                guildId: GUILD_ID,
                channelId: 'chan_other',
                recipe: recipe({channelId: 'chan_other'}),
            });
            expect(service.stateFor('chan_other').recipes).toEqual([]);
            expect(service.stateFor('chan_other').loaded).toBe(false);
        });

        // A write can reach a channel no load ever did. Treating that channel as unopened would
        // leave the rows already on screen deaf to every event that follows.
        it('keeps a channel a write reached before any load open to events', () => {
            const {service, ctrl, realtime} = setup();

            service.addRecipe(CHANNEL, {title: 'Chili'}).subscribe();
            expectOne(ctrl, RECIPES_URL, 'POST').flush(recipe());

            realtime.emit('guild.RecipeUpdated', scoped({recipe: recipe({title: 'Chili verde'})}));
            expect(service.stateFor(CHANNEL).recipes.map(r => r.title)).toEqual(['Chili verde']);
        });

        it('takes the plan entries with a deleted recipe', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl, {
                recipes: [recipe()],
                plan: [entry({recipeId: 'rcp_1'}), entry({id: 'mpe_2', recipeId: null})],
            });

            realtime.emit('guild.RecipeDeleted', scoped({recipeId: 'rcp_1'}));

            expect(recipeIds(service)).toEqual([]);
            expect(planIds(service)).toEqual(['mpe_2']);
        });

        it('places a broadcast entry that falls in the loaded week', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl);
            realtime.emit('guild.MealPlanEntryCreated', scoped({entry: entry({id: 'mpe_live'})}));
            expect(planIds(service)).toEqual(['mpe_live']);
        });

        it('ignores a broadcast entry for a week the board is not showing', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl);
            realtime.emit(
                'guild.MealPlanEntryCreated',
                scoped({
                    entry: entry({
                        id: 'mpe_next',
                        date: toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 7)),
                    }),
                }),
            );
            expect(planIds(service)).toEqual([]);
        });

        it('removes an entry a broadcast moved out of the loaded week', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl, {plan: [entry()]});
            realtime.emit(
                'guild.MealPlanEntryUpdated',
                scoped({
                    entry: entry({date: toPlanDate(addPlanDays(startOfPlanWeek(new Date()), 7))}),
                }),
            );
            expect(planIds(service)).toEqual([]);
        });

        it('removes a deleted entry', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl, {plan: [entry()]});
            realtime.emit('guild.MealPlanEntryDeleted', scoped({entryId: 'mpe_1'}));
            expect(planIds(service)).toEqual([]);
        });

        it('treats a re-delivered create as an upsert rather than a second dinner', () => {
            const {service, ctrl, realtime} = setup();
            load(service, ctrl, {plan: [entry()]});
            realtime.emit('guild.MealPlanEntryCreated', scoped({entry: entry({freeText: 'Chili'})}));
            expect(planIds(service)).toEqual(['mpe_1']);
        });
    });

    describe('read-through operations', () => {
        it('reloads the target list once the shopping run has added lines to it', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.generateShoppingList(CHANNEL, {from: MONDAY, to: SUNDAY}).subscribe();
            expectOne(ctrl, `${PLAN_URL}/shopping-list`, 'POST').flush({
                added: [{id: 'litm_1'}],
                skippedInPantry: [],
                skippedOnList: [],
                truncated: false,
            });

            // The configured list, since the request named none.
            expectOne(ctrl, `${GUILD}/channels/${LIST_CHANNEL}/list-items`, 'GET').flush([]);
        });

        it('reloads the list the request named over the configured one', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service
                .generateShoppingList(CHANNEL, {from: MONDAY, to: SUNDAY, listChannelId: 'chan_other_list'})
                .subscribe();
            expectOne(ctrl, `${PLAN_URL}/shopping-list`, 'POST').flush({
                added: [{id: 'litm_1'}],
                skippedInPantry: [],
                skippedOnList: [],
                truncated: false,
            });

            expectOne(ctrl, `${GUILD}/channels/chan_other_list/list-items`, 'GET').flush([]);
        });

        it('leaves the list alone when the run added nothing', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.generateShoppingList(CHANNEL, {from: MONDAY, to: SUNDAY}).subscribe();
            expectOne(ctrl, `${PLAN_URL}/shopping-list`, 'POST').flush({
                added: [],
                skippedInPantry: ['onions'],
                skippedOnList: [],
                truncated: false,
            });

            ctrl.expectNone(r => r.url === `${GUILD}/channels/${LIST_CHANNEL}/list-items`);
        });

        it('passes the cookable window and cap through, and caches nothing', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.cookable(CHANNEL, 5, 10).subscribe();
            const first = expectOne(ctrl, COOKABLE_URL, 'GET');
            expect(first.request.params.get('expiringDays')).toBe('5');
            expect(first.request.params.get('limit')).toBe('10');
            first.flush({items: [], reason: 'NO_PANTRY'});

            service.cookable(CHANNEL).subscribe();
            expectOne(ctrl, COOKABLE_URL, 'GET').flush({items: []});
        });

        it('caches the config a save returns', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.saveConfig(CHANNEL, {clearShoppingList: true}).subscribe();
            expectOne(ctrl, CONFIG_URL, 'PUT').flush(config({shoppingListChannelId: null}));

            expect(service.stateFor(CHANNEL).config?.shoppingListChannelId).toBeNull();
        });
    });
});
