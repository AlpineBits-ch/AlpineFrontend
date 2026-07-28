# Preset Contrast Pass & Brand Color Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's dark UI read as crisp, layered, and visually consistent by (1) raising border/shadow/focus contrast and widening surface elevation steps in the PrimeNG preset, (2) eliminating the dead/drifted accent-color scale so the preset and runtime theme can never diverge, and (3) sweeping every hardcoded old-indigo (`#6366f1` family) and Tailwind built-in `indigo-*` utility class in the codebase to reference the app's actual brand color (`#7c72ff` purple) via CSS custom properties.

**Architecture:** No new architecture - this is a token-layer correction. `alpine-preset.ts` (PrimeNG) and `styles.css` (`@theme`, Tailwind v4) are the two existing token systems; every other file change is a mechanical substitution driven by the table below, applied file-by-file.

**Tech Stack:** Angular 21, PrimeNG 21 (`@primeuix/themes`), Tailwind CSS v4 (`@tailwindcss/postcss`), TypeScript.

## Global Constraints

- Brand colors are defined once, in `src/app/models/theme.model.ts` `DEFAULT_THEME.colors`: `brand: '#7c72ff'`, `brandHover: '#695df2'`, `brandDim: '#9a84ff'`, `brandDark: '#584ad9'`. Every fix in this plan makes some other file reference these values (via CSS var or, for `alpine-preset.ts`, via direct import) instead of hardcoding a color.
- **Global substitution table** (applies everywhere in this plan; each task references it by name):

  | Old literal | New value |
  |---|---|
  | `#6366f1` (solid) | `var(--color-brand)` |
  | `#4f46e5` (solid) | `var(--color-brand-hover)` |
  | `#818cf8` (solid) | `var(--color-brand-dim)` |
  | `#4338ca` (solid) | `var(--color-brand-dark)` |
  | `rgba(99, 102, 241, X)` / `rgba(99,102,241,X)` | `color-mix(in srgb, var(--color-brand) X%, transparent)` |
  | `rgba(129, 140, 248, X)` / `rgba(129,140,248,X)` | `color-mix(in srgb, var(--color-brand-dim) X%, transparent)` |
  | `rgb(129, 140, 248)` | `var(--color-brand-dim)` |
  | `rgba(67,56,202,X)` | `color-mix(in srgb, var(--color-brand-dark) X%, transparent)` |
  | Tailwind `indigo-400` utility, no opacity (e.g. `text-indigo-400`) | `text-[var(--color-brand-dim)]` (swap the CSS property prefix as needed: `bg-`, `border-`, `ring-`, `from-`, `via-`, `to-`) |
  | Tailwind `indigo-400/N` (opacity suffix) | `text-[color-mix(in_srgb,var(--color-brand-dim)_N%,transparent)]` |
  | Tailwind `indigo-500` utility, no opacity | `bg-[var(--color-brand)]` etc. |
  | Tailwind `indigo-500/N` | `bg-[color-mix(in_srgb,var(--color-brand)_N%,transparent)]` etc. |
  | Tailwind `indigo-700` utility, no opacity | `to-[var(--color-brand-dark)]` etc. |

  Tailwind v4 arbitrary values use underscores in place of spaces/commas inside the brackets (e.g. `color-mix(in_srgb,var(--color-brand)_15%,transparent)`).
- `ng build` must succeed after every task.
- No changes to layout, spacing, typography, or light-mode support (app is dark-only).

---

### Task 1: `alpine-preset.ts` - border/shadow/focus contrast + accent drift fix

**Files:**
- Modify: `src/app/theme/alpine-preset.ts`

**Interfaces:**
- Consumes: `DEFAULT_THEME` from `src/app/models/theme.model.ts` (already exists, exports `colors.brand`/`brandHover`/`brandDim`/`brandDark` as hex strings), `palette` from `@primeuix/themes` (already used identically in `src/app/services/theme.service.ts:119-129`).
- Produces: nothing new consumed elsewhere - this file is the terminal PrimeNG preset passed to `providePrimeNG` in `app.config.ts`.

- [ ] **Step 1: Add imports and shared border constants**

At the top of the file:

```ts
import { definePreset, palette } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { DEFAULT_THEME } from '../models/theme.model';

const BORDER_SUBTLE = 'rgba(255,255,255,0.10)';
const BORDER_DEFAULT = 'rgba(255,255,255,0.16)';
const BORDER_STRONG = 'rgba(255,255,255,0.22)';
```

replacing the current:

```ts
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
```

- [ ] **Step 2: Replace the hand-authored `accent` primitive with a derivation from `DEFAULT_THEME`**

Replace:

```ts
        accent: {
            50: '#f2f5ff',
            100: '#e4eafc',
            200: '#cdd8f6',
            300: '#a9bbea',
            400: '#7f99d9',
            500: '#5f7fc7',
            600: '#4d6db3',
            700: '#405b95',
            800: '#344977',
            900: '#2b3c61',
            950: '#1b263d',
        },
```

with:

```ts
        accent: {
            ...(palette(DEFAULT_THEME.colors.brand) as object),
            400: DEFAULT_THEME.colors.brandDim,
            500: DEFAULT_THEME.colors.brand,
            600: DEFAULT_THEME.colors.brandHover,
            700: DEFAULT_THEME.colors.brandDark,
        },
```

This mirrors `ThemeService.applyTheme()` exactly, so the static preset and the runtime `updatePreset()` override can never diverge again.

- [ ] **Step 3: Widen the `zinc` elevation scale (700–950)**

Replace:

```ts
            500: '#3f4652',
            600: '#2b3038',
            700: '#1f2329',
            800: '#171a1f',
            900: '#111317',
            950: '#0b0d10',
```

with:

```ts
            500: '#454c59',
            600: '#2f3540',
            700: '#242a33',
            800: '#1b1f26',
            900: '#131620',
            950: '#0a0c10',
```

- [ ] **Step 4: `formField` - use `BORDER_SUBTLE`**

Replace:

```ts
                formField: {
                    background: '#121821',
                    borderColor: 'rgba(255,255,255,0.06)',
                    color: '{zinc.50}',
                },
```

with:

```ts
                formField: {
                    background: '#121821',
                    borderColor: BORDER_SUBTLE,
                    color: '{zinc.50}',
                },
```

- [ ] **Step 5: `overlay` (select/popover/navigation/modal) - crisper borders and hairline shadows**

Replace the entire `overlay` block:

