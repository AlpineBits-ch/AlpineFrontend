import { effect, Injectable, signal, computed } from '@angular/core';
import { AppTheme, BUILT_IN_THEME_ID, DEFAULT_THEME, ThemeColors } from '../models/theme.model';

const THEMES_KEY  = 'alpine-themes';
const ACTIVE_KEY  = 'alpine-active-theme';
const FONT_MIN    = 12;
const FONT_MAX    = 20;

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes       = signal<AppTheme[]>(this.loadThemes());
  readonly activeThemeId = signal<string>(this.loadActiveId());

  readonly activeTheme = computed(() =>
    this.themes().find(t => t.id === this.activeThemeId()) ?? DEFAULT_THEME
  );

  constructor() {
    effect(() => {
      this.applyTheme(this.activeTheme());
    });
  }

  setActive(id: string): void {
    this.activeThemeId.set(id);
    localStorage.setItem(ACTIVE_KEY, id);
  }

  createTheme(name: string): void {
    const base = this.activeTheme();
    const theme: AppTheme = {
      ...base,
      id:   crypto.randomUUID(),
      name: name.trim() || 'New Theme',
    };
    this.themes.update(ts => [...ts, theme]);
    this.saveThemes();
    this.setActive(theme.id);
  }

  updateActiveColors(partial: Partial<ThemeColors>): void {
    this.themes.update(ts => ts.map(t =>
      t.id === this.activeThemeId()
        ? { ...t, colors: { ...t.colors, ...partial } }
        : t
    ));
    this.saveThemes();
  }

  updateActiveFontSize(size: number): void {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
    this.themes.update(ts => ts.map(t =>
      t.id === this.activeThemeId() ? { ...t, baseFontSize: clamped } : t
    ));
    this.saveThemes();
  }

  deleteTheme(id: string): void {
    if (id === BUILT_IN_THEME_ID) return;
    this.themes.update(ts => ts.filter(t => t.id !== id));
    this.saveThemes();
    if (this.activeThemeId() === id) this.setActive(BUILT_IN_THEME_ID);
  }

  renameTheme(id: string, name: string): void {
    if (id === BUILT_IN_THEME_ID) return;
    this.themes.update(ts => ts.map(t =>
      t.id === id ? { ...t, name: name.trim() || t.name } : t
    ));
    this.saveThemes();
  }

  exportTheme(id: string): void {
    const theme = this.themes().find(t => t.id === id);
    if (!theme) return;
    const json = JSON.stringify(theme, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${theme.name.toLowerCase().replace(/\s+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  importTheme(json: string): void {
    const parsed = JSON.parse(json) as AppTheme;
    if (!parsed.name || !parsed.colors || typeof parsed.baseFontSize !== 'number') {
      throw new Error('Invalid theme file');
    }
    const theme: AppTheme = { ...parsed, id: crypto.randomUUID() };
    this.themes.update(ts => [...ts, theme]);
    this.saveThemes();
    this.setActive(theme.id);
  }

  private applyTheme(theme: AppTheme): void {
    const root = document.documentElement;
    const set  = (prop: string, val: string) => root.style.setProperty(prop, val);

    set('--base-font-size', `${theme.baseFontSize}px`);

    const c = theme.colors;
    set('--color-login-bg',    c.loginBg);
    set('--color-app-bg',      c.appBg);
    set('--color-sidebar',     c.sidebar);
    set('--color-card',        c.card);
    set('--color-hover',       c.hover);
    set('--color-border',      c.border);
    set('--color-brand',       c.brand);
    set('--color-brand-hover', c.brandHover);
    set('--color-brand-dim',   c.brandDim);
    set('--color-brand-dark',  c.brandDark);
    set('--color-online',      c.online);
    set('--color-connecting',  c.connecting);
    set('--color-offline',     c.offline);
  }

  private loadThemes(): AppTheme[] {
    try {
      const raw = localStorage.getItem(THEMES_KEY);
      const saved: AppTheme[] = raw ? JSON.parse(raw) : [];
      // Always keep built-in theme fresh from DEFAULT_THEME
      const withoutBuiltIn = saved.filter(t => t.id !== BUILT_IN_THEME_ID);
      return [DEFAULT_THEME, ...withoutBuiltIn];
    } catch {
      return [DEFAULT_THEME];
    }
  }

  private loadActiveId(): string {
    return localStorage.getItem(ACTIVE_KEY) ?? BUILT_IN_THEME_ID;
  }

  private saveThemes(): void {
    // Don't persist the built-in theme — it's always loaded from DEFAULT_THEME
    const custom = this.themes().filter(t => t.id !== BUILT_IN_THEME_ID);
    localStorage.setItem(THEMES_KEY, JSON.stringify(custom));
  }
}
