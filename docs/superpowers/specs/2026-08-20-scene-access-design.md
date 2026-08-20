# Scene access

Design for who may play in a scene and who may see it: a per-scene join policy, a request queue the
GM works, and a visibility rule that holds everywhere a scene channel is read.

From the roleplay requirements: a scene needs a setting for whether anyone can bring a character in
or only the added ones may speak, and a visibility setting whose non-default value shows the scene to
the cast and the admins only.

Spans two repos. Sections A to F are `RiderProjects\Echo`; G onwards is this client. The backend half
needs mirroring into `Echo/docs/specs` as a frontend guide once the wire shapes are real.

## What ships

1. `SceneState.JoinPolicy` and `SceneState.Visibility`, set at creation and changed by the GM.
2. Visibility enforced beside the permission answer, not inside it, in six call sites.
3. A player verb: bring one of your characters into an open scene, joining the rotation.
4. `SceneJoinRequest`: ask, approve, deny with a reason, ask again.
5. A send gate: in a closed scene only the cast and `ManageScenes` speak in character.
6. Two system messages: a character joined the scene, a character left it.
7. Two inbox task kinds: requests waiting on a GM, and your own request denied.

## Decisions taken

| Question | Answer |
|---|---|
| Where the way in lives | The composer strip, in the slot the turn strip already owns. It carries both registers: bring a character in when the scene is open, ask when it is closed. |
| How the character is picked | A dialog. It is the only surface with room to say where in the rotation the character lands, and it carries the optional note when the scene is closed. |
| Where the GM answers | A banner under the scene header, in the slot the stalled-scene banner uses, plus an inbox task. |
| How the GM sets the rules | Three named presets: Open table, Ask to join, Private table. The fourth combination is refused by the server, so the picker can never fail to describe a scene. |
| What joining does to the rotation | Appends. The character is in the cast and takes the last turn in the order. |
| Who speaks in a closed scene | The cast, plus anyone holding `ManageScenes`. |
| Who speaks in the OOC thread | Anyone who can see the scene, cast or not. The companion thread follows visibility, never the cast. |
| What hidden means | Hidden everywhere: the board, the archive, the folder rail, the thread list, message history, realtime fan-out and bot dispatch. No locked placeholder row. |
| Asking into a hidden scene | Not possible. You cannot see it, so the GM adds you by hand. Requests exist only for a visible, closed scene. |
| A denied request | Carries an optional reason, keeps its row, and does not stop the player asking again. |
| Speaking as a character not in an open scene | Auto-joins it, with the same system message the explicit verb writes. My call, not a stated requirement: without it the cast means nothing in an open scene. |
| Guild-wide defaults | None. Per scene only. |
| Who the GM is | Anyone holding `ManageScenes`, not the scene's creator. Matches every other verb on a scene. |

## A. Guild: data model

```
SceneState                           // existing, two new columns
    JoinPolicy : Open | Ask          // new pg enum SceneJoinPolicy, default Open
    Visibility : Everyone | Cast     // new pg enum SceneVisibility, default Everyone

SceneJoinRequest                     // scjr_
    Id (PK)
    SceneChannelId, GuildId
    PersonaId
    RequestedByUserId
    Note?                            // <= 300 chars, the player's pitch
    Status : Pending | Approved | Denied | Withdrawn
    DecidedByUserId?, DecidedAt?, DecisionReason?
    CreatedAt, UpdatedAt
```

Indexes: `(GuildId, Status)` for the GM's queue, `(SceneChannelId, Status)` for one scene's banner,
and a unique partial index on `(SceneChannelId, PersonaId) WHERE Status = 'Pending'` so a character
cannot queue twice. Decided rows stay: the player's inbox reads the reason off them, and a later
request is a new row rather than a reopened one.

`Visibility = Cast` with `JoinPolicy = Open` is refused with `scene_visibility_conflict`, because
walking into a scene you cannot see is not a state anything can act on. The client's three presets
are exactly the three legal pairs. A silent rewrite was the alternative and was rejected: a PATCH
that answers with something the caller did not send is worse than a 400.

Migration: two `HasPostgresEnum` types, two columns with defaults, one table. Existing scenes become
`Open` and `Everyone`, which is what they behave as today.

## B. Guild: visibility enforcement

