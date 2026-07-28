# Preset Contrast Pass & Brand Color Sync (Design)

## Context
The app feels "low contrast, blurred, cheap." Two root causes:

1. **Borders/shadows/focus rings in `alpine-preset.ts` are too subtle** (mostly `rgba(255,255,255,0.05–0.06)`) and the PrimeNG `zinc` surface scale (700–950) has very small steps between values, so panels/inputs/menus/dialogs don't read as distinct layered surfaces — everything blends into one dark mass.
2. **Brand color drift.** The app's actual brand color is purple `#7c72ff` (`theme.model.ts` `DEFAULT_THEME`), applied at runtime by `ThemeService.applyTheme()` via `updatePreset()`. But:
   - `alpine-preset.ts`'s hand-authored `accent` primitive scale (`500: '#5f7fc7'`, muted blue) is fully overwritten by `ThemeService` on every boot — it's dead code, just a source of potential drift/flash.
   - `styles.css`'s `@theme` block and three `.p-select` overrides still hardcode the *old* indigo (`#6366f1` family) as static fallback/override values, unrelated to the live theme.
   - 10 more component files hardcode the same old indigo in decorative accents (gradients, highlights, mention pills), so those elements render a visibly different purple/indigo than buttons and links.
   - A further **19 files** lean on Tailwind's *built-in* `indigo-400`/`500`/`600`/`700` utility classes (`bg-indigo-500/15`, `text-indigo-400`, `border-indigo-500/25`, etc.) for badges, active states, and highlights — not caught by a hex grep, but the same drift: Tailwind's stock indigo is a different hue from the app's brand purple.

## Approach
Fix the token layer, then mechanically propagate it.

1. Raise border/focus/shadow-hairline opacity and widen the `zinc` elevation scale in `alpine-preset.ts` so surfaces and edges read as distinct without changing the overall neutral-dark + purple-accent identity.
2. Make `accent` in `alpine-preset.ts` derive from `DEFAULT_THEME.colors.brand` via `palette()` — the same call `ThemeService` already makes — so the static preset and the runtime override are identical by construction. No more hand-maintained duplicate scale, no boot flash.
3. Sync `styles.css` `@theme` brand tokens to `DEFAULT_THEME.colors` exactly, and fix the `.p-select`/search-highlight overrides to reference `var(--color-brand...)` / `color-mix(...)` instead of literal old-indigo hex.
4. Sweep the 10 component files with hardcoded old-indigo decorative accents to use `var(--color-brand...)` / `color-mix(in srgb, var(--color-brand...) X%, transparent)` — the pattern already established elsewhere in the codebase (see `.wiki-content` rules in `styles.css`).
5. Separately, update the 2 files (3 literals) using `#6366f1` as a **default role-color swatch** (a Discord-style user-assignable color, not live theming) to `#7c72ff` so the default at least starts in sync with the current brand. These stay plain string literals (TS signal defaults / HTML placeholder), not CSS vars — they're data defaults, not theming.

## Changes

### `src/app/theme/alpine-preset.ts`
- Add two local constants: `const BORDER_SUBTLE = 'rgba(255,255,255,0.10)'` (was scattered `0.05`–`0.06`), `const BORDER_DEFAULT = 'rgba(255,255,255,0.16)'` (was `0.10`); use a `BORDER_STRONG = 'rgba(255,255,255,0.22)'` for active/pressed states (was `0.14`–`0.18`). Replace the repeated inline rgba literals across `formField`, `button`, `inputtext`, `textarea`, `dialog`, `menu`, `contextmenu` with these constants.
- Widen `zinc` 700–950 so menu/dialog/modal surfaces are visually distinct from each other and from `card`/`sidebar` (Tailwind tokens), instead of near-duplicate dark navy values.
- Bump the shadow "hairline" ring alpha in overlay/menu/contextmenu/dialog shadows (currently `0.03`–`0.06`) up to `~0.08`–`0.10` so floating surfaces have a crisp edge; leave the diffuse drop-shadow layer as-is (already strong enough).
- Bump `inputtext`/`textarea` focus ring alpha from `0.16` to `~0.32` for clearer focus feedback.
- Replace the hand-authored `accent` primitive scale with:
  ```ts
  accent: {
    ...(palette(DEFAULT_THEME.colors.brand) as object),
    400: DEFAULT_THEME.colors.brandDim,
    500: DEFAULT_THEME.colors.brand,
    600: DEFAULT_THEME.colors.brandHover,
    700: DEFAULT_THEME.colors.brandDark,
  },
  ```
  importing `palette` from `@primeuix/themes` and `DEFAULT_THEME` from `../models/theme.model` — mirroring `ThemeService.applyTheme()` exactly.

