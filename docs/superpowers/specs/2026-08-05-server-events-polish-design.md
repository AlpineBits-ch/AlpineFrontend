# Server Events Polish

**Date:** 2026-08-05
**Status:** Approved

## Problem

Scheduled events shipped functional but unsurfaced. Three concrete failures:

1. **No in-progress state exists anywhere.** `EventsPanelComponent.upcoming()` is
   `endBoundary(e) >= now` — an event that started ten minutes ago renders identically to one
   three weeks out. The DTO's `status` field cannot help: nothing server-side ever moves it off
   `Scheduled` except an explicit cancel, and cancelled events are excluded from the list
   endpoint entirely. "Happening now" has to be derived from the timestamps.
2. **The entry point is hidden.** Events is an unlabeled `pi-calendar` icon button sharing one
   cramped row with the Wiki quick-link, with no active state, no count, and no indication that
   anything is live.
3. **An end-less event is live for zero seconds.** `endBoundary` falls back to `startsAt` when
   `endsAt` is absent, so "Game Night at 8" — the most common way anyone schedules anything —
   drops into *Past* the minute it starts.

## Scope

Panel redesign plus left-sidebar surfacing. No new routes, no main-view Events page.

## 1. Timing model

New pure module `src/app/features/guild/components/events-panel/event-timing.ts`. No Angular
imports, no injection — every function takes `now` explicitly so it is testable without fake
timers.

```ts
export type EventPhase = 'live' | 'upcoming' | 'past';
export type DayBucket = 'today' | 'tomorrow' | 'later';

/** Grace window for an event with no `endsAt`. */
export const OPEN_ENDED_LIVE_MS = 60 * 60 * 1000;

export function endBoundary(event: ScheduledEventDto): number;
export function phaseOf(event: ScheduledEventDto, now: number): EventPhase;
export function dayBucket(startsAt: string, now: number): DayBucket;
```

### `endBoundary`

Moves out of `EventsPanelComponent` with one change. Current behaviour, preserved: a blank or
unparseable `endsAt` must fall back to `startsAt` — `new Date('')` is `NaN` and `NaN` compares
false both ways, which would silently drop the event from the upcoming *and* past lists.

New behaviour: when `endsAt` is absent or unparseable, the boundary becomes
`startsAt + OPEN_ENDED_LIVE_MS` rather than `startsAt`. An event with no declared end stays live
for an hour, then falls to past.

Sixty minutes is a guess at a typical session, chosen because it is long enough that an event is
still listed while people are actually at it and short enough that a forgotten event does not
squat at the top of the panel all day. It is a constant precisely so it is one edit to change.

**This is a behaviour change with test consequences.** `events-panel.component.spec.ts` asserts
the upcoming/past split; an end-less event that the existing tests expect in `past` will now be
`live` for an hour. Those expectations get updated as part of this work, not worked around.

### `phaseOf`

```
now < startsAt          → 'upcoming'
now > endBoundary       → 'past'
otherwise               → 'live'
```

An unparseable `startsAt` yields `NaN`, which fails both comparisons and would fall through to
`'live'`. Guard it: a `NaN` start returns `'past'` so a malformed event cannot pin itself to the
top of the panel forever.

### `dayBucket`

Compares local calendar days, not elapsed hours — an event at 00:30 tomorrow is `'tomorrow'` even
though it is 40 minutes away. Anything beyond tomorrow is `'later'` and renders its own date
header.

### `MinuteClockService`

`src/app/services/minute-clock.service.ts`, `providedIn: 'root'`.

Three components now need a ticking "now" (panel, channel-list badge, voice-channel-item marker).
One shared timer rather than three.

- 30 s cadence. The smallest unit anything here renders is a minute, so 30 s bounds how long a
  stale minute can sit on screen.
- Reads `ServerClockService.now()`, not `Date.now()` — inherits the local-clock correction that
  service exists for. An event list is exactly the case it describes: absolute server-issued
  timestamps compared against a local clock that is routinely hours wrong.
