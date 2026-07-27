# Profile Cosmetics (Banner, Accent Color, Font) + Self-Profile Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend-driven profile cosmetics (banner image, accent color, custom font) to
Alpine's frontend — settings UI to edit them, propagation of the font/color to every place a
username renders, and a Discord-style anchored popover for viewing/editing your own profile
(replacing the current centered modal for that one case).

**Architecture:** Extend `ProfileDto` and `ProfileService` to carry/persist the three new
fields. Add a small pure-function + directive layer (`userNameStyle()` /
`UserNameStyleDirective`) that turns `{accentColor, font}` into `{color, fontFamily}` and apply
it at every existing username render site. Generalize the existing square `ImageCropperComponent`
to arbitrary output dimensions so it can crop wide banners as well as square avatars. Extract the
presentational half of `ProfileDialogComponent` into a reusable `ProfileCardComponent` so the new
anchored self-profile popover and the existing centered other-user dialog share one
banner/avatar/name template instead of two.

**Tech Stack:** Angular 21 (signals: `input()`, `computed()`, `effect()`), PrimeNG 21
(`primeng/popover` newly introduced, `primeng/select`, `primeng/menu`, `primeng/dialog` already in
use), Tailwind CSS v4, `@fontsource`/`@fontsource-variable` for bundled webfonts, RxJS.

## Global Constraints

- Follow the existing `ProfileService` convention: every mutating HTTP call ends with
  `.pipe(tap(p => { this.ownProfile.set(p); this.store(p); }))`.
- All Social endpoints are called through the gateway prefix `/api/v1/social/...` — never the
  internal `/api/v1/...` form.
- No `removeBanner()` — the backend spec defines no DELETE endpoint for banner.
- Username is not editable anywhere in this feature (backend spec excludes it from
  `PATCH .../profiles/me`) — the Display Name field stays disabled.
- Accent color and font apply to the username **label only**, never to message body text.
- New standalone components/directives follow the codebase's existing style: signal `input()`s
  (not `@Input()` decorators) except where extending an existing decorator-based file.
- Run `ng test` after every task that touches a file with a `.spec.ts`, and `ng build` at the end
  of the plan to catch any TypeScript/template compile errors across the whole surface.

---

### Task 1: Data model — `ProfileDto` cosmetics fields

**Files:**
- Modify: `src/app/dtos/response/profile.dto.ts`
- Modify: `src/app/services/profile.service.ts` (`FALLBACK_PROFILE` only)
- Modify: `src/app/services/profile.service.spec.ts` (existing literal fixtures)

**Interfaces:**
- Produces: `ProfileFont` enum, `ProfileDto.bannerUrl: string | undefined`,
  `ProfileDto.accentColor: string | null`, `ProfileDto.font: ProfileFont` — consumed by every
  later task.

- [ ] **Step 1: Add `ProfileFont` enum and the three new fields to `ProfileDto`**

Edit `src/app/dtos/response/profile.dto.ts` — it currently reads:

```ts
export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    onlineStatus: OnlineStatus;
}

export enum OnlineStatus {
    Offline = 'Offline',
    Hidden = 'Hidden',
    Online = 'Online',
    Idle = 'Idle',
    DoNotDisturb = 'DoNotDisturb',
}
```

Replace it with:

```ts
export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    bannerUrl: string | undefined;
    accentColor: string | null;
    font: ProfileFont;
    onlineStatus: OnlineStatus;
}

export enum OnlineStatus {
    Offline = 'Offline',
    Hidden = 'Hidden',
    Online = 'Online',
    Idle = 'Idle',
    DoNotDisturb = 'DoNotDisturb',
}

export enum ProfileFont {
    Default = 'Default',
    Serif = 'Serif',
    Monospace = 'Monospace',
    Rounded = 'Rounded',
    Display = 'Display',
    Handwritten = 'Handwritten',
}
```

- [ ] **Step 2: Update `FALLBACK_PROFILE` in `profile.service.ts`**

It currently reads (near the top of the file):

```ts
const FALLBACK_PROFILE: ProfileDto = {
    id: 'unknown',
    userId: 'unknown',
    userName: 'Unknown User',
    bio: undefined,
    avatarUrl: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
    onlineStatus: OnlineStatus.Offline,
};
```

Add the three new fields and import `ProfileFont`:

```ts
import {OnlineStatus, ProfileDto, ProfileFont} from '../dtos/response/profile.dto';

const FALLBACK_PROFILE: ProfileDto = {
    id: 'unknown',
    userId: 'unknown',
    userName: 'Unknown User',
    bio: undefined,
    avatarUrl: undefined,
    bannerUrl: undefined,
    accentColor: null,
    font: ProfileFont.Default,
    createdAt: new Date(),
    updatedAt: new Date(),
    onlineStatus: OnlineStatus.Offline,
};
```

- [ ] **Step 3: Fix the two existing `ProfileDto` literals in `profile.service.spec.ts`**

They currently read:

```ts
service['ownProfile'].set({
    id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
    createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
});
```

and

```ts
req.flush({
    id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
    createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.DoNotDisturb,
});
```

Add the three fields to both (import `ProfileFont` from `../dtos/response/profile.dto` at the
top alongside the existing `OnlineStatus` import):

```ts
service['ownProfile'].set({
    id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
    bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
    createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
});
```

```ts
req.flush({
    id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
    bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
    createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.DoNotDisturb,
});
```

The `req.flush({onlineStatus: 'Idle'})` call in the first test (`PATCHes .../status`) is a
partial response used only to check the request shape, not `ownProfile()` afterward — leave it
unchanged.

- [ ] **Step 4: Run the test suite to confirm the DTO change compiles and passes**

Run: `ng test`
Expected: PASS (no TypeScript errors, both existing `ProfileService.setSelfStatus` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/app/dtos/response/profile.dto.ts src/app/services/profile.service.ts src/app/services/profile.service.spec.ts
git commit -m "feat: add bannerUrl/accentColor/font fields to ProfileDto"
```

---

### Task 2: Font infrastructure — `profile-font.model.ts` + bundled webfonts

**Files:**
- Create: `src/app/models/profile-font.model.ts`
- Create: `src/app/models/profile-font.model.spec.ts`
- Modify: `package.json` (via `npm install`, not hand-edited)
- Modify: `angular.json` (`styles` array)

**Interfaces:**
- Consumes: `ProfileFont` (Task 1).
- Produces: `FONT_LABELS: Record<ProfileFont, string>`, `FONT_STACKS: Record<ProfileFont, string>`,
  `userNameStyle(profile): {color?: string; fontFamily?: string}` — consumed by
  `UserNameStyleDirective` (Task 5), the composer's imperative chip builder (Task 11), and the
  Font `<p-select>` in settings (Task 12).

- [ ] **Step 1: Install the five webfont packages**

Run: `npm install @fontsource-variable/lora @fontsource-variable/fira-code @fontsource-variable/quicksand @fontsource/bebas-neue @fontsource-variable/caveat`

This mirrors how `@fontsource-variable/inter` was already added for the app's base sans font.

- [ ] **Step 2: Register the new font CSS in `angular.json`**

The `styles` array in the `build` target currently reads:

```json
"styles": [
  "src/styles.css",
  "node_modules/primeicons/primeicons.css",
  "node_modules/@fontsource-variable/inter/index.css"
],
```

Change it to:

```json
"styles": [
  "src/styles.css",
  "node_modules/primeicons/primeicons.css",
  "node_modules/@fontsource-variable/inter/index.css",
  "node_modules/@fontsource-variable/lora/index.css",
  "node_modules/@fontsource-variable/fira-code/index.css",
  "node_modules/@fontsource-variable/quicksand/index.css",
  "node_modules/@fontsource/bebas-neue/index.css",
  "node_modules/@fontsource-variable/caveat/index.css"
],
```

- [ ] **Step 3: Write the failing test for `userNameStyle()`**

Create `src/app/models/profile-font.model.spec.ts`:

```ts
import {ProfileFont} from '../dtos/response/profile.dto';
import {FONT_STACKS, userNameStyle} from './profile-font.model';

describe('userNameStyle', () => {
    it('returns an empty object for null/undefined input', () => {
        expect(userNameStyle(null)).toEqual({});
        expect(userNameStyle(undefined)).toEqual({});
    });

    it('returns no color when accentColor is null', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Default})).toEqual({});
    });

    it('returns the accent color when set', () => {
        expect(userNameStyle({accentColor: '#5865F2', font: ProfileFont.Default}))
            .toEqual({color: '#5865F2'});
    });

    it('omits fontFamily for ProfileFont.Default', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Default})).toEqual({});
    });

    it('returns the mapped font-family for a non-default font', () => {
        expect(userNameStyle({accentColor: null, font: ProfileFont.Serif}))
            .toEqual({fontFamily: FONT_STACKS[ProfileFont.Serif]});
    });

    it('returns both color and fontFamily together', () => {
        expect(userNameStyle({accentColor: '#ff0000', font: ProfileFont.Monospace}))
            .toEqual({color: '#ff0000', fontFamily: FONT_STACKS[ProfileFont.Monospace]});
    });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `ng test`
