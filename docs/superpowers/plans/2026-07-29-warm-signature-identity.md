# Warm Signature Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Alpine its own visual signature distinct from Discord - a darker/richer blue-violet brand color, a static (non-morphing) rounded-square icon shape, a weight-driven text hierarchy replacing ad hoc opacity values, a two-speed motion scale, and a mountain-peak empty-state motif - per `docs/superpowers/specs/2026-07-29-warm-signature-identity-design.md`.

**Architecture:** Token-layer change (same shape as the prior `2026-07-28-preset-contrast-and-brand-sync` plan): update the small set of source-of-truth values in `theme.model.ts` and `styles.css`'s `@theme` block, then apply the new tokens across the handful of components that currently hardcode the old values or bypass the token system entirely. `alpine-preset.ts`'s `accent` primitive already derives from `DEFAULT_THEME.colors.brand` via `palette()` (from the prior brand-sync pass), so it needs no edit - the new brand color propagates through PrimeNG automatically.

**Tech Stack:** Angular 21, PrimeNG 21 (`@primeuix/themes`), Tailwind CSS v4 (`@tailwindcss/postcss`), TypeScript.

## Global Constraints

- New brand colors (replacing `#7c72ff`/`#695df2`/`#9a84ff`/`#584ad9`): `brand: '#4B5BC4'`, `brandHover: '#3E4EAE'`, `brandDim: '#7E8AE0'`, `brandDark: '#333F8C'`. Defined once in `src/app/models/theme.model.ts` `DEFAULT_THEME.colors`; every other file references these via CSS var (`var(--color-brand...)`), never a literal, **except** the two documented "default swatch, not live theme" cases (role-color / accent-color pickers) which stay plain hex literals by design (same category the prior brand-sync plan established).
- No change to `online`/`connecting`/`offline` semantic colors, or to `success`/`warn`/`danger`/`info` in `alpine-preset.ts`.
- No change to light-mode support (app is dark-only).
- No `ThemeService`/appearance-settings UI changes.
- This is a pure token/template change set - no new business logic, so verification is `ng build` + `grep` (confirming no old literals remain) + a manual visual check, not new unit tests, matching how the prior `2026-07-28-preset-contrast-and-brand-sync` plan verified equivalent token-only changes.
- `ng build` must succeed after every task.

---

### Task 1: Brand color swap - source of truth + default-swatch literals

**Files:**
- Modify: `src/app/models/theme.model.ts:37-40`
- Modify: `src/styles.css` (doc comment `:124-126`, `@theme` block `:187-192`)
- Modify: `src/index.html:27-29`
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html:159`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts:42,49,139,159`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html:20,99`

**Interfaces:**
- Produces: `var(--color-brand)` = `#4B5BC4`, `var(--color-brand-hover)` = `#3E4EAE`, `var(--color-brand-dim)` = `#7E8AE0`, `var(--color-brand-dark)` = `#333F8C` - consumed by every later task in this plan, and (via `alpine-preset.ts`'s existing `palette(DEFAULT_THEME.colors.brand)` call) by all PrimeNG components without further edits.

- [ ] **Step 1: `theme.model.ts` - update `DEFAULT_THEME.colors`**

Replace:

```ts
        brand: '#7c72ff',
        brandHover: '#695df2',
        brandDim: '#9a84ff',
        brandDark: '#584ad9',
```

with:

```ts
        brand: '#4B5BC4',
        brandHover: '#3E4EAE',
        brandDim: '#7E8AE0',
        brandDark: '#333F8C',
```

- [ ] **Step 2: `styles.css` - sync the `@theme` brand tokens**

Replace:

```css
  --color-brand:       #7c72ff;
  --color-brand-hover: #695df2;
  --color-brand-dim:   #9a84ff;
  --color-brand-dark:  #584ad9;
```

with:

```css
  --color-brand:       #4B5BC4;
  --color-brand-hover: #3E4EAE;
  --color-brand-dim:   #7E8AE0;
  --color-brand-dark:  #333F8C;
```

- [ ] **Step 3: `styles.css` - fix the doc-comment example values**

Replace:

```css
 *   bg-brand           → #7c72ff  (brand purple)
 *   text-brand-dim     → #9a84ff  (brand dim)
 *   bg-brand/15        → brand purple at 15% opacity (active tab bg)
```

