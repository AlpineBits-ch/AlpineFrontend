import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
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
    /** `yyyy-MM-dd`. A plain date, see `parsePlanDate` for why it is never `new Date(iso)`. */
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

@Component({
    selector: 'app-meals-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, Dialog, InputText, Select, Tooltip, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './meals-channel.component.html',
})
export class MealsChannelComponent {
    readonly channel = input.required<ChannelDto>();
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

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    private readonly members = signal<GuildMemberDto[]>([]);
    private readonly memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected readonly icon = computed(() => channelIcon(this.channel().type) ?? 'pi pi-book');
    protected readonly state = computed(() => this.meals.stateFor(this.channel().id));
    protected readonly ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    protected readonly view = signal<MealsView>('plan');

    private readonly guild = computed(() => {
        const workspace = this.navService.workspace();
        return workspace.type === 'server' && workspace.guild.id === this.channel().guildId
            ? workspace.guild
            : null;
    });

    /** A 403 here usually means the house lacks Meals rather than a missing role (owner gets the same 403), so the module being off renders nothing, never a denial; unresolved counts as enabled. */
    protected readonly hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Meals);
        return moduleOff || this.state().forbidden;
    });

    // ── Permissions ──────────────────────────────────────────────────────────

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private readonly abilities = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.ownUserId()),
    );

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** Add recipes and plan entries, and run the shopping-list button. */
    protected readonly canPlan = computed(() => this.can(ModulePermissions.PlanMeals));
    /** Edit anyone's recipe or entry, and set the channel's config. */
    protected readonly canManageMeals = computed(() => this.can(ModulePermissions.ManageMeals));

    // ── The week ─────────────────────────────────────────────────────────────

    protected readonly weekStart = computed(() => this.state().weekStart);

    protected readonly weekLabel = computed(() => {
        const start = parsePlanDate(this.weekStart());
        const end = addPlanDays(start, 6);
        const format = new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'});
        return `${format.format(start)} - ${format.format(end)}`;
    });

    protected readonly days = computed<DayColumn[]>(() => {
        const today = toPlanDate(new Date());
        const byDate = new Map<string, MealPlanEntry[]>();
        for (const entry of this.state().plan) {
            const held = byDate.get(entry.date);
            if (held) held.push(entry);
            else byDate.set(entry.date, [entry]);
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
                // Empty slots are dropped rather than drawn as blanks: a week board of empty cells reads as broken.
                .filter(group => group.entries.length > 0),
        }));
    });

    protected readonly planEmpty = computed(() => this.state().loaded && this.state().plan.length === 0);

    protected readonly recipes = computed(() => this.state().recipes);
    protected readonly recipeOptions = computed<Option[]>(() =>
        this.recipes().map(recipe => ({value: recipe.id, label: recipe.title})),
    );

    protected readonly slotOptions = computed<Option[]>(() =>
        this.slots.map(slot => ({
            value: slot,
            label: this.translate.instant(mealSlotLabelKey(slot)),
        })),
    );

    protected readonly memberOptions = computed<Option[]>(() =>
        this.members()
            .map(m => ({value: m.userId, label: this.nameOf(m.userId)}))
            .sort((a, b) => a.label.localeCompare(b.label)),
    );

    // ── Entry editor ─────────────────────────────────────────────────────────
    protected readonly showEntryDialog = signal(false);
    protected readonly editingEntryId = signal<string | null>(null);
    protected readonly saving = signal(false);

    protected readonly entryDate = signal('');
    protected readonly entrySlot = signal<MealSlot>(MealSlot.Dinner);
    protected readonly entryRecipeId = signal<string | null>(null);
    protected readonly entryFreeText = signal('');
    protected readonly entryCookUserId = signal<string | null>(null);

    /** At least one of the two, which is the server's rule and the only one worth pre-empting. */
    protected readonly entryValid = computed(
        () => !!this.entryDate() && (!!this.entryRecipeId() || !!this.entryFreeText().trim()),
    );

    // ── Recipe editor ────────────────────────────────────────────────────────
    protected readonly showRecipeDialog = signal(false);
    protected readonly editingRecipeId = signal<string | null>(null);
    protected readonly confirmDeleteRecipeId = signal<string | null>(null);

    protected readonly recipeTitle = signal('');
    protected readonly recipeServings = signal(2);
    protected readonly recipePrepMinutes = signal<number | null>(null);
    protected readonly recipeSourceUrl = signal('');
    /** One line per ingredient, as typed; split on save, an ingredient list is edited as a block. */
    protected readonly recipeIngredients = signal('');

    protected readonly recipeValid = computed(() => {
        const title = this.recipeTitle().trim();
        if (!title || title.length > this.titleMaxLength) return false;
        return this.ingredientLines().length <= this.ingredientsMax;
    });

    protected readonly ingredientLines = computed(() =>
        this.recipeIngredients()
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean),
    );

    // ── Shopping list ────────────────────────────────────────────────────────
    protected readonly showShoppingDialog = signal(false);
    protected readonly shoppingListChannelId = signal<string | null>(null);
    protected readonly shoppingIncludeOptional = signal(false);
    protected readonly shoppingSkipPantry = signal(false);
    protected readonly shoppingResult = signal<ShoppingListResult | null>(null);
    protected readonly shoppingBusy = signal(false);

    /** `List` channels in this guild. A list elsewhere is not a legal target and is never offered. */
    protected readonly listChannelOptions = computed<Option[]>(() =>
        (this.guild()?.channels ?? [])
            .filter(c => c.type === ChannelType.List)
            .map(c => ({value: c.id, label: c.name})),
    );

    // ── Cookable ─────────────────────────────────────────────────────────────
    protected readonly cookable = signal<CookableRecipe[]>([]);
    protected readonly cookableReason = signal<string | null>(null);
    protected readonly cookableBusy = signal(false);

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => this.meals.loadFor(channelId));
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => {
                this.guildService.getOwnMember(guildId).subscribe({
                    // Failing closed: no member means no permissions, which hides the write affordances rather than offering ones the server will refuse.
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
                  // `clear*` rather than a null, for the same reason it is everywhere else: null on the value field reads as "leave it alone".
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
                  // The list replaces wholesale, which is the shape the endpoint takes: an ingredient list is edited as a block in every client that will ever exist.
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

    /** First press arms, second deletes; it takes every plan entry naming it with it. */
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

    /** The window is the week on screen, sent explicitly: "this week" is ambiguous, and letting the server guess would silently shop for the wrong one. */
    protected submitShopping(): void {
        if (this.shoppingBusy()) return;

        const from = this.weekStart();
        const to = toPlanDate(addPlanDays(parsePlanDate(from), 6));
        const listChannelId = this.shoppingListChannelId();

        this.shoppingBusy.set(true);
        this.meals
            .generateShoppingList(this.channel().id, {
                from,
                to,
                ...(listChannelId ? {listChannelId} : {}),
                includeOptional: this.shoppingIncludeOptional(),
                skipPantry: this.shoppingSkipPantry(),
            })
            .subscribe({
                // The dialog stays open on success: the result, especially what it skipped, is the answer, and closing over it is how the button stops being trusted.
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

    /** Ranked by about-to-expire stock used up, then fewest missing; two predictable sort keys, deliberately no slider to weight them with. */
    protected showCookable(): void {
        this.view.set('cookable');
        this.cookableBusy.set(true);
        this.meals.cookable(this.channel().id).subscribe({
            next: result => {
                this.cookableBusy.set(false);
                this.cookable.set(result.items);
                // Why it is empty when it is empty: no pantry module, none configured, or nothing in stock. A bare empty list would read as a broken feature.
                this.cookableReason.set(result.reason ?? null);
            },
            error: () => {
                this.cookableBusy.set(false);
                this.cookable.set([]);
                this.cookableReason.set(null);
            },
        });
    }

    /** Adds a cookable recipe straight onto tonight's dinner: the point of having looked. */
    protected planTonight(recipe: Recipe): void {
        this.meals
            .addEntry(this.channel().id, {
                date: toPlanDate(new Date()),
                slot: MealSlot.Dinner,
                recipeId: recipe.id,
            })
            .subscribe({
                next: () =>
                    this.toast.success(
                        this.translate.instant('MEALS.PLANNED_TONIGHT', {title: recipe.title}),
                    ),
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
            // Flattened to one line: most of a real week is "leftovers" rather than a recipe, and a board that renders the two differently makes the ordinary case look like a gap.
            title: entry.recipeTitle ?? entry.freeText ?? this.translate.instant('MEALS.UNTITLED'),
            cookName: entry.cookUserId ? this.nameOf(entry.cookUserId) : null,
        };
    }

    /** `Thu 14`. Built from the plain date's own parts, never through `new Date(iso)`. */
    private dayLabel(date: string): string {
        return new Intl.DateTimeFormat(undefined, {weekday: 'short', day: 'numeric'}).format(
            parsePlanDate(date),
        );
    }
}
