import {ProfileFont} from '../dtos/response/profile.dto';

export const FONT_LABELS: Record<ProfileFont, string> = {
    [ProfileFont.Default]: 'Default',
    [ProfileFont.Serif]: 'Serif',
    [ProfileFont.Monospace]: 'Monospace',
    [ProfileFont.Rounded]: 'Rounded',
    [ProfileFont.Display]: 'Display',
    [ProfileFont.Handwritten]: 'Handwritten',
};

export const FONT_STACKS: Record<ProfileFont, string> = {
    [ProfileFont.Default]: 'var(--font-sans)',
    [ProfileFont.Serif]: "'Lora Variable', Georgia, 'Times New Roman', serif",
    [ProfileFont.Monospace]: "'Fira Code Variable', 'Cascadia Code', 'Menlo', monospace",
    [ProfileFont.Rounded]: "'Quicksand Variable', system-ui, sans-serif",
    [ProfileFont.Display]: "'Bebas Neue', Impact, sans-serif",
    [ProfileFont.Handwritten]: "'Caveat Variable', cursive",
};

// Script/cursive faces have a much smaller x-height than the default UI sans font, so at
// a shared declared font-size they read as noticeably smaller. font-size-adjust rescales
// the rendered glyph size to hit a target x-height/font-size ratio, independent of whatever
// font-size the call site (message list, member list, profile card, ...) already declares.
// Only fonts that actually need correction get an entry here.
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

export function userNameStyle(
    profile: UserNameStyleInput | null | undefined,
): { color?: string; fontFamily?: string; fontSizeAdjust?: string } {
    const style: { color?: string; fontFamily?: string; fontSizeAdjust?: string } = {};
    const color = safeAccentColor(profile?.accentColor);
    if (color) style.color = color;
    if (profile?.font && profile.font !== ProfileFont.Default) {
        style.fontFamily = FONT_STACKS[profile.font];
        const adjust = FONT_SIZE_ADJUST[profile.font];
        if (adjust !== undefined) style.fontSizeAdjust = String(adjust);
    }
    return style;
}