with:

```css
 *   bg-brand           → #4B5BC4  (brand indigo-blue)
 *   text-brand-dim     → #7E8AE0  (brand dim)
 *   bg-brand/15        → brand indigo-blue at 15% opacity (active tab bg)
```

- [ ] **Step 4: `index.html` - preboot spinner ring color**

Replace:

```css
        border: 2.5px solid rgba(124, 114, 255, 0.18);
        border-top-color: #7c72ff;
        border-right-color: rgba(124, 114, 255, 0.55);
```

with:

```css
        border: 2.5px solid rgba(75, 91, 196, 0.18);
        border-top-color: #4B5BC4;
        border-right-color: rgba(75, 91, 196, 0.55);
```

(This renders before `styles.css`'s custom properties are available, so it stays a plain literal - `rgba(75, 91, 196, X)` is `#4B5BC4` in decimal RGB.)

- [ ] **Step 5: `profile-settings.component.html` - accent-color-picker default**

Replace:

```html
                           [value]="accentColorEdit() || '#7c72ff'"
```

with:

```html
                           [value]="accentColorEdit() || '#4B5BC4'"
```

- [ ] **Step 6: `roles-settings.component.ts` - role-color signal defaults (4 occurrences)**

Replace:

```ts
    editColor = signal('#7c72ff');
```

with:

```ts
    editColor = signal('#4B5BC4');
```

Replace:

```ts
    createColor = signal('#7c72ff');
```

with:

```ts
    createColor = signal('#4B5BC4');
```

Replace:

```ts
        this.editColor.set(role.color ?? '#7c72ff');
```

with:

```ts
        this.editColor.set(role.color ?? '#4B5BC4');
```

Replace:

```ts
            this.editColor() !== (r.color ?? '#7c72ff') ||
```

with:

```ts
            this.editColor() !== (r.color ?? '#4B5BC4') ||
```

- [ ] **Step 7: `roles-settings.component.html` - swatch fallback + placeholder**

Replace:

```html
          <span [style.background]="role.color || '#7c72ff'"
```

with:

```html
          <span [style.background]="role.color || '#4B5BC4'"
```

Replace:

```html
                                       placeholder="#7c72ff"/>
```

with:

```html
                                       placeholder="#4B5BC4"/>
```

- [ ] **Step 8: Verify no old brand literals remain**

Run: `grep -rnE '7c72ff|695df2|9a84ff|584ad9|124, ?114, ?255' src`
Expected: no output.

- [ ] **Step 9: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 10: Commit**

```bash
git add src/app/models/theme.model.ts src/styles.css src/index.html src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html
git commit -m "feat: switch brand accent to Royal Indigo-Blue"
```

---

### Task 2: New tokens - text hierarchy, motion scale, icon radius

**Files:**
- Modify: `src/styles.css:199-209`

**Interfaces:**
- Consumes: nothing new.
- Produces: `var(--color-text-primary)` = `0.88`, `var(--color-text-secondary)` = `0.62`, `var(--color-text-muted)` = `0.42`, `var(--color-text-faint)` = `0.24`; Tailwind utilities `duration-fast` (100ms), `duration-base` (200ms), `ease-brand` (`cubic-bezier(0.2,0,0,1)`); Tailwind utility `rounded-icon` (12px) - all consumed by Tasks 3, 5, and 6.

- [ ] **Step 1: Update the 4 text-opacity levels**

Replace:

```css
  --color-text-primary:   rgba(255 255 255 / 0.85);
  --color-text-secondary: rgba(255 255 255 / 0.60);
  --color-text-muted:     rgba(255 255 255 / 0.40);
  --color-text-faint:     rgba(255 255 255 / 0.06);
```

with:

```css
  --color-text-primary:   rgba(255 255 255 / 0.88);
  --color-text-secondary: rgba(255 255 255 / 0.62);
  --color-text-muted:     rgba(255 255 255 / 0.42);
  --color-text-faint:     rgba(255 255 255 / 0.24);
```

(`--color-text-faint` had zero usages in the codebase before this change - confirmed by grepping `text-faint|color-text-faint` across `src` - so redefining its value from `0.06` to `0.24` is safe. Its role also changes from an unused "barely-there wash" to the fourth rung of the text hierarchy: dividers and placeholder hints.)

- [ ] **Step 2: Add motion and icon-radius tokens after the border tokens**

Replace:

```css
  /* ── Borders ────────────────────────────────────────────── */
  --color-border-subtle:  rgba(255 255 255 / 0.10);
  --color-border-default: rgba(255 255 255 / 0.16);
}
```

with:

```css
  /* ── Borders ────────────────────────────────────────────── */
  --color-border-subtle:  rgba(255 255 255 / 0.10);
  --color-border-default: rgba(255 255 255 / 0.16);

  /* ── Motion - exactly two speeds, one curve, used everywhere ── */
  --duration-fast: 100ms;  /* immediate feedback: buttons, presses */
  --duration-base: 200ms;  /* everything else: hovers, panel/list transitions */
  --ease-brand: cubic-bezier(0.2, 0, 0, 1);

  /* ── Icon/tile shape - uniform rounded-square, no morphing ──── */
  --radius-icon: 12px;
}
```

- [ ] **Step 3: Verify build**

Run: `ng build`
Expected: succeeds with no errors. (Tailwind v4 turns `--duration-fast`/`--duration-base`/`--ease-brand`/`--radius-icon` theme keys into the `duration-fast`, `duration-base`, `ease-brand`, `rounded-icon` utilities used by later tasks - no other wiring needed.)

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat: add text-hierarchy, motion, and icon-radius design tokens"
```

---

### Task 3: Remove the animated icon-shape morph

**Files:**
- Modify: `src/app/features/guild/components/server-icon/server-icon.component.html`
- Modify: `src/app/features/guild/components/server-taskbar/server-taskbar.component.html:9,42`

**Interfaces:**
- Consumes: `rounded-icon` utility (from Task 2).

`ServerIconComponent` currently animates its own `border-radius` between `rounded-full` (idle) and `rounded-2xl` (active/hover) via `transition-[border-radius] duration-200 ease-out` - this is the exact "nightmare" flagged during design review. Replace with one static shape, no transition.

- [ ] **Step 1: `server-icon.component.html` - static shape, no morph**

Replace:

```html
    <button
            [ngClass]="[
              serverData().isActive ? 'rounded-2xl' : 'rounded-full hover:rounded-2xl',
              (!serverData().icon || imgFailed())
                ? fallbackColorClass()
                : 'bg-white/[0.07] text-white/60'
            ]"
            class="w-11 h-11 flex items-center justify-center transition-[border-radius] duration-200 ease-out border-0 cursor-pointer text-sm font-bold overflow-hidden">
