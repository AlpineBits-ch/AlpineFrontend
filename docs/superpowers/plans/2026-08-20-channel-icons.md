# Channel Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guild channel carry its own icon and icon colour, overriding the icon its type would otherwise pick, with defaults staying uniform.

**Architecture:** Two nullable columns on the `Channel` aggregate reach the wire through the existing Facet projection and the existing channel PATCH. On the client, the channel icon slot moves from PrimeIcons to Lucide via the data-only `lucide` package and a local renderer, behind one shared `<app-channel-icon>` component that fourteen existing call sites collapse into.

**Tech Stack:** Angular 21 (standalone, signals, OnPush), Tailwind 4, PrimeNG 21, Vitest; .NET 10, EF Core, Wolverine, FluentValidation, Facet.

**Spec:** `docs/superpowers/specs/2026-08-20-channel-icons-design.md`

## Global Constraints

- Backend repo is `C:\Users\Domin\RiderProjects\Echo`. Client repo is `C:\Users\Domin\WebstormProjects\Alpine`. Tasks name which.
- Work on `main` in both repos. Never `git stash`, `git checkout --`, `git reset --hard`, `git clean`, or any other command that discards working-tree state.

**Another agent is working on `main` in this repo at the same time, on an unrelated feature.** This is not a hypothetical:

- **Never `git add -A`, `git add .`, or `git commit -a`.** Stage the exact paths the task names, nothing else. A wildcard stage will sweep the other agent's in-progress work into your commit.
- Before committing, run `git status --short` and confirm every staged path belongs to your task. If something unexpected is staged, unstage it with `git restore --staged <path>`, which touches the index only and never the working tree.
- Expect files you did not touch to change under you mid-task, and expect `bun run test` to show failures that are not yours. Re-run a suspect spec alone before attributing any failure to your own work, and say so in the hand-back rather than fixing it.
- If a file this plan names has been restructured by the other agent, adapt to what is on disk. Do not revert their change to make the plan's snippet apply verbatim.
- Capture a baseline before starting: `bun run test 2>&1 | tail -20`. The bar is no *new* failures, not a green suite.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- No narrative rationale in comments. A comment earns its place only by stating an invariant whose violation is silent, or naming a non-obvious symbol.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports: `import {Component, inject} from '@angular/core';`
- Angular: `inject()` not constructor params; `input()`/`output()`/`model()` not decorators; `ChangeDetectionStrategy.OnPush` on every new component; `@if`/`@for` not structural directives; standalone, no NgModules.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field. Under Vite it reads `undefined` in full-suite runs. Use a getter.
- Client commands: test `bun run test`, single spec `bun run ng test --watch=false --include="**/name.spec.ts"`, build `bun run ng build --configuration development`, lint `bun run lint`. Never bare `vitest` or `npx ng`.
- Never run bare `bun run format`. It is `prettier --write .` and rewrites the whole repo. Format only your own files.
- Commits: conventional prefix, one line, lowercase, imperative. No body unless it carries what the diff cannot. No co-author trailers, no emoji.
- i18n keys are flat and dot-separated. `src/assets/i18n/locales` is a git submodule needing its own commit.
- Icon name pattern: `^[a-z0-9-]{1,48}$`. Colour pattern: `^#[0-9a-fA-F]{6}$`.
- Clear sentinel on the PATCH: `null` or absent leaves the stored value alone, `""` resets to default.

**Parallelisation:** Tasks 1 and 2 (backend) are independent of Tasks 3 to 9 (client) and may run concurrently. Within the client, Task 3 and Task 4 are independent of each other. Task 5 needs Task 4. Task 6 needs Tasks 3, 4 and 5. Tasks 7 and 8 need Task 6.

---

### Task 1: Channel icon columns, validation and migration

**Repo:** `C:\Users\Domin\RiderProjects\Echo`

**Files:**
- Modify: `Guild.Domain/Aggregates/Channel.cs`
- Modify: `Guild.Domain/Validators/ChannelValidator.cs`
- Create: `Guild.Infrastructure/Migrations/<timestamp>_AddChannelIcon.cs` (generated)
- Test: `Guild.Tests/Domain/ChannelValidatorTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Channel.Icon` (`string?`), `Channel.IconColor` (`string?`), and two new `init` properties on `Channel.UpdateChannelParams`: `Icon` (`string?`), `IconColor` (`string?`), both carrying **absolute** values, not sentinels.

- [ ] **Step 1: Write the failing validator test**

Create `Guild.Tests/Domain/ChannelValidatorTests.cs`:

```csharp
using FluentValidation.TestHelper;
using Guild.Domain.Aggregates;
using Guild.Domain.Enums;
using Guild.Domain.Validators;
using Xunit;

namespace Guild.Tests.Domain;

public class ChannelValidatorTests
{
    private static Channel Channel(string? icon = null, string? iconColor = null) => new()
    {
        Name = "general",
        Type = ChannelType.Text,
        Icon = icon,
        IconColor = iconColor,
    };

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("volume-2")]
    [InlineData("a")]
    [InlineData("messages-square")]
    public void AcceptsAbsentEmptyOrWellFormedIcon(string? icon)
    {
        new ChannelValidator().TestValidate(Channel(icon: icon))
            .ShouldNotHaveValidationErrorFor(c => c.Icon);
    }

    [Theory]
    [InlineData("Volume2")]
    [InlineData("volume 2")]
    [InlineData("pi pi-volume-up")]
    [InlineData("volume_2")]
    [InlineData("../../etc/passwd")]
    public void RejectsMalformedIcon(string icon)
    {
        new ChannelValidator().TestValidate(Channel(icon: icon))
            .ShouldHaveValidationErrorFor(c => c.Icon);
    }

    [Fact]
    public void RejectsIconLongerThan48()
    {
        new ChannelValidator().TestValidate(Channel(icon: new string('a', 49)))
            .ShouldHaveValidationErrorFor(c => c.Icon);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("#4B5BC4")]
    [InlineData("#ffffff")]
    [InlineData("#AbCdEf")]
    public void AcceptsAbsentEmptyOrWellFormedColour(string? colour)
    {
        new ChannelValidator().TestValidate(Channel(iconColor: colour))
            .ShouldNotHaveValidationErrorFor(c => c.IconColor);
    }

    [Theory]
    [InlineData("4B5BC4")]
    [InlineData("#4B5BC")]
    [InlineData("#4B5BC44")]
    [InlineData("red")]
    [InlineData("#GGGGGG")]
    public void RejectsMalformedColour(string colour)
    {
        new ChannelValidator().TestValidate(Channel(iconColor: colour))
            .ShouldHaveValidationErrorFor(c => c.IconColor);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test Guild.Tests --filter FullyQualifiedName~ChannelValidatorTests`
Expected: FAIL to compile, `'Channel' does not contain a definition for 'Icon'`.

- [ ] **Step 3: Add the two properties to the aggregate**

In `Guild.Domain/Aggregates/Channel.cs`, after the `SlowModeSeconds` property:

```csharp
    /// <summary>Lucide icon name, kebab-case. Null falls back to the channel type's own icon.</summary>
    public string? Icon { get; set; }

    /// <summary>#RRGGBB. Null falls back to the uniform default colour.</summary>
    public string? IconColor { get; set; }
```

- [ ] **Step 4: Add both to UpdateChannelParams and Update()**

In the same file, extend `UpdateChannelParams`:

```csharp
    public class UpdateChannelParams
    {
        public string Name { get; init; } = null!;
        public string? Description { get; init; }
        public bool IsAgeRestricted { get; init; }
        public int SlowModeSeconds { get; init; }

        // Absolute values. The endpoint has already resolved the clear sentinel.
        public string? Icon { get; init; }
        public string? IconColor { get; init; }
    }
```

and in `Update(UpdateChannelParams @params)`, before the `ValidateAndThrow` call:

```csharp
        Icon = @params.Icon;
        IconColor = @params.IconColor;
```

- [ ] **Step 5: Add the validator rules**

In `Guild.Domain/Validators/ChannelValidator.cs`, inside the constructor:

```csharp
        RuleFor(x => x.Icon)
            .Matches("^[a-z0-9-]{1,48}$")
            .When(x => !string.IsNullOrEmpty(x.Icon))
            .WithMessage("Channel icon must be a lowercase kebab-case name");

        RuleFor(x => x.IconColor)
            .Matches("^#[0-9a-fA-F]{6}$")
            .When(x => !string.IsNullOrEmpty(x.IconColor))
            .WithMessage("Channel icon colour must be #RRGGBB");
```

Add `using System.Text.RegularExpressions;` only if the analyser demands it; `Matches` takes a string.

- [ ] **Step 6: Run the test to verify it passes**

Run: `dotnet test Guild.Tests --filter FullyQualifiedName~ChannelValidatorTests`
Expected: PASS, all 20 cases.

- [ ] **Step 7: Generate the migration**

Run from the repo root:

```bash
dotnet ef migrations add AddChannelIcon --project Guild.Infrastructure --startup-project Echo
```

- [ ] **Step 8: Verify the migration adds exactly two nullable columns**

Open the generated `<timestamp>_AddChannelIcon.cs`. Its `Up` must contain two `AddColumn<string>` calls against `Channels`, both `nullable: true`, and nothing else beyond the boilerplate `AlterDatabase` enum annotations that every migration in this repo carries.

If it contains any other schema change, the model snapshot had drifted before this task. Stop and report rather than committing unrelated schema changes.

- [ ] **Step 9: Commit**

```bash
git add Guild.Domain/Aggregates/Channel.cs Guild.Domain/Validators/ChannelValidator.cs Guild.Infrastructure/Migrations Guild.Tests/Domain/ChannelValidatorTests.cs
git commit -m "feat(guild): add icon and icon colour to channel"
```

