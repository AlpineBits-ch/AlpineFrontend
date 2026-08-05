# Server Events Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give scheduled events a visible in-progress state and a Discord-grade panel, surfaced from the guild sidebar instead of behind an unlabeled icon.

**Architecture:** All "is this event happening" logic moves into one pure module (`event-timing.ts`) that takes `now` as a parameter, plus one root `MinuteClockService` that supplies `now` to the three components that need it. The panel, the sidebar nav row and the voice channel row all derive their state from those two pieces — no new store state, no duplicated timers.

**Tech Stack:** Angular 21 (signals, `input()`/`output()`, `@if`/`@for` control flow), PrimeNG 21, Tailwind CSS v4, `@ngx-translate/core`, Vitest via `ng test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-05-server-events-polish-design.md`.
- **Colors:** use theme tokens only — `bg-card`, `bg-sidebar`, `border-border`, `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-online`, `text-connecting`. Never `bg-[#161b27]`. In CSS files use `var(--color-online)` etc.
- **Font sizes:** rem-based Tailwind (`text-[0.75rem]`), never px — they scale with `--base-font-size`. Exception: the existing channel-list rows use px (`text-[15px]`, `text-[13px]`); match their neighbours when editing inside that file.
- **Scrollbars:** class `thin-scrollbar`, never an inline style.
- **PrimeNG buttons:** `(onClick)` not `(click)`. Icon-only toolbar buttons are `[text]="true" severity="secondary" size="small"`.
- **All user-facing strings** go through `| translate`. No literals in templates.
- **Test command:** `ng test` (Vitest via `@angular/build:unit-test`). There is no `npm test` script. Run a single file with `ng test --include=<path>`.
- **Never** `git push --force`, never `--no-verify`.
- Commit after every task. Push to `main` directly (this project does not use PRs).

---

### Task 1: `MinuteClockService`

A single shared 30-second clock, so the panel, the sidebar badge and the voice rows do not each own a `setInterval`.

**Files:**
- Create: `src/app/services/minute-clock.service.ts`
- Test: `src/app/services/minute-clock.service.spec.ts`

**Interfaces:**
- Consumes: `ServerClockService` from `src/app/services/server-clock.service.ts` — `now(): number`.
- Produces:
  - `class MinuteClockService`, `providedIn: 'root'`
  - `readonly now: Signal<number>` — server-corrected epoch ms
  - `retain(): void` — must be called from an injection context; releases on that context's `DestroyRef`

- [ ] **Step 1: Write the failing test**

Create `src/app/services/minute-clock.service.spec.ts`:

```ts
import {Component, inject} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MinuteClockService} from './minute-clock.service';
import {ServerClockService} from './server-clock.service';

/** Stands in for the real clock so tests control "now" without touching wall time. */
class FakeServerClock {
    value = 1_000;

    now(): number {
        return this.value;
    }
}

/** A retainer has to live somewhere with a DestroyRef, which in practice means a component. */
@Component({template: '', standalone: true})
class HostComponent {
    readonly clock = inject(MinuteClockService);

    constructor() {
        this.clock.retain();
    }
}

function setup() {
    const serverClock = new FakeServerClock();

    TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [{provide: ServerClockService, useValue: serverClock}],
    });

    return {serverClock, service: TestBed.inject(MinuteClockService)};
}

describe('MinuteClockService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('does not tick until something retains it', () => {
        const {serverClock, service} = setup();

        serverClock.value = 5_000;
        vi.advanceTimersByTime(120_000);

        expect(service.now()).not.toBe(5_000);
    });

    it('samples the server clock on retain and every 30 seconds after', () => {
        const {serverClock, service} = setup();

        serverClock.value = 5_000;
        TestBed.createComponent(HostComponent);
        expect(service.now()).toBe(5_000);

        serverClock.value = 35_000;
        vi.advanceTimersByTime(30_000);
        expect(service.now()).toBe(35_000);
    });

    it('reads the server-corrected clock, not the local one', () => {
        const {serverClock, service} = setup();

        // A machine three hours fast still reports the server's idea of now.
        serverClock.value = Date.now() - 3 * 60 * 60 * 1000;
        TestBed.createComponent(HostComponent);

        expect(service.now()).toBe(serverClock.value);
    });

    it('stops ticking once the last retainer is destroyed', () => {
        const {serverClock, service} = setup();

        const fixture = TestBed.createComponent(HostComponent);
        vi.advanceTimersByTime(30_000);

        fixture.destroy();
        const frozen = service.now();

        serverClock.value = 999_000;
        vi.advanceTimersByTime(120_000);

        expect(service.now()).toBe(frozen);
    });

    it('keeps ticking while a second retainer is still alive', () => {
        const {serverClock, service} = setup();

        const first = TestBed.createComponent(HostComponent);
        TestBed.createComponent(HostComponent);

        first.destroy();
        serverClock.value = 77_000;
        vi.advanceTimersByTime(30_000);

        expect(service.now()).toBe(77_000);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ng test --include=src/app/services/minute-clock.service.spec.ts`
Expected: FAIL — `Failed to resolve import "./minute-clock.service"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/services/minute-clock.service.ts`:

```ts
import {DestroyRef, inject, Injectable, signal} from '@angular/core';
import {ServerClockService} from './server-clock.service';

/**
 * 30 s. The smallest unit anything reading this clock renders is a minute, so half a minute is
 * the coarsest cadence that cannot leave a stale minute on screen for longer than it takes to
 * notice.
 */
const TICK_MS = 30_000;

/**
 * The one clock behind everything that renders a *scheduled* time - "ends in 40m", the live
 * badge on the events row, the LIVE pill on a voice channel.
 *
 * <p><b>Why not {@link ActivityTickerService}.</b> That service exists for the same reason and
 * would be the obvious thing to reuse, but its cadence logic asks "how old is the youngest
 * retained timestamp" and drops to 1 Hz below a minute. Every timestamp here is in the *future*,
 * so `now - startsAt` is negative, which satisfies that test permanently - retaining an event
 * there would pin the entire app at 1 Hz for as long as any upcoming event is on screen.</p>
 *
 * <p><b>Why not `Date.now()`.</b> Events carry absolute server-issued timestamps, and the local
 * clock is routinely wrong by hours - see {@link ServerClockService}, which exists for exactly
 * this failure. Reading through it means a machine with a dead CMOS battery still sees the right
 * event as live.</p>
 *
 * <p>Retention is ref-counted so the interval does not run when nothing is rendering a time.</p>
 */
@Injectable({providedIn: 'root'})
export class MinuteClockService {
    private readonly clock = inject(ServerClockService);

    private readonly _now = signal(0);

    /**
     * Server-corrected "now", epoch ms. Read it beside the value being formatted -
     * `{{ e.endsAt | relativeTime: clock.now() }}` - which is the convention
     * {@link RelativeTimePipe} documents for keeping a pure pipe live.
     *
     * <p>Reads `0` until something {@link retain}s the clock. A consumer that reads it has by
     * definition retained it, so the initial value is never rendered.</p>
     */
    readonly now = this._now.asReadonly();

    private handle?: ReturnType<typeof setInterval>;
    private retainers = 0;

    /**
     * Marks the clock as on-screen for as long as the calling context lives.
     *
     * <p>Must be called from an injection context (a component constructor or field
     * initializer): release is wired to that context's {@link DestroyRef}, so there is no
     * `ngOnDestroy` to forget.</p>
     */
    retain(): void {
        this.retainers++;
        this.sync();

        inject(DestroyRef).onDestroy(() => {
            this.retainers--;
            this.sync();
        });
    }

    /** Starts or stops the one timer to match whether anything is retaining it. */
    private sync(): void {
        if (this.retainers > 0) {
            // Sampled immediately as well as on the interval, so a component that mounts 29 s
            // into a tick does not render a value that is most of a tick stale.
            this._now.set(this.clock.now());
            this.handle ??= setInterval(() => this._now.set(this.clock.now()), TICK_MS);
            return;
        }

        if (this.handle) {
            clearInterval(this.handle);
            this.handle = undefined;
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ng test --include=src/app/services/minute-clock.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/minute-clock.service.ts src/app/services/minute-clock.service.spec.ts
git commit -m "feat(events): one shared 30s clock for scheduled-time rendering"
```