```

with:

```html
    <button
            [ngClass]="[
              'rounded-icon',
              (!serverData().icon || imgFailed())
                ? fallbackColorClass()
                : 'bg-white/[0.07] text-white/60'
            ]"
            class="w-11 h-11 flex items-center justify-center border-0 cursor-pointer text-sm font-bold overflow-hidden">
```

(`serverData().isActive` is still used elsewhere by the parent - `server-taskbar.component.html`'s left-pill indicator - so the input itself is untouched; only this template's shape logic drops it.)

- [ ] **Step 2: `server-taskbar.component.html` - home button**

Replace:

```html
            class="w-11 h-11 flex items-center justify-center transition-colors cursor-pointer border-0 shrink-0 rounded-2xl"
```

with:

```html
            class="w-11 h-11 flex items-center justify-center transition-colors cursor-pointer border-0 shrink-0 rounded-icon"
```

- [ ] **Step 3: `server-taskbar.component.html` - add-server button**

Replace:

```html
            class="w-11 h-11 rounded-2xl border border-dashed border-white/20 text-white/30 hover:text-brand-dim hover:border-brand-dim hover:bg-brand/10 flex items-center justify-center transition-colors text-xl leading-none cursor-pointer bg-transparent shrink-0">
```

with:

```html
            class="w-11 h-11 rounded-icon border border-dashed border-white/20 text-white/30 hover:text-brand-dim hover:border-brand-dim hover:bg-brand/10 flex items-center justify-center transition-colors text-xl leading-none cursor-pointer bg-transparent shrink-0">
