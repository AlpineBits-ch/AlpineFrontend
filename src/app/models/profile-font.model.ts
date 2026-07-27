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

export interface UserNameStyleInput {
    accentColor?: string | null;
    font?: ProfileFont;
}

export function safeAccentColor(color: string | null | undefined): string | null {
    return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

export function userNameStyle(
    profile: UserNameStyleInput | null | undefined,
): { color?: string; fontFamily?: string } {
    const style: { color?: string; fontFamily?: string } = {};
    const color = safeAccentColor(profile?.accentColor);
    if (color) style.color = color;
    if (profile?.font && profile.font !== ProfileFont.Default) {
        style.fontFamily = FONT_STACKS[profile.font];
    }
    return style;
}