- Ref-counted `retain()` wired to the caller's `DestroyRef`, mirroring `ActivityTickerService`.
  The interval does not run when nothing renders a time.

`ActivityTickerService` is deliberately **not** reused. Its cadence logic asks "how old is the
youngest retained timestamp" and goes to 1 Hz below a minute. A *future* `startsAt` gives
`now - value < 0`, which satisfies that test permanently — retaining event timestamps there would
pin the whole app at 1 Hz for as long as any upcoming event is on screen.

### Where the derivation lives

The pure functions stay pure; components wrap them in `computed()` over
`ScheduledEventStore.eventsForGuild(guildId)` and `clock.now()`. No new store state — `phaseOf`
is a function of data the store already holds plus the clock, and caching it would only create a
second thing to invalidate.

## 2. Panel redesign

`events-panel.component.html` is rewritten. Component logic changes only where the template needs
new shapes.

### Sections

**Happening now** — live events, most recently started first. Card treatment diverges from the
rest: `border-online/30`, `bg-online/[0.06]`, and a header row of a pulsing `bg-online` dot plus
`LIVE` in `text-online`, followed by "ends in 40m" via the existing `RelativeTimePipe`
(`| relativeTime: clock.now()` — the tick-argument pattern that pipe's own docblock prescribes).
An end-less event shows no ends-in line, because there is nothing truthful to put there; the
60-minute grace is an internal cutoff, not a claim about when it finishes.

**Upcoming** — grouped under `TODAY` / `TOMORROW` / `SAT, AUG 8` headers, styled like the existing
past-events toggle (`text-[0.6875rem] font-semibold text-text-muted uppercase tracking-widest`).
Grouping is a `computed()` returning `{bucket, label, events}[]`, so the template stays a flat
`@for` and the bucketing is unit-testable.

**Past** — collapsible, unchanged in behaviour.

### Card

- Date line loses its `uppercase`. `date:'EEE, MMM d · h:mm a'` already yields "Sat, Aug 8 ·
  7:00 PM"; forcing uppercase renders it as shouting.
- A muted relative line beside it ("in 2 days") on upcoming cards.
- Title `text-[0.9375rem] font-semibold text-text-primary`.
- Description clamped to two lines, as today.
- Meta rows for location (`pi-map-marker`) and voice channel (`pi-volume-up`), as today.
- **Footer becomes two elements, not three.** Interest star + count on the left; one primary
  action on the right — `Join Voice` when the event is live and has a voice channel, otherwise the
  interest toggle carries the weight and no second button renders. The current layout puts
  `Join Voice`, edit, and cancel in competition inside a 320 px column.
- **Edit/cancel move to a hover-revealed toolbar** in the card's top-right, `opacity-0
  group-hover:opacity-100 focus-within:opacity-100`, matching the existing
  `message-hover-toolbar` pattern. `focus-within` is not optional — hover-only reveal makes the
  controls unreachable by keyboard.

### States

- **Empty** — soft circle + `pi-calendar` icon, headline, subline, and a `Create Event` button when
  `canManage()`. Replaces the single grey line.
- **Loading / error** — unchanged in structure, restyled to match.
- **Footer note removed.** `EVENTS.NO_REMINDERS_NOTE` currently occupies a permanent bar at the
  bottom of every panel open. It moves into the empty state, where it is information, rather than
  a standing apology.
- The header `+` button gains a tooltip, which every other icon button in that row already has.

## 3. Sidebar surfacing

### Events nav row

Wiki and Events stop sharing a row. Both become full-width rows in the existing nav-row style
(`flex items-center gap-2.5 px-2 py-[7px] rounded-lg`), matching the Wiki and Channels-and-Roles
buttons already there.

The Events row gains:
- A label, from `EVENTS.TITLE`.
- An active state when `navService.eventsPanelGuildId() === guild().id`, using the same
  `bg-white/[0.08] text-white/95` treatment as the active Wiki row. Today the panel can be open
  with nothing in the sidebar indicating it.
- A count pill of upcoming (non-past) events, suppressed at zero.
- A pulsing `bg-online` dot when any event is live, which takes precedence over the count.

### Making the badge truthful

The badge reads `ScheduledEventStore`, which is only populated when the panel has been opened.
`channel-list.component.ts` gains the same effect the panel has —
`effect(() => { const id = this.guild().id; untracked(() => store.loadFor(id)); })` — gated on
`hasEvents()`.

`loadFor` is already idempotent within `STALE_MS`, so the panel's own effect becomes a no-op
rather than a second request. Second-order benefit: the guild becomes `isTracked` in the store, so
`applyRealtimeCreatedOrUpdated` stops early-returning for the guild the user is actually looking
at — today realtime event creation is silently dropped until the panel has been opened once.

### Live marker on the voice channel

`voice-channel-item` gains an optional `liveEvent = input<ScheduledEventDto | null>(null)`. When
set, a small `LIVE` pill renders on the right of the row.

The existing right-side slot is already occupied by either a lock icon (`isPrivate`) or the
participant count. Precedence: lock, then LIVE pill, then count — the lock is a permission fact
and must not be displaced by a transient one.

`channel-list.component.ts` computes `liveEventsByChannel: Map<string, ScheduledEventDto>` and
passes the lookup down, the same way `participants` already flow into that component.

## 4. i18n

New keys under `EVENTS.*`, added to `en.json`, `de.json` and `fr.json` in the `venta-i18n`
submodule at `src/assets/i18n/locales`:

| Key | English |
|---|---|
| `EVENTS.HAPPENING_NOW` | Happening now |
| `EVENTS.LIVE` | Live |
| `EVENTS.UPCOMING` | Upcoming |
| `EVENTS.TODAY` | Today |
| `EVENTS.TOMORROW` | Tomorrow |
| `EVENTS.ENDS_RELATIVE` | Ends {{ when }} |
| `EVENTS.STARTED_RELATIVE` | Started {{ when }} |
| `EVENTS.INTERESTED` | Interested |
| `EVENTS.INTERESTED_COUNT` | {{ count }} interested |
| `EVENTS.EMPTY_TITLE` | No events scheduled |
| `EVENTS.EMPTY_SUBTITLE` | Events you or a moderator schedule will show up here. |
| `EVENTS.CREATE_FIRST` | Create Event |
| `EVENTS.CREATE_TOOLTIP` | Create event |
| `EVENTS.IN_VOICE_COUNT` | {{ count }} in voice |

The relative phrasings take the pipe's output as `{{ when }}` rather than concatenating, so
languages that put the preposition elsewhere can move it.

`de.json` and `fr.json` currently carry 1488 keys against `en.json`'s 1917 — they are already
partial. These keys get real translations in all three rather than widening that gap.

The submodule is a separate repository: its own commit and push, then a pointer bump in this
repo. A second agent is working on wiki strings in the same submodule concurrently — pull and
rebase before pushing, and carry their keys along rather than reverting them.

## Testing

- `event-timing.spec.ts` — new. `phaseOf` at every boundary; the open-ended grace window at
  0/59/61 minutes past start; `NaN` start and `NaN` end; `dayBucket` across a local midnight.
- `events-panel.component.spec.ts` — existing upcoming/past assertions updated for the grace
  window, plus new coverage of the live/upcoming/past three-way split and day grouping.
- `minute-clock.service.spec.ts` — new. Ref-counting starts and stops the interval; the emitted
  value tracks `ServerClockService.offsetMs`.

## Out of scope

- Cover images and creator attribution — the DTO carries neither (`creatorUserId` only, with no
  resolution path in the panel).
- Event reminders and notifications — no server support; this is what `NO_REMINDERS_NOTE` exists
  to admit.
- A full-page Events view.
- Any change to `ScheduledEventService`, the DTOs, or the create/edit dialog.
