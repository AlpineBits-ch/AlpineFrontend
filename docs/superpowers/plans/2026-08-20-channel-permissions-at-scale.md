# Channel Permissions At Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four affordances that make a large guild's permissions manageable: view the server as a role, edit a role's access across every channel in one grid, apply one override to many channels, and start from a named preset.

**Architecture:** All four sit on top of the foundation plan. View-as is a guild-scoped service holding a subject and a lazily filled map of traces; nothing on a write path reads it. The matrix and the bulk applier both drive the existing `PUT .../permissions/roles/{roleId}` route, so neither needs a new endpoint. Presets are pure data producing the same masks the grid would.

**Tech Stack:** Angular 21 standalone components, signals, PrimeNG dialogs, ngx-translate, Vitest through the Angular CLI.

**Spec:** `docs/specs/channel-permissions-ux.md`, sections E, F, G and H.

**Depends on:** `2026-08-20-channel-permissions-foundation.md` complete, and the Echo plan's effective-permissions endpoint deployed.

## Global Constraints

Identical to the foundation plan. Repeated here because a task's implementer sees only their own task:

- `inject()`, never constructor parameters. `input()` / `output()` / `model()`, never `@Input` / `@Output`.
- `ChangeDetectionStrategy.OnPush` on every new component. Signals for state, never a plain field written from an async callback.
- Standalone components, no NgModules. `@if` / `@for`, not structural directives.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports.
- No em dashes anywhere. No essays in comments.
- Never `readonly x = SOME_IMPORTED_CONST` as a class field. Use a getter.
- Tests only through `bun run ng test --watch=false --include="**/name.spec.ts"`.
- `src/assets/i18n/locales` is a submodule. Commit and push new keys there first.
- `bun run format` rewrites the whole repo. Format only the paths you touched with `bunx prettier --write`.
- **Others are working on `main` at the same time.** Stage by explicit file path, never `git add -A` or `git add .`. No `git stash`, no `git checkout --`, no `git reset --hard`, no rebase, no force push. If a pull brings conflicts, stop and ask.

**The view-as safety rule, which every task in this plan is bound by:** view-as changes what is drawn, never what is permitted. No write path, guard, service call or store mutation may read the simulated subject. Affordances are disabled with a reason, not removed, so the mode can never be mistaken for the real thing.

## File Structure

| File                                                                                  | Responsibility                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `features/guild/view-as/view-as.service.ts`                                           | The simulated subject and its trace cache. Guild-scoped. |
| `features/guild/view-as/view-as-banner.component.ts/.html`                            | The persistent banner.                                   |
| `features/guild/view-as/view-as-picker.component.ts/.html`                            | Role and member picker, opened from the guild menu.      |
| `features/guild/shared/permission-presets.ts`                                         | The four presets as masks. Pure.                         |
| `features/guild/shared/apply-override-dialog/*`                                       | Pick channels, preview, fan out the writes.              |
| `features/guild/components/guild-settings-modal/pages/roles-settings/role-channels/*` | The role channel matrix tab.                             |

---

### Task 1: Permission presets

Smallest piece, no dependencies, and the matrix in Task 5 reuses its column sets.

**Files:**

- Create: `src/app/features/guild/shared/permission-presets.ts`
- Create: `src/app/features/guild/shared/permission-presets.spec.ts`
- Modify: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.ts` and `.html`

**Interfaces:**

- Consumes: `Permissions`, `PermissionKey` from `enums/permissions.enum`; `PermOverride`, `EMPTY_OVERRIDE` from `shared/permission-override-editor`.
- Produces:
  - `interface PermissionPreset {id: string; labelKey: string; voice: boolean; allow: PermissionKey[]; deny: PermissionKey[]}`
  - `PERMISSION_PRESETS: readonly PermissionPreset[]`
  - `function presetOverride(preset: PermissionPreset): PermOverride`
  - `function presetsFor(channelType: ChannelType | null): readonly PermissionPreset[]`

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/shared/permission-presets.spec.ts`:

```ts
import {PERMISSION_PRESETS, presetOverride, presetsFor} from './permission-presets';
import {Permissions} from '../../../enums/permissions.enum';
import {ChannelType} from '../../../dtos/response/guild.dto';

describe('permission presets', () => {
  it('turns a preset into the masks the grid would write', () => {
    const readOnly = PERMISSION_PRESETS.find(p => p.id === 'read-only')!;

    const override = presetOverride(readOnly);

    expect(override.allow & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
    expect(override.allow & Permissions.ReadMessageHistory).toBe(Permissions.ReadMessageHistory);
    expect(override.deny & Permissions.SendMessages).toBe(Permissions.SendMessages);
  });

  it('leaves the module masks untouched', () => {
    const override = presetOverride(PERMISSION_PRESETS[0]);

    expect(override.allowModule).toBe(0n);
    expect(override.denyModule).toBe(0n);
  });

  it('offers the voice preset on a voice channel and nowhere else', () => {
    expect(presetsFor(ChannelType.Voice).map(p => p.id)).toContain('listen-only');
    expect(presetsFor(ChannelType.Text).map(p => p.id)).not.toContain('listen-only');
  });

  it('offers the text presets on a category, which has no type', () => {
    expect(presetsFor(null).map(p => p.id)).toContain('read-only');
  });

  it('never lets a preset allow and deny the same bit', () => {
    for (const preset of PERMISSION_PRESETS) {
      const override = presetOverride(preset);
      expect(override.allow & override.deny).toBe(0n);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-presets.spec.ts"`