---

### Task 2: `event-timing.ts`

The live/upcoming/past derivation, extracted from the panel and made pure so it can be tested without a component or fake timers.

**Files:**
- Create: `src/app/features/guild/components/events-panel/event-timing.ts`
- Test: `src/app/features/guild/components/events-panel/event-timing.spec.ts`

**Interfaces:**
- Consumes: `ScheduledEventDto` from `src/app/dtos/response/scheduled-event.dto.ts`.
- Produces:
  - `type EventPhase = 'live' | 'upcoming' | 'past'`
  - `type DayBucket = 'today' | 'tomorrow' | 'later'`
  - `const OPEN_ENDED_LIVE_MS: number`
  - `startTime(event: ScheduledEventDto): number`
  - `endBoundary(event: ScheduledEventDto): number`
  - `phaseOf(event: ScheduledEventDto, now: number): EventPhase`
  - `dayBucket(startsAt: string, now: number): DayBucket`

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/components/events-panel/event-timing.spec.ts`:

```ts
import {ScheduledEventDto, ScheduledEventStatus} from '../../../../dtos/response/scheduled-event.dto';
import {dayBucket, endBoundary, OPEN_ENDED_LIVE_MS, phaseOf, startTime} from './event-timing';

// Built from local-time components, not a UTC string: `dayBucket` compares local calendar days,
// so a UTC-pinned fixture would bucket differently depending on the machine's timezone.
const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;

function event(overrides: Partial<ScheduledEventDto> = {}): ScheduledEventDto {
    return {
        id: 'e1',
        guildId: 'g1',
        creatorUserId: 'u1',
        title: 'Event',
        description: null,
        startsAt: new Date(NOW + 60 * MINUTE).toISOString(),
        endsAt: null,
        location: null,
        voiceChannelId: null,
        status: ScheduledEventStatus.Scheduled,
        interestedCount: 0,
        isInterested: false,
        ...overrides,
    };
}

describe('phaseOf', () => {
    it('calls an event that has not started upcoming', () => {
        expect(phaseOf(event({startsAt: new Date(NOW + MINUTE).toISOString()}), NOW)).toBe('upcoming');
    });

    it('calls an event live from the moment it starts', () => {
        const e = event({
            startsAt: new Date(NOW).toISOString(),
            endsAt: new Date(NOW + 30 * MINUTE).toISOString(),
        });

        expect(phaseOf(e, NOW)).toBe('live');
    });

    it('calls an event live right up to its end', () => {
        const e = event({
            startsAt: new Date(NOW - 30 * MINUTE).toISOString(),
            endsAt: new Date(NOW + MINUTE).toISOString(),
        });

        expect(phaseOf(e, NOW)).toBe('live');
        expect(phaseOf(e, NOW + 2 * MINUTE)).toBe('past');
    });

    it('keeps an event with no end time live for the grace window, then drops it', () => {
        // "Game Night at 8" with no end is the common case. Before this window existed it was
        // live for zero seconds and appeared under Past the minute it began.
        const e = event({startsAt: new Date(NOW).toISOString(), endsAt: null});

        expect(phaseOf(e, NOW)).toBe('live');
        expect(phaseOf(e, NOW + OPEN_ENDED_LIVE_MS - MINUTE)).toBe('live');
        expect(phaseOf(e, NOW + OPEN_ENDED_LIVE_MS + MINUTE)).toBe('past');
    });

    it('treats a blank endsAt exactly like an absent one', () => {
        // `new Date('')` is NaN and NaN compares false both ways, so an unguarded comparison
        // drops the event out of every list at once.
        const e = event({startsAt: new Date(NOW).toISOString(), endsAt: ''});

        expect(phaseOf(e, NOW)).toBe('live');
        expect(phaseOf(e, NOW + OPEN_ENDED_LIVE_MS + MINUTE)).toBe('past');
    });

    it('treats an unparseable endsAt like an absent one', () => {
        const e = event({startsAt: new Date(NOW).toISOString(), endsAt: 'not-a-date'});

        expect(phaseOf(e, NOW)).toBe('live');
    });

    it('files an event with an unparseable start under past rather than pinning it live', () => {
        expect(phaseOf(event({startsAt: 'not-a-date'}), NOW)).toBe('past');
    });
});

describe('endBoundary', () => {
    it('uses endsAt when it parses', () => {
        const endsAt = new Date(NOW + 90 * MINUTE);

        expect(endBoundary(event({endsAt: endsAt.toISOString()}))).toBe(endsAt.getTime());
    });

    it('adds the grace window to startsAt when endsAt is absent', () => {
        const startsAt = new Date(NOW + 10 * MINUTE);
        const e = event({startsAt: startsAt.toISOString(), endsAt: null});

        expect(endBoundary(e)).toBe(startsAt.getTime() + OPEN_ENDED_LIVE_MS);
    });

    it('is NaN when the start itself is unparseable', () => {
        expect(Number.isNaN(endBoundary(event({startsAt: 'nope', endsAt: null})))).toBe(true);
    });
});

describe('startTime', () => {
    it('returns the parsed start', () => {
        expect(startTime(event({startsAt: new Date(NOW).toISOString()}))).toBe(NOW);
    });
});

