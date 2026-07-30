# Household Modules Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared layer every household module needs - five new channel types, eleven new permissions, module-aware gating, and an allowlist router that can never render a shopping list as a message view.

**Architecture:** A single metadata table (`channel-types.ts`) becomes the source of truth for what a channel type is, which module gates it, and how it should be drawn. Channel-view resolution moves out of the `main-page` template into a pure function so the "unknown type is never a message view" guarantee is unit-tested. Permissions gain a `feature` tag so editors hide whole groups in guilds whose module is off, rather than showing them disabled.

**Tech Stack:** Angular 21 (signals, standalone components, `@if`/`@for` control flow), PrimeNG 21, Tailwind v4, TypeScript 5.9, Vitest 4, ngx-translate 17.

## Global Constraints

- **Design doc:** `docs/superpowers/specs/2026-07-30-household-modules-foundation-design.md`. Read it before starting.
- **Backend guide:** the `Household modules - frontend integration guide` in the originating conversation. §10 ("What will bite you otherwise") is the acceptance criteria for this plan.
- **This foundation makes no HTTP calls.** No services, stores, DTOs or WebSocket subjects for any module. Those belong to the eight per-module plans that follow.
- **A module being off makes its UI absent, not disabled.** Existing precedent: `channel.component.ts:98`.
- **Permission wire format is comma-separated names**, never a bitmask. Bit positions are client-internal.
- **Tests:** Vitest, driven by the Angular builder. `.spec.ts` for pure helpers and enums only - no component-template tests.
  - **Single pure-helper file** (no Angular imports): `npx vitest run <path>` is fine and fast.
  - **The full suite:** `./node_modules/.bin/ng test --watch=false`. Baseline is **57 files / 679 tests, all passing** - any failure is yours.
  - **Never** run bare `npx vitest run` with no path. It bypasses the Angular builder's setup, so every component spec fails to import and it reports ~50 spurious file failures. That number is an artifact of the wrong command, not a broken suite.
  - `npx ng ...` does not resolve in this repo; use `./node_modules/.bin/ng`.
- **i18n:** `src/assets/i18n/locales` is a **git submodule**. Keys are flat and dot-separated. All three of `en.json`, `de.json`, `fr.json` are maintained in parallel. Submodule changes need their own commit *inside* the submodule, then the parent repo's pointer bump.
- **Tailwind tokens:** use `bg-card`, `border-border`, `text-text-muted` etc. - never raw hex. Font sizes in rem (`text-[0.8125rem]`), never px.
- **Angular style:** `input.required<T>()` / `output<T>()` / `computed()`, `protected` members when template-only, `private` for injected services.

---

### Task 1: Channel type metadata and view resolution

**Files:**
- Modify: `src/app/dtos/response/guild.dto.ts:3-11`
- Create: `src/app/features/guild/channel-types.ts`
- Test: `src/app/features/guild/channel-types.spec.ts`

**Interfaces:**
- Consumes: `ChannelType`, `isForumLike` from `dtos/response/guild.dto`; `GuildFeature` from `features/guild/guild-features`.
- Produces:
  - `type ChannelView = 'voice' | 'forum' | 'message' | 'unsupported'`
  - `interface ChannelTypeMeta { type: ChannelType; icon: string | null; feature: GuildFeature | null; labelKey: string; descKey: string }`
  - `const CHANNEL_META: readonly ChannelTypeMeta[]` - **all eleven** types
  - `const HOUSEHOLD_CHANNEL_META: readonly ChannelTypeMeta[]` - the household subset, derived
  - `channelIcon(type: ChannelType): string | null` - **the only** icon lookup in the codebase
  - `householdChannelMeta(type: ChannelType): ChannelTypeMeta | null`
  - `isHouseholdChannel(type: ChannelType): boolean`
  - `householdFeatureFor(type: ChannelType): GuildFeature | null`
  - `channelViewFor(type: ChannelType): ChannelView`

- [ ] **Step 1: Add the five channel types**

In `src/app/dtos/response/guild.dto.ts`, replace the `ChannelType` enum body (lines 3-11) with:

```ts
export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
    Forum = 'Forum',
    /** A forum variant: same tags, posts and endpoints, gallery-first rendering. */
    Media = 'Media',
    Announcement = 'Announcement',

    // ── Household channel types ─────────────────────────────────────────────
    // Structured rows, not messages: none of these has message history or a
    // composer. Each is gated on the matching GuildFeatures module - see
    // features/guild/channel-types.ts.
    List = 'List',
    Chores = 'Chores',
    Ledger = 'Ledger',
    Pantry = 'Pantry',
    Decisions = 'Decisions',
}
```

- [ ] **Step 2: Write the failing test**

