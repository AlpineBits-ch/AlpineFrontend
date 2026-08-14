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
    ASSET_STATUSES,
    AssetStatus,
    assetStatusLabelKey,
    attentionReasonLabelKey,
    MAINTENANCE_LIMITS,
    MaintenanceAsset,
    MaintenanceAttentionEntry,
    MaintenanceRecord,
    primaryReason,
} from '../../../../dtos/response/maintenance.dto';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {formatMinor, parseMinor} from '../../../../helpers/money.helper';
import {GuildService} from '../../../../services/guild.service';
import {MaintenanceService} from '../../../../services/maintenance.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {channelIcon} from '../../channel-types';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {guildAbilities} from '../../guild-permissions';

const MEMBER_PAGE_SIZE = 200;

/** Only the two flags a client can honestly hold an opinion about. Everything else is server-side. */
interface AssetRow {
    asset: MaintenanceAsset;
    statusKey: string;
    /** `null` when it never expires. Given real prominence when it is close - see the class doc. */
    warrantyLabel: string | null;
    warrantyUrgent: boolean;
    nextServiceLabel: string | null;
}

interface AttentionRow {
    entry: MaintenanceAttentionEntry;
    reasonKeys: string[];
    primaryKey: string | null;
    warrantyLabel: string | null;
}

interface RecordRow {
    record: MaintenanceRecord;
    assetName: string | null;
    performedLabel: string;
    cost: string | null;
}

type MaintenanceView = 'assets' | 'log' | 'attention';

interface Option {
    value: string;
    label: string;
}

/**
 * The Maintenance channel: what the house owns, what state it is in, and what has been done to it.
 *
 * <p>Three things drive the whole screen.</p>
 *
 * <p><b>"Mark broken" is one tap from anywhere the asset appears</b>, and it takes `LogMaintenance`
 * rather than `ManageMaintenance` on purpose: the person who discovers the washing machine is dead
 * is whoever tried to use it, not whoever administers the house.</p>
 *
 * <p><b>Broken and out of service are not synonyms.</b> The first means it stopped working and
 * somebody has to deal with it; the second means the house took it out of use deliberately. Only the
 * first is urgent, and they are coloured apart so nobody reads a decision as a fault.</p>
 *
 * <p><b>The warranty date gets real prominence.</b> It is the one date in a house that nobody tracks
 * and that is expensive to have missed, and it is the entire reason a catalogue of appliances is
 * worth keeping at all.</p>
 */
@Component({
    selector: 'app-maintenance-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, Dialog, InputText, Select, Tooltip, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './maintenance-channel.component.html',
})
export class MaintenanceChannelComponent {
    channel = input.required<ChannelDto>();
    /** Bound by main-page, in common with every other full-page channel view. */
    back = output();