Expected: FAIL, cannot resolve `./permission-presets`.

- [ ] **Step 3: Write the presets**

Create `src/app/features/guild/shared/permission-presets.ts`:

```ts
import {ChannelType} from '../../../dtos/response/guild.dto';
import {PermissionKey, Permissions} from '../../../enums/permissions.enum';
import {
  EMPTY_OVERRIDE,
  PermOverride,
} from './permission-override-editor/permission-override-editor.component';

/** A named starting point. Writes the same masks the grid would, and stays editable after. */
export interface PermissionPreset {
  id: string;
  labelKey: string;
  /** Offered on voice channels instead of the message presets, not alongside them. */
  voice: boolean;
  allow: PermissionKey[];
  deny: PermissionKey[];
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'read-only',
    labelKey: 'PERM_PRESET.READ_ONLY',
    voice: false,
    allow: ['ViewChannel', 'ReadMessageHistory'],
    deny: ['SendMessages', 'CreateThreads', 'AddReactions'],
  },
  {
    id: 'hidden',
    labelKey: 'PERM_PRESET.HIDDEN',
    voice: false,
    allow: [],
    deny: ['ViewChannel'],
  },
  {
    id: 'talk-not-manage',
    labelKey: 'PERM_PRESET.TALK_NOT_MANAGE',
    voice: false,
    allow: ['ViewChannel', 'SendMessages', 'CreateThreads', 'ReadMessageHistory'],
    deny: ['PinMessages', 'ManageChannel'],
  },
  {
    id: 'listen-only',
    labelKey: 'PERM_PRESET.LISTEN_ONLY',
    voice: true,
    allow: ['ViewChannel', 'Connect'],
    deny: ['Speak', 'Stream'],
  },
];

export function presetOverride(preset: PermissionPreset): PermOverride {
  const allow = preset.allow.reduce((mask, key) => mask | Permissions[key], 0n);
  const deny = preset.deny.reduce((mask, key) => mask | Permissions[key], 0n);
  return {...EMPTY_OVERRIDE, allow, deny};
}

/** Hidden is offered everywhere; the rest split on whether the channel carries voice. */
export function presetsFor(channelType: ChannelType | null): readonly PermissionPreset[] {
  const isVoice = channelType === ChannelType.Voice;
  return PERMISSION_PRESETS.filter(preset => preset.id === 'hidden' || preset.voice === isVoice);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/permission-presets.spec.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Offer them when an override is added**

In `permission-overrides-panel.component.ts`:

```ts
    readonly presets = input<readonly PermissionPreset[]>([]);

    /** The entry whose preset row is showing, cleared once one is picked or dismissed. */
    protected readonly pendingPresetFor = signal<string | null>(null);

    protected pickPreset(preset: PermissionPreset): void {
        const id = this.pendingPresetFor();
        if (!id) return;
        this.change.emit({id, override: presetOverride(preset)});
        this.pendingPresetFor.set(null);
    }

    protected dismissPresets(): void {
        this.pendingPresetFor.set(null);
    }
```

Set `pendingPresetFor` inside the existing `onAdd(id)` right after `this.add.emit(id)`.

In the detail pane of `permission-overrides-panel.component.html`, above `<app-permission-override-editor>`:

```html
@if (pendingPresetFor() === entry.id && presets().length > 0) {
<div class="px-4 pt-3">
  <p class="text-[0.625rem] font-semibold text-text-muted uppercase tracking-widest mb-2">
    {{ 'PERM_PRESET.TITLE' | translate }}
  </p>
  <div class="grid grid-cols-2 gap-2">
    @for (preset of presets(); track preset.id) {
    <button
      (click)="pickPreset(preset)"
      class="text-left px-3 py-2 rounded-xl bg-card border border-border-subtle hover:border-brand transition-colors cursor-pointer"
    >
      <span class="text-sm font-medium text-text-primary">{{ preset.labelKey | translate }}</span>
    </button>
    }
  </div>
  <button
    (click)="dismissPresets()"
    class="mt-2 text-xs text-text-muted hover:text-text-secondary cursor-pointer border-0 bg-transparent p-0"
  >
    {{ 'PERM_PRESET.START_BLANK' | translate }}
  </button>
</div>
}
```

Pass `[presets]="presetsFor(scope().channelType)"` from `permission-overrides.component.html`, with a passthrough on the component:

```ts
    protected presetsFor = presetsFor;
```

- [ ] **Step 6: Add the i18n keys**

Submodule, all three files, committed and pushed first:

```json
"PERM_PRESET.TITLE": "Start from",
"PERM_PRESET.START_BLANK": "Start from blank instead",
"PERM_PRESET.READ_ONLY": "Read only",
"PERM_PRESET.HIDDEN": "Hidden",
"PERM_PRESET.TALK_NOT_MANAGE": "Talk, do not manage",
"PERM_PRESET.LISTEN_ONLY": "Listen only"
```

- [ ] **Step 7: Run the suite and commit**

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: PASS, unchanged count.

```bash
git add src/app/features/guild/shared src/assets/i18n/locales
git commit -m "feat(permissions): offer four preset overrides when adding one"
```

---

### Task 2: Apply one override to many channels

**Files:**

- Create: `src/app/features/guild/shared/apply-override-dialog/apply-override.plan.ts`
- Create: `src/app/features/guild/shared/apply-override-dialog/apply-override.plan.spec.ts`
- Create: `src/app/features/guild/shared/apply-override-dialog/apply-override-dialog.component.ts` and `.html`
- Create: `src/app/features/guild/shared/apply-override-dialog/apply-override-dialog.component.spec.ts`

**Interfaces:**

- Consumes: `PermOverride`, `GuildService.upsertChannelRolePermission`, `stringifyPermissions`.
- Produces:
  - `type ApplyMode = 'replace' | 'merge'`
  - `function mergeOverride(existing: PermOverride, incoming: PermOverride): PermOverride`
  - `function planApply(targets: ApplyTarget[], incoming: PermOverride, mode: ApplyMode): ApplyStep[]` where `ApplyTarget` is `{channelId: string; existing: PermOverride | null}` and `ApplyStep` is `{channelId: string; result: PermOverride; skipped: boolean}`
  - `<app-apply-override-dialog [(visible)] [guild] [roleId] [override] [channels] [categories]>` with `applied = output<{succeeded: string[]; failed: string[]}>()`

- [ ] **Step 1: Write the failing plan test**

Create `apply-override.plan.spec.ts`:

```ts
import {mergeOverride, planApply} from './apply-override.plan';
import {Permissions} from '../../../../enums/permissions.enum';