```ts
                overlay: {
                    select: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    popover: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    navigation: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    modal: {
                        background: '{zinc.900}',
                        borderColor: 'rgba(255,255,255,0.05)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.04),
              0 20px 60px rgba(0,0,0,0.60)
            `,
                    },
                },
```

with:

```ts
                overlay: {
                    select: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    popover: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    navigation: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    modal: {
                        background: '{zinc.900}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.10),
              0 20px 60px rgba(0,0,0,0.60)
            `,
                    },
                },
```

- [ ] **Step 6: `button.secondary` - border ramp + slightly stronger background deltas**

Replace:

```ts
                        secondary: {
                            background: 'rgba(255,255,255,0.03)',
                            hoverBackground: 'rgba(255,255,255,0.06)',
                            activeBackground: 'rgba(255,255,255,0.09)',

                            borderColor: 'rgba(255,255,255,0.06)',
                            hoverBorderColor: 'rgba(255,255,255,0.10)',
                            activeBorderColor: 'rgba(255,255,255,0.14)',

                            color: '{zinc.200}',
                        },
```

with:

```ts
                        secondary: {
                            background: 'rgba(255,255,255,0.05)',
                            hoverBackground: 'rgba(255,255,255,0.09)',
                            activeBackground: 'rgba(255,255,255,0.13)',

                            borderColor: BORDER_SUBTLE,
                            hoverBorderColor: BORDER_DEFAULT,
                            activeBorderColor: BORDER_STRONG,

                            color: '{zinc.200}',
                        },
```

- [ ] **Step 7: `inputtext` - border ramp + stronger focus ring**

Replace:

```ts
        inputtext: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',

                        borderColor: 'rgba(255,255,255,0.06)',
                        hoverBorderColor: 'rgba(255,255,255,0.10)',

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.16)',
                        },
                    },
                },
            },
        },
```

with:

```ts
        inputtext: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_DEFAULT,

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },
                },
            },
        },
```

- [ ] **Step 8: `textarea` - identical fix to Step 7**

Replace:

```ts
        textarea: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',

                        borderColor: 'rgba(255,255,255,0.06)',
                        hoverBorderColor: 'rgba(255,255,255,0.10)',

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.16)',
                        },
                    },
                },
            },
        },
```

with:

```ts
        textarea: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_DEFAULT,

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },
                },
            },
        },
```

- [ ] **Step 9: `dialog` - border + hairline shadow**

Replace:

```ts
        dialog: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.900}',
                        borderColor: 'rgba(255,255,255,0.05)',
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 24px 80px rgba(0,0,0,0.65)
            `,
                    },
                },
            },
        },
```

with:

```ts
        dialog: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.900}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.09),
              0 24px 80px rgba(0,0,0,0.65)
            `,
                    },
                },
            },
        },
```

- [ ] **Step 10: `menu` - border, hairline shadow, separator, focus background**

Replace:

```ts
        menu: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.04)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: 'rgba(255,255,255,0.06)',
                    },

                    submenuLabel: {
                        color: '{zinc.400}',
                    },
                },
            },
        },
```

with:

```ts
        menu: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.07)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: BORDER_SUBTLE,
                    },

                    submenuLabel: {
                        color: '{zinc.400}',
                    },
                },
            },
        },
```

- [ ] **Step 11: `contextmenu` - identical fix to Step 10 (no `submenuLabel`)**

Replace:

```ts
        contextmenu: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.04)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: 'rgba(255,255,255,0.06)',
                    },
                },
            },
        },
```

with:

```ts
        contextmenu: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.07)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: BORDER_SUBTLE,
                    },
                },
            },
        },
```

- [ ] **Step 12: Verify build**

Run: `ng build`
Expected: succeeds with no TypeScript or template errors.

- [ ] **Step 13: Commit**

```bash
git add src/app/theme/alpine-preset.ts
git commit -m "fix: raise preset border/shadow/focus contrast and fix accent-scale drift"
```

---

### Task 2: `styles.css` - brand token sync + hardcoded override fixes