---

### Task 2: Channel PATCH accepts icon and colour

**Repo:** `C:\Users\Domin\RiderProjects\Echo`

**Files:**
- Modify: `Guild.Application/Dtos/Request/UpdateChannelDto.cs`
- Modify: `Guild.Application/Endpoints/Channel/ChannelEndpoint.cs:176-252`
- Test: `Guild.Tests/Endpoints/ChannelEndpointTests.cs`

**Interfaces:**
- Consumes: `Channel.Icon`, `Channel.IconColor`, `UpdateChannelParams.Icon`, `UpdateChannelParams.IconColor` from Task 1.
- Produces: `UpdateChannelDto.Icon` (`string?`), `UpdateChannelDto.IconColor` (`string?`) carrying the clear sentinel. The PATCH 200 response gains `Icon`, `IconColor`, `Description`, `CategoryId`, `Position`, `SlowModeSeconds`.

- [ ] **Step 1: Write the failing endpoint tests**

Append to `Guild.Tests/Endpoints/ChannelEndpointTests.cs`, matching the fixture style already used by the tests in that file (read the file first and reuse its existing arrange helpers rather than inventing new ones):

```csharp
    [Fact]
    public async Task UpdateChannel_SetsIconAndColour()
    {
        var channel = await CreateChannelAsync();

        var result = await UpdateAsync(channel.Id, new UpdateChannelDto
        {
            Name = channel.Name,
            Icon = "swords",
            IconColor = "#F87171",
        });

        var saved = await Context.Channels.FirstAsync(c => c.Id == channel.Id);
        Assert.Equal("swords", saved.Icon);
        Assert.Equal("#F87171", saved.IconColor);
    }

    [Fact]
    public async Task UpdateChannel_NullIconLeavesStoredValueAlone()
    {
        var channel = await CreateChannelAsync(icon: "swords", iconColor: "#F87171");

        await UpdateAsync(channel.Id, new UpdateChannelDto
        {
            Name = channel.Name,
            Icon = null,
            IconColor = null,
        });

        var saved = await Context.Channels.FirstAsync(c => c.Id == channel.Id);
        Assert.Equal("swords", saved.Icon);
        Assert.Equal("#F87171", saved.IconColor);
    }

    [Fact]
    public async Task UpdateChannel_EmptyStringClearsIcon()
    {
        var channel = await CreateChannelAsync(icon: "swords", iconColor: "#F87171");

        await UpdateAsync(channel.Id, new UpdateChannelDto
        {
            Name = channel.Name,
            Icon = "",
            IconColor = "",
        });

        var saved = await Context.Channels.FirstAsync(c => c.Id == channel.Id);
        Assert.Null(saved.Icon);
        Assert.Null(saved.IconColor);
    }

    [Fact]
    public async Task UpdateChannel_ResponseCarriesEveryEditableField()
    {
        var channel = await CreateChannelAsync();

        var result = await UpdateAsync(channel.Id, new UpdateChannelDto
        {
            Name = "renamed",
            Description = "a description",
            SlowModeSeconds = 30,
            Icon = "swords",
            IconColor = "#F87171",
        });

        var dto = Assert.IsType<ChannelDto>(GetValue(result));
        Assert.Equal("renamed", dto.Name);
        Assert.Equal("a description", dto.Description);
        Assert.Equal(30, dto.SlowModeSeconds);
        Assert.Equal("swords", dto.Icon);
        Assert.Equal("#F87171", dto.IconColor);
        Assert.Equal(channel.Position, dto.Position);
        Assert.Equal(channel.CategoryId, dto.CategoryId);
    }
```

If the file has no `CreateChannelAsync`, `UpdateAsync` or `GetValue` helper, add them alongside the existing arrangement code in that file rather than duplicating fixture setup inside each test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test Guild.Tests --filter FullyQualifiedName~ChannelEndpointTests`
Expected: FAIL to compile, `'UpdateChannelDto' does not contain a definition for 'Icon'`.

- [ ] **Step 3: Add the two fields to the request DTO**

In `Guild.Application/Dtos/Request/UpdateChannelDto.cs`, after `SlowModeSeconds`:

```csharp
    /// <summary>
    /// Null leaves the stored icon alone, so a client that predates this field cannot wipe it.
    /// An empty string resets the channel to its type's icon.
    /// </summary>
    public string? Icon { get; set; }

    /// <summary>Same sentinel as <see cref="Icon"/>: null keeps, empty clears.</summary>
    public string? IconColor { get; set; }
```

- [ ] **Step 4: Resolve the sentinel in the endpoint**

In `ChannelEndpoint.UpdateChannelAsync`, immediately before the `try` block:

```csharp
        // Absent and explicit null both deserialise to null, which is what makes "null keeps" work
        // for clients that do not send these fields at all.
        var icon = dto.Icon is null ? channel.Icon : NullIfEmpty(dto.Icon);
        var iconColor = dto.IconColor is null ? channel.IconColor : NullIfEmpty(dto.IconColor);
```

and inside the `channel.Update(new ...UpdateChannelParams { ... })` initialiser, add:

```csharp
                Icon = icon,
                IconColor = iconColor,
```

Add this private static helper to the endpoint class:

```csharp
    private static string? NullIfEmpty(string value) => value.Length == 0 ? null : value;
```

- [ ] **Step 5: Complete the response projection**

Replace the `return Results.Ok(new ChannelDto { ... })` at the end of `UpdateChannelAsync` with:

```csharp
        return Results.Ok(new ChannelDto
        {
            Type = channel.Type,
            GuildId = channel.GuildId,
            Id = channel.Id,
            Name = channel.Name,
            Description = channel.Description,
            CreatedAt = channel.CreatedAt,
            UpdatedAt = channel.UpdatedAt,
            IsAgeRestricted = channel.IsAgeRestricted,
            IsPrivate = channel.IsPrivate,
            CategoryId = channel.CategoryId,
            Position = channel.Position,
            SlowModeSeconds = channel.SlowModeSeconds,
            Icon = channel.Icon,
            IconColor = channel.IconColor,
        });
```

The client emits this response straight into its `channelUpdated` output, so a field missing here reads as the value being wiped until the next refetch.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `dotnet test Guild.Tests --filter FullyQualifiedName~ChannelEndpointTests`
Expected: PASS. Tests requiring Docker fail in this environment and are pre-existing; confirm the four new tests are among the passing ones rather than counting the total.

- [ ] **Step 7: Commit**

```bash
git add Guild.Application/Dtos/Request/UpdateChannelDto.cs Guild.Application/Endpoints/Channel/ChannelEndpoint.cs Guild.Tests/Endpoints/ChannelEndpointTests.cs
git commit -m "feat(guild): accept icon and colour on the channel patch"
```

---

### Task 3: The Lucide renderer

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`

**Files:**
- Create: `src/app/components/lucide-icon/lucide-icon.component.ts`
- Test: `src/app/components/lucide-icon/lucide-icon.component.spec.ts`
- Modify: `package.json` (add `lucide`)

**Interfaces:**
- Consumes: nothing.
- Produces: `LucideIconComponent`, selector `app-lucide-icon`, one required input `icon: IconNode` where `IconNode` is imported from `lucide` and equals `[tag: string, attrs: SVGProps][]`. Renders an `svg` with `stroke="currentColor"`, so CSS `color` tints it.

- [ ] **Step 1: Add the dependency**

Run: `bun add lucide`
Expected: `installed lucide@1.33.0`. It is ISC-licensed and data-only. Do **not** add `lucide-angular`: its component throws on an unresolved name and ships Angular 13 partial declarations.

- [ ] **Step 2: Write the failing test**

Create `src/app/components/lucide-icon/lucide-icon.component.spec.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import type {IconNode} from 'lucide';
import {LucideIconComponent} from './lucide-icon.component';

const TWO_PATHS: IconNode = [
    ['path', {d: 'M1 1h10'}],
    ['circle', {cx: '5', cy: '5', r: '3'}],
];

@Component({
    imports: [LucideIconComponent],
    template: '<app-lucide-icon [icon]="icon()" />',
})
class HostComponent {
    readonly icon = signal<IconNode>(TWO_PATHS);
}

describe('LucideIconComponent', () => {
    function render() {
        const fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        return fixture;
    }

    it('renders one element per icon node, in order', () => {
        const svg = render().nativeElement.querySelector('svg');
        expect([...svg.children].map((c: Element) => c.tagName)).toEqual(['path', 'circle']);
    });

    it('applies every attribute from the node', () => {
        const path = render().nativeElement.querySelector('path');
        expect(path.getAttribute('d')).toBe('M1 1h10');
    });

    it('strokes with currentColor so css can tint it', () => {
        const svg = render().nativeElement.querySelector('svg');
        expect(svg.getAttribute('stroke')).toBe('currentColor');
    });

    it('is hidden from assistive tech', () => {
        const svg = render().nativeElement.querySelector('svg');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('replaces the children when the icon changes', () => {
        const fixture = render();
        fixture.componentInstance.icon.set([['rect', {x: '0', y: '0'}]]);
        fixture.detectChanges();
        const svg = fixture.nativeElement.querySelector('svg');
        expect([...svg.children].map((c: Element) => c.tagName)).toEqual(['rect']);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run ng test --watch=false --include="**/lucide-icon.component.spec.ts"`
Expected: FAIL, cannot resolve `./lucide-icon.component`.

- [ ] **Step 4: Write the component**

Create `src/app/components/lucide-icon/lucide-icon.component.ts`:

```typescript
import {ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, viewChild} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import type {IconNode} from 'lucide';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Renders one lucide icon. The data is bundled at build time, never user input. */
@Component({
    selector: 'app-lucide-icon',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'contents'},
    template: `
        <svg
            #svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        ></svg>
    `,
})
export class LucideIconComponent {
    readonly icon = input.required<IconNode>();

    private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
    private readonly doc = inject(DOCUMENT);

    constructor() {
        effect(() => {
            const host = this.svg().nativeElement;
            host.replaceChildren();
            for (const [tag, attrs] of this.icon()) {
                const el = this.doc.createElementNS(SVG_NS, tag);
                for (const [name, value] of Object.entries(attrs)) {
                    el.setAttribute(name, String(value));
                }
                host.appendChild(el);
            }
        });
    }
}
```

`width`/`height` in `em` rather than lucide's default 24px, so the slot's `font-size` sizes the icon the way it sized the icon font.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run ng test --watch=false --include="**/lucide-icon.component.spec.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 6: Lint and format your files**

```bash
bun run lint
bunx prettier --write src/app/components/lucide-icon
```

Never run bare `bun run format`.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/app/components/lucide-icon
git commit -m "feat: add a lucide icon renderer"
```

---

### Task 4: The channel icon catalog

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`

**Files:**
- Create: `src/app/features/guild/channel-icon-catalog.ts`
- Test: `src/app/features/guild/channel-icon-catalog.spec.ts`

**Interfaces:**
- Consumes: `IconNode` from `lucide` (Task 3 added the dependency).
- Produces:
  - `type ChannelIconGroup = 'general' | 'communication' | 'gaming' | 'media' | 'places' | 'objects' | 'nature' | 'symbols'`
  - `interface ChannelIconEntry {name: string; icon: IconNode; group: ChannelIconGroup}`
  - `const CHANNEL_ICON_CATALOG: readonly ChannelIconEntry[]`
  - `const CHANNEL_ICON_GROUPS: readonly ChannelIconGroup[]`
  - `function lookupChannelIcon(name: string | null | undefined): IconNode | null`

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/channel-icon-catalog.spec.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {
    CHANNEL_ICON_CATALOG,
    CHANNEL_ICON_GROUPS,
    lookupChannelIcon,
} from './channel-icon-catalog';

const NAME_PATTERN = /^[a-z0-9-]{1,48}$/;

