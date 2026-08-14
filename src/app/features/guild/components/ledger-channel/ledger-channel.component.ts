import {ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {
    EXPENSE_CATEGORIES,
    Expense,
    ExpenseCategory,
    expenseCategoryLabelKey,
    ExpenseSplitKind,
    TransferSuggestion,
} from '../../../../dtos/response/ledger.dto';
import {ExpenseShareDto, LEDGER_LIMITS, normalizeCurrencyCode} from '../../../../dtos/request/ledger.dto';
import {BillsPanelComponent} from './bills-panel.component';
import {LedgerSummaryComponent} from './ledger-summary.component';
import {ReceiptGalleryComponent} from './receipt-gallery.component';
import {PaymentHandlesEditorComponent, PaySheetComponent} from '../../../payments';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {formatMinor, minorToInputString, parseMinor} from '../../../../helpers/money.helper';
import {GuildService} from '../../../../services/guild.service';
import {LedgerService} from '../../../../services/ledger.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {channelIcon} from '../../channel-types';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {guildAbilities} from '../../guild-permissions';

/** One page of members is plenty for a household, and the picker is unusable past it anyway. */
const MEMBER_PAGE_SIZE = 200;

interface MemberOption {
    value: string;
    label: string;
}

interface ExpenseRow {
    expense: Expense;
    payerName: string;
    /** Only set when the person who entered it is not the person who paid. */
    enteredByName: string | null;
    /** What this expense costs the viewer, or null when they are not in the split. */
    ownShareMinor: number | null;
    splitLabelKey: string;
    categoryLabelKey: string;
    /** Only drawn once somebody has looked - see `LedgerService.receiptCountFor`. */
    receiptCount: number;
    canEdit: boolean;
}

/** Which body the channel is showing. Bills are not history and get their own. */
type LedgerTab = 'expenses' | 'bills' | 'summary';

interface BalanceRow {
    userId: string;
    name: string;
    netMinor: number;
    isSelf: boolean;
}

interface SuggestionRow {
    suggestion: TransferSuggestion;
    fromName: string;
    toName: string;
    /** Own transfers need only `AddExpenses`; anyone else's is a third-party write. */
    canRecord: boolean;
}

/**
 * The shared-expense ledger: what the house spent, who owes whom, and the shortest way to make
 * that nothing.
 *
 * <p>Three rules run through the whole file and none of them are negotiable.</p>
 *
 * <p><b>Money is integer minor units.</b> The amount box is a text field, not a number one, and
 * what the user types goes through {@link parseMinor} to become whole rappen. No amount is ever a
 * fractional `number`, in state or on the wire.</p>
 *
 * <p><b>Splits are described, not computed.</b> The form can send `Equal` or `Shares`; it cannot
 * send `Exact`. Splitting 1000 across three is 334/333/333, the server decides which flatmate takes
 * the extra rappen, and a client that worked it out itself would eventually pick a different one
 * and be rejected for a total that doesn't add up.</p>
 *
 * <p><b>Balances come from the server.</b> {@link LedgerService} re-fetches them after every event;
 * nothing here reduces the expense list.</p>
 */
@Component({
    selector: 'app-ledger-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button, Dialog, InputText, Select, Tooltip, FormsModule, PrimeTemplate, TranslateModule,
        BillsPanelComponent, LedgerSummaryComponent, ReceiptGalleryComponent, PaySheetComponent,
        PaymentHandlesEditorComponent,
    ],
    templateUrl: './ledger-channel.component.html',
})
export class LedgerChannelComponent {
    channel = input.required<ChannelDto>();
    /** Bound by main-page, in common with every other full-page channel view. */
    back = output();