    protected navService = inject(NavigationService);
    private maintenance = inject(MaintenanceService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly statuses = ASSET_STATUSES;
    protected readonly AssetStatus = AssetStatus;
    protected readonly nameMaxLength = MAINTENANCE_LIMITS.nameMaxLength;
    protected readonly noteMaxLength = MAINTENANCE_LIMITS.noteMaxLength;

    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private members = signal<GuildMemberDto[]>([]);
    private memberById = computed(() => new Map(this.members().map(m => [m.userId, m])));

    protected icon = computed(() => channelIcon(this.channel().type) ?? 'pi pi-wrench');
    protected state = computed(() => this.maintenance.stateFor(this.channel().id));
    protected attention = computed(() => this.maintenance.attentionFor(this.channel().guildId));
    protected ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    protected view = signal<MaintenanceView>('assets');

    private guild = computed(() => {
        const workspace = this.navService.workspace();
        return workspace.type === 'server' && workspace.guild.id === this.channel().guildId
            ? workspace.guild
            : null;
    });

    /** Module off renders nothing at all - "this house doesn't do upkeep" is not a denial. */
    protected hidden = computed(() => {
        const guild = this.guild();
        const moduleOff = !!guild && !guildHasFeature(guild, GuildFeature.Maintenance);
        return moduleOff || this.state().forbidden;
    });

    // ── Permissions ──────────────────────────────────────────────────────────

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private abilities = computed(() => guildAbilities(this.ownMember(), this.guild(), this.ownUserId()));

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /**
     * Report a status and log a repair. The participation bit, held by everyone in `@everyone` -
     * which is what makes "mark broken" available to whoever found it broken.
     */
    protected canLog = computed(() => this.can(ModulePermissions.LogMaintenance));
    /** Catalogue an asset, edit anyone's record. Administration rather than discovery. */
    protected canManage = computed(() => this.can(ModulePermissions.ManageMaintenance));

    // ── Rows ─────────────────────────────────────────────────────────────────

    protected assetRows = computed<AssetRow[]>(() => this.state().assets.map(asset => ({
        asset,
        statusKey: assetStatusLabelKey(asset.status),
        warrantyLabel: asset.warrantyUntil ? this.day(asset.warrantyUntil) : null,
        warrantyUrgent: asset.isWarrantyExpiring,
        nextServiceLabel: asset.nextServiceAt ? this.day(asset.nextServiceAt) : null,
    })));

    protected attentionRows = computed<AttentionRow[]>(() => this.attention().entries.map(entry => ({
        entry,
        reasonKeys: entry.reasons.map(attentionReasonLabelKey),
        primaryKey: this.primaryKeyOf(entry),
        warrantyLabel: entry.asset.warrantyUntil ? this.day(entry.asset.warrantyUntil) : null,
    })));

    protected recordRows = computed<RecordRow[]>(() => {
        const assets = new Map(this.state().assets.map(a => [a.id, a.name]));
        return this.state().records.map(record => ({
            record,
            assetName: record.assetId ? assets.get(record.assetId) ?? null : null,
            performedLabel: this.day(record.performedAt),
            // Formatted only at the point of display, from whole minor units, as everywhere else.
            cost: record.costMinor != null
                ? formatMinor(record.costMinor, record.currency ?? 'CHF')
                : null,
        }));
    });

    protected assetOptions = computed<Option[]>(() =>
        this.state().assets.map(asset => ({value: asset.id, label: asset.name})));

    protected statusOptions = computed<Option[]>(() => this.statuses.map(status => ({
        value: status,
        label: this.translate.instant(assetStatusLabelKey(status)),
    })));

    // ── Asset editor ─────────────────────────────────────────────────────────
    protected showAssetDialog = signal(false);
    protected editingAssetId = signal<string | null>(null);
    protected saving = signal(false);
    protected confirmDeleteAssetId = signal<string | null>(null);

    protected assetName = signal('');
    protected assetLocation = signal('');
    protected assetBrand = signal('');
    protected assetModel = signal('');
    protected assetSerial = signal('');
    protected assetPurchasedAt = signal('');
    protected assetWarrantyUntil = signal('');
    protected assetVendorName = signal('');
    protected assetVendorPhone = signal('');
    protected assetVendorEmail = signal('');
    protected assetNotes = signal('');
    protected assetServiceIntervalDays = signal<number | null>(null);
    protected assetLastServicedAt = signal('');

    protected assetValid = computed(() => {
        const name = this.assetName().trim();
        return !!name && name.length <= this.nameMaxLength;
    });

    // ── Status dialog ────────────────────────────────────────────────────────
    protected showStatusDialog = signal(false);
    protected statusAsset = signal<MaintenanceAsset | null>(null);
    protected statusValue = signal<AssetStatus>(AssetStatus.Broken);
    protected statusNote = signal('');

    // ── Service dialog ───────────────────────────────────────────────────────
    protected showServiceDialog = signal(false);
    protected serviceAsset = signal<MaintenanceAsset | null>(null);
    protected servicePerformedAt = signal('');
    protected serviceTitle = signal('');
    protected serviceNotes = signal('');
    protected serviceVendorName = signal('');
    protected serviceCost = signal('');
    protected serviceCurrency = signal('CHF');

    protected serviceCostMinor = computed(() =>
        this.serviceCost().trim() ? parseMinor(this.serviceCost(), this.serviceCurrency()) : null);

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => this.maintenance.loadFor(channelId));
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => {
                this.guildService.getOwnMember(guildId).subscribe({
                    // Failing closed while unknown: a control is never briefly offered to somebody
                    // who turns out not to have the bit.
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

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * The guild-wide attention board.
     *
     * <p>Spans every upkeep channel the caller can see rather than this one, because "what in this
     * house needs a human" is a question about the house - which is also why it is loaded on demand
     * from a separate cache instead of filtered out of the catalogue on screen.</p>
     */
    protected showAttention(): void {
        this.view.set('attention');
        this.maintenance.loadAttention(this.channel().guildId);
    }

    protected refreshAttention(): void {
        this.maintenance.loadAttention(this.channel().guildId, true);
    }

    protected loadMoreRecords(): void {
        this.maintenance.loadMoreRecords(this.channel().id);
    }

    // ── Assets ───────────────────────────────────────────────────────────────

    protected openAddAsset(): void {
        this.editingAssetId.set(null);
        this.assetName.set('');
        this.assetLocation.set('');
        this.assetBrand.set('');
        this.assetModel.set('');
        this.assetSerial.set('');
        this.assetPurchasedAt.set('');
        this.assetWarrantyUntil.set('');
        this.assetVendorName.set('');
        this.assetVendorPhone.set('');
        this.assetVendorEmail.set('');
        this.assetNotes.set('');
        this.assetServiceIntervalDays.set(null);
        this.assetLastServicedAt.set('');
        this.showAssetDialog.set(true);
    }

    protected openEditAsset(asset: MaintenanceAsset): void {
        this.editingAssetId.set(asset.id);
        this.assetName.set(asset.name);
        this.assetLocation.set(asset.location ?? '');
        this.assetBrand.set(asset.brand ?? '');
        this.assetModel.set(asset.model ?? '');
        this.assetSerial.set(asset.serialNumber ?? '');
        this.assetPurchasedAt.set(asset.purchasedAt?.slice(0, 10) ?? '');
        this.assetWarrantyUntil.set(asset.warrantyUntil?.slice(0, 10) ?? '');
        this.assetVendorName.set(asset.vendorName ?? '');
        this.assetVendorPhone.set(asset.vendorPhone ?? '');
        this.assetVendorEmail.set(asset.vendorEmail ?? '');
        this.assetNotes.set(asset.notes ?? '');
        this.assetServiceIntervalDays.set(asset.serviceIntervalDays ?? null);
        this.assetLastServicedAt.set(asset.lastServicedAt?.slice(0, 10) ?? '');
        this.showAssetDialog.set(true);
    }

    protected submitAsset(): void {
        if (this.saving() || !this.assetValid()) return;

        const guildId = this.channel().guildId;
        const channelId = this.channel().id;
        const editingId = this.editingAssetId();
        const interval = this.assetServiceIntervalDays();

        const common = {
            name: this.assetName().trim(),
            location: this.assetLocation().trim(),
            brand: this.assetBrand().trim(),
            model: this.assetModel().trim(),
            serialNumber: this.assetSerial().trim(),
            vendorName: this.assetVendorName().trim(),
            vendorPhone: this.assetVendorPhone().trim(),
            vendorEmail: this.assetVendorEmail().trim(),
            notes: this.assetNotes().trim(),
        };

        this.saving.set(true);

        const request$ = editingId
            ? this.maintenance.editAsset(guildId, channelId, editingId, {
                ...common,
                // `clear*` rather than a null, the same rule as every other patch in the household
                // surface: null on the value field reads as "leave it alone".
                ...(this.dateIso(this.assetPurchasedAt())
                    ? {purchasedAt: this.dateIso(this.assetPurchasedAt())}
                    : {clearPurchasedAt: true}),
                ...(this.dateIso(this.assetWarrantyUntil())
                    ? {warrantyUntil: this.dateIso(this.assetWarrantyUntil())}
                    : {clearWarrantyUntil: true}),
                ...(interval ? {serviceIntervalDays: interval} : {clearServiceInterval: true}),
                ...(this.dateIso(this.assetLastServicedAt())
                    ? {lastServicedAt: this.dateIso(this.assetLastServicedAt())}
                    : {}),
            })
            : this.maintenance.addAsset(guildId, channelId, {
                ...common,
                ...(this.dateIso(this.assetPurchasedAt()) ? {purchasedAt: this.dateIso(this.assetPurchasedAt())} : {}),
                ...(this.dateIso(this.assetWarrantyUntil()) ? {warrantyUntil: this.dateIso(this.assetWarrantyUntil())} : {}),
                ...(interval ? {serviceIntervalDays: interval} : {}),
                // Counted from here rather than from today, so a boiler serviced eight months ago
                // schedules the next one four months out instead of a year.
                ...(this.dateIso(this.assetLastServicedAt()) ? {lastServicedAt: this.dateIso(this.assetLastServicedAt())} : {}),
            });

        request$.subscribe({
            next: () => {
                this.saving.set(false);
                this.showAssetDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('MAINTENANCE.SAVE_FAILED'), err);
            },
        });
    }

    protected removeAsset(asset: MaintenanceAsset): void {
        if (this.confirmDeleteAssetId() !== asset.id) {
            this.confirmDeleteAssetId.set(asset.id);
            return;
        }
        this.confirmDeleteAssetId.set(null);
        this.maintenance.removeAsset(this.channel().guildId, this.channel().id, asset.id).subscribe({
            error: err => this.toast.httpError(this.translate.instant('MAINTENANCE.DELETE_FAILED'), err),
        });
    }

    // ── Status ───────────────────────────────────────────────────────────────

    /**
     * The one-tap report, from wherever the asset happens to be on screen.
     *
     * <p>Straight to `Broken` with no dialog. It is the only status anybody sets in a hurry, and the
     * whole reason the write takes the participation bit: the person standing in front of the dead
     * machine should not have to find a form.</p>
     */
    protected markBroken(asset: MaintenanceAsset): void {
        this.writeStatus(asset, AssetStatus.Broken);
    }

    protected markOk(asset: MaintenanceAsset): void {
        this.writeStatus(asset, AssetStatus.Ok);
    }

    /** The full picker, for the statuses that are a decision rather than a discovery. */
    protected openStatus(asset: MaintenanceAsset): void {
        this.statusAsset.set(asset);
        this.statusValue.set(asset.status);
        this.statusNote.set(asset.statusNote ?? '');
        this.showStatusDialog.set(true);
    }

    protected submitStatus(): void {
        const asset = this.statusAsset();
        if (this.saving() || !asset) return;

        this.saving.set(true);
        this.maintenance.setStatus(
            this.channel().guildId, this.channel().id, asset.id,
            this.statusValue(), this.statusNote().trim() || undefined,
        ).subscribe({
            next: () => {
                this.saving.set(false);
                this.showStatusDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('MAINTENANCE.STATUS_FAILED'), err);
            },
        });
    }

    private writeStatus(asset: MaintenanceAsset, status: AssetStatus): void {
        this.maintenance.setStatus(this.channel().guildId, this.channel().id, asset.id, status).subscribe({
            error: err => this.toast.httpError(this.translate.instant('MAINTENANCE.STATUS_FAILED'), err),
        });
    }

    // ── Service ──────────────────────────────────────────────────────────────

    protected openService(asset: MaintenanceAsset): void {
        this.serviceAsset.set(asset);
        this.servicePerformedAt.set(this.todayInputValue());
        this.serviceTitle.set('');
        this.serviceNotes.set('');
        this.serviceVendorName.set(asset.vendorName ?? '');
        this.serviceCost.set('');
        this.serviceCurrency.set('CHF');
        this.showServiceDialog.set(true);
    }

    protected submitService(): void {
        const asset = this.serviceAsset();
        if (this.saving() || !asset) return;

        const costMinor = this.serviceCostMinor();
        const title = this.serviceTitle().trim();
        const notes = this.serviceNotes().trim();
        const vendorName = this.serviceVendorName().trim();

        this.saving.set(true);
        this.maintenance.recordService(this.channel().guildId, this.channel().id, asset.id, {
            // When it was actually done, not when it was typed - the next due date counts from this.
            ...(this.dateIso(this.servicePerformedAt()) ? {performedAt: this.dateIso(this.servicePerformedAt())} : {}),
            ...(title ? {title} : {}),
            ...(notes ? {notes} : {}),
            ...(vendorName ? {vendorName} : {}),
            ...(costMinor != null && costMinor > 0
                ? {costMinor, currency: this.serviceCurrency()}
                : {}),
        }).subscribe({
            next: () => {
                this.saving.set(false);
                this.showServiceDialog.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('MAINTENANCE.SERVICE_FAILED'), err);
            },
        });
    }

