# Entitlements and degradation: what the client needs from WP-09

Written from Alpine, before the contract exists, so that the contract is right the first time.

Echo's monetization design is `docs/specs/monetization.md` in the Echo repo; the execution plan is
`docs/specs/monetization-implementation-plan.md`. **WP-09 (Degradation surfacing)** owns
`Echo/Dtos/Entitlements/*` and a new `docs/specs/entitlements-frontend-guide.md`.
This document is the input to that guide. It is not a design for the client and it does not describe
anything that exists.

Status: nothing below is implemented on either side. `Echo.Entitlements` exists as a pure-domain
library (WP-01); no endpoint, no event and no client code does.

---

## 1. The rule this has to satisfy

Alpine already has a written rule for capabilities the app does not have, in
`src/app/platform/capabilities.ts`:

> - A control that cannot work is **hidden** when its absence needs no explanation.
> - It is **disabled with a one-line reason** when a user would go looking for it.
> - No control is ever left enabled over a no-op.

Spec section 3.3 adds a fourth case that rule does not cover, and it is the hard one: a control that
**works, but produced less than it was asked for**. A denial is a support ticket; a silent
degradation is a bug report. The client can only tell the difference if the server says so on the
successful response, which is the single largest ask in this document (section 3).

Every requirement below exists to keep the client from inventing copy, inventing policy, or guessing
which of two parties can fix a thing.

---

## 2. What the client looks like today

Full inventory in section 9. The summary is that **there is no limit-shaped UI anywhere in Alpine**,
and almost every path a limit will land on currently swallows its failure.

- No plan, tier, quota, entitlement, billing, usage or upgrade surface exists in `src/`.
- Voice join failure logs to console and leaves the joined-state signals set (section 9, and the bug
  in section 11).
- Every camera and screenshare publish failure is `catch { return null }` with no toast.
- Exactly one upload path validates size client-side (guild icon, 8 MB).
- Emoji settings render a bare count with a comment saying there is deliberately no denominator.
- The audit log pages by `skip`/`take` with no date concept at all.
- Guild modules are a client-side table of 22 names with two states, present and absent.

So none of this is "add a number to an existing meter". Every surface is new UI, which is an argument
for getting the payload right rather than shipping something the client has to reshape.

---

## 3. Requirement A: the degradation payload

### 3.1 A degradation is a 200, and it rides the normal response

**This is the decision that everything else depends on.**

If a degraded voice join answers `200` with the reduced room and nothing else, the client cannot
distinguish it from a normal join and "degrade, do not deny" is invisible to the user - which is the
same outcome as not building it. If it answers `4xx`, every existing client call path treats it as a
failed join and rolls back, which is a denial with extra steps.

So: **the degraded case is a `200` (or `201`, as the operation dictates) carrying its normal body,
plus a `degradations` array.** Absent or empty means nothing was reduced.

```jsonc
{
  // ... the normal response body, unchanged and complete ...
  "degradations": [
    {
      "key": "voice.video_ceiling",
      "requested": { "kind": "ladder", "rung": "1080p60", "rank": 4 },
      "granted":   { "kind": "ladder", "rung": "720p30",  "rank": 2 },
      "reason": "guild_plan_limit",
      "boundBy": "guild",
      "remedy": "upgrade_guild",
      "actorCanRemedy": false,
      "subjectId": "guild-1"
    }
  ]
}
```

`degradations` must be additive on existing v1 responses, which the plan already requires.

It has to be **on the response the caller already holds**, not somewhere the caller has to go and
look. Alpine has no interceptor that maps error bodies to messages and no global toast-on-error: by
convention services rethrow and the **component call site** surfaces the failure with a feature-scoped
`*_FAILED` key. A degradation delivered anywhere other than the response of the action that caused it
has no call site to be rendered at.

### 3.2 Values must be typed objects, never `long.MaxValue`

`EntitlementValue.Unlimited` is `long.MaxValue` = `9223372036854775807`. That is larger than
JavaScript's `Number.MAX_SAFE_INTEGER` (`9007199254740991`). `JSON.parse` silently returns
`9223372036854775808`, every equality check against a known sentinel fails, and any client that
round-trips the number sends back a different one.

**Numeric limits must never appear on the wire as `long.MaxValue`.** Nor as `-1`, which is a second
sentinel to forget about.

```jsonc
{ "kind": "numeric", "value": 26214400, "unlimited": false }
{ "kind": "numeric", "value": null,     "unlimited": true  }
{ "kind": "flag",    "granted": true }
{ "kind": "ladder",  "rung": "720p30", "rank": 2 }
```

`EntitlementKey.Format` already produces `"unlimited"` for this case, so the string form is available
if a flat shape is preferred. The typed object is better because the client needs the number for
arithmetic (a progress meter, "your file is 40 MB, the limit is 25 MB") and parsing `"unlimited"`
out of a string at every call site is how one call site forgets.

`requested` and `granted` must be the same shape as each other and as the key's declared kind.
Alpine has **no shared byte-formatting helper** today (two private duplicates exist, in
`update-dialog.component.ts` and `receipt-gallery.component.ts`); the client will add one, but that
is only possible if the wire carries a number.

### 3.3 Reason and remedy are two different fields

`EntitlementDegradationReason` today has four members: `GuildPlanLimit`, `UserPlanLimit`,
`PairedCeiling`, `OperatorCeiling`. That is **which side bound**, and it is not the same question as
**who can fix it**, which is what decides the button.

| Reason | Who can fix it | Button the client should draw |
|---|---|---|
| `guild_plan_limit` | the guild owner, or a member with `ManageGuild` | "Upgrade this server" if the viewer can, otherwise a sentence with no button |
| `user_plan_limit` | the viewer themselves | "Upgrade your account" |
| `paired_ceiling` | **depends on which side is lower**, and the payload does not say | undecidable today |
| `operator_ceiling` | nobody | no button, ever - and the server's own comment says so |