    protected navService = inject(NavigationService);
    private ledger = inject(LedgerService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly SplitKind = ExpenseSplitKind;

    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private members = signal<GuildMemberDto[]>([]);

    protected icon = computed(() => channelIcon(this.channel().type) ?? 'pi pi-wallet');
    protected state = computed(() => this.ledger.stateFor(this.channel().id));
    protected currency = computed(() => this.ledger.currencyFor(this.channel().id));
    protected ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    /** The guild this channel belongs to, or null while the workspace is still elsewhere. */
    private guild = computed(() => {
        const workspace = this.navService.workspace();
        return workspace.type === 'server' && workspace.guild.id === this.channel().guildId
            ? workspace.guild
            : null;
    });

    /**
     * Whether to draw the ledger at all.
     *
     * <p>A `403` from these endpoints usually means the guild has no Ledger module rather than that
     * this member lacks a role, and the owner gets the same `403` - so the module being off renders
     * *nothing*, never "you don't have permission". A guild that hasn't resolved yet counts as
     * enabled: the feature set is only ever used to hide, and the `403` path catches the rest.</p>
     */
    protected hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Ledger);
        return moduleOff || this.state().forbidden;
    });

    // ── Permissions (§2) ─────────────────────────────────────────────────────

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private abilities = computed(() => guildAbilities(this.ownMember(), this.guild(), this.ownUserId()));

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** Edit anyone's expense, record a settlement between two other people, set the currency. */
    protected canManageLedger = computed(() => this.can(ModulePermissions.ManageLedger));
    /** Add an expense you paid, and edit or delete the ones you entered. */
    protected canAddExpense = computed(() => this.can(ModulePermissions.AddExpenses) || this.canManageLedger());
    /** Naming someone else as the payer is a third-party write, so it needs the manage bit. */
    protected canNamePayer = computed(() => this.canManageLedger());

    // ── Derived view models ──────────────────────────────────────────────────
    private memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected memberOptions = computed<MemberOption[]>(() => this.members()
        .map(m => ({value: m.userId, label: this.nameOf(m.userId)}))
        .sort((a, b) => a.label.localeCompare(b.label)));

    protected expenseRows = computed<ExpenseRow[]>(() => {
        const ownUserId = this.ownUserId();
        return this.state().expenses.map(expense => ({
            expense,
            payerName: this.nameOf(expense.payerUserId),
            // Whoever fetched the beers is rarely whoever remembered to type it in. Showing only
            // the payer makes the ledger look like it was written by someone who wasn't there.
            enteredByName: expense.createdByUserId === expense.payerUserId
                ? null
                : this.nameOf(expense.createdByUserId),
            ownShareMinor: expense.shares.find(s => s.userId === ownUserId)?.amountMinor ?? null,
            splitLabelKey: `LEDGER.SPLIT_${expense.splitKind.toUpperCase()}`,
            categoryLabelKey: expenseCategoryLabelKey(expense.category ?? ExpenseCategory.Uncategorized),
            receiptCount: this.ledger.receiptCountFor(expense.id),
            canEdit: this.canEditExpense(expense),
        }));
    });

    // ── Tabs and the category filter ─────────────────────────────────────────

    protected tab = signal<LedgerTab>('expenses');

    /** `null` is everything. Held in the service, because it decides what the loaded pages mean. */
    protected categoryFilter = computed(() => this.state().category);

    protected readonly categories = EXPENSE_CATEGORIES;

    protected categoryOptions = computed<MemberOption[]>(() => this.categories.map(category => ({
        value: category,
        label: this.translate.instant(expenseCategoryLabelKey(category)),
    })));

    /** The receipt gallery's expense, or null when it is closed. */
    protected receiptsFor = signal<Expense | null>(null);

    /**
     * Everyone with a non-zero position, biggest creditor first.
     *
     * <p>The server omits members at zero, so this list being empty is a fact and not a gap - see
     * {@link settled}.</p>
     */
    protected balanceRows = computed<BalanceRow[]>(() => {
        const ownUserId = this.ownUserId();
        return [...this.state().balances]
            .sort((a, b) => b.netMinor - a.netMinor)
            .map(b => ({
                userId: b.userId,
                name: this.nameOf(b.userId),
                netMinor: b.netMinor,
                isSelf: b.userId === ownUserId,
            }));
    });

    /** Loaded, and nobody owes anybody anything. Worth saying out loud rather than showing a void. */
    protected settled = computed(() => this.state().loaded && this.state().balances.length === 0);

    protected ownNetMinor = computed(() => {
        const ownUserId = this.ownUserId();
        return this.state().balances.find(b => b.userId === ownUserId)?.netMinor ?? 0;
    });

    protected suggestionRows = computed<SuggestionRow[]>(() => {
        return this.state().suggestions.map(suggestion => ({
            suggestion,
            fromName: this.nameOf(suggestion.fromUserId),
            toName: this.nameOf(suggestion.toUserId),
            canRecord: this.canRecordSettlementFrom(suggestion.fromUserId),
        }));
    });

    // ── Expense dialog ───────────────────────────────────────────────────────
    protected showExpenseDialog = signal(false);
    /** Set when the dialog is editing rather than adding. */
    protected editingExpenseId = signal<string | null>(null);
    /** The expense being edited was written with per-person amounts this form cannot reproduce. */
    protected editingWasExact = signal(false);
    protected saving = signal(false);
    /** The expense whose delete button has been pressed once. A second press does it. */
    protected confirmDeleteId = signal<string | null>(null);

    protected formDescription = signal('');
    /** Text, not a number: the string is the only thing that survives to {@link parseMinor} intact. */
    protected formAmount = signal('');
    protected formPayerUserId = signal<string | null>(null);
    protected formOccurredAt = signal('');
    protected formSplitKind = signal<ExpenseSplitKind>(ExpenseSplitKind.Equal);
    /**
     * `Equal` over an empty `shares` array, which the server reads as everyone in the guild.
     *
     * <p>The default, because rent and internet are what a house ledger is mostly made of, and
     * because it is the one split that stays correct when a flatmate moves in.</p>
     */
    protected formSplitEveryone = signal(true);
    protected formParticipantIds = signal<string[]>([]);
    protected formWeights = signal<Record<string, number>>({});
    protected formCategory = signal<ExpenseCategory>(ExpenseCategory.Uncategorized);

    protected formAmountMinor = computed(() => parseMinor(this.formAmount(), this.currency()));
    protected formAmountInvalid = computed(() => {
        const raw = this.formAmount().trim();
        if (!raw) return false;
        const minor = this.formAmountMinor();
        return minor === null || minor <= 0;
    });

    /** `MaxDescriptionLength`, mirrored onto the input so 201 characters is untypable, not a 400. */
    protected readonly descriptionMaxLength = LEDGER_LIMITS.descriptionMaxLength;

    /**
     * Whether the named payer is still in the guild.
     *
     * <p>The server refuses a non-member payer with a `400` - a balance owed to somebody who has
     * left is one nobody can ever clear. That is not reachable when adding an expense, because the
     * picker only lists members; it is reachable when <b>editing</b> one whose payer has since moved
     * out, and the form has to say so rather than let Save answer with a bare 400.</p>
     *
     * <p>True while the member list is still loading, so a slow roster does not brand every payer
     * invalid for the second the dialog takes to fill.</p>
     */
    protected payerIsMember = computed(() => {
        const payer = this.formPayerUserId();
        if (!payer) return true;
        if (this.members().length === 0) return true;
        return this.memberById().has(payer);
    });

    protected formValid = computed(() => {
        const minor = this.formAmountMinor();
        const description = this.formDescription().trim();
        if (!description || description.length > this.descriptionMaxLength) return false;
        if (minor === null || minor <= 0) return false;
        if (!this.payerIsMember()) return false;
        if (this.formSplitKind() === ExpenseSplitKind.Equal && this.formSplitEveryone()) return true;
        return this.formParticipantIds().length > 0;
    });

    /** The viewer's own payment details, opened from the header. Guild-scoped, not per channel. */
    protected showHandlesDialog = signal(false);

    // ── Settlement dialog ────────────────────────────────────────────────────
    protected showSettleDialog = signal(false);
    protected settleFromUserId = signal<string | null>(null);
    protected settleToUserId = signal<string | null>(null);
    protected settleAmount = signal('');
    protected settleAmountMinor = computed(() => parseMinor(this.settleAmount(), this.currency()));
    protected settleValid = computed(() => {
        const minor = this.settleAmountMinor();
        const from = this.settleFromUserId();
        const to = this.settleToUserId();
        if (!from || !to || from === to) return false;
        if (minor === null || minor <= 0) return false;
        // Same rule as the payer: neither party may be a non-member. A settle-suggestion computed
        // before somebody moved out can still name them, and it now `400`s rather than recording a
        // transfer that clears nothing.
        return this.bothPartiesAreMembers();
    });

    /** False only once the roster has actually arrived - see {@link payerIsMember}. */
    private bothPartiesAreMembers = computed(() => {
        if (this.members().length === 0) return true;
        const known = this.memberById();
        return known.has(this.settleFromUserId() ?? '') && known.has(this.settleToUserId() ?? '');
    });

    /**
     * Who this dialog would actually help pay, or null.
     *
     * <p>Only ever the viewer paying somebody else. Recording a settlement between two other people
     * is a `ManageLedger` bookkeeping action - the money moved elsewhere, days ago, and nobody
     * present needs a QR code for it. Offering payment details there would put a flatmate's IBAN on
     * screen for a transaction the viewer is not party to, which is the kind of casual disclosure
     * the sealed blob exists to avoid.</p>
     */
    protected payeeForSheet = computed(() => {
        const ownUserId = this.ownUserId();
        const to = this.settleToUserId();
        if (!ownUserId || !to || to === ownUserId) return null;
        return this.settleFromUserId() === ownUserId ? to : null;
    });

    /**
     * What goes in the QR-bill's message line, and therefore on somebody's bank statement.
     *
     * <p>The channel name rather than the ledger's contents. A settlement clears a running balance
     * made of many expenses, so naming one of them would be wrong, and listing them would put the
     * household's shopping on a bank statement that other people read.</p>
     */
    protected settlementReference = computed(() =>
        this.translate.instant('LEDGER.SETTLEMENT_REFERENCE', {channel: this.channel().name}));

    // ── Currency dialog ──────────────────────────────────────────────────────
    protected showCurrencyDialog = signal(false);
    protected currencyDraft = signal('');
    /** The code the server would store, or null if it would answer `400` instead. */
    private currencyCode = computed(() => normalizeCurrencyCode(this.currencyDraft()));
    protected currencyValid = computed(() => this.currencyCode() !== null);
    /**
     * The same stored integer under the proposed code, shown next to the current one.
     *
     * <p>This is the confirmation dialog's entire argument: 1234 stays 1234 and only the label
     * moves, so a house switching CHF to EUR has just given itself a discount it never agreed to.</p>
     */
    protected currencyPreview = computed(() => {
        const sample = this.state().expenses[0]?.amountMinor ?? 123456;
        const code = this.currencyCode();
        return {
            before: formatMinor(sample, this.currency()),
            after: code ? formatMinor(sample, code) : '',
        };
    });

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => this.ledger.loadFor(channelId));
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => {
                this.guildService.getOwnMember(guildId).subscribe({
                    next: member => this.ownMember.set(member),
                    // Failing closed: no member means no permissions, which hides the write
                    // affordances rather than offering ones the server will refuse.
                    error: () => this.ownMember.set(null),
                });
                this.guildService.getMembers(guildId, 0, MEMBER_PAGE_SIZE).subscribe({
                    next: members => this.members.set(members),
                    error: () => undefined,
                });
            });
        });
    }

    // ── Paging ───────────────────────────────────────────────────────────────

    /**
     * Pulls in the page of older expenses behind the ones on screen.
     *
     * <p>The service already ignores a call with no cursor or one in flight, so the button does not
     * have to be disabled to be safe - it is hidden on `nextCursor === null` only because there is
     * nothing left to offer.</p>
     */
    protected loadMore(): void {
        this.ledger.loadMore(this.channel().id);
    }

    // ── Formatting ───────────────────────────────────────────────────────────

    /** The only way an amount reaches the template. */
    protected money(amountMinor: number): string {
        return formatMinor(amountMinor, this.currency());
    }

    protected absMoney(amountMinor: number): string {
        return formatMinor(Math.abs(amountMinor), this.currency());
    }

    protected day(iso: string): string {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', year: 'numeric'}).format(date);
    }

    protected nameOf(userId: string): string {
        const member = this.memberById().get(userId);
        return member?.nickname ?? member?.profile?.userName ?? this.translate.instant('LEDGER.SOMEONE');
    }

    /**
     * {@link nameOf} as a value, for the panels that render member names but hold no roster.
     *
     * <p>A computed over `memberById` rather than a bound method reference, so a child re-renders
     * when the roster lands - a plain `this.nameOf.bind(this)` is a stable reference and would leave
     * every name in the bills panel reading "Someone" until something else happened to change.</p>
     */
    protected nameResolver = computed(() => {
        const members = this.memberById();
        const fallback = this.translate.instant('LEDGER.SOMEONE');
        return (userId: string): string => {
            const member = members.get(userId);
            return member?.nickname ?? member?.profile?.userName ?? fallback;
        };
    });

    protected initialOf(userId: string): string {
        return this.nameOf(userId).trim().charAt(0).toUpperCase() || '?';
    }

    // ── Expense dialog ───────────────────────────────────────────────────────

    protected openAddExpense(): void {
        this.editingExpenseId.set(null);
        this.editingWasExact.set(false);
        this.formDescription.set('');
        this.formAmount.set('');
        this.formPayerUserId.set(this.ownUserId());
        this.formOccurredAt.set(this.todayInputValue());
        this.formSplitKind.set(ExpenseSplitKind.Equal);
        this.formSplitEveryone.set(true);
        this.formParticipantIds.set([]);
        this.formWeights.set({});
        // Uncategorized rather than a guess. It is a real bucket the rollup names honestly, where a
        // defaulted "Groceries" would quietly file the rent under food.
        this.formCategory.set(ExpenseCategory.Uncategorized);
        this.showExpenseDialog.set(true);
    }

    protected openEditExpense(expense: Expense): void {
        this.editingExpenseId.set(expense.id);
        this.formDescription.set(expense.description);
        // Round-trips exactly: the integer becomes digits and the digits become the same integer.
        this.formAmount.set(minorToInputString(expense.amountMinor, this.currency()));
        this.formPayerUserId.set(expense.payerUserId);
        this.formOccurredAt.set(expense.occurredAt.slice(0, 10));
        // Exact is readable but not writable here - a client that filled in per-person amounts
        // would be picking the remainder itself. So an Exact expense opens as the equal split it
        // would become, and the dialog says so rather than quietly rewriting it on save.
        this.editingWasExact.set(expense.splitKind === ExpenseSplitKind.Exact);
        this.formSplitKind.set(expense.splitKind === ExpenseSplitKind.Shares
            ? ExpenseSplitKind.Shares
            : ExpenseSplitKind.Equal);
        this.formSplitEveryone.set(expense.shares.length === 0);
        this.formParticipantIds.set(expense.shares.map(s => s.userId));
        this.formWeights.set(Object.fromEntries(expense.shares.map(s => [s.userId, s.shareValue || 1])));
        this.formCategory.set(expense.category ?? ExpenseCategory.Uncategorized);
        this.showExpenseDialog.set(true);
    }

    /** Narrows the list. Re-reads from the first page - see `LedgerService.setCategory`. */
    protected setCategoryFilter(category: ExpenseCategory | null): void {
        this.ledger.setCategory(this.channel().id, category);
    }

    protected openReceipts(expense: Expense): void {
        this.receiptsFor.set(expense);
    }

    protected toggleParticipant(userId: string): void {
        this.formParticipantIds.update(ids =>
            ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId]);
    }

    protected isParticipant(userId: string): boolean {
        return this.formParticipantIds().includes(userId);
    }

    protected weightOf(userId: string): number {
        return this.formWeights()[userId] ?? 1;
    }

    protected setWeight(userId: string, value: string): void {
        // Weights are counts of people-equivalents, so a whole number at least one. They are not
        // money and never become money on this side - the server turns them into amounts.
        const parsed = Math.trunc(Number(value));
        const weight = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        this.formWeights.update(all => ({...all, [userId]: weight}));
    }

    protected setSplitKind(kind: ExpenseSplitKind): void {
        this.formSplitKind.set(kind);
        // A weighted split over "everyone" has nothing to weight, so switching to Shares seeds the
        // picker with everybody rather than emptying it.
        if (kind === ExpenseSplitKind.Shares && this.formParticipantIds().length === 0) {
            this.formParticipantIds.set(this.members().map(m => m.userId));
        }
    }

    protected submitExpense(): void {
        const amountMinor = this.formAmountMinor();
        // In-flight check, not only button state: the form fields submit on Enter and a held key
        // repeats. Two identical expenses are indistinguishable from a legitimate pair of them,
        // so nobody would spot the duplicate until the balances were wrong.
        if (this.saving() || !this.formValid() || amountMinor === null) return;

        const channelId = this.channel().id;
        const editingId = this.editingExpenseId();
        const body = {
            description: this.formDescription().trim(),
            amountMinor,
            payerUserId: this.formPayerUserId() ?? undefined,
            occurredAt: this.occurredAtIso(),
            splitKind: this.formSplitKind(),
            shares: this.sharesForSubmit(),
            category: this.formCategory(),
        };

        this.saving.set(true);
        const request$ = editingId
            ? this.ledger.editExpense(channelId, editingId, body)
            : this.ledger.addExpense(channelId, body);

        request$.subscribe({
            next: () => {
                this.saving.set(false);
                this.showExpenseDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('LEDGER.SAVE_FAILED'), err);
            },
        });
    }

    /**
     * First press arms, second press deletes.
     *
     * <p>Cheaper than a modal and enough of a speed bump: a deleted expense moves everyone's
     * balance, so a mis-click on the row next to the one you meant is not a private mistake.</p>
     */
    protected deleteExpense(expense: Expense): void {
        if (this.confirmDeleteId() !== expense.id) {
            this.confirmDeleteId.set(expense.id);
            return;
        }
        this.confirmDeleteId.set(null);
        this.ledger.removeExpense(this.channel().id, expense.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('LEDGER.DELETE_FAILED'), err),
        });
    }

    protected canEditExpense(expense: Expense): boolean {
        if (this.canManageLedger()) return true;
        // "Your own" is the one you entered. An expense someone else typed in on your behalf is
        // theirs to correct, and the server would refuse anyway.
        return this.can(ModulePermissions.AddExpenses) && expense.createdByUserId === this.ownUserId();
    }

    // ── Settling ─────────────────────────────────────────────────────────────

    protected openSettle(suggestion?: TransferSuggestion): void {
        const ownUserId = this.ownUserId();
        this.settleFromUserId.set(suggestion?.fromUserId ?? ownUserId);
        this.settleToUserId.set(suggestion?.toUserId ?? null);
        this.settleAmount.set(suggestion ? minorToInputString(suggestion.amountMinor, this.currency()) : '');
        this.showSettleDialog.set(true);
    }

    /**
     * Who may record a payment *out of* `fromUserId`.
     *
     * <p>The server gates on the payer alone - `dto.FromUserId == userId ? AddExpenses :
     * ManageLedger` - so being the person who was paid buys nothing. "Marco paid me" rewrites
     * Marco's balance on Marco's word-of-mouth, which is exactly the write `ManageLedger` exists
     * to hold back, and offering the button to the recipient would collect a 403 every time.</p>
     */
    private canRecordSettlementFrom(fromUserId: string | null): boolean {
        if (this.canManageLedger()) return true;
        return this.canAddExpense() && !!fromUserId && fromUserId === this.ownUserId();
    }

    protected canRecordCurrentSettlement = computed(() =>
        this.canRecordSettlementFrom(this.settleFromUserId()));

    protected submitSettlement(): void {
        const amountMinor = this.settleAmountMinor();
        const from = this.settleFromUserId();
        const to = this.settleToUserId();
        // `canRecordCurrentSettlement()` is re-checked here rather than trusted from the disabled
        // button: recording a settlement *from* someone else needs ManageLedger, and Enter would
        // otherwise reach the request without passing the gate the template applies.
        if (this.saving() || !this.settleValid() || !this.canRecordCurrentSettlement()) return;
        if (amountMinor === null || !from || !to) return;

        this.saving.set(true);
        this.ledger.recordSettlement(this.channel().id, {
            fromUserId: from,
            toUserId: to,
            amountMinor,
        }).subscribe({
            next: () => {
                this.saving.set(false);
                this.showSettleDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('LEDGER.SETTLE_FAILED'), err);
            },
        });
    }

    // ── Currency ─────────────────────────────────────────────────────────────

    protected openCurrencyDialog(): void {
        this.currencyDraft.set(this.currency());
        this.showCurrencyDialog.set(true);
    }

    protected submitCurrency(): void {
        // Upper-cased here rather than left to the server, which does the same thing and then
        // answers with the canonical form - so sending "chf" would round-trip a no-op as a change.
        const currency = this.currencyCode();
        if (this.saving() || !currency) return;
        if (currency === this.currency()) {
            this.showCurrencyDialog.set(false);
            return;
        }

        this.saving.set(true);
        this.ledger.saveConfig(this.channel().id, {currency}).subscribe({
            next: () => {
                this.saving.set(false);
                this.showCurrencyDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('LEDGER.CURRENCY_FAILED'), err);
            },
        });
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * The `shares` array for a write.
     *
     * <p>Weights under `Shares`, bare user ids under a picked `Equal`, and an empty array for the
     * whole guild. Never a per-person `amountMinor`, and never `Exact`: the remainder is the
     * server's to distribute.</p>
     */
    private sharesForSubmit(): ExpenseShareDto[] {
        if (this.formSplitKind() === ExpenseSplitKind.Shares) {
            return this.formParticipantIds().map(userId => ({userId, shareValue: this.weightOf(userId)}));
        }
        if (this.formSplitEveryone()) return [];
        return this.formParticipantIds().map(userId => ({userId}));
    }

    /** A `yyyy-MM-dd` from the date input back to an instant the server will accept. */
    private occurredAtIso(): string | undefined {
        const value = this.formOccurredAt().trim();
        if (!value) return undefined;
        const date = new Date(`${value}T12:00:00`);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    private todayInputValue(): string {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
}