    // ── Presentation ─────────────────────────────────────────────────────────

    /**
     * Broken is red, out of service is grey, and they are never the same colour.
     *
     * <p>The two mean opposite things - one is a fault the house has to deal with, the other is a
     * decision the house already took - and the whole board is judged on telling them apart.</p>
     */
    protected statusClass(status: AssetStatus): string {
        switch (status) {
            case AssetStatus.Broken:
                return 'bg-rose-500/10 text-rose-300 border-rose-500/25';
            case AssetStatus.NeedsAttention:
                return 'bg-amber-400/10 text-amber-300 border-amber-400/25';
            case AssetStatus.OutOfService:
                return 'bg-white/[0.04] text-text-muted border-border-subtle';
            default:
                return 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25';
        }
    }

    protected nameOf(userId: string): string {
        const member = this.memberById().get(userId);
        return member?.nickname ?? member?.profile?.userName ?? this.translate.instant('MAINTENANCE.SOMEONE');
    }

    protected day(iso: string): string {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', year: 'numeric'}).format(date);
    }

    private primaryKeyOf(entry: MaintenanceAttentionEntry): string | null {
        const reason = primaryReason(entry.reasons);
        return reason ? attentionReasonLabelKey(reason) : null;
    }

    /** A `yyyy-MM-dd` from a date input back to an instant, or undefined for an empty box. */
    private dateIso(value: string): string | undefined {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const date = new Date(`${trimmed}T12:00:00`);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    private todayInputValue(): string {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
}