The client cannot derive the "who" column. It would have to re-evaluate `ManageGuild` for the viewer
(`memberCanManageGuild` in `src/app/features/guild/guild-permissions.ts`, which needs a member fetch),
know whether the instance sells anything at all, and know whether the guild already has the plan that
would fix it. All three are server knowledge.

**Requirements:**

1. Keep `reason` as the honest explanation. It is what the copy is keyed on.
2. Add `remedy`: `"upgrade_guild" | "upgrade_user" | "none"`. It is what the button is keyed on.
3. Add `actorCanRemedy`: whether **this caller** can perform that remedy. A member in a free guild
   gets `remedy: "upgrade_guild"`, `actorCanRemedy: false`, and the client draws an explanation with
   no button rather than a button that 403s.
4. **`paired_ceiling` must never be emitted without `boundBy: "guild" | "user"`.** Without it the
   client either shows both buttons or neither, and the reason `PairedCeiling` exists at all is that
   telling a paying Venta Plus member their own plan limited them "would read as a bug they had paid
   to avoid" - the payload has to be able to avoid that in the other direction too.
5. `operator_ceiling` must be safe to render on a self-hosted instance with no billing at all. It
   implies `remedy: "none"`.

### 3.4 Hard denials use the same vocabulary

Spec 3.3 reserves hard denials for the 51st emoji, the oversized upload and the 6th bot. Those are
still entitlement events and the user-facing sentence is nearly identical, so **they must carry the
same `key` / `requested` / `granted` / `reason` / `remedy` fields**, in the error body, under the same
field names. If a denial invents a second shape the client writes the same copy twice and the two
drift.

Alpine's established machine-readable-refusal precedent is `src/app/core/refusal-message.ts` plus
`PRIVACY_REFUSAL_CODES` in `src/app/models/privacy-settings.model.ts`: a `403` with a stable snake_case
code, mapped to a translation key and a `retryable` boolean. An entitlement denial should read the
same way from the client's side.

### 3.5 Status codes: two traps

- **Never `429`.** `src/app/interceptors/rate-limit-interceptor.ts` is registered globally and
  retries any `429` up to three times with backoff before handing the error on. An entitlement
  rejection sent as `429` would be silently retried three times, delayed by up to 30 seconds, and then
  surface as a generic error with the body long gone from the user's attention.
- **Never `401`.** `src/app/interceptors/logout-interceptor.ts` calls `OAuthService.logOut()` and
  navigates to `/authentication` on any `401`. An entitlement rejection sent as `401` signs the user
  out.

`402 Payment Required` or `403` are both fine. `403` matches the existing refusal precedent and is
already understood by the interceptor stack; `402` is more precise and equally safe. Pick one and use
it everywhere - the client will branch on the body code, not the status, but it needs the status to be
stable enough to know a body is worth reading.

Whatever is chosen, the code field must have **one name**. `refusalCode()` in
`src/app/services/privacy-settings.service.ts` currently sniffs four (`error`, `code`, `errorCode`,
`detail`) because the server is inconsistent today. Do not add a fifth.

---

## 4. Requirement B: delivery, and the cache

### 4.1 The answer is "all three", split by cost

Not one mechanism. Three, with a clear rule for which:

| Mechanism | Carries | Why |
|---|---|---|
| **Snapshot on connect** | the **user's own** resolved set, and the license mode | It is small, fixed-size (three user-scoped keys plus the paired ones), needed before the first upload picker opens, and needed to decide whether billing UI exists at all |
| **Per-subject fetch** | one **guild's** resolved set | A user can be in hundreds of guilds. Pushing every guild's set on connect is a payload proportional to guild count for data that is read when a settings screen opens |
| **Push on change** | an envelope, not the values | Rare event; the client refetches what it actually has open |
| **Inline on the operation** | `degradations[]` | Section 3. This is the only one that is load-bearing for correctness |

**The inline one is the one that matters.** The other three are conveniences that let the UI
pre-empt a limit; the inline one is what makes a limit explicable after the fact. If WP-09 ships only
one thing, ship section 3.

### 4.2 The snapshot

`GET /api/v1/entitlements/me` returning the caller's own resolved set, plus:

```jsonc
{
  "licenseMode": "hosted",          // or "selfhost" - see 4.5
  "subject": { "kind": "user", "id": "user-1" },
  "resolvedAt": "2026-08-14T10:00:00Z",
  "version": 7,
  "ttlSeconds": 300,
  "entitlements": {
    "user.upload_max_bytes": { "kind": "numeric", "value": 26214400, "unlimited": false },
    "user.max_devices":      { "kind": "numeric", "value": 5,        "unlimited": false },
    "voice.video_ceiling":   { "kind": "ladder",  "rung": "1080p30", "rank": 3 }
  },
  "ladders": {
    "video_quality": ["none", "480p30", "720p30", "1080p30", "1080p60"]
  }
}
```

`GET /api/v1/entitlements/guilds/{guildId}` returns the same shape for a guild subject.

**`ladders` is not optional.** See section 6.2: without the rung order on the wire, the client cannot
clamp its own quality picker, and hardcoding a copy of the ladder in the client is exactly the
duplicated-table problem `EntitlementKeys` was built to avoid.

**Provenance is deliberately not in this payload.** It is staff-facing (spec section 6, WP-12) and
belongs in the admin console. A member does not need to be told a Stripe subscription id, and
including it makes the response a data-exposure question rather than a rendering one.

### 4.3 Cache invalidation, and why it is harder here than it looks

Alpine is a **multi-instance, multi-account client**. `ApiConfigService.baseUrl` is a signal set at
runtime from a user-entered domain (`src/app/services/api-config.service.ts`), and
`AccountSwitchService` re-enters the app as a different account without a process restart
(`src/app/services/account-switch.service.ts`). A cache keyed on subject id alone will show one
account's limits to another and one instance's plans on a different instance.

