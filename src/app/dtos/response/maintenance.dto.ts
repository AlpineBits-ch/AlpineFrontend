/**
 * Maintenance: the things in the house, what state they are in, and what has been done to them.
 *
 * <p>Two rules run through the whole module.</p>
 *
 * <p><b>Marking something broken is `LogMaintenance`, not `ManageMaintenance`</b>, and that is
 * deliberate: the person who discovers the washing machine is dead is whoever tried to use it, not
 * whoever administers the house. So the status control belongs everywhere an asset appears, one tap
 * from wherever you are standing.</p>
 *
 * <p><b>A service does not clear a `Broken` status.</b> A visit is not proof it works, and a module
 * that quietly declared the boiler fixed because somebody logged a callout would be lying about the
 * one thing anybody consults it for.</p>
 */

export enum AssetStatus {
    Ok = 'Ok',
    /** Something is off, but it still works. Worth a look; not worth waking anyone. */
    NeedsAttention = 'NeedsAttention',
    /** It stopped working and somebody must deal with it. The only urgent one. */
    Broken = 'Broken',
    /** The house took it out of use on purpose. **Not a synonym for broken.** */
    OutOfService = 'OutOfService',
}

const STATUS_BY_ORDINAL: readonly AssetStatus[] = [
    AssetStatus.Ok, AssetStatus.NeedsAttention, AssetStatus.Broken, AssetStatus.OutOfService,
];

/** In the order the status picker offers them, which is also increasing severity then withdrawal. */
export const ASSET_STATUSES: readonly AssetStatus[] = STATUS_BY_ORDINAL;

export function assetStatusLabelKey(status: AssetStatus): string {
    return `MAINTENANCE.STATUS_${status.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

export interface MaintenanceAsset {
    id: string;
    channelId: string;
    name: string;
    location?: string | null;
    brand?: string | null;
    model?: string | null;
    serialNumber?: string | null;
    purchasedAt?: string | null;
    /**
     * The one date in a house nobody tracks and that is expensive to have missed. Given real
     * prominence wherever an asset is drawn, and the whole reason the attention board exists.
     */
    warrantyUntil?: string | null;
    vendorName?: string | null;
    vendorPhone?: string | null;
    vendorEmail?: string | null;
    notes?: string | null;
    /** Null leaves the asset unscheduled - right for anything catalogued only for its warranty. */
    serviceIntervalDays?: number | null;
    lastServicedAt?: string | null;
    nextServiceAt?: string | null;
    status: AssetStatus;
    statusNote?: string | null;
    /**
     * Server-computed, so no client has to carry the sweep's cutoffs or a clock the server
     * disagrees with. Recomputing either of these from the dates is how two screens start
     * disagreeing about whether the boiler is late.
     */
    isServiceOverdue: boolean;
    isWarrantyExpiring: boolean;
    addedByUserId: string;
}

/**
 * One thing that was done. Records exist without an asset too - a repair can be logged for
 * something the house never catalogued.
 */
export interface MaintenanceRecord {
    id: string;
    assetId?: string | null;
    channelId: string;
    title: string;
    description?: string | null;
    /**
     * When the work was **actually** done, not when it was entered. The next service is scheduled
     * from this, which is why a callout logged a week later has to say so.
     */
    performedAt: string;
    performedByUserId: string;
    vendorName?: string | null;
    /** Minor units, in {@link currency}. Nothing is posted to the ledger from here. */
    costMinor?: number | null;
    currency?: string | null;
    /** An existing ledger expense this cost was linked to, if any. */
    expenseId?: string | null;
}

export interface MaintenanceRecordPage {
    items: MaintenanceRecord[];
    nextCursor: string | null;
}

/**
 * The machine-readable tokens the attention board sorts and labels on.
 *
 * <p>They travel with the asset rather than being re-derived here, because deriving them would mean
 * reimplementing the warranty window and the overdue cutoff, and the two copies would drift the
 * first time either changed.</p>
 */
export type AttentionReason =
    | 'broken'
    | 'service_overdue'
    | 'needs_attention'
    | 'warranty_expiring'
    | (string & {});

/**
 * Most urgent first. Broken beats a missed service beats a warning light beats a lapsing warranty:
 * only the first means the house has lost the use of something today.
 */
const REASON_ORDER: readonly string[] = [
    'broken', 'service_overdue', 'needs_attention', 'warranty_expiring',
];

export interface MaintenanceAttentionEntry {
    asset: MaintenanceAsset;
    /** An asset can carry more than one, and the board says all of them. */
    reasons: AttentionReason[];
}

/** The one that decides where a row sorts, and what a one-line surface would call it. */
export function primaryReason(reasons: readonly AttentionReason[]): AttentionReason | null {
    for (const known of REASON_ORDER) {
        if (reasons.includes(known)) return known;
    }
    // An unrecognised token from a newer server still names something real - keep it rather than
    // dropping the row to the bottom with no explanation.
    return reasons[0] ?? null;
}

export function reasonRank(reason: AttentionReason | null): number {
    const index = reason == null ? -1 : REASON_ORDER.indexOf(reason);
    // Unknown tokens sort after every known one, ahead of nothing at all.
    return index >= 0 ? index : REASON_ORDER.length;
}

/** `warranty_expiring` -> `MAINTENANCE.REASON.WARRANTY_EXPIRING`. */
export function attentionReasonLabelKey(reason: AttentionReason): string {
    return `MAINTENANCE.REASON.${reason.toUpperCase()}`;
}

export const MAINTENANCE_LIMITS = {
    nameMaxLength: 120,
    titleMaxLength: 200,
    noteMaxLength: 500,
    serviceIntervalDaysMin: 1,
    serviceIntervalDaysMax: 3650,
} as const;

// ── Realtime (server → client) ──────────────────────────────────────────────

export interface MaintenanceAssetCreated {
    guildId: string;
    channelId: string;
    asset: MaintenanceAsset;
}

export type MaintenanceAssetUpdated = MaintenanceAssetCreated;

export interface MaintenanceAssetDeleted {
    guildId: string;
    channelId: string;
    assetId: string;
}

export interface MaintenanceRecordCreated {
    guildId: string;
    channelId: string;
    record: MaintenanceRecord;
}

export type MaintenanceRecordUpdated = MaintenanceRecordCreated;

export interface MaintenanceRecordDeleted {
    guildId: string;
    channelId: string;
    recordId: string;
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * `Ok` for anything unrecognised.
 *
 * <p>The conservative reading in both directions: an unknown status must not put a working machine
 * on the attention board, and it must not claim a broken one is fine either - which is why
 * `isServiceOverdue` and the attention board's own `reasons` are what actually drive urgency, and
 * this only decides a badge.</p>
 */
export function normalizeAssetStatus(
    value: AssetStatus | number | string | null | undefined,
): AssetStatus {
    if (typeof value === 'number') return STATUS_BY_ORDINAL[value] ?? AssetStatus.Ok;
    return (STATUS_BY_ORDINAL as readonly string[]).includes(value as string)
        ? value as AssetStatus
        : AssetStatus.Ok;
}

export function normalizeAsset(raw: MaintenanceAsset): MaintenanceAsset {
    return {...raw, status: normalizeAssetStatus(raw.status)};
}

export function normalizeRecord(raw: MaintenanceRecord): MaintenanceRecord {
    return {
        ...raw,
        // Belt and braces, exactly as the expense list does it: a fractional value here is a server
        // bug, but a truncated one is at least still an integer and will not poison a sum.
        costMinor: raw.costMinor == null ? null : Math.trunc(raw.costMinor),
    };
}