**Files:**
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: same brand hex values as Task 1 (`#7c72ff`/`#695df2`/`#9a84ff`/`#584ad9`), now duplicated here as plain CSS (Tailwind `@theme` can't import a TS constant) - keep this block's values byte-identical to `DEFAULT_THEME.colors` if either ever changes.
- Produces: `var(--color-brand)`, `var(--color-brand-hover)`, `var(--color-brand-dim)`, `var(--color-brand-dark)`, `var(--color-border-subtle)`, `var(--color-border-default)` - consumed by every later task in this plan.

- [ ] **Step 1: Sync `@theme` brand tokens and border tokens**

Replace:

```css
  /* ── Brand (Indigo) ────────────────────────────────────── */
  --color-brand:       #6366f1;
  --color-brand-hover: #4f46e5;
  --color-brand-dim:   #818cf8;
  --color-brand-dark:  #4338ca;
```

with:

```css
  /* ── Brand - must stay byte-identical to DEFAULT_THEME.colors in
     src/app/models/theme.model.ts, which ThemeService applies at runtime. ── */
  --color-brand:       #7c72ff;
  --color-brand-hover: #695df2;
  --color-brand-dim:   #9a84ff;
  --color-brand-dark:  #584ad9;
```

Replace:

```css
  /* ── Borders ────────────────────────────────────────────── */
  --color-border-subtle:  rgba(255 255 255 / 0.08);
  --color-border-default: rgba(255 255 255 / 0.12);
```

with:

```css
  /* ── Borders ────────────────────────────────────────────── */
  --color-border-subtle:  rgba(255 255 255 / 0.10);
  --color-border-default: rgba(255 255 255 / 0.16);
```

- [ ] **Step 2: Fix the doc-comment example values in the same `@theme` region**

Replace:

```css
 *   bg-brand           → #6366f1  (indigo-500)
 *   text-brand-dim     → #818cf8  (indigo-400)
 *   bg-brand/15        → indigo-500 at 15% opacity (active tab bg)
```

with:

```css
 *   bg-brand           → #7c72ff  (brand purple)
 *   text-brand-dim     → #9a84ff  (brand dim)
 *   bg-brand/15        → brand purple at 15% opacity (active tab bg)
```

- [ ] **Step 3: Fix the `.p-select` hardcoded old-indigo overrides**

Replace:

```css
.dark .p-select:hover { border-color: rgba(255, 255, 255, 0.18) !important; }
.dark .p-select.p-focus { border-color: #818cf8 !important; }
```

with:

```css
.dark .p-select:hover { border-color: rgba(255, 255, 255, 0.18) !important; }
.dark .p-select.p-focus { border-color: var(--color-brand-dim) !important; }
```

Replace:

```css
.dark .p-select-option.p-select-option-selected {
  background: rgba(99, 102, 241, 0.15) !important;
  color: #818cf8 !important;
}
.dark .p-select-option.p-select-option-selected:hover,
.dark .p-select-option.p-select-option-selected.p-focus {
  background: rgba(99, 102, 241, 0.22) !important;
  color: #a5b4fc !important;
}
```

with:

```css
.dark .p-select-option.p-select-option-selected {
  background: color-mix(in srgb, var(--color-brand) 15%, transparent) !important;
  color: var(--color-brand-dim) !important;
}
.dark .p-select-option.p-select-option-selected:hover,
.dark .p-select-option.p-select-option-selected.p-focus {
  background: color-mix(in srgb, var(--color-brand) 22%, transparent) !important;
  color: color-mix(in srgb, var(--color-brand-dim) 80%, white 20%) !important;
}
```

- [ ] **Step 4: Fix `.search-highlight` and the wiki image-uploading outline**

Replace:

```css
.search-highlight {
  background: rgba(99, 102, 241, 0.30);
  color: rgba(255, 255, 255, 0.92);
  border-radius: 2px;
  padding: 0 2px;
}
```

with:

```css
.search-highlight {
  background: color-mix(in srgb, var(--color-brand) 30%, transparent);
  color: rgba(255, 255, 255, 0.92);
  border-radius: 2px;
  padding: 0 2px;
}
```

Replace:

```css
.wiki-wysiwyg img[src^="blob:"] {
  opacity: 0.4;
  outline: 2px solid rgba(129, 140, 248, 0.5);
  outline-offset: 2px;
  animation: wiki-img-uploading 1.3s ease-in-out infinite;
}
```

with:

```css
.wiki-wysiwyg img[src^="blob:"] {
  opacity: 0.4;
  outline: 2px solid color-mix(in srgb, var(--color-brand-dim) 50%, transparent);
  outline-offset: 2px;
  animation: wiki-img-uploading 1.3s ease-in-out infinite;
}
```

- [ ] **Step 5: Verify no old-indigo literals remain in this file**

Run: `grep -nE '6366f1|4f46e5|818cf8|4338ca|99, ?102, ?241|129, ?140, ?248|a5b4fc' src/styles.css`
Expected: no output.

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/styles.css
git commit -m "fix: sync styles.css brand tokens with DEFAULT_THEME, fix hardcoded p-select colors"
```

---

### Task 3: Decorative CSS sweep, batch A - titlebar, login

**Files:**
- Modify: `src/app/titlebar/titlebar.component.css`
- Modify: `src/app/features/login/login.component.html`
- Modify: `src/app/features/login/login.component.css`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)`, `var(--color-brand-dark)` (from Task 2).

- [ ] **Step 1: `titlebar.component.css`**

Replace:

```css
    background: linear-gradient(135deg, #818cf8 0%, #4338ca 100%);
```

with:

```css
    background: linear-gradient(135deg, var(--color-brand-dim) 0%, var(--color-brand-dark) 100%);
```

- [ ] **Step 2: `login.component.html` - logo gradient + shadow (line 14)**

Replace:

```html
            <div class="w-11 h-11 rounded-[13px] bg-gradient-to-br from-indigo-400 to-indigo-700 flex items-center justify-center text-[20px] font-black text-white shadow-[0_4px_18px_rgba(67,56,202,0.45)]">
```

with:

```html
            <div class="w-11 h-11 rounded-[13px] bg-gradient-to-br from-[var(--color-brand-dim)] to-[var(--color-brand-dark)] flex items-center justify-center text-[20px] font-black text-white shadow-[0_4px_18px_color-mix(in_srgb,var(--color-brand-dark)_45%,transparent)]">
```

- [ ] **Step 3: `login.component.html` - remaining `indigo-*` utility classes**

Replace (line 51):

```html
                        <span [class]="loginServerConfigError() ? 'bg-rose-500/15 text-rose-400 border-rose-500/25' : isCustomServer() ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25' : 'bg-white/[0.04] text-slate-500 border-white/[0.08]'"
```

with:

```html
                        <span [class]="loginServerConfigError() ? 'bg-rose-500/15 text-rose-400 border-rose-500/25' : isCustomServer() ? 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)] border-[color-mix(in_srgb,var(--color-brand)_25%,transparent)]' : 'bg-white/[0.04] text-slate-500 border-white/[0.08]'"
```

Replace (identical text appears twice, at lines 88-95 and 229-236 - use `replace_all: true`):

```html
                    <a class="text-indigo-400/60 hover:text-indigo-400 no-underline transition-colors cursor-pointer"
                       (click)="openLink('https://venta.gg/#/eula')">
                        {{ 'LOGIN.TERMS_OF_SERVICE' | translate }}
                    </a>
                    {{ 'LOGIN.AND' | translate }}
                    <a class="text-indigo-400/60 hover:text-indigo-400 no-underline transition-colors cursor-pointer"
                       (click)="openLink('https://venta.gg/#/privacy')">
                        {{ 'LOGIN.PRIVACY_POLICY' | translate }}
                    </a>
```

with:

```html
                    <a class="text-[color-mix(in_srgb,var(--color-brand-dim)_60%,transparent)] hover:text-[var(--color-brand-dim)] no-underline transition-colors cursor-pointer"
                       (click)="openLink('https://venta.gg/#/eula')">
                        {{ 'LOGIN.TERMS_OF_SERVICE' | translate }}
                    </a>
                    {{ 'LOGIN.AND' | translate }}
                    <a class="text-[color-mix(in_srgb,var(--color-brand-dim)_60%,transparent)] hover:text-[var(--color-brand-dim)] no-underline transition-colors cursor-pointer"
                       (click)="openLink('https://venta.gg/#/privacy')">
                        {{ 'LOGIN.PRIVACY_POLICY' | translate }}
                    </a>
```

(This text block appears twice, once around line 88 and once around line 229 - identical text, so use `replace_all: true` if using the Edit tool, since both instances get the same fix.)

Replace (line 119):

```html
                                    class="text-[11px] text-indigo-400/60 hover:text-indigo-400 bg-transparent border-0 cursor-pointer transition-colors px-0 shrink-0">
```

with:

```html
                                    class="text-[11px] text-[color-mix(in_srgb,var(--color-brand-dim)_60%,transparent)] hover:text-[var(--color-brand-dim)] bg-transparent border-0 cursor-pointer transition-colors px-0 shrink-0">
```

Replace (line 137):

```html
                                    class="w-9 h-9 flex items-center justify-center rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 border-0 cursor-pointer transition-colors shrink-0">
```

with:

```html
                                    class="w-9 h-9 flex items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-brand)_20%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-brand)_30%,transparent)] text-[var(--color-brand-dim)] border-0 cursor-pointer transition-colors shrink-0">
```

- [ ] **Step 4: `login.component.css`**

Replace:

```css
    background-image: radial-gradient(rgba(99, 102, 241, 0.07) 1px, transparent 1px);
```

with:

```css
    background-image: radial-gradient(color-mix(in srgb, var(--color-brand) 7%, transparent) 1px, transparent 1px);
```

Replace:

```css
    background: radial-gradient(circle, rgba(99, 102, 241, 0.32) 0%, transparent 65%);
```

with:

```css
    background: radial-gradient(circle, color-mix(in srgb, var(--color-brand) 32%, transparent) 0%, transparent 65%);
```

- [ ] **Step 5: Verify no old-indigo literals remain**

Run: `grep -nE '6366f1|4f46e5|818cf8|4338ca|99, ?102, ?241|67,\s?56,\s?202|indigo-(400|500|600|700)' src/app/titlebar/titlebar.component.css src/app/features/login/login.component.html src/app/features/login/login.component.css`
Expected: no output.

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/titlebar/titlebar.component.css src/app/features/login/login.component.html src/app/features/login/login.component.css
git commit -m "fix: replace hardcoded old-indigo colors with brand tokens in titlebar and login"
```

---

### Task 4: Decorative CSS sweep, batch B - channel, call-panel, conversation

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.css`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.css`
- Modify: `src/app/features/messaging/components/conversation/conversation.component.css`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).

- [ ] **Step 1: `channel.component.css`**

Replace:

```css
        background: rgba(99, 102, 241, 0.15);
```

with:

```css
        background: color-mix(in srgb, var(--color-brand) 15%, transparent);
```

- [ ] **Step 2: `call-panel.component.css` - 5 instances**

Replace:

```css
.resize-handle:hover .resize-grip {
    background: rgba(99, 102, 241, 0.5);
    width: 56px;
}
```

with:

```css
.resize-handle:hover .resize-grip {
    background: color-mix(in srgb, var(--color-brand) 50%, transparent);
    width: 56px;
}
```

Replace:

```css
.stats-toggle--active {
    background: rgba(99, 102, 241, 0.15);
    color: var(--color-brand-dim);
}
```

with:

```css
.stats-toggle--active {
    background: color-mix(in srgb, var(--color-brand) 15%, transparent);
    color: var(--color-brand-dim);
}
```

Replace:

```css
.stats-arrow--up {
    color: #818cf8;
}
```

with:

```css
.stats-arrow--up {
    color: var(--color-brand-dim);
}
```

Replace:

```css
.ctrl-btn--on {
    background: rgba(99, 102, 241, 0.2);
    color: var(--color-brand-dim);
}

.ctrl-btn--on:hover {
    background: rgba(99, 102, 241, 0.3);
}
```

with:

```css
.ctrl-btn--on {
    background: color-mix(in srgb, var(--color-brand) 20%, transparent);
    color: var(--color-brand-dim);
}

.ctrl-btn--on:hover {
    background: color-mix(in srgb, var(--color-brand) 30%, transparent);
}
```

- [ ] **Step 3: `conversation.component.css` - 4 instances**

Replace:

```css
        background: rgba(99, 102, 241, 0.15);
```

with:

```css
        background: color-mix(in srgb, var(--color-brand) 15%, transparent);
```

Replace:

```css
    background: linear-gradient(90deg, rgba(99, 102, 241, 0.13) 0%, rgba(99, 102, 241, 0.04) 100%);
    border-bottom: 1px solid rgba(99, 102, 241, 0.18);
```

with:

```css
    background: linear-gradient(90deg, color-mix(in srgb, var(--color-brand) 13%, transparent) 0%, color-mix(in srgb, var(--color-brand) 4%, transparent) 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--color-brand) 18%, transparent);
