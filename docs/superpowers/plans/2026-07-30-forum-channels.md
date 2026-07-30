# Forum Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let guild admins create a `Forum` channel type, and let members create/browse "posts" inside it — where a post is exactly the existing `Thread` channel type, just parented to a Forum channel instead of a Text channel, per the already-live backend support.

**Architecture:** `ChannelType` gains a `Forum` member. `CreateChannelModalComponent` gets a third type card. A new full-page `ForumChannelComponent` (list of posts + "New post" dialog) is wired into `main-page.component.html`'s existing type-based branch (alongside the current Voice-vs-everything-else split) and reuses `GuildService.getThreads`/`createThread`/`archiveThread` unchanged — the only backend-visible addition is an optional `content` field on `CreateThreadDto`, which posts the post's first message server-side in one round trip. Opening a post is just `navService.openChannel(post)`, which already renders any `Thread`-type channel through the existing `ChannelComponent` — no new "post view" component is needed.

**Tech Stack:** Angular 21 (signals, `input()`, new `@if`/`@for` control flow), Vitest (`*.spec.ts`, run via `ng test`), PrimeNG (`Button`, `Dialog`, `InputText`, `Textarea`).

## Global Constraints

- `POST https://api.venta.gg/api/v1/guild/guilds/{guildId}/channels` with `{type: "Forum", ...}` creates a Forum channel — same permission (`Permissions.ManageChannel`) as Text/Voice, no new endpoint.
- `POST https://api.venta.gg/api/v1/guild/channels/{forumChannelId}/threads` creates a post — `name` is the post title, optional `content` is posted as the first message automatically server-side. Requires `Permissions.CreateThreads` on the forum channel (same permission as thread creation under a Text channel — not newly gated client-side, matching the existing `ThreadPanelComponent`'s "create thread" button, which today has no client-side permission gate either).
- `GET https://api.venta.gg/api/v1/guild/channels/{forumChannelId}/threads` lists posts — same endpoint as Text-channel thread listing, filtered server-side by `parentChannelId`.
- No tags/categories on posts, no distinct "pinned post" concept, no reactions on the post container itself, no post preview snippet (the `GET .../threads` response is a plain `ChannelDto[]` with no message content attached — rendering a snippet would require fetching each post's first message individually, which is out of scope for this pass; only the post title and creation time are shown in the list).
- Full spec: see the "Forum channels — frontend integration guide" section of the conversation this plan originated from (not a repo file — inline in the planning session).

---

### Task 1: `ChannelType.Forum` + `CreateThreadDto.content` + translations

**Files:**
- Modify: `src/app/dtos/response/guild.dto.ts`
- Modify: `src/app/dtos/request/create-thread.dto.ts`
- Modify: `src/app/assets/i18n/locales/en.json` (path shown relative to repo root: `src/assets/i18n/locales/en.json`)
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`

**Interfaces:**
- Produces: `ChannelType.Forum = 'Forum'`, `CreateThreadDto.content?: string` — consumed by every later task.

- [ ] **Step 1: Add the enum member**

In `src/app/dtos/response/guild.dto.ts`, change:

Before:
```ts
export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
}
```

After:
```ts
export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
    Forum = 'Forum',
}
```

- [ ] **Step 2: Add the optional `content` field**

In `src/app/dtos/request/create-thread.dto.ts`, change:

Before:
```ts
export interface CreateThreadDto {
    name: string;
    description?: string;
}
```

After:
```ts
export interface CreateThreadDto {
    name: string;
    description?: string;
    content?: string;
}
```

- [ ] **Step 3: Add translation keys**

In `src/assets/i18n/locales/en.json`, add these two keys immediately after the existing `"GUILD.CHANNEL_TYPE_VOICE_DESC"` entry:

```json
  "GUILD.CHANNEL_TYPE_FORUM": "Forum",
  "GUILD.CHANNEL_TYPE_FORUM_DESC": "Organize discussions into posts",