`ComputePermissionsForUserAsync` resolves thread-shaped channels in a second pass that copies the
parent's mask verbatim, and skips channel overwrites for them entirely. A `ChannelPermission` row on
a scene channel is therefore ignored, and expressing visibility as an overwrite would mean changing
how every thread in the product resolves. Visibility is a scene rule checked beside the permission
answer, never a permission itself.

```
SceneVisibilityCache(IDistributedCache, MicroserviceContext, PersonaService)

    RestrictedAsync(guildId)
        -> { channelId -> castPersonaIds }
        covers scenes with Visibility = Cast and their OOC thread ids, nothing else
        epoch-keyed the way PersonaService keys its per-user sets, so one write
        invalidates the guild

    CanSeeAsync(userId, guildId, channelId, isGameMaster)
        not in the map                              -> true
        isGameMaster                                -> true
        usable persona ids intersect the cast       -> true
        otherwise                                   -> false
```

`GuildPermissionService` takes the cache as a constructor parameter and applies it after the mask
answer in four paths, seven overloads between them:

| Call site | What it stops leaking |
|---|---|
| `CanUserPerformActionAsync(user, channel, Permissions)` | The scene read, the message history read, every endpoint that asks `ViewChannel` |
| `CanUserPerformActionAsync(user, channel, ModulePermissions)` | The module verbs on a scene channel |
| `FilterUsersWithChannelPermissionAsync`, both overloads | Realtime fan-out and bot dispatch. This is what keeps a private scene's messages off other people's sockets |
| `FilterChannelsWithPermissionAsync`, all three overloads | Channel lists, thread lists, search |

No dependency cycle: `PersonaService` takes only the cache and the context, and the `ManageScenes`
check is `CanUserPerformActionOnGuildAsync`, which is a guild-level answer and does not re-enter the
channel path. The guild owner short-circuits ahead of all of it and keeps seeing everything.