```

- [ ] **Step 4: Verify no shape-morph classes remain on these files**

Run: `grep -nE 'rounded-2xl|rounded-full hover:rounded-2xl|transition-\[border-radius\]' src/app/features/guild/components/server-icon/server-icon.component.html src/app/features/guild/components/server-taskbar/server-taskbar.component.html`
Expected: no output.

- [ ] **Step 5: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 6: Manual check**

Launch the app (`run` skill) and hover/click between server icons in the rail: confirm the icon shape stays a static rounded square at all times (idle, hover, active) - no shape animation - and the left-pill indicator is the only active-state signal.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/server-icon/server-icon.component.html src/app/features/guild/components/server-taskbar/server-taskbar.component.html
git commit -m "fix: replace animated squircle-morph server icons with a static rounded-square shape"
```

---

### Task 4: Empty-state mountain-peak motif

**Files:**
- Modify: `src/app/components/empty-state/empty-state.component.ts`

**Interfaces:**
- Consumes: `var(--color-brand-dim)` (from Task 1).

- [ ] **Step 1: Replace the `lg`-size bare icon with the mountain-peak SVG**

Replace:

```ts
    template: `
    <div class="flex flex-col items-center justify-center gap-2 text-center px-3" [class]="containerClass()">
      @if (size() === 'sm') {
        <div class="w-8 h-8 rounded-full bg-white/[0.04] flex items-center justify-center">
          <i class="pi text-white/20 text-sm" [class]="icon()"></i>
        </div>
      } @else {
        <i class="pi text-3xl text-white/25" [class]="icon()"></i>
      }
      <p [class]="size() === 'sm' ? 'text-[11px] text-white/25' : 'text-sm text-white/25'" class="leading-snug">
        {{ message() }}
      </p>
    </div>
  `,
```

with:

```ts
    template: `
    <div class="flex flex-col items-center justify-center gap-2 text-center px-3" [class]="containerClass()">
      @if (size() === 'sm') {
        <div class="w-8 h-8 rounded-full bg-white/[0.04] flex items-center justify-center">
          <i class="pi text-white/20 text-sm" [class]="icon()"></i>
        </div>
      } @else {
        <svg width="120" height="64" viewBox="0 0 120 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 56 L28 22 L42 40 L58 12 L78 44 L92 26 L116 56"
                stroke="var(--color-brand-dim)" stroke-width="3"
                stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
          <circle cx="58" cy="12" r="3.5" fill="var(--color-brand-dim)" opacity="0.8"/>
        </svg>
      }
      <p [class]="size() === 'sm' ? 'text-[11px] text-white/25' : 'text-sm text-white/25'" class="leading-snug">
        {{ message() }}
      </p>
    </div>
  `,
```

(The `icon` input stays `input.required<string>()` - still consumed by the `sm` branch, unchanged.)

- [ ] **Step 2: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 3: Manual check**

Launch the app (`run` skill), navigate to a full-panel empty state (e.g. Home → Friends tab with zero friends, or the Blocked tab with nothing blocked) and confirm the mountain-peak motif renders in place of the old bare icon, tinted with the new brand-dim color. Confirm the `sm` (compact) empty-state contexts - e.g. an empty activity feed or DM list - are unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/empty-state/empty-state.component.ts
git commit -m "feat: replace bare icon with mountain-peak motif in full-panel empty states"
```

---

### Task 5: Text-hierarchy sweep - `message.component.html`

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`

**Interfaces:**
- Consumes: `var(--color-text-primary/secondary/muted/faint)` (from Task 2).

This file has the highest count of ad hoc opacity values in the app (8+ distinct `text-white/NN` values with no consistent rule). Map each to one of the 4 fixed levels, pairing weight with role per the design spec. **Not touched:** `isPending`/`isFailed` status colors (`text-white/40`, `text-rose-300`, `text-rose-400`) - these are transient state indicators, not part of the readable-text hierarchy, and are left exactly as they are.

- [ ] **Step 1: Grouped-row hover timestamp (muted)**

Replace:

```html
        <div class="shrink-0 w-8 flex items-start justify-center mt-0.5">
            <span class="hidden group-hover:block text-[10px] text-white/25 select-none">{{ message().createdAt | date: 'shortTime' }}</span>
        </div>
```

with:

```html
        <div class="shrink-0 w-8 flex items-start justify-center mt-0.5">
            <span class="hidden group-hover:block text-[10px] font-medium text-[var(--color-text-muted)] select-none">{{ message().createdAt | date: 'shortTime' }}</span>
        </div>
```

- [ ] **Step 2: Reply-reference author name and snippet (muted → secondary on hover; faint → muted on hover)**

Replace:

```html
                @if (replyMessage()) {
                    <span [appUserNameStyle]="replyAuthorProfile()" class="text-[11px] font-semibold text-white/45 shrink-0
                       group-hover/reply:text-white/65 transition-colors">
            {{ replyAuthorName() }}
          </span>
                    <span class="text-[11px] text-white/25 truncate
                       group-hover/reply:text-white/40 transition-colors">
            {{ replySnippet() || '(attachment)' }}
          </span>
                } @else {
```

with:

```html
                @if (replyMessage()) {
                    <span [appUserNameStyle]="replyAuthorProfile()" class="text-[11px] font-medium text-[var(--color-text-muted)] shrink-0
                       group-hover/reply:text-[var(--color-text-secondary)] transition-colors">
            {{ replyAuthorName() }}
          </span>
                    <span class="text-[11px] text-[var(--color-text-faint)] truncate
                       group-hover/reply:text-[var(--color-text-muted)] transition-colors">
            {{ replySnippet() || '(attachment)' }}
          </span>
                } @else {
```

- [ ] **Step 3: Username - bot and non-bot branches (primary, weight 700)**

Replace:

```html
                    @if (botName(message().authorId); as bName) {
                        <span (click)="profileDialogSvc.open(message().authorId)"
                              class="text-sm font-semibold text-white/85 cursor-pointer hover:text-white transition-colors">
              {{ bName }}
            </span>
                        <span class="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1 py-[1px] rounded bg-brand/20 text-brand-dim">Bot</span>
                    } @else {
                        @let user = (getProfile() | async);
                        <span (click)="profileDialogSvc.open(message().authorId)"
                              [appUserNameStyle]="user"
                              class="text-sm font-semibold text-white/85 cursor-pointer hover:text-white transition-colors">
              {{ user ? user.userName : message().authorId }}
            </span>
                    }
                    <span class="text-[11px] text-white/25">{{ message().createdAt | date: 'shortTime' }}</span>
```

with:

```html
                    @if (botName(message().authorId); as bName) {
                        <span (click)="profileDialogSvc.open(message().authorId)"
                              class="text-sm font-bold text-[var(--color-text-primary)] cursor-pointer hover:text-white transition-colors">
              {{ bName }}
            </span>
                        <span class="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1 py-[1px] rounded bg-brand/20 text-brand-dim">Bot</span>
                    } @else {
                        @let user = (getProfile() | async);
                        <span (click)="profileDialogSvc.open(message().authorId)"
                              [appUserNameStyle]="user"
                              class="text-sm font-bold text-[var(--color-text-primary)] cursor-pointer hover:text-white transition-colors">
              {{ user ? user.userName : message().authorId }}
            </span>
                    }
                    <span class="text-[11px] font-medium text-[var(--color-text-muted)]">{{ message().createdAt | date: 'shortTime' }}</span>
```

- [ ] **Step 4: Message body text (secondary) - `isPending`/`isFailed` states untouched**

Replace:

```html
            <div (click)="onLinkClick($event)"
                 [ngClass]="message().isFailed ? 'text-rose-300' : message().isPending ? 'text-white/40' : 'text-white/70'"
                 class="text-[15px] leading-relaxed m-0 break-words">
```

with:

```html
            <div (click)="onLinkClick($event)"
                 [ngClass]="message().isFailed ? 'text-rose-300' : message().isPending ? 'text-white/40' : 'text-[var(--color-text-secondary)]'"
                 class="text-[15px] leading-relaxed m-0 break-words">
```

- [ ] **Step 5: "Edited" label (faint)**

Replace:

```html
        @if (!message().isPending && !message().isFailed && message().updatedAt > message().createdAt) {
            <span class="text-[10px] italic text-white/25 mt-0.5">Edited</span>
        }
```

with:

```html
        @if (!message().isPending && !message().isFailed && message().updatedAt > message().createdAt) {
            <span class="text-[10px] italic text-[var(--color-text-faint)] mt-0.5">Edited</span>
        }
```

- [ ] **Step 6: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 7: Manual check**

Launch the app (`run` skill), open a channel or DM with several messages including at least one grouped (consecutive same-author) message and one reply. Confirm: usernames read visibly heavier/brighter than body text (weight doing the work, not just opacity), timestamps and the reply-reference label are legible but clearly secondary, and hovering a reply reference brightens both its author name and snippet.

- [ ] **Step 8: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/message.component.html
git commit -m "refactor: apply weight-driven text hierarchy to message.component.html"
```

---

### Task 6: Text-hierarchy sweep - `home.component.html` and `dm-sidepanel.component.html`

**Files:**
- Modify: `src/app/features/main-page/pages/home/home.component.html`
- Modify: `src/app/features/main-page/components/dm-sidepanel/dm-sidepanel.component.html`

**Interfaces:**
- Consumes: `var(--color-text-primary/secondary/muted/faint)` (from Task 2).

`action-sidepanel.component.html` was checked and contains no text-hierarchy classes (it only switches between `dm-sidepanel` and `channel-list`) - not part of this sweep. Dynamic status-color text (`statusTextClass()`, online/offline dots) and the deliberately-dimmed "blocked user" row styling are left untouched - they're semantic-state colors, not part of the plain-text hierarchy.

- [ ] **Step 1: `home.component.html` - page title (primary)**

Replace:

```html
                    <i class="pi pi-users text-white/50 text-sm"></i>
                    <h1 class="text-[15px] font-semibold text-white/85">{{ 'HOME.TITLE' | translate }}</h1>
```

with:

```html
                    <i class="pi pi-users text-white/50 text-sm"></i>
                    <h1 class="text-[15px] font-bold text-[var(--color-text-primary)]">{{ 'HOME.TITLE' | translate }}</h1>
```

- [ ] **Step 2: `home.component.html` - add-friend hint text (muted) and panel title (primary)**

Replace:

```html
                    <p class="text-sm font-semibold text-white/80 mb-1">{{ 'HOME.ADD_FRIEND_PANEL.TITLE' | translate }}</p>
                    <p class="text-xs text-white/35">{{ 'HOME.ADD_FRIEND_PANEL.HINT' | translate }} <span
                            class="text-brand-dim/70">sarah</span></p>
```

with:

```html
                    <p class="text-sm font-bold text-[var(--color-text-primary)] mb-1">{{ 'HOME.ADD_FRIEND_PANEL.TITLE' | translate }}</p>
                    <p class="text-xs text-[var(--color-text-muted)]">{{ 'HOME.ADD_FRIEND_PANEL.HINT' | translate }} <span
                            class="text-brand-dim/70">sarah</span></p>
```

- [ ] **Step 3: `home.component.html` - friends-list section count label (muted)**

Replace:

```html
                    <p class="text-[11px] font-semibold text-white/25 uppercase tracking-widest mb-2">
                        {{ 'HOME.FRIENDS_COUNT' | translate:{count: list.length} }}
                    </p>
```

with:

```html
                    <p class="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-widest mb-2">
                        {{ 'HOME.FRIENDS_COUNT' | translate:{count: list.length} }}
                    </p>
```

- [ ] **Step 4: `home.component.html` - friend row name (primary)**

Replace:

```html
                            <div class="flex-1 min-w-0">
                                <p class="text-sm font-semibold text-white/80">{{ rel.target.userName }}</p>
                                <p [ngClass]="statusTextClass(getOnlineStatus(rel.target.userId))"
```

with:

```html
                            <div class="flex-1 min-w-0">
                                <p class="text-sm font-bold text-[var(--color-text-primary)]">{{ rel.target.userName }}</p>
                                <p [ngClass]="statusTextClass(getOnlineStatus(rel.target.userId))"
```

- [ ] **Step 5: `home.component.html` - incoming/outgoing section labels (muted, 2 occurrences)**

Replace:

```html
                    <p class="text-[11px] font-semibold text-white/25 uppercase tracking-widest">
                        {{ 'HOME.INCOMING_COUNT' | translate:{count: incoming().length} }}
                    </p>
