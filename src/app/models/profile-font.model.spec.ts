import {ProfileFont} from '../dtos/response/profile.dto';
import {FONT_SIZE_ADJUST, FONT_STACKS, safeAccentColor, userNameStyle} from './profile-font.model';

describe('userNameStyle', () => {
    it('returns an empty object for null/undefined input', () => {
        expect(userNameStyle(null)).toEqual({});
        expect(userNameStyle(undefined)).toEqual({});
    });

    it('returns no color when accentColor is null', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Default})).toEqual({});
    });

    it('returns the accent color when set', () => {
        expect(userNameStyle({accentColor: '#5865F2', font: ProfileFont.Default}))
            .toEqual({color: '#5865F2'});
    });

    it('omits fontFamily for ProfileFont.Default', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Default})).toEqual({});
    });

    it('returns the mapped font-family for a non-default font', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Serif}))
            .toEqual({fontFamily: FONT_STACKS[ProfileFont.Serif]});
    });

    it('returns both color and fontFamily together', () => {
        expect(userNameStyle({accentColor: '#ff0000', font: ProfileFont.Monospace}))
            .toEqual({color: '#ff0000', fontFamily: FONT_STACKS[ProfileFont.Monospace]});
    });

    it('rejects an invalid accentColor rather than passing it through as CSS', () => {
        expect(userNameStyle({accentColor: 'url(javascript:alert(1))', font: ProfileFont.Default})).toEqual({});
    });

    it('adds fontSizeAdjust for fonts with a small x-height relative to the default font', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Handwritten})).toEqual({
            fontFamily: FONT_STACKS[ProfileFont.Handwritten],
            fontSizeAdjust: String(FONT_SIZE_ADJUST[ProfileFont.Handwritten]),
        });
    });

    it('omits fontSizeAdjust for fonts that do not need size correction', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Serif}))
            .toEqual({fontFamily: FONT_STACKS[ProfileFont.Serif]});
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
