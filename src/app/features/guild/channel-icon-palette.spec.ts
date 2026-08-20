import {describe, expect, it} from 'vitest';
import {CHANNEL_ICON_PALETTE} from './channel-icon-palette';

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
    const channel = (i: number) => {
        const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** The sidebar surface these swatches are read against. */
const SIDEBAR_BG = '#111520';

describe('CHANNEL_ICON_PALETTE', () => {
    it('is not empty', () => {
        expect(CHANNEL_ICON_PALETTE.length).toBeGreaterThan(0);
    });

    it('gives every swatch a well-formed hex the server will accept', () => {
        for (const swatch of CHANNEL_ICON_PALETTE) {
            expect(swatch.value, swatch.name).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });

    it('has no duplicate values or names', () => {
        expect(new Set(CHANNEL_ICON_PALETTE.map(s => s.value)).size).toBe(CHANNEL_ICON_PALETTE.length);
        expect(new Set(CHANNEL_ICON_PALETTE.map(s => s.name)).size).toBe(CHANNEL_ICON_PALETTE.length);
    });

    it('clears 3:1 against the sidebar surface, so no swatch reads as an empty slot', () => {
        for (const swatch of CHANNEL_ICON_PALETTE) {
            expect(contrast(swatch.value, SIDEBAR_BG), swatch.name).toBeGreaterThanOrEqual(3);
        }
    });
});