```

Replace:

```css
    border: 1.5px solid rgba(99, 102, 241, 0.45);
```

with:

```css
    border: 1.5px solid color-mix(in srgb, var(--color-brand) 45%, transparent);
```

- [ ] **Step 4: Verify no old-indigo literals remain**

Run: `grep -nE '6366f1|4f46e5|818cf8|4338ca|99, ?102, ?241' src/app/features/guild/components/channel/channel.component.css src/app/features/messaging/components/conversation/call-panel/call-panel.component.css src/app/features/messaging/components/conversation/conversation.component.css`
Expected: no output.

- [ ] **Step 5: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/channel/channel.component.css src/app/features/messaging/components/conversation/call-panel/call-panel.component.css src/app/features/messaging/components/conversation/conversation.component.css
git commit -m "fix: replace hardcoded old-indigo colors with brand tokens in channel/call-panel/conversation"
```

---

### Task 5: Decorative CSS sweep, batch C - mention-chip components

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/system-message/system-message.component.css`
- Modify: `src/app/features/messaging/components/conversation/composer/composer.component.css`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.css`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).

- [ ] **Step 1: `system-message.component.css`**

Replace:

```css
.mention-chip {
    display: inline-flex;
    align-items: center;
    background: rgba(99, 102, 241, 0.18);
    color: rgb(129, 140, 248);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
```

with:

```css
.mention-chip {
    display: inline-flex;
    align-items: center;
    background: color-mix(in srgb, var(--color-brand) 18%, transparent);
    color: var(--color-brand-dim);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
```

- [ ] **Step 2: `composer.component.css`**

Replace:

```css
:host ::ng-deep .mention-chip {
    display: inline-flex;
    align-items: center;
    background: rgba(99, 102, 241, 0.18);
    color: rgb(129, 140, 248);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
```

with:

```css
:host ::ng-deep .mention-chip {
    display: inline-flex;
    align-items: center;
    background: color-mix(in srgb, var(--color-brand) 18%, transparent);
    color: var(--color-brand-dim);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
```

- [ ] **Step 3: `message.component.css` - mention chip + channel-mention variant**

Replace:

```css
:host ::ng-deep .mention-chip {
    display: inline-flex;
    align-items: center;
    background: rgba(99, 102, 241, 0.18);
    color: rgb(129, 140, 248);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
```

with:

```css
:host ::ng-deep .mention-chip {
    display: inline-flex;
    align-items: center;
    background: color-mix(in srgb, var(--color-brand) 18%, transparent);
    color: var(--color-brand-dim);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 0.875rem;
```

Replace:

```css
.mention-chip-channel,
:host ::ng-deep .mention-chip-channel {
    background: rgba(129, 140, 248, 0.10);
    color: var(--color-brand-dim);
}
```

with:

```css
.mention-chip-channel,
:host ::ng-deep .mention-chip-channel {
    background: color-mix(in srgb, var(--color-brand-dim) 10%, transparent);
    color: var(--color-brand-dim);
}
```

- [ ] **Step 4: Verify no old-indigo literals remain**

Run: `grep -nE '99, ?102, ?241|129, ?140, ?248' src/app/features/messaging/components/conversation/message/system-message/system-message.component.css src/app/features/messaging/components/conversation/composer/composer.component.css src/app/features/messaging/components/conversation/message/message.component.css`
Expected: no output.

- [ ] **Step 5: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/system-message/system-message.component.css src/app/features/messaging/components/conversation/composer/composer.component.css src/app/features/messaging/components/conversation/message/message.component.css
git commit -m "fix: replace hardcoded old-indigo mention-chip colors with brand tokens"
```

---

### Task 6: wiki-history, permission-overrides-panel, roles-settings

**Files:**
- Modify: `src/app/features/guild/components/wiki/wiki-history/wiki-history.component.html`
- Modify: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).
- Note: `roles-settings.*` also gets a **plain literal** default-swatch update (`#6366f1` → `#7c72ff`) - this is a role-color data default, not a live theme reference (see design doc's "Role-color swatch defaults" section), so it stays a hardcoded hex, not a CSS var.

- [ ] **Step 1: `wiki-history.component.html`**

Replace:

```html
                        <div [style.borderColor]="expandedRevId() === rev.id ? 'rgba(129,140,248,0.35)' : 'rgba(255,255,255,0.06)'"
```

with:

```html
                        <div [style.borderColor]="expandedRevId() === rev.id ? 'color-mix(in srgb, var(--color-brand-dim) 35%, transparent)' : 'rgba(255,255,255,0.10)'"
```

(The non-expanded branch's border also moves from `0.06` to `0.10` to match Task 1/2's new `BORDER_SUBTLE` baseline.)

- [ ] **Step 2: `permission-overrides-panel.component.html` - 3 identical fallbacks**

Replace all 3 occurrences of:

```html
<span [style.background]="entry.color || '#6366f1'"
```

with:

```html
<span [style.background]="entry.color || 'var(--color-brand)'"
```

(Use `replace_all: true` - all three are the same replacement, at lines 32, 56, 97.)

- [ ] **Step 3: `roles-settings.component.ts` - default-swatch literal (4 occurrences)**

Replace:

```ts
    editColor = signal('#6366f1');
```

with:

```ts
    editColor = signal('#7c72ff');
```

Replace:

```ts
    createColor = signal('#6366f1');
```

with:

```ts
    createColor = signal('#7c72ff');
```

Replace:

```ts
        this.editColor.set(role.color ?? '#6366f1');
```

with:

```ts
        this.editColor.set(role.color ?? '#7c72ff');
```

Replace:

```ts
            this.editColor() !== (r.color ?? '#6366f1') ||
```

with:

```ts
            this.editColor() !== (r.color ?? '#7c72ff') ||
```

- [ ] **Step 4: `roles-settings.component.html` - fallback literal + placeholder + 3 `indigo-*` tab/row highlights**

Replace:

```html
          <span [style.background]="role.color || '#6366f1'"
```

with:

```html
          <span [style.background]="role.color || '#7c72ff'"
```

Replace:

```html
                                       placeholder="#6366f1"/>
```

with:

```html
                                       placeholder="#7c72ff"/>
```

Replace all 3 occurrences of the pattern `'bg-indigo-500/15 text-indigo-400' : 'text-white/50 hover:bg-white/[0.05]'` (lines 18, 51, 56 - each has different leading condition text, so match each full line individually):

```html
                        [ngClass]="selectedRole()?.id === role.id ? 'bg-indigo-500/15 text-indigo-400' : 'text-white/50 hover:bg-white/[0.05]'"
```

with:

```html
                        [ngClass]="selectedRole()?.id === role.id ? 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)]' : 'text-white/50 hover:bg-white/[0.05]'"
```

Replace:

```html
                        [ngClass]="activeTab() === 'settings' ? 'bg-indigo-500/15 text-indigo-400' : 'text-white/50 hover:bg-white/[0.05]'"
```

with:

```html
                        [ngClass]="activeTab() === 'settings' ? 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)]' : 'text-white/50 hover:bg-white/[0.05]'"
```

Replace:

```html
                        [ngClass]="activeTab() === 'members' ? 'bg-indigo-500/15 text-indigo-400' : 'text-white/50 hover:bg-white/[0.05]'"
```

with:

```html
                        [ngClass]="activeTab() === 'members' ? 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)]' : 'text-white/50 hover:bg-white/[0.05]'"
```

- [ ] **Step 5: Verify no old-indigo literals remain (except the intentional role-swatch default)**

Run: `grep -nE '6366f1|129, ?140, ?248|indigo-(400|500|600|700)' src/app/features/guild/components/wiki/wiki-history/wiki-history.component.html src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.html src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html`
Expected: no output.

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-history/wiki-history.component.html src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.html src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html
git commit -m "fix: sync wiki-history/permission-overrides/roles-settings colors to brand tokens"
```

---

### Task 7: `entropy-modal.component.ts` - theme-aware canvas colors

**Files:**
- Modify: `src/app/features/key-setup/entropy-modal/entropy-modal.component.ts`

**Interfaces:**
- Consumes: `--color-brand`, `--color-brand-dim` CSS custom properties (resolved via `getComputedStyle`, since a `<canvas>` 2D context cannot consume `var(...)` directly).
- Produces: `private brandRgb: string`, `private brandDimRgb: string` - resolved once in `ngAfterViewInit`, consumed by `renderLoop()`.

- [ ] **Step 1: Add RGB-resolution fields and a `hexToRgb` helper**

Replace:

```ts
    private ctx!: CanvasRenderingContext2D;
    private rafId = 0;
    private timerId: ReturnType<typeof setInterval> | null = null;
    private finished = false;
