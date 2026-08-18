# Anchored profile popout

Clicking a member in the guild member list or the conversation info panel opens a profile card
anchored to the row, not a centered modal. The card shows mutual friends and mutual servers, and
carries a composer that opens or reuses a DM and sends the first message.

## Current state

`ProfileDialogService.open(userId)` sets a signal. `main-page.component.html:130` renders
`app-profile-dialog`, a centered PrimeNG `p-dialog` holding `app-profile-card`. Seven call sites
open it:

| Call site               | File                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Guild member list       | `features/guild/components/guild-member-list/guild-member-list.component.html:9`                  |
| Conversation info panel | `features/messaging/components/conversation-info-panel/conversation-info-panel.component.html:62` |
| Message author          | `features/messaging/components/conversation/message/message.component.html:12,47,54,170`          |
| DM header               | `features/messaging/components/conversation/conversation.component.html:9`                        |
| Home friends list       | `features/main-page/pages/home/home.component.html:151,181,212`                                   |
| Activity feed           | `features/main-page/components/activity-feed/activity-feed.component.html:30,55,77`               |
| Home status board       | `features/guild/components/home-status-board/home-status-board.component.html:58`                 |

`ProfileDto` already declares `mutualFriends?` and `mutualServers?`. Nothing renders them.

## Scope

Two surfaces, in order of how they open:

1. **Popout.** Anchored to the clicked row. Shows a preview of the mutuals as a single line.
2. **Full profile modal.** Opened from that line. Two columns: the profile card on the left, and a
   tabbed panel on the right holding Activity, N Mutual Friends and M Mutual Servers.

Plus dedicated backend endpoints backing the modal's lists, the DTO correction, and lifting the DM
helper out of `home.component.ts`.

Out: badges (the icon row beside the username), and anchoring the other five call sites. They keep
the centered fallback.

## 1. Placement

`p-popover` cannot do this. Its `align()` calls `absolutePosition`, which places above or below the
target only. The card belongs to the side of the row.

The precedent to follow is `shared/call/call-context-menu`: a hand rolled `position: fixed` card at
`z-[9999]`, `bg-card border-border`, dismissed by `@HostListener('document:click')` and
`document:keydown.escape`, with the host stopping propagation of its own clicks. No PrimeNG.

Placement is a pure function so it is testable without a DOM:

```ts
// components/profile-popout/place-popout.ts
export interface Placement {
  left: number;
  top: number;
}
export function placePopout(
  anchor: DOMRect,
  card: {width: number; height: number},
  viewport: {width: number; height: number},
): Placement;
```

Rules:

- Prefer left of the anchor: `anchor.left - card.width - GAP`.
- Flip to `anchor.right + GAP` when the left edge would land under `MARGIN`.
- Vertically align the card top to the anchor top, then clamp into `[MARGIN, viewport.height - card.height - MARGIN]`.
- When the card is taller than the viewport, pin to `MARGIN` and let it scroll internally.

Repositioned on capture phase `scroll` and on window `resize`. A scroll originating inside the card
is ignored.

## 2. Component

`components/profile-dialog/` is replaced by `components/profile-popout/`. `ProfileDialogService`
becomes `ProfilePopoutService`. Mechanical rename across the seven call sites.

```ts
readonly target = signal<{userId: string; anchor: HTMLElement | null} | null>(null);
open(userId: string, anchor?: HTMLElement): void;
close(): void;
```

`anchor` absent means centered fallback, which is what the five unwired call sites get. The fallback
is also custom: a fixed full screen flex container with a scrim, not `p-dialog`.

Card body stays `app-profile-card` and `app-profile-header`, which already draw the banner, accent
color, overlapping avatar, status dot, name and bio.

Block and Report move off the card face into an overflow button in the top right corner, matching
the reference. The block confirmation and the avatar lightbox keep their current behaviour.

The composer input takes focus on open.

## 3. Mutuals

The client DTO does not match the wire. Server truth, from
`Social.Application/Dtos/Response/ProfileSupplementDtos.cs`:

```csharp
class MutualFriendDto { string ProfileId; string UserId; string UserName; }
class MutualServerDto { string GuildId; string? Name; }
```

The client declares `id` where the server sends `profileId`, and adds `avatarUrl` and `iconUrl`
that the server never sends. Both interfaces are unreferenced outside `dtos/response/profile.dto.ts`,
so correcting them touches nothing else.

The embedded lists stay the popout's preview. One line under the name:

```
[avatar avatar avatar]  9 Mutual Friends  ·  10 Mutual Servers
```

- Friend avatars are `<app-avatar [userId]>`, which resolves and fetches on its own. Capped at three.
- An absent key means the viewer is not permitted to see it. An empty array means there are none.
  Both draw nothing, but every read stays optional or it throws.
- Both halves absent means the whole line is omitted, not an empty row.
- Clicking either half opens the full modal on that tab.

## 4. Backend endpoints

The profile embed is a preview and stays as it is. The modal's lists get their own endpoints, so a
1000 friend profile does not put 1000 rows into every profile read.

```
GET /api/v1/social/profiles/{profileId}/mutual-friends?limit=&cursor=
GET /api/v1/social/profiles/{profileId}/mutual-servers?limit=
```

New `Social.Application/Endpoints/MutualsEndpoint.cs`, Wolverine, following `BlockEndpoint`. Both
answer `{items, nextCursor}`.

`mutual-friends` keyset paginates over `(Relationship.UpdatedAt, Id)` descending and reuses
`BlockEndpoint.EncodeCursor` / `TryDecodeCursor`, which are `internal` in the same assembly. Rows
carry `profileId`, `userId`, `userName`, `avatarUrl` and `onlineStatus`, the last passed through
`ProfileVisibility.ProjectStatus` so a Hidden mutual reads as Offline.