```

with:

```html
                    <p class="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-widest">
                        {{ 'HOME.INCOMING_COUNT' | translate:{count: incoming().length} }}
                    </p>
```

Replace:

```html
                    <p class="text-[11px] font-semibold text-white/25 uppercase tracking-widest">
                        {{ 'HOME.OUTGOING_COUNT' | translate:{count: outgoing().length} }}
                    </p>
```

with:

```html
                    <p class="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-widest">
                        {{ 'HOME.OUTGOING_COUNT' | translate:{count: outgoing().length} }}
                    </p>
```

- [ ] **Step 6: `home.component.html` - incoming/outgoing row names (primary, 2 occurrences)**

Replace:

```html
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-semibold text-white/80">{{ rel.target.userName }}</p>
                                    <p class="text-xs text-white/35">{{ 'HOME.INCOMING_REQUEST' | translate }}</p>
                                </div>
```

with:

```html
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-bold text-[var(--color-text-primary)]">{{ rel.target.userName }}</p>
                                    <p class="text-xs text-[var(--color-text-muted)]">{{ 'HOME.INCOMING_REQUEST' | translate }}</p>
                                </div>
```

Replace:

```html
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-semibold text-white/80">{{ rel.target.userName }}</p>
                                    <p class="text-xs text-white/35">{{ 'HOME.OUTGOING_SENT' | translate }}</p>
                                </div>
```

with:

```html
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm font-bold text-[var(--color-text-primary)]">{{ rel.target.userName }}</p>
                                    <p class="text-xs text-[var(--color-text-muted)]">{{ 'HOME.OUTGOING_SENT' | translate }}</p>
                                </div>
```

- [ ] **Step 7: `home.component.html` - blocked-tab count label (muted)**

Replace:

```html
                <p class="text-[11px] font-semibold text-white/25 uppercase tracking-widest mb-2">
                    {{ 'HOME.BLOCKED_COUNT' | translate:{count: blocked().length} }}
                </p>
```

with:

```html
                <p class="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-widest mb-2">
                    {{ 'HOME.BLOCKED_COUNT' | translate:{count: blocked().length} }}
                </p>
```

(The blocked-row name itself, `text-white/50` on line ~212, is left unchanged - it's the deliberately-dimmed "this user is blocked" state, not part of the general hierarchy.)

- [ ] **Step 8: `dm-sidepanel.component.html` - "Direct Messages" section label (muted)**

Replace:

```html
        <span class="text-[10.5px] font-semibold text-white/35 uppercase tracking-widest">{{ 'SIDEBAR.DIRECT_MESSAGES' | translate }}</span>
```

with:

```html
        <span class="text-[10.5px] font-medium text-[var(--color-text-muted)] uppercase tracking-widest">{{ 'SIDEBAR.DIRECT_MESSAGES' | translate }}</span>
```

- [ ] **Step 9: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 10: Manual check**

Launch the app (`run` skill), open Home → Friends (online/all/pending/blocked tabs) and the DM sidebar. Confirm names read clearly bolder/brighter than section labels and hint text, and the blocked-user row still looks visibly "dimmed/inactive" (unaffected by this sweep).

- [ ] **Step 11: Commit**

```bash
git add src/app/features/main-page/pages/home/home.component.html src/app/features/main-page/components/dm-sidepanel/dm-sidepanel.component.html
git commit -m "refactor: apply weight-driven text hierarchy to home and DM sidebar"
```

---

### Task 7: Motion sweep - apply `duration-fast`/`duration-base`/`ease-brand` to known ad hoc transitions

**Files:**
- Modify: `src/app/features/guild/components/server-taskbar/server-taskbar.component.html`
- Modify: `src/app/features/main-page/main-page.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`

**Interfaces:**
- Consumes: `duration-fast`, `duration-base`, `ease-brand` Tailwind utilities (from Task 2).

These are the three ad hoc `duration-200`/`duration-300` instances identified during design research (Task 3 already removed a fourth - the icon-shape morph transition). This is not an exhaustive app-wide transition sweep, just the specific mixed-duration spots called out in the design spec.

- [ ] **Step 1: `server-taskbar.component.html` - active-server pill indicator**

Replace:

```html
                        [style.opacity]="isPillVisible(server) ? '1' : '0'"
                        class="absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-white transition-[height,opacity] duration-200 ease-out pointer-events-none">