**Cache key must be `(baseUrl, accountId, subjectKind, subjectId)`.** That is a client-side
obligation, but the payload has to make it possible, which means it must echo its own subject
(`subject` above) so a late response cannot be filed against the subject the user has since switched
to.

The invalidation triggers the client will implement, and what the payload must support:

| Trigger | Needs from the payload |
|---|---|
| `entitlements.Changed` push | the envelope (4.4) |
| hub reconnect | nothing - refetch unconditionally |
| account switch, instance switch | `subject`, so a stale in-flight response is discarded |
| app resume from background | `resolvedAt` + `ttlSeconds` |
| opening a guild settings screen | per-subject fetch |

`ttlSeconds` must be **shorter than or equal to** the resolver's own Redis TTL backstop (WP-13). If
the client caches longer than the server, a dropped invalidation event that the server self-heals from
stays broken on the client, and the backstop that WP-13 exists to provide is defeated one layer up.

**The client will never cache an entitlement set to disk.** A stale plan read from disk at cold start
would show the wrong limits before the first fetch lands, and "your server was downgraded" is not a
thing to say by accident. The guild layout cache (`guild-layout-cache.ts`) is the precedent for what
*is* safe to persist; this is not that.

### 4.4 The push event

Hub event, on the existing single connection (`/api/v1/ws/hub`, owned by
`src/app/services/realtime-connection.service.ts`). Names are domain-prefixed by convention
(`conversation.*`, `guild.*`, `call.*`, `status.*`), so:

```
entitlements.Changed   { subjectKind, subjectId, version, changedKeys: ["voice.max_participants"] }
```

**Send the envelope, not the values.** Two reasons. A guild plan change fans out to every online
member, and a full set per member is a payload multiplier for data most of them will not read. And
delivery is unordered, so a full set can arrive stale and overwrite a newer one - `version` plus a
refetch is monotonic, a pushed value is not.

`changedKeys` is advisory: it lets a client that has nothing relevant open skip the refetch entirely.
A client must behave correctly if it is absent.

**Route it to the right people.** A guild plan change goes to that guild's members; a user plan change
goes to that user's devices only. A user's Venta Plus state is not the guild's business.

### 4.5 License mode

Alpine can be pointed at any instance, including a self-hosted one where `Billing.*` is not deployed
and every key resolves to maximum. **The client must be told which**, or a self-hoster sees upgrade
buttons for a product that does not exist. Spec section 8.8 says the same thing about credit wallets:
hide the surface entirely rather than showing an infinite balance, because both readings look like a
bug.

`licenseMode` on the snapshot is the minimum. If there is already an instance-capability document
served at the gateway, it belongs there instead and the snapshot should not duplicate it - but it has
to be somewhere the client reads before it draws a settings nav.

The client's plan: `billing` in `SETTINGS_NAV_GROUPS` and a plan section in `buildGuildNavGroups` are
**omitted from the nav table** when `licenseMode === "selfhost"`, matching the house rule that a
household never sees a Bans tab it cannot press
(`guild-settings-modal.component.ts`). Hidden, not disabled, because the absence needs no explanation.

---

## 5. Requirement C: which surfaces need realtime

Refresh-on-navigate is the default and is correct almost everywhere. Entitlement changes are rare
(a purchase, a grant, an expiry) and every screen that shows a limit is a screen the user just opened.

**Two exceptions, and only two.**

### 5.1 Voice, and it must ride the existing version stream

A voice room's effective limits can change *during* a call: a boost lapses, a grant expires, a plan
downgrades at period end. The room is the one surface where the user is looking at it when it changes.

**Do not add a second event for this.** The voice client already has snapshot versioning, gap
detection and a resync path (`docs/specs/voice-frontend-guide.md` section 4.2, implemented in
`VoiceRoomTracker` in `src/app/models/voice-room.ts`). A parallel `entitlements.Changed` carrying room
limits would race the snapshot stream, and the client has no way to order the two. It would reproduce
exactly the bug the version mechanism exists to prevent.

**Requirement: put the room's effective limits on the voice snapshot**, version-gated like everything
else on it, and let a change to them advance the version:

```jsonc
{
  "roomId": "channel-123",
  "instanceId": "...",
  "version": 43,
  "participants": [ ... ],
  "limits": {
    "maxParticipants": { "kind": "numeric", "value": 10, "unlimited": false },
    "videoCeiling":    { "kind": "ladder",  "rung": "720p30", "rank": 2 },
    "maxPublishers":   { "kind": "numeric", "value": 2, "unlimited": false },
    "publisherCount": 2
  }
}
```

`publisherCount` is room state, not entitlement state, and the client has no concept of it today. It
is needed for the same reason a slot count is: "2 of 2 people are sharing" is a sentence, "you cannot
share" is a mystery.

### 5.2 The guild plan badge, if one is drawn

If a member buys a boost and the guild crosses a threshold, the effect should be visible without a
reload. `entitlements.Changed` plus a refetch covers this; it does not need its own channel.

### 5.3 Everything else is refresh-on-navigate

Upload ceilings, emoji slots, bot slots, audit window, storage quota. All are read when a screen
opens. None of them need to be live, and making them live buys nothing but invalidation bugs.

---

## 6. Requirement D: i18n

### 6.1 The convention, and the guard's actual coverage

Alpine uses **ngx-translate** with a **flat** `Record<string, string>` in
`src/assets/i18n/locales/en.json` (about 3,200 keys). Keys are `SCREAMING.DOT.CASE`, feature-prefixed,
interpolated as `{{name}}`. `de.json` and `fr.json` are deliberately partial and fall back to English.