```

with:

```ts
    private ctx!: CanvasRenderingContext2D;
    private rafId = 0;
    private timerId: ReturnType<typeof setInterval> | null = null;
    private finished = false;

    private brandRgb = '124,114,255';
    private brandDimRgb = '154,132,255';
```

- [ ] **Step 2: Resolve the live brand colors at init time**

Find the start of `ngAfterViewInit`:

```ts
    ngAfterViewInit(): void {
        this.grid = Array.from({length: this.ROWS}, () =>
            Array.from({length: this.COLS}, () => ({brightness: 0, visited: false}))
        );
```

Replace with:

```ts
    ngAfterViewInit(): void {
        const style = getComputedStyle(document.documentElement);
        this.brandRgb = this.hexToRgb(style.getPropertyValue('--color-brand')) ?? this.brandRgb;
        this.brandDimRgb = this.hexToRgb(style.getPropertyValue('--color-brand-dim')) ?? this.brandDimRgb;

        this.grid = Array.from({length: this.ROWS}, () =>
            Array.from({length: this.COLS}, () => ({brightness: 0, visited: false}))
        );
```

- [ ] **Step 3: Add the `hexToRgb` helper method**

Add after `private finish(): void {` - actually, add it as a new private method anywhere in the class body, e.g. right before `private renderLoop(): void {`:

```ts
    private hexToRgb(hex: string): string | null {
        const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
        if (!match) return null;
        const n = parseInt(match[1], 16);
        return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    }

    private renderLoop(): void {
```

replacing the original:

```ts
    private renderLoop(): void {
```

- [ ] **Step 4: Use the resolved RGB strings in the render loop**

Replace:

```ts
                if (cell.visited) {
                    ctx.fillStyle = 'rgba(99,102,241,0.12)';
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
                }

                if (cell.brightness > 0.01) {
                    ctx.fillStyle = `rgba(99,102,241,${cell.brightness * 0.85})`;
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);

                    const m = cw * 0.28;
                    ctx.fillStyle = `rgba(165,180,252,${cell.brightness * 0.55})`;
                    ctx.fillRect(x + m, y + m, cw - m * 2, ch - m * 2);
```

with:

```ts
                if (cell.visited) {
                    ctx.fillStyle = `rgba(${this.brandRgb},0.12)`;
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
                }

                if (cell.brightness > 0.01) {
                    ctx.fillStyle = `rgba(${this.brandRgb},${cell.brightness * 0.85})`;
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);

                    const m = cw * 0.28;
                    ctx.fillStyle = `rgba(${this.brandDimRgb},${cell.brightness * 0.55})`;
                    ctx.fillRect(x + m, y + m, cw - m * 2, ch - m * 2);
```

- [ ] **Step 5: Verify no old-indigo literals remain**

Run: `grep -nE '99,102,241|165,180,252' src/app/features/key-setup/entropy-modal/entropy-modal.component.ts`
Expected: no output.

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/key-setup/entropy-modal/entropy-modal.component.ts
git commit -m "fix: make entropy-modal canvas colors track the live brand theme"
```

---

### Task 8: Indigo-utility sweep, batch A - settings/admin page-nav active states

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/settings/settings-modal/settings-modal.component.ts`
- Modify: `src/app/features/admin/admin-modal/admin-modal.component.ts`
- Modify: `src/app/features/guild/components/channel-settings-modal/channel-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/category-settings-modal/category-settings-modal.component.ts`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).

These 5 files share the identical `ngClass`-object pattern for a page-nav active state. Apply the same edit in each:

- [ ] **Step 1: `guild-settings-modal.component.ts`**

Replace:

```ts
            'bg-indigo-500/15': active,
            'text-indigo-400': active,
```

with:

```ts
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
```

- [ ] **Step 2: `settings-modal.component.ts`**

Replace:

```ts
            'bg-indigo-500/15': active,
            'text-indigo-400': active,
```

with:

```ts
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
```

- [ ] **Step 3: `admin-modal.component.ts`**

Replace:

```ts
            'bg-indigo-500/15': active,
            'text-indigo-400': active,
```

with:

```ts
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
```

- [ ] **Step 4: `channel-settings-modal.component.ts`**

Replace:

```ts
            'bg-indigo-500/15': active,
            'text-indigo-400': active,
```

with:

```ts
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
```

- [ ] **Step 5: `category-settings-modal.component.ts`**

Replace:

```ts
            'bg-indigo-500/15': active,
            'text-indigo-400': active,
```

with:

```ts
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
```

- [ ] **Step 6: Verify no `indigo-` utility remains**

Run: `grep -nE 'indigo-(400|500|600|700)' src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts src/app/features/settings/settings-modal/settings-modal.component.ts src/app/features/admin/admin-modal/admin-modal.component.ts src/app/features/guild/components/channel-settings-modal/channel-settings-modal.component.ts src/app/features/guild/components/category-settings-modal/category-settings-modal.component.ts`
Expected: no output.

- [ ] **Step 7: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts src/app/features/settings/settings-modal/settings-modal.component.ts src/app/features/admin/admin-modal/admin-modal.component.ts src/app/features/guild/components/channel-settings-modal/channel-settings-modal.component.ts src/app/features/guild/components/category-settings-modal/category-settings-modal.component.ts
git commit -m "fix: replace indigo-* Tailwind utilities with brand tokens in settings-modal nav active states"
```

---

### Task 9: Indigo-utility sweep, batch B - settings page templates

**Files:**
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html`
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/invites-settings/invites-settings.component.html`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).

- [ ] **Step 1: `profile-settings.component.html` - 3 identical avatar-placeholder blocks**

Replace (occurs at 3 different sizes - apply to each of the 3 occurrences individually, since surrounding context differs):

```html
                    <div class="w-16 h-16 rounded-full bg-indigo-500/20 border-2 border-white/10
                      flex items-center justify-center text-2xl font-semibold text-indigo-300
                      transition-opacity group-hover:opacity-80">
```

with:

```html
                    <div class="w-16 h-16 rounded-full bg-[color-mix(in_srgb,var(--color-brand)_20%,transparent)] border-2 border-white/10
                      flex items-center justify-center text-2xl font-semibold text-[var(--color-brand-dim)]
                      transition-opacity group-hover:opacity-80">
```

Replace:

```html
                    <div class="w-20 h-20 rounded-full bg-indigo-500/20 border-2 border-white/10
                      flex items-center justify-center text-3xl font-semibold text-indigo-300
                      transition-opacity group-hover:opacity-80">
```

with:

```html
                    <div class="w-20 h-20 rounded-full bg-[color-mix(in_srgb,var(--color-brand)_20%,transparent)] border-2 border-white/10
                      flex items-center justify-center text-3xl font-semibold text-[var(--color-brand-dim)]
                      transition-opacity group-hover:opacity-80">
```

Replace:

```html
            <div class="w-64 h-64 rounded-full bg-indigo-500/20 border-4 border-white/10 shadow-2xl
                  flex items-center justify-center text-8xl font-semibold text-indigo-300">
```

with:

```html
            <div class="w-64 h-64 rounded-full bg-[color-mix(in_srgb,var(--color-brand)_20%,transparent)] border-4 border-white/10 shadow-2xl
                  flex items-center justify-center text-8xl font-semibold text-[var(--color-brand-dim)]">
```

- [ ] **Step 2: `voice-video-settings.component.html`**

Replace:

```html
                        [ngClass]="isMicActive()
            ? 'bg-rose-500/15 border-rose-500/30 text-rose-400 hover:bg-rose-500/25'
            : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/25'"
```

with:

```html
                        [ngClass]="isMicActive()
            ? 'bg-rose-500/15 border-rose-500/30 text-rose-400 hover:bg-rose-500/25'
            : 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] border-[color-mix(in_srgb,var(--color-brand)_30%,transparent)] text-[var(--color-brand-dim)] hover:bg-[color-mix(in_srgb,var(--color-brand)_25%,transparent)]'"
```

Replace:

```html
                        <span class="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide
                         bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">RNNoise</span>
```

with:

```html
                        <span class="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide
                         bg-[color-mix(in_srgb,var(--color-brand)_20%,transparent)] text-[var(--color-brand-dim)] border border-[color-mix(in_srgb,var(--color-brand)_30%,transparent)]">RNNoise</span>
```

- [ ] **Step 3: `invites-settings.component.html`**

Replace:

```html
              <span [ngClass]="invite.type === InviteType.Permanent ? 'bg-indigo-500/15 text-indigo-400' : 'bg-amber-500/15 text-amber-400'"
```

with:

```html
              <span [ngClass]="invite.type === InviteType.Permanent ? 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)]' : 'bg-amber-500/15 text-amber-400'"
```

- [ ] **Step 4: Verify no `indigo-` utility remains**

Run: `grep -nE 'indigo-(400|500|600|700)' src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html src/app/features/guild/components/guild-settings-modal/pages/invites-settings/invites-settings.component.html`
Expected: no output.

- [ ] **Step 5: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html src/app/features/guild/components/guild-settings-modal/pages/invites-settings/invites-settings.component.html
git commit -m "fix: replace indigo-* Tailwind utilities with brand tokens in settings page templates"
```

---

### Task 10: Indigo-utility sweep, batch C - messaging composer/suggestions

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`
- Modify: `src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.html`
- Modify: `src/app/features/messaging/components/conversation/composer/composer.component.html`
- Modify: `src/app/features/messaging/components/conversation/composer/gif-picker-button/gif-picker-button.component.html`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).

- [ ] **Step 1: `message.component.html`**

Replace:

```html
                  class="w-full bg-white/[0.05] border border-white/[0.12] focus:border-indigo-400/60
```

with:

```html
                  class="w-full bg-white/[0.05] border border-white/[0.12] focus:border-[color-mix(in_srgb,var(--color-brand-dim)_60%,transparent)]
```

- [ ] **Step 2: `suggestion-overlay.component.html` - 3 instances**

Replace both occurrences of:

```html
                        <span class="text-sm font-bold text-indigo-400 shrink-0">/{{ item.def.name }}</span>
```

with (use `replace_all: true` - identical text at lines 58 and 72):

```html
                        <span class="text-sm font-bold text-[var(--color-brand-dim)] shrink-0">/{{ item.def.name }}</span>
```

Replace:

```html
                        <span [ngClass]="item.def.scope === 'inline' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-indigo-500/15 text-indigo-400'"
```

with:

```html
                        <span [ngClass]="item.def.scope === 'inline' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)]'"
```

- [ ] **Step 3: `composer.component.html`**

Replace:

```html
            <span class="text-[11px] font-bold text-indigo-400">/ {{ activeCommand()!.name }}</span>
```

with:

```html
            <span class="text-[11px] font-bold text-[var(--color-brand-dim)]">/ {{ activeCommand()!.name }}</span>
```

Replace:

```html
            <div class="absolute inset-0 rounded-2xl bg-indigo-500/10 border-2 border-dashed border-indigo-500/40 flex items-center justify-center z-10 pointer-events-none">
                <div class="flex flex-col items-center gap-1.5">
                    <i class="pi pi-upload text-indigo-400 text-lg"></i>
                    <p class="text-xs text-indigo-400/70">Drop files here</p>
                </div>
            </div>
```

with:

```html
            <div class="absolute inset-0 rounded-2xl bg-[color-mix(in_srgb,var(--color-brand)_10%,transparent)] border-2 border-dashed border-[color-mix(in_srgb,var(--color-brand)_40%,transparent)] flex items-center justify-center z-10 pointer-events-none">
                <div class="flex flex-col items-center gap-1.5">
                    <i class="pi pi-upload text-[var(--color-brand-dim)] text-lg"></i>
                    <p class="text-xs text-[color-mix(in_srgb,var(--color-brand-dim)_70%,transparent)]">Drop files here</p>
                </div>
            </div>
```

- [ ] **Step 4: `gif-picker-button.component.html`**

Replace:

```html
                                    class="aspect-square overflow-hidden rounded-lg border-0 p-0 cursor-pointer hover:ring-2 hover:ring-indigo-500 transition-all bg-white/[0.04]">
```

with:

```html
                                    class="aspect-square overflow-hidden rounded-lg border-0 p-0 cursor-pointer hover:ring-2 hover:ring-[var(--color-brand)] transition-all bg-white/[0.04]">
```

- [ ] **Step 5: Verify no `indigo-` utility remains**

Run: `grep -nE 'indigo-(400|500|600|700)' src/app/features/messaging/components/conversation/message/message.component.html src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.html src/app/features/messaging/components/conversation/composer/composer.component.html src/app/features/messaging/components/conversation/composer/gif-picker-button/gif-picker-button.component.html`
Expected: no output.

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/message.component.html src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.html src/app/features/messaging/components/conversation/composer/composer.component.html src/app/features/messaging/components/conversation/composer/gif-picker-button/gif-picker-button.component.html
git commit -m "fix: replace indigo-* Tailwind utilities with brand tokens in composer and suggestions"
```

---

### Task 11: Indigo-utility sweep, batch D - admin, call-overlay, avatar

**Files:**
- Modify: `src/app/features/admin/admin-modal/pages/federation-policy/federation-policy.component.html`
- Modify: `src/app/features/admin/admin-modal/admin-modal.component.html`
- Modify: `src/app/components/avatar/avatar.component.ts`
- Modify: `src/app/features/call/call-overlay/call-overlay.component.html`

**Interfaces:**
- Consumes: `var(--color-brand)`, `var(--color-brand-dim)` (from Task 2).

- [ ] **Step 1: `federation-policy.component.html` - refactor 3 `[class.X]` bindings into one `[ngClass]` ternary**

The 3 separate `[class.indigo-*]` bindings need to become arbitrary-value Tailwind classes, which is unwieldy to express as individual `[class.foo-[var(...)]]` binding keys (the brackets clash with Angular's own binding syntax). Consolidate into `[ngClass]`, matching the ternary pattern already used elsewhere in this codebase (e.g. `roles-settings.component.html`).

Replace:

```html
                <button (click)="setPolicy(option.value)"
                        [class.ring-2]="policy() === option.value"
                        [class.ring-indigo-500]="policy() === option.value"
                        [class.border-indigo-500/40]="policy() === option.value"
                        [class.border-white\/\[0\.08\]]="policy() !== option.value"
                        class="flex items-center gap-4 w-full text-left bg-white/[0.03] border rounded-xl px-4 py-3.5 transition-all cursor-pointer">
                    <div [class.bg-indigo-500]="policy() === option.value"
                         [class.border-white\/30]="policy() !== option.value"
                         class="w-4 h-4 rounded-full border-2 shrink-0 transition-colors flex items-center justify-center">
```

with:

```html
                <button (click)="setPolicy(option.value)"
                        [ngClass]="policy() === option.value
                          ? 'ring-2 ring-[var(--color-brand)] border-[color-mix(in_srgb,var(--color-brand)_40%,transparent)]'
                          : 'border-white/[0.08]'"
                        class="flex items-center gap-4 w-full text-left bg-white/[0.03] border rounded-xl px-4 py-3.5 transition-all cursor-pointer">
                    <div [ngClass]="policy() === option.value ? 'bg-[var(--color-brand)]' : 'border-white/30'"
                         class="w-4 h-4 rounded-full border-2 shrink-0 transition-colors flex items-center justify-center">
```

- [ ] **Step 2: `admin-modal.component.html` - 2 identical shield-icon/label instances**

Replace both occurrences of:

```html
                        <i class="pi pi-shield text-sm text-indigo-400"></i>
```

with (use `replace_all: true` - identical text at lines 22 and 53):

```html
                        <i class="pi pi-shield text-sm text-[var(--color-brand-dim)]"></i>
```

Replace:

```html
                        <span class="text-xs font-semibold text-indigo-400 uppercase tracking-widest">Admin Panel</span>
```

with:

```html
                        <span class="text-xs font-semibold text-[var(--color-brand-dim)] uppercase tracking-widest">Admin Panel</span>
```

- [ ] **Step 3: `avatar.component.ts`**

Replace:

```html
          <div class="w-full h-full flex items-center justify-center bg-indigo-500 text-white font-semibold text-sm rounded-full">
```

with:

```html
          <div class="w-full h-full flex items-center justify-center bg-[var(--color-brand)] text-white font-semibold text-sm rounded-full">
```

- [ ] **Step 4: `call-overlay.component.html`**

Replace:

```html
        <div class="h-[2px] bg-gradient-to-r from-indigo-500/70 via-indigo-400/30 to-transparent"></div>
```

with:

```html
        <div class="h-[2px] bg-gradient-to-r from-[color-mix(in_srgb,var(--color-brand)_70%,transparent)] via-[color-mix(in_srgb,var(--color-brand-dim)_30%,transparent)] to-transparent"></div>
```

Replace:

```html
                <div class="absolute inset-0 rounded-full bg-indigo-500/20 scale-[1.35] animate-pulse"></div>
```

with:

```html
                <div class="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--color-brand)_20%,transparent)] scale-[1.35] animate-pulse"></div>
```

- [ ] **Step 5: Verify no `indigo-` utility remains**

Run: `grep -nE 'indigo-(400|500|600|700)' src/app/features/admin/admin-modal/pages/federation-policy/federation-policy.component.html src/app/features/admin/admin-modal/admin-modal.component.html src/app/components/avatar/avatar.component.ts src/app/features/call/call-overlay/call-overlay.component.html`
Expected: no output.

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/admin/admin-modal/pages/federation-policy/federation-policy.component.html src/app/features/admin/admin-modal/admin-modal.component.html src/app/components/avatar/avatar.component.ts src/app/features/call/call-overlay/call-overlay.component.html
git commit -m "fix: replace indigo-* Tailwind utilities with brand tokens in admin, call-overlay, avatar"
```

---

### Task 12: Full-repo verification and visual check

**Files:** none (verification-only task)

- [ ] **Step 1: Full-repo grep for any remaining old-indigo literal**

Run:

```bash
grep -rnE '6366f1|4f46e5|818cf8|4338ca|99, ?102, ?241|129, ?140, ?248|67, ?56, ?202|indigo-(400|500|600|700)' src
```

Expected: **zero matches**, except the two intentional role-swatch-default literals in `roles-settings.component.ts`/`.html`, which are now `#7c72ff` (not matched by this pattern - verify by eye that only `#7c72ff` appears there, not `#6366f1`).

- [ ] **Step 2: Full build**

Run: `ng build`
Expected: succeeds with no errors or warnings introduced by this work.

- [ ] **Step 3: Launch the app and visually verify**

Use the `run` skill to launch the app. Confirm:
- Panels, menus, dropdowns, and dialogs read as visually distinct layered surfaces (not flat/blended).
- Borders and focus rings are clearly visible, not near-invisible.
- The accent purple renders identically across: buttons, PrimeNG dropdowns (`.p-select`), mention pills in messages, the login screen logo/links, the titlebar icon, and any settings-modal active-nav-item highlight - no mismatched indigo/purple anywhere.
- The entropy-modal (key-setup flow) draws in the same brand purple as the rest of the app.

- [ ] **Step 4: Report findings**

If any visual issue is found in Step 3, note the specific component and file, then fix inline (small follow-up edit + commit) before considering this plan complete. If everything matches, the plan is done - no further commit needed for this task.