describe('dayBucket', () => {
    it('buckets a later hour of the same calendar day as today', () => {
        expect(dayBucket(new Date(2026, 7, 1, 23, 30).toISOString(), NOW)).toBe('today');
    });

    it('buckets an earlier hour of the same calendar day as today', () => {
        expect(dayBucket(new Date(2026, 7, 1, 1, 0).toISOString(), NOW)).toBe('today');
    });

    it('buckets just after midnight as tomorrow, not today', () => {
        // 40 minutes away by the clock, but a different calendar day - which is what a reader
        // means by "tomorrow".
        const nearMidnight = new Date(2026, 7, 1, 23, 20).getTime();

        expect(dayBucket(new Date(2026, 7, 2, 0, 0).toISOString(), nearMidnight)).toBe('tomorrow');
    });

    it('buckets two days out as later', () => {
        expect(dayBucket(new Date(2026, 7, 3, 9, 0).toISOString(), NOW)).toBe('later');
    });

    it('buckets an unparseable start as later rather than throwing', () => {
        expect(dayBucket('not-a-date', NOW)).toBe('later');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ng test --include=src/app/features/guild/components/events-panel/event-timing.spec.ts`
Expected: FAIL — `Failed to resolve import "./event-timing"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/features/guild/components/events-panel/event-timing.ts`:

```ts
import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';

export type EventPhase = 'live' | 'upcoming' | 'past';
export type DayBucket = 'today' | 'tomorrow' | 'later';

/**
 * How long an event with no declared end stays live.
 *
 * <p>An hour is a guess at a typical session: long enough that the event is still listed while
 * people are actually at it, short enough that a forgotten one does not squat at the top of the
 * panel all day. It is a constant so that is one edit to change.</p>
 */
export const OPEN_ENDED_LIVE_MS = 60 * 60 * 1000;

/** Epoch ms of the event's start, or `NaN` if `startsAt` does not parse. */
export function startTime(event: ScheduledEventDto): number {
    return new Date(event.startsAt).getTime();
}

/**
 * Epoch ms at which an event stops counting as happening.
 *
 * <p>`endsAt` when it is present and parseable. A blank or unparseable one must not be compared
 * directly - `new Date('')` is `NaN`, and `NaN` compares false in both directions, which would
 * silently drop the event out of every list at once. It falls back to
 * `startsAt + OPEN_ENDED_LIVE_MS`.</p>
 */
export function endBoundary(event: ScheduledEventDto): number {
    const end = event.endsAt ? new Date(event.endsAt).getTime() : Number.NaN;
    if (!Number.isNaN(end)) return end;

    const start = startTime(event);
    return Number.isNaN(start) ? Number.NaN : start + OPEN_ENDED_LIVE_MS;
}

/**
 * Which of the three lists an event belongs in, at a given moment.
 *
 * <p>Derived from the timestamps, never from `status`: nothing server-side moves that field off
 * `Scheduled` except an explicit cancel, and cancelled events are excluded from the list endpoint
 * entirely.</p>
 */
export function phaseOf(event: ScheduledEventDto, now: number): EventPhase {
    const start = startTime(event);
    // An unparseable start fails both comparisons below and would fall through to 'live',
    // pinning a malformed event to the top of the panel forever.
    if (Number.isNaN(start)) return 'past';

    if (now < start) return 'upcoming';
    return now > endBoundary(event) ? 'past' : 'live';
}

/** Local midnight preceding `date`. */
function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Which day header an upcoming event belongs under.
 *
 * <p>Compares local calendar days rather than elapsed hours: an event at 00:30 tomorrow is
 * "tomorrow" even though it is forty minutes away, which is what a reader means by the word.
 * Calendar arithmetic via `setDate` rather than adding 86 400 000 ms, so a DST boundary - where a
 * day is 23 or 25 hours long - does not misfile the next day as "later".</p>
 */
export function dayBucket(startsAt: string, now: number): DayBucket {
    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) return 'later';

    const today = startOfDay(new Date(now));
    const day = startOfDay(start);
    if (day <= today) return 'today';

    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    return day === startOfDay(tomorrowDate) ? 'tomorrow' : 'later';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ng test --include=src/app/features/guild/components/events-panel/event-timing.spec.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/events-panel/event-timing.ts src/app/features/guild/components/events-panel/event-timing.spec.ts
git commit -m "feat(events): derive live/upcoming/past from timestamps in one pure module"
```

---

### Task 3: Translation strings

The submodule at `src/assets/i18n/locales` is a separate repository (`venta-i18n`). It gets its own commit and push, then this repo records the new pointer. **A second agent is working on wiki strings in the same submodule concurrently** — rebase onto their work and carry their keys along rather than reverting them.

**Files:**
- Modify: `src/assets/i18n/locales/en.json` (after `"EVENTS.SAVE_ERROR"`)
- Modify: `src/assets/i18n/locales/de.json` (same position)
- Modify: `src/assets/i18n/locales/fr.json` (same position)
- Modify: this repo's submodule pointer

**Interfaces:**
- Produces: the keys `EVENTS.HAPPENING_NOW`, `EVENTS.LIVE`, `EVENTS.TODAY`, `EVENTS.TOMORROW`, `EVENTS.ENDS_RELATIVE`, `EVENTS.INTERESTED`, `EVENTS.EMPTY_TITLE`, `EVENTS.EMPTY_SUBTITLE`, `EVENTS.CREATE_FIRST`, `EVENTS.CREATE_TOOLTIP`, `EVENTS.IN_VOICE_COUNT`. Tasks 4–7 reference these.

- [ ] **Step 1: Sync the submodule onto the other agent's work**

```bash
cd src/assets/i18n/locales
git checkout main
git pull --rebase origin main
```

Expected: clean. If the other agent has pushed wiki keys, they arrive here — keep them.

- [ ] **Step 2: Add the English keys**

In `src/assets/i18n/locales/en.json`, immediately after the `"EVENTS.SAVE_ERROR"` line, insert:

```json
  "EVENTS.HAPPENING_NOW": "Happening now",
  "EVENTS.LIVE": "Live",
  "EVENTS.TODAY": "Today",
  "EVENTS.TOMORROW": "Tomorrow",
  "EVENTS.ENDS_RELATIVE": "Ends {{ when }}",
  "EVENTS.INTERESTED": "Interested",
  "EVENTS.EMPTY_TITLE": "No events scheduled",
  "EVENTS.EMPTY_SUBTITLE": "Events you or a moderator schedule will show up here.",
  "EVENTS.CREATE_FIRST": "Create event",
  "EVENTS.CREATE_TOOLTIP": "Create event",
  "EVENTS.IN_VOICE_COUNT": "{{ count }} in voice",
```

- [ ] **Step 3: Add the German keys**

In `src/assets/i18n/locales/de.json`, immediately after the `"EVENTS.SAVE_ERROR"` line, insert:

```json
  "EVENTS.HAPPENING_NOW": "Läuft gerade",
  "EVENTS.LIVE": "Live",
  "EVENTS.TODAY": "Heute",
  "EVENTS.TOMORROW": "Morgen",
  "EVENTS.ENDS_RELATIVE": "Endet {{ when }}",
  "EVENTS.INTERESTED": "Interessiert",
  "EVENTS.EMPTY_TITLE": "Keine Events geplant",
  "EVENTS.EMPTY_SUBTITLE": "Events, die du oder ein Moderator plant, erscheinen hier.",
  "EVENTS.CREATE_FIRST": "Event erstellen",
  "EVENTS.CREATE_TOOLTIP": "Event erstellen",
  "EVENTS.IN_VOICE_COUNT": "{{ count }} im Sprachkanal",
```

- [ ] **Step 4: Add the French keys**

In `src/assets/i18n/locales/fr.json`, immediately after the `"EVENTS.SAVE_ERROR"` line, insert:

```json
  "EVENTS.HAPPENING_NOW": "En cours",
  "EVENTS.LIVE": "En direct",
  "EVENTS.TODAY": "Aujourd'hui",
  "EVENTS.TOMORROW": "Demain",
  "EVENTS.ENDS_RELATIVE": "Se termine {{ when }}",
  "EVENTS.INTERESTED": "Intéressé",
  "EVENTS.EMPTY_TITLE": "Aucun événement prévu",
  "EVENTS.EMPTY_SUBTITLE": "Les événements que vous ou un modérateur planifiez apparaîtront ici.",
  "EVENTS.CREATE_FIRST": "Créer un événement",
  "EVENTS.CREATE_TOOLTIP": "Créer un événement",
  "EVENTS.IN_VOICE_COUNT": "{{ count }} en vocal",
```

- [ ] **Step 5: Verify all three files still parse**

```bash
cd src/assets/i18n/locales
node -e "for (const f of ['en','de','fr']) { const d = require('./' + f + '.json'); console.log(f, Object.keys(d).length, d['EVENTS.HAPPENING_NOW']); }"
```

Expected: three lines, each ending in the translated "Happening now" for that language.

- [ ] **Step 6: Commit and push the submodule**

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat(i18n): live and empty-state strings for scheduled events"
git pull --rebase origin main
git push origin main
```

If the rebase reports a conflict inside the `EVENTS.*` or `WIKI.*` block, keep **both** sides — the other agent's keys and these — and re-run step 5 before pushing.

- [ ] **Step 7: Record the pointer in this repo and push**

```bash
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for scheduled-event strings"
git push origin main
```

---

### Task 4: Live event dot

The one piece of motion in this feature, defined once and reused by the panel card, the sidebar row and the voice channel row.

**Files:**
- Modify: `src/styles.css` (append after the `speaking-ring` block, around line 122)

**Interfaces:**
- Produces: CSS class `.event-live-dot` — a 7 px emerald dot with an expanding ring, ring suppressed under `prefers-reduced-motion`.

- [ ] **Step 1: Add the class**

In `src/styles.css`, directly after the `.speaking-ring { ... }` rule, insert:

```css
/* ── Live scheduled event ────────────────────────────────────────────────────
   `--color-online` already means "someone is here, now" everywhere else in this
   app - voice rows, speaking rings - so a live event speaks the same colour
   rather than introducing a second one for the same idea. */

@keyframes event-live-ring {
  0%   { transform: scale(1);   opacity: 0.55; }
  70%  { transform: scale(2.4); opacity: 0; }
  100% { transform: scale(2.4); opacity: 0; }
}

.event-live-dot {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  background: var(--color-online);
}

.event-live-dot::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  background: var(--color-online);
  animation: event-live-ring 1.8s ease-out infinite;
}

/* The dot's colour carries the meaning on its own; the ring is emphasis, and
   emphasis is the first thing to drop when motion is unwelcome. */
@media (prefers-reduced-motion: reduce) {
  .event-live-dot::after {
    display: none;
  }
}
```

- [ ] **Step 2: Verify the stylesheet still builds**

Run: `ng build --configuration development`
Expected: build succeeds with no CSS errors.

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat(events): live dot, with the ring dropped under reduced motion"
```

---

### Task 5: `EventCardComponent`

One card, three phases. Extracted so the panel template does not repeat a 60-line block three times.

**Files:**
- Create: `src/app/features/guild/components/events-panel/event-card.component.ts`
- Create: `src/app/features/guild/components/events-panel/event-card.component.html`

**Interfaces:**
- Consumes: `EventPhase` from `./event-timing` (Task 2); `MinuteClockService` from `src/app/services/minute-clock.service` (Task 1); `.event-live-dot` (Task 4); the `EVENTS.*` keys from Task 3.
- Produces: `EventCardComponent`, selector `app-event-card`
  - inputs: `event = input.required<ScheduledEventDto>()`, `phase = input.required<EventPhase>()`, `canManage = input.required<boolean>()`
  - outputs: `edit = output<void>()`, `cancel = output<void>()`, `interest = output<void>()`, `joinVoice = output<void>()`

- [ ] **Step 1: Write the component class**

Create `src/app/features/guild/components/events-panel/event-card.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {DatePipe, NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {EventPhase} from './event-timing';

/**
 * One scheduled event, rendered for whichever phase it is in.
 *
 * <p>Presentation only: it resolves what it can read for itself (the voice channel's name, who is
 * in it, the clock) and emits an intent for anything that mutates. The panel owns the store, the
 * toasts and the cancel confirmation, so there is exactly one place where an event changes.</p>
 */
@Component({
    selector: 'app-event-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [DatePipe, NgClass, TranslateModule, RelativeTimePipe, Button, Tooltip],
    templateUrl: './event-card.component.html',
})
export class EventCardComponent {
    event = input.required<ScheduledEventDto>();
    phase = input.required<EventPhase>();
    canManage = input.required<boolean>();

    readonly edit = output<void>();
    readonly cancel = output<void>();
    readonly interest = output<void>();
    readonly joinVoice = output<void>();

    protected readonly clock = inject(MinuteClockService);
    private readonly navService = inject(NavigationService);
    private readonly voiceChannelSvc = inject(VoiceChannelService);

    constructor() {
        this.clock.retain();
    }

    /** The end to render, or null when there is nothing truthful to show. */
    protected endsAt = computed<string | null>(() => {
        // The open-ended grace window is an internal cutoff, not a claim about when the event
        // finishes - an event with no declared end must not be given one on screen.
        const endsAt = this.event().endsAt;
        if (!endsAt) return null;
        return Number.isNaN(new Date(endsAt).getTime()) ? null : endsAt;
    });

    protected voiceChannelName = computed<string | null>(() => {
        const channelId = this.event().voiceChannelId;
        if (!channelId) return null;

        const ws = this.navService.workspace();
        if (ws.type !== 'server') return null;
        return ws.guild.channels.find(c => c.id === channelId)?.name ?? null;
    });

    protected voiceParticipantCount = computed(() => {
        const channelId = this.event().voiceChannelId;
        if (!channelId) return 0;
        return this.voiceChannelSvc.channelParticipants().get(channelId)?.length ?? 0;
    });
}
```

- [ ] **Step 2: Write the template**

Create `src/app/features/guild/components/events-panel/event-card.component.html`:

```html
<div [ngClass]="phase() === 'live'
                    ? 'border-online/30 bg-online/[0.06]'
                    : 'border-border bg-card hover:border-border-default'"
     class="group relative rounded-xl border p-3 transition-colors">

    <!-- Manage actions. Hover-revealed so the card stays quiet, focus-revealed so they are
         still reachable from the keyboard. Never on a past event - there is nothing to change. -->
    @if (canManage() && phase() !== 'past') {
        <div class="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-lg bg-sidebar/90 p-0.5
                    opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <p-button (onClick)="edit.emit()" [pTooltip]="'COMMON.EDIT' | translate" [text]="true"
                      icon="pi pi-pencil" severity="secondary" size="small" tooltipPosition="bottom"/>
            <p-button (onClick)="cancel.emit()" [pTooltip]="'EVENTS.CANCEL_CONFIRM_HEADER' | translate"
                      [text]="true" icon="pi pi-trash" severity="danger" size="small" tooltipPosition="bottom"/>
        </div>
    }

    <!-- When -->
    @if (phase() === 'live') {
        <div class="flex items-center gap-2 min-w-0 pr-16">
            <span class="event-live-dot"></span>
            <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-online shrink-0">
                {{ 'EVENTS.LIVE' | translate }}
            </span>
            @if (endsAt(); as ends) {
                <span class="text-[0.75rem] text-text-secondary truncate">
                    {{ 'EVENTS.ENDS_RELATIVE' | translate: {when: (ends | relativeTime: clock.now())} }}
                </span>
            }
        </div>
    } @else {
        <div class="flex items-baseline gap-2 min-w-0 pr-16">
            <span class="text-[0.75rem] font-medium text-[var(--color-brand-dim)] shrink-0">
                {{ event().startsAt | date:'EEE, MMM d · h:mm a' }}
            </span>
            @if (phase() === 'upcoming') {
                <span class="text-[0.6875rem] text-text-muted truncate">
                    {{ event().startsAt | relativeTime: clock.now() }}
                </span>
            }
        </div>
    }

    <h4 class="mt-1 mb-0 text-[0.9375rem] font-semibold leading-snug text-text-primary break-words">
        {{ event().title }}
    </h4>

    @if (event().description) {
        <p class="mt-1 mb-0 text-[0.8125rem] text-text-secondary line-clamp-2">{{ event().description }}</p>
    }

    @if (event().location; as location) {
        <div class="mt-2 flex items-center gap-1.5 min-w-0 text-[0.75rem] text-text-secondary">
            <i class="pi pi-map-marker text-[0.6875rem] shrink-0 text-text-muted"></i>
            <span class="truncate">{{ location }}</span>
        </div>
    }

    @if (voiceChannelName(); as channelName) {
        <div class="mt-1.5 flex items-center gap-1.5 min-w-0 text-[0.75rem] text-text-secondary">
            <i class="pi pi-volume-up text-[0.6875rem] shrink-0 text-text-muted"></i>
            <span class="truncate">{{ channelName }}</span>
            @if (voiceParticipantCount() > 0) {
                <span class="shrink-0 text-text-muted">
                    · {{ 'EVENTS.IN_VOICE_COUNT' | translate: {count: voiceParticipantCount()} }}
                </span>
            }
        </div>
    }

    @if (phase() !== 'past') {
        <div class="mt-3 flex items-center gap-2">
            <button (click)="interest.emit()"
                    [attr.aria-pressed]="event().isInterested"
                    [ngClass]="event().isInterested
                                   ? 'border-connecting/40 bg-connecting/10 text-connecting'
                                   : 'border-border text-text-secondary hover:border-border-default hover:text-text-primary'"
                    [pTooltip]="'EVENTS.INTERESTED' | translate"
                    class="flex items-center gap-1.5 rounded-lg border bg-transparent px-2 py-1
                           text-[0.75rem] font-medium cursor-pointer transition-colors"
                    tooltipPosition="bottom"
                    type="button">
                <i [ngClass]="event().isInterested ? 'pi-star-fill' : 'pi-star'" class="pi text-[0.6875rem]"></i>
                <span>{{ event().interestedCount }}</span>
            </button>

            <!-- Only while it is actually happening: a Join button on an event three weeks out
                 drops you into an empty channel. -->
            @if (phase() === 'live' && event().voiceChannelId) {
                <p-button (onClick)="joinVoice.emit()" [label]="'EVENTS.JOIN_VOICE' | translate"
                          class="ml-auto" severity="primary" size="small"/>
            }
        </div>
    }
</div>
```

- [ ] **Step 3: Verify it compiles**

Run: `ng build --configuration development`
Expected: build succeeds. (The component is not yet referenced; this step only proves the template type-checks.)

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/events-panel/event-card.component.ts src/app/features/guild/components/events-panel/event-card.component.html
git commit -m "feat(events): one event card that renders all three phases"
```

---

### Task 6: Panel rewire and redesign

**Files:**
- Modify: `src/app/features/guild/components/events-panel/events-panel.component.ts`
- Modify: `src/app/features/guild/components/events-panel/events-panel.component.html` (full rewrite)
- Test: `src/app/features/guild/components/events-panel/events-panel.component.spec.ts` (rewrite `setup` + split tests)

**Interfaces:**
- Consumes: `phaseOf`, `startTime`, `dayBucket`, `DayBucket` (Task 2); `MinuteClockService` (Task 1); `EventCardComponent` (Task 5); `EVENTS.*` keys (Task 3).
- Produces: `EventDayGroup` interface, exported from `events-panel.component.ts` for the template.

- [ ] **Step 1: Write the failing test**

Replace the whole of `src/app/features/guild/components/events-panel/events-panel.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {Observable, Subject} from 'rxjs';
import {EventsPanelComponent} from './events-panel.component';
import {ScheduledEventService} from '../../../../services/scheduled-event.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {ProfileService} from '../../../../services/profile.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {ToastService} from '../../../../services/toast.service';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {ScheduledEventDto, ScheduledEventStatus} from '../../../../dtos/response/scheduled-event.dto';

// Local-time components, not a UTC string: the day grouping compares local calendar days.
const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;

function event(id: string, overrides: Partial<ScheduledEventDto> = {}): ScheduledEventDto {
    return {
        id,
        guildId: 'g1',
        creatorUserId: 'u1',
        title: `Event ${id}`,
        description: null,
        startsAt: new Date(NOW + 60 * MINUTE).toISOString(),
        endsAt: null,
        location: null,
        voiceChannelId: null,
        status: ScheduledEventStatus.Scheduled,
        interestedCount: 0,
        isInterested: false,
        ...overrides,
    };
}

class FakeScheduledEventService {
    listPending: Subject<ScheduledEventDto[]>[] = [];

    list(_guildId: string): Observable<ScheduledEventDto[]> {
        const subject = new Subject<ScheduledEventDto[]>();
        this.listPending.push(subject);
        return subject.asObservable();
    }
}

class FakeGuildWebsocketService {
    eventCreatedObservable = new Subject<any>();
    eventUpdatedObservable = new Subject<any>();
    eventCancelledObservable = new Subject<any>();
}

function setup(events: ScheduledEventDto[], memberPermissions = '') {
    const api = new FakeScheduledEventService();
    // The clock is faked rather than pinned through the component, so the split depends on a
    // value the test owns instead of on wall time.
    const now: WritableSignal<number> = signal(NOW);

    TestBed.configureTestingModule({
        imports: [EventsPanelComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ScheduledEventService, useValue: api},
            {provide: GuildWebsocketService, useValue: new FakeGuildWebsocketService()},
            {provide: ProfileService, useValue: {ownProfile: signal(undefined)}},
            {
                provide: VoiceChannelService,
                useValue: {
                    joinedChannelId: () => null,
                    joinChannel: () => undefined,
                    channelParticipants: signal(new Map()),
                },
            },
            {provide: ToastService, useValue: {success: () => undefined, httpError: () => undefined}},
            {provide: MinuteClockService, useValue: {now, retain: () => undefined}},
        ],
    });

    const fixture: ComponentFixture<EventsPanelComponent> = TestBed.createComponent(EventsPanelComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.componentRef.setInput('memberPermissions', memberPermissions);
    fixture.detectChanges();

    api.listPending[0].next(events);
    api.listPending[0].complete();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    const ids = (events: ScheduledEventDto[]) => events.map(e => e.id);

    return {
        fixture,
        component,
        now,
        live: () => ids(component['live']()),
        upcoming: () => ids(component['upcoming']()),
        past: () => ids(component['past']()),
        groups: () => component['upcomingGroups']()
            .map(g => [g.bucket, ids(g.events)] as [string, string[]]),
    };
}

describe('EventsPanelComponent live/upcoming/past split', () => {
    it('files an event that has started but not ended under live, not upcoming', () => {
        const {live, upcoming, past} = setup([
            event('running', {
                startsAt: new Date(NOW - 30 * MINUTE).toISOString(),
                endsAt: new Date(NOW + 30 * MINUTE).toISOString(),
            }),
        ]);

        expect(live()).toEqual(['running']);
        expect(upcoming()).toEqual([]);
        expect(past()).toEqual([]);
    });

    it('keeps a just-started event with no end time live rather than filing it under past', () => {
        // Before the grace window this event was live for zero seconds.
        const {live, past} = setup([
            event('open-ended', {startsAt: new Date(NOW - MINUTE).toISOString(), endsAt: null}),
        ]);

        expect(live()).toEqual(['open-ended']);
        expect(past()).toEqual([]);
    });

    it('treats a blank endsAt like an absent one instead of dropping the event from every list', () => {
        const {live, upcoming, past} = setup([
            event('blank-future', {startsAt: new Date(NOW + MINUTE).toISOString(), endsAt: ''}),
            event('blank-running', {startsAt: new Date(NOW - MINUTE).toISOString(), endsAt: ''}),
        ]);

        expect(upcoming()).toEqual(['blank-future']);
        expect(live()).toEqual(['blank-running']);
        expect(past()).toEqual([]);
    });

    it('walks an event from upcoming to live to past as the clock advances', () => {
        const {now, live, upcoming, past} = setup([
            event('e1', {
                startsAt: new Date(NOW + 10 * MINUTE).toISOString(),
                endsAt: new Date(NOW + 20 * MINUTE).toISOString(),
            }),
        ]);

        expect(upcoming()).toEqual(['e1']);

        now.set(NOW + 15 * MINUTE);
        expect(live()).toEqual(['e1']);
        expect(upcoming()).toEqual([]);

        now.set(NOW + 21 * MINUTE);
        expect(past()).toEqual(['e1']);
        expect(live()).toEqual([]);
    });

    it('orders past events most recent first', () => {
        const {past} = setup([
            event('older', {
                startsAt: new Date(NOW - 300 * MINUTE).toISOString(),
                endsAt: new Date(NOW - 290 * MINUTE).toISOString(),
            }),
            event('newer', {
                startsAt: new Date(NOW - 200 * MINUTE).toISOString(),
                endsAt: new Date(NOW - 190 * MINUTE).toISOString(),
            }),
        ]);

        expect(past()).toEqual(['newer', 'older']);
    });
});

describe('EventsPanelComponent day grouping', () => {
    it('groups upcoming events by calendar day in start order', () => {
        const {groups} = setup([
            event('today-1', {startsAt: new Date(2026, 7, 1, 18, 0).toISOString()}),
            event('today-2', {startsAt: new Date(2026, 7, 1, 20, 0).toISOString()}),
            event('tomorrow-1', {startsAt: new Date(2026, 7, 2, 9, 0).toISOString()}),
            event('later-1', {startsAt: new Date(2026, 7, 5, 9, 0).toISOString()}),
        ]);

        expect(groups()).toEqual([
            ['today', ['today-1', 'today-2']],
            ['tomorrow', ['tomorrow-1']],
            ['later', ['later-1']],
        ]);
    });

    it('gives two separate later days their own groups', () => {
        const {groups} = setup([
            event('a', {startsAt: new Date(2026, 7, 5, 9, 0).toISOString()}),
            event('b', {startsAt: new Date(2026, 7, 6, 9, 0).toISOString()}),
        ]);

        expect(groups().map(([bucket]) => bucket)).toEqual(['later', 'later']);
        expect(groups().map(([, ids]) => ids)).toEqual([['a'], ['b']]);
    });
});

describe('EventsPanelComponent empty state', () => {
    it('stays out of the empty state while an event is live', () => {
        const {component} = setup([
            event('running', {
                startsAt: new Date(NOW - MINUTE).toISOString(),
                endsAt: new Date(NOW + MINUTE).toISOString(),
            }),
        ]);

        expect(component['showEmpty']()).toBe(false);
    });

    it('shows the empty state when everything has finished', () => {
        const {component} = setup([
            event('done', {
                startsAt: new Date(NOW - 300 * MINUTE).toISOString(),
                endsAt: new Date(NOW - 290 * MINUTE).toISOString(),
            }),
        ]);

        expect(component['showEmpty']()).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ng test --include=src/app/features/guild/components/events-panel/events-panel.component.spec.ts`
Expected: FAIL — `component['live'] is not a function` and no `MinuteClockService` import resolution problems.

- [ ] **Step 3: Rewire the component class**

In `src/app/features/guild/components/events-panel/events-panel.component.ts`:

Replace the import block's Angular import and add the new ones:

```ts
import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked} from '@angular/core';
```

becomes

```ts
import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
```

and add, after the existing imports:

```ts
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {EventCardComponent} from './event-card.component';
import {DayBucket, dayBucket, phaseOf, startTime} from './event-timing';
```

Add the exported group type above the `@Component` decorator:

```ts
/** A run of consecutive upcoming events that share a day header. */
export interface EventDayGroup {
    /** Stable `@for` track key. The bucket name for today/tomorrow, the date string otherwise. */
    key: string;
    bucket: DayBucket;
    events: ScheduledEventDto[];
}
```

Add `EventCardComponent` to the component's `imports` array. `DatePipe` stays — the `later` day
header still formats a date:

```ts
imports: [DatePipe, TranslateModule, Button, Tooltip, ConfirmDialog, EventEditorDialogComponent, EventCardComponent],
```

Replace the `private readonly now = signal(...)` / `nowIntervalId` block, the `events`/`upcoming`/`past` computeds, and the `endBoundary` method with:

```ts
    // One shared clock rather than a per-component interval - the sidebar row and every voice
    // channel row read the same signal. See MinuteClockService for why ActivityTickerService
    // cannot be reused for future timestamps.
    protected readonly clock = inject(MinuteClockService);

    private readonly events = computed(() => this.store.eventsForGuild(this.guildId()));

    // Most recently started first: the thing that just began is the thing you are looking for.
    protected live = computed(() =>
        this.events()
            .filter(e => phaseOf(e, this.clock.now()) === 'live')
            .sort((a, b) => startTime(b) - startTime(a)));

    // `events()` is already ascending by start, and filter preserves order.
    protected upcoming = computed(() =>
        this.events().filter(e => phaseOf(e, this.clock.now()) === 'upcoming'));

    protected past = computed(() =>
        this.events().filter(e => phaseOf(e, this.clock.now()) === 'past').reverse());

    /**
     * Upcoming events cut into day groups. Consecutive-run grouping is only correct because
     * `upcoming()` is sorted ascending by start - which it is, from the store.
     */
    protected upcomingGroups = computed<EventDayGroup[]>(() => {
        const now = this.clock.now();
        const groups: EventDayGroup[] = [];

        for (const event of this.upcoming()) {
            const bucket = dayBucket(event.startsAt, now);
            const key = bucket === 'later' ? new Date(event.startsAt).toDateString() : bucket;
            const last = groups.at(-1);

            if (last?.key === key) last.events.push(event);
            else groups.push({key, bucket, events: [event]});
        }

        return groups;
    });
```

Update the load-state computeds so a live event no longer reads as empty:

```ts
    protected showEmpty = computed(() =>
        !this.showLoading() && !this.showError()
        && this.live().length === 0 && this.upcoming().length === 0);
```

In the constructor, retain the clock and drop the interval cleanup:

```ts
    constructor() {
        this.clock.retain();

        // `loadFor` reads AND patches loadingGuilds/loadedGuilds internally -tracking
        // only `guildId()` here (and calling loadFor untracked) keeps this effect from
        // re-running itself into a request storm off the store's own state changes.
        effect(() => {
            const id = this.guildId();
            untracked(() => this.store.loadFor(id));
        });

        // No websocket subscriptions here on purpose: ScheduledEventStore's own onInit
        // hook already subscribes to eventCreated/eventUpdated/eventCancelled and
        // dispatches to the exact same store methods. Duplicating them here only worked
        // because the store's hook happened to run first.
    }
```

Delete the now-unused `destroyRef` field and the `endBoundary` method entirely. Keep `retry`, `openCreate`, `openEdit`, `confirmCancel`, `toggleInterest` and `joinVoice` as they are, and delete `voiceChannelName` — `EventCardComponent` resolves that itself now.

- [ ] **Step 4: Rewrite the template**

Replace the whole of `src/app/features/guild/components/events-panel/events-panel.component.html`:

```html
<div class="hidden lg:flex flex-col w-80 shrink-0 h-full bg-sidebar border-r border-white/[0.10]">

    <!-- Header -->
    <div class="flex items-center gap-1.5 px-3 py-3 border-b border-white/[0.10] shrink-0">
        <p-button (onClick)="navService.closeEventsPanel()" [pTooltip]="'COMMON.CLOSE' | translate" [text]="true"
                  icon="pi pi-times" severity="secondary" size="small" tooltipPosition="bottom"/>
        <span class="flex-1 min-w-0 truncate text-sm font-semibold text-text-primary">{{ 'EVENTS.TITLE' | translate }}</span>
        @if (canManage()) {
            <p-button (onClick)="openCreate()" [pTooltip]="'EVENTS.CREATE_TOOLTIP' | translate" [text]="true"
                      icon="pi pi-plus" severity="secondary" size="small" tooltipPosition="bottom"/>
        }
    </div>

    <!-- Body -->
    <div class="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-3 py-3">

        @if (showLoading()) {
            <p class="flex items-center justify-center gap-2 py-8 m-0 text-[0.8125rem] text-text-muted">
                <i class="pi pi-spin pi-spinner text-[0.75rem]"></i>{{ 'COMMON.LOADING' | translate }}
            </p>
        } @else if (showError()) {
            <div class="flex flex-col items-center gap-2 py-8">
                <p class="m-0 text-center text-[0.8125rem] text-text-secondary">{{ 'EVENTS.LOAD_ERROR' | translate }}</p>
                <p-button (onClick)="retry()" [label]="'COMMON.RETRY' | translate" [text]="true" icon="pi pi-refresh"
                          severity="secondary" size="small"/>
            </div>
        } @else if (showEmpty()) {
            <div class="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <div class="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.04]">
                    <i class="pi pi-calendar text-[1.125rem] text-text-muted"></i>
                </div>
                <div>
                    <p class="m-0 text-[0.875rem] font-semibold text-text-primary">{{ 'EVENTS.EMPTY_TITLE' | translate }}</p>
                    <p class="m-0 mt-1 text-[0.8125rem] text-text-secondary">{{ 'EVENTS.EMPTY_SUBTITLE' | translate }}</p>
                </div>
                @if (canManage()) {
                    <p-button (onClick)="openCreate()" [label]="'EVENTS.CREATE_FIRST' | translate" icon="pi pi-plus"
                              severity="primary" size="small"/>
                }
                <p class="m-0 mt-1 text-[0.6875rem] leading-relaxed text-text-muted">
                    {{ 'EVENTS.NO_REMINDERS_NOTE' | translate }}
                </p>
            </div>
        } @else {

            @if (live().length > 0) {
                <h3 class="mb-2 px-1 text-[0.6875rem] font-semibold uppercase tracking-widest text-text-muted">
                    {{ 'EVENTS.HAPPENING_NOW' | translate }}
                </h3>
                <div class="mb-5 space-y-2">
                    @for (event of live(); track event.id) {
                        <app-event-card (cancel)="confirmCancel(event)"
                                        (edit)="openEdit(event)"
                                        (interest)="toggleInterest(event)"
                                        (joinVoice)="joinVoice(event.voiceChannelId!)"
                                        [canManage]="canManage()"
                                        [event]="event"
                                        phase="live"/>
                    }
                </div>
            }

            @for (group of upcomingGroups(); track group.key) {
                <h3 class="mb-2 px-1 text-[0.6875rem] font-semibold uppercase tracking-widest text-text-muted">
                    @switch (group.bucket) {
                        @case ('today') {
                            {{ 'EVENTS.TODAY' | translate }}
                        }
                        @case ('tomorrow') {
                            {{ 'EVENTS.TOMORROW' | translate }}
                        }
                        @default {
                            {{ group.events[0].startsAt | date:'EEE, MMM d' }}
                        }
                    }
                </h3>
                <div class="mb-5 space-y-2">
                    @for (event of group.events; track event.id) {
                        <app-event-card (cancel)="confirmCancel(event)"
                                        (edit)="openEdit(event)"
                                        (interest)="toggleInterest(event)"
                                        (joinVoice)="joinVoice(event.voiceChannelId!)"
                                        [canManage]="canManage()"
                                        [event]="event"
                                        phase="upcoming"/>
                    }
                </div>
            }
        }

        <!-- Past events -->
        @if (past().length > 0) {
            <button (click)="showPast.set(!showPast())"
                    class="flex items-center gap-1.5 border-0 bg-transparent px-1 py-1 cursor-pointer
                           text-[0.6875rem] font-semibold uppercase tracking-widest text-text-muted
                           hover:text-text-secondary transition-colors">
                <i [class.pi-chevron-down]="showPast()" [class.pi-chevron-right]="!showPast()" class="pi text-[0.625rem]"></i>
                {{ 'EVENTS.PAST' | translate }} ({{ past().length }})
            </button>

            @if (showPast()) {
                <div class="mt-2 space-y-2 opacity-60">
                    @for (event of past(); track event.id) {
                        <app-event-card [canManage]="false" [event]="event" phase="past"/>
                    }
                </div>
            }
        }
    </div>
</div>

<p-confirmdialog appendTo="body"/>

<app-event-editor-dialog [event]="editingEvent()" [guildId]="guildId()" [(visible)]="editorVisible"/>
```

Note the `DatePipe` is still used here (the `later` day header), so keep `DatePipe` in the component's `imports` after all — the Step 3 instruction to drop it applies only if you removed that header. Keep it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `ng test --include=src/app/features/guild/components/events-panel/events-panel.component.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify the app builds**

Run: `ng build --configuration development`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/events-panel/
git commit -m "feat(events): a live section, day-grouped upcoming, and a real empty state"
```

---

### Task 7: Sidebar Events row

**Files:**
- Modify: `src/app/features/guild/components/channel-list/channel-list.component.ts`
- Modify: `src/app/features/guild/components/channel-list/channel-list.component.html:13-31`

**Interfaces:**
- Consumes: `phaseOf` (Task 2), `MinuteClockService` (Task 1), `ScheduledEventStore`, `.event-live-dot` (Task 4), `EVENTS.TITLE` / `EVENTS.LIVE`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the derivations to the component**

In `src/app/features/guild/components/channel-list/channel-list.component.ts`, add to the imports:

```ts
import {ScheduledEventStore} from '../../../../stores/scheduled-event.store';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {phaseOf} from '../events-panel/event-timing';
```

Add the fields, next to the existing `isWikiActive`:

```ts
    private eventStore = inject(ScheduledEventStore);
    private minuteClock = inject(MinuteClockService);

    protected isEventsActive = computed(() => this.navService.eventsPanelGuildId() === this.guild().id);

    private guildEvents = computed(() => this.eventStore.eventsForGuild(this.guild().id));

    protected hasLiveEvent = computed(() =>
        this.guildEvents().some(e => phaseOf(e, this.minuteClock.now()) === 'live'));

    protected upcomingEventCount = computed(() =>
        this.guildEvents().filter(e => phaseOf(e, this.minuteClock.now()) === 'upcoming').length);
```

In the constructor, add:

```ts
        this.minuteClock.retain();

        // The badge has to be truthful before the panel has ever been opened, so the list is
        // fetched here rather than only by the panel. `loadFor` is idempotent inside its TTL, so
        // the panel's own effect becomes a no-op instead of a second request.
        //
        // It also makes the guild `isTracked` in the store, which is what
        // `applyRealtimeCreatedOrUpdated` gates on - without this, an event created by someone
        // else is dropped on the floor until you have opened the panel once.
        effect(() => {
            const id = this.guild().id;
            if (!this.hasEvents()) return;
            untracked(() => this.eventStore.loadFor(id));
        });
```

- [ ] **Step 2: Replace the wiki/events row in the template**

In `src/app/features/guild/components/channel-list/channel-list.component.html`, replace lines 13–31 (the `<!-- Wiki quick-link + events. -->` block) with:

```html
    <!-- Wiki quick-link + events. Both are modules: absent when switched off, never greyed out.
         Stacked rather than sharing a row - Events carries a label, a count and a live badge,
         none of which fit beside the Wiki link. -->
    @if (hasWiki() || hasEvents()) {
        <div class="px-2 pt-2 shrink-0 flex flex-col gap-0.5 mb-1">
            @if (hasWiki()) {
                <button (click)="openWiki()"
                        [ngClass]="isWikiActive() ? 'bg-white/[0.08] text-white/95' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/90'"
                        class="w-full flex items-center gap-2.5 px-2 py-[7px] rounded-lg text-left transition-all border-0 cursor-pointer">
                    <i [ngClass]="isWikiActive() ? 'text-brand-dim' : 'text-white/35'"
                       class="pi pi-book text-[13px] shrink-0"></i>
                    <span class="text-[15px] font-medium">{{ 'GUILD.WIKI' | translate }}</span>
                </button>
            }
            @if (hasEvents()) {
                <button (click)="toggleEvents()"
                        [ngClass]="isEventsActive() ? 'bg-white/[0.08] text-white/95' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/90'"
                        class="w-full flex items-center gap-2.5 px-2 py-[7px] rounded-lg text-left transition-all border-0 cursor-pointer">
                    <i [ngClass]="isEventsActive() ? 'text-brand-dim' : 'text-white/35'"
                       class="pi pi-calendar text-[13px] shrink-0"></i>
                    <span class="text-[15px] font-medium">{{ 'EVENTS.TITLE' | translate }}</span>

                    <!-- Live wins over the count: "something is on right now" is the more urgent
                         of the two, and both together is noise in a 15px row. -->
                    @if (hasLiveEvent()) {
                        <span class="ml-auto shrink-0 flex items-center gap-1.5">
                            <span class="event-live-dot"></span>
                            <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-online">
                                {{ 'EVENTS.LIVE' | translate }}
                            </span>
                        </span>
                    } @else if (upcomingEventCount() > 0) {
                        <span class="ml-auto shrink-0 min-w-[1.25rem] rounded-full bg-white/[0.08] px-1.5 py-0.5
                                     text-center text-[0.625rem] font-semibold text-white/60">
                            {{ upcomingEventCount() }}
                        </span>
                    }
                </button>
            }
        </div>
    }
```

- [ ] **Step 3: Verify the build and the existing suite**

Run: `ng build --configuration development`
Expected: build succeeds.

Run: `ng test`
Expected: the full suite passes, including the events-panel and event-timing files.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/channel-list/channel-list.component.ts src/app/features/guild/components/channel-list/channel-list.component.html
git commit -m "feat(events): a labelled Events row with an upcoming count and a live badge"
```

---

### Task 8: LIVE pill on the voice channel row

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/voice-channel-item/voice-channel-item.component.ts`
- Modify: `src/app/features/guild/components/channel-list/components/voice-channel-item/voice-channel-item.component.html:20-24`

**Interfaces:**
- Consumes: `phaseOf` (Task 2), `MinuteClockService` (Task 1), `ScheduledEventStore`, `.event-live-dot` (Task 4), `EVENTS.LIVE`.

- [ ] **Step 1: Add the derivation to the component**

In `voice-channel-item.component.ts`, add to the imports:

```ts
import {TranslateModule} from '@ngx-translate/core';
import {Tooltip} from 'primeng/tooltip';
import {ScheduledEventDto} from '../../../../../../dtos/response/scheduled-event.dto';
import {ScheduledEventStore} from '../../../../../../stores/scheduled-event.store';
import {MinuteClockService} from '../../../../../../services/minute-clock.service';
import {phaseOf} from '../../../events-panel/event-timing';
```

Extend the component's `imports` array:

```ts
    imports: [NgClass, VoiceParticipantRowComponent, TranslateModule, Tooltip],
```

Add the fields and a constructor:

```ts
    private eventStore = inject(ScheduledEventStore);
    private minuteClock = inject(MinuteClockService);

    /**
     * Derived here rather than passed in, matching how this component already reaches for
     * `participants`, `isJoined` and `isActive`. Threading it down as an input would have to
     * cross `channel-list-items`, whose whole job is drag-and-drop ordering and which has no
     * other reason to know events exist.
     */
    protected liveEvent = computed<ScheduledEventDto | null>(() => {
        const now = this.minuteClock.now();
        const channelId = this.channel().id;

        return this.eventStore.eventsForGuild(this.channel().guildId)
            .find(e => e.voiceChannelId === channelId && phaseOf(e, now) === 'live') ?? null;
    });

    constructor() {
        this.minuteClock.retain();
    }
```

- [ ] **Step 2: Add the pill to the template**

In `voice-channel-item.component.html`, replace this block:

```html
        @if (channel().isPrivate) {
            <i class="pi pi-lock text-[11px] text-white/35 ml-auto shrink-0"></i>
        } @else if (participants().length > 0) {
            <span class="ml-auto text-[11px] text-white/40 shrink-0">{{ participants().length }}</span>
        }
```

with:

```html
        <!-- Lock first: it is a permission fact and must not be displaced by a transient one.
             The LIVE pill then outranks the participant count, which is redundant anyway - every
             participant is already listed as a row directly beneath this one. -->
        @if (channel().isPrivate) {
            <i class="pi pi-lock text-[11px] text-white/35 ml-auto shrink-0"></i>
        } @else if (liveEvent(); as event) {
            <span [pTooltip]="event.title"
                  class="ml-auto shrink-0 flex items-center gap-1 rounded-md bg-online/15 px-1.5 py-0.5"
                  tooltipPosition="right">
                <span class="event-live-dot"></span>
                <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-online">
                    {{ 'EVENTS.LIVE' | translate }}
                </span>
            </span>
        } @else if (participants().length > 0) {
            <span class="ml-auto text-[11px] text-white/40 shrink-0">{{ participants().length }}</span>
        }
```

- [ ] **Step 3: Verify the build and the full suite**

Run: `ng build --configuration development`
Expected: build succeeds.

Run: `ng test`
Expected: the full suite passes.

- [ ] **Step 4: Commit and push**

```bash
git add src/app/features/guild/components/channel-list/components/voice-channel-item/
git commit -m "feat(events): mark the voice channel an event is running in"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `event-timing.ts` (`endBoundary`, `phaseOf`, `dayBucket`, grace window) | 2 |
| `MinuteClockService` | 1 |
| Panel: live / day-grouped upcoming / past sections | 6 |
| Panel: card redesign, hover toolbar, two-element footer | 5 |
| Panel: empty state, footer note relocated, `+` tooltip | 6 |
| Sidebar: stacked rows, label, active state, count, live dot | 7 |
| Sidebar: `loadFor` effect for a truthful badge | 7 |
| Voice channel LIVE pill with lock > live > count precedence | 8 |
| i18n keys in en/de/fr, submodule commit and push | 3 |
| Existing panel spec updated for the grace window | 6 |

**Type consistency:** `phaseOf(event, now)` is called with that argument order in Tasks 6, 7 and 8. `startTime`/`dayBucket`/`EventPhase`/`DayBucket` are defined in Task 2 and used unchanged. `MinuteClockService.now` is a `Signal<number>` read as `clock.now()` everywhere; `retain()` takes no arguments and is called from a constructor in Tasks 5, 6, 7 and 8. `EventCardComponent`'s four outputs (`edit`, `cancel`, `interest`, `joinVoice`) match the four handlers bound in Task 6.

**Known ordering constraint:** Task 4 (`.event-live-dot`) must land before Tasks 5, 7 and 8, which all reference the class. Task 3 must land before Tasks 5–8, which reference its keys.
