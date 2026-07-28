# Guild System Messages (Join/Leave) - Design

## Background

The backend now posts Discord-style system messages into a guild's system channel when a
member joins (`type: "GuildMemberJoin"`), and is forward-compatible for a future
`"GuildMemberLeave"` (no backend event produces this yet). Every message - REST history and
realtime alike - now carries `type` (string enum: `Message`, `Invite`, `GuildMemberJoin`,
`GuildMemberLeave`) and `systemMessageVariant` (`0`–`9`, only set for non-`Message` types).
The backend never sends copy text for these; the client owns ~10 wording variants per type,
picked by index, with the joining user substituted in as a mention.

Guilds also gained a nullable `systemChannelId` field (the channel these messages post into),
settable via `PATCH /api/v1/guild/guilds/{id}` (omit the field to leave unchanged - explicit
`null` to clear isn't wired up server-side yet).

This spec covers what the Angular client needs to build to render these messages and manage
the system channel setting. Full backend contract is in the original integration doc (see the
"Guild system messages" writeup shared alongside this request).

## Goals

- Render `GuildMemberJoin` (and, forward-compatibly, `GuildMemberLeave`) messages as centered,
  avatar-less system lines in the channel view, both from REST history and live via
  `guild.MessageCreated`.
- Let guild admins (ManageGuild) pick which Text channel receives system messages, from
  Overview settings.
- Fix a related bug found during investigation: `guild-websocket.service.ts` currently
  hardcodes `type: MessageType.Message` on every incoming `guild.MessageCreated` event,
  which would silently mis-render system messages arriving live even after the rest of this
  work lands.
- Wire up the `guild.MemberJoined` presence event, confirmed genuinely missing (not stale) -
  it directly replaces a documented TODO/stopgap in `guild-member-list.component.ts` and
  `bot-install-dialog.service.ts`.

## Non-goals

- Building `GuildMemberLeave`-triggering backend logic (kicks/bans/leaves) - the client just
  needs to render one generically if it ever arrives.
- A dedicated `Invite` system-message renderer - `type: "Invite"` is added to the enum for
  completeness, but this app already renders shared invite links via content-based URL
  detection in `MessageComponent`; that path is untouched.
- An "Announcement" channel type in the system-channel picker - this codebase only has
  `Text`/`Voice`/`Thread` channel types, so the picker is Text-only (the spec's Discord-style
  "Text or Announcement" wording doesn't apply here).
- A "None" option for the system channel picker - every guild already has one assigned at
  creation, and explicitly clearing isn't backend-supported yet.
- Replacing the bot-install roster-refresh stopgap - `guild.MemberJoined` isn't confirmed to
  also fire during bot installs, so that stopgap stays as-is; only the human-join TODO is
  resolved.

## Data model changes

**`src/app/enums/message-type.enum.ts`**
```ts
export enum MessageType {
    Message = 'Message',
    System = 'System',        // unchanged, unused by this feature
    Invite = 'Invite',
    GuildMemberJoin = 'GuildMemberJoin',
    GuildMemberLeave = 'GuildMemberLeave',
}
```

**`src/app/dtos/response/message.dto.ts`**
- Add `systemMessageVariant?: number;` to `MessageDto`.

**`src/app/dtos/response/guild.dto.ts`**
- Add `systemChannelId: string | null;` to `GuildDto`.

**`src/app/services/guild.service.ts`**
- Add `systemChannelId?: string;` to `UpdateGuildDto` (optional/omittable, matching the
  "omit to leave unchanged" contract - never send `null` from this client).

No REST service changes are needed beyond the DTO additions: `MessagingService`'s history
endpoints are plain `HttpClient.get<MessageDto[]>` calls, so new fields flow through once
they're on the interface.

## Realtime wiring

**`src/app/services/guild-websocket.service.ts`**
- The `guild.MessageCreated` handler's inline payload type gains `type: string` and
  `systemMessageVariant: number | undefined`, and the constructed `MessageDto` uses
  `type: data.type as MessageType` and `systemMessageVariant: data.systemMessageVariant`
  instead of the current hardcoded `MessageType.Message`.
- New `WsMemberJoined { guildId: string; userId: string }` interface and
  `memberJoinedObservable = new Subject<WsMemberJoined>()`, registered in `setupListeners()`
  against `guild.MemberJoined`.

**`src/app/features/guild/components/guild-member-list/guild-member-list.component.ts`**
- Constructor subscribes to `memberJoinedObservable`: on a matching `guildId`, `reset()` +
  `fetchPage()`, same shape as the existing bot-install stopgap subscription right below it.
  Leave the bot-install stopgap and its TODO comment in place (see Non-goals).

## Rendering

**New component: `src/app/features/messaging/components/conversation/message/system-message/system-message.component.ts` (+ `.html`)**
- Selector `app-system-message`, input `message = input.required<MessageDto>()`.
- A `readonly variantText = computed(...)` that:
  1. Picks the variant array by `message().type` (`GuildMemberJoin` → join variants,
     `GuildMemberLeave` → leave variants).
  2. Indexes by `message().systemMessageVariant ?? 0`, clamped into range defensively.
  3. Returns the i18n key for that slot (e.g. `MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.3`).
- Resolves the joining user's profile via `ProfileService` (same
  `resolveByUserId`/`getCachedByUserId` pattern `MessageComponent` already uses for mentions),
  and renders it with the existing `mention-chip` styling + `appUserNameStyle` directive,
  clickable to open the profile dialog - visually consistent with an `@mention` inside a
  normal message.
- Template: `translate` pipe on the resolved key with a `{{ user: ... }}` param wrapping the
  rendered mention chip; centered, avatar-less row (`flex justify-center py-1`), muted text
  size, no hover toolbar/reactions/reply affordances (not a real interactive message).

**`src/app/features/guild/components/channel/channel.component.html`**
- In the messages `@for` loop, branch on `msg.type`: `GuildMemberJoin`/`GuildMemberLeave` render
  `<app-system-message [message]="msg"/>`, everything else renders the existing `<app-message>`
  unchanged (same inputs/outputs as today).

`MessageComponent` itself is untouched - no new branches added to its already-large template.

## i18n

New flat keys, added to `en.json`, `de.json`, and `fr.json` (matching the existing
`MESSAGE.*` naming convention), with real translated copy in all three locales for this pass:

```
MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0 .. .9
MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0 .. .9
```

Each value contains a `{{user}}` placeholder, e.g. `"{{user}} joined the server"`. Exact
10-variant wording (join and leave, all 3 locales) is drafted during implementation, following
the tone of the example set in the original integration doc (light, Discord-like, not
corporate).

## Guild settings - system channel picker

**`src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.ts`**
- New `systemChannelId = signal<string | null>(null)`, initialized in `ngOnInit()` from
  `this.guild().systemChannelId`.
- `channelOptions = computed(...)` over `this.guild().channels.filter(c => c.type ===
  ChannelType.Text)`, shaped `{label: c.name, value: c.id}` for `p-select` (same
  `optionLabel`/`optionValue` pattern as `wiki-editor.component.html`'s category/parent
  pickers).
- `onFieldChange()`'s dirty check extends to compare `systemChannelId()` against
  `guild().systemChannelId`.
- `save()`'s `UpdateGuildDto` includes `systemChannelId: this.systemChannelId() ?? undefined`
  only when it actually changed (never sends `null`).

**`overview-settings.component.html`**
- New field block after Description, following the existing label/control markup pattern:
  a `p-select` bound to `systemChannelId`, labeled via new i18n key
  `GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL` (+ a short hint key), options from
  `channelOptions()`.

## Testing

- Unit test for the variant-selection logic in `SystemMessageComponent` (index selection,
  clamping, join vs. leave array selection).
- Unit test for `channel.component`'s render-branch (system type → `app-system-message`,
  normal type → `app-message`) if existing test setup covers that component; otherwise this
  is verified manually via the running app per the project's UI-testing convention.
- Manual verification: join a guild with a system channel configured and confirm the message
  renders live; confirm channel history (page reload) renders it identically from REST; change
  the system channel in Overview settings and confirm it persists.

## Open questions / follow-ups (not blocking this spec)

- Whether bot installs also fire `guild.MemberJoined` - if backend confirms they do, the
  bot-install stopgap in `bot-install-dialog.service.ts` / `guild-member-list.component.ts`
  can be removed as a follow-up.
- A "None"/clear option for the system channel picker, once the backend supports explicitly
  clearing `systemChannelId`.