import {ProfileFont} from '../dtos/response/profile.dto';
import {
    FONT_SIZE_ADJUST,
    FONT_STACKS,
    readableAccent,
    safeAccentColor,
    userNameStyle,
} from './profile-font.model';

describe('userNameStyle', () => {
    it('returns an empty object for null/undefined input', () => {
        expect(userNameStyle(null)).toEqual({});
        expect(userNameStyle(undefined)).toEqual({});
    });

    it('returns no color when accentColor is null', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Default})).toEqual({});
    });

    it('returns the accent color when set', () => {
        expect(userNameStyle({accentColor: '#5865F2', font: ProfileFont.Default})).toEqual({
            color: '#5865F2',
        });
    });

    it('omits fontFamily for ProfileFont.Default', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Default})).toEqual({});
    });

    it('returns the mapped font-family for a non-default font', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Serif})).toEqual({
            fontFamily: FONT_STACKS[ProfileFont.Serif],
        });
    });

    it('returns both color and fontFamily together', () => {
        expect(userNameStyle({accentColor: '#ff0000', font: ProfileFont.Monospace})).toEqual({
            color: '#ff0000',
            fontFamily: FONT_STACKS[ProfileFont.Monospace],
        });
    });

    it('rejects an invalid accentColor rather than passing it through as CSS', () => {
        expect(userNameStyle({accentColor: 'url(javascript:alert(1))', font: ProfileFont.Default})).toEqual(
            {},
        );
    });

    it('adds fontSizeAdjust for fonts with a small x-height relative to the default font', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Handwritten})).toEqual({
            fontFamily: FONT_STACKS[ProfileFont.Handwritten],
            fontSizeAdjust: String(FONT_SIZE_ADJUST[ProfileFont.Handwritten]),
        });
    });

    it('omits fontSizeAdjust for fonts that do not need size correction', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Serif})).toEqual({
            fontFamily: FONT_STACKS[ProfileFont.Serif],
        });
    });
});

describe('safeAccentColor', () => {
    it('accepts a valid 6-digit hex color', () => {
        expect(safeAccentColor('#5865F2')).toBe('#5865F2');
    });

    it('rejects null/undefined/empty', () => {
        expect(safeAccentColor(null)).toBeNull();
        expect(safeAccentColor(undefined)).toBeNull();
        expect(safeAccentColor('')).toBeNull();
    });

    it('rejects a non-hex CSS value that could inject a background-image', () => {
        expect(safeAccentColor('url(https://evil.example/pixel.png)')).toBeNull();
        expect(safeAccentColor('red')).toBeNull();
        expect(safeAccentColor('#zzzzzz')).toBeNull();
    });
});

describe('readableAccent', () => {
    // Relative luminance against #161b27, the lighter of the two surfaces a name is drawn on.
    function contrast(hex: string): number {
        const lum = (c: string) => {
            const parts = [1, 3, 5].map(at => {
                const v = parseInt(c.slice(at, at + 2), 16) / 255;
                return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
        };
        return (lum(hex) + 0.05) / (lum('#161b27') + 0.05);
    }

    it('leaves a colour that already reads alone', () => {
        expect(readableAccent('#b08968')).toBe('#b08968');
    });

    it('lifts a near-black accent until it can be read', () => {
        const lifted = readableAccent('#000000');
        expect(lifted).not.toBe('#000000');
        expect(contrast(lifted!)).toBeGreaterThanOrEqual(4.5);
    });

    it('lifts a saturated dark accent without discarding its hue', () => {
        const lifted = readableAccent('#1a1a3e')!;
        expect(contrast(lifted)).toBeGreaterThanOrEqual(4.5);
        // Still blue: the channel that was highest stays highest.
        expect(parseInt(lifted.slice(5, 7), 16)).toBeGreaterThan(parseInt(lifted.slice(1, 3), 16));
    });

    it('rejects what safeAccentColor rejects', () => {
        expect(readableAccent('red')).toBeNull();
        expect(readableAccent(null)).toBeNull();
    });
});
