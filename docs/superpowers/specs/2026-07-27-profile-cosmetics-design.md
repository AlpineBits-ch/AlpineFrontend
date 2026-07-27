# Profile Cosmetics (Banner, Accent Color, Font) — Design

## Context

The Social backend added profile cosmetics: `bannerUrl`, `accentColor`, and `font` on
`ProfileDto`, plus `GET/PATCH .../profiles/{id}/banner` and a new general-purpose
`PATCH .../profiles/me` for bio/accentColor/font. Presence changes are backend-only and need
no frontend work (SignalR payload shape is unchanged; connect/disconnect now also fires the
existing `guild.PresenceChanged` event, which the client already handles).

This spec covers the frontend implementation: data model, service layer, settings UI, the
profile popover, and applying the user's chosen font/accent color to their username wherever
it renders in the app.

Full backend spec is reproduced in the task that spawned this doc; key points restated where
relevant below.

## Scope decisions (confirmed with user)

- Font/accent color apply to the **profile popover card** *and* to the **username label**
  everywhere it renders (member list, message author header, mention chips, mention
  autocomplete) — not to message body text.
- The `font` enum maps to **real bundled webfonts** (via `@fontsource`), not generic system
  font stacks.
- Banner upload gets a **real rectangular crop** (extending `ImageCropperComponent`), not a
  direct unrocked upload.

## 1. Data model

`src/app/dtos/response/profile.dto.ts`:

```ts
export enum ProfileFont {
    Default = 'Default',
    Serif = 'Serif',
    Monospace = 'Monospace',
    Rounded = 'Rounded',
    Display = 'Display',
    Handwritten = 'Handwritten',
}

export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    bannerUrl: string | undefined;      // new — always present, may 404 like avatar
    accentColor: string | null;         // new — hex string or null
    font: ProfileFont;                  // new
    onlineStatus: OnlineStatus;
}
```

`FALLBACK_PROFILE` in `profile.service.ts` gets `bannerUrl: undefined, accentColor: null,
font: ProfileFont.Default` added so the circuit-breaker fallback stays a valid `ProfileDto`.

No changes needed to `GuildMemberDto`/`SelfGuildMemberDto` — they embed `ProfileDto` directly,
so the new fields flow through automatically.

## 2. Font/color infrastructure

New file `src/app/models/profile-font.model.ts`, mirroring the existing
`COLOR_LABELS`/`COLOR_GROUPS` pattern in `theme.model.ts`:

```ts
export const FONT_LABELS: Record<ProfileFont, string> = {
    Default: 'Default',
    Serif: 'Serif',
    Monospace: 'Monospace',
    Rounded: 'Rounded',
    Display: 'Display',
    Handwritten: 'Handwritten',
};

export const FONT_STACKS: Record<ProfileFont, string> = {
    Default: 'var(--font-sans)',
    Serif: "'Lora Variable', Georgia, 'Times New Roman', serif",
    Monospace: "'Fira Code Variable', 'Cascadia Code', 'Menlo', monospace",
    Rounded: "'Quicksand Variable', system-ui, sans-serif",
    Display: "'Bebas Neue', Impact, sans-serif",
    Handwritten: "'Caveat Variable', cursive",
};

export function userNameStyle(
    profile: { accentColor?: string | null; font?: ProfileFont } | null | undefined,
): { color?: string; fontFamily?: string } {
    const style: { color?: string; fontFamily?: string } = {};
    if (profile?.accentColor) style.color = profile.accentColor;
    if (profile?.font && profile.font !== ProfileFont.Default) {
        style.fontFamily = FONT_STACKS[profile.font];
    }
    return style;
}
```

Webfont bundling — same mechanism as the existing `@fontsource-variable/inter` setup
(`angular.json` → `styles`, `package.json` → dependency):

| Enum value | Package |
|---|---|
| Serif | `@fontsource-variable/lora` |
| Monospace | `@fontsource-variable/fira-code` |
| Rounded | `@fontsource-variable/quicksand` |
| Display | `@fontsource/bebas-neue` (single weight, not variable) |
| Handwritten | `@fontsource-variable/caveat` |