```

In `src/assets/i18n/locales/de.json`, add the matching keys in the same position:

```json
  "GUILD.CHANNEL_TYPE_FORUM": "Forum",
  "GUILD.CHANNEL_TYPE_FORUM_DESC": "Diskussionen in Beiträgen organisieren",
```

In `src/assets/i18n/locales/fr.json`, add the matching keys in the same position:

```json
  "GUILD.CHANNEL_TYPE_FORUM": "Forum",
  "GUILD.CHANNEL_TYPE_FORUM_DESC": "Organiser les discussions en publications",
```

(Match whatever exact surrounding punctuation/comma style each file already uses for its `GUILD.CHANNEL_TYPE_*` block — check the existing `CHANNEL_TYPE_VOICE_DESC` entry's trailing comma in each file before inserting.)

- [ ] **Step 4: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully (the new enum member and DTO field are additive and unused so far).

- [ ] **Step 5: Commit**

```bash
git add src/app/dtos/response/guild.dto.ts src/app/dtos/request/create-thread.dto.ts src/assets/i18n/locales/en.json src/assets/i18n/locales/de.json src/assets/i18n/locales/fr.json
git commit -m "feat: add Forum channel type and thread content field"
```

---

### Task 2: Forum option in `CreateChannelModalComponent`

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.html`

**Interfaces:**
- Consumes: `ChannelType.Forum` (Task 1). No template-only logic changes needed in the `.ts` file — `type` is already a plain `signal<ChannelType>`, and `submit()` already passes `type()` straight through to `GuildService.createChannel`.

- [ ] **Step 1: Add the third type card**

In `src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.html`, change the type-selector grid (currently a 2-column grid with Text and Voice cards):

Before:
```html
        <div>
            <p class="text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">{{ 'GUILD.CHANNEL_TYPE' | translate }}</p>
            <div class="grid grid-cols-2 gap-2">
                <button
                        (click)="type.set(ChannelType.Text)"
                        [ngClass]="type() === ChannelType.Text ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                        class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                    <span class="text-base font-bold text-white/50">#</span>
                    <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_TEXT' | translate }}</span>
                    <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_TEXT_DESC' | translate }}</span>
                </button>
                <button
                        (click)="type.set(ChannelType.Voice)"
                        [ngClass]="type() === ChannelType.Voice ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                        class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                    <i class="pi pi-volume-up text-white/50"></i>
                    <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_VOICE' | translate }}</span>
                    <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_VOICE_DESC' | translate }}</span>
                </button>
            </div>
        </div>
```

After:
```html
        <div>
            <p class="text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">{{ 'GUILD.CHANNEL_TYPE' | translate }}</p>
            <div class="grid grid-cols-3 gap-2">
                <button
                        (click)="type.set(ChannelType.Text)"
                        [ngClass]="type() === ChannelType.Text ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                        class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                    <span class="text-base font-bold text-white/50">#</span>
                    <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_TEXT' | translate }}</span>
                    <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_TEXT_DESC' | translate }}</span>
                </button>
                <button
                        (click)="type.set(ChannelType.Voice)"
                        [ngClass]="type() === ChannelType.Voice ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                        class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                    <i class="pi pi-volume-up text-white/50"></i>
                    <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_VOICE' | translate }}</span>
                    <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_VOICE_DESC' | translate }}</span>
                </button>
                <button
                        (click)="type.set(ChannelType.Forum)"
                        [ngClass]="type() === ChannelType.Forum ? 'border-brand/50 bg-brand/10' : 'border-white/[0.08] bg-white/[0.03]'"
                        class="flex flex-col items-start gap-1 p-3 rounded-xl border transition-all cursor-pointer">
                    <i class="pi pi-align-left text-white/50"></i>
                    <span class="text-sm font-medium text-white/80">{{ 'GUILD.CHANNEL_TYPE_FORUM' | translate }}</span>
                    <span class="text-[11px] text-white/35">{{ 'GUILD.CHANNEL_TYPE_FORUM_DESC' | translate }}</span>
                </button>
            </div>
        </div>
```

