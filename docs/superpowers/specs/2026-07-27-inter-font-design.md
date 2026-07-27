# Bundle Inter Font Locally (Design)

## Context
Alpine currently sets no `font-family` anywhere (no `@font-face`, no Google Fonts link, no Tailwind font token, no PrimeNG preset font override) — the app renders with the browser/OS default sans-serif. Alpine is a Tauri desktop app, so bundling the font locally (vs. a Google Fonts CDN `<link>`) avoids an unnecessary network dependency and matches how other static assets are already handled.

## Approach
Use `@fontsource/inter-variable`, installed via `bun`. It ships one variable woff2 (weight axis 100–900, normal + italic) and a CSS file with relative `@font-face` `url()` references — the same shape as `primeicons.css`, which is already wired into `angular.json`'s `styles` array.

## Changes
1. **Install**: `bun add @fontsource/inter-variable`.
2. **`angular.json`**: add `"node_modules/@fontsource/inter-variable/index.css"` to the `styles` array (after `primeicons.css`). Angular's build resolves the package's relative woff2 `url()`s and copies them automatically — no manual asset globbing needed.
3. **`src/styles.css`**:
   - Add `font-family: 'Inter Variable', 'Inter', system-ui, sans-serif;` to the existing `html { font-size: var(--base-font-size, 16px); }` rule.
   - Add `--font-sans: 'Inter Variable', 'Inter', system-ui, sans-serif;` to the `@theme` block, so Tailwind's `font-sans` utility also resolves to Inter for any future usage.
4. **No PrimeNG preset changes**: `alpine-preset.ts` has no existing font token; components inherit `font-family` via the CSS cascade from `body`/`html`, so no edits needed there.

## Out of scope
- No static-weight fallback files (variable font covers the full weight range already used in the app, e.g. `font-weight: 600` in `.wiki-content strong`).
- No change to `--base-font-size` or any existing font-size tokens.

## Verification
- `bun install` succeeds, `ng build` / `ng serve` succeed with no missing-asset errors.
- Inspect a running instance: computed `font-family` on `body` resolves to Inter Variable; text renders visibly with Inter's letterforms (visible check on numerals `0`/`O`, single-story `a`/`g`).