`Default` needs no package — it resolves to the app's existing `--font-sans` (Inter).

## 3. Service layer

`ProfileService` additions, following the existing `tap(set ownProfile + store)` convention:

```ts
public updateProfile(patch: { bio?: string; accentColor?: string; font?: ProfileFont }): Observable<ProfileDto> {
    return this.httpClient
        .patch<ProfileDto>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/me`, patch)
        .pipe(tap(p => { this.ownProfile.set(p); this.store(p); }));
}

public uploadBanner(file: File): Observable<ProfileDto> {
    const current = this.ownProfile();
    if (!current) return EMPTY;
    const form = new FormData();
    form.append('file', file, file.name);
    return this.httpClient
        .patch<ProfileDto>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/banner`, form)
        .pipe(tap(p => { this.ownProfile.set(p); this.store(p); }));
}
```

No `removeBanner()` — the backend spec defines no DELETE endpoint for banner (unlike avatar),
so there is no remove action to wire up.

`profile.service.spec.ts` gets test cases for both new methods (success + the `EMPTY` guard
when there's no current profile), matching the existing avatar-upload test shape.

## 4. `ImageCropperComponent` — rectangular crop

Currently the component has a hardcoded square crop box (`CROP = 240`) and a single
`outputSize` input, used only for circular avatars. Banners need a wide rectangle.

Change: replace `outputSize: input(400)` with `outputWidth: input(400)` /
`outputHeight: input(400)`. The crop box aspect ratio is derived from
`outputWidth() / outputHeight()` rather than being a separate input — avatar call sites keep
passing equal width/height (still square), so `circular=true` continues to work unchanged.

Internals: `CROP` (a single number) becomes `cropWidth`/`cropHeight`, computed once from the
available draw area (`SIZE - 2*PAD`) scaled to fit the target aspect ratio. `minScale`,
`clamp`, and `draw`'s crop-rectangle math change from one dimension to two independent
dimensions; `confirmCrop`'s output canvas takes `outputWidth()`×`outputHeight()` instead of a
single `size`, and the source-rect sampling (`srcSize`) becomes `srcW`/`srcH`.

Avatar usage (`profile-settings.component.html`) changes only `[outputSize]="400"` →
`[outputWidth]="400" [outputHeight]="400"`. Banner usage is new:
`[outputWidth]="1200" [outputHeight]="400" [circular]="false"`.

## 5. Settings UI (`profile-settings` page)

**Banner section** (new, placed after the existing Avatar section): same
upload-button-triggers-hidden-file-input → `FileReader` → crop dialog → confirm → upload flow
as Avatar, reusing the (now rectangular) cropper. No remove button (see §3). Rendered as a
`background-image` strip above the section, matching `.profile-banner` styling already defined
in `profile-dialog.component.css` (reused/shared, not duplicated).

**Accent Color control** (new, in the Display section): reuses the exact swatch + native
`<input type="color">` pattern from `appearance-settings.component.html`'s color grid — a
small preview square plus the native picker overlaid on it. A "Clear" text button next to it
sets the pending value to `''` (spec: empty string clears).

**Font control** (new, in the Display section): a simple `<select>` (or PrimeNG `Select`) over
the 6 `FONT_LABELS` entries, with a live preview line below it rendered in
`FONT_STACKS[selected]`, similar in spirit to the existing font-size preview block in
Appearance settings.

**Bio field**: currently rendered `disabled` with a "Coming soon" placeholder despite the DTO
already having a `bio` field — there was no save endpoint. Now there is
(`PATCH .../profiles/me`). Un-disable it. Bio + Accent Color + Font are batched behind one
"Save Changes" button (dirty-tracking against `ownProfile()`, single `updateProfile()` call on
click) rather than saving per-keystroke or per-field — consistent with how the existing
Change Password section batches its three fields behind one submit action.

**Display Name stays disabled** — the spec explicitly excludes username from this endpoint;
no change to that field's current "Coming soon" treatment.

## 6. Profile popover (`ProfileDialogComponent`)

The component already fetches the full `ProfileDto` into a `profile` signal and has a
`.profile-banner` CSS class — but its `@Input() bannerUrl` is dead code (grepped: no caller
passes it; `main-page.component.html` only binds `[userId]`). Remove the `@Input()` and read
`profile()?.bannerUrl` directly instead.

- Banner: `background-image` from `profile()?.bannerUrl` when present; when absent, fall back
  to a solid `background` using `profile()?.accentColor` instead of the current always-null
  background. If both are absent, keep today's default (no image, no color — existing
  `.profile-banner` base styling).
- Avatar-initials fallback circle: currently hardcoded `bg-brand`. When `accentColor` is set,
  override via `[style.background]` with the accent color; otherwise keep `bg-brand`.
- Username heading (`<h2>`): apply `[appUserNameStyle]="profile()"` (see §7).

## 7. Shared username styling directive

No existing helper computes a display name's visual style — five render sites each read
`userName` independently. Introduce one shared, narrow attribute directive rather than
duplicating the same `[style.color]`/`[style.fontFamily]` bindings five times:

```ts
// src/app/directives/user-name-style.directive.ts
@Directive({ selector: '[appUserNameStyle]' })
export class UserNameStyleDirective {
    appUserNameStyle = input<{ accentColor?: string | null; font?: ProfileFont } | null | undefined>(null);
    @HostBinding('style.color') protected get color() { return userNameStyle(this.appUserNameStyle()).color; }
    @HostBinding('style.fontFamily') protected get fontFamily() { return userNameStyle(this.appUserNameStyle()).fontFamily; }
}
```

Applied at:

| Site | File | Data source |
|---|---|---|
| Member list rows (online + offline) | `guild-member-list.component.html` | `member.profile` |
| Guild-settings member table | `members-settings.component.html` | `row.profile` |
| Message author header | `message.component.html` | `user` (from `getProfile()`) |
| Reply-reference author name | `message.component.ts`/`.html` | `profileService.getCachedByUserId(...)` (already a full cached `ProfileDto`) |
| Resolved `@mention` chip (sent messages) | `message.component.html` | matched entry in `mentionedProfiles` |
| Mention-autocomplete dropdown row | `suggestion-overlay.component.html` | `m` (`UserMentionCandidate`, extended — see below) |

`UserMentionCandidate` (`composer-utils.ts`) gets two new optional fields:
`accentColor?: string | null; font?: ProfileFont`. Populated only where a full profile is
already available — the guild-member-search candidate builder in `composer.component.ts`
(`m.profile?.accentColor`, `m.profile?.font`). The DM/conversation-member candidate builder in
`conversation.component.ts` only has a cached username string (`cachedUserName`), not a full
profile, so those candidates leave the new fields `undefined` — the directive/helper already
treats `undefined` as "use defaults," so this degrades gracefully rather than breaking.

**Composer live-typing chip** (`composer.component.ts`'s `onMentionSelected`, which builds a
`mention-chip` span imperatively via raw DOM, not a template) is not a directive target. It
applies the same `userNameStyle()` pure function directly:
`Object.assign(chip.style, userNameStyle(candidate))`.

## 8. Presence

No frontend changes. Confirmed: `guild.PresenceChanged` payload shape is unchanged and already
handled; the "fires on connect/disconnect too" behavior is transparent to the client — it's the
same event, just fired more often.

## Out of scope

- Removing a previously-uploaded banner (no backend endpoint for it yet).
- Fetching full profiles for DM mention-autocomplete just to show accent/font (would add a new
  N+1 profile-fetch dependency into the conversation member list for a cosmetic-only gain).
- Applying accent color/font to message *body* text (confirmed: name label only).
- Editing username/display name (explicitly excluded by the backend spec).