```

with:

```html
                        [style.opacity]="isPillVisible(server) ? '1' : '0'"
                        class="absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-white transition-[height,opacity] duration-base ease-brand pointer-events-none">
```

- [ ] **Step 2: `main-page.component.html` - mobile nav drawer slide**

Replace:

```html
         class="fixed top-0 bottom-0 left-0 z-50 flex flex-col transition-transform duration-200
              lg:relative lg:top-auto lg:bottom-auto lg:z-auto lg:![translate:none]">
```

with:

```html
         class="fixed top-0 bottom-0 left-0 z-50 flex flex-col transition-transform duration-base ease-brand
              lg:relative lg:top-auto lg:bottom-auto lg:z-auto lg:![translate:none]">
```

- [ ] **Step 3: `message.component.html` - row hover/pending transition**

Replace:

```html
     class="relative flex items-start gap-3 px-4 hover:bg-white/[0.02] rounded-lg transition-colors transition-opacity duration-300 group">
```

with:

```html
     class="relative flex items-start gap-3 px-4 hover:bg-white/[0.02] rounded-lg transition-colors transition-opacity duration-base ease-brand group">
```

- [ ] **Step 4: Verify no ad hoc durations remain in these three files**

Run: `grep -nE 'duration-(200|300)|ease-out' src/app/features/guild/components/server-taskbar/server-taskbar.component.html src/app/features/main-page/main-page.component.html src/app/features/messaging/components/conversation/message/message.component.html`
Expected: no output.

- [ ] **Step 5: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 6: Manual check**

Launch the app (`run` skill): hover over server icons (pill indicator grows/shrinks), resize the window below the `lg` breakpoint and toggle the mobile nav drawer, and hover a message row - confirm all three still animate smoothly, just on the shared 200ms/`ease-brand` curve instead of their previous individually-chosen values.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/server-taskbar/server-taskbar.component.html src/app/features/main-page/main-page.component.html src/app/features/messaging/components/conversation/message/message.component.html
git commit -m "refactor: apply the shared duration-base/ease-brand motion tokens to known ad hoc transitions"
```

---

### Task 8: Fix channel-name font-size mismatch between text and voice channels

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.html:14`
- Modify: `src/app/features/guild/components/channel-list/components/voice-channel-item/voice-channel-item.component.html:17`

**Interfaces:**
- Consumes: nothing new.

Found during manual review (not in the original design spec): in the same channel list, text-channel rows render their name at `text-[0.8rem]` (~12.8px) while voice-channel rows render theirs at a fixed `text-[15px]` - two different sizes for what should be one visual rhythm. First attempt unified both at `0.9375rem` (the 15px voice-channel size promoted to rem) - user feedback after seeing it live: too large, "just FAT". Corrected direction: unify both at the smaller `0.8rem` instead (the pre-existing text-channel size), which also fixes the voice-channel side's raw-pixel-value violation of the project's rem-based font-size convention (`text-[0.625rem]` not `text-[10px]`) without changing the size anyone was already used to.

- [ ] **Step 1: `text-channel-item.component.html` - already at the target size, no change needed**

`text-channel-item.component.html:14` already reads `text-[0.8rem] font-medium truncate flex-1 pointer-events-none` - this is the target value, so this file needs no edit for this task. (Confirm it hasn't drifted from this value before moving on.)

- [ ] **Step 2: `voice-channel-item.component.html` - convert the fixed-px size down to match, in rem**

Replace:

```html
        <span class="text-[15px] font-medium truncate">{{ channel().name }}</span>
```

with:

```html
        <span class="text-[0.8rem] font-medium truncate">{{ channel().name }}</span>
```

- [ ] **Step 3: Verify build**

Run: `ng build`
Expected: succeeds with no errors.

- [ ] **Step 4: Manual check**

Launch the app (`run` skill), open a guild with both text and voice channels in the same category. Confirm channel names are now visually the same size across both types, and match the "Wiki" quick-link entry above the list.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.html src/app/features/guild/components/channel-list/components/voice-channel-item/voice-channel-item.component.html
git commit -m "fix: unify text/voice channel name font size in the channel list"
```