Create `src/app/features/guild/channel-types.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {ChannelType} from '../../dtos/response/guild.dto';
import {GuildFeature} from './guild-features';
import {
    CHANNEL_META,
    channelIcon,
    channelViewFor,
    HOUSEHOLD_CHANNEL_META,
    householdChannelMeta,
    householdFeatureFor,
    isHouseholdChannel,
} from './channel-types';

const HOUSEHOLD_TYPES = [
    ChannelType.List, ChannelType.Chores, ChannelType.Ledger,
    ChannelType.Pantry, ChannelType.Decisions,
] as const;

describe('CHANNEL_META', () => {
    it('has exactly one entry for every ChannelType', () => {
        const allTypes = Object.values(ChannelType);
        expect(CHANNEL_META).toHaveLength(allTypes.length);
        for (const type of allTypes) {
            expect(CHANNEL_META.filter(m => m.type === type), type).toHaveLength(1);
        }
    });

    it('gives every entry translation keys, and an icon for all but Text', () => {
        for (const meta of CHANNEL_META) {
            expect(meta.labelKey, meta.type).toBeTruthy();
            expect(meta.descKey, meta.type).toBeTruthy();
            if (meta.type === ChannelType.Text) {
                expect(meta.icon).toBeNull();  // renders a literal '#'
            } else {
                expect(meta.icon, meta.type).toMatch(/^pi pi-/);
            }
        }
    });
});

describe('channelIcon', () => {
    it('returns null for Text, which renders a hash instead', () => {
        expect(channelIcon(ChannelType.Text)).toBeNull();
    });

    it('returns the icon for every other known type', () => {
        expect(channelIcon(ChannelType.Voice)).toBe('pi pi-volume-up');
        expect(channelIcon(ChannelType.Forum)).toBe('pi pi-align-left');
        expect(channelIcon(ChannelType.Media)).toBe('pi pi-images');
        expect(channelIcon(ChannelType.Announcement)).toBe('pi pi-megaphone');
        expect(channelIcon(ChannelType.List)).toBe('pi pi-check-square');
        expect(channelIcon(ChannelType.Chores)).toBe('pi pi-sync');
        expect(channelIcon(ChannelType.Ledger)).toBe('pi pi-wallet');
        expect(channelIcon(ChannelType.Pantry)).toBe('pi pi-box');
        expect(channelIcon(ChannelType.Decisions)).toBe('pi pi-flag');
    });

    it('returns null for an unknown type rather than throwing', () => {
        expect(channelIcon('Sauna' as ChannelType)).toBeNull();
    });
});

describe('HOUSEHOLD_CHANNEL_META', () => {
    it('is exactly the household subset of CHANNEL_META', () => {
        expect(HOUSEHOLD_CHANNEL_META.map(m => m.type)).toEqual([...HOUSEHOLD_TYPES]);
    });

    it('gives every household entry a gating module and CHANNEL_TYPE.* keys', () => {
        for (const meta of HOUSEHOLD_CHANNEL_META) {
            expect(meta.feature, meta.type).not.toBeNull();
            expect(meta.labelKey).toMatch(/^CHANNEL_TYPE\./);
            expect(meta.descKey).toMatch(/^CHANNEL_TYPE\./);
        }
    });
});

describe('householdFeatureFor', () => {
    it('maps each household type to its gating module', () => {
        expect(householdFeatureFor(ChannelType.List)).toBe(GuildFeature.Lists);
        expect(householdFeatureFor(ChannelType.Chores)).toBe(GuildFeature.Chores);
        expect(householdFeatureFor(ChannelType.Ledger)).toBe(GuildFeature.Ledger);
        expect(householdFeatureFor(ChannelType.Pantry)).toBe(GuildFeature.Pantry);
        expect(householdFeatureFor(ChannelType.Decisions)).toBe(GuildFeature.Decisions);
    });

    it('returns null for the chat types', () => {
        expect(householdFeatureFor(ChannelType.Text)).toBeNull();
        expect(householdFeatureFor(ChannelType.Voice)).toBeNull();
        expect(householdFeatureFor(ChannelType.Forum)).toBeNull();
    });
});

describe('isHouseholdChannel', () => {
    it('agrees with the metadata table', () => {
        for (const type of HOUSEHOLD_TYPES) expect(isHouseholdChannel(type)).toBe(true);
        expect(isHouseholdChannel(ChannelType.Text)).toBe(false);
        expect(isHouseholdChannel(ChannelType.Announcement)).toBe(false);
    });
});

describe('householdChannelMeta', () => {
    it('returns the entry for a household type and null otherwise', () => {
        expect(householdChannelMeta(ChannelType.Ledger)?.feature).toBe(GuildFeature.Ledger);
        expect(householdChannelMeta(ChannelType.Text)).toBeNull();
    });
});

describe('channelViewFor', () => {
    it('routes voice to the voice view', () => {
        expect(channelViewFor(ChannelType.Voice)).toBe('voice');
    });

    it('routes both forum-like types to the forum view', () => {
        expect(channelViewFor(ChannelType.Forum)).toBe('forum');
        expect(channelViewFor(ChannelType.Media)).toBe('forum');
    });

    it('routes the message-bearing types to the message view', () => {
        expect(channelViewFor(ChannelType.Text)).toBe('message');
        expect(channelViewFor(ChannelType.Announcement)).toBe('message');
        expect(channelViewFor(ChannelType.Thread)).toBe('message');
    });

    it('routes every household type to the unsupported view for now', () => {
        for (const type of HOUSEHOLD_TYPES) expect(channelViewFor(type)).toBe('unsupported');
    });

    // The single most damaging failure mode in the integration guide (§10.1): a type this
    // build has never heard of must not fall through to the message view, or the client
    // renders a composer that posts into a shopping list.
    it('never routes an unknown type to the message view', () => {
        expect(channelViewFor('Sauna' as ChannelType)).toBe('unsupported');
        expect(channelViewFor('' as ChannelType)).toBe('unsupported');
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/app/features/guild/channel-types.spec.ts`
Expected: FAIL - "Failed to resolve import ./channel-types".

- [ ] **Step 4: Write the implementation**

Create `src/app/features/guild/channel-types.ts`:

```ts
import {ChannelType, isForumLike} from '../../dtos/response/guild.dto';
import {GuildFeature} from './guild-features';

/**
 * How a channel should be drawn. Resolved by {@link channelViewFor} rather than by a
 * template `@switch`, so "an unrecognised type is never a message view" is something a
 * test asserts instead of something a reviewer has to notice.
 */
export type ChannelView = 'voice' | 'forum' | 'message' | 'unsupported';

export interface ChannelTypeMeta {
    type: ChannelType;
    /** PrimeIcons class, or `null` for Text - which renders a literal `#` instead. */
    icon: string | null;
    /** The module gating this type, or `null` when nothing gates it (Text and Thread). */
    feature: GuildFeature | null;
    labelKey: string;
    descKey: string;
}

/**
 * The types whose contents are structured rows rather than messages. Declared as raw
 * strings ahead of the table so the table can be filtered by it at module init.
 */
const HOUSEHOLD_TYPE_SET: ReadonlySet<string> = new Set([
    ChannelType.List, ChannelType.Chores, ChannelType.Ledger,
    ChannelType.Pantry, ChannelType.Decisions,
]);

/**
 * Every channel type this build knows, in sidebar order. One table, because the
 * leading icon for a type was previously chosen by an `@if` ladder in the sidebar row
 * *and* independently again in the create-channel modal - at eleven types those stop
 * agreeing with each other. {@link channelIcon} is the only icon lookup in the app.
 */
