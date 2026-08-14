import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    untracked,
} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {DatePicker} from 'primeng/datepicker';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {
    EXPIRY_WARNING_DAYS_MAX,
    EXPIRY_WARNING_DAYS_MIN,
    isRestockLoopEnabled,
    isValidExpiryWarningDays,
    PantryExpiryState,
    pantryExpiryState,
    PantryItem,
    PantryStockState,
    pantryStockState,
} from '../../../../dtos/response/pantry.dto';
import {UpdatePantryItemDto} from '../../../../dtos/request/pantry.dto';
import {
    DEFAULT_EXPIRING_DAYS,
    DEFAULT_EXPIRY_WARNING_DAYS,
    PantryService,
} from '../../../../services/pantry.service';
import {GuildService} from '../../../../services/guild.service';
import {ToastService} from '../../../../services/toast.service';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {channelIcon} from '../../channel-types';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {guildAbilities} from '../../guild-permissions';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {PantryScanComponent} from './pantry-scan.component';
import {EntitlementStore} from '../../../../stores/entitlement.store';
import {ModuleNotInPlanComponent} from '../module-not-in-plan/module-not-in-plan.component';

/**
 * The look-ahead overrides offered by the house-wide expiring view, alongside the default of no
 * override at all.
 *
 * <p>Each of these replaces *every* pantry's own `expiryWarningDays` for one query - the "what goes
 * off this month" question. The default (`null`) is the everyday one and lets a freezer set to 14
 * days and a fridge set to 2 both answer correctly in the same list.</p>
 */
const EXPIRING_WINDOWS = [3, 7, 14, 30] as const;

/**
 * One pantry: the stock in one location, and the restock wiring behind it.
 *
 * <p>Structured rows, no messages - a Pantry channel has no history and no composer. Two
 * bodies hang off the same header: this pantry's stock, and the **house-wide** expiring
 * view, which spans every pantry in the guild rather than this one. Keeping them behind a
 * toggle rather than in two places is what stops "what needs eating" being read as a
 * property of the fridge you happen to have open.</p>
 */
@Component({
    selector: 'app-pantry-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        DatePipe, FormsModule, TranslateModule, Button, Dialog, InputText, Select, DatePicker,
        ToggleSwitch, Tooltip, PrimeTemplate, PantryScanComponent, ModuleNotInPlanComponent,
    ],
    templateUrl: './pantry-channel.component.html',
})
export class PantryChannelComponent implements OnDestroy {
    channel = input.required<ChannelDto>();
    /**
     * Mobile "leave this channel", bound by the main page exactly as the forum and message
     * views bind theirs. Unused inside the template on purpose - the header's own hamburger
     * is how the nav is reached here.
     */
    back = output();

    protected readonly EXPIRING_WINDOWS = EXPIRING_WINDOWS;
    protected readonly minWarningDays = EXPIRY_WARNING_DAYS_MIN;
    protected readonly maxWarningDays = EXPIRY_WARNING_DAYS_MAX;

    protected navService = inject(NavigationService);
    private pantry = inject(PantryService);
    private entitlements = inject(EntitlementStore);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    private ownMember = signal<SelfGuildMemberDto | null>(null);

    /** Which body is showing. `expiring` is guild-wide; see the class doc. */
    protected view = signal<'stock' | 'expiring' | 'scan'>('stock');
    /** `null` - the default - is "each pantry's own window", not "no window". */
    protected expiringDays = signal<number | null>(DEFAULT_EXPIRING_DAYS);

    protected icon = computed(() => channelIcon(this.channel().type));