`src/app/i18n-keys.spec.ts` asserts that every key used in the app resolves in `en.json`, because a
missing key does not fail or warn - ngx-translate renders the key itself, so the user reads
`CALL.CONNECTED_COUNT` where a sentence should be.

**Read the guard's regex before assuming it covers this:**

```ts
const STATIC_KEY = /'([A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+)'\s*\|\s*translate/g;
```

It matches a **literal followed by `| translate`**. Two consequences that WP-09's guide should know
about, because they shape what the client can safely do with a server-supplied code:

1. A computed key (`'ENTITLEMENT.REASON.' + code`) matches nothing and is **not** guarded. A server
   code with no matching entry renders raw to the user with every test green.
2. Keys held in a lookup table and piped through a variable - which is how `refusal-message.ts`
   already works - are **also not** guarded today.

So the client will hold an exhaustive `Record<ReasonCode, string>` table with literal values and add
its own spec asserting every entry resolves. That is client work and needs nothing from the server -
**except the one thing it cannot supply itself.**

### 6.2 What WP-09 must guarantee for this to work

1. **The reason-code set is closed, enumerated in the guide, and stable.** A code is a translation key
   in three clients and four locale files. Renaming one is a coordinated release, not a refactor. Say
   so in the guide the way `EntitlementLadder` already says it about rung names.
2. **snake_case on the wire**, matching `PRIVACY_REFUSAL_CODES`, not the C# enum's PascalCase. One
   convention per repo.
3. **A documented fallback rule for an unrecognised code.** A client built before a new code exists
   must render something honest. The rule should be: render the generic
   `ENTITLEMENT.REASON.UNKNOWN` sentence and **suppress the button entirely**, because a remedy the
   client does not understand is a remedy it should not offer. The same applies to an unknown `remedy`
   value.
4. **An open union on the wire is fine; an open union in the copy is not.** Alpine's DTO convention
   for extensible server enums is `'Known' | 'Other' | (string & {})` - see `InboxTaskKind` in
   `src/app/dtos/response/inbox.dto.ts`, which is renderable without recognising the kind because the
   server writes the title. Entitlement reasons are the opposite case: the client writes the copy, so
   an unrecognised code has no rendering. Hence rule 3.
5. **The server never writes user-facing copy for a degradation.** `EntitlementDegradation.Detail` is
   already documented as admin-console-only and must stay that way. Contrast the status page, where
   the server *does* write the sentence (`status-frontend-guide.md` section 1) for a reason that does
   not apply here: an outage notice must not be machine-translated, whereas "this server is on the
   free plan" must be.

### 6.3 Keys the client will need

Reason and remedy, one per enumerated code plus the fallbacks:

```
ENTITLEMENT.REASON.GUILD_PLAN_LIMIT
ENTITLEMENT.REASON.USER_PLAN_LIMIT
ENTITLEMENT.REASON.PAIRED_CEILING_GUILD
ENTITLEMENT.REASON.PAIRED_CEILING_USER
ENTITLEMENT.REASON.OPERATOR_CEILING
ENTITLEMENT.REASON.UNKNOWN
ENTITLEMENT.CTA.UPGRADE_SERVER
ENTITLEMENT.CTA.UPGRADE_ACCOUNT
ENTITLEMENT.CTA.ASK_OWNER
ENTITLEMENT.CTA.LEARN_MORE
```

Note `PAIRED_CEILING` splits into two keys, driven by `boundBy`. That is section 3.3's requirement
showing up as a translation key, which is the cheapest possible proof that the field is needed.

One display name per catalogue key, so a degradation can be named in a sentence without the client
switching on eleven strings in every component:

```
ENTITLEMENT.KEY.VOICE_MAX_PARTICIPANTS
ENTITLEMENT.KEY.VOICE_VIDEO_CEILING
ENTITLEMENT.KEY.VOICE_MAX_PUBLISHERS
ENTITLEMENT.KEY.STORAGE_UPLOAD_MAX_BYTES
ENTITLEMENT.KEY.STORAGE_GUILD_QUOTA_BYTES
ENTITLEMENT.KEY.GUILD_EMOJI_SLOTS
ENTITLEMENT.KEY.GUILD_BOTS_INSTALLED
ENTITLEMENT.KEY.GUILD_VANITY_URL
ENTITLEMENT.KEY.GUILD_AUDIT_LOG_DAYS
ENTITLEMENT.KEY.USER_UPLOAD_MAX_BYTES
ENTITLEMENT.KEY.USER_MAX_DEVICES
```

Surface copy, where the sentence is specific enough that a generic one would be worse:

```
VOICE.DEGRADED.AUDIO_ONLY
VOICE.DEGRADED.QUALITY_CAPPED
VOICE.DEGRADED.PUBLISHERS_FULL
VOICE.DEGRADED.ROOM_AT_LIMIT
COMPOSER.UPLOAD_TOO_LARGE
GUILD_SETTINGS.EMOJIS.SLOTS            "{{count}} of {{max}}"
GUILD_SETTINGS.EMOJIS.SLOTS_FULL
GUILD_SETTINGS.AUDIT_LOG.WINDOW_END
GUILD_SETTINGS.MODULES.NOT_IN_PLAN
GUILD_SETTINGS.STORAGE.USED
BOT_INSTALL.SLOTS_FULL
```

Plus, per module screen, a third member of the existing two-member empty-state family (section 8.1):

```
<MODULE>.NOT_IN_PLAN_TITLE
<MODULE>.NOT_IN_PLAN_BODY
```

alongside the `MODULE_OFF_TITLE` / `MODULE_OFF_BODY` / `FORBIDDEN_TITLE` / `FORBIDDEN_BODY` pairs
every module already ships.

`RECEIPTS.LIMIT` (`"{{count}} of {{max}}"`) is the existing X-of-Y precedent to copy. Key depth in
`en.json` is two or three segments as a rule and four at the absolute ceiling, so nothing above
should grow another level.