The common case is one dictionary lookup against a map that is empty in most guilds. All three inputs
(the map, the caller's usable personas, the module mask) are already cached.

Invalidation: the epoch moves when a scene's visibility changes, when the cast of a restricted scene
changes, and when a restricted scene or its channel is deleted.

## C. Guild: joining and requests

```
POST   /api/v1/guilds/{guildId}/scenes/{id}/join                    {personaId}
DELETE /api/v1/guilds/{guildId}/scenes/{id}/join/{personaId}
POST   /api/v1/guilds/{guildId}/scenes/{id}/join-requests           {personaId, note?}
GET    /api/v1/guilds/{guildId}/scenes/{id}/join-requests           ?status=Pending
POST   /api/v1/guilds/{guildId}/scenes/{id}/join-requests/{rid}/approve
POST   /api/v1/guilds/{guildId}/scenes/{id}/join-requests/{rid}/deny  {reason?}
DELETE /api/v1/guilds/{guildId}/scenes/{id}/join-requests/{rid}
GET    /api/v1/guilds/{guildId}/scene-join-requests                 ?status=Pending
```

`/join` is not `/participants` with a different guard. `/participants` is the GM adding anybody;
`/join` accepts only a persona the caller may speak as, only on a scene whose policy is `Open`, and
only while the scene is not concluded. Two authorizations, two routes.

`GET .../join-requests` answers the whole queue to a `ManageScenes` holder and only the caller's own
rows to anybody else, so a player can see that their request is still pending without being told who
else asked.

Approve is add-participant plus the system message plus the row transition, in one call. Deny takes
an optional reason and leaves the character free to ask again.

Refusals follow the existing `{error, message}` shape: `scene_not_open`, `scene_concluded`,
`scene_join_not_visible`, `persona_not_usable`, `persona_already_in_scene` (409),
`join_request_exists` (409), `join_request_not_pending` (409), `scene_visibility_conflict`.

## D. Guild: the send gate

`ResolvePersonaForSendHandler` already runs on every send with the user and the channel, and can
answer `IsAllowed: false` with a sentence. The gate goes at the end of it, after the existing
resolution, and fires only for `ChannelType.Scene` with `JoinPolicy = Ask`:

```
resolved a persona that is in the cast   -> allow
anything else                            -> allow only with ManageScenes
```

"Anything else" covers both a character outside the cast and a plain message with no character at
all, which is what makes a closed scene actually closed. It keys on the scene channel only, so the
OOC companion thread is untouched and stays open to everyone who can see the scene.

The open-scene half is in `MessageCreatedHandler`, beside the existing `AdvanceOnPostAsync`: a
persona that spoke in an open, non-concluded scene and is not in the cast is appended to the cast and
the rotation, and the join system message is written. Doing it there rather than in the send path
means the join lands after the message that caused it, in the order a reader expects.

## E. Guild: realtime and inbox

`guild.SceneUpdated` gains `joinPolicy` and `visibility`. It already carries the cast and the status,
so a client that follows it has everything the access rules need.

Two new events, both addressed the way the nudge escalation is:

- `guild.SceneJoinRequested` to `ManageScenes` holders: `guildId, channelId, requestId, personaId`,
  the character's display fields, `requestedByUserId`, `note`, `createdAt`.
- `guild.SceneJoinRequestResolved` to the requester and to `ManageScenes` holders: `guildId,
  channelId, requestId, status, decisionReason, decidedByUserId`.

There is no visibility-changed event. `guild.SceneUpdated` carries the new value, and a client that
can no longer satisfy the predicate drops the scene itself. One rule, evaluated in one place on the
client.

Two `InboxTaskKind` members, both following `PersonaReview` and `PersonaChangesRequested` exactly,
including the dismissal rows and the per-feature visibility filter:

- `SceneJoinRequest`, gated on `Scenes` and `ManageScenes`.
- `SceneJoinDenied`, for the player, carrying the reason.

## F. Messaging: the system messages

Two new `MessageType` members, `SceneCharacterJoined` and `SceneCharacterLeft`, written through the
`CreateMessageCommand` path `DiceEndpoint` already uses. Authored by the real account with
`PersonaId`, `AuthorDisplayName` and `AuthorAvatarUrl` set from the character, and `Content` empty,
or `removed` when a GM took the character out rather than the player leaving. That mirrors
`GroupIconChanged`, which distinguishes its two cases the same way, and avoids a third message type
for a one-word difference.

The display fields are denormalised onto the message on purpose. A character renamed a year later
still reads correctly at the point in the log where it walked in, which is the rule persona messages
already follow.

## G. Client: wire shapes and the service

`scene.dto.ts` gains the two enums and puts `joinPolicy` and `visibility` on `SceneDto`,
`SceneListItemDto`, `SceneCreatedDto` and `SceneUpdatedDto`, plus a `SceneJoinRequestDto` and the
two new event shapes. `scene.dto.ts` (request) gains `JoinSceneDto`, `CreateJoinRequestDto` and
`DenyJoinRequestDto`, and `CreateSceneDto` and `UpdateSceneDto` gain the two fields.

`RoleplayApi` gains `join`, `leave`, `requestJoin`, `listJoinRequests`, `approveJoinRequest`,
`denyJoinRequest`, `withdrawJoinRequest` and `listGuildJoinRequests`.

`SceneService` gains a `requestsByScene` signal fed by the two events and by the read, plus:

```
canSeeScene(guildId, scene)  // visibility Everyone, or canManage, or the cast intersects speakableIds
pendingRequests(channelId)   // the GM banner
myRequest(channelId)         // the caller's own pending or denied row, for the composer strip
```

`canSeeScene` is the single client predicate. The board, the archive, the folder rail and the thread
list all filter through it, so a scene going private disappears from four surfaces on one event.

## H. Client: the composer strip

`SceneTurnPrompt` is about turns and stays that way. The composer takes a second input,
`sceneJoin: SceneJoinPrompt | null`, rendered in the same slot:

```ts
interface SceneJoinPrompt {
    state: 'open' | 'ask' | 'pending' | 'denied';
    /** The reason a GM gave, for 'denied'. */
    reason: string | null;
    open: () => void;
}
```

The two inputs are mutually exclusive by construction: a reader who is not in the cast has no turn,
and a reader who is in the cast has nothing to join. `channel-conversation.component.ts` computes
`sceneJoin` beside the existing `sceneTurn`, and when the reader is outside the cast the join strip
replaces the quiet "waiting on Kaelen" strip rather than stacking with it. The actionable notice
wins the slot.

Copy, from the mockup: "Bring your character here" with a Choose button when the policy is Open,
"Ask the GM to bring a character in" when it is Ask, "Waiting on the GM" with a Withdraw action while
a request is pending, and the reason when one was denied.

## I. Client: the bring-in dialog

New `scene-join-dialog` component under `features/guild/scenes/`, `p-dialog`, OnPush, signals.

Rows come from `personas.cast(guildId)` filtered through `canSpeakAs` and minus the scene's current
cast, sorted by `sortPersonas` and searched with `matchesPersonaQuery`. Avatars are
`app-avatar` through `PersonaAvatarComponent`. Nothing here re-implements a persona list.

Under the selection, one line saying what will happen: the character joins the cast and takes the
last turn, after whoever is currently last. When the scene is closed the same dialog grows a note
field and the confirm button reads "Ask to join".

## J. Client: the GM banner

In `scene-header.component.html`, above the stalled banner and under the same `canManage()` guard.
One row per pending request: avatar, character name, the note, Approve, Deny. Deny opens a
`p-popover` with the optional reason and a confirm, because a modal for one line is heavy.

`scene-header.component.ts` has no spec file. Characterization tests come first, green against the
current component, before anything moves.

## K. Client: the access preset

`scene-dialog.component` gains a "Who plays here" block of three `p-radiobutton` rows:

| Preset | joinPolicy | visibility | Line under it |
|---|---|---|---|
| Open table | Open | Everyone | Anyone can read it, anyone can bring a character in. |
| Ask to join | Ask | Everyone | Anyone can read it. Getting a character in needs your yes. |
| Private table | Ask | Cast | Only the cast and the GMs can see the scene at all. |

Because the server refuses the fourth pair, the picker can always name what a scene is set to, and
there is no custom row to explain away. Editing an existing scene shows the same block seeded from
the scene.

The board and archive rows get a lock chip on a private scene. There is no join affordance on the
board: the scene is where you decide to play in it.

## L. i18n

New keys under `SCENE.ACCESS.*`, `SCENE.JOIN.*` and `SCENE.REQUEST.*`, plus
`MESSAGE.SYSTEM.SCENE_CHARACTER_JOINED` and `MESSAGE.SYSTEM.SCENE_CHARACTER_LEFT` with a removed
variant. The locales repo is a submodule and takes its own commit.

## M. Tests

Backend:

- `SceneVisibilityCache` over the four branches, including a shared guild persona whose second player
  can see a private scene.
- The list route drops a private scene, the get route refuses it, and `FilterUsersWithChannelPermissionAsync`
  drops a non-cast member so the fan-out test proves messages do not leave.
- The send gate: cast passes, non-cast character refused, plain message refused, `ManageScenes`
  passes, and the OOC thread accepts all four.
- The request state machine, the partial unique index, and re-asking after a denial.
- `scene_visibility_conflict` on both create and patch.
- Auto-join on a post in an open scene, and no auto-join in a closed or concluded one.

Client:

- Characterization tests for `scene-header` before it is touched.
- `canSeeScene` over the same four branches.
- The composer renders the join strip instead of the waiting strip for a non-cast reader, and the
  turn strip for a cast one.
- The preset picker maps both ways, including seeding from an existing scene.

Two standing traps apply. A new spec file changes how Vitest batches, so an unrelated failure after
adding one is usually that and not the change. No `readonly x = SOME_IMPORTED_CONST` class fields.

## N. Build order

1. Model, migration, the two fields on create and patch, the conflict refusal, the preset picker.
   Nothing is enforced yet and every existing scene keeps behaving as it does.
2. `SceneVisibilityCache` and the six call sites, plus `canSeeScene` and the four client surfaces.
3. Joining an open scene: the route, auto-join on post, the system messages, the composer strip and
   the dialog.
4. Requests: the entity, the routes, the two events, the GM banner, the two inbox kinds.
5. Locale commit, and the backend half mirrored into `Echo/docs/specs` as a frontend guide.

Each phase is shippable. Phase 2 is the one with a blast radius: it touches the permission service
every read in the product goes through, and its tests are the ones to write first.

## Open risks

The visibility check adds a lookup to the hottest path in Guild. It is a dictionary hit against a map
that is empty in a guild with no private scenes, and every input is already cached, but it is still a
new thing on that path and phase 2 should be measured rather than assumed.

Auto-join on a post is the one behaviour here that nobody asked for. It is what stops the cast being
fiction in an open scene, but it means a misfired proxy tag can put a character in a game. Leaving is
one click and writes its own line in the log.
