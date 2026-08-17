import {AssetStatus} from '../response/maintenance.dto';

export interface CreateMaintenanceAssetDto {
    name: string;
    location?: string;
    brand?: string;
    model?: string;
    serialNumber?: string;
    purchasedAt?: string;
    warrantyUntil?: string;
    vendorName?: string;
    vendorPhone?: string;
    vendorEmail?: string;
    notes?: string;
    /** Omitted leaves the asset unscheduled, which is right for a warranty-only catalogue entry. */
    serviceIntervalDays?: number;
    /**
     * When it was last serviced, if the house already knows.
     *
     * <p>The first due date counts from here rather than from today, so a boiler serviced eight
     * months ago schedules the next one four months out instead of a year.</p>
     */
    lastServicedAt?: string;
}

export interface UpdateMaintenanceAssetDto {
    name?: string;
    location?: string;
    brand?: string;
    model?: string;
    serialNumber?: string;
    purchasedAt?: string;
    clearPurchasedAt?: boolean;
    warrantyUntil?: string;
    clearWarrantyUntil?: boolean;
    vendorName?: string;
    vendorPhone?: string;
    vendorEmail?: string;
    notes?: string;
    serviceIntervalDays?: number;
    /** Switches scheduling off entirely; null on the value field only means "leave alone". */
    clearServiceInterval?: boolean;
    lastServicedAt?: string;
}

/**
 * The one-tap write. `LogMaintenance`, not `ManageMaintenance` - see the module doc.
 *
 * <p>The note is shown on the board and is deliberately kept out of the notification body, which is
 * localized server-side.</p>
 */
export interface UpdateAssetStatusDto {
    status: AssetStatus;
    note?: string;
}

/**
 * Marks an asset serviced and writes the log entry in one call, because they are one act - and the
 * half that gets skipped when they are two calls is always the log.
 *
 * <p>It does **not** clear a `Broken` status: a visit is not proof it works.</p>
 */
export interface RecordServiceDto {
    /** When the work was actually done. The next due date counts from this, not from now. */
    performedAt?: string;
    title?: string;
    notes?: string;
    vendorName?: string;
    /** Minor units. Nothing is posted to the ledger from here; link an expense instead. */
    costMinor?: number;
    currency?: string;
    expenseId?: string;
}

export interface CreateMaintenanceRecordDto {
    /** Optional: a repair can be logged against nothing the house has catalogued. */
    assetId?: string;
    title: string;
    description?: string;
    performedAt?: string;
    vendorName?: string;
    costMinor?: number;
    currency?: string;
    expenseId?: string;
}

export interface UpdateMaintenanceRecordDto {
    title?: string;
    description?: string;
    performedAt?: string;
    vendorName?: string;
    costMinor?: number;
    clearCost?: boolean;
    currency?: string;
    expenseId?: string;
    clearExpense?: boolean;
}
