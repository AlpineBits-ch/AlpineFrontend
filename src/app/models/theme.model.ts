export interface ThemeColors {
    loginBg: string;
    appBg: string;
    sidebar: string;
    card: string;
    hover: string;
    border: string;
    brand: string;
    brandHover: string;
    brandDim: string;
    brandDark: string;
    online: string;
    connecting: string;
    offline: string;
}

export interface AppTheme {
    id: string;
    name: string;
    baseFontSize: number;
    colors: ThemeColors;
}

export const BUILT_IN_THEME_ID = 'alpine-dark';

export const DEFAULT_THEME: AppTheme = {
    id: BUILT_IN_THEME_ID,
    name: 'Alpine Dark',
    baseFontSize: 16,
    colors: {
        loginBg: '#06090f',
        appBg: '#0d1117',
        sidebar: '#111520',
        card: '#161b27',
        hover: '#1d2333',
        border: '#252e42',
        brand: '#4B5BC4',
        brandHover: '#3E4EAE',
        brandDim: '#7E8AE0',
        brandDark: '#333F8C',
        online: '#34d399',
        connecting: '#fbbf24',
        offline: '#f43f5e',
    },
};

export const COLOR_LABELS: Record<keyof ThemeColors, string> = {
    loginBg: 'Login Background',
    appBg: 'App Background',
    sidebar: 'Sidebar',
    card: 'Card / Input',
    hover: 'Hover State',
    border: 'Border',
    brand: 'Brand Primary',
    brandHover: 'Brand Hover',
    brandDim: 'Brand Dim',
    brandDark: 'Brand Dark',
    online: 'Online',
    connecting: 'Connecting',
    offline: 'Offline',
};

export const COLOR_GROUPS: { title: string; keys: (keyof ThemeColors)[] }[] = [
    {title: 'Surfaces', keys: ['loginBg', 'appBg', 'sidebar', 'card', 'hover', 'border']},
    {title: 'Brand', keys: ['brand', 'brandHover', 'brandDim', 'brandDark']},
    {title: 'Status', keys: ['online', 'connecting', 'offline']},
];