`mutual-servers` comes back from Guild in one bus call with no natural cursor, so it caps at 200 and
always answers `nextCursor: null`. One shape for both, no special case in the client.

Both apply the same gate the profile projection applies, `CanView(settings.MutualXVisibility,
relation)`, and refuse with `403 {"code": "not_visible"}`. That leaks nothing the profile payload
does not already leak: key absence there is exactly as observable.

### Guild has to start returning names

`BusSharedGuildResolver` leaves `MutualServerDto.Name` null because `GetSharedGuildsResponse` only
carries ids, so a server tab built on it today would draw a list of ULIDs.

`SharedGuildsSummary` gains `Guilds`, a list of `{Id, Name}`, alongside the existing `GuildIds`.
Additive: `FriendRequestPolicy.ServerMembers` and `ShareAnyGuildAsync` keep reading `GuildIds` and
are untouched.

Icon URLs are built client side from the guild id, as everywhere else. Not `environment.apiUrl`:
that is the venta.gg address baked in at build time and would send self-hosted deployments to our
servers.

## 5. Full profile modal

`components/profile-modal/`. Custom, like the popout. Left column is the same `app-profile-card`
plus a Message button and the overflow menu. Right column is a tab strip over a scrolling list.

| Tab              | Source                                      | Shown when                                 |
| ---------------- | ------------------------------------------- | ------------------------------------------ |
| Activity         | `UserActivityService.activitiesFor(userId)` | Always. Empty state when there is nothing. |
| N Mutual Friends | `GET .../mutual-friends`                    | `mutualFriends` present on the profile     |
| M Mutual Servers | `GET .../mutual-servers`                    | `mutualServers` present on the profile     |

Counts in the tab labels come from the profile embed, so the strip renders before either list
loads. A tab fetches on first open and keeps its page. A 403 removes the tab rather than showing an
error, because the only way to reach it is a stale count from a profile read that predates the
subject tightening the setting.

Mutual friend rows open that person's profile modal in place, replacing the subject. Mutual server
rows navigate to the guild and close the modal.

## 6. Direct message

`home.component.ts:145` already has `openOrCreateDm`, trapped in that component. It moves to
`services/direct-message.service.ts` unchanged in behaviour:

```ts
openOrCreate(userId: string): Observable<ConversationDto>;
```

It looks for a two member conversation containing the viewer and the target in `ConversationStore`,
and otherwise posts `{members: [{userId}], name: undefined, encryption: Plain, deviceWelcomes: []}`.
`ConversationService.createConversation` already turns the server's 302 duplicate answer into
`{existing: true}` with the conversation in the body, so reuse across a cold store is handled.
`home.component.ts` then calls the service.

Composer flow on Enter, in order: `openOrCreate`, then `MessagingService.createMessage`, then
`NavigationService.openConversation`, then close. The input is disabled while in flight.

On failure the popout stays open with the text intact and a toast reports it. A failure after the
conversation was created still navigates, because the conversation exists and hiding it would strand
it.

### Consequence

`Plain` means these DMs are not end to end encrypted, so a conversation started here will not show
the E2E badge that `conversation.component.html:29` draws. This matches what the friends list does
today and differs from `new-conversation-dialog`, which runs the full MLS exchange. Chosen because
the MLS path can fail on unreachable devices and needs a confirmation prompt the popout has no room
for.

## 7. Errors

| Case                             | Behaviour                                                          |
| -------------------------------- | ------------------------------------------------------------------ |
| Profile fetch fails              | Card shows the existing loading skeleton, no toast. Same as today. |
| Mutual key absent                | Half omitted, tab omitted. Never read without a guard.             |
| Mutuals endpoint 403             | Tab removed. The count that offered it was stale.                  |
| Mutuals endpoint fails otherwise | Retry row inside the tab. The rest of the modal stays usable.      |
| Guild icon 404                   | Falls back to the guild initial.                                   |
| DM create fails                  | Toast, surface stays open, composer text kept.                     |
| Send fails after create          | Toast, navigate anyway.                                            |
| Anchor detached while open       | Close the popout.                                                  |

## 8. Tests

Client:

- `place-popout.spec.ts`: left preferred, right flip when clipped, vertical clamp top and bottom,
  card taller than viewport. No DOM.
- Characterization spec on `home.component.openOrCreateDm` first, green against current code, before
  the lift.
- `direct-message.service.spec.ts`: existing two member conversation reused with no HTTP call;
  created otherwise; `existing: true` from the 302 path still resolves and navigates.
- `profile-popout.component.spec.ts`: mutual halves for absent, empty and populated; whole line
  omitted when both absent; composer disabled while pending; text kept after a failed send.
- `profile-modal.component.spec.ts`: tab present only when its key is present; a tab fetches once
  and keeps its page; 403 removes the tab.

Server, in `Social.Tests` and `Guild.Tests`:

- Gate refuses with `not_visible` for `Nobody`, and for `Friends` when the viewer is not a friend.
- A blocked viewer gets the refusal on both routes.
- Keyset paging over mutual friends returns each row once across pages and terminates.
- A malformed cursor is a 400, not a 500.
- `GetSharedGuildsHandler` fills `Guilds` with names and leaves `GuildIds` byte for byte as before.

## 9. i18n

New keys, needing their own commit in the `src/assets/i18n/locales` submodule:

- `PROFILE.MUTUAL_FRIENDS`
- `PROFILE.MUTUAL_SERVERS`
- `PROFILE.MESSAGE_PLACEHOLDER`
- `PROFILE.TAB_ACTIVITY`
- `PROFILE.NO_ACTIVITY`
- `PROFILE.MUTUALS_RETRY`