const EMPTY = {allow: 0n, deny: 0n, allowModule: 0n, denyModule: 0n};

describe('apply override plan', () => {
  it('replaces whatever was there in replace mode', () => {
    const steps = planApply(
      [{channelId: 'c1', existing: {...EMPTY, deny: Permissions.SendMessages}}],
      {...EMPTY, allow: Permissions.AddReactions},
      'replace',
    );

    expect(steps[0].result).toEqual({...EMPTY, allow: Permissions.AddReactions});
  });

  it('unions both masks in merge mode', () => {
    const steps = planApply(
      [{channelId: 'c1', existing: {...EMPTY, deny: Permissions.SendMessages}}],
      {...EMPTY, allow: Permissions.AddReactions},
      'merge',
    );

    expect(steps[0].result.allow).toBe(Permissions.AddReactions);
    expect(steps[0].result.deny).toBe(Permissions.SendMessages);
  });

  // A bit cannot be on both sides. The incoming side wins, because it is the edit being made.
  it('lets the incoming side win a conflict', () => {
    const merged = mergeOverride(
      {...EMPTY, deny: Permissions.SendMessages},
      {...EMPTY, allow: Permissions.SendMessages},
    );

    expect(merged.allow & Permissions.SendMessages).toBe(Permissions.SendMessages);
    expect(merged.deny & Permissions.SendMessages).toBe(0n);
  });

  it('skips a channel whose result would be identical', () => {
    const same = {...EMPTY, allow: Permissions.AddReactions};

    const steps = planApply([{channelId: 'c1', existing: same}], same, 'replace');

    expect(steps[0].skipped).toBe(true);
  });

  it('does not skip a channel with no override yet', () => {
    const steps = planApply(
      [{channelId: 'c1', existing: null}],
      {...EMPTY, allow: Permissions.AddReactions},
      'replace',
    );

    expect(steps[0].skipped).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/apply-override.plan.spec.ts"`
Expected: FAIL, cannot resolve `./apply-override.plan`.

- [ ] **Step 3: Write the plan**

Create `apply-override.plan.ts`:

```ts
import {PermOverride} from '../permission-override-editor/permission-override-editor.component';

export type ApplyMode = 'replace' | 'merge';

export interface ApplyTarget {
  channelId: string;
  existing: PermOverride | null;
}

export interface ApplyStep {
  channelId: string;
  result: PermOverride;
  /** Writing this would change nothing, so it is counted and not sent. */
  skipped: boolean;
}

/** Unions both sides. A bit named on both wins as an allow, since that is the edit being made. */
export function mergeOverride(existing: PermOverride, incoming: PermOverride): PermOverride {
  const allow = existing.allow | incoming.allow;
  const deny = (existing.deny | incoming.deny) & ~incoming.allow;

  const allowModule = existing.allowModule | incoming.allowModule;
  const denyModule = (existing.denyModule | incoming.denyModule) & ~incoming.allowModule;

  return {allow: allow & ~incoming.deny, deny, allowModule: allowModule & ~incoming.denyModule, denyModule};
}

function same(a: PermOverride, b: PermOverride): boolean {
  return (
    a.allow === b.allow &&
    a.deny === b.deny &&
    a.allowModule === b.allowModule &&
    a.denyModule === b.denyModule
  );
}

export function planApply(targets: ApplyTarget[], incoming: PermOverride, mode: ApplyMode): ApplyStep[] {
  return targets.map(target => {
    const result =
      mode === 'replace' || !target.existing ? incoming : mergeOverride(target.existing, incoming);

    return {
      channelId: target.channelId,
      result,
      skipped: target.existing !== null && same(target.existing, result),
    };
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/apply-override.plan.spec.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing dialog test**

Create `apply-override-dialog.component.spec.ts` with a `setup()` in the house style (see `permission-overrides.component.spec.ts`), stubbing `GuildService` with `upsertChannelRolePermission: vi.fn(() => of({id: 'p'}))`:

```ts
describe('ApplyOverrideDialogComponent', () => {
  it('sends one write per selected channel, skipping the no-ops', async () => {
    const {component, guildService} = setup({
      channels: [channel('c1'), channel('c2'), channel('c3')],
    });

    component.toggleChannel('c1');
    component.toggleChannel('c2');
    await component.apply();

    expect(guildService.upsertChannelRolePermission).toHaveBeenCalledTimes(2);
  });

  it('selects and clears a whole category at once', () => {
    const {component} = setup({
      channels: [channel('c1', 'cat1'), channel('c2', 'cat1')],
    });

    component.toggleCategory('cat1');
    expect(component.selectedCount()).toBe(2);

    component.toggleCategory('cat1');
    expect(component.selectedCount()).toBe(0);
  });

  it('reports the channels that failed rather than stopping', async () => {
    const {component, guildService} = setup({channels: [channel('c1'), channel('c2')]});
    guildService.upsertChannelRolePermission
      .mockReturnValueOnce(throwError(() => new Error('nope')))
      .mockReturnValueOnce(of({id: 'p'}));

    component.toggleChannel('c1');
    component.toggleChannel('c2');
    const result = await component.apply();

    expect(result.failed).toEqual(['c1']);
    expect(result.succeeded).toEqual(['c2']);
  });

  it('counts what a sync would skip before anything is sent', () => {
    const {component} = setup({
      channels: [channel('c1')],
      existing: {c1: {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n}},
      override: {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n},
    });

    component.toggleChannel('c1');

    expect(component.skippedCount()).toBe(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails, then write the dialog**

Run: `bun run ng test --watch=false --include="**/apply-override-dialog.component.spec.ts"`
Expected: FAIL, component does not exist.

Create `apply-override-dialog.component.ts`:

```ts
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {CategoryDto, ChannelDto, GuildDto} from '../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../services/guild.service';
import {stringifyPermissions} from '../../../../enums/permissions.enum';
import {stringifyModulePermissions} from '../../../../enums/module-permissions.enum';
import {PermOverride} from '../permission-override-editor/permission-override-editor.component';
import {ApplyMode, ApplyTarget, planApply} from './apply-override.plan';

const CONCURRENCY = 4;

@Component({
  selector: 'app-apply-override-dialog',
  imports: [Dialog, Button, TranslateModule],
  templateUrl: './apply-override-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApplyOverrideDialogComponent {
  readonly visible = model.required<boolean>();
  readonly guild = input.required<GuildDto>();
  readonly roleId = input.required<string>();
  readonly override = input.required<PermOverride>();
  readonly channels = input.required<ChannelDto[]>();
  readonly categories = input<CategoryDto[]>([]);

  readonly applied = output<{succeeded: string[]; failed: string[]}>();

  protected readonly mode = signal<ApplyMode>('replace');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly running = signal(false);
  protected readonly done = signal(0);

  private guildService = inject(GuildService);

  protected readonly steps = computed(() => {
    const targets: ApplyTarget[] = this.channels()
      .filter(c => this.selected().has(c.id))
      .map(c => ({channelId: c.id, existing: this.existingOverride(c)}));

    return planApply(targets, this.override(), this.mode());
  });

  readonly selectedCount = computed(() => this.selected().size);
  readonly skippedCount = computed(() => this.steps().filter(s => s.skipped).length);
  readonly writeCount = computed(() => this.steps().filter(s => !s.skipped).length);

  toggleChannel(channelId: string): void {
    this.selected.update(set => {
      const next = new Set(set);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  toggleCategory(categoryId: string): void {
    const ids = this.channels()
      .filter(c => c.categoryId === categoryId)
      .map(c => c.id);
    const allSelected = ids.every(id => this.selected().has(id));

    this.selected.update(set => {
      const next = new Set(set);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async apply(): Promise<{succeeded: string[]; failed: string[]}> {
    if (this.running()) return {succeeded: [], failed: []};

    this.running.set(true);
    this.done.set(0);

    const queue = this.steps().filter(step => !step.skipped);
    const succeeded: string[] = [];
    const failed: string[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        const step = queue.shift();
        if (!step) return;

        try {
          await firstValueFrom(
            this.guildService.upsertChannelRolePermission(step.channelId, this.roleId(), {
              allowPermissions: stringifyPermissions(step.result.allow),
              denyPermissions: stringifyPermissions(step.result.deny),
              allowModulePermissions: stringifyModulePermissions(step.result.allowModule),
              denyModulePermissions: stringifyModulePermissions(step.result.denyModule),
            }),
          );
          succeeded.push(step.channelId);
        } catch {
          failed.push(step.channelId);
        }

        this.done.update(n => n + 1);
      }
    };

    await Promise.all(Array.from({length: CONCURRENCY}, worker));

    this.running.set(false);
    const result = {succeeded, failed};
    this.applied.emit(result);
    return result;
  }

  private existingOverride(channel: ChannelDto): PermOverride | null {
    const perm = channel.permissions.find(p => p.roleId === this.roleId());
    if (!perm) return null;
    return {
      allow: parsePermissions(perm.allowPermissions),
      deny: parsePermissions(perm.denyPermissions),
      allowModule: parseModulePermissions(perm.allowModulePermissions),
      denyModule: parseModulePermissions(perm.denyModulePermissions),
    };
  }
}
```

Import `parsePermissions` and `parseModulePermissions` alongside the stringify pair.

The template renders the two-panel layout from the spec: mode radios and the incoming diff on the left, the category-grouped channel checklist on the right, then a footer with `writeCount()`, `skippedCount()` and the apply button. `running()` drives the button's loading state and `done()` a progress count.

- [ ] **Step 7: Run the dialog spec**

Run: `bun run ng test --watch=false --include="**/apply-override-dialog.component.spec.ts"`
Expected: PASS, 4 tests.

- [ ] **Step 8: Add the i18n keys and commit**

Submodule first:

```json
"APPLY_OVERRIDE.TITLE": "Apply to channels",
"APPLY_OVERRIDE.MODE_REPLACE": "Replace any existing override",
"APPLY_OVERRIDE.MODE_MERGE": "Merge into what is already there",
"APPLY_OVERRIDE.SELECTED": "{{count}} selected",
"APPLY_OVERRIDE.SKIPPED": "{{count}} channels already match, will be skipped",
"APPLY_OVERRIDE.APPLY": "Apply to {{count}}",
"APPLY_OVERRIDE.FAILED": "{{count}} channels could not be updated"
```

```bash
git add src/app/features/guild/shared/apply-override-dialog src/assets/i18n/locales
git commit -m "feat(permissions): apply one role override across many channels"
```

---

### Task 3: View-as service

**Files:**

- Create: `src/app/features/guild/view-as/view-as.service.ts`
- Create: `src/app/features/guild/view-as/view-as.service.spec.ts`

**Interfaces:**

- Consumes: `GuildService.getEffectivePermissions` from the foundation plan.
- Produces:
  - `interface ViewAsSubject {kind: 'role' | 'member'; id: string; name: string; color?: string}`
  - `ViewAsService` with `subject(guildId): Signal<ViewAsSubject | null>`, `enter(guildId, subject)`, `exit(guildId)`, `active(guildId): Signal<boolean>`, `can(guildId, channelId, permission): boolean`, `traceFor(guildId, channelId): Signal<EffectivePermissionsDto | null>`, `request(guildId, channelId)`

`can` answers false while the trace is in flight, so an unresolved channel renders as inaccessible rather than briefly as accessible. That direction is the safe one for a preview.

- [ ] **Step 1: Write the failing test**

Create `view-as.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {ViewAsService} from './view-as.service';
import {GuildService} from '../../../services/guild.service';
import {Permissions} from '../../../enums/permissions.enum';
import {EffectivePermissionsDto} from '../../../dtos/response/effective-permissions.dto';

const GUILD = 'guild_1';
const SUBJECT = {kind: 'role' as const, id: 'role_1', name: 'Recruit'};

function trace(permissions: string): EffectivePermissionsDto {
  return {
    channelId: 'chan_1',
    subjectKind: 'Role',
    subjectId: 'role_1',
    permissions,
    modulePermissions: 'None',
    sources: [],
  };
}

function setup(permissions = 'ViewChannel') {
  const guildService = {getEffectivePermissions: vi.fn(() => of(trace(permissions)))};

  TestBed.configureTestingModule({
    providers: [ViewAsService, {provide: GuildService, useValue: guildService}],
  });

  return {service: TestBed.inject(ViewAsService), guildService};
}

describe('ViewAsService', () => {
  it('is inactive until a subject is entered', () => {
    const {service} = setup();

    expect(service.active(GUILD)()).toBe(false);
  });

  it('holds the subject per guild', () => {
    const {service} = setup();

    service.enter(GUILD, SUBJECT);

    expect(service.subject(GUILD)()?.name).toBe('Recruit');
    expect(service.subject('guild_2')()).toBeNull();
  });

  it('denies everything until the trace lands', () => {
    const {service} = setup();
    service.enter(GUILD, SUBJECT);

    expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(false);
  });

  it('answers from the trace once requested', () => {
    const {service} = setup('ViewChannel, ReadMessageHistory');
    service.enter(GUILD, SUBJECT);
    service.request(GUILD, 'chan_1');

    expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(true);
    expect(service.can(GUILD, 'chan_1', Permissions.SendMessages)).toBe(false);
  });

  it('asks for a channel once, however many times it is requested', () => {
    const {service, guildService} = setup();
    service.enter(GUILD, SUBJECT);

    service.request(GUILD, 'chan_1');
    service.request(GUILD, 'chan_1');

    expect(guildService.getEffectivePermissions).toHaveBeenCalledTimes(1);
  });

  it('drops the cache on exit, so a second subject cannot read the first one answers', () => {
    const {service} = setup();
    service.enter(GUILD, SUBJECT);
    service.request(GUILD, 'chan_1');
    service.exit(GUILD);

    expect(service.active(GUILD)()).toBe(false);
    expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/view-as.service.spec.ts"`
Expected: FAIL, cannot resolve `./view-as.service`.

- [ ] **Step 3: Write the service**

Create `view-as.service.ts`:

```ts
import {computed, inject, Injectable, Signal, signal} from '@angular/core';
import {GuildService} from '../../../services/guild.service';
import {EffectivePermissionsDto} from '../../../dtos/response/effective-permissions.dto';
import {parsePermissions, PermissionValue} from '../../../enums/permissions.enum';

export interface ViewAsSubject {
  kind: 'role' | 'member';
  id: string;
  name: string;
  color?: string;
}

/**
 * A preview of the guild through someone else's permissions.
 *
 * Nothing on a write path may read this. It changes what is drawn, never what is permitted, and
 * every affordance it touches is disabled with a reason rather than removed.
 */
@Injectable({providedIn: 'root'})
export class ViewAsService {
  private readonly subjects = signal<Record<string, ViewAsSubject>>({});
  private readonly traces = signal<Record<string, EffectivePermissionsDto>>({});
  private readonly inFlight = new Set<string>();

  private guildService = inject(GuildService);

  subject(guildId: string): Signal<ViewAsSubject | null> {
    return computed(() => this.subjects()[guildId] ?? null);
  }

  active(guildId: string): Signal<boolean> {
    return computed(() => this.subjects()[guildId] !== undefined);
  }

  enter(guildId: string, subject: ViewAsSubject): void {
    this.clearGuild(guildId);
    this.subjects.update(map => ({...map, [guildId]: subject}));
  }

  exit(guildId: string): void {
    this.subjects.update(map => {
      const next = {...map};
      delete next[guildId];
      return next;
    });
    this.clearGuild(guildId);
  }

  traceFor(guildId: string, channelId: string): Signal<EffectivePermissionsDto | null> {
    return computed(() => this.traces()[this.key(guildId, channelId)] ?? null);
  }

  /** Fetches one channel's trace, once. Safe to call from a template-driven render. */
  request(guildId: string, channelId: string): void {
    const subject = this.subjects()[guildId];
    if (!subject) return;

    const key = this.key(guildId, channelId);
    if (this.traces()[key] || this.inFlight.has(key)) return;

    this.inFlight.add(key);
    this.guildService.getEffectivePermissions(channelId, {kind: subject.kind, id: subject.id}).subscribe({
      next: dto => {
        this.inFlight.delete(key);
        this.traces.update(map => ({...map, [key]: dto}));
      },
      error: () => this.inFlight.delete(key),
    });
  }

  /** False while the trace is unknown: an unresolved channel reads as inaccessible, not as open. */
  can(guildId: string, channelId: string, permission: PermissionValue): boolean {
    const dto = this.traces()[this.key(guildId, channelId)];
    if (!dto) return false;
    return (parsePermissions(dto.permissions) & permission) === permission;
  }

  private clearGuild(guildId: string): void {
    const prefix = `${guildId}:`;
    this.traces.update(map =>
      Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith(prefix))),
    );
    for (const key of [...this.inFlight]) {
      if (key.startsWith(prefix)) this.inFlight.delete(key);
    }
  }

  private key(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/view-as.service.spec.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/view-as
git commit -m "feat(permissions): hold a simulated subject and its resolved channels"
```

---

### Task 4: View-as banner, picker and channel list

**Files:**

- Create: `src/app/features/guild/view-as/view-as-banner.component.ts` and `.html`
- Create: `src/app/features/guild/view-as/view-as-picker.component.ts` and `.html`
- Modify: `src/app/features/guild/components/channel-list/channel-list.component.ts` and `.html`
- Test: `src/app/features/guild/view-as/view-as-banner.component.spec.ts`

**Interfaces:**

- Consumes: `ViewAsService` from Task 3.
- Produces: `<app-view-as-banner [guildId]>`, `<app-view-as-picker [(visible)] [guild]>`.

- [ ] **Step 1: Write the failing banner test**

Create `view-as-banner.component.spec.ts`:

```ts
describe('ViewAsBannerComponent', () => {
  it('draws nothing when the mode is off', () => {
    const {fixture} = setup();

    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('names the subject and counts what they can see', () => {
    const {fixture, service} = setup();
    service.enter('guild_1', {kind: 'role', id: 'role_1', name: 'Recruit'});
    fixture.componentRef.setInput('visibleCount', 9);
    fixture.componentRef.setInput('totalCount', 14);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Recruit');
    expect(fixture.nativeElement.textContent).toContain('9');
    expect(fixture.nativeElement.textContent).toContain('14');
  });

  it('exits the mode when asked', () => {
    const {fixture, service, component} = setup();
    service.enter('guild_1', {kind: 'role', id: 'role_1', name: 'Recruit'});
    fixture.detectChanges();

    component.exit();

    expect(service.active('guild_1')()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the banner**

Run: `bun run ng test --watch=false --include="**/view-as-banner.component.spec.ts"`
Expected: FAIL, component does not exist.

`view-as-banner.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ViewAsService} from './view-as.service';

@Component({
  selector: 'app-view-as-banner',
  imports: [TranslateModule],
  templateUrl: './view-as-banner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewAsBannerComponent {
  readonly guildId = input.required<string>();
  readonly visibleCount = input(0);
  readonly totalCount = input(0);

  private viewAs = inject(ViewAsService);

  protected readonly subject = computed(() => this.viewAs.subject(this.guildId())());

  exit(): void {
    this.viewAs.exit(this.guildId());
  }
}
```

`view-as-banner.component.html`:

```html
@if (subject(); as who) {
<div class="flex items-center gap-3 px-3 py-2 rounded-xl bg-brand/15 border border-brand/40">
  <span
    [style.background]="who.color || 'var(--color-brand)'"
    class="w-2.5 h-2.5 rounded-full shrink-0"
  ></span>
  <span class="flex-1 text-sm text-text-primary truncate">
    {{ 'VIEW_AS.BANNER' | translate: {name: who.name, visible: visibleCount(), total: totalCount()} }}
  </span>
  <button
    (click)="exit()"
    class="px-2.5 py-1 rounded-lg text-xs text-text-secondary hover:bg-hover hover:text-text-primary transition-colors cursor-pointer border-0 bg-transparent"
  >
    {{ 'VIEW_AS.EXIT' | translate }}
  </button>
</div>
}
```

- [ ] **Step 3: Write the picker**

`view-as-picker.component.ts` opens a PrimeNG dialog listing the guild's roles (with colour swatches) and a member search using `searchMembers`. Picking one calls `viewAs.enter(guildId, subject)` and closes. Follow the markup of the existing add-override popover for the row style.

- [ ] **Step 4: Filter the channel list**

In `channel-list.component.ts`:

```ts
    protected readonly viewAs = inject(ViewAsService);
    protected readonly viewAsActive = computed(() => this.viewAs.active(this.guild().id)());

    /** Requests every top-level channel's trace once the mode turns on. */
    private readonly viewAsRequests = effect(() => {
        if (!this.viewAsActive()) return;
        const guildId = this.guild().id;
        for (const channel of this.localChannels()) this.viewAs.request(guildId, channel.id);
    });

    protected readonly viewAsVisibleCount = computed(() =>
        this.localChannels().filter(c => this.viewAs.can(this.guild().id, c.id, Permissions.ViewChannel)).length,
    );

    protected canSee(channel: ChannelDto): boolean {
        if (!this.viewAsActive()) return true;
        return this.viewAs.can(this.guild().id, channel.id, Permissions.ViewChannel);
    }
```

`effect` needs `inject(Injector)` context, so declare it as a field on the component, which already runs in an injection context.

In `channel-list.component.html`, render the banner above the list and give every channel row `[class.opacity-40]="!canSee(channel)"` plus, when in the mode and not visible, a small "hidden" chip. Do not remove the row: the point of the preview is to show what is missing.

Add `<app-view-as-banner [guildId]="guild().id" [totalCount]="localChannels().length" [visibleCount]="viewAsVisibleCount()" />` at the top of the column, and a "View server as" item to the existing guild context menu that opens the picker.

- [ ] **Step 5: Disable, never remove, in the channel view**

In the channel conversation composer, when `viewAsActive()` and `!viewAs.can(guildId, channelId, Permissions.SendMessages)`, render the composer disabled with `VIEW_AS.CANNOT_SEND` as the reason. Do not touch any send handler: the mode must not be reachable from a write path.

Verify that nothing on a write path reads the service:

Run: `grep -rn "viewAs\." src/app/services src/app/stores`
Expected: no results.

- [ ] **Step 6: Add the i18n keys**

Submodule first:

```json
"VIEW_AS.MENU": "View server as",
"VIEW_AS.BANNER": "Viewing as {{name}}. {{visible}} of {{total}} channels visible.",
"VIEW_AS.EXIT": "Exit",
"VIEW_AS.HIDDEN": "hidden",
"VIEW_AS.CANNOT_SEND": "This role cannot send messages here.",
"VIEW_AS.PICK_TITLE": "View the server as",
"VIEW_AS.PICK_ROLE": "Roles",
"VIEW_AS.PICK_MEMBER": "Members"
```

- [ ] **Step 7: Run the specs and the build**

Run: `bun run ng test --watch=false --include="**/view-as-banner.component.spec.ts"`
Expected: PASS, 3 tests.

Run: `bun run ng build --configuration development`
Expected: success.

Run: `bun run test`
Expected: PASS, at or above baseline.

- [ ] **Step 8: Commit**

```bash
git add src/app/features/guild src/assets/i18n/locales
git commit -m "feat(permissions): preview the guild through another role's permissions"
```

---

### Task 5: The role channel matrix

**Files:**

- Create: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/role-channels/role-channel-columns.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/role-channels/role-channel-columns.spec.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/role-channels/role-channels.component.ts` and `.html`
- Create: `.../role-channels/role-channels.component.spec.ts`
- Modify: `roles-settings.component.ts` and `.html` (third tab)

**Interfaces:**

- Consumes: `PermOverride`, `GuildService.upsertChannelRolePermission`, `deleteChannelRolePermission`, `ApplyOverrideDialogComponent` from Task 2.
- Produces:
  - `function columnsFor(type: ChannelType): PermissionKey[]`
  - `<app-role-channels [guild] [role] [channels] [categories]>`

- [ ] **Step 1: Write the failing column test**

Create `role-channel-columns.spec.ts`:

```ts
import {columnsFor} from './role-channel-columns';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';

describe('role channel columns', () => {
  it('gives a text channel the message columns', () => {
    expect(columnsFor(ChannelType.Text)).toEqual([
      'ViewChannel',
      'SendMessages',
      'ReadMessageHistory',
      'CreateThreads',
      'ManageChannel',
    ]);
  });

  it('gives a voice channel the voice columns and no Send', () => {
    const columns = columnsFor(ChannelType.Voice);

    expect(columns).toContain('Connect');
    expect(columns).toContain('Speak');
    expect(columns).not.toContain('SendMessages');
  });

  it('treats a forum like a text channel', () => {
    expect(columnsFor(ChannelType.Forum)).toEqual(columnsFor(ChannelType.Text));
  });

  it('gives a household channel only View', () => {
    expect(columnsFor(ChannelType.Ledger)).toEqual(['ViewChannel']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the columns**

Run: `bun run ng test --watch=false --include="**/role-channel-columns.spec.ts"`
Expected: FAIL, cannot resolve `./role-channel-columns`.

`role-channel-columns.ts`:

```ts
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {PermissionKey} from '../../../../../../enums/permissions.enum';

const MESSAGE_COLUMNS: PermissionKey[] = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'CreateThreads',
  'ManageChannel',
];

const VOICE_COLUMNS: PermissionKey[] = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'ManageChannel'];

/** Household channels carry their permissions in the module mask, which this grid does not edit. */
const STRUCTURED_COLUMNS: PermissionKey[] = ['ViewChannel'];

export function columnsFor(type: ChannelType): PermissionKey[] {
  switch (type) {
    case ChannelType.Voice:
      return VOICE_COLUMNS;
    case ChannelType.Text:
    case ChannelType.Announcement:
    case ChannelType.Forum:
    case ChannelType.Media:
      return MESSAGE_COLUMNS;
    default:
      return STRUCTURED_COLUMNS;
  }
}
```

- [ ] **Step 3: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/role-channel-columns.spec.ts"`
Expected: PASS, 4 tests.

- [ ] **Step 4: Write the failing matrix test**

Create `role-channels.component.spec.ts`:

```ts
describe('RoleChannelsComponent', () => {
    it('shows a channel with no override as inherited', () => {
        const {component} = setup({channels: [channel('c1', ChannelType.Text)]});

        expect(component.cellState('c1', 'SendMessages')).toBe('inherit');
    });

    it('reads allow and deny off the role's override', () => {
        const {component} = setup({
            channels: [channel('c1', ChannelType.Text, {allowPermissions: 'SendMessages', denyPermissions: 'CreateThreads'})],
        });

        expect(component.cellState('c1', 'SendMessages')).toBe('allow');
        expect(component.cellState('c1', 'CreateThreads')).toBe('deny');
    });

    it('writes the whole override when a cell changes', () => {
        const {component, guildService} = setup({channels: [channel('c1', ChannelType.Text)]});

        component.setCell('c1', 'SendMessages', 'deny');

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith('c1', ROLE, {
            allowPermissions: 'None',
            denyPermissions: 'SendMessages',
        });
    });

    it('deletes the override when the last bit is cleared', () => {
        const {component, guildService} = setup({
            channels: [channel('c1', ChannelType.Text, {allowPermissions: 'SendMessages', denyPermissions: 'None'})],
        });

        component.setCell('c1', 'SendMessages', 'inherit');

        expect(guildService.deleteChannelRolePermission).toHaveBeenCalledWith('c1', ROLE);
        expect(guildService.upsertChannelRolePermission).not.toHaveBeenCalled();
    });

    it('offers no control where the column does not apply to the row', () => {
        const {component} = setup({channels: [channel('c1', ChannelType.Voice)]});

        expect(component.applies('c1', 'SendMessages')).toBe(false);
        expect(component.applies('c1', 'Connect')).toBe(true);
    });
});
```

- [ ] **Step 5: Run it to verify it fails, then write the matrix**

The component holds `overrides` as a signal keyed by channel id, reads `columnsFor(channel.type)` per row, and on `setCell` recomputes that channel's `PermOverride`, then either PUTs it or DELETEs when both masks come back empty. Deleting rather than writing an all-None row keeps the resolver from walking a row that says nothing, matching what the server's privacy service already does.

```ts
    setCell(channelId: string, key: PermissionKey, state: OverrideState): void {
        const current = this.overrideFor(channelId);
        const val = Permissions[key];

        let allow = current.allow & ~val;
        let deny = current.deny & ~val;
        if (state === 'allow') allow |= val;
        else if (state === 'deny') deny |= val;

        if (allow === 0n && deny === 0n && current.allowModule === 0n && current.denyModule === 0n) {
            this.guildService.deleteChannelRolePermission(channelId, this.role().id).subscribe({
                next: () => this.forget(channelId),
            });
            return;
        }

        this.guildService
            .upsertChannelRolePermission(channelId, this.role().id, {
                allowPermissions: stringifyPermissions(allow),
                denyPermissions: stringifyPermissions(deny),
            })
            .subscribe({next: perm => this.remember(channelId, perm)});
    }
```

`applies(channelId, key)` returns whether `key` is in `columnsFor` for that row's type. The template renders an em-space where it is not, never a disabled button.

- [ ] **Step 6: Add the third tab**

In `roles-settings.component.ts`, widen `activeTab` to `'settings' | 'members' | 'channels'` and extend `switchTab`. In the template, add the tab button and `@if (activeTab() === 'channels') { <app-role-channels ... /> }`. Add an "Apply to channels" button in that tab that opens `<app-apply-override-dialog>` from Task 2, seeded with the currently selected channel's override.

- [ ] **Step 7: Add the i18n keys**

Submodule first:

```json
"ROLE_CHANNELS.TAB": "Channels",
"ROLE_CHANNELS.SUMMARY": "{{count}} overrides across {{total}} channels",
"ROLE_CHANNELS.LEGEND_ALLOW": "allow",
"ROLE_CHANNELS.LEGEND_DENY": "deny",
"ROLE_CHANNELS.LEGEND_INHERIT": "inherited",
"ROLE_CHANNELS.APPLY": "Apply to channels"
```

- [ ] **Step 8: Run everything**

Run: `bun run ng test --watch=false --include="**/role-channels.component.spec.ts"`
Expected: PASS, 5 tests.

Run: `bun run lint`

```bash
bunx prettier --write "src/app/features/guild/view-as/**" "src/app/features/guild/shared/**" "src/app/features/guild/components/guild-settings-modal/pages/roles-settings/**"
```

Run: `bun run test`
Expected: PASS, at or above baseline.

- [ ] **Step 9: Commit**

```bash
git add -- src/app/features/guild/components/guild-settings-modal/pages/roles-settings src/assets/i18n/locales
git commit -m "feat(permissions): edit a role's channel access as one grid"
```

---

## Self-review notes

- **Spec coverage.** H is Task 1, G is Task 2, E is Tasks 3 and 4, F is Task 5.
- **Order matters.** Task 1 first because it is standalone and Task 5 reuses its column thinking. Task 2 before Task 5 because the matrix's "Apply to channels" button opens that dialog.
- **The one rule worth re-reading before Task 4.** View-as changes what is drawn, never what is permitted. The `grep` in Task 4 Step 5 is not a formality: a single service or store reading the simulated subject turns a preview into a privilege bug.
- **Deliberately not built here.** Guild-level saved permission templates, and syncing a whole category's channels in one action. Both are in the spec's "Out of scope".