export const CHANNEL_META: readonly ChannelTypeMeta[] = [
    // ── Chat types. Their label keys predate this table, hence the GUILD.* stem. ──
    {
        type: ChannelType.Text,
        icon: null,
        feature: null,
        labelKey: 'GUILD.CHANNEL_TYPE_TEXT',
        descKey: 'GUILD.CHANNEL_TYPE_TEXT_DESC',
    },
    {
        type: ChannelType.Voice,
        icon: 'pi pi-volume-up',
        feature: GuildFeature.VoiceChannels,
        labelKey: 'GUILD.CHANNEL_TYPE_VOICE',
        descKey: 'GUILD.CHANNEL_TYPE_VOICE_DESC',
    },
    {
        // A thread is never offered in the create-channel picker - it is created from a
        // message - so it borrows the text strings purely to keep the table total.
        type: ChannelType.Thread,
        icon: 'pi pi-comments',
        feature: GuildFeature.Threads,
        labelKey: 'GUILD.CHANNEL_TYPE_TEXT',
        descKey: 'GUILD.CHANNEL_TYPE_TEXT_DESC',
    },
    {
        type: ChannelType.Forum,
        icon: 'pi pi-align-left',
        feature: GuildFeature.Forums,
        labelKey: 'GUILD.CHANNEL_TYPE_FORUM',
        descKey: 'GUILD.CHANNEL_TYPE_FORUM_DESC',
    },
    {
        type: ChannelType.Media,
        icon: 'pi pi-images',
        feature: GuildFeature.Forums,
        labelKey: 'GUILD.CHANNEL_TYPE_MEDIA',
        descKey: 'GUILD.CHANNEL_TYPE_MEDIA_DESC',
    },
    {
        type: ChannelType.Announcement,
        icon: 'pi pi-megaphone',
        feature: GuildFeature.Announcements,
        labelKey: 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT',
        descKey: 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT_DESC',
    },

    // ── Household types: structured rows, no messages, no composer. ──────────────
    {
        type: ChannelType.List,
        icon: 'pi pi-check-square',
        feature: GuildFeature.Lists,
        labelKey: 'CHANNEL_TYPE.LIST.LABEL',
        descKey: 'CHANNEL_TYPE.LIST.DESC',
    },
    {
        type: ChannelType.Chores,
        icon: 'pi pi-sync',
        feature: GuildFeature.Chores,
        labelKey: 'CHANNEL_TYPE.CHORES.LABEL',
        descKey: 'CHANNEL_TYPE.CHORES.DESC',
    },
    {
        type: ChannelType.Ledger,
        icon: 'pi pi-wallet',
        feature: GuildFeature.Ledger,
        labelKey: 'CHANNEL_TYPE.LEDGER.LABEL',
        descKey: 'CHANNEL_TYPE.LEDGER.DESC',
    },
    {
        type: ChannelType.Pantry,
        icon: 'pi pi-box',
        feature: GuildFeature.Pantry,
        labelKey: 'CHANNEL_TYPE.PANTRY.LABEL',
        descKey: 'CHANNEL_TYPE.PANTRY.DESC',
    },
    {
        type: ChannelType.Decisions,
        icon: 'pi pi-flag',
        feature: GuildFeature.Decisions,
        labelKey: 'CHANNEL_TYPE.DECISIONS.LABEL',
        descKey: 'CHANNEL_TYPE.DECISIONS.DESC',
    },
];

/** Keyed by the raw string so an off-enum value from a newer server simply misses. */
const META_BY_TYPE = new Map<string, ChannelTypeMeta>(
    CHANNEL_META.map(meta => [meta.type as string, meta]),
);

/** The five whose contents are structured rows rather than messages. */
export const HOUSEHOLD_CHANNEL_META: readonly ChannelTypeMeta[] = CHANNEL_META.filter(
    meta => HOUSEHOLD_TYPE_SET.has(meta.type as string),
);

/**
 * The leading glyph for a channel type. `null` means "no icon" - Text renders a literal
 * `#`, and an unknown type gets whatever fallback the caller prefers. The single icon
 * lookup in the app: the sidebar row and the create-channel picker both call this.
 */
export function channelIcon(type: ChannelType): string | null {
    return META_BY_TYPE.get(type as string)?.icon ?? null;
}

export function householdChannelMeta(type: ChannelType): ChannelTypeMeta | null {
    if (!HOUSEHOLD_TYPE_SET.has(type as string)) return null;
    return META_BY_TYPE.get(type as string) ?? null;
}

export function isHouseholdChannel(type: ChannelType): boolean {
    return HOUSEHOLD_TYPE_SET.has(type as string);
}

export function householdFeatureFor(type: ChannelType): GuildFeature | null {
    return householdChannelMeta(type)?.feature ?? null;
}

/** The types this build can render as a message view - the only ones that get a composer. */
const MESSAGE_TYPES: readonly string[] = [
    ChannelType.Text, ChannelType.Announcement, ChannelType.Thread,
];

/**
 * Deliberately an allowlist. The previous template `@else` sent every unrecognised type
 * to the message view, which is how a household channel ends up offering a composer that
 * posts nowhere. Anything not named here - a household type whose module has not shipped,
 * or a type from a newer server - is inert.
 */