    private guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.channel().guildId) ?? null);

    /**
     * §13.2: a 403 from any of these routes often means the guild simply doesn't have the
     * module, not that the caller lacks a role. When we can see the guild and the flag is
     * off we say so instead of rendering a stock list that can never load - "your house
     * doesn't do this" and "you're not allowed" are different sentences.
     *
     * A guild we haven't got yet reads as enabled, so the view doesn't flash a module-off
     * panel during load.
     */
    protected moduleOff = computed(() => {
        const guild = this.guild();
        return !!guild && !guildHasFeature(guild, GuildFeature.Pantry);
    });

    /** The channel's own guild id, which is known before the guild list is. */
    protected guildId = computed(() => this.channel().guildId);

    /**
     * Off because the plan does not cover it, which is a different sentence with a different
     * remedy: no permission and no toggle in this house produces the module.
     *
     * <p>False while nothing is held, so a screen that has not read the resolution renders exactly
     * what it rendered before this existed.</p>
     */
    protected moduleWithheld = computed(() =>
        this.entitlements.moduleStanding(this.guildId(), GuildFeature.Pantry) === 'withheld');

    // ── Permissions ──────────────────────────────────────────────────────────


    private ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    private abilities = computed(() => guildAbilities(this.ownMember(), this.guild(), this.ownUserId()));

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /**
     * Add/edit/delete stock and thresholds, and the restock wiring. Reading needs only
     * `ViewChannel`, which the user demonstrably has by being able to open the channel at
     * all - so there is no separate read gate here.
     */
    protected canManage = computed(() => this.can(ModulePermissions.ManagePantry));

    // ── Stock ────────────────────────────────────────────────────────────────

    protected items = computed(() => this.pantry.itemsFor(this.channel().id));
    protected loading = computed(() => this.pantry.loading(this.channel().id));
    protected loadError = computed(() => this.pantry.loadError(this.channel().id));
    protected hasLoaded = computed(() => this.pantry.hasLoaded(this.channel().id));

    protected config = computed(() => this.pantry.configFor(this.channel().id));

    /**
     * The master switch. With no list channel configured, every threshold in this pantry is
     * decoration: nothing is ever appended anywhere. The banner and the muted threshold
     * column both hang off this rather than off individual items.
     */
    protected restockLoopOn = computed(() => isRestockLoopEnabled(this.config()));

    /**
     * Whether we have an answer at all. Items and config are two requests, and items
     * usually win - without this the view would flash "restocking is off" over every
     * threshold for as long as the config took, which is exactly the claim it must not
     * make carelessly.
     */
    protected loopKnown = computed(() => this.config() !== undefined);

    /** The one that drives presentation: known, and known to be off. */
    protected loopOff = computed(() => this.loopKnown() && !this.restockLoopOn());

    protected warningDays = computed(() => this.config()?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS);

    /** The configured list channel's name, for the banner - or null if it has vanished. */
    protected restockListName = computed(() => {
        const id = this.config()?.restockListChannelId;
        return id ? this.channelNameFor(id) : null;
    });

    /**
     * The picker's options: `List` channels **in this guild** only. A list in another house
     * is not a legal target and the server rejects it, so it is never offered.
     */
    protected listChannelOptions = computed(() => (this.guild()?.channels ?? [])
        .filter(c => c.type === ChannelType.List)
        .map(c => ({label: c.name, value: c.id})));

    /**
     * Ticked every minute so the expiry badges age without each row reading the clock, and
     * so `pantryExpiryState` is re-derived rather than frozen at first render.
     */
    protected nowTick = signal(Date.now());
    private tickIntervalId = setInterval(() => this.nowTick.set(Date.now()), 60_000);

    /**
     * Rows with their derived state attached once, rather than calling the state machine
     * three times per row from the template.
     */
    protected rows = computed(() => {
        const now = this.nowTick();
        const days = this.warningDays();
        return this.items().map(item => ({
            item,
            state: pantryStockState(item),
            expiry: pantryExpiryState(item, days, now),
        }));
    });

    /** Header counts. `listed` is not a subset of `low` - it is the state *after* low. */
    protected listedCount = computed(() => this.rows().filter(r => r.state === 'listed').length);
    protected lowCount = computed(() => this.rows().filter(r => r.state === 'low').length);
    protected expiringCount = computed(() => this.rows().filter(r => r.expiry !== 'none').length);

    // ── House-wide expiring ──────────────────────────────────────────────────

    protected expiringRows = computed(() => {
        const now = this.nowTick();
        const days = this.expiringDays();
        return this.pantry.expiringFor(this.channel().guildId).map(item => ({
            item,
            // The query window, not any one pantry's badge threshold: this list spans
            // pantries whose `expiryWarningDays` differ, so the only honest yardstick is
            // what was actually asked for - and when nothing was asked for, the server has
            // already applied each pantry's own, so a null here means "trust the answer".
            expiry: pantryExpiryState(item, days, now),
            pantryName: this.channelNameFor(item.channelId),
        }));
    });

    protected expiringBusy = computed(() => this.pantry.expiringBusy(this.channel().guildId));

    // ── Item editor ──────────────────────────────────────────────────────────

    protected editorOpen = signal(false);
    protected editingId = signal<string | null>(null);
    protected draftName = signal('');
    protected draftQuantity = signal<number | null>(1);
    protected draftUnit = signal('');
    /**
     * The null-vs-zero switch, made explicit in the UI rather than inferred from an empty
     * number field. Off sends `clearLowThreshold: true` (never chased); on sends the number,
     * **including 0**, which is a real threshold meaning "chase it when it runs out".
     */
    protected draftTrackRestock = signal(false);
    protected draftThreshold = signal<number | null>(1);
    protected draftExpiresAt = signal<Date | null>(null);
    protected saving = signal(false);

    protected draftValid = computed(() => {
        if (!this.draftName().trim()) return false;
        const qty = this.draftQuantity();
        if (qty == null || !Number.isFinite(qty) || qty < 0) return false;
        if (!this.draftTrackRestock()) return true;
        const threshold = this.draftThreshold();
        return threshold != null && Number.isFinite(threshold) && threshold >= 0;
    });

    // ── Config editor ────────────────────────────────────────────────────────

    protected configOpen = signal(false);
    protected cfgListChannelId = signal<string | null>(null);
    protected cfgWarningDays = signal<number | null>(DEFAULT_EXPIRY_WARNING_DAYS);
    protected savingConfig = signal(false);

    /** Client-side because 1-90 is a server 400 otherwise, and a typo shouldn't cost a round trip. */
    protected cfgWarningDaysValid = computed(() => isValidExpiryWarningDays(this.cfgWarningDays()));

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => this.pantry.loadFor(channelId));
        });

        // Only once the module reads as off: that is the one moment "this house doesn't keep a
        // pantry" and "this plan doesn't include Pantry" need telling apart.
        effect(() => {
            if (this.moduleOff()) this.entitlements.ensureFeaturesLoaded(this.guildId());
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => this.guildService.getOwnMember(guildId).subscribe({
                next: m => this.ownMember.set(m),
                // Failing closed: no member means no ManagePantry, which hides the write
                // affordances rather than offering buttons that 403.
                error: () => this.ownMember.set(null),
            }));
        });
    }

    ngOnDestroy(): void {
        clearInterval(this.tickIntervalId);
    }

    // ── Navigation between the two bodies ────────────────────────────────────

    protected showExpiring(): void {
        this.view.set('expiring');
        this.pantry.loadExpiring(this.channel().guildId, this.expiringDays());
    }

    /** `null` restores the per-pantry default; a number overrides every pantry at once. */
    protected setExpiringDays(days: number | null): void {
        if (this.expiringDays() === days) return;
        this.expiringDays.set(days);
        // A different window is a different question - always refetch.
        this.pantry.loadExpiring(this.channel().guildId, days, true);
    }

    protected refreshExpiring(): void {
        this.pantry.loadExpiring(this.channel().guildId, this.expiringDays(), true);
    }

    protected retry(): void {
        this.pantry.refresh(this.channel().id);
    }

    // ── Item editor ──────────────────────────────────────────────────────────

    protected openAdd(): void {
        this.editingId.set(null);
        this.draftName.set('');
        this.draftQuantity.set(1);
        this.draftUnit.set('');
        // A new item defaults to untracked. Opting *in* to a threshold is the honest
        // default: inventing one would put things on the shopping list nobody asked for.
        this.draftTrackRestock.set(false);
        this.draftThreshold.set(1);
        this.draftExpiresAt.set(null);
        this.editorOpen.set(true);
    }

    protected openEdit(item: PantryItem): void {
        this.editingId.set(item.id);
        this.draftName.set(item.name);
        this.draftQuantity.set(item.quantity);
        this.draftUnit.set(item.unit ?? '');
        // `!= null`, never a falsy test: a stored threshold of 0 must reopen as tracked.
        this.draftTrackRestock.set(item.lowThreshold != null);
        this.draftThreshold.set(item.lowThreshold ?? 1);
        this.draftExpiresAt.set(item.expiresAt ? new Date(item.expiresAt) : null);
        this.editorOpen.set(true);
    }

    protected saveItem(): void {
        if (!this.draftValid() || this.saving()) return;
        this.saving.set(true);

        const channelId = this.channel().id;
        const name = this.draftName().trim();
        const quantity = this.draftQuantity()!;
        const unit = this.draftUnit().trim();
        const tracked = this.draftTrackRestock();
        const threshold = this.draftThreshold()!;
        const expiresAt = this.draftExpiresAt();

        // The PATCH and the POST are not the same body, and not only because of the flags.
        // On a create, absent really is absent - `null` is the natural way to say "no
        // threshold, no expiry, no unit". On a patch, `null` is indistinguishable from an
        // omitted key and the server reads both as "leave it alone", so switching something
        // off has to be said with `clear*`. See UpdatePantryItemDto.
        const patch: UpdatePantryItemDto = {
            name,
            quantity,
            // `''`, not `null`: the same rule applies to the unit, which has no flag because
            // the server stores the empty string verbatim and every reader treats it as absent.
            unit,
            ...(tracked ? {lowThreshold: threshold} : {clearLowThreshold: true}),
            ...(expiresAt ? {expiresAt: expiresAt.toISOString()} : {clearExpiresAt: true}),
        };

        const id = this.editingId();
        const request$ = id
            ? this.pantry.updateItem(channelId, id, patch)
            : this.pantry.addItem(channelId, {
                name,
                quantity,
                unit: unit || null,
                lowThreshold: tracked ? threshold : null,
                expiresAt: expiresAt?.toISOString() ?? null,
            });

        request$.subscribe({
            next: () => {
                this.saving.set(false);
                this.editorOpen.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('PANTRY.SAVE_ERROR'), err);
            },
        });
    }

    protected deleteItem(item: PantryItem): void {
        this.pantry.deleteItem(this.channel().id, item.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('PANTRY.DELETE_ERROR'), err),
        });
    }

    /**
     * The one-tap restock: bump the quantity by one unit. Crossing back above the threshold
     * is what makes the *server* release `restockedAt`, so the badge clears itself on the
     * update event rather than being cleared here.
     */
    protected bumpQuantity(item: PantryItem, delta: number): void {
        const quantity = Math.max(0, Math.round((item.quantity + delta) * 1000) / 1000);
        if (quantity === item.quantity) return;
        this.pantry.updateItem(this.channel().id, item.id, {quantity}).subscribe({
            error: err => this.toast.httpError(this.translate.instant('PANTRY.SAVE_ERROR'), err),
        });
    }

    // ── Capture ──────────────────────────────────────────────────────────────
    //
    // Three taps that replace a form. The point is not that these do something an edit could not -
    // it is that an edit costs a dialog and some arithmetic, and that is why nobody kept the pantry
    // up to date.

    /**
     * "Used one." Runs the server's low-stock loop, so the same alerts and the same shopping-list
     * append happen as if somebody had edited the quantity down by hand.
     */
    protected consumeOne(item: PantryItem): void {
        this.pantry.consume(this.channel().guildId, this.channel().id, item.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('PANTRY.CONSUME_FAILED'), err),
        });
    }

    /**
     * "That was the last of it."
     *
     * <p>Sent as `all` rather than as an amount, which is the one thing a client cannot express
     * without first knowing the exact stock - and looking that up is the arithmetic the tap is here
     * to remove.</p>
     */
    protected consumeAll(item: PantryItem): void {
        this.pantry.consume(this.channel().guildId, this.channel().id, item.id, {all: true}).subscribe({
            error: err => this.toast.httpError(this.translate.instant('PANTRY.CONSUME_FAILED'), err),
        });
    }

    /** "Put one back." Also ticks off the shopping-list line the pantry created for it. */
    protected restockOne(item: PantryItem): void {
        this.pantry.restock(this.channel().guildId, this.channel().id, item.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('PANTRY.RESTOCK_FAILED'), err),
        });
    }

    protected showScan(): void {
        this.view.set('scan');
    }

    // ── Config editor ────────────────────────────────────────────────────────

    protected openConfig(): void {
        const config = this.config();
        this.cfgListChannelId.set(config?.restockListChannelId ?? null);
        this.cfgWarningDays.set(config?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS);
        this.configOpen.set(true);
    }

    protected saveConfig(): void {
        if (!this.cfgWarningDaysValid() || this.savingConfig()) return;
        this.savingConfig.set(true);

        const listChannelId = this.cfgListChannelId();
        const expiryWarningDays = this.cfgWarningDays()!;

        // "No list" is `clearRestockList: true` with the id omitted, never `restockListChannelId:
        // null` - see UpdatePantryConfigDto. Getting this wrong is invisible: the PUT succeeds and
        // the loop stays wired to whatever it was wired to.
        this.pantry.saveConfig(this.channel().id, listChannelId
            ? {restockListChannelId: listChannelId, expiryWarningDays}
            : {clearRestockList: true, expiryWarningDays},
        ).subscribe({
            next: () => {
                this.savingConfig.set(false);
                this.configOpen.set(false);
            },
            error: err => {
                this.savingConfig.set(false);
                this.toast.httpError(this.translate.instant('PANTRY.CONFIG_SAVE_ERROR'), err);
            },
        });
    }

    // ── Presentation helpers ─────────────────────────────────────────────────

    /**
     * Four states, four looks. `listed` deliberately does not share `low`'s colour: the
     * point of the module is that "someone needs to buy this" and "it is already on the
     * list" are visibly different, or the same tin gets bought three times.
     */
    protected stateClass(state: PantryStockState): string {
        switch (state) {
            case 'listed':
                return 'bg-brand/15 text-brand-dim border-brand/30';
            case 'low':
                return 'bg-amber-400/10 text-amber-300 border-amber-400/25';
            case 'untracked':
                return 'bg-white/[0.04] text-text-muted border-border-subtle';
            default:
                return 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25';
        }
    }

    protected stateLabelKey(state: PantryStockState): string {
        switch (state) {
            case 'listed':
                return 'PANTRY.STATE_LISTED';
            case 'low':
                return 'PANTRY.STATE_LOW';
            case 'untracked':
                return 'PANTRY.STATE_UNTRACKED';
            default:
                return 'PANTRY.STATE_OK';
        }
    }

    protected expiryClass(state: PantryExpiryState): string {
        return state === 'expired'
            ? 'bg-rose-500/10 text-rose-300 border-rose-500/25'
            : 'bg-amber-400/10 text-amber-300 border-amber-400/25';
    }

    /** `#groceries`, or the raw id if the channel is gone or not visible to this member. */
    protected channelNameFor(channelId: string): string | null {
        return this.guild()?.channels.find(c => c.id === channelId)?.name ?? null;
    }

    /** `2 kg`, or just `2` when the item carries no unit. */
    protected quantityLabel(item: PantryItem): string {
        return item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
    }
}
