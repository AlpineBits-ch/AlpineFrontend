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
import {ChannelIconComponent} from '../channel-icon/channel-icon.component';
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
    /** Only drawn once somebody has looked; see `LedgerService.receiptCountFor`. */
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

@Component({
    selector: 'app-ledger-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button,
        Dialog,
        InputText,
        Select,
        Tooltip,
        FormsModule,
        PrimeTemplate,
        TranslateModule,
        BillsPanelComponent,
        LedgerSummaryComponent,
        ReceiptGalleryComponent,
        PaySheetComponent,
        PaymentHandlesEditorComponent,
        ChannelIconComponent,
    ],
    templateUrl: './ledger-channel.component.html',
})
export class LedgerChannelComponent {
    readonly channel = input.required<ChannelDto>();
    /** Bound by main-page, in common with every other full-page channel view. */
    back = output();

    protected navService = inject(NavigationService);
    private ledger = inject(LedgerService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly SplitKind = ExpenseSplitKind;

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    private readonly members = signal<GuildMemberDto[]>([]);

    protected readonly state = computed(() => this.ledger.stateFor(this.channel().id));
    protected readonly currency = computed(() => this.ledger.currencyFor(this.channel().id));
    protected readonly ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    /** The guild this channel belongs to, or null while the workspace is still elsewhere. */
    private readonly guild = computed(() => {
        const workspace = this.navService.workspace();
        return workspace.type === 'server' && workspace.guild.id === this.channel().guildId
            ? workspace.guild
            : null;
    });

    /** A `403` here means the module is off, not that this member lacks a role (the owner gets the same `403`), so it hides rather than shows a permission error; an unresolved guild counts as enabled. */
    protected readonly hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Ledger);
        return moduleOff || this.state().forbidden;
    });

    // ── Permissions (§2) ─────────────────────────────────────────────────────

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private readonly abilities = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.ownUserId()),
    );

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** Edit anyone's expense, record a settlement between two other people, set the currency. */
    protected readonly canManageLedger = computed(() => this.can(ModulePermissions.ManageLedger));
    /** Add an expense you paid, and edit or delete the ones you entered. */
    protected readonly canAddExpense = computed(
        () => this.can(ModulePermissions.AddExpenses) || this.canManageLedger(),
    );
    /** Naming someone else as the payer is a third-party write, so it needs the manage bit. */
    protected readonly canNamePayer = computed(() => this.canManageLedger());

    // ── Derived view models ──────────────────────────────────────────────────
    private readonly memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected readonly memberOptions = computed<MemberOption[]>(() =>
        this.members()
            .map(m => ({value: m.userId, label: this.nameOf(m.userId)}))
            .sort((a, b) => a.label.localeCompare(b.label)),
    );

    protected readonly expenseRows = computed<ExpenseRow[]>(() => {
        const ownUserId = this.ownUserId();
        return this.state().expenses.map(expense => ({
            expense,
            payerName: this.nameOf(expense.payerUserId),
            enteredByName:
                expense.createdByUserId === expense.payerUserId ? null : this.nameOf(expense.createdByUserId),
            ownShareMinor: expense.shares.find(s => s.userId === ownUserId)?.amountMinor ?? null,
            splitLabelKey: `LEDGER.SPLIT_${expense.splitKind.toUpperCase()}`,
            categoryLabelKey: expenseCategoryLabelKey(expense.category ?? ExpenseCategory.Uncategorized),
            receiptCount: this.ledger.receiptCountFor(expense.id),
            canEdit: this.canEditExpense(expense),
        }));
    });

    // ── Tabs and the category filter ─────────────────────────────────────────

    protected readonly tab = signal<LedgerTab>('expenses');

    /** `null` is everything. Held in the service, because it decides what the loaded pages mean. */
    protected readonly categoryFilter = computed(() => this.state().category);

    protected readonly categories = EXPENSE_CATEGORIES;

    protected readonly categoryOptions = computed<MemberOption[]>(() =>
        this.categories.map(category => ({
            value: category,
            label: this.translate.instant(expenseCategoryLabelKey(category)),
        })),
    );

    /** The receipt gallery's expense, or null when it is closed. */
    protected readonly receiptsFor = signal<Expense | null>(null);

    /** Everyone with a non-zero position, biggest creditor first; the server omits zero balances, so an empty list is a fact, not a gap (see {@link settled}). */
    protected readonly balanceRows = computed<BalanceRow[]>(() => {
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

    /** True once balances have loaded and everyone is at zero. */
    protected readonly settled = computed(() => this.state().loaded && this.state().balances.length === 0);

    protected readonly ownNetMinor = computed(() => {
        const ownUserId = this.ownUserId();
        return this.state().balances.find(b => b.userId === ownUserId)?.netMinor ?? 0;
    });

    protected readonly suggestionRows = computed<SuggestionRow[]>(() => {
        return this.state().suggestions.map(suggestion => ({
            suggestion,
            fromName: this.nameOf(suggestion.fromUserId),
            toName: this.nameOf(suggestion.toUserId),
            canRecord: this.canRecordSettlementFrom(suggestion.fromUserId),
        }));
    });

    // ── Expense dialog ───────────────────────────────────────────────────────
    protected readonly showExpenseDialog = signal(false);
    /** Set when the dialog is editing rather than adding. */
    protected readonly editingExpenseId = signal<string | null>(null);
    /** The expense being edited was written with per-person amounts this form cannot reproduce. */
    protected readonly editingWasExact = signal(false);
    protected readonly saving = signal(false);
    /** The expense whose delete button has been pressed once. A second press does it. */
    protected readonly confirmDeleteId = signal<string | null>(null);

    protected readonly formDescription = signal('');
    /** Text, not a number: money is stored as integer minor units and only formatted at display time via {@link parseMinor}/{@link formatMinor}. */
    protected readonly formAmount = signal('');
    protected readonly formPayerUserId = signal<string | null>(null);
    protected readonly formOccurredAt = signal('');
    protected readonly formSplitKind = signal<ExpenseSplitKind>(ExpenseSplitKind.Equal);
    /** Equal over an empty shares array, which the server reads as everyone in the guild. */
    protected readonly formSplitEveryone = signal(true);
    protected readonly formParticipantIds = signal<string[]>([]);
    protected readonly formWeights = signal<Record<string, number>>({});
    protected readonly formCategory = signal<ExpenseCategory>(ExpenseCategory.Uncategorized);

    protected readonly formAmountMinor = computed(() => parseMinor(this.formAmount(), this.currency()));
    protected readonly formAmountInvalid = computed(() => {
        const raw = this.formAmount().trim();
        if (!raw) return false;
        const minor = this.formAmountMinor();
        return minor === null || minor <= 0;
    });

    /** `MaxDescriptionLength`, mirrored onto the input so 201 characters is untypable, not a 400. */
    protected readonly descriptionMaxLength = LEDGER_LIMITS.descriptionMaxLength;

    protected readonly payerIsMember = computed(() => {
        const payer = this.formPayerUserId();
        if (!payer) return true;
        if (this.members().length === 0) return true;
        return this.memberById().has(payer);
    });

    protected readonly formValid = computed(() => {
        const minor = this.formAmountMinor();
        const description = this.formDescription().trim();
        if (!description || description.length > this.descriptionMaxLength) return false;
        if (minor === null || minor <= 0) return false;
        if (!this.payerIsMember()) return false;
        if (this.formSplitKind() === ExpenseSplitKind.Equal && this.formSplitEveryone()) return true;
        return this.formParticipantIds().length > 0;
    });

    /** The viewer's own payment details, opened from the header. Guild-scoped, not per channel. */
    protected readonly showHandlesDialog = signal(false);

    // ── Settlement dialog ────────────────────────────────────────────────────
    protected readonly showSettleDialog = signal(false);
    protected readonly settleFromUserId = signal<string | null>(null);
    protected readonly settleToUserId = signal<string | null>(null);
    protected readonly settleAmount = signal('');
    protected readonly settleAmountMinor = computed(() => parseMinor(this.settleAmount(), this.currency()));
    protected readonly settleValid = computed(() => {
        const minor = this.settleAmountMinor();
        const from = this.settleFromUserId();
        const to = this.settleToUserId();
        if (!from || !to || from === to) return false;
        if (minor === null || minor <= 0) return false;
        // Neither settlement party may be a non-member; the server 400s rather than recording a transfer that clears nothing.
        return this.bothPartiesAreMembers();
    });

    /** False only once the roster has actually arrived. */
    private readonly bothPartiesAreMembers = computed(() => {
        if (this.members().length === 0) return true;
        const known = this.memberById();
        return known.has(this.settleFromUserId() ?? '') && known.has(this.settleToUserId() ?? '');
    });

    /** The payee to show a pay sheet for, or null; only set when the viewer is the one settling, never for a third-party settlement. */
    protected readonly payeeForSheet = computed(() => {
        const ownUserId = this.ownUserId();
        const to = this.settleToUserId();
        if (!ownUserId || !to || to === ownUserId) return null;
        return this.settleFromUserId() === ownUserId ? to : null;
    });

    /** The QR-bill message line: the channel name, not any one expense, since a settlement clears a running balance. */
    protected readonly settlementReference = computed(() =>
        this.translate.instant('LEDGER.SETTLEMENT_REFERENCE', {channel: this.channel().name}),
    );

    // ── Currency dialog ──────────────────────────────────────────────────────
    protected readonly showCurrencyDialog = signal(false);
    protected readonly currencyDraft = signal('');
    /** The code the server would store, or null if it would answer `400` instead. */
    private readonly currencyCode = computed(() => normalizeCurrencyCode(this.currencyDraft()));
    protected readonly currencyValid = computed(() => this.currencyCode() !== null);
    /** Same stored integer under the proposed code: currency change relabels amounts, it never rescales them. */
    protected readonly currencyPreview = computed(() => {
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
                    // Failing closed: no member means no permissions, hiding write affordances rather than offering ones the server would refuse.
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

    /** The service ignores a call with no cursor or one already in flight, so this is safe to call freely. */
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
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', year: 'numeric'}).format(
            date,
        );
    }

    protected nameOf(userId: string): string {
        const member = this.memberById().get(userId);
        return member?.nickname ?? member?.profile?.userName ?? this.translate.instant('LEDGER.SOMEONE');
    }

    /** A computed, not a bound method reference: a stable reference leaves child panels reading "Someone" until something else changes. */
    protected readonly nameResolver = computed(() => {
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
        // Exact is readable but not writable here; an Exact expense opens as the equal split it would become, and the dialog says so instead of quietly rewriting it on save.
        this.editingWasExact.set(expense.splitKind === ExpenseSplitKind.Exact);
        this.formSplitKind.set(
            expense.splitKind === ExpenseSplitKind.Shares ? ExpenseSplitKind.Shares : ExpenseSplitKind.Equal,
        );
        this.formSplitEveryone.set(expense.shares.length === 0);
        this.formParticipantIds.set(expense.shares.map(s => s.userId));
        this.formWeights.set(Object.fromEntries(expense.shares.map(s => [s.userId, s.shareValue || 1])));
        this.formCategory.set(expense.category ?? ExpenseCategory.Uncategorized);
        this.showExpenseDialog.set(true);
    }

    /** Narrows the list. Re-reads from the first page; see `LedgerService.setCategory`. */
    protected setCategoryFilter(category: ExpenseCategory | null): void {
        this.ledger.setCategory(this.channel().id, category);
    }

    protected openReceipts(expense: Expense): void {
        this.receiptsFor.set(expense);
    }

    protected toggleParticipant(userId: string): void {
        this.formParticipantIds.update(ids =>
            ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId],
        );
    }

    protected isParticipant(userId: string): boolean {
        return this.formParticipantIds().includes(userId);
    }

    protected weightOf(userId: string): number {
        return this.formWeights()[userId] ?? 1;
    }

    protected setWeight(userId: string, value: string): void {
        // Weights are people-equivalent counts (whole numbers, at least one), never money; the server turns them into amounts.
        const parsed = Math.trunc(Number(value));
        const weight = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        this.formWeights.update(all => ({...all, [userId]: weight}));
    }

    protected setSplitKind(kind: ExpenseSplitKind): void {
        this.formSplitKind.set(kind);
        // A weighted split over "everyone" has nothing to weight, so switching to Shares seeds the picker with everybody instead of emptying it.
        if (kind === ExpenseSplitKind.Shares && this.formParticipantIds().length === 0) {
            this.formParticipantIds.set(this.members().map(m => m.userId));
        }
    }

    protected submitExpense(): void {
        const amountMinor = this.formAmountMinor();
        // In-flight check, not only button state: Enter/a held key can double-submit, and duplicate expenses are indistinguishable from a legitimate pair, silently skewing balances.
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

    /** First press arms, second press deletes; a mis-click matters because it moves everyone's balance. */
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
        // "Your own" means entered by you, not paid by you; an expense someone else typed in for you is theirs to correct (the server refuses otherwise).
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

    /** Who may record a payment out of `fromUserId`; the server gates on the payer alone (`AddExpenses` for yourself, `ManageLedger` otherwise), so being the recipient buys nothing. */
    private canRecordSettlementFrom(fromUserId: string | null): boolean {
        if (this.canManageLedger()) return true;
        return this.canAddExpense() && !!fromUserId && fromUserId === this.ownUserId();
    }

    protected readonly canRecordCurrentSettlement = computed(() =>
        this.canRecordSettlementFrom(this.settleFromUserId()),
    );

    protected submitSettlement(): void {
        const amountMinor = this.settleAmountMinor();
        const from = this.settleFromUserId();
        const to = this.settleToUserId();
        // Re-checked here, not trusted from the disabled button: Enter can submit past the template's gate, and a third-party settlement needs ManageLedger.
        if (this.saving() || !this.settleValid() || !this.canRecordCurrentSettlement()) return;
        if (amountMinor === null || !from || !to) return;

        this.saving.set(true);
        this.ledger
            .recordSettlement(this.channel().id, {
                fromUserId: from,
                toUserId: to,
                amountMinor,
            })
            .subscribe({
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
        // Upper-cased here, not left to the server: otherwise sending "chf" would round-trip a no-op as a change.
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

    /** Splits are described, never computed client-side: sends `Equal` or `Shares`, never `Exact` or a per-person `amountMinor`; the server distributes the remainder. */
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