export function channelViewFor(type: ChannelType): ChannelView {
    if (type === ChannelType.Voice) return 'voice';
    if (isForumLike(type)) return 'forum';
    if (MESSAGE_TYPES.includes(type as string)) return 'message';
    return 'unsupported';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/features/guild/channel-types.spec.ts`
Expected: PASS - 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/guild.dto.ts src/app/features/guild/channel-types.ts src/app/features/guild/channel-types.spec.ts
git commit -m "feat: add household channel types and view resolution"
```

---

### Task 2: Translation keys

**Files:**
- Modify: `src/assets/i18n/locales/en.json` (submodule)
- Modify: `src/assets/i18n/locales/de.json` (submodule)
- Modify: `src/assets/i18n/locales/fr.json` (submodule)

**Interfaces:**
- Consumes: nothing.
- Produces: the translation keys every later task renders. Landing them first means no task ships a screen showing raw key names.

- [ ] **Step 1: Add the English strings**

In `src/assets/i18n/locales/en.json`, insert after the last `GUILD_MODULE.*` line (near line 1119). Note `en.json` is flat - no nesting, one key per line:

```json
  "CHANNEL_TYPE.LIST.LABEL": "List",
  "CHANNEL_TYPE.LIST.DESC": "A shared shopping or to-do list",
  "CHANNEL_TYPE.CHORES.LABEL": "Chores",
  "CHANNEL_TYPE.CHORES.DESC": "A rota that shares work out fairly",
  "CHANNEL_TYPE.LEDGER.LABEL": "Ledger",
  "CHANNEL_TYPE.LEDGER.DESC": "Shared expenses and who owes what",
  "CHANNEL_TYPE.PANTRY.LABEL": "Pantry",
  "CHANNEL_TYPE.PANTRY.DESC": "What's in stock and what's running out",
  "CHANNEL_TYPE.DECISIONS.LABEL": "Decisions",
  "CHANNEL_TYPE.DECISIONS.DESC": "House decisions everyone can weigh in on",
  "CHANNEL.GROUP_CHAT": "Chat",
  "CHANNEL.GROUP_HOUSEHOLD": "Household",
  "CHANNEL.UNSUPPORTED.TITLE": "Not available in this version",
  "CHANNEL.UNSUPPORTED.BODY": "This channel type needs a newer version of the app. Update to open it.",
  "PERM_GROUP.LISTS": "Lists",
  "PERM_GROUP.CHORES": "Chores",
  "PERM_GROUP.LEDGER": "Ledger",
  "PERM_GROUP.PANTRY": "Pantry",
  "PERM_GROUP.DECISIONS": "Decisions",
  "PERM_GROUP.GUESTS": "Guests",
```

- [ ] **Step 2: Add the German strings**

In `src/assets/i18n/locales/de.json`, at the matching position:

```json
  "CHANNEL_TYPE.LIST.LABEL": "Liste",
  "CHANNEL_TYPE.LIST.DESC": "Eine gemeinsame Einkaufs- oder To-do-Liste",
  "CHANNEL_TYPE.CHORES.LABEL": "Ämtli",
  "CHANNEL_TYPE.CHORES.DESC": "Ein Plan, der die Arbeit fair verteilt",
  "CHANNEL_TYPE.LEDGER.LABEL": "Kassenbuch",
  "CHANNEL_TYPE.LEDGER.DESC": "Gemeinsame Ausgaben und wer wem was schuldet",
  "CHANNEL_TYPE.PANTRY.LABEL": "Vorrat",
  "CHANNEL_TYPE.PANTRY.DESC": "Was da ist und was ausgeht",
  "CHANNEL_TYPE.DECISIONS.LABEL": "Entscheidungen",
  "CHANNEL_TYPE.DECISIONS.DESC": "Entscheidungen, bei denen alle mitreden können",
  "CHANNEL.GROUP_CHAT": "Chat",
  "CHANNEL.GROUP_HOUSEHOLD": "Haushalt",
  "CHANNEL.UNSUPPORTED.TITLE": "In dieser Version nicht verfügbar",
  "CHANNEL.UNSUPPORTED.BODY": "Dieser Kanaltyp braucht eine neuere Version der App. Aktualisiere, um ihn zu öffnen.",
  "PERM_GROUP.LISTS": "Listen",
  "PERM_GROUP.CHORES": "Ämtli",
  "PERM_GROUP.LEDGER": "Kassenbuch",
  "PERM_GROUP.PANTRY": "Vorrat",
  "PERM_GROUP.DECISIONS": "Entscheidungen",
  "PERM_GROUP.GUESTS": "Gäste",
```

- [ ] **Step 3: Add the French strings**

In `src/assets/i18n/locales/fr.json`, at the matching position:

```json
  "CHANNEL_TYPE.LIST.LABEL": "Liste",
  "CHANNEL_TYPE.LIST.DESC": "Une liste de courses ou de tâches partagée",
  "CHANNEL_TYPE.CHORES.LABEL": "Tâches",
  "CHANNEL_TYPE.CHORES.DESC": "Un roulement qui répartit le travail équitablement",
  "CHANNEL_TYPE.LEDGER.LABEL": "Comptes",
  "CHANNEL_TYPE.LEDGER.DESC": "Dépenses partagées et qui doit quoi",
  "CHANNEL_TYPE.PANTRY.LABEL": "Garde-manger",
  "CHANNEL_TYPE.PANTRY.DESC": "Ce qu'il reste et ce qui manque bientôt",
  "CHANNEL_TYPE.DECISIONS.LABEL": "Décisions",
  "CHANNEL_TYPE.DECISIONS.DESC": "Les décisions de la maison, ouvertes à tous",
  "CHANNEL.GROUP_CHAT": "Discussion",
  "CHANNEL.GROUP_HOUSEHOLD": "Maison",
  "CHANNEL.UNSUPPORTED.TITLE": "Indisponible dans cette version",
  "CHANNEL.UNSUPPORTED.BODY": "Ce type de salon nécessite une version plus récente de l'application. Mettez à jour pour l'ouvrir.",
  "PERM_GROUP.LISTS": "Listes",
  "PERM_GROUP.CHORES": "Tâches",
  "PERM_GROUP.LEDGER": "Comptes",
  "PERM_GROUP.PANTRY": "Garde-manger",
  "PERM_GROUP.DECISIONS": "Décisions",
  "PERM_GROUP.GUESTS": "Invités",
```

- [ ] **Step 4: Verify all three files are still valid JSON**

Run:

```bash
node -e "for (const f of ['en','de','fr']) { JSON.parse(require('fs').readFileSync('src/assets/i18n/locales/'+f+'.json','utf8')); console.log(f, 'ok'); }"
```

Expected: `en ok`, `de ok`, `fr ok`. A trailing-comma or duplicate-key mistake fails here.

- [ ] **Step 5: Verify no key was added twice**

Run:

```bash
node -e "const j=require('fs').readFileSync('src/assets/i18n/locales/en.json','utf8'); const keys=[...j.matchAll(/^  \"([^\"]+)\":/gm)].map(m=>m[1]); const dupes=keys.filter((k,i)=>keys.indexOf(k)!==i); console.log(dupes.length ? 'DUPES: '+dupes : 'no duplicates');"
```

Expected: `no duplicates`.

- [ ] **Step 6: Commit inside the submodule, then bump the pointer**

```bash
git -C src/assets/i18n/locales add en.json de.json fr.json
git -C src/assets/i18n/locales commit -m "feat: add household channel type and permission group strings"
git add src/assets/i18n/locales
git commit -m "chore: bump i18n locales for household channel types"
```

---

### Task 3: The unsupported-channel placeholder

**Files:**
- Create: `src/app/features/guild/components/unsupported-channel/unsupported-channel.component.ts`
- Create: `src/app/features/guild/components/unsupported-channel/unsupported-channel.component.html`

**Interfaces:**
- Consumes: `householdChannelMeta` from Task 1; `CHANNEL.UNSUPPORTED.*` and `CHANNEL_TYPE.*` keys from Task 2.
- Produces: `<app-unsupported-channel [channel]="..."/>`, selector `app-unsupported-channel`, one required input `channel: ChannelDto`. Task 4 mounts it.

- [ ] **Step 1: Write the component class**

Create `src/app/features/guild/components/unsupported-channel/unsupported-channel.component.ts`:

```ts
import {Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {householdChannelMeta} from '../../channel-types';

/**
 * Shown for a channel this build cannot render: a household type whose module has not
 * shipped yet, or a type from a newer server. Inert by construction - no inputs beyond
 * the channel, no outputs, no fetching, and above all no composer.
 */
@Component({
    selector: 'app-unsupported-channel',
    imports: [TranslateModule],
    templateUrl: './unsupported-channel.component.html',
})
export class UnsupportedChannelComponent {
    channel = input.required<ChannelDto>();

    private meta = computed(() => householdChannelMeta(this.channel().type));

    /**
     * A household channel keeps its own icon and noun, so a shopping list opened before
     * the Lists module lands still reads as a shopping list - just not an interactive
     * one. A genuinely unknown type falls back to a neutral glyph.
     */
    protected icon = computed(() => this.meta()?.icon ?? 'pi pi-question-circle');
    protected typeLabelKey = computed(() => this.meta()?.labelKey ?? null);
    protected typeDescKey = computed(() => this.meta()?.descKey ?? null);
}
```

- [ ] **Step 2: Write the template**

Create `src/app/features/guild/components/unsupported-channel/unsupported-channel.component.html`:

```html
<div class="flex flex-col h-full bg-app-bg">

    <!-- Header: matches the channel header elsewhere so the shell doesn't jump on navigation -->
    <div class="flex items-center gap-2.5 px-4 h-12 shrink-0 border-b border-white/[0.10]">
        <i [class]="icon()" class="text-white/35 text-[17px] shrink-0"></i>
        <span class="text-sm font-semibold text-text-primary truncate">{{ channel().name }}</span>
        @if (typeLabelKey(); as labelKey) {
            <span class="text-[0.6875rem] font-medium text-text-muted uppercase tracking-widest px-1.5 py-0.5 rounded bg-white/[0.04] shrink-0">
                {{ labelKey | translate }}
            </span>
        }
    </div>

    <!-- Body -->
    <div class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div class="w-14 h-14 rounded-2xl bg-card border border-border flex items-center justify-center">
            <i [class]="icon()" class="text-[1.5rem] text-text-muted"></i>
        </div>

        <div class="max-w-sm space-y-1.5">
            <p class="text-sm font-semibold text-text-primary m-0">{{ 'CHANNEL.UNSUPPORTED.TITLE' | translate }}</p>
            @if (typeDescKey(); as descKey) {
                <p class="text-[0.8125rem] text-text-secondary m-0">{{ descKey | translate }}</p>
            }
            <p class="text-[0.8125rem] text-text-muted m-0">{{ 'CHANNEL.UNSUPPORTED.BODY' | translate }}</p>
        </div>
    </div>
</div>
```

- [ ] **Step 3: Verify it compiles**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds. (The component is not yet mounted; this only proves it type-checks.)

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/unsupported-channel/
git commit -m "feat: add inert placeholder for unsupported channel types"
```

---

### Task 4: Route through the allowlist

**Files:**
- Modify: `src/app/features/main-page/main-page.component.html:54-62`
- Modify: `src/app/features/main-page/main-page.component.ts:28,83`

**Interfaces:**
- Consumes: `channelViewFor` from Task 1; `UnsupportedChannelComponent` from Task 3.
- Produces: nothing further tasks depend on. This is the task that closes §10.1 of the guide.

- [ ] **Step 1: Swap the imports on the component class**

In `src/app/features/main-page/main-page.component.ts`, replace the import on line 28:

```ts
import {ChannelType, isForumLike} from '../../dtos/response/guild.dto';
```

with these two:

```ts
import {channelViewFor} from '../guild/channel-types';
import {UnsupportedChannelComponent} from '../guild/components/unsupported-channel/unsupported-channel.component';
```

Both `ChannelType` and `isForumLike` are referenced **only** at lines 82-83 of this file and only from the template block Step 2 replaces, so the whole import goes. Replace both exposed members (lines 82-83):

```ts
    protected readonly ChannelType = ChannelType;
    protected readonly isForumLike = isForumLike;
```

with:

```ts
    /** Routing is an allowlist: an unrecognised type resolves to 'unsupported', never 'message'. */
    protected readonly channelViewFor = channelViewFor;
```

Finally, add `UnsupportedChannelComponent` to the `imports` array (line 51-73), directly after `ForumChannelComponent`:

```ts
        ForumChannelComponent,
        UnsupportedChannelComponent,
```

- [ ] **Step 2: Rewrite the channel case in the template**

In `src/app/features/main-page/main-page.component.html`, replace lines 54-62:

```html
                @case ('channel') {
                    @if (view.channel.type === ChannelType.Voice) {
                        <app-voice-channel [channel]="view.channel"/>
                    } @else if (isForumLike(view.channel.type)) {
                        <app-forum-channel (back)="navService.showHome()" [channel]="view.channel"/>
                    } @else {
                        <app-channel (back)="navService.showHome()" [channel]="view.channel"/>
                    }
                }
```

with:

```html
                @case ('channel') {
                    <!-- An allowlist, deliberately. The previous @else sent every
                         unrecognised type to the message view, composer and all. -->
                    @switch (channelViewFor(view.channel.type)) {
                        @case ('voice') {
                            <app-voice-channel [channel]="view.channel"/>
                        }
                        @case ('forum') {
                            <app-forum-channel (back)="navService.showHome()" [channel]="view.channel"/>
                        }
                        @case ('message') {
                            <app-channel (back)="navService.showHome()" [channel]="view.channel"/>
                        }
                        @default {
                            <app-unsupported-channel [channel]="view.channel"/>
                        }
                    }
                }
```

- [ ] **Step 3: Verify the build**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds with no unused-import or unknown-element errors.

- [ ] **Step 4: Re-run the routing test**

Run: `npx vitest run src/app/features/guild/channel-types.spec.ts`
Expected: PASS - the allowlist behaviour the template now depends on is still covered.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/main-page/main-page.component.ts src/app/features/main-page/main-page.component.html
git commit -m "fix: route unknown channel types to an inert view, not the composer"
```

---

### Task 5: Sidebar rows for household channels

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.ts`
- Modify: `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.html:13-27`

**Interfaces:**
- Consumes: `householdChannelMeta`, `isHouseholdChannel` from Task 1.
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Add the icon and badge computeds**

In `text-channel-item.component.ts`, add the import:

```ts
import {channelIcon, isHouseholdChannel} from '../../../../channel-types';
```

and add these members to the class, after `isActive`:

```ts
    /** `null` for Text, which renders a literal `#`. One table, no per-type ladder. */
    protected icon = computed(() => channelIcon(this.channel().type));

    /**
     * Household channels carry no messages, so read state for them is meaningless -
     * an unread weight or a mention count on a shopping list could only ever be wrong.
     */
    protected showsReadState = computed(() => !isHouseholdChannel(this.channel().type));
```

- [ ] **Step 2: Rewrite the icon and badge markup**

In `text-channel-item.component.html`, replace lines 11-27 (the `[ngClass]` line through the mention badge) with:

```html
            [ngClass]="isActive() ? 'bg-white/[0.08] text-white/95' : (showsReadState() && rs.isUnread) ? 'text-white/90 font-semibold hover:bg-white/[0.06] hover:text-white' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/90'"
            class="w-full flex items-center gap-2.5 px-2 py-[7px] rounded-lg text-left transition-all border-0 cursor-pointer">
        @if (icon(); as iconClass) {
            <i [class]="iconClass" class="text-white/35 text-[17px] shrink-0 pointer-events-none"></i>
        } @else {
            <span class="text-white/35 text-[25px] leading-none font-medium shrink-0 pointer-events-none">#</span>
        }
        <span class="text-[0.8rem] font-medium truncate flex-1 pointer-events-none">{{ channel().name }}</span>
        @if (showsReadState() && rs.mentionCount > 0) {
            <span class="min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0 pointer-events-none">
                {{ rs.mentionCount }}
            </span>
        }
```

- [ ] **Step 3: Verify the build**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/channel-list/components/text-channel-item/
git commit -m "feat: render household channel icons and suppress their read state"
```

---

### Task 6: The eleven permissions

**Files:**
- Modify: `src/app/enums/permissions.enum.ts:66-121`
- Test: `src/app/enums/permissions.enum.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Eleven new `PermissionKey`s: `ManageLists`, `AddListItems`, `CheckOffListItems`, `ManageChores`, `CompleteChores`, `ManageLedger`, `AddExpenses`, `ManagePantry`, `CreateDecisions`, `VoteDecisions`, `ManageGuests`.
  - `PermGroup` gains `feature?: string` - the **module flag name**, not a `GuildFeature` union value, so this file keeps zero feature-layer imports. Tasks 7 and 8 consume it.

- [ ] **Step 1: Write the failing test**

Append to `src/app/enums/permissions.enum.spec.ts`:

```ts
describe('Household permission bits', () => {
    const HOUSEHOLD_KEYS: PermissionKey[] = [
        'ManageLists', 'AddListItems', 'CheckOffListItems',
        'ManageChores', 'CompleteChores',
        'ManageLedger', 'AddExpenses',
        'ManagePantry',
        'CreateDecisions', 'VoteDecisions',
        'ManageGuests',
    ];

    it('assigns bits 39-49 in the order the backend guide lists them', () => {
        HOUSEHOLD_KEYS.forEach((key, i) => {
            expect(Permissions[key], key).toBe(1n << BigInt(39 + i));
        });
    });

    it('does not collide with any pre-existing bit', () => {
        const existing = (Object.keys(Permissions) as PermissionKey[])
            .filter(k => k !== 'None' && !HOUSEHOLD_KEYS.includes(k));
        for (const key of HOUSEHOLD_KEYS) {
            for (const other of existing) {
                expect(Permissions[key] & Permissions[other], `${key} vs ${other}`).toBe(0n);
            }
        }
    });

    // The wire format is names in both directions, so a name that does not round-trip
    // is a permission the client would silently drop when saving a role.
    it('round-trips every household name through the serializer', () => {
        for (const key of HOUSEHOLD_KEYS) {
            expect(stringifyPermissions(Permissions[key])).toBe(key);
            expect(parsePermissions(key)).toBe(Permissions[key]);
        }
    });

    it('tags each household group with the module that gates it', () => {
        const byLabel = new Map(PERM_GROUPS.map(g => [g.label, g]));
        expect(byLabel.get('Lists')?.feature).toBe('Lists');
        expect(byLabel.get('Chores')?.feature).toBe('Chores');
        expect(byLabel.get('Ledger')?.feature).toBe('Ledger');
        expect(byLabel.get('Pantry')?.feature).toBe('Pantry');
        expect(byLabel.get('Decisions')?.feature).toBe('Decisions');
        expect(byLabel.get('Guests')?.feature).toBe('GuestAccess');
    });

    it('leaves the chat groups untagged, so they always render', () => {
        const byLabel = new Map(PERM_GROUPS.map(g => [g.label, g]));
        expect(byLabel.get('General')?.feature).toBeUndefined();
        expect(byLabel.get('Messages')?.feature).toBeUndefined();
        expect(byLabel.get('Admin')?.feature).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/enums/permissions.enum.spec.ts`
Expected: FAIL - TypeScript rejects the unknown `PermissionKey` values, and the existing "every key in exactly one group" test still passes (nothing added yet).

- [ ] **Step 3: Add the permission bits**

In `src/app/enums/permissions.enum.ts`, insert between `ManageEvents` (line 66) and the `Superadmin` catch-all:

```ts
    // ── Household: lists ──────────────────────────────────────────────────────
    ManageLists: 1n << 39n,
    AddListItems: 1n << 40n,
    CheckOffListItems: 1n << 41n,

    // ── Household: chores ─────────────────────────────────────────────────────
    ManageChores: 1n << 42n,
    CompleteChores: 1n << 43n,

    // ── Household: ledger ─────────────────────────────────────────────────────
    ManageLedger: 1n << 44n,
    AddExpenses: 1n << 45n,

    // ── Household: pantry ─────────────────────────────────────────────────────
    ManagePantry: 1n << 46n,

    // ── Household: decisions ──────────────────────────────────────────────────
    CreateDecisions: 1n << 47n,
    VoteDecisions: 1n << 48n,

    // ── Household: guest access ───────────────────────────────────────────────
    ManageGuests: 1n << 49n,
```

- [ ] **Step 4: Tag `PermGroup` with its module**

Replace the `PermGroup` interface (lines 75-78) with:

```ts
export interface PermGroup {
    label: string;
    perms: PermissionKey[];
    /**
     * The `GuildFeatures` module name gating this group. A plain string rather than the
     * `GuildFeature` union so this file needs no feature-layer import - and the values
     * are the flag names anyway, which is exactly what `GuildFeatureSet` holds.
     *
     * Absent means ungated: the group renders in every guild.
     */
    feature?: string;
}
```

- [ ] **Step 5: Add the six groups**

In `PERM_GROUPS`, insert immediately before the `Admin` group so `Superadmin` stays last:

```ts
    {
        label: 'Lists',
        feature: 'Lists',
        perms: ['ManageLists', 'AddListItems', 'CheckOffListItems'],
    },
    {
        label: 'Chores',
        feature: 'Chores',
        perms: ['ManageChores', 'CompleteChores'],
    },
    {
        label: 'Ledger',
        feature: 'Ledger',
        perms: ['ManageLedger', 'AddExpenses'],
    },
    {
        label: 'Pantry',
        feature: 'Pantry',
        perms: ['ManagePantry'],
    },
    {
        label: 'Decisions',
        feature: 'Decisions',
        perms: ['CreateDecisions', 'VoteDecisions'],
    },
    {
        label: 'Guests',
        feature: 'GuestAccess',
        perms: ['ManageGuests'],
    },
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/app/enums/permissions.enum.spec.ts`
Expected: PASS. The pre-existing "places every PermissionKey except None in exactly one group" test now also covers the eleven new keys - if any were left ungrouped it fails here.

- [ ] **Step 7: Commit**

```bash
git add src/app/enums/permissions.enum.ts src/app/enums/permissions.enum.spec.ts
git commit -m "feat: add household permissions and module-tagged permission groups"
```

---

### Task 7: Hide permission groups whose module is off

**Files:**
- Modify: `src/app/features/guild/shared/permission-toggle/permission-toggle.component.ts`
- Modify: `src/app/features/guild/shared/permission-toggle/permission-toggle.component.html:2`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html:138`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/members-settings/members-settings.component.html:113`

**Interfaces:**
- Consumes: `PermGroup.feature` from Task 6; `guildFeatures`, `GuildFeatureSet` from `features/guild/guild-features`.
- Produces: `<app-permission-toggle [features]="...">` - an **optional** input, so any caller that omits it keeps today's behaviour of showing every group.

**Note:** `bot-install-consent.component.ts` also reads `PERM_GROUPS` and is deliberately **left alone**. It enumerates what a bot has *requested*; hiding a requested permission would understate the grant the user is approving.

- [ ] **Step 1: Add the optional features input**

In `permission-toggle.component.ts`, change line 1 from:

```ts
import {Component, input, output} from '@angular/core';
```

to:

```ts
import {Component, computed, input, output} from '@angular/core';
```

and add:

```ts
import {GuildFeatureSet} from '../../guild-features';
```

Replace `readonly groups = PERM_GROUPS;` (line 16) with:

```ts
    /**
     * The guild's module set. A group whose module is off is hidden outright rather than
     * disabled: "this house doesn't do money" and "you aren't allowed to touch the money"
     * must not look the same - see §10.2 of the household modules guide.
     *
     * Optional. Omitted means "show everything", which is what any caller with no guild
     * in hand needs and what every caller did before modules existed.
     */
    features = input<GuildFeatureSet | null>(null);

    protected readonly groups = computed(() => {
        const features = this.features();
        if (!features) return PERM_GROUPS;
        return PERM_GROUPS.filter(group => !group.feature || features.has(group.feature));
    });
```

- [ ] **Step 2: Call it as a signal in the template**

In `permission-toggle.component.html`, change line 2 from:

```html
    @for (group of groups; track group.label) {
```

to:

```html
    @for (group of groups(); track group.label) {
```

- [ ] **Step 3: Pass the guild's features from the roles page**

In `roles-settings.component.html:138`, change:

```html
                            <app-permission-toggle (maskChange)="onPermChange($event)" [mask]="editPermMask()"/>
```

to:

```html
                            <app-permission-toggle (maskChange)="onPermChange($event)"
                                                   [features]="features()"
                                                   [mask]="editPermMask()"/>
```

and add to `roles-settings.component.ts` - import `guildFeatures` from `../../../../guild-features` and add the computed beside the other class members:

```ts
    /** Module set for this guild: permission groups whose module is off aren't offered. */
    protected features = computed(() => guildFeatures(this.guild()));
```

- [ ] **Step 4: Pass the guild's features from the members page**

In `members-settings.component.html:113`, change:

```html
                <app-permission-toggle (maskChange)="onPermissionChange($event)" [mask]="editPermMask()"/>
```

to:

```html
                <app-permission-toggle (maskChange)="onPermissionChange($event)"
                                       [features]="features()"
                                       [mask]="editPermMask()"/>
```

and add to `members-settings.component.ts` - import `computed` from `@angular/core` (the file currently imports `inject, input, OnInit, signal`), import `guildFeatures` from `../../../../guild-features`, and add:

```ts
    /** Module set for this guild: permission groups whose module is off aren't offered. */
    protected features = computed(() => guildFeatures(this.guild()));
```

- [ ] **Step 5: Verify the build**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/shared/permission-toggle/ src/app/features/guild/components/guild-settings-modal/pages/roles-settings/ src/app/features/guild/components/guild-settings-modal/pages/members-settings/
git commit -m "feat: hide permission groups whose module is off"
```

---

### Task 8: Channel-scoped household overrides

**Files:**
- Modify: `src/app/features/guild/shared/permission-override-editor/permission-override-editor.component.ts:5-27,34-38`
- Modify: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.ts:29-33`
- Modify: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.html:77`
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.html:26,38`

**Interfaces:**
- Consumes: the eleven `PermissionKey`s from Task 6; `ChannelType` from `dtos/response/guild.dto`.
- Produces: `<app-permission-overrides-panel [channelType]="...">` and `<app-permission-override-editor [channelType]="...">`, both **optional** inputs defaulting to `null`.

**Design note:** household permissions are gated here on **channel type**, not guild features, because they resolve per channel - the guide is explicit that "a channel overwrite granting control of one list doesn't grant every list". The **category** permission editor (`category-permissions.component.html`) deliberately passes nothing, so it offers no household permissions at all: a category-wide household override is exactly the grants-every-list shape the per-channel model exists to avoid.

- [ ] **Step 1: Gate the editor's groups on channel type**

In `permission-override-editor.component.ts`, add to the imports:

```ts
import {ChannelType} from '../../../../dtos/response/guild.dto';
```

Extend the local `PermGroup` interface (lines 5-8) to:

```ts
interface PermGroup {
    label: string;
    perms: PermissionKey[];
    /** When set, this group only appears on a channel of that exact type. */
    channelType?: ChannelType;
}
```

Append these six entries to the local `PERM_GROUPS` array (after the `Moderation` entry on line 26):

```ts
    {label: 'Lists', channelType: ChannelType.List, perms: ['ManageLists', 'AddListItems', 'CheckOffListItems']},
    {label: 'Chores', channelType: ChannelType.Chores, perms: ['ManageChores', 'CompleteChores']},
    {label: 'Ledger', channelType: ChannelType.Ledger, perms: ['ManageLedger', 'AddExpenses']},
    {label: 'Pantry', channelType: ChannelType.Pantry, perms: ['ManagePantry']},
    {label: 'Decisions', channelType: ChannelType.Decisions, perms: ['CreateDecisions', 'VoteDecisions']},
```

**Note:** `ManageGuests` is guild-scoped, not channel-scoped, so it gets no entry here - it only appears in the roles/members editor from Task 7.

- [ ] **Step 2: Filter on the input**

In the same file, replace `readonly groups = PERM_GROUPS;` (line 38) with:

```ts
    /**
     * The type of the channel being edited, or null for a category. Household permission
     * groups resolve per channel, so a Ledger channel offers the ledger permissions and
     * nothing else - and a category offers none of them, since a category-wide grant is
     * precisely the "controls every list" shape the per-channel model avoids.
     */
    channelType = input<ChannelType | null>(null);

    protected readonly groups = computed(() => {
        const type = this.channelType();
        return PERM_GROUPS.filter(group => !group.channelType || group.channelType === type);
    });
```

and update the `@angular/core` import on line 1 to include `computed`:

```ts
import {Component, computed, input, output} from '@angular/core';
```

- [ ] **Step 3: Call groups as a signal in the editor template**

In `permission-override-editor.component.html`, change line 2 from:

```html
    @for (group of groups; track group.label) {
```

to:

```html
    @for (group of groups(); track group.label) {
```

- [ ] **Step 4: Thread the input through the panel**

In `permission-overrides-panel.component.ts`, add the import:

```ts
import {ChannelType} from '../../../../dtos/response/guild.dto';
```

and add beside the other inputs (after `loading = input(false);`):

```ts
    /** Forwarded to the editor so channel-scoped household groups appear on the right channel. */
    channelType = input<ChannelType | null>(null);
```

In `permission-overrides-panel.component.html:77`, add the binding to the `<app-permission-override-editor` element:

```html
                        [channelType]="channelType()"
```

- [ ] **Step 5: Pass the channel's type from the channel permissions page**

In `channel-permissions.component.html`, add to **both** `<app-permission-overrides-panel` elements (lines 26 and 38):

```html
                [channelType]="channel().type"
```

Leave `category-permissions.component.html` untouched - it correctly passes nothing.

- [ ] **Step 6: Verify the build**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/shared/permission-override-editor/ src/app/features/guild/shared/permission-overrides-panel/ src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/
git commit -m "feat: offer household permission overrides per channel type"
```

---

### Task 9: Create-channel picker sections

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.ts`
- Modify: `src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.html:11-93`

**Interfaces:**
- Consumes: `HOUSEHOLD_CHANNEL_META`, `householdChannelMeta` from Task 1; `CHANNEL.GROUP_*` and `CHANNEL_TYPE.*` keys from Task 2.
- Produces: nothing further tasks depend on. Final task of the plan.

- [ ] **Step 1: Add the household options to the component**

In `create-channel-modal.component.ts`, add the import:

```ts
import {channelIcon, HOUSEHOLD_CHANNEL_META, householdFeatureFor} from '../../../../channel-types';
```

Add these members after `canAnnouncement` (line 31):

```ts
    /** Only the household types whose module this guild actually has. */
    protected householdTypes = computed(() =>
        HOUSEHOLD_CHANNEL_META.filter(meta => meta.feature !== null && this.guildFeatures().has(meta.feature)));
```

Replace `hasTypeChoice` (line 32) with:

```ts
    protected hasTypeChoice = computed(() =>
        this.canVoice() || this.canForum() || this.canAnnouncement() || this.householdTypes().length > 0);
```

Add a helper for the name field's leading glyph, after `hasTypeChoice`:

```ts
    /** The glyph inside the name field - the same table the sidebar row reads. */
    protected selectedIcon = computed(() => channelIcon(this.type()));
```

- [ ] **Step 2: Strand-guard the household types too**

In the same file, replace the `effect` body in the constructor (lines 44-49) with:

```ts
        effect(() => {
            const type = this.type();
            const householdFeature = householdFeatureFor(type);
            const stranded = (type === ChannelType.Voice && !this.canVoice())
                || ((type === ChannelType.Forum || type === ChannelType.Media) && !this.canForum())
                || (type === ChannelType.Announcement && !this.canAnnouncement())
                || (householdFeature !== null && !this.guildFeatures().has(householdFeature));
            if (stranded) untracked(() => this.type.set(ChannelType.Text));
        });
```

- [ ] **Step 3: Split the picker into two sections**

In `create-channel-modal.component.html`, replace the type-selector block (lines 11-67) with:

```html
        <!-- Type selector. Hidden entirely when every other type's module is off -
             a picker with one choice is just noise. -->
        @if (hasTypeChoice()) {
            <div class="space-y-4">

                <!-- Chat types -->
                <div>
                    <p class="text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">{{ 'CHANNEL.GROUP_CHAT' | translate }}</p>
                    <div class="grid grid-cols-2 gap-2">
                        <button
                                (click)="type.set(ChannelType.Text)"
                                [ngClass]="type() === ChannelType.Text ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                                class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                            <span class="text-base font-bold text-white/50">#</span>
                            <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_TEXT' | translate }}</span>
                            <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_TEXT_DESC' | translate }}</span>
                        </button>
                        @if (canVoice()) {
                            <button
                                    (click)="type.set(ChannelType.Voice)"
                                    [ngClass]="type() === ChannelType.Voice ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                                    class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                                <i class="pi pi-volume-up text-white/50"></i>
                                <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_VOICE' | translate }}</span>
                                <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_VOICE_DESC' | translate }}</span>
                            </button>
                        }
                        @if (canForum()) {
                            <button
                                    (click)="type.set(ChannelType.Forum)"
                                    [ngClass]="type() === ChannelType.Forum ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                                    class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                                <i class="pi pi-align-left text-white/50"></i>
                                <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_FORUM' | translate }}</span>
                                <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_FORUM_DESC' | translate }}</span>
                            </button>
                        }
                        @if (canAnnouncement()) {
                            <button
                                    (click)="type.set(ChannelType.Announcement)"
                                    [ngClass]="type() === ChannelType.Announcement ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                                    class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                                <i class="pi pi-megaphone text-white/50"></i>
                                <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT' | translate }}</span>
                                <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_ANNOUNCEMENT_DESC' | translate }}</span>
                            </button>
                        }
                        @if (canForum()) {
                            <button
                                    (click)="type.set(ChannelType.Media)"
                                    [ngClass]="type() === ChannelType.Media ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                                    class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                                <i class="pi pi-images text-white/50"></i>
                                <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_MEDIA' | translate }}</span>
                                <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_MEDIA_DESC' | translate }}</span>
                            </button>
                        }
                    </div>
                </div>

                <!-- Household types. Absent entirely in a guild with no household module,
                     so a Community server's picker looks exactly as it always did. -->
                @if (householdTypes().length > 0) {
                    <div>
                        <p class="text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">{{ 'CHANNEL.GROUP_HOUSEHOLD' | translate }}</p>
                        <div class="grid grid-cols-2 gap-2">
                            @for (meta of householdTypes(); track meta.type) {
                                <button
                                        (click)="type.set(meta.type)"
                                        [ngClass]="type() === meta.type ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                                        class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                                    <i [class]="meta.icon" class="text-white/50"></i>
                                    <span class="text-sm font-medium text-white/80">{{ meta.labelKey | translate }}</span>
                                    <span class="text-[11px] text-white/35">{{ meta.descKey | translate }}</span>
                                </button>
                            }
                        </div>
                    </div>
                }
            </div>
        }
```

- [ ] **Step 4: Simplify the name field's glyph**

In the same file, replace the leading-glyph `<span>` (lines 73-85) with:

```html
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 font-bold text-sm pointer-events-none">
          @if (selectedIcon(); as iconClass) {
              <i [class]="iconClass" class="text-xs"></i>
          } @else {
              #
          }
        </span>
```

- [ ] **Step 5: Verify the build**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

- [ ] **Step 6: Run the full test suite**

Run: `./node_modules/.bin/ng test --watch=false`
Expected: PASS - 57 files / 679 tests, matching the baseline. No regressions.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/channel-list/components/create-channel-modal/
git commit -m "feat: offer household channel types in the create-channel picker"
```

---

## Manual verification

After Task 9, confirm the two behaviours that no unit test covers. Run `./node_modules/.bin/ng serve` (port 1420) or the Tauri shell.

1. **A Community guild is unchanged.** Open any existing server: the channel sidebar, the create-channel modal (five chat types, no "Household" section, no group headers if only Text is available), and the roles settings permission list (no Lists/Chores/Ledger/Pantry/Decisions/Guests groups) all look exactly as they did before.
2. **A household channel is inert.** In a Household guild, open `# groceries`: it shows the placeholder with the list icon and the "List" chip, **and no message composer anywhere on screen**. This is the single behaviour the whole plan exists to guarantee.

## What this plan does not deliver

No working household feature. At the end of Task 9 a shopping list is a placeholder, not a shopping list. That is the intended end state: the modules are eight follow-up plans, each of which now has channel types, permissions, gating and routing to build on. The user-visible improvement here is the removal of a composer that silently posted nowhere.