Also update the name-field prefix icon (currently only branches Text vs Voice):

Before:
```html
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 font-bold text-sm pointer-events-none">
          @if (type() === ChannelType.Text) {
              #
          } @else {
              <i class="pi pi-volume-up text-xs"></i>
          }
        </span>
```

After:
```html
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 font-bold text-sm pointer-events-none">
          @if (type() === ChannelType.Text) {
              #
          } @else if (type() === ChannelType.Forum) {
              <i class="pi pi-align-left text-xs"></i>
          } @else {
              <i class="pi pi-volume-up text-xs"></i>
          }
        </span>
```

- [ ] **Step 2: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 3: Manual verification**

Run the app, open "Create Channel" in a guild you manage, confirm a third "Forum" card appears, selecting it updates the name-field icon, and submitting creates a channel with `type: "Forum"` (visible via the network tab or by confirming it shows up correctly once Task 3/4 land).

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.html
git commit -m "feat: add Forum option to the create-channel dialog"
```

---

### Task 3: Forum channel icon in the sidebar

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.ts`
- Modify: `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.html`

**Interfaces:**
- Consumes: `ChannelType.Forum` (Task 1). `channel-list-items.component.html` already routes every non-`Voice` channel type (including the new `Forum`) into `<app-text-channel-item>` via its `@else` branch — no change needed there.

- [ ] **Step 1: Expose `ChannelType` to the template**

In `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.ts`, add the import and a protected re-export:

```ts
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
```

(merge into the existing `import {ChannelDto} from '../../../../../../dtos/response/guild.dto';` line)

Add to the class body:

```ts
    protected readonly ChannelType = ChannelType;
```

- [ ] **Step 2: Branch the leading icon**

In `src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.html`, change:

Before:
```html
        <span class="text-white/35 text-[25px] leading-none font-medium shrink-0 pointer-events-none">#</span>
```

After:
```html
        @if (channel().type === ChannelType.Forum) {
            <i class="pi pi-align-left text-white/35 text-[17px] shrink-0 pointer-events-none"></i>
        } @else {
            <span class="text-white/35 text-[25px] leading-none font-medium shrink-0 pointer-events-none">#</span>
        }
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Manual verification**

Create a Forum channel (Task 2), confirm its sidebar row shows the align-left icon instead of `#`, sized/aligned consistently with the text-channel rows around it.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.ts src/app/features/guild/components/channel-list/components/text-channel-item/text-channel-item.component.html
git commit -m "feat: render a distinct icon for Forum channels in the sidebar"
```

---

### Task 4: `ForumChannelComponent` (post list + create-post dialog)

**Files:**
- Create: `src/app/features/guild/components/forum-channel/forum-channel.component.ts`
- Create: `src/app/features/guild/components/forum-channel/forum-channel.component.html`

**Interfaces:**
- Consumes: `GuildService.getThreads(channelId)`, `GuildService.createThread(channelId, dto)` (existing, unchanged signatures — `dto` now optionally carries `content` per Task 1), `GuildWebsocketService.threadCreatedObservable` (existing).
- Produces: `ForumChannelComponent` with `channel = input.required<ChannelDto>()`, `back = output()` (mirroring `ChannelComponent`'s own `back` output so `main-page.component.html` can wire it identically) — consumed by Task 5.

- [ ] **Step 1: Implement the component**

Create `src/app/features/guild/components/forum-channel/forum-channel.component.ts`:

```ts
import {Component, DestroyRef, effect, inject, input, output, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ToastService} from '../../../../services/toast.service';

@Component({
    selector: 'app-forum-channel',
    imports: [Button, InputText, Textarea, Dialog, FormsModule, PrimeTemplate, DatePipe],
    templateUrl: './forum-channel.component.html',
})
export class ForumChannelComponent {
    channel = input.required<ChannelDto>();
    back = output();

