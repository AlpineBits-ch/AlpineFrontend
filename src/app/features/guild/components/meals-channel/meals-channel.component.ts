import {ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {
    addPlanDays,
    CookableRecipe,
    MEAL_LIMITS,
    MEAL_SLOTS,
    MealPlanEntry,
    MealSlot,
    mealSlotLabelKey,
    parsePlanDate,
    Recipe,
    ShoppingListResult,
    toPlanDate,
} from '../../../../dtos/response/meal.dto';
import {RecipeIngredientInputDto} from '../../../../dtos/request/meal.dto';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {GuildService} from '../../../../services/guild.service';
import {MealService} from '../../../../services/meal.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {channelIcon} from '../../channel-types';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {guildAbilities} from '../../guild-permissions';

const MEMBER_PAGE_SIZE = 200;

interface Option {
    value: string;
    label: string;
}

interface DayColumn {
    /** `yyyy-MM-dd`. A plain date - see `parsePlanDate` for why it is never `new Date(iso)`. */
    date: string;
    label: string;
    isToday: boolean;
    slots: SlotGroup[];
}

interface SlotGroup {
    slot: MealSlot;
    labelKey: string;
    entries: PlanRow[];
}

interface PlanRow {
    entry: MealPlanEntry;
    /** The recipe title, or the free text. One line either way. */
    title: string;
    cookName: string | null;
}

/** Which body the channel is showing. */
type MealsView = 'plan' | 'recipes' | 'cookable';

/**
 * The Meals channel: recipes, the week's plan, and the button the module exists for.
 *
 * <p><b>Plan to shopping list is the highest-value screen here</b> and everything else earns its
 * keep by making it possible. Its answer is also the only one in the module whose <i>negative</i>
 * half has to reach the screen: a shopper who opens the list and finds no onions has no way to tell
 * a working pantry check from a broken button, and will not press it twice.</p>
 *
 * <p>Structured rows, no messages - a Meals channel has no history and no composer.</p>
 */
@Component({
    selector: 'app-meals-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, Dialog, InputText, Select, Tooltip, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './meals-channel.component.html',
})
export class MealsChannelComponent {
    channel = input.required<ChannelDto>();
    /** Bound by main-page, in common with every other full-page channel view. */
    back = output();

    protected navService = inject(NavigationService);
    private meals = inject(MealService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly slots = MEAL_SLOTS;
    protected readonly titleMaxLength = MEAL_LIMITS.titleMaxLength;
    protected readonly ingredientsMax = MEAL_LIMITS.ingredientsMax;

    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private members = signal<GuildMemberDto[]>([]);
    private memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected icon = computed(() => channelIcon(this.channel().type) ?? 'pi pi-book');
    protected state = computed(() => this.meals.stateFor(this.channel().id));
    protected ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    protected view = signal<MealsView>('plan');

    private guild = computed(() => {
        const workspace = this.navService.workspace();
        return workspace.type === 'server' && workspace.guild.id === this.channel().guildId
            ? workspace.guild
            : null;
    });

    /**
     * Whether to draw the module at all.
     *
     * <p>A `403` here means the house does not have Meals far more often than that this member lacks
     * a role, and the owner gets the same `403` - so the module being off renders nothing, never a
     * denial. A guild that has not resolved yet counts as enabled.</p>
     */
    protected hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Meals);
        return moduleOff || this.state().forbidden;
    });

    // ── Permissions ──────────────────────────────────────────────────────────

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private abilities = computed(() => guildAbilities(this.ownMember(), this.guild(), this.ownUserId()));

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** Add recipes and plan entries, and run the shopping-list button. */
    protected canPlan = computed(() => this.can(ModulePermissions.PlanMeals));
    /** Edit anyone's recipe or entry, and set the channel's config. */
    protected canManageMeals = computed(() => this.can(ModulePermissions.ManageMeals));

    // ── The week ─────────────────────────────────────────────────────────────

    protected weekStart = computed(() => this.state().weekStart);

    protected weekLabel = computed(() => {
        const start = parsePlanDate(this.weekStart());
        const end = addPlanDays(start, 6);
        const format = new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'});
        return `${format.format(start)} - ${format.format(end)}`;
    });

    protected days = computed<DayColumn[]>(() => {
        const today = toPlanDate(new Date());
        const byDate = new Map<string, MealPlanEntry[]>();
        for (const entry of this.state().plan) {
            const held = byDate.get(entry.date);
            if (held) held.push(entry); else byDate.set(entry.date, [entry]);
        }

        return this.meals.weekDatesFor(this.channel().id).map(date => ({
            date,
            label: this.dayLabel(date),
            isToday: date === today,
            slots: this.slots
                .map(slot => ({
                    slot,
                    labelKey: mealSlotLabelKey(slot),
                    entries: (byDate.get(date) ?? [])
                        .filter(entry => entry.slot === slot)
                        .map(entry => this.toRow(entry)),
                }))
                // Empty slots are dropped rather than drawn as four blanks per day. A week board of
                // twenty-eight empty cells reads as broken; a day with one dinner on it reads as a
                // day with one dinner on it.
                .filter(group => group.entries.length > 0),
        }));
    });

    protected planEmpty = computed(() => this.state().loaded && this.state().plan.length === 0);

    protected recipes = computed(() => this.state().recipes);
    protected recipeOptions = computed<Option[]>(() =>
        this.recipes().map(recipe => ({value: recipe.id, label: recipe.title})));

    protected slotOptions = computed<Option[]>(() => this.slots.map(slot => ({
        value: slot,
        label: this.translate.instant(mealSlotLabelKey(slot)),
    })));

    protected memberOptions = computed<Option[]>(() => this.members()
        .map(m => ({value: m.userId, label: this.nameOf(m.userId)}))
        .sort((a, b) => a.label.localeCompare(b.label)));

    // ── Entry editor ─────────────────────────────────────────────────────────
    protected showEntryDialog = signal(false);
    protected editingEntryId = signal<string | null>(null);
    protected saving = signal(false);

    protected entryDate = signal('');
    protected entrySlot = signal<MealSlot>(MealSlot.Dinner);
    protected entryRecipeId = signal<string | null>(null);
    protected entryFreeText = signal('');
    protected entryCookUserId = signal<string | null>(null);

    /** At least one of the two, which is the server's rule and the only one worth pre-empting. */
    protected entryValid = computed(() =>
        !!this.entryDate() && (!!this.entryRecipeId() || !!this.entryFreeText().trim()));

    // ── Recipe editor ────────────────────────────────────────────────────────
    protected showRecipeDialog = signal(false);
    protected editingRecipeId = signal<string | null>(null);
    protected confirmDeleteRecipeId = signal<string | null>(null);

    protected recipeTitle = signal('');
    protected recipeServings = signal(2);
    protected recipePrepMinutes = signal<number | null>(null);
    protected recipeSourceUrl = signal('');
    /** One line per ingredient, as typed. Split on save - an ingredient list is edited as a block. */
    protected recipeIngredients = signal('');

    protected recipeValid = computed(() => {
        const title = this.recipeTitle().trim();
        if (!title || title.length > this.titleMaxLength) return false;
        return this.ingredientLines().length <= this.ingredientsMax;
    });

    protected ingredientLines = computed(() => this.recipeIngredients()
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean));

    // ── Shopping list ────────────────────────────────────────────────────────
    protected showShoppingDialog = signal(false);
    protected shoppingListChannelId = signal<string | null>(null);
    protected shoppingIncludeOptional = signal(false);
    protected shoppingSkipPantry = signal(false);
    protected shoppingResult = signal<ShoppingListResult | null>(null);
    protected shoppingBusy = signal(false);

    /** `List` channels in this guild. A list elsewhere is not a legal target and is never offered. */
    protected listChannelOptions = computed<Option[]>(() => (this.guild()?.channels ?? [])
        .filter(c => c.type === ChannelType.List)
        .map(c => ({value: c.id, label: c.name})));

    // ── Cookable ─────────────────────────────────────────────────────────────
    protected cookable = signal<CookableRecipe[]>([]);
    protected cookableReason = signal<string | null>(null);
    protected cookableBusy = signal(false);

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => this.meals.loadFor(channelId));
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => {
                this.guildService.getOwnMember(guildId).subscribe({
                    // Failing closed: no member means no permissions, which hides the write
                    // affordances rather than offering ones the server will refuse.
                    next: member => this.ownMember.set(member),
                    error: () => this.ownMember.set(null),
                });
                this.guildService.getMembers(guildId, 0, MEMBER_PAGE_SIZE).subscribe({
                    next: members => this.members.set(members),
                    error: () => undefined,
                });
            });
        });
    }

    // ── The week ─────────────────────────────────────────────────────────────

    protected shiftWeek(weeks: number): void {
        this.meals.shiftWeek(this.channel().id, weeks);
    }

    protected thisWeek(): void {
        this.meals.setWeek(this.channel().id, toPlanDate(new Date()));
    }

    // ── Entries ──────────────────────────────────────────────────────────────

    protected openAddEntry(date?: string, slot?: MealSlot): void {
        this.editingEntryId.set(null);
        this.entryDate.set(date ?? toPlanDate(new Date()));
        this.entrySlot.set(slot ?? MealSlot.Dinner);
        this.entryRecipeId.set(null);
        this.entryFreeText.set('');
        this.entryCookUserId.set(null);
        this.showEntryDialog.set(true);
    }

    protected openEditEntry(entry: MealPlanEntry): void {
        this.editingEntryId.set(entry.id);
        this.entryDate.set(entry.date);
        this.entrySlot.set(entry.slot);
        this.entryRecipeId.set(entry.recipeId ?? null);
        this.entryFreeText.set(entry.freeText ?? '');
        this.entryCookUserId.set(entry.cookUserId ?? null);
        this.showEntryDialog.set(true);
    }

    protected submitEntry(): void {
        if (this.saving() || !this.entryValid()) return;

        const channelId = this.channel().id;
        const editingId = this.editingEntryId();
        const recipeId = this.entryRecipeId();
        const freeText = this.entryFreeText().trim();
        const cookUserId = this.entryCookUserId();

        this.saving.set(true);

        const request$ = editingId
            ? this.meals.editEntry(channelId, editingId, {
                date: this.entryDate(),
                slot: this.entrySlot(),
                // `clear*` rather than a null, for the same reason it is everywhere else: null on
                // the value field reads as "leave it alone".
                ...(recipeId ? {recipeId} : {clearRecipe: true}),
                ...(freeText ? {freeText} : {clearFreeText: true}),
                ...(cookUserId ? {cookUserId} : {clearCook: true}),
            })
            : this.meals.addEntry(channelId, {
                date: this.entryDate(),
                slot: this.entrySlot(),
                ...(recipeId ? {recipeId} : {}),
                ...(freeText ? {freeText} : {}),
                ...(cookUserId ? {cookUserId} : {}),
            });

        request$.subscribe({
            next: () => {
                this.saving.set(false);
                this.showEntryDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('MEALS.SAVE_FAILED'), err);
            },
        });
    }

    protected removeEntry(entry: MealPlanEntry): void {
        this.meals.removeEntry(this.channel().id, entry.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('MEALS.DELETE_FAILED'), err),
        });
    }

    /** Your own always; anyone else's needs `ManageMeals`. The server enforces it either way. */
    protected canEditEntry(entry: MealPlanEntry): boolean {
        if (this.canManageMeals()) return true;
        return this.canPlan() && (!entry.cookUserId || entry.cookUserId === this.ownUserId());
    }

    // ── Recipes ──────────────────────────────────────────────────────────────

    protected openAddRecipe(): void {
        this.editingRecipeId.set(null);
        this.recipeTitle.set('');
        this.recipeServings.set(2);
        this.recipePrepMinutes.set(null);
        this.recipeSourceUrl.set('');
        this.recipeIngredients.set('');
        this.showRecipeDialog.set(true);
    }

    protected openEditRecipe(recipe: Recipe): void {
        this.editingRecipeId.set(recipe.id);
        this.recipeTitle.set(recipe.title);
        this.recipeServings.set(recipe.servings);
        this.recipePrepMinutes.set(recipe.prepMinutes ?? null);
        this.recipeSourceUrl.set(recipe.sourceUrl ?? '');
        this.recipeIngredients.set(recipe.ingredients.map(i => i.text).join('\n'));
        this.showRecipeDialog.set(true);
    }

    protected submitRecipe(): void {
        if (this.saving() || !this.recipeValid()) return;

        const channelId = this.channel().id;
        const editingId = this.editingRecipeId();
        const ingredients: RecipeIngredientInputDto[] = this.ingredientLines().map(text => ({text}));
        const sourceUrl = this.recipeSourceUrl().trim();
        const prepMinutes = this.recipePrepMinutes();

        this.saving.set(true);

        const request$ = editingId
            ? this.meals.editRecipe(channelId, editingId, {
                title: this.recipeTitle().trim(),
                servings: this.recipeServings(),
                // The list replaces wholesale, which is the shape the endpoint takes: an ingredient
                // list is edited as a block in every client that will ever exist.
                ingredients,
                ...(prepMinutes ? {prepMinutes} : {clearPrepMinutes: true}),
                ...(sourceUrl ? {sourceUrl} : {clearSourceUrl: true}),
            })
            : this.meals.addRecipe(channelId, {
                title: this.recipeTitle().trim(),
                servings: this.recipeServings(),
                ingredients,
                ...(prepMinutes ? {prepMinutes} : {}),
                ...(sourceUrl ? {sourceUrl} : {}),
            });

        request$.subscribe({
            next: () => {
                this.saving.set(false);
                this.showRecipeDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('MEALS.SAVE_FAILED'), err);
            },
        });
    }

    /** First press arms, second deletes - it takes every plan entry naming it with it. */
    protected removeRecipe(recipe: Recipe): void {
        if (this.confirmDeleteRecipeId() !== recipe.id) {
            this.confirmDeleteRecipeId.set(recipe.id);
            return;
        }
        this.confirmDeleteRecipeId.set(null);
        this.meals.removeRecipe(this.channel().id, recipe.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('MEALS.DELETE_FAILED'), err),
        });
    }

    protected canEditRecipe(recipe: Recipe): boolean {
        if (this.canManageMeals()) return true;
        return this.canPlan() && recipe.createdByUserId === this.ownUserId();
    }

    protected loadMoreRecipes(): void {
        this.meals.loadMoreRecipes(this.channel().id);
    }

    // ── Shopping list ────────────────────────────────────────────────────────

    protected openShopping(): void {
        this.shoppingListChannelId.set(this.state().config?.shoppingListChannelId ?? null);
        this.shoppingIncludeOptional.set(false);
        this.shoppingSkipPantry.set(false);
        this.shoppingResult.set(null);
        this.showShoppingDialog.set(true);
    }

    /**
     * Turns the visible week into shopping-list lines.
     *
     * <p>The window is the week on screen and is sent explicitly - "this week" means different
     * things on a Sunday night and a Monday morning, and letting the server guess would silently
     * shop for the wrong one.</p>
     */
    protected submitShopping(): void {
        if (this.shoppingBusy()) return;

        const from = this.weekStart();
        const to = toPlanDate(addPlanDays(parsePlanDate(from), 6));
        const listChannelId = this.shoppingListChannelId();

        this.shoppingBusy.set(true);
        this.meals.generateShoppingList(this.channel().id, {
            from,
            to,
            ...(listChannelId ? {listChannelId} : {}),
            includeOptional: this.shoppingIncludeOptional(),
            skipPantry: this.shoppingSkipPantry(),
        }).subscribe({
            // The dialog stays open on success, deliberately: the result - and especially what it
            // skipped - is the answer, and closing over it is how the button stops being trusted.
            next: result => {
                this.shoppingBusy.set(false);
                this.shoppingResult.set(result);
            },
            error: err => {
                this.shoppingBusy.set(false);
                this.toast.httpError(this.translate.instant('MEALS.SHOPPING_FAILED'), err);
            },
        });
    }

    // ── Cookable ─────────────────────────────────────────────────────────────

    /**
     * What the house could cook tonight, ranked by how much about-to-expire stock it uses up.
     *
     * <p>The food-waste payoff, and the reason keeping a pantry is worth the effort. Two sort keys
     * a person can predict - most expiring first, then fewest missing - and deliberately no slider
     * to weight them with.</p>
     */
    protected showCookable(): void {
        this.view.set('cookable');
        this.cookableBusy.set(true);
        this.meals.cookable(this.channel().id).subscribe({
            next: result => {
                this.cookableBusy.set(false);
                this.cookable.set(result.items);
                // Why it is empty when it is empty: no pantry module, none configured, or nothing
                // in stock. A bare empty list would read as a broken feature.
                this.cookableReason.set(result.reason ?? null);
            },
            error: () => {
                this.cookableBusy.set(false);
                this.cookable.set([]);
                this.cookableReason.set(null);
            },
        });
    }

    /** Adds a cookable recipe straight onto tonight's dinner - the point of having looked. */
    protected planTonight(recipe: Recipe): void {
        this.meals.addEntry(this.channel().id, {
            date: toPlanDate(new Date()),
            slot: MealSlot.Dinner,
            recipeId: recipe.id,
        }).subscribe({
            next: () => this.toast.success(this.translate.instant('MEALS.PLANNED_TONIGHT', {title: recipe.title})),
            error: err => this.toast.httpError(this.translate.instant('MEALS.SAVE_FAILED'), err),
        });
    }

    // ── Presentation ─────────────────────────────────────────────────────────

    protected nameOf(userId: string): string {
        const member = this.memberById().get(userId);
        return member?.nickname ?? member?.profile?.userName ?? this.translate.instant('MEALS.SOMEONE');
    }

    private toRow(entry: MealPlanEntry): PlanRow {
        return {
            entry,
            // Flattened to one line: most of a real week is "leftovers" rather than a recipe, and a
            // board that renders the two differently makes the ordinary case look like a gap.
            title: entry.recipeTitle ?? entry.freeText ?? this.translate.instant('MEALS.UNTITLED'),
            cookName: entry.cookUserId ? this.nameOf(entry.cookUserId) : null,
        };
    }

    /** `Thu 14`. Built from the plain date's own parts, never through `new Date(iso)`. */
    private dayLabel(date: string): string {
        return new Intl.DateTimeFormat(undefined, {weekday: 'short', day: 'numeric'})
            .format(parsePlanDate(date));
    }
}
