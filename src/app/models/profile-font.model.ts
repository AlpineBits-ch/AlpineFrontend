import {ProfileFont} from '../dtos/response/profile.dto';

export const FONT_LABELS: Record<ProfileFont, string> = {
    [ProfileFont.Default]: 'Default',
    [ProfileFont.Serif]: 'Serif',
    [ProfileFont.Monospace]: 'Monospace',
    [ProfileFont.Rounded]: 'Rounded',
    [ProfileFont.Display]: 'Display',
    [ProfileFont.Handwritten]: 'Handwritten',
};

export const FONT_OPTIONS: {value: ProfileFont; label: string}[] = (
    Object.entries(FONT_LABELS) as [ProfileFont, string][]
).map(([value, label]) => ({value, label}));

export const FONT_STACKS: Record<ProfileFont, string> = {
    [ProfileFont.Default]: 'var(--font-sans)',
    [ProfileFont.Serif]: "'Lora Variable', Georgia, 'Times New Roman', serif",
    [ProfileFont.Monospace]: "'Fira Code Variable', 'Cascadia Code', 'Menlo', monospace",
    [ProfileFont.Rounded]: "'Quicksand Variable', system-ui, sans-serif",
    [ProfileFont.Display]: "'Bebas Neue', Impact, sans-serif",
    [ProfileFont.Handwritten]: "'Caveat Variable', cursive",
};

// Target x-height/font-size ratio. Only fonts that need the correction get an entry.
export const FONT_SIZE_ADJUST: Partial<Record<ProfileFont, number>> = {
    [ProfileFont.Handwritten]: 0.5,
};

export interface UserNameStyleInput {
    accentColor?: string | null;
    font?: ProfileFont;
}

export function safeAccentColor(color: string | null | undefined): string | null {
    return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

type Rgb = [number, number, number];

/** The lighter of the two surfaces an accent name is drawn on, which is the harder read. */
const ACCENT_SURFACE: Rgb = [0x16, 0x1b, 0x27];
const WHITE: Rgb = [255, 255, 255];
const MIN_CONTRAST = 4.5;

/**
 * A chosen accent, lifted until it can be read on the app's dark surfaces. The picker hands back
 * anything, and near-black over a card is an invisible name.
 */
export function readableAccent(color: string | null | undefined): string | null {
    const rgb = parseHex(safeAccentColor(color));
    if (!rgb) return null;

    for (let mix = 0; mix < 1; mix += 0.05) {
        const lifted = blend(rgb, WHITE, mix);
        if (contrastRatio(lifted, ACCENT_SURFACE) >= MIN_CONTRAST) return toHex(lifted);
    }
    return toHex(WHITE);
}

function parseHex(color: string | null): Rgb | null {
    if (!color) return null;
    return [
        parseInt(color.slice(1, 3), 16),
        parseInt(color.slice(3, 5), 16),
        parseInt(color.slice(5, 7), 16),
    ];
}

function toHex(rgb: Rgb): string {
    return '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
    return [
        from[0] + (to[0] - from[0]) * amount,
        from[1] + (to[1] - from[1]) * amount,
        from[2] + (to[2] - from[2]) * amount,
    ];
}

function luminance(rgb: Rgb): number {
    const [r, g, b] = rgb.map(channel => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgb, b: Rgb): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

export function userNameStyle(profile: UserNameStyleInput | null | undefined): {
    color?: string;
    fontFamily?: string;
    fontSizeAdjust?: string;
} {
    const style: {color?: string; fontFamily?: string; fontSizeAdjust?: string} = {};
    const color = safeAccentColor(profile?.accentColor);
    if (color) style.color = color;
    if (profile?.font && profile.font !== ProfileFont.Default) {
        style.fontFamily = FONT_STACKS[profile.font];
        const adjust = FONT_SIZE_ADJUST[profile.font];
        if (adjust !== undefined) style.fontSizeAdjust = String(adjust);
    }
    return style;
}