---

## 7. Requirement E: ceilings and consumption are two different payloads

An entitlement set says a guild has 50 emoji slots. It does not say 47 are used. **Every "X of Y" UI
in section 9 needs both numbers, and they have opposite caching properties**: a ceiling changes when
someone buys something, and consumption changes when anyone uploads anything.

Putting `used` in the entitlement set makes the set uncacheable and turns the resolver into a counting
service. Requirement: a separate `GET /api/v1/guilds/{id}/usage` (or equivalent) returning current
consumption for the countable keys, cached independently and free to be stale.

This is not a nicety. Without it the emoji page can render "50 slots" and nothing else, which is worse
than the bare count it renders today.

---

## 8. The tier table with no client representation

Spec section 3.5, row by row, from the client's side.

| Lever | Client status | What is missing |
|---|---|---|
| Voice room participants | No capacity concept exists. `ChannelDto` has no `userLimit`; the snapshot has no max; no "full" string exists in any locale file | Section 5.1's `limits` block |
| Video / screenshare ceiling | **The ladders do not line up.** Server rungs are `none, 480p30, 720p30, 1080p30, 1080p60`. The client picker offers `720p / 1080p / 1440p / source` x `15 / 30 / 60` (`src/app/models/stream-preset.ts`) - twelve combinations, of which `1440p`, `source` and every 15 fps option have **no rung**, and `480p30` has no client option | The mapping from (resolution, framerate) to rung is **policy and must be the server's**. Either publish the mapping, or extend the ladder to cover what clients can actually produce. The client must not invent it: guessing that `1440p30` clamps to `1080p30` is a pricing decision |
| Concurrent video publishers | No concept at all. The tile grid is unbounded above 10 | `publisherCount` alongside the cap (5.1) |
| Upload size | One 8 MB check on guild icons; nothing anywhere else | Section 3 plus a shared bytes formatter (client work) |
| Guild storage | **Nothing.** No usage, quota, or space-used UI anywhere in the app | Section 7's usage endpoint, and a new screen |
| Message history retention | Nothing, correctly | The guide should **state explicitly that retention is unlimited on every tier and always will be**, so nobody builds a retention warning that then has to be un-built. This is a deliberate decision in the spec and it deserves to be written where a client author will read it |
| Audit log window | Offset paged (`skip`/`take`, `TAKE = 50`), infinite scroll, **no date concept whatsoever**. `hasMore` is `entries.length === TAKE` | The client will page into the end of the window and render "no more entries", which reads as "your server has no history". The response needs a **`windowEndsAt`** and a distinct "this is the edge of your plan's window, not the edge of the data" signal. Without it the degradation is invisible and indistinguishable from an empty log |
| Custom emoji | Bare count, with a code comment saying there is deliberately no denominator because no cap exists | Slots plus used (section 7) |
| Bots installed | **There is no installed-bot list, integrations page, or applications screen in Alpine at all.** Install is a one-shot OAuth consent dialog | A count cannot be shown against a list that does not exist. This is a whole screen, and it is a prerequisite for the lever being visible |
| Vanity invite / custom domain | No component, service, DTO or i18n key. `guild.vanity_url` defaults to `false` and the key's own comment says that means "the capability does not exist yet", not "not entitled" | The guide must say which of the two a `false` means at the time it ships, or the client renders a locked upsell for a feature nobody built |
| Guild modules | Client-side table of **22** feature names (`src/app/features/guild/guild-features.ts`); the tier table names **two**. Two states only, present and absent - and disabled modules are **removed from the nav, not disabled**, by explicit house rule | Which of the 22 are in the "core set" is undefined. Needs a server-sent list of plan-included features and a **third** unusable-reason, which the module screens do not have - see 8.1. Today an out-of-plan toggle would flip, 403, and silently revert with a generic toast |
| Venta Plus cosmetics (animated avatar, banner, badge) | Not in the key catalogue at all | Either add keys or say they are not entitlement-gated |
| Venta Plus device count | `user.max_devices` exists as a key; the devices settings page shows no cap | Section 7 |
| Boosts | No representation anywhere | Out of scope for WP-09, but the degradation `remedy` vocabulary should leave room for `"boost_guild"` rather than being closed at three values |

### 8.1 A module now has three reasons to be unusable, and the client only knows two

Every household and community module screen already renders two mutually exclusive empty states, and
the code comments are explicit that conflating them is the bug:

```html
@if (!moduleEnabled()) { ... 'CHORES.MODULE_OFF_TITLE' / MODULE_OFF_BODY ... }
@else if (forbidden())  { ... 'CHORES.FORBIDDEN_TITLE' / FORBIDDEN_BODY ... }
```

`ChoreService` keeps `forbidden` as a field **separate from `error`** for exactly this reason
(`src/app/services/chore.service.ts`), because "the module is off" and "you cannot see this" are
different sentences and one of them is not an error.

WP-08 introduces a third: **the module exists, is switched on, you have the permission, and the plan
does not include it.** It arrives through the existing `DisabledPermissions` path, which means it
reaches the client looking **identical to a 403**. The client will render "you can't see this rota" at
a guild owner who can see it perfectly well and just needs to upgrade.

**Requirement: an out-of-plan refusal must be distinguishable from a permission refusal at the call
site**, by the code in the body, not by the client inferring it. The client will add
`NOT_IN_PLAN_TITLE` / `NOT_IN_PLAN_BODY` as a third member of that copy family, and it cannot pick
between the three without being told.

The same requirement applies to the `features` list itself. `GuildDto.features` is a comma-separated
string of names, and `parseGuildFeatures` deliberately keeps unknown names so a round trip is
lossless. If WP-08 clamps the list, a client that reads only the clamped list cannot tell "the owner
turned Forums off" from "Forums is not in this plan", and the modules page will render the toggle in
the off position with no explanation. **The plan-included set has to be a second list, not a
subtraction from the first.**

