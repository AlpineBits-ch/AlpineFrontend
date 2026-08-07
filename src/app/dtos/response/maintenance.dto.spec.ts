import {describe, expect, it} from 'vitest';
import {
    AssetStatus,
    assetStatusLabelKey,
    attentionReasonLabelKey,
    MaintenanceAsset,
    MaintenanceRecord,
    normalizeAsset,
    normalizeAssetStatus,
    normalizeRecord,
    primaryReason,
    reasonRank,
} from './maintenance.dto';

describe('normalizeAssetStatus', () => {
    it('accepts both the name and the ordinal', () => {
        expect(normalizeAssetStatus('Broken')).toBe(AssetStatus.Broken);
        expect(normalizeAssetStatus(3)).toBe(AssetStatus.OutOfService);
    });

    it('falls back to Ok for anything unrecognised', () => {
        expect(normalizeAssetStatus('Smouldering')).toBe(AssetStatus.Ok);
        expect(normalizeAssetStatus(undefined)).toBe(AssetStatus.Ok);
    });
});

describe('primaryReason', () => {
    /**
     * Broken beats a missed service beats a warning light beats a lapsing warranty: only the first
     * means the house has lost the use of something today.
     */
    it('picks the most urgent token regardless of the order they arrived in', () => {
        expect(primaryReason(['warranty_expiring', 'broken'])).toBe('broken');
        expect(primaryReason(['warranty_expiring', 'service_overdue'])).toBe('service_overdue');
        expect(primaryReason(['warranty_expiring', 'needs_attention'])).toBe('needs_attention');
    });

    /** A token from a newer server still names something real, so the row keeps its reason. */
    it('keeps an unrecognised token rather than dropping it', () => {
        expect(primaryReason(['recall_notice'])).toBe('recall_notice');
    });

    it('is null for an empty list', () => {
        expect(primaryReason([])).toBeNull();
    });
});

describe('reasonRank', () => {
    it('orders the known tokens by urgency', () => {
        expect(reasonRank('broken')).toBeLessThan(reasonRank('service_overdue'));
        expect(reasonRank('service_overdue')).toBeLessThan(reasonRank('needs_attention'));
        expect(reasonRank('needs_attention')).toBeLessThan(reasonRank('warranty_expiring'));
    });

    it('sorts an unknown token after every known one, and null with it', () => {
        expect(reasonRank('recall_notice')).toBeGreaterThan(reasonRank('warranty_expiring'));
        expect(reasonRank(null)).toBeGreaterThan(reasonRank('warranty_expiring'));
    });
});

describe('label keys', () => {
    it('snake-cases a compound status name', () => {
        expect(assetStatusLabelKey(AssetStatus.OutOfService)).toBe('MAINTENANCE.STATUS_OUT_OF_SERVICE');
        expect(assetStatusLabelKey(AssetStatus.Ok)).toBe('MAINTENANCE.STATUS_OK');
    });

    it('upper-cases an attention token', () => {
        expect(attentionReasonLabelKey('warranty_expiring')).toBe('MAINTENANCE.REASON.WARRANTY_EXPIRING');
    });
});

describe('normalizeRecord', () => {
    function record(costMinor: number | null | undefined): MaintenanceRecord {
        return {
            id: 'm1',
            channelId: 'c1',
            title: 'Boiler service',
            performedAt: '2026-08-01T00:00:00Z',
            performedByUserId: 'u1',
            costMinor,
        };
    }

    it('keeps an absent cost absent rather than turning it into zero', () => {
        expect(normalizeRecord(record(null)).costMinor).toBeNull();
        expect(normalizeRecord(record(undefined)).costMinor).toBeNull();
    });

    it('truncates a fractional cost to whole minor units', () => {
        expect(normalizeRecord(record(1234.9)).costMinor).toBe(1234);
    });
});

describe('normalizeAsset', () => {
    it('collapses an ordinal status and leaves everything else alone', () => {
        const asset: MaintenanceAsset = {
            id: 'a1',
            channelId: 'c1',
            name: 'Washing machine',
            status: 2 as unknown as AssetStatus,
            isServiceOverdue: false,
            isWarrantyExpiring: true,
            addedByUserId: 'u1',
        };

        const normalized = normalizeAsset(asset);
        expect(normalized.status).toBe(AssetStatus.Broken);
        expect(normalized.isWarrantyExpiring).toBe(true);
    });
});
