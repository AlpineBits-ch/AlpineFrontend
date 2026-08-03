# Messaging Parity: Search Endpoint Fix and Announcement Cross-Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the already-built message search UI at the endpoint the backend actually exposes, and add announcement channels with Discord's Follow-Channel + Publish cross-posting mechanic.

**Architecture:** Task 1 is a targeted repair - the search UI, store, highlight pipe and results panel all already exist and work; only the two URLs in `MessagingService` are wrong, so nothing above the service layer changes. Tasks 2-5 add `ChannelType.Announcement` to the client model, a `ChannelFollowService`, a Publish action on messages in announcement channels, and a Follow-Channel dialog.

**Tech Stack:** Angular 21 signals, PrimeNG 21 (`Dialog`, `Button`, `Select`), Tailwind v4 theme tokens, `@ngx-translate/core`.

## Global Constraints

- **Never invent colors.** Use theme tokens (`bg-card`, `bg-sidebar`, `bg-hover`, `border-border`, `text-text-primary`, `text-text-secondary`, `text-text-muted`) or CSS vars (`var(--color-brand)`, `var(--color-brand-dim)`, `color-mix(in srgb, var(--color-brand) 15%, transparent)`). No `bg-[#hex]`.
- **Font sizes use rem-based Tailwind classes** (`text-[0.625rem]`, not `text-[10px]`).
- **Scrollable areas use the `thin-scrollbar` class** from `styles.css`.
- **PrimeNG buttons:** `<p-button>` with `(onClick)`, never `(click)`.
- **All URLs through `this.apiConfig.baseUrl()`.** Note the messaging service base legitimately contains `messaging` twice: `/api/v1/messaging/messaging/...` (gateway prefix + the service's own route base). This is not a typo - preserve it.
- **Enums serialize as strings.**
- **All user-facing strings must be i18n keys** in `en.json`, `de.json`, `fr.json` (flat dotted keys). That directory is the `venta-i18n` git submodule - commit inside it first.
- **Visual target is Discord**, adapted to Alpine's conventions.
- Use `ChangeDetectionStrategy.OnPush` on all new components.
- Do not modify `src-tauri/Cargo.lock`.

---

### Task 1: Fix the message search endpoint

**Files:**
- Modify: `src/app/services/messaging.service.ts`
- Test: `src/app/services/messaging.service.spec.ts` (create if absent)

**Interfaces:**
- Produces: corrected `searchMessagesForChannel` / `searchMessagesForConversation`. Callers in `src/app/stores/message.store.ts` (lines ~309 and ~445) keep their existing signatures and must not change.

**Context:** the client currently calls `/api/v1/messaging/messaging/channels/{id}/messages/search?q=...`, which does not exist on the backend. The real endpoint is a single flat route taking the scope as a query parameter. Every remote search has therefore been failing silently - the store swallows the error and falls back to local-only results, so the bug looks like "search only finds recent messages".

- [ ] **Step 1: Write the failing test**

Create `src/app/services/messaging.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {MessagingService} from './messaging.service';
import {ApiConfigService} from './api-config.service';

describe('MessagingService search', () => {
    let service: MessagingService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(MessagingService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('scopes a channel search with query params on the flat search route', () => {
        service.searchMessagesForChannel('c1', 'hello world').subscribe();
        const req = http.expectOne(r => r.url === 'https://api.test.example/api/v1/messaging/messaging/search');
        expect(req.request.method).toBe('GET');
        expect(req.request.params.get('query')).toBe('hello world');
        expect(req.request.params.get('channelId')).toBe('c1');
        expect(req.request.params.get('conversationId')).toBeNull();
        req.flush([]);
    });

    it('scopes a conversation search the same way', () => {
        service.searchMessagesForConversation('v1', 'test').subscribe();
        const req = http.expectOne(r => r.url === 'https://api.test.example/api/v1/messaging/messaging/search');
        expect(req.request.params.get('conversationId')).toBe('v1');
        expect(req.request.params.get('channelId')).toBeNull();
        req.flush([]);
    });

    it('sends the server-side maximum limit', () => {
        service.searchMessagesForChannel('c1', 'x').subscribe();
        const req = http.expectOne(r => r.url.endsWith('/search'));
        expect(req.request.params.get('limit')).toBe('50');
        req.flush([]);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/messaging.service.spec.ts'`
Expected: FAIL - the requests go to `/channels/c1/messages/search` and `expectOne` finds no match.

- [ ] **Step 3: Fix the service**

In `src/app/services/messaging.service.ts`, replace both search methods with:

```ts
    /**
     * Single flat search route scoped by query param - there is no per-channel search
     * path. Relevance-ordered (best match first), not chronological, and MLS-encrypted
     * messages are never indexed so encrypted conversations always come back empty.
     */
    public searchMessagesForChannel(channelId: string, query: string): Observable<MessageDto[]> {
        return this.httpClient.get<MessageDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/search`,
            {params: new HttpParams().set('query', query).set('channelId', channelId).set('limit', SEARCH_LIMIT)}
        );
    }

    public searchMessagesForConversation(conversationId: string, query: string): Observable<MessageDto[]> {
        return this.httpClient.get<MessageDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/search`,
            {params: new HttpParams().set('query', query).set('conversationId', conversationId).set('limit', SEARCH_LIMIT)}
        );
    }
```

Add `HttpParams` to the `@angular/common/http` import, and declare the constant above the class:

```ts
/** Server caps this at 50 and silently falls back to 25 for anything out of range. */
const SEARCH_LIMIT = 50;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `ng test --watch=false --include='**/messaging.service.spec.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the callers still compile**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; full suite green. `message.store.ts` should need no changes - confirm you did not alter either method's signature.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/messaging.service.ts src/app/services/messaging.service.spec.ts
git commit -m "fix: point message search at the real backend endpoint"
```

---

### Task 2: Announcement channel type

**Files:**
- Modify: `src/app/dtos/response/guild.dto.ts`
- Modify: `src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.ts` and `.html`
- Modify: the channel-list item components that map a `ChannelType` to an icon (find with `grep -rn "ChannelType.Forum" src/app/features/guild`)

**Interfaces:**
- Produces: `ChannelType.Announcement` - consumed by Tasks 3-4.

- [ ] **Step 1: Add the enum member**

In `src/app/dtos/response/guild.dto.ts`:

```ts
export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
    Forum = 'Forum',
    Announcement = 'Announcement',
}
```

- [ ] **Step 2: Add the create-channel card**

The create-channel modal already offers Text, Voice and Forum as selectable type cards. Add a fourth for Announcement, copying the existing card markup exactly and using `pi pi-megaphone` as the icon. Add the matching `GUILD.CHANNEL_TYPE_ANNOUNCEMENT` and `GUILD.CHANNEL_TYPE_ANNOUNCEMENT_DESC` translate keys (Task 5 adds them to the locale files). The description should say posts here can be published to other servers that follow this channel.

- [ ] **Step 3: Add the sidebar icon**

Wherever the sidebar maps channel type to an icon (the same place `ChannelType.Forum` is handled), add an `Announcement` branch using `pi pi-megaphone`. Search for every `ChannelType.Forum` occurrence and handle `Announcement` at each site that needs it - including any `switch` that would otherwise fall through to a text-channel default.

- [ ] **Step 4: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green. Any `switch` over `ChannelType` with exhaustiveness checking will surface here - fix each.

- [ ] **Step 5: Commit**

```bash
git add src/app/dtos/response/guild.dto.ts src/app/features/guild
git commit -m "feat: add Announcement channel type"
```

---

### Task 3: Channel follow service and publish endpoint

**Files:**
- Create: `src/app/dtos/response/channel-follow.dto.ts`
- Create: `src/app/services/channel-follow.service.ts`
- Modify: `src/app/services/messaging.service.ts`
- Test: `src/app/services/channel-follow.service.spec.ts`

**Interfaces:**
- Produces: `ChannelFollowDto`, `ChannelFollowService.{follow,listFollowers,unfollow}`, `MessagingService.publishMessage`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/channel-follow.service.spec.ts` asserting, with the standard `ApiConfigService` stub:

- `follow('src1', 'tgt1')` → `POST https://api.test.example/api/v1/guild/channels/src1/followers` with body `{targetChannelId: 'tgt1'}`.
- `listFollowers('src1')` → `GET .../channels/src1/followers`.
- `unfollow('src1', 'f1')` → `DELETE .../channels/src1/followers/f1`.

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/channel-follow.service.spec.ts'`
Expected: FAIL.

- [ ] **Step 3: Write the DTO**

Create `src/app/dtos/response/channel-follow.dto.ts`:

```ts
export interface ChannelFollowDto {
    id: string;
    targetChannelId: string;
    targetGuildId: string;
    createdByUserId: string;
    createdAt: string;
}

/** Response from creating a follow - narrower than the list shape. */
export interface CreatedChannelFollowDto {
    id: string;
    sourceChannelId: string;
    targetChannelId: string;
}

export interface PublishResponse {
    /** Number of channels the copy landed in. Zero is a success, not an error. */
    published: number;
}
```

- [ ] **Step 4: Write the service**

Create `src/app/services/channel-follow.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ChannelFollowDto, CreatedChannelFollowDto} from '../dtos/response/channel-follow.dto';

@Injectable({providedIn: 'root'})
export class ChannelFollowService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /**
     * Initiated from the receiving side, like Discord: the caller picks an announcement
     * channel they can see and nominates one of their own channels to receive its posts.
     * 409 means that exact source-to-target pairing already exists.
     */
    follow(sourceChannelId: string, targetChannelId: string): Observable<CreatedChannelFollowDto> {
        return this.http.post<CreatedChannelFollowDto>(
            `${this.base}/channels/${sourceChannelId}/followers`, {targetChannelId});
    }

    /** Source-side admin view ("who is subscribed to us") - needs ManageChannel on the source. */
    listFollowers(sourceChannelId: string): Observable<ChannelFollowDto[]> {
        return this.http.get<ChannelFollowDto[]>(`${this.base}/channels/${sourceChannelId}/followers`);
    }

    /** Either side may unfollow - a manager of the target guild or of the source guild. */
    unfollow(sourceChannelId: string, followId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${sourceChannelId}/followers/${followId}`);
    }
}
```

- [ ] **Step 5: Add publish to MessagingService**

Append to `src/app/services/messaging.service.ts`, next to the pin methods:

```ts
    /**
     * Copies an announcement-channel message into every channel currently following it.
     * Gated by PinMessages on the source channel, reused as the elevated-action bit rather
     * than adding a new permission. There is no re-publish guard server-side, so callers
     * must disable the control after a successful publish to avoid duplicate sends.
     */
    public publishMessage(messageId: string): Observable<PublishResponse> {
        return this.httpClient.post<PublishResponse>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/publish`, null);
    }
```

with the matching import of `PublishResponse`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `ng test --watch=false --include='**/channel-follow.service.spec.ts'`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/app/dtos/response/channel-follow.dto.ts src/app/services/channel-follow.service.ts src/app/services/channel-follow.service.spec.ts src/app/services/messaging.service.ts
git commit -m "feat: add channel follow service and message publish"
```

---

### Task 4: Publish action and Follow Channel dialog

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts` and `.html`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts` and `.html`
- Create: `src/app/features/guild/components/follow-channel-dialog/follow-channel-dialog.component.ts` and `.html`
- Modify: the guild channel header component (the one hosting the search box in `channel.component.html`)

**Interfaces:**
- Consumes: `ChannelFollowService`, `MessagingService.publishMessage` (Task 3), `ChannelType.Announcement` (Task 2).

**Read first:** `message-hover-toolbar.component.ts` - it currently exposes `isOwn`, `canPin`, `isPinned`, `guildId` inputs and `reply`/`edit`/`delete`/`emojiToggled`/`pinToggled` outputs. Follow that pattern exactly.

- [ ] **Step 1: Add the publish control to the hover toolbar**

In `message-hover-toolbar.component.ts` add:

```ts
    canPublish = input<boolean>(false);
    isPublished = input<boolean>(false);
```

and the output:

```ts
    publish = output<void>();
```

In the toolbar template, add a button rendered only `@if (canPublish())`, using `pi pi-megaphone`, disabled when `isPublished()`, with a tooltip from `MESSAGE.PUBLISH` (or `MESSAGE.PUBLISHED` when already sent). Match the existing toolbar buttons' markup and sizing exactly.

- [ ] **Step 2: Wire it in the message component**

In `message.component.ts`:

- Add `channelType = input<ChannelType | undefined>();`
- Add `protected canPublish = computed(() => this.channelType() === ChannelType.Announcement && this.canPin());` - the backend gates publishing on `PinMessages`, so the same permission the pin control already uses applies here; do not introduce a second permission input.
- Add `protected published = signal(false);`
- Add:

```ts
    protected publish(): void {
        if (this.published()) return;
        // No server-side re-publish guard exists: a second call sends duplicate copies to
        // every follower. Latch locally the moment the request succeeds.
        this.messagingService.publishMessage(this.message().id).subscribe({
            next: res => {
                this.published.set(true);
                this.toast.success(
                    res.published === 0
                        ? 'Published - no servers follow this channel yet'
                        : `Published to ${res.published} channel(s)`);
            },
            error: err => this.toast.httpError('Could not publish', err),
        });
    }
```

In `message.component.html`, extend the existing `<app-message-hover-toolbar ... />` element with `[canPublish]="canPublish()"`, `[isPublished]="published()"` and `(publish)="publish()"`. Keep the existing attributes untouched.

Then pass `[channelType]="channel().type"` down from wherever `<app-message>` is rendered inside the guild channel view.

- [ ] **Step 3: Build the Follow Channel dialog**

Create `follow-channel-dialog.component.ts` + `.html`:

- Inputs: `sourceChannelId`, `sourceChannelName`, `visible` model.
- Injects `GuildService` to list the user's guilds and their channels, so the user can pick a destination.
- Body: a `<p-select>` of the user's guilds, then a `<p-select>` of that guild's `ChannelType.Text` channels, and a confirm button calling `follow(sourceChannelId, targetChannelId)`.
- Error handling: `409` → inline "That channel already follows this one"; `403` → "You need Manage Channel permission in the destination server"; otherwise `toast.httpError`.
- Explanatory copy: posts published in the source channel will be copied into the selected channel; mentions are stripped; crossposted messages arrive as ordinary messages with no special badge.

- [ ] **Step 4: Add the Follow entry point**

In the guild channel header (the component rendering the channel name and search box), add - rendered only when `channel().type === ChannelType.Announcement` - a `<p-button icon="pi pi-plus-circle" [text]="true" severity="secondary" size="small">` opening the follow dialog, with the `CHANNEL.FOLLOW` tooltip.

- [ ] **Step 5: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/messaging src/app/features/guild
git commit -m "feat: add announcement publish action and follow-channel dialog"
```

---

### Task 5: i18n keys

**Files:**
- Modify: `src/assets/i18n/locales/en.json`, `de.json`, `fr.json`

- [ ] **Step 1: Collect every new key**

Grep Tasks 2-4's files for `| translate`. Include at minimum: `GUILD.CHANNEL_TYPE_ANNOUNCEMENT`, `GUILD.CHANNEL_TYPE_ANNOUNCEMENT_DESC`, `MESSAGE.PUBLISH`, `MESSAGE.PUBLISHED`, `CHANNEL.FOLLOW`, and the `FOLLOW_CHANNEL.*` dialog group.

- [ ] **Step 2: Add to all three locales with real translations**

Flat dotted keys, grouped next to their topical neighbours (the `GUILD.CHANNEL_TYPE_*` keys already exist - put the announcement pair immediately after the forum pair). No English placeholders in `de.json`/`fr.json`.

- [ ] **Step 3: Verify parity**

```bash
node -e "const a=require('./src/assets/i18n/locales/en.json'),b=require('./src/assets/i18n/locales/de.json'),c=require('./src/assets/i18n/locales/fr.json');const ka=Object.keys(a).sort(),kb=Object.keys(b).sort(),kc=Object.keys(c).sort();const miss=(x,y,n)=>x.filter(k=>!y.includes(k)).forEach(k=>console.log('missing in '+n+':',k));miss(ka,kb,'de');miss(ka,kc,'fr');console.log('en',ka.length,'de',kb.length,'fr',kc.length)"
```

Expected: no "missing in" lines; equal counts.

- [ ] **Step 4: Commit the submodule, then the pointer**

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat: add announcement cross-posting strings"
git push
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore: bump i18n submodule for cross-posting strings"
```

---

## Notes for the controller

**Expected merge conflicts with sibling plans in this batch:**

- `src/app/dtos/response/guild.dto.ts` - this plan adds `ChannelType.Announcement`; the guild-safety plan adds `verificationLevel` to `GuildDto`; the events/templates plan may also add `Announcement`. Resolve by union, keeping one copy of the enum member.
- `src/app/features/messaging/.../message-hover-toolbar.component.ts` and `message.component.html` - no other plan in this batch touches them, but they were the conflict points in the previous batch. If a conflict appears, resolve by union of inputs/outputs and attributes.
- The three i18n locale files - union of added keys.