---

## 9. Hook-point inventory

Where a limit will bite, and what happens there today. All paths relative to
`C:\Users\Domin\WebstormProjects\Alpine\`.

### Voice

| Hook | File | Today |
|---|---|---|
| Guild voice join | `src/app/services/voice-channel.service.ts:442` (`joinChannel`), HTTP in `src/app/services/guild-voice.service.ts` | `catch { console.error }`. **No toast, no rollback.** Joined-state signals are set at line 454, before the request, and are not cleared on failure |
| Guild join callers | `channel-list.component.ts:463,478`, `voice-channel.component.ts:214,223,232`, `guild-member-list.component.ts:263`, `events-panel.component.ts:180`, `main-page.component.ts:416` | All fire-and-forget, none add handling |
| DM call create | `src/app/services/call-state.service.ts:173` | Overlay clears, ringback stops, **no message** |
| DM call accept / join ongoing | `call-state.service.ts:187,207` | Generic `"Could not join call - it may have ended"` |
| Media session create | `voice-rtc.service.ts:342`, `call-webrtc.service.ts:349` | Guild: `console.error`. DM: **unguarded `await`, unhandled rejection** |
| Camera publish | `voice-rtc.service.ts:871`, `call-session.service.ts:148` | `catch { return null }` / `catch { return }`, button springs back silently |
| Screenshare publish | `voice-rtc.service.ts:923,1075`, `call-session.service.ts:281` | `console.error`, silent no-op |
| Quality picker (pre-share) | `src/app/features/screen-picker/screen-picker.component.ts` | **Done.** Options still come from `RESOLUTION_LABELS` / `FRAMERATE_OPTIONS`, but each is disabled against `VoiceLimitsService.videoCeiling()`, and the restored preference is clamped as it is read |
| Quality picker (in call) | `src/app/shared/call/call-controls-bar/call-controls-bar.component.ts` | **Done.** Same treatment, via the `videoCeiling` input |
| Bitrate / resolution matrix | `src/app/models/stream-preset.ts:20,27,43` | `BITRATES`, `BOXES`, `DEFAULT_STREAM_PRESET = {1080p, 30}` |
| Fixed encoder caps | `src/app/services/webrtc-encoding.ts:4,6,8,16` | `VOICE_AUDIO_KBPS 64`, `STREAM_AUDIO_KBPS 128`, `CAMERA_KBPS 2500`, `MIN_BITRATE_RATIO 0.6`. **No simulcast anywhere** |
| Participant roster | `voice-channel-item.component.html:38`, `voice-channel.component.html:15`, `voice-channel-lobby.component.html:9` | Bare counts, no denominator |
| Tile grid | `call-screen-layout.component.ts:225-231` | UI-only thresholds, unbounded above 10 |
| Voice error vocabulary the client knows | `src/app/models/voice-room.ts:98-167` | `staleSubscription`, `sessionGone`, `session_error` only. Anything else falls to `console.error` |
| The one good precedent | `src/app/services/isle-proximity.service.ts:144-195` | Maps status + `refusalCode()` to a specific message. **This is the shape an entitlement refusal should copy** |

### Uploads

| Hook | File | Today |
|---|---|---|
| Message composer attach | `features/messaging/components/conversation/composer/composer.component.ts:276,280,397` -> `composer-attachments.service.ts:27` | **Zero validation** - no size, no type, no count. The `<input>` has no `accept` attribute |
| Upload transport | `src/app/services/file.service.ts:47` | `POST /api/v1/messaging/attachments`, then polls. **No status-code branching**; a 413 or 402 becomes a generic RxJS error |
| Composer failure UI | `attachment-previews.component.html`, `composer.component.ts:750` | Per-file error badge with no reason, plus one toast `COMPOSER.UPLOAD_FAILED` that cannot distinguish "too large" from "network died" |
| Guild icon | `guild-settings-modal/pages/overview-settings/overview-settings.component.ts:87,162` | **The only pre-flight size guard in the app**: `8 * 1024 * 1024`, with `ICON_HINT` = "PNG, JPG, GIF up to 8 MB" duplicating the number in a locale string. Checked on the **pre**-crop file, while the cropper emits PNG and can grow a small JPEG |
| User avatar / banner | `profile-settings.component.ts:184,248` -> `profile.service.ts:251,265` | No size check. Toast is a hardcoded English literal |
| Shared cropper | `src/app/components/image-cropper/image-cropper.component.ts:169-175` | Always re-encodes to PNG at 400x400 (avatar) / 1200x400 (banner) |
| Custom emoji | `emoji-settings.component.ts` -> `src/app/services/guild-emoji.service.ts:17` | MIME filter only, **no size cap, no slot cap**. Best-in-app rejection handling: `uploadErrorKey()` maps `409 -> NAME_TAKEN`, `413 -> TOO_LARGE`, else generic. A 402/403 falls to generic |
| Ledger receipts | `receipt-gallery.component.ts:48,95` -> `ledger-api.service.ts:159` | Count capped at 4 (`MAX_RECEIPTS_PER_EXPENSE`, mirrored from the server), **bytes uncapped** |
| Wiki article images | `wiki-article.component.ts:803,910` | Image-type check only. **Failure silently deletes the placeholder node with no feedback at all** |
| Notification sound | `notification-settings.component.ts:96` | `5 * 1024 * 1024`, hardcoded English error, local-only (data URL, never uploaded) |
| Storage used | nowhere | Does not exist |
| Bytes formatter | nowhere shared | Two private duplicates: `update-dialog.component.ts:16`, `receipt-gallery.component.ts:76` |

### Guild settings

| Hook | File | Today |
|---|---|---|
| Settings shell / nav | `features/guild/components/guild-settings-modal/guild-settings-modal.component.ts:81` (`buildGuildNavGroups`), `:199` (`access`) | A **function**, not a constant, because the nav is already feature-dependent. This is the single funnel a plan gate would use. `access` is a three-state `'checking' \| 'granted' \| 'denied'` - a good precedent for an entitlement tri-state |
| Emoji management | `pages/emoji-settings/`, `src/app/services/guild-emoji.service.ts`, `src/app/stores/guild-emoji.store.ts` | Count with no denominator, by explicit comment. Also calls both `ensureLoaded` and `getEmojis` on init - a redundant duplicate request |
| Bot installs | `features/bot-install/*`, `src/app/services/bot-install.service.ts` | **No installed-bot list and no integrations page exist.** Failure toast is a hardcoded English literal |
| Audit log | `pages/audit-log-settings/audit-log-settings.component.ts:179` -> `guild.service.ts:637` | `skip`/`take`, `TAKE = 50`, infinite scroll, no date range. Action and actor filters are **client-side over already-fetched pages only** |
| Vanity URL | nowhere | Does not exist |
| Modules toggles | `pages/modules-settings/`, `src/app/features/guild/guild-features.ts:10,49,64,215` | 22 client-side feature names, comma-separated on the wire in `GuildDto.features`. Toggle saves immediately and optimistically; failure reverts with a generic toast. Disabled modules are **removed from the nav, not disabled** |
| Guild kind | `guild.dto.ts:135`, `guild-features.ts:164` | Presentation only, explicitly never gates anything |
| Onboarding limits | `dtos/response/guild-safety.dto.ts:128` (`ONBOARDING_LIMITS`) | **The precedent for mirrored server caps**: 11 numbers, commented "server-enforced caps, mirrored", rendered as X-of-Y. This is the pattern that becomes server-driven |
| Name / description caps | `overview-settings.component.ts:81`, `templates-settings.component.ts:37` | `100` / `300`, rendered `{{length}}/{{limit}}` |
| Invite uses | `invites-settings.component.html:101` | Per-invite `maxUses`, not a guild quota |
| Guild data pattern | `src/app/services/guild.service.ts:159` | **There is no `guild.store.ts`.** `GuildService` holds `guilds = signal<readonly GuildDto[]>`. Settings pages take `guild` as an `input()` and do their own HTTP. `GuildDto.features` already rides this path, which makes it the natural carrier for a plan field |

### Admin

| Hook | File | Today |
|---|---|---|
| Admin modal | `features/admin/admin-modal/admin-modal.component.ts:32` (`ADMIN_NAV_GROUPS`) | One group, `ADMIN.NAV.FEDERATION`, two items. `labelKey` is a translation key by deliberate type design |
| Its gate | `self-profile-menu.component.ts:64` | `userService.self()?.userType === UserType.Admin` - a **profile claim**, not a per-request staff-tier resolution. See section 10 |

---

## 10. Where staff billing tools belong

**Not in Alpine's admin modal.** In the gateway-served console at `Echo/wwwroot/admin/`, which is
where WP-12 already places them.

1. **The trust model is wrong.** Alpine gates the modal on
   `userService.self()?.userType === UserType.Admin`, a claim on the profile the client already
   holds. Spec section 6 and WP-12 require staff tier resolved **per request** through `StaffAccess`,
   explicitly "not from a JWT claim", and require Admin-only grants with Moderator read-only. The
   modal has no tier concept at all, and a client-side boolean is not an access control - it decides
   what to *draw*, and the drawing is the only thing it can decide.
2. **The console already implements the split.** `Echo/wwwroot/admin/index.html` has
   `class="rail-item admin-only hidden"` on Federation, Product catalog and Audit log, with
   moderator-visible views alongside. It has an Accounts lookup, an audit log view, and host-gating at
   the gateway on `admin.<instance>`. Adding a Billing rail item is one entry; adding a tier system to
   Alpine is a project.
3. **Alpine is a multi-instance client, and that is disqualifying.** It can be pointed at any
   instance, including self-hosted ones where `Billing.*` is not deployed. Shipping staff billing
   tools inside the end-user desktop binary means every self-hoster ships a billing console for a
   service that does not exist, and the provenance screen - which shows Stripe subscription ids, grant
   reasons and staff ids - would be one `userType` bug away from a member.
4. **The provenance screen needs arbitrary-subject lookup, and Alpine's data layer cannot do it.**
   `GuildService.guilds` is *the caller's* guilds; `getOwnMember` is *the caller's* membership. Every
   store and cache in the app is scoped to "me and mine". "Show me every effective key for guild X and
   which source won it", for a guild the staff member is not in, is a different application sharing
   only a colour scheme.
5. **Release cadence.** A billing bug fixed in the gateway console deploys with the backend. The same
   fix in Alpine needs a Tauri build, a signed release and an update cycle, while the support ticket
   that needed it stays open.

**What does belong in Alpine** is the user-facing half: the current plan, the upgrade call to action,
credit balance and the plain-language ledger (spec section 8.8), and links out to Stripe's
`hosted_invoice_url`. Those go in `SETTINGS_NAV_GROUPS` under `SETTINGS.NAV.MY_ACCOUNT` and in
`buildGuildNavGroups`, both omitted entirely when `licenseMode === "selfhost"`.

---

## 11. Bugs found while surveying

Reported, not fixed, per the scope of this pass.

1. **A failed voice join leaves the client believing it joined.**
   `src/app/services/voice-channel.service.ts` sets `joinedChannelId` and `joinedGuildId` at line 454,
   *before* the request at 467. The `catch` at 513 only logs. The status bar, sidebar highlight and
   mute controls all render as joined with no media and no way back except clicking another channel.
   This is pre-existing, and it is also the exact path an entitlement rejection will take, so it has
   to be fixed before WP-09 lands or the degradation will be invisible under a worse bug.
2. **`CallWebRtcService.connect()` awaits `cfCreateSession` with no `try`**
   (`src/app/services/call-webrtc.service.ts:337-402`), and is called as `void this.connect(...)` from
   an effect. Any rejection is an unhandled promise rejection.
3. **A stale second quality list.**
   `features/messaging/components/conversation/call-panel/call-panel.component.ts:42-43` declares
   `fpsList = [5, 10, 15, 30]` and `resolutionList = ['native', '1440p', '1080p', '720p', '480p']`,
   referenced nowhere and disagreeing with `stream-preset.ts`.
4. **DM camera ignores the selected device.** `call-session.service.ts:166` hardcodes `{video: true}`
   while the guild path honours `audioSettings.buildVideoConstraint()`.
5. **The emoji settings page double-fetches**, calling both `guildEmojiStore.ensureLoaded()` and
   `guildEmojiService.getEmojis()` on init, the second only to flip a local loading flag.
6. **Hardcoded English in three error paths** that should be i18n keys:
   `profile-settings.component.ts:205,268`, `bot-install-consent.component.ts:78`,
   `notification-settings.component.ts:96`.
7. **Server-side, and mentioned only because it is the thing WP-07 replaces:**
   `Messaging.Application/Controllers/AttachmentController.cs:85-93` carries
   `// TODO: Get the users file upload limit. For now 35 may suffice`, rejects with
   `BadRequest("A file is too large")` - an untranslatable English string with no code - and rejects
   the **whole batch** on one oversized file rather than the file.

---

## 12. The decisions WP-09 cannot get wrong

Ordered by how expensive they are to reverse once clients ship.

1. **A degradation is a `200` carrying the normal body plus `degradations[]`.** If it is an error
   status, every existing client path rolls back and it is a denial. If it is a `200` with no
   marker, it is invisible. There is no third option and no client-side workaround.
2. **`unlimited` never crosses the wire as `long.MaxValue`.** JavaScript cannot hold it. This is
   unfixable in the client and silent.
3. **Not `429`** (the rate-limit interceptor retries and swallows it) and **not `401`** (the logout
   interceptor signs the user out).
4. **`remedy` and `actorCanRemedy` are server-computed and separate from `reason`.** The client
   cannot derive who can fix a limit without re-implementing permission evaluation plus knowledge of
   whether the instance sells anything.
5. **`paired_ceiling` always carries `boundBy`.** Without it there is no correct call to action, and
   the one thing the reason exists to prevent - telling a paying member their own plan limited them -
   becomes unavoidable.
6. **Reason codes are a closed, versioned, documented enumeration with a mandated unknown-fallback
   rule.** They are translation keys in three clients and four locale files. A code invented later
   without a fallback rule renders as a raw key to a user, with every test green.
7. **The video ladder's rungs ship on the wire, and the mapping from the client's (resolution,
   framerate) picker to a rung is the server's.** The two vocabularies do not currently overlap.
   Guessing the mapping client-side is making a pricing decision in a TypeScript file.
8. **Ceilings and consumption are separate payloads.** Conflating them makes the entitlement set
   uncacheable and every X-of-Y meter impossible.
9. **Voice limits ride the existing voice snapshot and its version, not a parallel event.** A second
   unordered channel into a room that already has gap detection reintroduces exactly the bug the
   version mechanism was built to prevent.
10. **`licenseMode` is readable by the client before it draws a nav.** Alpine points at arbitrary
    instances; without it a self-hoster sees upgrade buttons for a service that is not deployed.
11. **The entitlement response echoes its own subject, and carries `resolvedAt` plus a `ttlSeconds`
    no longer than the resolver's own backstop.** Alpine switches account and instance at runtime;
    without the echo, a late response is filed against the wrong subject, and a client TTL longer than
    the server's defeats WP-13's self-healing.
12. **Hard denials use the same field names and code vocabulary as degradations.** Otherwise the same
    sentence is written twice and the two drift.
13. **The audit log response says where the plan's window ends**, distinctly from where the data ends.
    Without it a plan limit renders as "your server has no history".

---

## 13. Checklist for WP-09's frontend guide

- [ ] Degradation is a `200` with `degradations[]` on the normal body, and it says so first
- [ ] Every numeric value is `{kind, value, unlimited}`; `long.MaxValue` appears nowhere
- [ ] `reason`, `boundBy`, `remedy`, `actorCanRemedy` are four separate fields
- [ ] Reason codes enumerated in full, snake_case, with the unknown-code fallback rule stated
- [ ] Status code for a hard denial fixed at one value, with one field name for the code
- [ ] Ladder rungs on the wire; (resolution, framerate) to rung mapping published
- [ ] `licenseMode` reachable before the client draws a settings nav
- [ ] Snapshot echoes `subject`, `resolvedAt`, `version`, `ttlSeconds`
- [ ] `entitlements.Changed` carries an envelope, not values, and its routing is specified
- [ ] Voice limits are on the voice snapshot, version-gated
- [ ] Usage endpoint specified separately from the entitlement set
- [ ] Audit log window end is distinguishable from end of data
- [ ] A statement that message history retention is unlimited on every tier and no client should
      build a retention warning
- [ ] A statement of whether `guild.vanity_url: false` means "not entitled" or "not built yet"
- [ ] An out-of-plan module refusal is distinguishable from a permission refusal at the call site, and
      the plan-included feature set is a second list rather than a clamped `features` string
- [ ] Sections are **numbered and citable**. Alpine's code comments reference guides by section
      (`household guide §10`, `§13.2`), so `entitlements-frontend-guide.md §4.2` has to be a stable
      thing to point at
- [ ] The **event table lives in the guide**. Alpine has no central event-name constants file by
      design - names are inline literals at one registration site each - so the docs are the only
      place the full list exists