describe('CHANNEL_ICON_CATALOG', () => {
    it('has no duplicate names', () => {
        const names = CHANNEL_ICON_CATALOG.map(e => e.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('gives every entry a name the server will accept', () => {
        for (const entry of CHANNEL_ICON_CATALOG) {
            expect(entry.name, entry.name).toMatch(NAME_PATTERN);
        }
    });

    it('gives every entry non-empty icon data', () => {
        for (const entry of CHANNEL_ICON_CATALOG) {
            expect(entry.icon.length, entry.name).toBeGreaterThan(0);
        }
    });

    it('puts every entry in a declared group', () => {
        for (const entry of CHANNEL_ICON_CATALOG) {
            expect(CHANNEL_ICON_GROUPS, entry.name).toContain(entry.group);
        }
    });

    it('fills every declared group', () => {
        for (const group of CHANNEL_ICON_GROUPS) {
            expect(CHANNEL_ICON_CATALOG.some(e => e.group === group), group).toBe(true);
        }
    });
});

describe('lookupChannelIcon', () => {
    it('resolves a catalog name to its data', () => {
        expect(lookupChannelIcon('volume-2')).toBe(
            CHANNEL_ICON_CATALOG.find(e => e.name === 'volume-2')!.icon,
        );
    });

    it('returns null for a name it does not ship', () => {
        expect(lookupChannelIcon('not-a-real-icon')).toBeNull();
    });

    it('returns null for null, undefined and empty', () => {
        expect(lookupChannelIcon(null)).toBeNull();
        expect(lookupChannelIcon(undefined)).toBeNull();
        expect(lookupChannelIcon('')).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run ng test --watch=false --include="**/channel-icon-catalog.spec.ts"`
Expected: FAIL, cannot resolve `./channel-icon-catalog`.

- [ ] **Step 3: Write the catalog**

Create `src/app/features/guild/channel-icon-catalog.ts`. Import icons by name from `lucide`; never `import * as`, which defeats tree-shaking.

Three lucide exports collide with globals this file or its consumers rely on, so they are aliased on import. `Map` is the sharp one: unaliased it shadows the `Map` constructor and `new Map(...)` at the bottom of this very file stops working.

```typescript
import type {IconNode} from 'lucide';
import {
    Anchor, Archive, Award, Bell, Bookmark, Box, Calendar, Clock, Cog, Compass,
    Crown, Flag, Folder, Hash, Home, Inbox, Info, Layers, LifeBuoy, Link,
    List, Lock, Mail, Map as MapIcon, Megaphone, Package, Paperclip, Pin, Search, Settings,
    Shield, Star, Tag, Target, Trophy, Users, Wallet, Wrench,
    AtSign, Handshake, HeartHandshake, MessageCircle, MessageSquare, MessagesSquare, Mic, Phone, Podcast, Quote,
    Radio, Reply, Send, Speech, Video, Voicemail, Volume2, Vote,
    Bomb, Castle, Crosshair, Dice5, Drama, Ghost, Gamepad2, Joystick, Puzzle, Rocket,
    Scroll, Shapes, Skull, Sparkles, Swords, Tent, Wand2, Zap,
    Aperture, Book, BookOpen, Camera, Clapperboard, Disc3, Film, Headphones, Image as ImageIcon, Images,
    Library, Music, Newspaper, Palette, Piano, Projector, Tv, Youtube,
    Anvil, Building2, Church, Factory, Fence, Landmark, MapPin, Mountain, Route, School,
    Ship, Signpost, Store, Train, Warehouse, Waypoints,
    Backpack, Banknote, Beaker, Bike, Briefcase, Brush, Car, ChefHat, Coffee, Coins,
    Cpu, Croissant, Gem, Gift, Glasses, Hammer, Key, Lamp, Laptop, Pizza,
    Scissors, Shirt, ShoppingCart, Sofa, Syringe, Utensils, Wine,
    Bird, Bug, Cat, Cherry, Cloud, Clover, Dog, Droplet, Feather, Fish,
    Flame, Flower2, Leaf, Moon, Rabbit, Snowflake, Sprout, Sun, TreePine, Waves,
    Activity, Asterisk, Atom, Binary, BrainCircuit, CircleDot, Code, Diamond, Divide, Eye,
    Heart, Hexagon, Infinity as InfinityIcon, Orbit, Percent, Pyramid, Sigma, Spade, Triangle,
} from 'lucide';

export type ChannelIconGroup =
    | 'general'
    | 'communication'
    | 'gaming'
    | 'media'
    | 'places'
    | 'objects'
    | 'nature'
    | 'symbols';

export interface ChannelIconEntry {
    /** The stored value. Must satisfy the server's `^[a-z0-9-]{1,48}$`. */
    name: string;
    icon: IconNode;
    group: ChannelIconGroup;
}

/** Picker order. */
export const CHANNEL_ICON_GROUPS: readonly ChannelIconGroup[] = [
    'general',
    'communication',
    'gaming',
    'media',
    'places',
    'objects',
    'nature',
    'symbols',
];

/** The only place a channel icon may come from. The picker and the name lookup both derive from it, so a listed icon is always resolvable and a resolvable icon is always listed. */
export const CHANNEL_ICON_CATALOG: readonly ChannelIconEntry[] = [
    {name: 'anchor', icon: Anchor, group: 'general'},
    {name: 'archive', icon: Archive, group: 'general'},
    {name: 'award', icon: Award, group: 'general'},
    {name: 'bell', icon: Bell, group: 'general'},
    {name: 'bookmark', icon: Bookmark, group: 'general'},
    {name: 'box', icon: Box, group: 'general'},
    {name: 'calendar', icon: Calendar, group: 'general'},
    {name: 'clock', icon: Clock, group: 'general'},
    {name: 'cog', icon: Cog, group: 'general'},
    {name: 'compass', icon: Compass, group: 'general'},
    {name: 'crown', icon: Crown, group: 'general'},
    {name: 'flag', icon: Flag, group: 'general'},
    {name: 'folder', icon: Folder, group: 'general'},
    {name: 'hash', icon: Hash, group: 'general'},
    {name: 'home', icon: Home, group: 'general'},
    {name: 'inbox', icon: Inbox, group: 'general'},
    {name: 'info', icon: Info, group: 'general'},
    {name: 'layers', icon: Layers, group: 'general'},
    {name: 'life-buoy', icon: LifeBuoy, group: 'general'},
    {name: 'link', icon: Link, group: 'general'},
    {name: 'list', icon: List, group: 'general'},
    {name: 'lock', icon: Lock, group: 'general'},
    {name: 'mail', icon: Mail, group: 'general'},
    {name: 'map', icon: MapIcon, group: 'general'},
    {name: 'megaphone', icon: Megaphone, group: 'general'},
    {name: 'package', icon: Package, group: 'general'},
    {name: 'paperclip', icon: Paperclip, group: 'general'},
    {name: 'pin', icon: Pin, group: 'general'},
    {name: 'search', icon: Search, group: 'general'},
    {name: 'settings', icon: Settings, group: 'general'},
    {name: 'shield', icon: Shield, group: 'general'},
    {name: 'star', icon: Star, group: 'general'},
    {name: 'tag', icon: Tag, group: 'general'},
    {name: 'target', icon: Target, group: 'general'},
    {name: 'trophy', icon: Trophy, group: 'general'},
    {name: 'users', icon: Users, group: 'general'},
    {name: 'wallet', icon: Wallet, group: 'general'},
    {name: 'wrench', icon: Wrench, group: 'general'},

    {name: 'at-sign', icon: AtSign, group: 'communication'},
    {name: 'handshake', icon: Handshake, group: 'communication'},
    {name: 'heart-handshake', icon: HeartHandshake, group: 'communication'},
    {name: 'message-circle', icon: MessageCircle, group: 'communication'},
    {name: 'message-square', icon: MessageSquare, group: 'communication'},
    {name: 'messages-square', icon: MessagesSquare, group: 'communication'},
    {name: 'mic', icon: Mic, group: 'communication'},
    {name: 'phone', icon: Phone, group: 'communication'},
    {name: 'podcast', icon: Podcast, group: 'communication'},
    {name: 'quote', icon: Quote, group: 'communication'},
    {name: 'radio', icon: Radio, group: 'communication'},
    {name: 'reply', icon: Reply, group: 'communication'},
    {name: 'send', icon: Send, group: 'communication'},
    {name: 'speech', icon: Speech, group: 'communication'},
    {name: 'video', icon: Video, group: 'communication'},
    {name: 'voicemail', icon: Voicemail, group: 'communication'},
    {name: 'volume-2', icon: Volume2, group: 'communication'},
    {name: 'vote', icon: Vote, group: 'communication'},

    {name: 'bomb', icon: Bomb, group: 'gaming'},
    {name: 'castle', icon: Castle, group: 'gaming'},
    {name: 'crosshair', icon: Crosshair, group: 'gaming'},
    {name: 'dice-5', icon: Dice5, group: 'gaming'},
    {name: 'drama', icon: Drama, group: 'gaming'},
    {name: 'gamepad-2', icon: Gamepad2, group: 'gaming'},
    {name: 'ghost', icon: Ghost, group: 'gaming'},
    {name: 'joystick', icon: Joystick, group: 'gaming'},
    {name: 'puzzle', icon: Puzzle, group: 'gaming'},
    {name: 'rocket', icon: Rocket, group: 'gaming'},
    {name: 'scroll', icon: Scroll, group: 'gaming'},
    {name: 'shapes', icon: Shapes, group: 'gaming'},
    {name: 'skull', icon: Skull, group: 'gaming'},
    {name: 'sparkles', icon: Sparkles, group: 'gaming'},
    {name: 'swords', icon: Swords, group: 'gaming'},
    {name: 'tent', icon: Tent, group: 'gaming'},
    {name: 'wand-2', icon: Wand2, group: 'gaming'},
    {name: 'zap', icon: Zap, group: 'gaming'},

    {name: 'aperture', icon: Aperture, group: 'media'},
    {name: 'book', icon: Book, group: 'media'},
    {name: 'book-open', icon: BookOpen, group: 'media'},
    {name: 'camera', icon: Camera, group: 'media'},
    {name: 'clapperboard', icon: Clapperboard, group: 'media'},
    {name: 'disc-3', icon: Disc3, group: 'media'},
    {name: 'film', icon: Film, group: 'media'},
    {name: 'headphones', icon: Headphones, group: 'media'},
    {name: 'image', icon: ImageIcon, group: 'media'},
    {name: 'images', icon: Images, group: 'media'},
    {name: 'library', icon: Library, group: 'media'},
    {name: 'music', icon: Music, group: 'media'},
    {name: 'newspaper', icon: Newspaper, group: 'media'},
    {name: 'palette', icon: Palette, group: 'media'},
    {name: 'piano', icon: Piano, group: 'media'},
    {name: 'projector', icon: Projector, group: 'media'},
    {name: 'tv', icon: Tv, group: 'media'},
    {name: 'youtube', icon: Youtube, group: 'media'},

    {name: 'anvil', icon: Anvil, group: 'places'},
    {name: 'building-2', icon: Building2, group: 'places'},
    {name: 'church', icon: Church, group: 'places'},
    {name: 'factory', icon: Factory, group: 'places'},
    {name: 'fence', icon: Fence, group: 'places'},
    {name: 'landmark', icon: Landmark, group: 'places'},
    {name: 'map-pin', icon: MapPin, group: 'places'},
    {name: 'mountain', icon: Mountain, group: 'places'},
    {name: 'route', icon: Route, group: 'places'},
    {name: 'school', icon: School, group: 'places'},
    {name: 'ship', icon: Ship, group: 'places'},
    {name: 'signpost', icon: Signpost, group: 'places'},
    {name: 'store', icon: Store, group: 'places'},
    {name: 'train', icon: Train, group: 'places'},
    {name: 'warehouse', icon: Warehouse, group: 'places'},
    {name: 'waypoints', icon: Waypoints, group: 'places'},

    {name: 'backpack', icon: Backpack, group: 'objects'},
    {name: 'banknote', icon: Banknote, group: 'objects'},
    {name: 'beaker', icon: Beaker, group: 'objects'},
    {name: 'bike', icon: Bike, group: 'objects'},
    {name: 'briefcase', icon: Briefcase, group: 'objects'},
    {name: 'brush', icon: Brush, group: 'objects'},
    {name: 'car', icon: Car, group: 'objects'},
    {name: 'chef-hat', icon: ChefHat, group: 'objects'},
    {name: 'coffee', icon: Coffee, group: 'objects'},
    {name: 'coins', icon: Coins, group: 'objects'},
    {name: 'cpu', icon: Cpu, group: 'objects'},
    {name: 'croissant', icon: Croissant, group: 'objects'},
    {name: 'gem', icon: Gem, group: 'objects'},
    {name: 'gift', icon: Gift, group: 'objects'},
    {name: 'glasses', icon: Glasses, group: 'objects'},
    {name: 'hammer', icon: Hammer, group: 'objects'},
    {name: 'key', icon: Key, group: 'objects'},
    {name: 'lamp', icon: Lamp, group: 'objects'},
    {name: 'laptop', icon: Laptop, group: 'objects'},
    {name: 'pizza', icon: Pizza, group: 'objects'},
    {name: 'scissors', icon: Scissors, group: 'objects'},
    {name: 'shirt', icon: Shirt, group: 'objects'},
    {name: 'shopping-cart', icon: ShoppingCart, group: 'objects'},
    {name: 'sofa', icon: Sofa, group: 'objects'},
    {name: 'syringe', icon: Syringe, group: 'objects'},
    {name: 'utensils', icon: Utensils, group: 'objects'},
    {name: 'wine', icon: Wine, group: 'objects'},

    {name: 'bird', icon: Bird, group: 'nature'},
    {name: 'bug', icon: Bug, group: 'nature'},
    {name: 'cat', icon: Cat, group: 'nature'},
    {name: 'cherry', icon: Cherry, group: 'nature'},
    {name: 'cloud', icon: Cloud, group: 'nature'},
    {name: 'clover', icon: Clover, group: 'nature'},
    {name: 'dog', icon: Dog, group: 'nature'},
    {name: 'droplet', icon: Droplet, group: 'nature'},
    {name: 'feather', icon: Feather, group: 'nature'},
    {name: 'fish', icon: Fish, group: 'nature'},
    {name: 'flame', icon: Flame, group: 'nature'},
    {name: 'flower-2', icon: Flower2, group: 'nature'},
    {name: 'leaf', icon: Leaf, group: 'nature'},
    {name: 'moon', icon: Moon, group: 'nature'},
    {name: 'rabbit', icon: Rabbit, group: 'nature'},
    {name: 'snowflake', icon: Snowflake, group: 'nature'},
    {name: 'sprout', icon: Sprout, group: 'nature'},
    {name: 'sun', icon: Sun, group: 'nature'},
    {name: 'tree-pine', icon: TreePine, group: 'nature'},
    {name: 'waves', icon: Waves, group: 'nature'},

    {name: 'activity', icon: Activity, group: 'symbols'},
    {name: 'asterisk', icon: Asterisk, group: 'symbols'},
    {name: 'atom', icon: Atom, group: 'symbols'},
    {name: 'binary', icon: Binary, group: 'symbols'},
    {name: 'brain-circuit', icon: BrainCircuit, group: 'symbols'},
    {name: 'circle-dot', icon: CircleDot, group: 'symbols'},
    {name: 'code', icon: Code, group: 'symbols'},
    {name: 'diamond', icon: Diamond, group: 'symbols'},
    {name: 'divide', icon: Divide, group: 'symbols'},
    {name: 'eye', icon: Eye, group: 'symbols'},
    {name: 'heart', icon: Heart, group: 'symbols'},
    {name: 'hexagon', icon: Hexagon, group: 'symbols'},
    {name: 'infinity', icon: InfinityIcon, group: 'symbols'},
    {name: 'orbit', icon: Orbit, group: 'symbols'},
    {name: 'percent', icon: Percent, group: 'symbols'},
    {name: 'pyramid', icon: Pyramid, group: 'symbols'},
    {name: 'sigma', icon: Sigma, group: 'symbols'},
    {name: 'spade', icon: Spade, group: 'symbols'},
    {name: 'triangle', icon: Triangle, group: 'symbols'},
];

const ICON_BY_NAME = new Map<string, IconNode>(CHANNEL_ICON_CATALOG.map(e => [e.name, e.icon]));

/** Null for anything this build does not ship, which is what keeps an icon name from a newer server off the render path. */
export function lookupChannelIcon(name: string | null | undefined): IconNode | null {
    if (!name) return null;
    return ICON_BY_NAME.get(name) ?? null;
}
```

Verify every named import exists in `lucide@1.33.0` before running the test:

```bash
grep -oP '^declare const \K\w+' node_modules/lucide/dist/lucide.d.ts | sort > /tmp/lucide-exports.txt
grep -oP "icon: \K\w+" src/app/features/guild/channel-icon-catalog.ts | sed 's/Icon$//' | sort -u | comm -23 - /tmp/lucide-exports.txt
```

Expected: no output. Any name printed does not exist in this lucide version. Substitute the nearest real export and keep the entry's `name` field as the kebab-case of whatever export you land on, so the stored value and the lucide name never disagree.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run ng test --watch=false --include="**/channel-icon-catalog.spec.ts"`
Expected: PASS, 8 tests.

- [ ] **Step 5: Lint and format**

```bash
bun run lint
bunx prettier --write src/app/features/guild/channel-icon-catalog.ts src/app/features/guild/channel-icon-catalog.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/channel-icon-catalog.ts src/app/features/guild/channel-icon-catalog.spec.ts
git commit -m "feat(guild): add the channel icon catalog"
```

---

### Task 5: Move the type table to Lucide and add the channel lookup

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`

**Files:**
- Modify: `src/app/features/guild/channel-types.ts:18-181`
- Modify: `src/app/features/guild/channel-types.spec.ts:37-68`
- Modify: `src/app/dtos/response/guild.dto.ts:33-63`
- Modify: `src/app/services/guild.service.ts:95-101`

**Interfaces:**
- Consumes: `lookupChannelIcon` and `CHANNEL_ICON_CATALOG` from Task 4.
- Produces:
  - `ChannelDto.icon?: string`, `ChannelDto.iconColor?: string`
  - `UpdateChannelDto.icon?: string`, `UpdateChannelDto.iconColor?: string`
  - `channelIcon(type: ChannelType): string | null` still returns a **name**, now a lucide one
  - `channelIconDataFor(channel: {type: ChannelType; icon?: string}): IconNode | null`
  - `channelIconTint(channel: {iconColor?: string}): string | null`

- [ ] **Step 1: Write the failing tests**

In `src/app/features/guild/channel-types.spec.ts`, replace the icon assertion inside the `'gives every entry translation keys, and an icon for all but Text'` test:

```typescript
            if (meta.type === ChannelType.Text) {
                expect(meta.icon).toBeNull(); // renders a literal '#'
            } else {
                expect(meta.icon, meta.type).toMatch(/^[a-z0-9-]{1,48}$/);
            }
```

replace the whole `describe('channelIcon', ...)` body's per-type expectations:

```typescript
describe('channelIcon', () => {
    it('is null for Text, which renders a literal #', () => {
        expect(channelIcon(ChannelType.Text)).toBeNull();
    });

    it('names a lucide icon for the other types', () => {
        expect(channelIcon(ChannelType.Voice)).toBe('volume-2');
        expect(channelIcon(ChannelType.Forum)).toBe('messages-square');
        expect(channelIcon(ChannelType.Media)).toBe('images');
        expect(channelIcon(ChannelType.Announcement)).toBe('megaphone');
        expect(channelIcon(ChannelType.List)).toBe('square-check');
        expect(channelIcon(ChannelType.Chores)).toBe('refresh-cw');
        expect(channelIcon(ChannelType.Ledger)).toBe('wallet');
        expect(channelIcon(ChannelType.Pantry)).toBe('package');
        expect(channelIcon(ChannelType.Decisions)).toBe('flag');
    });

    it('is null for a type this build does not know', () => {
        expect(channelIcon('Sauna' as ChannelType)).toBeNull();
    });
});
```

and append:

```typescript
describe('channelIconDataFor', () => {
    it('prefers the channel own icon over the type default', () => {
        const data = channelIconDataFor({type: ChannelType.Text, icon: 'swords'});
        expect(data).toBe(lookupChannelIcon('swords'));
    });

    it('falls back to the type default when the channel sets none', () => {
        expect(channelIconDataFor({type: ChannelType.Voice})).toBe(lookupChannelIcon('volume-2'));
    });

    it('falls back to the type default when the stored name is not shipped', () => {
        expect(channelIconDataFor({type: ChannelType.Voice, icon: 'not-a-real-icon'})).toBe(
            lookupChannelIcon('volume-2'),
        );
    });

    it('is null for a Text channel with no icon, so the row renders its #', () => {
        expect(channelIconDataFor({type: ChannelType.Text})).toBeNull();
    });

    it('is null when neither the channel nor the type resolves', () => {
        expect(channelIconDataFor({type: 'Sauna' as ChannelType, icon: 'nope'})).toBeNull();
    });
});

describe('channelIconTint', () => {
    it('passes a well-formed hex through', () => {
        expect(channelIconTint({iconColor: '#F87171'})).toBe('#F87171');
    });

    it('is null when unset', () => {
        expect(channelIconTint({})).toBeNull();
        expect(channelIconTint({iconColor: ''})).toBeNull();
    });

    it('is null for anything that is not #rrggbb, so a bad value cannot reach a style binding', () => {
        expect(channelIconTint({iconColor: 'red'})).toBeNull();
        expect(channelIconTint({iconColor: '#fff'})).toBeNull();
        expect(channelIconTint({iconColor: 'url(javascript:alert(1))'})).toBeNull();
    });
});

describe('CHANNEL_META icons are all catalog members', () => {
    it('resolves every non-null default', () => {
        for (const meta of CHANNEL_META) {
            if (meta.icon === null) continue;
            expect(lookupChannelIcon(meta.icon), meta.type).not.toBeNull();
        }
    });
});
```

Add `channelIconDataFor`, `channelIconTint` to the existing import from `./channel-types`, and `import {lookupChannelIcon} from './channel-icon-catalog';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run ng test --watch=false --include="**/channel-types.spec.ts"`
Expected: FAIL, `channelIconDataFor is not exported`.

- [ ] **Step 3: Move the CHANNEL_META icon values to lucide names**

In `src/app/features/guild/channel-types.ts`, change the `icon` field's doc comment to:

```typescript
    /** Lucide icon name, or `null` for Text - which renders a literal `#` instead. */
    icon: string | null;
```

and replace each entry's icon value:

| Type | New value |
|---|---|
| `Text` | `null` |
| `Voice` | `'volume-2'` |
| `Thread` | `'messages-square'` |
| `Forum` | `'messages-square'` |
| `Media` | `'images'` |
| `Scene` | `'bookmark'` |
| `Announcement` | `'megaphone'` |
| `List` | `'square-check'` |
| `Chores` | `'refresh-cw'` |
| `Ledger` | `'wallet'` |
| `Pantry` | `'package'` |
| `Decisions` | `'flag'` |
| `Meals` | `'book-open'` |
| `Maintenance` | `'wrench'` |

`square-check` and `refresh-cw` are not in the Task 4 catalog groups above. Add them to the `general` group of `CHANNEL_ICON_CATALOG` in `channel-icon-catalog.ts`, importing `SquareCheck` and `RefreshCw` from `lucide`:

```typescript
    {name: 'refresh-cw', icon: RefreshCw, group: 'general'},
    {name: 'square-check', icon: SquareCheck, group: 'general'},
```

The `CHANNEL_META icons are all catalog members` test is what catches this if it is missed.

- [ ] **Step 4: Add the two new lookups**

At the end of `channel-types.ts`:

```typescript
/** The tint a channel asks for, or null. Anything that is not #rrggbb is dropped here rather than reaching a style binding. */
export function channelIconTint(channel: {iconColor?: string}): string | null {
    const colour = channel.iconColor;
    if (!colour || !HEX_COLOUR.test(colour)) return null;
    return colour;
}

/** The icon a channel actually renders: its own if this build ships it, otherwise its type's. */
export function channelIconDataFor(channel: {type: ChannelType; icon?: string}): IconNode | null {
    return lookupChannelIcon(channel.icon) ?? lookupChannelIcon(channelIcon(channel.type));
}
```

with, at the top of the file:

```typescript
import type {IconNode} from 'lucide';
import {lookupChannelIcon} from './channel-icon-catalog';
```

and near the other module-level constants:

```typescript
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
```

- [ ] **Step 5: Add the wire fields**

In `src/app/dtos/response/guild.dto.ts`, inside `interface ChannelDto`, after `slowModeSeconds`:

```typescript
    /** Lucide icon name. Absent means the channel type's own icon. */
    icon?: string;
    /** #RRGGBB. Absent means the uniform default colour. */
    iconColor?: string;
```

In `src/app/services/guild.service.ts`, inside `interface UpdateChannelDto`:

```typescript
    /** Empty string clears it back to the type default; omitting it leaves the stored value alone. */
    icon?: string;
    iconColor?: string;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run ng test --watch=false --include="**/channel-types.spec.ts"`
Then: `bun run ng test --watch=false --include="**/channel-icon-catalog.spec.ts"`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/channel-types.ts src/app/features/guild/channel-types.spec.ts src/app/features/guild/channel-icon-catalog.ts src/app/dtos/response/guild.dto.ts src/app/services/guild.service.ts
git commit -m "feat(guild): move channel type icons to lucide"
```

---

### Task 6: The shared channel icon component and its call sites

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`

**Files:**
- Create: `src/app/features/guild/components/channel-icon/channel-icon.component.ts`
- Test: `src/app/features/guild/components/channel-icon/channel-icon.component.spec.ts`
- Modify: `.../channel-list/components/text-channel-item/text-channel-item.component.html` and `.ts`
- Modify: `.../channel-list/components/voice-channel-item/voice-channel-item.component.html`
- Modify: `.../channel-list/components/create-channel-modal/create-channel-modal.component.html`
- Modify: `.../channel-settings-modal/pages/channel-overview/channel-overview.component.html`
- Modify: `.../create-guild-modal/template-preview.component.html`
- Modify: `src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.html`
- Modify: `.../guild/components/{forum-channel/forum-channel,forum-channel/forum-post-list,list-channel/list-channel,chores-channel/chores-channel,ledger-channel/ledger-channel,pantry-channel/pantry-channel,decisions-channel/decisions-channel,meals-channel/meals-channel,maintenance-channel/maintenance-channel}.component.ts` and their templates
- Modify: `src/app/features/guild/components/wiki/wiki-share/wiki-share-dialog.component.ts`

**Interfaces:**
- Consumes: `LucideIconComponent` (Task 3), `channelIconDataFor`, `channelIconTint`, `channelIcon` (Task 5).
- Produces: `ChannelIconComponent`, selector `app-channel-icon`, inputs `channel: {type: ChannelType; icon?: string; iconColor?: string}` (required) and `fallbackHash: boolean` (default `true`). Emits nothing.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/components/channel-icon/channel-icon.component.spec.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {ChannelIconComponent} from './channel-icon.component';

type Channel = {type: ChannelType; icon?: string; iconColor?: string};

@Component({
    imports: [ChannelIconComponent],
    template: '<app-channel-icon [channel]="channel()" />',
})
class HostComponent {
    readonly channel = signal<Channel>({type: ChannelType.Text});
}

function render(channel: Channel) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.channel.set(channel);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
}

describe('ChannelIconComponent', () => {
    it('renders a hash for a plain text channel', () => {
        const el = render({type: ChannelType.Text});
        expect(el.textContent?.trim()).toBe('#');
        expect(el.querySelector('svg')).toBeNull();
    });

    it('renders the type icon for a voice channel', () => {
        const el = render({type: ChannelType.Voice});
        expect(el.querySelector('svg')).not.toBeNull();
        expect(el.textContent?.trim()).toBe('');
    });

    it('renders a custom icon in place of the hash', () => {
        const el = render({type: ChannelType.Text, icon: 'swords'});
        expect(el.querySelector('svg')).not.toBeNull();
        expect(el.textContent?.trim()).toBe('');
    });

    it('falls back to the hash when the stored icon is not shipped', () => {
        const el = render({type: ChannelType.Text, icon: 'not-a-real-icon'});
        expect(el.textContent?.trim()).toBe('#');
    });

    it('leaves an untinted icon without the tint class or property', () => {
        const slot = render({type: ChannelType.Voice}).querySelector('.chan-icon')!;
        expect(slot.classList.contains('chan-icon-tinted')).toBe(false);
        expect((slot as HTMLElement).style.getPropertyValue('--chan-icon-tint')).toBe('');
    });

    it('tints a channel that sets a colour', () => {
        const slot = render({type: ChannelType.Voice, iconColor: '#F87171'}).querySelector('.chan-icon')!;
        expect(slot.classList.contains('chan-icon-tinted')).toBe(true);
        expect((slot as HTMLElement).style.getPropertyValue('--chan-icon-tint')).toBe('#F87171');
    });

    it('ignores a colour that is not #rrggbb', () => {
        const slot = render({type: ChannelType.Voice, iconColor: 'red'}).querySelector('.chan-icon')!;
        expect(slot.classList.contains('chan-icon-tinted')).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run ng test --watch=false --include="**/channel-icon.component.spec.ts"`
Expected: FAIL, cannot resolve `./channel-icon.component`.

- [ ] **Step 3: Write the component**

Create `src/app/features/guild/components/channel-icon/channel-icon.component.ts`:

```typescript
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {channelIconDataFor, channelIconTint} from '../../channel-types';
import {LucideIconComponent} from '../../../../components/lucide-icon/lucide-icon.component';

/** The channel icon slot: a channel's own icon, else its type's, else the literal `#`. */
@Component({
    selector: 'app-channel-icon',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'contents'},
    imports: [LucideIconComponent],
    template: `
        <span
            class="chan-icon pointer-events-none"
            [class.chan-icon-hash]="!icon()"
            [class.chan-icon-tinted]="!!tint()"
            [style.--chan-icon-tint]="tint()"
        >
            @if (icon(); as data) {
                <app-lucide-icon [icon]="data" />
            } @else if (fallbackHash()) {
                #
            }
        </span>
    `,
})
export class ChannelIconComponent {
    readonly channel = input.required<{type: ChannelType; icon?: string; iconColor?: string}>();
    /** Off for surfaces that would rather show nothing than a `#`, such as the type picker. */
    readonly fallbackHash = input(true);

    protected readonly icon = computed(() => channelIconDataFor(this.channel()));
    protected readonly tint = computed(() => channelIconTint(this.channel()));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run ng test --watch=false --include="**/channel-icon.component.spec.ts"`
Expected: PASS, 7 tests.

- [ ] **Step 5: Swap the sidebar rows**

In `text-channel-item.component.html`, replace the whole `<span class="chan-icon ...">...</span>` block with:

```html
        <app-channel-icon [channel]="channel()" />
```

In `text-channel-item.component.ts`: delete the `icon` computed and the `channelIcon` import, add `ChannelIconComponent` to `imports`.

In `voice-channel-item.component.html`, replace:

```html
        <span class="chan-icon">
            <i [class]="isJoining() ? 'pi pi-spinner pi-spin' : 'pi pi-volume-up'"></i>
        </span>
```

with:

```html
        @if (isJoining()) {
            <span class="chan-icon"><i class="pi pi-spinner pi-spin"></i></span>
        } @else {
            <app-channel-icon [channel]="channel()" />
        }
```

and add `ChannelIconComponent` to that component's `imports`. The spinner stays a PrimeIcon: it is chrome, not the channel's identity, and Phase B sweeps it.

- [ ] **Step 6: Swap the remaining call sites**

For each template listed in **Files** that renders `<i [class]="channelIcon(...)">` or a hardcoded `pi pi-*` standing in for a channel type:

- Where a full channel object is in scope, use `<app-channel-icon [channel]="theChannel" />`.
- Where only a `ChannelType` is in scope (`create-channel-modal`, `template-preview`, `suggestion-overlay` rows built from a type, the `channel-overview` type badge), pass a literal: `<app-channel-icon [channel]="{type: ChannelType.Voice}" [fallbackHash]="false" />`.

In each component `.ts`, add `ChannelIconComponent` to `imports` and remove the now-unused `channelIcon` import and its `protected readonly channelIcon = channelIcon;` field where nothing else uses it.

For the household and forum view headers (`list-channel`, `chores-channel`, `ledger-channel`, `pantry-channel`, `decisions-channel`, `meals-channel`, `maintenance-channel`, `forum-channel`, `forum-post-list`), each has an `icon` computed of the form `channelIcon(this.channel().type) ?? 'pi pi-x'`. Delete the computed, drop the `<i [class]="icon()">` from the template, and use `<app-channel-icon [channel]="channel()" />`. The `?? 'pi pi-...'` fallbacks disappear: `channelIconDataFor` already falls back.

In `channel-overview.component.html`, replace the four-branch type-badge ladder's icons with the component, keeping the branch structure that picks the label text.

- [ ] **Step 7: Verify nothing still reaches for a channel icon class**

Run:

```bash
grep -rn "channelIcon(" src --include=*.ts --include=*.html | grep -v "channel-types"
```

Expected: only `channel-types.spec.ts`. Any other hit is a call site missed in Step 6.

- [ ] **Step 8: Run the full suite**

Run: `bun run test`
Expected: no new failures against the baseline. If a spec in an untouched component fails, re-run it alone before assuming this task caused it: adding spec files reshuffles Vitest's worker batching and surfaces the class-field bug elsewhere.

- [ ] **Step 9: Build**

Run: `bun run ng build --configuration development`
Expected: success. Note the bundle size for the risk log.

- [ ] **Step 10: Lint, format and commit**

```bash
bun run lint
bunx prettier --write src/app/features/guild/components/channel-icon
```

Stage only the files this task touched. Build the list from your own edits, then check it:

```bash
git add src/app/features/guild/components/channel-icon
git add src/app/features/guild/components/channel-list/components/text-channel-item
git add src/app/features/guild/components/channel-list/components/voice-channel-item
git add src/app/features/guild/components/channel-list/components/create-channel-modal
git add src/app/features/guild/components/channel-settings-modal/pages/channel-overview
git add src/app/features/guild/components/create-guild-modal/template-preview.component.html
git add src/app/features/guild/components/wiki/wiki-share/wiki-share-dialog.component.ts
git add src/app/features/guild/components/forum-channel src/app/features/guild/components/list-channel
git add src/app/features/guild/components/chores-channel src/app/features/guild/components/ledger-channel
git add src/app/features/guild/components/pantry-channel src/app/features/guild/components/decisions-channel
git add src/app/features/guild/components/meals-channel src/app/features/guild/components/maintenance-channel
git add src/app/features/messaging/components/conversation/composer/suggestion-overlay

git status --short
```

Read that output before committing. Every staged path must be one you edited. Unstage anything else with `git restore --staged <path>`, which touches the index only.

```bash
git commit -m "feat(guild): render every channel icon through one component"
```

---

### Task 7: The tint styles and the palette

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`

**Files:**
- Modify: `src/styles.css` (after the `.chan-icon-hash` rule at :227)
- Create: `src/app/features/guild/channel-icon-palette.ts`
- Test: `src/app/features/guild/channel-icon-palette.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ChannelIconSwatch {name: string; value: string}` and `const CHANNEL_ICON_PALETTE: readonly ChannelIconSwatch[]`. `name` is an i18n key suffix, `value` is `#RRGGBB`.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/channel-icon-palette.spec.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {CHANNEL_ICON_PALETTE} from './channel-icon-palette';

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
    const channel = (i: number) => {
        const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** The sidebar surface these swatches are read against. */
const SIDEBAR_BG = '#1a1b1e';

describe('CHANNEL_ICON_PALETTE', () => {
    it('is not empty', () => {
        expect(CHANNEL_ICON_PALETTE.length).toBeGreaterThan(0);
    });

    it('gives every swatch a well-formed hex the server will accept', () => {
        for (const swatch of CHANNEL_ICON_PALETTE) {
            expect(swatch.value, swatch.name).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });

    it('has no duplicate values or names', () => {
        expect(new Set(CHANNEL_ICON_PALETTE.map(s => s.value)).size).toBe(CHANNEL_ICON_PALETTE.length);
        expect(new Set(CHANNEL_ICON_PALETTE.map(s => s.name)).size).toBe(CHANNEL_ICON_PALETTE.length);
    });

    it('clears 3:1 against the sidebar surface, so no swatch reads as an empty slot', () => {
        for (const swatch of CHANNEL_ICON_PALETTE) {
            expect(contrast(swatch.value, SIDEBAR_BG), swatch.name).toBeGreaterThanOrEqual(3);
        }
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run ng test --watch=false --include="**/channel-icon-palette.spec.ts"`
Expected: FAIL, cannot resolve `./channel-icon-palette`.

- [ ] **Step 3: Write the palette**

Create `src/app/features/guild/channel-icon-palette.ts`:

```typescript
export interface ChannelIconSwatch {
    /** Suffix of `CHANNEL_SETTINGS.ICON_COLOR.<name>`. */
    name: string;
    value: string;
}

/** Every value clears 3:1 against the sidebar surface; `channel-icon-palette.spec.ts` holds that line. */
export const CHANNEL_ICON_PALETTE: readonly ChannelIconSwatch[] = [
    {name: 'red', value: '#F87171'},
    {name: 'orange', value: '#FB923C'},
    {name: 'amber', value: '#FBBF24'},
    {name: 'lime', value: '#A3E635'},
    {name: 'green', value: '#4ADE80'},
    {name: 'teal', value: '#2DD4BF'},
    {name: 'cyan', value: '#22D3EE'},
    {name: 'blue', value: '#60A5FA'},
    {name: 'indigo', value: '#818CF8'},
    {name: 'violet', value: '#A78BFA'},
    {name: 'pink', value: '#F472B6'},
    {name: 'rose', value: '#FB7185'},
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run ng test --watch=false --include="**/channel-icon-palette.spec.ts"`
Expected: PASS, 4 tests. If a swatch fails the contrast assertion, lighten it rather than lowering the threshold.

- [ ] **Step 5: Add the tint rules**

In `src/styles.css`, directly after the `.chan-icon-hash` rule:

```css
/* A chosen colour is a signal, not chrome, so it sits at 78% where the default sits at 32%:
   a saturated hue at the default's alpha is close to invisible on this surface. */
.chan-icon-tinted {
    color: color-mix(in srgb, var(--chan-icon-tint) 78%, transparent);
}

.chan-row:hover .chan-icon-tinted,
.chan-row.is-active .chan-icon-tinted,
.chan-row.is-unread .chan-icon-tinted {
    color: var(--chan-icon-tint);
}
```

Change no existing rule. A channel with no custom colour must render exactly as it does today.

- [ ] **Step 6: Verify the untinted path is untouched**

Run: `git diff src/styles.css`
Expected: additions only. If the diff shows a modified line inside `.chan-icon`, `.chan-row.is-active .chan-icon`, `.chan-row.is-joined .chan-icon` or `.chan-row-module .chan-icon`, revert that line.

- [ ] **Step 7: Commit**

```bash
bun run lint
bunx prettier --write src/app/features/guild/channel-icon-palette.ts src/app/features/guild/channel-icon-palette.spec.ts
git add src/styles.css src/app/features/guild/channel-icon-palette.ts src/app/features/guild/channel-icon-palette.spec.ts
git commit -m "feat(guild): tint a channel icon without disturbing its row states"
```

---

### Task 8: The Appearance block in channel settings

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`

**Files:**
- Create: `src/app/features/guild/components/channel-settings-modal/pages/channel-overview/channel-icon-picker.component.ts`
- Test: `src/app/features/guild/components/channel-settings-modal/pages/channel-overview/channel-icon-picker.component.spec.ts`
- Modify: `.../channel-overview/channel-overview.component.ts`
- Modify: `.../channel-overview/channel-overview.component.html`

**Interfaces:**
- Consumes: `CHANNEL_ICON_CATALOG`, `CHANNEL_ICON_GROUPS` (Task 4), `CHANNEL_ICON_PALETTE` (Task 7), `ChannelIconComponent` and `LucideIconComponent` (Tasks 3 and 6), `UpdateChannelDto.icon`/`.iconColor` (Task 5).
- Produces: `ChannelIconPickerComponent`, selector `app-channel-icon-picker`, `model()` signals `icon: string` and `iconColor: string` (both `''` for default), plus a required `channelType: ChannelType` input for the preview row.

- [ ] **Step 1: Write the failing test**

Create `channel-icon-picker.component.spec.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {ChannelIconPickerComponent} from './channel-icon-picker.component';

@Component({
    imports: [ChannelIconPickerComponent],
    template: `
        <app-channel-icon-picker
            [(icon)]="icon"
            [(iconColor)]="iconColor"
            [channelType]="type()"
        />
    `,
})
class HostComponent {
    readonly icon = signal('');
    readonly iconColor = signal('');
    readonly type = signal(ChannelType.Text);
}

function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
}

describe('ChannelIconPickerComponent', () => {
    it('offers every palette swatch plus a default chip', () => {
        const fixture = setup();
        const swatches = fixture.nativeElement.querySelectorAll('[data-testid="icon-colour-swatch"]');
        expect(swatches.length).toBe(12);
        expect(fixture.nativeElement.querySelector('[data-testid="icon-colour-default"]')).not.toBeNull();
    });

    it('writes the chosen colour back through the model', () => {
        const fixture = setup();
        const swatch = fixture.nativeElement.querySelectorAll('[data-testid="icon-colour-swatch"]')[0];
        swatch.click();
        fixture.detectChanges();
        expect(fixture.componentInstance.iconColor()).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('clears the colour through the default chip', () => {
        const fixture = setup();
        fixture.componentInstance.iconColor.set('#F87171');
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="icon-colour-default"]').click();
        fixture.detectChanges();
        expect(fixture.componentInstance.iconColor()).toBe('');
    });

    it('writes the chosen icon back through the model', () => {
        const fixture = setup();
        fixture.nativeElement.querySelector('[data-testid="icon-open"]').click();
        fixture.detectChanges();
        fixture.nativeElement.querySelectorAll('[data-testid="icon-option"]')[0].click();
        fixture.detectChanges();
        expect(fixture.componentInstance.icon()).toMatch(/^[a-z0-9-]{1,48}$/);
    });

    it('filters the grid by the search term', () => {
        const fixture = setup();
        fixture.nativeElement.querySelector('[data-testid="icon-open"]').click();
        fixture.detectChanges();
        const search = fixture.nativeElement.querySelector('[data-testid="icon-search"]');
        search.value = 'swords';
        search.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        const options = fixture.nativeElement.querySelectorAll('[data-testid="icon-option"]');
        expect(options.length).toBe(1);
    });

    it('clears the icon through the default option', () => {
        const fixture = setup();
        fixture.componentInstance.icon.set('swords');
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="icon-open"]').click();
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="icon-default"]').click();
        fixture.detectChanges();
        expect(fixture.componentInstance.icon()).toBe('');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run ng test --watch=false --include="**/channel-icon-picker.component.spec.ts"`
Expected: FAIL, cannot resolve the component.

- [ ] **Step 3: Write the picker**

Create `channel-icon-picker.component.ts`. Use `model()` for the two-way signals, `OnPush`, and the shared `<app-channel-icon>` for the preview so the preview cannot drift from the sidebar.

```typescript
import {ChangeDetectionStrategy, Component, computed, input, model, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {CHANNEL_ICON_CATALOG, CHANNEL_ICON_GROUPS} from '../../../../channel-icon-catalog';
import {CHANNEL_ICON_PALETTE} from '../../../../channel-icon-palette';
import {ChannelIconComponent} from '../../../channel-icon/channel-icon.component';
import {LucideIconComponent} from '../../../../../../components/lucide-icon/lucide-icon.component';

@Component({
    selector: 'app-channel-icon-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, ChannelIconComponent, LucideIconComponent],
    templateUrl: './channel-icon-picker.component.html',
})
export class ChannelIconPickerComponent {
    /** `''` means the channel type's own icon. */
    readonly icon = model('');
    /** `''` means the uniform default colour. */
    readonly iconColor = model('');
    readonly channelType = input.required<ChannelType>();

    protected readonly open = signal(false);
    protected readonly search = signal('');

    protected get palette() {
        return CHANNEL_ICON_PALETTE;
    }

    protected readonly preview = computed(() => ({
        type: this.channelType(),
        icon: this.icon() || undefined,
        iconColor: this.iconColor() || undefined,
    }));

    protected readonly groups = computed(() => {
        const term = this.search().trim().toLowerCase();
        const matching = term
            ? CHANNEL_ICON_CATALOG.filter(e => e.name.includes(term))
            : CHANNEL_ICON_CATALOG;
        return CHANNEL_ICON_GROUPS.map(group => ({
            group,
            entries: matching.filter(e => e.group === group),
        })).filter(g => g.entries.length > 0);
    });

    protected toggle(): void {
        this.open.update(v => !v);
    }

    protected choose(name: string): void {
        this.icon.set(name);
        this.open.set(false);
    }

    protected clearIcon(): void {
        this.icon.set('');
        this.open.set(false);
    }

    protected onSearch(event: Event): void {
        this.search.set((event.target as HTMLInputElement).value);
    }
}
```

`palette` is a getter, not `readonly palette = CHANNEL_ICON_PALETTE`. A class field initialised from an imported const reads `undefined` in full-suite runs under Vite.

Create `channel-icon-picker.component.html` beside it, following the Tailwind token classes the rest of `channel-overview.component.html` uses. It must carry these `data-testid` hooks, which the spec asserts on: `icon-open`, `icon-search`, `icon-option`, `icon-default`, `icon-colour-swatch`, `icon-colour-default`. Structure:

```html
<div class="space-y-4">
    <div class="flex items-center gap-3">
        <button (click)="toggle()" data-testid="icon-open" type="button"
            class="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-colors cursor-pointer">
            <app-channel-icon [channel]="preview()" [fallbackHash]="true" />
        </button>
        <div class="chan-row is-preview flex items-center gap-2 flex-1 px-2 py-1.5 rounded-lg bg-white/[0.03]">
            <app-channel-icon [channel]="preview()" />
            <span class="chan-label">{{ 'CHANNEL_SETTINGS.APPEARANCE.PREVIEW' | translate }}</span>
        </div>
    </div>

    @if (open()) {
        <div class="rounded-xl bg-surface-raised p-3 space-y-3">
            <input (input)="onSearch($event)" data-testid="icon-search"
                [placeholder]="'CHANNEL_SETTINGS.APPEARANCE.SEARCH' | translate"
                class="w-full px-3 py-2 rounded-lg bg-white/[0.06] text-sm outline-none" />
            <button (click)="clearIcon()" data-testid="icon-default" type="button"
                class="w-full text-left px-3 py-2 rounded-lg text-xs text-text-muted hover:bg-white/[0.06] cursor-pointer">
                {{ 'CHANNEL_SETTINGS.APPEARANCE.ICON_DEFAULT' | translate }}
            </button>
            <div class="max-h-64 overflow-y-auto thin-scrollbar space-y-3">
                @for (g of groups(); track g.group) {
                    <div>
                        <p class="text-[0.625rem] font-semibold text-text-muted uppercase tracking-widest mb-1.5">
                            {{ 'CHANNEL_SETTINGS.APPEARANCE.GROUP.' + g.group | translate }}
                        </p>
                        <div class="grid grid-cols-8 gap-1">
                            @for (entry of g.entries; track entry.name) {
                                <button (click)="choose(entry.name)" data-testid="icon-option" type="button"
                                    [title]="entry.name" [class.is-chosen]="entry.name === icon()"
                                    class="flex items-center justify-center h-8 rounded-lg text-text-secondary hover:bg-white/[0.08] hover:text-text-primary transition-colors cursor-pointer">
                                    <app-lucide-icon [icon]="entry.icon" />
                                </button>
                            }
                        </div>
                    </div>
                }
            </div>
        </div>
    }

    <div class="flex items-center gap-1.5 flex-wrap">
        <button (click)="iconColor.set('')" data-testid="icon-colour-default" type="button"
            [class.ring-2]="iconColor() === ''"
            class="w-6 h-6 rounded-full bg-white/20 ring-white/60 cursor-pointer"
            [title]="'CHANNEL_SETTINGS.APPEARANCE.COLOR_DEFAULT' | translate"></button>
        @for (swatch of palette; track swatch.value) {
            <button (click)="iconColor.set(swatch.value)" data-testid="icon-colour-swatch" type="button"
                [style.background]="swatch.value" [class.ring-2]="iconColor() === swatch.value"
                class="w-6 h-6 rounded-full ring-white/60 cursor-pointer"
                [title]="'CHANNEL_SETTINGS.ICON_COLOR.' + swatch.name | translate"></button>
        }
    </div>
</div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run ng test --watch=false --include="**/channel-icon-picker.component.spec.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the overview page**

In `channel-overview.component.ts`: add two signals, include them in `onChange()`, and send them in `save()`.

```typescript
    readonly icon = signal('');
    readonly iconColor = signal('');
```

In `ngOnInit`:

```typescript
        this.icon.set(c.icon ?? '');
        this.iconColor.set(c.iconColor ?? '');
```

In `onChange()`, extend the `dirty.set(...)` expression with:

```typescript
                this.icon() !== (c.icon ?? '') ||
                this.iconColor() !== (c.iconColor ?? '') ||
```

In `save()`, extend the dto:

```typescript
            icon: this.icon(),
            iconColor: this.iconColor(),
```

Empty string is the clear sentinel, so sending absolute values here is correct and needs no branching.

Add `ChannelIconPickerComponent` to `imports`, and in the template add above the Name field:

```html
    <div>
        <label class="block text-xs font-semibold text-text-muted uppercase tracking-widest mb-2">
            {{ 'CHANNEL_SETTINGS.APPEARANCE.LABEL' | translate }}
        </label>
        <app-channel-icon-picker
            [(icon)]="icon"
            [(iconColor)]="iconColor"
            [channelType]="channel().type"
        />
    </div>
```

- [ ] **Step 6: Check who can reach this page**

Run:

```bash
grep -rn "app-channel-settings-modal\|ChannelSettingsModalComponent" src/app --include=*.html --include=*.ts | grep -v "channel-settings-modal/"
```

Read whatever gates the modal's opening. If it is already behind a `ManageChannel` check, add no client gate. If it is not, add one using the ownership-aware permission path, never `unionMemberPermissions`, which answers "none" for a guild owner and would lock an owner out of their own channel.

Report which of the two you found in the task hand-back.

- [ ] **Step 7: Full suite and build**

```bash
bun run test
bun run ng build --configuration development
```

Expected: no new failures; build succeeds.

- [ ] **Step 8: Lint, format and commit**

```bash
bun run lint
bunx prettier --write src/app/features/guild/components/channel-settings-modal/pages/channel-overview
git add src/app/features/guild/components/channel-settings-modal/pages/channel-overview
git status --short
```

Confirm only the channel-overview files are staged, then:

```bash
git commit -m "feat(guild): let a channel choose its icon and colour"
```

---

### Task 9: Translation keys

**Repo:** `C:\Users\Domin\WebstormProjects\Alpine`, submodule `src/assets/i18n/locales`

**Files:**
- Modify: `src/assets/i18n/locales/en.json` and every sibling locale file that the repo keeps in step

**Interfaces:**
- Consumes: the key names used in Task 8's template.
- Produces: nothing code-facing.

- [ ] **Step 1: Check the submodule state**

```bash
cd src/assets/i18n/locales
git status
```

Expected: a clean checkout on its own branch. If it is detached, check out the branch the repo tracks before editing.

- [ ] **Step 2: Add the keys**

Add to `en.json`, flat and dot-separated, matching the file's existing ordering convention:

```json
"CHANNEL_SETTINGS.APPEARANCE.LABEL": "Appearance",
"CHANNEL_SETTINGS.APPEARANCE.PREVIEW": "channel-name",
"CHANNEL_SETTINGS.APPEARANCE.SEARCH": "Search icons",
"CHANNEL_SETTINGS.APPEARANCE.ICON_DEFAULT": "Use the default icon",
"CHANNEL_SETTINGS.APPEARANCE.COLOR_DEFAULT": "Default colour",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.general": "General",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.communication": "Communication",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.gaming": "Gaming",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.media": "Media",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.places": "Places",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.objects": "Objects",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.nature": "Nature",
"CHANNEL_SETTINGS.APPEARANCE.GROUP.symbols": "Symbols",
"CHANNEL_SETTINGS.ICON_COLOR.red": "Red",
"CHANNEL_SETTINGS.ICON_COLOR.orange": "Orange",
"CHANNEL_SETTINGS.ICON_COLOR.amber": "Amber",
"CHANNEL_SETTINGS.ICON_COLOR.lime": "Lime",
"CHANNEL_SETTINGS.ICON_COLOR.green": "Green",
"CHANNEL_SETTINGS.ICON_COLOR.teal": "Teal",
"CHANNEL_SETTINGS.ICON_COLOR.cyan": "Cyan",
"CHANNEL_SETTINGS.ICON_COLOR.blue": "Blue",
"CHANNEL_SETTINGS.ICON_COLOR.indigo": "Indigo",
"CHANNEL_SETTINGS.ICON_COLOR.violet": "Violet",
"CHANNEL_SETTINGS.ICON_COLOR.pink": "Pink",
"CHANNEL_SETTINGS.ICON_COLOR.rose": "Rose"
```

Before adding, grep the file for each stem: prefer an existing key over a new one. If `CHANNEL_SETTINGS.APPEARANCE` already exists under another name, use that instead and update Task 8's template.

- [ ] **Step 3: Commit the submodule, then the pointer**

```bash
cd src/assets/i18n/locales
git add en.json
git commit -m "feat: add channel appearance strings"
git push
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for channel appearance"
```

---

## Verification

After every task, before reporting the feature done:

- [ ] `bun run test` passes with no regression against the baseline captured before Task 3.
- [ ] `bun run ng build --configuration development` succeeds.
- [ ] `bun run lint` is clean.
- [ ] `dotnet test Guild.Tests` shows the new validator and endpoint tests passing. Docker-dependent failures are pre-existing.
- [ ] `git diff` on `src/styles.css` is additions only.
- [ ] `grep -rn "channelIcon(" src --include=*.ts --include=*.html | grep -v channel-types` returns nothing.
- [ ] A channel with no icon and no colour renders byte-identically to `main` before this work. Check one text row, one voice row, one active row and one unread row.

State plainly what was verified by running it and what was not.