Expected: FAIL — `Cannot find module './profile-font.model'`.

- [ ] **Step 5: Implement `profile-font.model.ts`**

Create `src/app/models/profile-font.model.ts`:

```ts
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

export function userNameStyle(
    profile: UserNameStyleInput | null | undefined,
): { color?: string; fontFamily?: string } {
    const style: { color?: string; fontFamily?: string } = {};
    if (profile?.accentColor) style.color = profile.accentColor;
    if (profile?.font && profile.font !== ProfileFont.Default) {
        style.fontFamily = FONT_STACKS[profile.font];
    }
    return style;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `ng test`
Expected: PASS — all 6 `userNameStyle` cases green.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json angular.json src/app/models/profile-font.model.ts src/app/models/profile-font.model.spec.ts
git commit -m "feat: add profile font infrastructure and bundle five webfonts"
```

---

### Task 3: `ProfileService.updateProfile()` and `.uploadBanner()`

**Files:**
- Modify: `src/app/services/profile.service.ts`
- Modify: `src/app/services/profile.service.spec.ts`

**Interfaces:**
- Consumes: `ProfileFont` (Task 1).
- Produces: `ProfileService.updateProfile(patch: {bio?: string; accentColor?: string; font?: ProfileFont}): Observable<ProfileDto>`,
  `ProfileService.uploadBanner(file: File): Observable<ProfileDto>` — consumed by the settings
  page (Task 12).

- [ ] **Step 1: Write the failing tests**

Append to `src/app/services/profile.service.spec.ts`:

```ts
describe('ProfileService.updateProfile', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PATCHes /api/v1/social/profiles/me with the patch body', () => {
        const {service, ctrl} = setup();
        service.updateProfile({bio: 'hi', accentColor: '#5865F2', font: ProfileFont.Serif}).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me');
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({bio: 'hi', accentColor: '#5865F2', font: 'Serif'});
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: 'hi', avatarUrl: undefined,
            bannerUrl: undefined, accentColor: '#5865F2', font: ProfileFont.Serif,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
    });

    it('updates ownProfile signal on success', () => {
        const {service, ctrl} = setup();
        service.updateProfile({bio: 'hi'}).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me');
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: 'hi', avatarUrl: undefined,
            bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        expect(service.ownProfile()?.bio).toBe('hi');
    });
});

describe('ProfileService.uploadBanner', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('does nothing when there is no current profile', () => {
        const {service, ctrl} = setup();
        const file = new File(['x'], 'banner.png', {type: 'image/png'});
        let completed = false;
        service.uploadBanner(file).subscribe({complete: () => completed = true});
        expect(completed).toBe(true);
        ctrl.verify();
    });

    it('PATCHes /api/v1/social/profiles/{id}/banner with FormData', () => {
        const {service, ctrl} = setup();
        service['ownProfile'].set({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            bannerUrl: undefined, accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        const file = new File(['x'], 'banner.png', {type: 'image/png'});
        service.uploadBanner(file).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/p1/banner');
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body instanceof FormData).toBe(true);
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            bannerUrl: 'https://cdn.example/banner.png', accentColor: null, font: ProfileFont.Default,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        expect(service.ownProfile()?.bannerUrl).toBe('https://cdn.example/banner.png');
    });
});
```