    posts = signal<ChannelDto[]>([]);
    loading = signal(true);
    showCreateDialog = signal(false);
    createName = signal('');
    createContent = signal('');
    creating = signal(false);

    protected navService = inject(NavigationService);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);

    constructor() {
        effect(() => {
            this.channel().id;
            this.load();
        });

        this.guildWsService.threadCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.parentChannelId !== this.channel().id) return;
                this.load();
            });
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getThreads(this.channel().id).subscribe({
            next: posts => {
                this.posts.set(posts);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load posts', err);
            },
        });
    }

    openCreateDialog(): void {
        this.createName.set('');
        this.createContent.set('');
        this.showCreateDialog.set(true);
    }

    createPost(): void {
        const name = this.createName().trim();
        if (!name || this.creating()) return;
        this.creating.set(true);
        const content = this.createContent().trim();
        this.guildService.createThread(this.channel().id, {name, content: content || undefined}).subscribe({
            next: post => {
                this.posts.update(list => [post, ...list]);
                this.showCreateDialog.set(false);
                this.creating.set(false);
                this.navService.openChannel(post);
            },
            error: err => {
                this.creating.set(false);
                this.toastService.httpError('Failed to create post', err);
            },
        });
    }

    openPost(post: ChannelDto): void {
        this.navService.openChannel(post);
    }
}
```

- [ ] **Step 2: Implement the template**

Create `src/app/features/guild/components/forum-channel/forum-channel.component.html`:

```html
<div class="flex flex-col h-full bg-app-bg overflow-hidden">

    <!-- Header -->
    <header class="flex items-center px-3 sm:px-5 border-b border-white/[0.10] shrink-0 bg-app-bg"
            style="padding-top: env(safe-area-inset-top); min-height: calc(env(safe-area-inset-top) + 3.5rem)">
        <p-button (onClick)="navService.mobileNavOpen.set(true)" [text]="true" class="lg:hidden" icon="pi pi-bars"
                  severity="secondary" size="small" styleClass="mr-1"/>
        <div class="flex items-center gap-2 sm:gap-3 min-w-0">
            <i class="pi pi-align-left text-white/30 shrink-0"></i>
            <span class="text-sm font-semibold text-white/85 truncate">{{ channel().name }}</span>
            @if (channel().description) {
                <span class="hidden sm:block text-white/40 text-xs border-l border-white/15 pl-3 ml-1 truncate max-w-xs">
                    {{ channel().description }}
                </span>
            }
        </div>
        <div class="ml-auto">
            <p-button (onClick)="openCreateDialog()" icon="pi pi-plus" label="New Post" severity="primary" size="small"/>
        </div>
    </header>

    <!-- Post list -->
    <div class="flex-1 min-h-0 overflow-y-auto" style="scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.08) transparent;">
        <div class="px-4 py-4">
            @if (loading()) {
                <p class="text-xs text-white/25 text-center py-8">Loading…</p>
            } @else if (posts().length === 0) {
                <div class="flex flex-col items-center justify-center py-16 gap-3">
                    <i class="pi pi-align-left text-3xl text-white/10"></i>
                    <p class="text-sm text-white/25 m-0">No posts yet — start the first one.</p>
                </div>
            } @else {
                <div class="flex flex-col gap-1.5">
                    @for (post of posts(); track post.id) {
                        <button (click)="openPost(post)"
                                class="flex flex-col gap-1 bg-card/60 border border-white/[0.06] rounded-xl p-3 text-left hover:bg-hover hover:border-white/[0.10] transition-colors w-full">
                            <span class="text-sm font-medium text-white/85 truncate">{{ post.name }}</span>
                            <span class="text-[11px] text-white/30">{{ post.createdAt | date: 'MMM d, y · h:mm a' }}</span>
                        </button>
                    }
                </div>
            }
        </div>
    </div>
</div>

