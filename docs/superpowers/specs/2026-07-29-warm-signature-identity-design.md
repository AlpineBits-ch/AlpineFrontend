# Warm Signature Identity: Brand Color, Icon Shape, Typography & Motion Tokens (Design)

## Context

A Discord design-system research pass (colors, typography, motion, IA, brand history) surfaced that Alpine's structure already mirrors Discord closely (server rail, channel list, member list, grouped messages, hover toolbar, reactions) but the token layer underneath has drifted from being a real system into ad hoc per-component choices, and the brand identity (violet accent, animated squircle-morph server icons) sits close enough to Discord's own visual grammar (Blurple hue family, rounded-square-to-circle icon morph) to read as a reskin rather than its own product.

Decided direction (from a browser-based brainstorming session comparing color/shape options live): **warm & organic**, expressed through depth and shape rather than the originally-considered "coral/rose" hue family, which the user ultimately moved away from in favor of a richer, more saturated blue-violet. Keep Inter Variable (no font swap — already bundled locally, no licensing/perf cost).

## Decisions

1. **Brand color → Royal Indigo-Blue.** Replaces the current lighter periwinkle-violet (`#7c72ff` family, close to Discord's Blurple) with a darker, more saturated blue-violet that has no purple/pink undertone:
   - `brand`: `#7c72ff` → `#4B5BC4`
   - `brandHover`: `#695df2` → `#3E4EAE`
   - `brandDim`: `#9a84ff` → `#7E8AE0`
   - `brandDark`: `#584ad9` → `#333F8C`

   No change to `online`/`connecting`/`offline` semantic colors — the new brand hue doesn't collide with any of them (unlike the rejected green/red warm candidates explored during brainstorming, which would have forced a semantic-color rework).

2. **Icon shape → uniform rounded-square, no morphing.** `ServerIconComponent` currently animates between `rounded-full` (idle) and `rounded-2xl` (active/hover) via `transition-[border-radius]` — an animated-corner-radius "squircle-morph" effect that was flagged directly as painful to maintain. Replace with **one static radius, always** — no hover/active shape change, no transition on `border-radius` at all. Avatars are unaffected and stay circular (already `shape="circle"` on `p-avatar` / `rounded-full` on the Ionic fallback) — this was already the one deliberate person-vs-space shape distinction in the app, kept as-is.

3. **Typography → weight-driven hierarchy, 4 fixed opacity levels.** `styles.css` already defines `--color-text-primary/secondary/muted` but most components bypass them with ad hoc `text-white/NN` utilities (message.component.html alone uses 8+ distinct values: `/85 /70 /60 /50 /45 /40 /35 /30 /25 /20`). Consolidate to exactly 4 levels, each paired with a font-weight role rather than a bespoke opacity guess per element:
   - primary `0.88` (weight 700 — names, headings, emphasis)
   - secondary `0.62` (weight 400 — body/message text)
   - muted `0.42` (weight 500 — timestamps, meta labels, secondary UI text)
   - faint `0.24` (weight 500 — dividers, placeholder hints)

   `--color-text-faint` currently exists at `0.06` but has zero usages in the codebase today (grepped — dead token), so redefining it to `0.24` for this new role is safe.

4. **Motion → two durations, one easing curve.** Currently ad hoc (`duration-200`, `duration-300`, bare `transition-colors`/`transition-all` on Tailwind's default ease, plus the doomed `transition-[border-radius]` from #2). Add as Tailwind v4 theme keys (so they become real utilities — `duration-fast`, `duration-base`, `ease-brand` — not just CSS vars needing arbitrary-value syntax):
   - `--duration-fast: 100ms` (immediate feedback: buttons, presses)
   - `--duration-base: 200ms` (everything else: hovers, panel/list transitions)
   - `--ease-brand: cubic-bezier(0.2, 0, 0, 1)` (the one easing curve used everywhere)

5. **Empty-state personality.** `EmptyStateComponent`'s `lg` variant (full-panel "nothing here" states — friends list, blocked list, etc.) currently renders a bare PrimeIcon at low opacity. Give it Alpine's own delight-moment, analogous to Discord's Wumpus: a small inline line-art **mountain-peak motif** SVG (accent-tinted, using `brandDim`), replacing the bare icon for `lg` only. `sm` (compact sidebar contexts) is unchanged — the personality moment is reserved for full-panel empty states, matching how sparingly Discord itself deploys Wumpus.

## Scope boundary on shape/radius

The radius fix is scoped **only** to the two files exhibiting the animated squircle-morph problem (`server-icon.component.html`, `server-taskbar.component.html`) — not a full-app radius audit. Cards, dialogs, message attachments, and other `rounded-lg`/`rounded-xl`/`rounded-2xl` usage elsewhere are unaffected; nothing there was reported as broken, so it's left alone.

## Changes

### `src/app/models/theme.model.ts`
Update `DEFAULT_THEME.colors` to the four new hex values listed in Decision 1.

### `src/styles.css`
- `@theme` block: update `--color-brand`, `--color-brand-hover`, `--color-brand-dim`, `--color-brand-dark` to match `theme.model.ts`; update the doc-comment example values in the same block (currently reference the old hex).
- Update `--color-text-primary` (`0.85→0.88`), `--color-text-secondary` (`0.60→0.62`), `--color-text-muted` (`0.40→0.42`), `--color-text-faint` (`0.06→0.24`).
- Add `--duration-fast: 100ms`, `--duration-base: 200ms`, `--ease-brand: cubic-bezier(0.2, 0, 0, 1)` to the `@theme` block.
- Add `--radius-icon: 12px` to the `@theme` block (new `rounded-icon` utility — used only by the two files below).

No `alpine-preset.ts` edit needed: its `accent` primitive already derives from `DEFAULT_THEME.colors.brand` via `palette()` (wired in the prior `2026-07-28-preset-contrast-and-brand-sync-design` pass), so the new brand color propagates through PrimeNG automatically.

### `src/index.html`
Preboot loading-spinner inline style (`border-top-color: #7c72ff`, line 28) → `#4B5BC4`. This renders before `styles.css`'s CSS custom properties are available, so it stays a plain literal, just updated to match.

### Role/accent-color swatch defaults (data defaults, not live theming — same category the prior brand-sync spec already handled for the old-indigo→violet transition)
- `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html:159` — `accentColorEdit() || '#7c72ff'` → `'#4B5BC4'`.
- `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts` — `editColor`/`createColor` signal defaults and the two `?? '#7c72ff'` comparisons → `'#4B5BC4'`.
- `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html` — the `role.color || '#7c72ff'` swatch fallback and the `placeholder="#7c72ff"` text input placeholder → `'#4B5BC4'`.

### `src/app/features/guild/components/server-icon/server-icon.component.html`
Replace:
```html
serverData().isActive ? 'rounded-2xl' : 'rounded-full hover:rounded-2xl'
```
and the `transition-[border-radius] duration-200 ease-out` on the button, with a single static `rounded-icon` class and no border-radius transition at all. The active-state left-pill indicator (rendered by the parent, `server-taskbar.component.html`) remains the only active/hover signal for server icons — shape no longer participates.

### `src/app/features/guild/components/server-taskbar/server-taskbar.component.html`
- Home/DMs button (line 9, currently `rounded-2xl`) → `rounded-icon`.
- Add-server dashed button (line 42, currently `rounded-2xl`) → `rounded-icon`.

### `src/app/components/empty-state/empty-state.component.ts`
`lg` branch: replace the bare `<i class="pi text-3xl text-white/25">` with the exact inline SVG motif validated in the brainstorming session:
```html
<svg width="120" height="64" viewBox="0 0 120 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 56 L28 22 L42 40 L58 12 L78 44 L92 26 L116 56"
        stroke="var(--color-brand-dim)" stroke-width="3"
        stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
  <circle cx="58" cy="12" r="3.5" fill="var(--color-brand-dim)" opacity="0.8"/>
</svg>
```
`sm` branch is unchanged. The `icon` input stays required (still used by `sm`) — `lg` simply stops rendering it in favor of the motif.

### Component text-hierarchy sweep
Replace ad hoc `text-white/NN` utilities with the four consolidated levels (Decision 3) plus their weight pairing, starting with the highest-traffic surfaces: `message.component.html` (8+ distinct values today), `home.component.html`, `dm-sidepanel.component.html`, `action-sidepanel.component.html`. The precise file-by-file mapping (which of the 8+ existing opacity values maps to which of the 4 new levels) is left to the implementation plan rather than enumerated here — the rule (4 levels, weight-paired) is fixed; the mechanical sweep is not.

## Out of scope

- No change to `online`/`connecting`/`offline` semantic colors, or to `success`/`warn`/`danger`/`info` in `alpine-preset.ts` — the chosen brand hue doesn't collide with any of them.
- No radius changes outside the two named files (see "Scope boundary" above) — cards, dialogs, attachments, message bubbles keep their current radii.
- No new illustration/character system beyond the single mountain-peak motif — no onboarding illustrations, no additional mascot states (Discord-style Wumpus variety is a much larger content investment, not attempted here).
- No light-mode work (app is dark-only).
- No `ThemeService`/appearance-settings UI changes — end users who customize their own accent color via settings are unaffected; this changes the shipped *default* only.

## Verification

- `ng build` succeeds with no errors.
- Grep the repo for the old brand hex (`7c72ff|695df2|9a84ff|584ad9`) — zero remaining hits (all six files listed above updated).
- Launch the app (`run` skill) and visually confirm: server rail icons no longer morph shape on hover/active (static rounded-square throughout), the accent color reads as the new indigo-blue everywhere (buttons, mentions, active states, login screen, titlebar — same propagation path already validated by the prior brand-sync spec), a full-panel empty state (e.g. empty friends list) shows the mountain-peak motif instead of a bare icon, and hover/press transitions feel like one consistent speed rather than a mix.
- Spot-check `message.component.html` after the text-hierarchy sweep: confirm usernames read clearly heavier than body text at a glance (weight, not just opacity, doing the work).