Add `ProfileFont` to the existing import line at the top of the file:
`import {OnlineStatus, ProfileDto, ProfileFont} from '../dtos/response/profile.dto';` (it's
already imported as part of Task 1, Step 3 — just confirm it's there).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `ng test`
Expected: FAIL — `service.updateProfile is not a function`, `service.uploadBanner is not a function`.

- [ ] **Step 3: Implement both methods**

Add to `ProfileService`, directly after the existing `setSelfStatus` method:

```ts
public updateProfile(patch: { bio?: string; accentColor?: string; font?: ProfileFont }): Observable<ProfileDto> {
    return this.httpClient
        .patch<ProfileDto>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/me`, patch)
        .pipe(tap(p => {
            this.ownProfile.set(p);
            this.store(p);
        }));
}
```

Add directly after the existing `uploadAvatar` method:

```ts
public uploadBanner(file: File): Observable<ProfileDto> {
    const current = this.ownProfile();
    if (!current) return EMPTY;
    const form = new FormData();
    form.append('file', file, file.name);
    return this.httpClient
        .patch<ProfileDto>(
            `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${current.id}/banner`,
            form,
        )
        .pipe(tap(p => {
            this.ownProfile.set(p);
            this.store(p);
        }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `ng test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/profile.service.ts src/app/services/profile.service.spec.ts
git commit -m "feat: add ProfileService.updateProfile and uploadBanner"
```

---

### Task 4: Generalize `ImageCropperComponent` to rectangular output

**Files:**
- Modify: `src/app/components/image-cropper/image-cropper.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html` (avatar cropper call site only — the `outputSize` → `outputWidth`/`outputHeight` rename)

**Interfaces:**
- Produces: `ImageCropperComponent` inputs `outputWidth = input(400)`,
  `outputHeight = input(400)` (replacing `outputSize`), aspect ratio derived as
  `outputWidth() / outputHeight()`. `circular` input unchanged. Consumed by Task 12 (banner crop
  dialog) and the existing avatar crop dialog (call-site update in this task).

- [ ] **Step 1: Replace `outputSize` with `outputWidth`/`outputHeight` and generalize the crop box**

Edit `src/app/components/image-cropper/image-cropper.component.ts`. The full current file is 222
lines; the changes are:

Replace:

```ts
    imageSrc = input.required<string>();
    circular = input(false);
    outputSize = input(400);
```

with:

```ts
    imageSrc = input.required<string>();
    circular = input(false);
    outputWidth = input(400);
    outputHeight = input(400);
```

Replace the three fixed-crop-box constants:

```ts
    private readonly SIZE = 320;
    private readonly CROP = 240;
    private readonly PAD = 40;
```

with a computed pair of crop dimensions derived from the target aspect ratio, fit inside the same
240×240 available area used today:

```ts
    private readonly SIZE = 320;
    private readonly MAX_CROP = 240;
    private readonly PAD = 40;

    private get cropWidth(): number {
        const ratio = this.outputWidth() / this.outputHeight();
        return ratio >= 1 ? this.MAX_CROP : this.MAX_CROP * ratio;
    }

    private get cropHeight(): number {
        const ratio = this.outputWidth() / this.outputHeight();
        return ratio >= 1 ? this.MAX_CROP / ratio : this.MAX_CROP;
    }
```

Every remaining use of `this.CROP` becomes `this.cropWidth`/`this.cropHeight` depending on which
axis it constrains. Replace `ngAfterViewInit`'s initial-scale calculation:

```ts
            this.scale = Math.max(
                this.CROP / this.img.naturalWidth,
                this.CROP / this.img.naturalHeight,
            );
```

with:

```ts
            this.scale = Math.max(
                this.cropWidth / this.img.naturalWidth,
                this.cropHeight / this.img.naturalHeight,
            );
```

Replace `minScale()`:

```ts
    private minScale(): number {
        return Math.max(this.CROP / this.img.naturalWidth, this.CROP / this.img.naturalHeight);
    }
```

with:

```ts
    private minScale(): number {
        return Math.max(this.cropWidth / this.img.naturalWidth, this.cropHeight / this.img.naturalHeight);
    }
```

Replace `clamp()`:

```ts
    private clamp(): void {
        const maxX = (this.img.naturalWidth * this.scale - this.CROP) / 2;
        const maxY = (this.img.naturalHeight * this.scale - this.CROP) / 2;
        this.offsetX = Math.max(-maxX, Math.min(maxX, this.offsetX));
        this.offsetY = Math.max(-maxY, Math.min(maxY, this.offsetY));
    }
```

with:

```ts
    private clamp(): void {
        const maxX = (this.img.naturalWidth * this.scale - this.cropWidth) / 2;
        const maxY = (this.img.naturalHeight * this.scale - this.cropHeight) / 2;
        this.offsetX = Math.max(-maxX, Math.min(maxX, this.offsetX));
        this.offsetY = Math.max(-maxY, Math.min(maxY, this.offsetY));
    }
```

Replace `confirmCrop()`:

```ts
    protected confirmCrop(): void {
        const size = this.outputSize();
        const out = document.createElement('canvas');
        out.width = size;
        out.height = size;
        const ctx = out.getContext('2d')!;

        const w = this.img.naturalWidth * this.scale;
        const h = this.img.naturalHeight * this.scale;
        const imgLeft = this.SIZE / 2 + this.offsetX - w / 2;
        const imgTop = this.SIZE / 2 + this.offsetY - h / 2;

        const srcX = (this.PAD - imgLeft) / this.scale;
        const srcY = (this.PAD - imgTop) / this.scale;
        const srcSize = this.CROP / this.scale;

        if (this.circular()) {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
            ctx.clip();
        }

        ctx.drawImage(this.img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);

        out.toBlob(blob => {
            if (!blob) return;
            this.confirmed.emit(new File([blob], 'cropped.png', {type: 'image/png'}));
        }, 'image/png');
    }
```

with:

```ts
    protected confirmCrop(): void {
        const outW = this.outputWidth();
        const outH = this.outputHeight();
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const ctx = out.getContext('2d')!;

        const w = this.img.naturalWidth * this.scale;
        const h = this.img.naturalHeight * this.scale;
        const imgLeft = this.SIZE / 2 + this.offsetX - w / 2;
        const imgTop = this.SIZE / 2 + this.offsetY - h / 2;

        const srcX = (this.PAD - imgLeft) / this.scale;
        const srcY = (this.PAD - imgTop) / this.scale;
        const srcW = this.cropWidth / this.scale;
        const srcH = this.cropHeight / this.scale;

        if (this.circular()) {
            ctx.beginPath();
            ctx.ellipse(outW / 2, outH / 2, outW / 2, outH / 2, 0, 0, Math.PI * 2);
            ctx.clip();
        }

        ctx.drawImage(this.img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

        out.toBlob(blob => {
            if (!blob) return;
            this.confirmed.emit(new File([blob], 'cropped.png', {type: 'image/png'}));
        }, 'image/png');
    }
```

First, in `draw()`, replace the top declarations (removing the now-nonexistent `this.CROP`
reference; `S` and the image-drawing lines below are unchanged):

```ts
        const S = this.SIZE;
        const C = this.CROP;
        const P = this.PAD;
```

with:

```ts
        const S = this.SIZE;
```

Then replace `draw()`'s crop-rectangle section (keep the image-drawing line above it unchanged):

```ts
        // Dark overlay with crop hole via even-odd fill rule
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, S, S);
        if (this.circular()) {
            ctx.arc(S / 2, S / 2, C / 2, 0, Math.PI * 2, true);
        } else {
            ctx.rect(P, P, C, C);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fill('evenodd');
        ctx.restore();

        // Crop border
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        if (this.circular()) {
            ctx.beginPath();
            ctx.arc(S / 2, S / 2, C / 2, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.strokeRect(P, P, C, C);
            // Rule-of-thirds guides
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            for (let i = 1; i < 3; i++) {
                ctx.moveTo(P + (C / 3) * i, P);
                ctx.lineTo(P + (C / 3) * i, P + C);
                ctx.moveTo(P, P + (C / 3) * i);
                ctx.lineTo(P + C, P + (C / 3) * i);
            }
            ctx.stroke();
        }
    }
```

with (introducing local `cw`/`ch` and centered `left`/`top` since the crop box is no longer
necessarily centered on the fixed `PAD` offset when it's narrower than the 240 max on one axis):

```ts
        const cw = this.cropWidth;
        const ch = this.cropHeight;
        const left = (S - cw) / 2;
        const top = (S - ch) / 2;

        // Dark overlay with crop hole via even-odd fill rule
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, S, S);
        if (this.circular()) {
            ctx.arc(S / 2, S / 2, cw / 2, 0, Math.PI * 2, true);
        } else {
            ctx.rect(left, top, cw, ch);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fill('evenodd');
        ctx.restore();

        // Crop border
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        if (this.circular()) {
            ctx.beginPath();
            ctx.arc(S / 2, S / 2, cw / 2, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.strokeRect(left, top, cw, ch);
            // Rule-of-thirds guides
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            for (let i = 1; i < 3; i++) {
                ctx.moveTo(left + (cw / 3) * i, top);
                ctx.lineTo(left + (cw / 3) * i, top + ch);
                ctx.moveTo(left, top + (ch / 3) * i);
                ctx.lineTo(left + cw, top + (ch / 3) * i);
            }
            ctx.stroke();
        }
    }
```

(The `PAD` field itself is still used in `confirmCrop`, so it stays on the class — only the
unused local `P`/`C` aliases inside `draw()` are removed.)

- [ ] **Step 2: Update the avatar crop dialog call site**

In `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html`,
change:

```html
        <app-image-cropper
                (cancelled)="cropVisible.set(false)"
                (confirmed)="onCropConfirmed($event)"
                [circular]="true"
                [imageSrc]="cropSrc()"
                [outputSize]="400"/>
```

to:

```html
        <app-image-cropper
                (cancelled)="cropVisible.set(false)"
                (confirmed)="onCropConfirmed($event)"
                [circular]="true"
                [imageSrc]="cropSrc()"
                [outputWidth]="400"
                [outputHeight]="400"/>
```

- [ ] **Step 3: Manually verify the avatar crop still works**

Run: `ng serve`, open Settings → Profile → Change Avatar, pick an image, confirm the circular
crop still previews and drags/zooms correctly (square aspect ratio, `outputWidth === outputHeight`
so this is behavior-preserving), then cancel out (no need to actually upload).

Expected: identical square drag/zoom/crop behavior to before this task.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/image-cropper/image-cropper.component.ts src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html
git commit -m "refactor: generalize ImageCropperComponent to arbitrary output aspect ratio"
```

---

### Task 5: Shared `UserNameStyleDirective`

**Files:**
- Create: `src/app/directives/user-name-style.directive.ts`
- Create: `src/app/directives/user-name-style.directive.spec.ts`

**Interfaces:**
- Consumes: `userNameStyle()` (Task 2).
- Produces: `UserNameStyleDirective`, selector `[appUserNameStyle]`, input
  `appUserNameStyle: UserNameStyleInput | null | undefined` — consumed by Tasks 6, 7, 8, 9, 10.

- [ ] **Step 1: Write the failing test**

Create `src/app/directives/user-name-style.directive.spec.ts`:

```ts
import {Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ProfileFont} from '../dtos/response/profile.dto';
import {UserNameStyleDirective} from './user-name-style.directive';

@Component({
    imports: [UserNameStyleDirective],
    template: `<span [appUserNameStyle]="profile">Name</span>`,
})
class HostComponent {
    profile: { accentColor?: string | null; font?: ProfileFont } | null = null;
}

describe('UserNameStyleDirective', () => {
    let fixture: ComponentFixture<HostComponent>;

    beforeEach(() => {
        fixture = TestBed.createComponent(HostComponent);
    });

    function span(): HTMLElement {
        return fixture.nativeElement.querySelector('span');
    }

    it('applies no inline style when profile is null', () => {
        fixture.componentInstance.profile = null;
        fixture.detectChanges();
        expect(span().style.color).toBe('');
        expect(span().style.fontFamily).toBe('');
    });

    it('applies color and font-family from the profile', () => {
        fixture.componentInstance.profile = {accentColor: '#ff0000', font: ProfileFont.Serif};
        fixture.detectChanges();
        expect(span().style.color).toBe('rgb(255, 0, 0)');
        expect(span().style.fontFamily).toContain('Lora Variable');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ng test`
Expected: FAIL — `Cannot find module './user-name-style.directive'`.

- [ ] **Step 3: Implement the directive**

Create `src/app/directives/user-name-style.directive.ts`:

```ts
import {Directive, HostBinding, input} from '@angular/core';
import {userNameStyle, UserNameStyleInput} from '../models/profile-font.model';

@Directive({
    selector: '[appUserNameStyle]',
})
export class UserNameStyleDirective {
    appUserNameStyle = input<UserNameStyleInput | null | undefined>(null);

    @HostBinding('style.color')
    protected get color(): string | undefined {
        return userNameStyle(this.appUserNameStyle()).color;
    }

    @HostBinding('style.fontFamily')
    protected get fontFamily(): string | undefined {
        return userNameStyle(this.appUserNameStyle()).fontFamily;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ng test`
Expected: PASS — both directive tests green.

- [ ] **Step 5: Commit**

```bash
git add src/app/directives/user-name-style.directive.ts src/app/directives/user-name-style.directive.spec.ts
git commit -m "feat: add UserNameStyleDirective for per-user font/accent color on name labels"
```

---

### Task 6: Extract `ProfileCardComponent` and wire cosmetics into `ProfileDialogComponent`

**Files:**
- Create: `src/app/components/profile-card/profile-card.component.ts`
- Create: `src/app/components/profile-card/profile-card.component.html`
- Create: `src/app/components/profile-card/profile-card.component.css`
- Modify: `src/app/components/profile-dialog/profile-dialog.component.ts`
- Modify: `src/app/components/profile-dialog/profile-dialog.component.html`
- Modify: `src/app/components/profile-dialog/profile-dialog.component.css`

**Interfaces:**
- Consumes: `UserNameStyleDirective` (Task 5), `ProfileDto` (Task 1).
- Produces: `ProfileCardComponent` (`app-profile-card`), inputs `profile: ProfileDto | undefined`,
  `friendsSince: Date | null` (default `null`), `avatarError: boolean` (default `false`), outputs
  `avatarClick: void`, `avatarErrorChange: void` — consumed by Task 7 (self-profile popover).

- [ ] **Step 1: Create `ProfileCardComponent`**

This extracts the `@if (profile(); as p) { ... }` banner/avatar/name/bio/dates block that
currently lives inline in `profile-dialog.component.html`, so it can be reused by the new
anchored popover without duplication. It takes plain `@Input`-style signal inputs (no dialog
chrome of its own — no close button, no `p-dialog` wrapper — that stays the caller's job).

Create `src/app/components/profile-card/profile-card.component.ts`:

```ts
import {Component, computed, input, output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {UserStatusDotComponent} from '../user-status-dot/user-status-dot.component';
import {UserNameStyleDirective} from '../../directives/user-name-style.directive';

@Component({
    selector: 'app-profile-card',
    imports: [DatePipe, UserStatusDotComponent, UserNameStyleDirective],
    templateUrl: './profile-card.component.html',
    styleUrl: './profile-card.component.css',
})
export class ProfileCardComponent {
    profile = input<ProfileDto | undefined>(undefined);
    friendsSince = input<Date | null>(null);
    avatarError = input(false);

    avatarClick = output<void>();
    avatarErrorChange = output<void>();

    protected avatarLabel = computed(() =>
        this.profile()?.userName?.[0]?.toUpperCase() ?? '?'
    );

    protected onAvatarClick(): void {
        if (this.profile()?.avatarUrl && !this.avatarError()) {
            this.avatarClick.emit();
        }
    }

    protected onAvatarError(): void {
        this.avatarErrorChange.emit();
    }
}
```

Create `src/app/components/profile-card/profile-card.component.html` — this is the existing
`profile-dialog.component.html` inner block, unchanged except: `bannerUrl` becomes
`profile()?.bannerUrl`, a fallback `accentColor` background is added, the avatar-fallback circle
uses `accentColor` when set, and the username heading gets `[appUserNameStyle]`:

```html
@if (profile(); as p) {
    <div class="relative">

        <!-- Banner -->
        <div [style.backgroundImage]="p.bannerUrl ? 'url(' + p.bannerUrl + ')' : null"
             [style.background]="!p.bannerUrl && p.accentColor ? p.accentColor : null"
             class="profile-banner"></div>

        <!-- Avatar (overlapping banner/body boundary) -->
        <div class="absolute left-4 z-10" style="top: 56px;">
            <div (click)="onAvatarClick()"
                 [class.cursor-pointer]="p.avatarUrl && !avatarError()"
                 class="relative">
                @if (p.avatarUrl && !avatarError()) {
                    <img
                            (error)="onAvatarError()"
                            [src]="p.avatarUrl"
                            alt="Profile avatar"
                            class="w-[88px] h-[88px] rounded-full object-cover ring-[3px] ring-card transition-opacity hover:opacity-90"/>
                } @else {
                    <div [style.background]="p.accentColor ?? null"
                         [class.bg-brand]="!p.accentColor"
                         class="w-[88px] h-[88px] rounded-full ring-[3px] ring-card flex items-center justify-center text-2xl font-bold text-white select-none">
                        {{ avatarLabel() }}
                    </div>
                }
                <app-user-status-dot
                        [status]="p.onlineStatus"
                        borderColor="border-card"
                        size="lg"/>
            </div>
        </div>

        <!-- Body -->
        <div class="px-4 pb-4" style="padding-top: 56px;">

            <h2 [appUserNameStyle]="p" class="text-[17px] font-bold leading-tight text-text-primary mb-1">
                {{ p.userName }}
            </h2>

            @if (p.bio) {
                <p class="text-sm text-text-secondary leading-snug mb-3">{{ p.bio }}</p>
            }

            <div class="border-t border-border-subtle my-3"></div>

            <div class="flex flex-col gap-2.5">
                <div class="flex flex-col gap-0.5">
                    <span class="text-[10px] font-semibold tracking-widest uppercase text-text-muted">Member Since</span>
                    <span class="text-sm text-text-secondary">{{ p.createdAt | date:'MMM d, yyyy' }}</span>
                </div>
                @if (friendsSince()) {
                    <div class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold tracking-widest uppercase text-text-muted">Friends Since</span>
                        <span class="text-sm text-text-secondary">{{ friendsSince() | date:'MMM d, yyyy' }}</span>
                    </div>
                }
            </div>

        </div>
    </div>
} @else {
    <!-- Loading skeleton -->
    <div class="relative">
        <div class="profile-banner"></div>
        <div class="px-4 pb-5" style="padding-top: 56px;">
            <div class="h-4 w-36 bg-white/[0.08] rounded-md animate-pulse mb-2 mt-1"></div>
            <div class="h-3 w-24 bg-white/[0.05] rounded-md animate-pulse mb-4"></div>
            <div class="border-t border-border-subtle my-3"></div>
            <div class="h-3 w-20 bg-white/[0.05] rounded-md animate-pulse mb-1.5"></div>
            <div class="h-3 w-28 bg-white/[0.08] rounded-md animate-pulse"></div>
        </div>
    </div>
}
```

Create `src/app/components/profile-card/profile-card.component.css` — the `.profile-banner` rule
moves here verbatim from `profile-dialog.component.css` (it's now the card's own concern, not the
dialog's):

```css
/* ── Banner ───────────────────────────────────────────────────────────── */
.profile-banner {
    height: 100px;
    background: linear-gradient(135deg, var(--color-brand-dark) 0%, var(--color-brand) 65%, var(--color-brand-dim) 100%);
    background-size: cover;
    background-position: center top;
    position: relative;
}
```

- [ ] **Step 2: Slim `ProfileDialogComponent` down to a shell around `ProfileCardComponent`**

Replace the full contents of `src/app/components/profile-dialog/profile-dialog.component.ts`:

```ts
import {Component, inject, Input, OnChanges, Output, EventEmitter, signal, SimpleChanges} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ProfileService} from '../../services/profile.service';
import {ProfileCardComponent} from '../profile-card/profile-card.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-profile-dialog',
    standalone: true,
    imports: [Dialog, ProfileCardComponent, TranslateModule],
    templateUrl: './profile-dialog.component.html',
    styleUrl: './profile-dialog.component.css',
})
export class ProfileDialogComponent implements OnChanges {
    @Input() userId: string | null = null;
    @Input() friendsSince: Date | null = null;
    @Output() visibleChange = new EventEmitter<boolean>();
    protected dialogVisible = false;
    protected profile = signal<ProfileDto | undefined>(undefined);
    protected avatarExpanded = false;
    protected avatarError = signal(false);
    private profileService = inject(ProfileService);

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['userId']) {
            const id = this.userId;
            if (id) {
                this.dialogVisible = true;
                this.avatarError.set(false);
                const cached = this.profileService.getCachedByUserId(id);
                if (cached) {
                    this.profile.set(cached);
                } else {
                    this.profile.set(undefined);
                    this.profileService.getByUserId(id).subscribe(p => this.profile.set(p));
                }
            } else {
                this.dialogVisible = false;
                this.profile.set(undefined);
                this.avatarExpanded = false;
                this.avatarError.set(false);
            }
        }
    }

    protected onHide(): void {
        this.visibleChange.emit(false);
    }

    protected onAvatarClick(): void {
        if (this.profile()?.avatarUrl && !this.avatarError()) {
            this.avatarExpanded = true;
        }
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }
}
```

(Removed the dead `@Input() bannerUrl` and the now-unused `avatarLabel`/`computed` import — both
moved into `ProfileCardComponent`.)

Replace `src/app/components/profile-dialog/profile-dialog.component.html`:

```html
<p-dialog
        (onHide)="onHide()"
        [(visible)]="dialogVisible"
        [breakpoints]="{ '480px': '95vw' }"
        [closable]="true"
        [dismissableMask]="true"
        [draggable]="false"
        [modal]="true"
        [resizable]="false"
        [showHeader]="false"
        [style]="{ width: '360px' }"
        styleClass="profile-dialog">

    <div class="relative">
        <button (click)="dialogVisible = false" class="close-btn">
            <i class="pi pi-times"></i>
        </button>
        <app-profile-card
                (avatarClick)="onAvatarClick()"
                (avatarErrorChange)="onAvatarError()"
                [avatarError]="avatarError()"
                [friendsSince]="friendsSince"
                [profile]="profile()"/>
    </div>

</p-dialog>

<!-- Avatar lightbox -->
@if (avatarExpanded && profile()?.avatarUrl && !avatarError()) {
    <p-dialog
            [(visible)]="avatarExpanded"
            [dismissableMask]="true"
            [draggable]="false"
            [modal]="true"
            [resizable]="false"
            [showHeader]="false"
            [style]="{ background: 'transparent', boxShadow: 'none', border: 'none' }"
            styleClass="avatar-lightbox-dialog">
        <div class="flex items-center justify-center p-1">
            <img [src]="profile()!.avatarUrl" alt="Profile avatar" class="w-72 h-72 rounded-2xl object-cover"/>
        </div>
    </p-dialog>
}
```

Note the close button now sits at the shell level (`profile-dialog.component.ts`/`.html`), not
inside `ProfileCardComponent` — the card is dialog-agnostic and reusable by the popover, which
will supply its own close/dismiss affordance (a `p-popover` dismisses on outside click, no button
needed there).

Replace `src/app/components/profile-dialog/profile-dialog.component.css` (drop the now-relocated
`.profile-banner` rule, keep the dialog shell + close button rules):

```css
/* ── Profile dialog shell ─────────────────────────────────────────────── */
::ng-deep .profile-dialog.p-dialog {
    background: var(--color-card) !important;
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    border-radius: 16px !important;
    overflow: hidden !important;
    padding: 0 !important;
}

::ng-deep .profile-dialog .p-dialog-content {
    background: var(--color-card) !important;
    padding: 0 !important;
    border-radius: 0 !important;
}

/* ── Close button ─────────────────────────────────────────────────────── */
.close-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.35);
    border: none;
    color: rgba(255, 255, 255, 0.75);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    z-index: 20;
    transition: background 0.15s ease, color 0.15s ease;
}

.close-btn:hover {
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
}
```

(Added `z-index: 20` since the button is now a sibling positioned over `app-profile-card` rather
than living inside the same `relative` wrapper as the banner — without it, the banner's
`position: relative` stacking could otherwise sit on top in some browsers. The wrapping `<div
class="relative">` in the new template already gives both children a shared positioning context,
so `position: absolute` + `z-index: 20` places the button correctly above the banner.)

- [ ] **Step 3: Manually verify other-user profile viewing still works**

Run: `ng serve`, click another member's avatar/name (in a guild member list or a message) to open
`ProfileDialogComponent`, and confirm the centered dialog still shows banner, avatar, status dot,
username, bio, member-since — identical to before this task, since this is a pure refactor with a
few additive fallback behaviors (which won't visually trigger for a profile with no
`accentColor`/`bannerUrl` set).

Expected: no visual regression.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/profile-card src/app/components/profile-dialog
git commit -m "refactor: extract ProfileCardComponent from ProfileDialogComponent, wire banner/accent cosmetics"
```

---

### Task 7: Self-profile popover (bottom-left user bar)

**Files:**
- Create: `src/app/features/main-page/components/self-profile-popover/self-profile-popover.component.ts`
- Create: `src/app/features/main-page/components/self-profile-popover/self-profile-popover.component.html`
- Modify: `src/app/features/settings/settings-modal/settings-modal.component.ts` (expose `selectPage`
  as already-public — no signature change needed, see note in Step 2)
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.ts`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.html`

**Interfaces:**
- Consumes: `ProfileCardComponent` (Task 6), `StatusPickerComponent` (existing,
  `src/app/features/main-page/components/status-picker/status-picker.component.ts`),
  `SettingsModalComponent.selectPage(id: string): void` (existing, already public).
- Produces: `SelfProfilePopoverComponent` (`app-self-profile-popover`), output
  `editProfile: void` — consumed by `QuickSettingsComponent`.

- [ ] **Step 1: Create `SelfProfilePopoverComponent`**

Create `src/app/features/main-page/components/self-profile-popover/self-profile-popover.component.ts`:

```ts
import {Component, inject, output, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {ProfileService} from '../../../../services/profile.service';
import {ProfileCardComponent} from '../../../../components/profile-card/profile-card.component';
import {StatusPickerComponent} from '../status-picker/status-picker.component';

@Component({
    selector: 'app-self-profile-popover',
    imports: [Popover, ProfileCardComponent, StatusPickerComponent],
    templateUrl: './self-profile-popover.component.html',
})
export class SelfProfilePopoverComponent {
    editProfile = output<void>();
    protected profileService = inject(ProfileService);
    @ViewChild('popover') private popoverRef!: Popover;

    toggle(event: Event): void {
        this.popoverRef.toggle(event);
    }

    protected onEditProfile(): void {
        this.popoverRef.hide();
        this.editProfile.emit();
    }
}
```

Create `src/app/features/main-page/components/self-profile-popover/self-profile-popover.component.html`:

```html
<p-popover #popover appendTo="body" [style]="{width: '320px', padding: '0'}">
    <div class="flex flex-col">
        <app-profile-card [profile]="profileService.ownProfile()"/>
        <div class="flex items-center gap-2 px-4 pb-4 pt-1">
            <app-status-picker/>
            <button (click)="onEditProfile()"
                    class="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium
                     bg-brand hover:bg-brand-hover text-white rounded-lg py-2 transition-colors
                     cursor-pointer border-0">
                <i class="pi pi-pencil text-xs"></i>
                Edit Profile
            </button>
        </div>
    </div>
</p-popover>
```

`Popover`'s own `[style]` sets padding to `0` because `ProfileCardComponent`'s banner needs to
reach the popover's edges (matching how the centered dialog's `p-dialog-content` also zeroes
padding for the same reason).

- [ ] **Step 2: Confirm `SettingsModalComponent.selectPage` is usable from outside**

No code change needed here — `selectPage(id: string): void` on
`src/app/features/settings/settings-modal/settings-modal.component.ts` is already a public
(non-`protected`) method, so `QuickSettingsComponent` can call it directly via a `@ViewChild`
reference in the next step. This step is just verifying that fact by reading the file — if it
were `protected`, this step would change it to public; skip any edit.

- [ ] **Step 3: Wire the popover into `QuickSettingsComponent`**

In `src/app/features/main-page/components/quick-settings/quick-settings.component.ts`, add the
import and a `@ViewChild` for the settings modal, plus the click handler:

```ts
import {Component, inject, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {ProfileService} from "../../../../services/profile.service";
import {AppAvatarComponent} from "../../../../components/avatar/avatar.component";
import {Button} from "primeng/button";
import {ConnectionState, MessagingWebsocketService} from "../../../../services/messaging-websocket.service";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";
import {SettingsModalComponent} from "../../../../features/settings/settings-modal/settings-modal.component";
import {VoiceChannelService} from "../../../../services/voice-channel.service";
import {TranslateModule} from '@ngx-translate/core';
import {UserService} from "../../../../services/user.service";
import {UserType} from "../../../../dtos/response/UserDto";
import {AdminModalComponent} from "../../../../features/admin/admin-modal/admin-modal.component";
import {StatusPickerComponent} from "../status-picker/status-picker.component";
import {SelfProfilePopoverComponent} from "../self-profile-popover/self-profile-popover.component";

@Component({
    selector: 'app-quick-settings',
    imports: [
        AppAvatarComponent,
        Button,
        ConnectionStatusComponent,
        SettingsModalComponent,
        AdminModalComponent,
        StatusPickerComponent,
        SelfProfilePopoverComponent,
        NgClass,
        TranslateModule,
    ],
    templateUrl: './quick-settings.component.html',
    styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
    public isSettingsOpen = signal(false);
    public isAdminOpen = signal(false);
    protected profileService = inject(ProfileService);
    protected userService = inject(UserService);
    protected websocketService = inject(MessagingWebsocketService);
    protected voiceSvc = inject(VoiceChannelService);
    protected readonly ConnectionState = ConnectionState;
    protected readonly UserType = UserType;
    @ViewChild(SettingsModalComponent) private settingsModal!: SettingsModalComponent;
    @ViewChild(SelfProfilePopoverComponent) private selfProfilePopover!: SelfProfilePopoverComponent;

    constructor() {
        if (!this.profileService.ownProfile()) {
            this.profileService.getSelf().subscribe();
        }
        if (!this.userService.self()) {
            this.userService.getSelf().subscribe();
        }
    }

    protected openSelfProfilePopover(event: Event): void {
        this.selfProfilePopover.toggle(event);
    }

    protected openProfileSettings(): void {
        this.settingsModal.selectPage('profile');
        this.isSettingsOpen.set(true);
    }
}
```

(Removed the now-unused `ProfileDialogService` import/injection — the bottom-left bar no longer
opens the centered dialog.)

In `quick-settings.component.html`, replace the avatar/name button's click handler and add the
popover component right after it:

```html
        <!-- Avatar + name (clickable -opens self-profile popover) -->
        <button (click)="openSelfProfilePopover($event)"
                class="flex items-center gap-1.5 flex-1 min-w-0 rounded-lg p-1 -m-1 hover:bg-white/[0.06] transition-colors cursor-pointer border-0 text-left">

            <!-- Avatar + status dot -->
            <div class="relative shrink-0 mr-1">
                <app-avatar [userId]="profileService.ownProfile()?.userId"/>
                <div [ngClass]="{
            'bg-emerald-400': websocketService.connectionState() === ConnectionState.Connected,
            'bg-amber-400': websocketService.connectionState() === ConnectionState.Connecting,
            'bg-rose-500': websocketService.connectionState() === ConnectionState.Disconnected
          }"
                     class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-sidebar"></div>
            </div>

            <!-- Name + connection status -->
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-white/85 truncate leading-tight">{{ profileService.ownProfile()?.userName }}</p>
                <app-connection-status></app-connection-status>
            </div>

        </button>
        <app-self-profile-popover (editProfile)="openProfileSettings()"/>
```

(Only the `(click)` handler on the `<button>` and the new `<app-self-profile-popover>` line
change; every other line in that `<button>` block is unchanged.)

- [ ] **Step 4: Manually verify the new popover**

Run: `ng serve`. Click the bottom-left avatar/username bar:
- Confirm a small popover appears anchored above the bar (not centered on screen), showing your
  banner/accent-color background, avatar with status dot, username, bio (if set), member-since.
- Confirm the status-picker inside the popover still changes your status.
- Click "Edit Profile" — confirm it closes the popover and opens the Settings modal directly on
  the Profile page.
- Confirm clicking outside the popover dismisses it (default `p-popover` behavior).
- Confirm clicking another user's avatar/message elsewhere still opens the original centered
  `ProfileDialogComponent` (unaffected by this task).

Expected: all of the above behave as described.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/main-page/components/self-profile-popover src/app/features/main-page/components/quick-settings
git commit -m "feat: replace centered self-profile dialog with anchored popover"
```

---

### Task 8: Apply username styling to the guild member list

**Files:**
- Modify: `src/app/features/guild/components/guild-member-list/guild-member-list.component.ts`
- Modify: `src/app/features/guild/components/guild-member-list/guild-member-list.component.html`

**Interfaces:**
- Consumes: `UserNameStyleDirective` (Task 5).

- [ ] **Step 1: Import the directive**

In `guild-member-list.component.ts`, add the import and register it:

```ts
import {UserNameStyleDirective} from '../../../../directives/user-name-style.directive';
```

Change:

```ts
    imports: [TranslateModule, Menu, UserStatusDotComponent],
```

to:

```ts
    imports: [TranslateModule, Menu, UserStatusDotComponent, UserNameStyleDirective],
```

- [ ] **Step 2: Apply the directive to both name spans**

In `guild-member-list.component.html`, change the online-row name span (line 31):

```html
                        <span class="text-sm font-medium text-white/80 truncate">{{ displayName(member) }}</span>
```

to:

```html
                        <span [appUserNameStyle]="member.profile" class="text-sm font-medium text-white/80 truncate">{{ displayName(member) }}</span>
```

and the offline-row name span (line 54):

```html
                        <span class="text-sm font-medium text-white/35 truncate">{{ displayName(member) }}</span>
```

to:

```html
                        <span [appUserNameStyle]="member.profile" class="text-sm font-medium text-white/35 truncate">{{ displayName(member) }}</span>
```

- [ ] **Step 3: Manually verify**

Run: `ng serve`, open a guild with members who have `accentColor`/`font` set on their profile
(set one via Settings → Profile once Task 12 lands — for now, this can be checked visually once
the whole plan is complete, or skipped here and re-verified in Task 12's manual check). If Task 12
hasn't landed yet, just confirm `ng build` compiles cleanly with no template errors from the new
binding.

Expected: no compile errors; member names with no accent/font set look unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/guild-member-list
git commit -m "feat: apply per-user font/accent color to guild member list names"
```

---

### Task 9: Apply username styling to the guild-settings member table

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/members-settings/members-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/members-settings/members-settings.component.html`

**Interfaces:**
- Consumes: `UserNameStyleDirective` (Task 5).

- [ ] **Step 1: Import the directive**

In `members-settings.component.ts`, add:

```ts
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';
```

Change:

```ts
    imports: [FormsModule, Button, InputText, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate, TranslateModule],
```

to:

```ts
    imports: [FormsModule, Button, InputText, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate, TranslateModule, UserNameStyleDirective],
```

- [ ] **Step 2: Apply the directive to the row's name paragraph**

In `members-settings.component.html`, change:

```html
                        <p class="text-sm font-medium text-white/85 truncate">{{ displayName(row) }}</p>
```

to:

```html
                        <p [appUserNameStyle]="row.profile" class="text-sm font-medium text-white/85 truncate">{{ displayName(row) }}</p>
```

- [ ] **Step 3: Manually verify**

Run: `ng build` to confirm no template compile errors (`row.profile` is typed
`ProfileDto | null`, which matches the directive's `UserNameStyleInput | null | undefined` input
type).

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/members-settings
git commit -m "feat: apply per-user font/accent color to guild-settings member table"
```

---

### Task 10: Apply username styling to messages (author header, reply reference, mention chip)

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`

**Interfaces:**
- Consumes: `UserNameStyleDirective` (Task 5).
- Produces: `MessageComponent.mentionedProfile(userId: string): ProfileDto | undefined` — used
  only within this component's own template.

- [ ] **Step 1: Import the directive and add a `mentionedProfile` lookup helper**

In `message.component.ts`, add the import:

```ts
import {UserNameStyleDirective} from '../../../../../directives/user-name-style.directive';
```

Add `UserNameStyleDirective` to the component's `imports` array (currently
`[AppAvatarComponent, DatePipe, AsyncPipe, NgClass, MarkdownPipe, InviteCardComponent, MessageHoverToolbarComponent, MessageReactionBarComponent, TwemojiComponent, Dialog, Button, TranslateModule]`
— append it at the end).

Add a small public helper next to `getProfile()` (used by the mention-chip template branch, which
only has a `refId: string`, not the resolved `ProfileDto`, in its segment object):

```ts
    public mentionedProfile(userId: string): ProfileDto | undefined {
        return this.profileService.getCachedByUserId(userId);
    }
```

Also add a `replyAuthorProfile` computed next to the existing `replyAuthorName` computed, since
the reply-reference name span needs the same styling and `getCachedByUserId` is already how
`replyAuthorName` resolves the name:

```ts
    protected readonly replyAuthorProfile = computed(() => {
        const msg = this.replyMessage();
        if (!msg) return undefined;
        return this.profileService.getCachedByUserId(msg.authorId);
    });
```

- [ ] **Step 2: Apply the directive in the template**

In `message.component.html`, the reply-reference name span (lines 21-24):

```html
                    <span class="text-[11px] font-semibold text-white/45 shrink-0
                       group-hover/reply:text-white/65 transition-colors">
            {{ replyAuthorName() }}
          </span>
```

becomes:

```html
                    <span [appUserNameStyle]="replyAuthorProfile()" class="text-[11px] font-semibold text-white/45 shrink-0
                       group-hover/reply:text-white/65 transition-colors">
            {{ replyAuthorName() }}
          </span>
```

The author header span (lines 37-40):

```html
            <span (click)="profileDialogSvc.open(message().authorId)"
                  class="text-sm font-semibold text-white/85 cursor-pointer hover:text-white transition-colors">
        {{ user ? user.userName : message().authorId }}
      </span>
```

becomes:

```html
            <span (click)="profileDialogSvc.open(message().authorId)"
                  [appUserNameStyle]="user"
                  class="text-sm font-semibold text-white/85 cursor-pointer hover:text-white transition-colors">
        {{ user ? user.userName : message().authorId }}
      </span>
```

The resolved mention-chip span (lines 120-123):

```html
                        } @else if (seg.type === 'mention') {
                            <span (click)="seg.refId && profileDialogSvc.open(seg.refId)"
                                  [class.cursor-pointer]="seg.refId"
                                  class="mention-chip">{{ seg.value }}</span>
```

becomes:

```html
                        } @else if (seg.type === 'mention') {
                            <span (click)="seg.refId && profileDialogSvc.open(seg.refId)"
                                  [appUserNameStyle]="seg.refId ? mentionedProfile(seg.refId) : null"
                                  [class.cursor-pointer]="seg.refId"
                                  class="mention-chip">{{ seg.value }}</span>
```

- [ ] **Step 3: Manually verify**

Run: `ng build` to confirm the template compiles (no type errors — `user` from
`@let user = (getProfile() | async);` is `ProfileDto | null`, which satisfies
`UserNameStyleInput | null | undefined`).

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/messaging/components/conversation/message
git commit -m "feat: apply per-user font/accent color to message author, reply, and mention names"
```

---

### Task 11: Apply username styling to mention autocomplete and the live composer chip

**Files:**
- Modify: `src/app/features/messaging/components/conversation/composer/composer-utils.ts`
- Modify: `src/app/features/messaging/components/conversation/composer/composer.component.ts`
- Modify: `src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.ts`
- Modify: `src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.html`

**Interfaces:**
- Consumes: `userNameStyle()` (Task 2), `UserNameStyleDirective` (Task 5).
- Produces: `UserMentionCandidate.accentColor?: string | null`, `UserMentionCandidate.font?: ProfileFont`.

- [ ] **Step 1: Add optional cosmetics fields to `UserMentionCandidate`**

In `composer-utils.ts`, change:

```ts
export interface UserMentionCandidate {
    kind: 'user';
    userId: string;
    userName: string;
    avatarUrl?: string;
}
```

to:

```ts
export interface UserMentionCandidate {
    kind: 'user';
    userId: string;
    userName: string;
    avatarUrl?: string;
    accentColor?: string | null;
    font?: ProfileFont;
}
```

Add the import at the top of the file:

```ts
import {ProfileFont} from '../../../../../dtos/response/profile.dto';
```

- [ ] **Step 2: Populate the new fields where a full profile is available**

In `composer.component.ts`, the guild-member-search candidate builder currently reads:

```ts
                return this.guildService.searchMembers(gid, q).pipe(
                    map(members => members
                        .filter(m => m.profile)
                        .map((m): MentionCandidate => ({
                            kind: 'user',
                            userId: m.userId,
                            userName: m.profile!.userName,
                            avatarUrl: m.profile?.avatarUrl,
                        }))
                    ),
                    catchError(() => of<MentionCandidate[]>([]))
                );
```

Change the `.map()` callback to also carry the cosmetics fields:

```ts
                return this.guildService.searchMembers(gid, q).pipe(
                    map(members => members
                        .filter(m => m.profile)
                        .map((m): MentionCandidate => ({
                            kind: 'user',
                            userId: m.userId,
                            userName: m.profile!.userName,
                            avatarUrl: m.profile?.avatarUrl,
                            accentColor: m.profile?.accentColor,
                            font: m.profile?.font,
                        }))
                    ),
                    catchError(() => of<MentionCandidate[]>([]))
                );
```

The DM/conversation-member candidate builder in `conversation.component.ts`
(`.map((m): MentionCandidate => ({kind: 'user', userId: m.userId, userName: m.cachedUserName}))`)
is intentionally left unchanged — it only has a cached username string, not a full profile (see
spec §7, "Out of scope").

- [ ] **Step 3: Apply the directive in the suggestion overlay**

In `suggestion-overlay.component.ts`, add the import and register it:

```ts
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';
```

Change:

```ts
    imports: [NgClass, Avatar, TwemojiComponent],
```

to:

```ts
    imports: [NgClass, Avatar, TwemojiComponent, UserNameStyleDirective],
```

In `suggestion-overlay.component.html`, change the `@case ('user')` branch:

```html
                        @case ('user') {
                            <p-avatar icon="pi pi-user" shape="circle"/>
                            <span class="text-sm font-semibold text-white/80">{{ m.userName }}</span>
                        }
```

to:

```html
                        @case ('user') {
                            <p-avatar icon="pi pi-user" shape="circle"/>
                            <span [appUserNameStyle]="m" class="text-sm font-semibold text-white/80">{{ m.userName }}</span>
                        }
```

(`m` is narrowed to `UserMentionCandidate` by the `@case ('user')` block, which now has
`accentColor`/`font` — satisfies the directive's input type.)

- [ ] **Step 4: Apply the same styling to the live-typing composer chip**

In `composer.component.ts`'s `onMentionSelected`, the user-chip branch currently reads:

```ts
        if (candidate.kind === 'user') {
            chip.className = 'mention-chip';
            chip.dataset['userId'] = candidate.userId;
            chip.dataset['display'] = `@${candidate.userName}`;
            chip.textContent = `@${candidate.userName}`;
        } else if (candidate.kind === 'role') {
```

Change it to also apply the pure-function style (import `userNameStyle` from the model file
added in Task 2):

```ts
        if (candidate.kind === 'user') {
            chip.className = 'mention-chip';
            chip.dataset['userId'] = candidate.userId;
            chip.dataset['display'] = `@${candidate.userName}`;
            chip.textContent = `@${candidate.userName}`;
            Object.assign(chip.style, userNameStyle(candidate));
        } else if (candidate.kind === 'role') {
```

Add the import at the top of `composer.component.ts`:

```ts
import {userNameStyle} from '../../../../../models/profile-font.model';
```

- [ ] **Step 5: Manually verify**

Run: `ng build` to confirm all four files compile. Then `ng serve`, open a guild channel, type
`@` and search a member whose profile has an accent color/font set (once Task 12 lands) — confirm
the autocomplete row and the resulting chip both reflect it.

Expected: PASS on build; visual confirmation once Task 12 is done (acceptable to defer the visual
check to the final end-to-end pass after Task 12, noted here for completeness).

- [ ] **Step 6: Commit**

```bash
git add src/app/features/messaging/components/conversation/composer
git commit -m "feat: apply per-user font/accent color to mention autocomplete and composer chips"
```

---

### Task 12: Profile settings page — Banner, Accent Color, Font, and Bio save

**Files:**
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html`

**Interfaces:**
- Consumes: `ProfileService.updateProfile()`/`.uploadBanner()` (Task 3), `ImageCropperComponent`
  with `outputWidth`/`outputHeight` (Task 4), `FONT_LABELS` (Task 2).

- [ ] **Step 1: Add banner/accent/font/bio editing state to the component**

In `profile-settings.component.ts`, add imports:

```ts
import {Select} from 'primeng/select';
import {FONT_LABELS} from '../../../../../models/profile-font.model';
import {ProfileFont} from '../../../../../dtos/response/profile.dto';
```

Add `Select` and `FormsModule` (already imported) to the component's `imports` array — change:

```ts
    imports: [Button, Dialog, ImageCropperComponent, TranslateModule, FormsModule, DatePipe],
```

to:

```ts
    imports: [Button, Dialog, ImageCropperComponent, TranslateModule, FormsModule, DatePipe, Select],
```

Add new signal state and a `fontOptions` list, next to the existing `avatarExpanded`/`avatarError`
signals:

```ts
    protected uploadingBanner = signal(false);
    protected bannerCropVisible = signal(false);
    protected bannerCropSrc = signal('');
    protected readonly fontOptions = Object.entries(FONT_LABELS).map(([value, label]) => ({value, label}));
    protected bioEdit = signal('');
    protected accentColorEdit = signal('');
    protected fontEdit = signal<ProfileFont>(ProfileFont.Default);
    protected savingDetails = signal(false);
```

Add an `ngOnInit` sync of the edit state from the loaded profile — the class already implements
`OnInit` for the user fetch; extend the existing method rather than adding a second one. It
currently reads:

```ts
    ngOnInit(): void {
        this.userService.getSelf().pipe(take(1)).subscribe({
            next: user => {
                this.user.set(user);
                this.userLoading.set(false);
            },
            error: () => this.userLoading.set(false),
        });
    }
```

Change to:

```ts
    ngOnInit(): void {
        this.userService.getSelf().pipe(take(1)).subscribe({
            next: user => {
                this.user.set(user);
                this.userLoading.set(false);
            },
            error: () => this.userLoading.set(false),
        });
        const profile = this.ownProfile();
        this.bioEdit.set(profile?.bio ?? '');
        this.accentColorEdit.set(profile?.accentColor ?? '');
        this.fontEdit.set(profile?.font ?? ProfileFont.Default);
    }
```

Add a `detailsDirty` computed and the save/banner methods, near `pickFile`/`onFileSelected`:

```ts
    protected detailsDirty = computed(() => {
        const p = this.ownProfile();
        return this.bioEdit() !== (p?.bio ?? '')
            || this.accentColorEdit() !== (p?.accentColor ?? '')
            || this.fontEdit() !== (p?.font ?? ProfileFont.Default);
    });

    protected saveDetails(): void {
        if (!this.detailsDirty() || this.savingDetails()) return;
        this.savingDetails.set(true);
        this.profileService.updateProfile({
            bio: this.bioEdit(),
            accentColor: this.accentColorEdit(),
            font: this.fontEdit(),
        }).subscribe({
            next: () => this.savingDetails.set(false),
            error: () => this.savingDetails.set(false),
        });
    }

    protected pickBannerFile(): void {
        this.bannerFileInputRef.nativeElement.click();
    }

    protected onBannerFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            this.bannerCropSrc.set(reader.result as string);
            this.bannerCropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onBannerCropConfirmed(file: File): void {
        this.bannerCropVisible.set(false);
        this.uploadingBanner.set(true);
        this.profileService.uploadBanner(file).subscribe({
            next: () => this.uploadingBanner.set(false),
            error: () => this.uploadingBanner.set(false),
        });
    }
```

Add the `computed` import to the existing `@angular/core` import line (it currently imports
`Component, computed, ElementRef, inject, OnInit, signal, ViewChild` — `computed` is already
there) and add a second `@ViewChild` for the new hidden file input, next to the existing one:

```ts
    @ViewChild('fileInput') private fileInputRef!: ElementRef<HTMLInputElement>;
    @ViewChild('bannerFileInput') private bannerFileInputRef!: ElementRef<HTMLInputElement>;
```

- [ ] **Step 2: Add the Banner section to the template**

In `profile-settings.component.html`, insert a new section directly after the existing `<!-- ──
Avatar ── -->` section (after its closing `</section>`, before `<!-- ── Display ── -->`):

```html
    <!-- ── Banner ──────────────────────────────────────────────────────────── -->
    <section class="flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-white/30 uppercase tracking-widest border-b border-white/[0.10] pb-3">
            Banner</h2>

        <div class="relative w-full h-28 rounded-xl overflow-hidden bg-white/[0.04] border border-white/[0.09]">
            @if (ownProfile()?.bannerUrl) {
                <img [src]="ownProfile()!.bannerUrl" alt="Banner" class="w-full h-full object-cover"/>
            } @else if (ownProfile()?.accentColor) {
                <div [style.background]="ownProfile()!.accentColor" class="w-full h-full"></div>
            }
            @if (uploadingBanner()) {
                <div class="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <i class="pi pi-spin pi-spinner text-white text-xl"></i>
                </div>
            }
        </div>

        <div class="flex gap-2">
            <input #bannerFileInput (change)="onBannerFileSelected($event)" accept="image/*" class="hidden" type="file"/>
            <p-button (onClick)="pickBannerFile()" [disabled]="uploadingBanner()" label="Change Banner"
                      severity="primary" size="small"/>
        </div>
    </section>
```

- [ ] **Step 3: Un-disable Bio, add Accent Color + Font controls, add the Save button**

In `profile-settings.component.html`, the `<!-- ── Display ── -->` section currently reads:

```html
    <!-- ── Display ─────────────────────────────────────────────────────────── -->
    <section class="flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-white/30 uppercase tracking-widest border-b border-white/[0.10] pb-3">
            Display</h2>

        <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Display Name</label>
            <input [value]="ownProfile()?.userName ?? ''" class="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-2.5 text-sm text-white/40 placeholder:text-white/20 outline-none cursor-not-allowed" disabled placeholder="Your display name"
                   type="text"/>
            <p class="text-[11px] text-white/25">Coming soon -this will be your visible name in chats.</p>
        </div>

        <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Bio</label>
            <textarea [value]="ownProfile()?.bio ?? ''" class="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-2.5 text-sm text-white/40 placeholder:text-white/20 outline-none cursor-not-allowed resize-none" disabled
                      placeholder="Tell people a bit about yourself…"
                      rows="3"></textarea>
        </div>
    </section>
```

Replace it with (Display Name stays disabled/unchanged; Bio becomes editable; Accent Color and
Font are added; one batched Save button covers all three):

```html
    <!-- ── Display ─────────────────────────────────────────────────────────── -->
    <section class="flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-white/30 uppercase tracking-widest border-b border-white/[0.10] pb-3">
            Display</h2>

        <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Display Name</label>
            <input [value]="ownProfile()?.userName ?? ''" class="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-2.5 text-sm text-white/40 placeholder:text-white/20 outline-none cursor-not-allowed" disabled placeholder="Your display name"
                   type="text"/>
            <p class="text-[11px] text-white/25">Coming soon -this will be your visible name in chats.</p>
        </div>

        <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Bio</label>
            <textarea (ngModelChange)="bioEdit.set($event)" [ngModel]="bioEdit()"
                      class="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-2.5 text-sm text-white/80 placeholder:text-white/25 outline-none focus:border-brand/40 transition-colors resize-none"
                      placeholder="Tell people a bit about yourself…"
                      rows="3"></textarea>
        </div>

        <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Accent Color</label>
            <div class="flex items-center gap-3">
                <div class="color-swatch-wrap">
                    <div [style.background]="accentColorEdit() || 'transparent'" class="color-swatch-bg"></div>
                    <input (input)="accentColorEdit.set($any($event.target).value)"
                           [value]="accentColorEdit() || '#7c72ff'"
                           type="color"/>
                </div>
                @if (accentColorEdit()) {
                    <button (click)="accentColorEdit.set('')"
                            class="text-xs text-white/40 hover:text-white/70 cursor-pointer border-0 bg-transparent transition-colors">
                        Clear
                    </button>
                }
            </div>
        </div>

        <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Font</label>
            <p-select (ngModelChange)="fontEdit.set($event)" [ngModel]="fontEdit()"
                      [options]="fontOptions" optionLabel="label" optionValue="value"
                      styleClass="w-full"/>
            <p [style.font-family]="fontEdit() === 'Default' ? null : fontStackPreview()"
               class="text-sm text-white/60 mt-1">
                The quick brown fox jumps over the lazy dog.
            </p>
        </div>

        <div class="flex items-center gap-3">
            <p-button (onClick)="saveDetails()" [disabled]="!detailsDirty()" [loading]="savingDetails()"
                      label="Save Changes" severity="primary" size="small"/>
        </div>
    </section>
```

Add the `fontStackPreview` computed referenced above, next to `detailsDirty` in the `.ts` file:

```ts
    protected fontStackPreview = computed(() => FONT_STACKS[this.fontEdit()]);
```

Add `FONT_STACKS` to the existing model import:

```ts
import {FONT_LABELS, FONT_STACKS} from '../../../../../models/profile-font.model';
```

The `color-swatch-wrap`/`color-swatch-bg` classes already exist as global styles (used by
`appearance-settings.component.html`'s color grid) — confirm via
`Grep "color-swatch-wrap" src/styles.css` that they're defined globally rather than scoped to
that component; if they turn out to be scoped to `appearance-settings.component.css` instead,
copy the two rules into `profile-settings.component.css` verbatim rather than reference an
inaccessible scoped class.

- [ ] **Step 4: Add the banner crop dialog**

In `profile-settings.component.html`, add a second crop dialog next to the existing avatar one
(after the existing `<!-- ── Avatar crop dialog ── -->` `</p-dialog>`):

```html
<!-- ── Banner crop dialog ─────────────────────────────────────────────────── -->
<p-dialog
        [(visible)]="bannerCropVisible"
        [draggable]="false"
        [modal]="true"
        [resizable]="false"
        [style]="{width: '620px'}"
        appendTo="body"
        header="Crop Banner">
    @if (bannerCropVisible() && bannerCropSrc()) {
        <app-image-cropper
                (cancelled)="bannerCropVisible.set(false)"
                (confirmed)="onBannerCropConfirmed($event)"
                [circular]="false"
                [imageSrc]="bannerCropSrc()"
                [outputHeight]="400"
                [outputWidth]="1200"/>
    }
</p-dialog>
```

- [ ] **Step 5: Manually verify the full settings flow**

Run: `ng serve`, open Settings → Profile:
- Change Banner → pick an image → confirm a wide (non-square) crop box appears, drag/zoom works,
  Apply uploads and the banner preview updates.
- Set an Accent Color, type a Bio, pick a non-Default Font, confirm "Save Changes" enables, click
  it, confirm it saves (network tab shows one `PATCH .../profiles/me` call with all three
  fields) and the preview text switches to the chosen font.
- Clear the Accent Color, save again, confirm it clears (network body has `accentColor: ""`).
- Reopen the self-profile popover (Task 7) and confirm the banner/accent color/font now show
  there too, and open another user's profile dialog (Task 6) to confirm the same for a profile
  that has cosmetics set.
- Check the guild member list, message author names, and mention autocomplete (Tasks 8–11) for
  your own name — confirm the accent color/font now visibly apply everywhere.

Expected: all of the above work end-to-end.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/settings/settings-modal/pages/profile-settings
git commit -m "feat: add banner upload, accent color, font, and bio editing to profile settings"
```

---

### Task 13: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `ng test`
Expected: PASS — every spec file touched across Tasks 1–12 green, no regressions elsewhere.

- [ ] **Step 2: Run a full production build**

Run: `ng build`
Expected: PASS — no TypeScript or template compile errors across the ~20 files touched by this
plan (this is the first point every file is compiled together in one pass).

- [ ] **Step 3: Fix anything the build/tests surface**

If either command fails, the failure is almost certainly a leftover reference to the old
`ImageCropperComponent.outputSize` input, the old `ProfileDialogComponent.@Input() bannerUrl`, or
a missed `ProfileDto` literal somewhere Task 1's search didn't cover — grep for
`outputSize`/`[bannerUrl]` across `src/app` to confirm zero remaining references before declaring
this task done.

- [ ] **Step 4: Commit (only if Step 3 required fixes)**

```bash
git add -A
git commit -m "fix: address build/test issues found in final verification pass"
```