<!-- Create post dialog -->
<p-dialog (visibleChange)="showCreateDialog.set($event)" [draggable]="false" [modal]="true" [resizable]="false"
          [style]="{width: '480px'}" [visible]="showCreateDialog()" appendTo="body">
    <ng-template pTemplate="header">
        <span class="text-sm font-semibold text-white/85">New Post</span>
    </ng-template>
    <div class="flex flex-col gap-3">
        <input (ngModelChange)="createName.set($event)" [ngModel]="createName()" pInputText placeholder="Post title"
               type="text"/>
        <textarea (ngModelChange)="createContent.set($event)" [ngModel]="createContent()"
                   placeholder="What do you want to talk about? (optional)" pTextarea rows="4"></textarea>
    </div>
    <ng-template pTemplate="footer">
        <p-button (onClick)="showCreateDialog.set(false)" [text]="true" label="Cancel"/>
        <p-button (onClick)="createPost()" [disabled]="!createName().trim()" [loading]="creating()" label="Create Post"/>
    </ng-template>
</p-dialog>
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully (component isn't wired into any route yet — this only confirms it compiles standalone).

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/forum-channel/
git commit -m "feat: add ForumChannelComponent post list and create-post dialog"
```

---

### Task 5: Wire `ForumChannelComponent` into channel routing

**Files:**
- Modify: `src/app/features/main-page/main-page.component.html`
- Modify: `src/app/features/main-page/main-page.component.ts`

**Interfaces:**
- Consumes: `ForumChannelComponent` (Task 4).

- [ ] **Step 1: Register `ForumChannelComponent`**

In `src/app/features/main-page/main-page.component.ts`, add the import next to the existing `ChannelComponent`/`VoiceChannelComponent` imports (currently lines 10-11):

```ts
import {ForumChannelComponent} from '../guild/components/forum-channel/forum-channel.component';
```

Add `ForumChannelComponent` to the `imports` array in the `@Component` decorator, next to the existing `ChannelComponent`/`VoiceChannelComponent` entries (currently lines 51-52):

```ts
        ChannelComponent,
        VoiceChannelComponent,
        ForumChannelComponent,
```

- [ ] **Step 2: Branch the template on `ChannelType.Forum`**

In `src/app/features/main-page/main-page.component.html`, change the `'channel'` case:

Before:
```html
                @case ('channel') {
                    @if (view.channel.type === ChannelType.Voice) {
                        <app-voice-channel [channel]="view.channel"/>
                    } @else {
                        <app-channel (back)="navService.showHome()" [channel]="view.channel"/>
                    }
                }
```

After:
```html
                @case ('channel') {
                    @if (view.channel.type === ChannelType.Voice) {
                        <app-voice-channel [channel]="view.channel"/>
                    } @else if (view.channel.type === ChannelType.Forum) {
                        <app-forum-channel (back)="navService.showHome()" [channel]="view.channel"/>
                    } @else {
                        <app-channel (back)="navService.showHome()" [channel]="view.channel"/>
                    }
                }
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Manual verification (end-to-end)**

Run the app:
1. Create a Forum channel in a guild you manage (Task 2's dialog).
2. Selecting it in the sidebar now opens `ForumChannelComponent` instead of the normal message view — confirm the header, empty state, and "New Post" button render.
3. Click "New Post", type a title and some content, submit — confirm it navigates straight into the new post (a normal `ChannelComponent` view, since the post is a `Thread`-type channel) and the content you typed appears as the first message.
4. Go back to the forum channel — the post now appears in the list with its title and creation time.
5. Post a reply inside the opened post via the normal composer — confirm it behaves exactly like a Text-channel thread (because it is one).
6. From a second account/session in the same guild, create another post — confirm the first account's forum list updates live via `guild.ThreadCreated` without a manual refresh.
7. Create a post with no content (leave the textarea empty) — confirm it opens successfully with no first message (empty thread, exactly like today's plain `ThreadPanelComponent` flow).

- [ ] **Step 5: Commit**

```bash
git add src/app/features/main-page/main-page.component.ts src/app/features/main-page/main-page.component.html
git commit -m "feat: route Forum channels to ForumChannelComponent"
```