### `src/styles.css`
- `@theme` block: `--color-brand: #7c72ff`, `--color-brand-hover: #695df2`, `--color-brand-dim: #9a84ff`, `--color-brand-dark: #584ad9` (was old indigo `#6366f1`/`#4f46e5`/`#818cf8`/`#4338ca`); update the doc-comment example values in the same block.
- `.dark .p-select.p-focus`, `.p-select-option-selected` (and its hover/focus variant), `.search-highlight`, and the `wiki-img-uploading` outline: replace literal old-indigo hex/rgba with `var(--color-brand...)` / `color-mix(in srgb, var(--color-brand...) X%, transparent)`.
- Bump `--color-border-subtle` (`0.08 → 0.10`) and `--color-border-default` (`0.12 → 0.16`) to stay aligned with the preset's new `BORDER_SUBTLE`/`BORDER_DEFAULT`.

### Component sweep (old-indigo → brand token)
Replace hardcoded `#6366f1` / `#818cf8` / `#4338ca` / `#4f46e5` / their rgb/rgba forms with `var(--color-brand...)` or `color-mix(in srgb, var(--color-brand...) X%, transparent)` in:
`titlebar.component.css`, `login.component.html`, `login.component.css`, `channel.component.css`, `call-panel.component.css`, `conversation.component.css`, `system-message.component.css`, `composer.component.css`, `message.component.css`, `wiki-history.component.html`, `permission-overrides-panel.component.html` (the `entry.color || '#6366f1'` fallback becomes `entry.color || 'var(--color-brand)'`).

`entropy-modal.component.ts` draws to a `<canvas>`, so `ctx.fillStyle` can't consume a CSS custom property directly. Add a small helper that resolves `--color-brand` via `getComputedStyle` once and builds the `rgba(...)` string, so the entropy visualization also tracks the live theme instead of a hardcoded color.

### Tailwind built-in `indigo-*` utility sweep (19 files)
Same substitution rule, applied to Tailwind utility classes instead of raw CSS: replace `indigo-400` → arbitrary value keyed to `var(--color-brand-dim)`, `indigo-500` → `var(--color-brand)`, `indigo-600` → `var(--color-brand-hover)`, `indigo-700` → `var(--color-brand-dark)`, preserving whatever opacity modifier was already present (e.g. `bg-indigo-500/15` → `bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]`; `text-indigo-400` → `text-[var(--color-brand-dim)]`; `border-indigo-500/25` → `border-[color-mix(in_srgb,var(--color-brand)_25%,transparent)]`). Applies to: `profile-settings.component.html`, `voice-video-settings.component.html`, `message.component.html`, `suggestion-overlay.component.html`, `composer.component.html`, `invites-settings.component.html`, `roles-settings.component.html`, `guild-settings-modal.component.ts`, `settings-modal.component.ts`, `federation-policy.component.html`, `admin-modal.component.html`, `admin-modal.component.ts`, `login.component.html`, `avatar.component.ts`, `channel-settings-modal.component.ts`, `call-overlay.component.html`, `gif-picker-button.component.html`, `category-settings-modal.component.ts`, plus the `indigo-*` reference in `styles.css`'s doc comment (already covered by the `@theme` sync above). `login.component.html` also has a literal `rgba(67,56,202,0.45)` shadow (rgb form of old `brand-dark`) alongside its `indigo-*` classes — replace with `color-mix(in_srgb,var(--color-brand-dark)_45%,transparent)`. `roles-settings.component.html` has an existing typo (`bg-indigo-500\15` — backslash instead of `/`) on its selected-row class, already inert; fix the separator to `/` while converting it to the brand token.

### Role-color swatch defaults
`permission-overrides-panel.component.html`'s `entry.color || '#6366f1'` fallbacks are handled above as a live token (`var(--color-brand)`). Separately, `roles-settings.component.ts` (2 signal defaults + 2 comparisons) and `roles-settings.component.html` (1 fallback + 1 placeholder) use `'#6366f1'` as a plain default-swatch literal — change these to `'#7c72ff'`.

## Out of scope
- No change to surface hex values for the Tailwind-token system (`app-bg`/`sidebar`/`card`/`hover`) — only the PrimeNG `zinc` scale steps are widened. If contrast still feels flat after this pass, that's a follow-up.
- No rework of component layout, spacing, or typography — colors/borders/shadows only.
- No change to light-mode support (app is dark-only; preset has no light `colorScheme` block).
- No ThemeService/appearance-settings UI changes.

## Verification
- `ng build` succeeds with no errors.
- Launch the app (`run` skill) and visually confirm: panels/menus/dialogs read as distinct layered surfaces; borders and focus rings are visibly crisp, not near-invisible; the accent purple is visually identical across buttons, dropdowns, mention pills, login screen, and titlebar (no mismatched indigo anywhere).
- Grep the repo for the old indigo hex/rgb values (`6366f1|4f46e5|818cf8|4338ca|99,\s?102,\s?241|129,\s?140,\s?248|67,\s?56,\s?202`) and for the Tailwind built-in utility classes (`indigo-(400|500|600|700)`) — zero remaining hits outside the intentional role-swatch-default literals (now `#7c72ff`).
