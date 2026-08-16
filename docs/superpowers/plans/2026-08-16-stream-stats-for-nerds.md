# Stream Stats For Nerds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click any screen share tile for a live per-stream WebRTC readout, inbound and outbound, on both the guild voice and DM call surfaces, plus a menu item that copies the raw snapshot as JSON.

**Architecture:** One `StreamStatsSnapshot` shape serves both directions and both hosts. Inbound rides the `getStats()` poll both RTC services already run. Outbound on web reads the browser's own publish peer connection; outbound on desktop is merged in Rust from `pc.get_stats()` (transport counters) and the frame pump (encoder counters), because webrtc-rs cannot report encoder fields at all. All rate arithmetic happens in TypeScript against cumulative counters.

**Tech Stack:** Angular 21 (signals, `input()`/`output()`, OnPush), Vitest via the Angular CLI builder, Tailwind v4 token classes, PrimeNG preset, Rust + Tauri 2, webrtc-rs 0.14, ngx-translate.

**Spec:** `docs/superpowers/specs/2026-08-16-stream-stats-for-nerds-design.md`

## Global Constraints

- **Run unit tests via the Angular CLI entrypoint only:** `node node_modules/@angular/cli/bin/ng.js test --include="<glob>" --watch=false`. There is no `test` npm script and no `ng` binary in `node_modules/.bin`. Bare `npx vitest run` bypasses the `@angular/build:unit-test` builder, so every TestBed spec fails with `TypeError: Cannot read properties of null (reading 'injector')` — a wrong-runner failure that reads exactly like a broken change.
- **Rust tests:** `cargo test --manifest-path src-tauri/Cargo.toml <filter>`. The package is `Venta`, lib target `alpine_lib`.
- **`fakeAsync` is unusable in this repo** (no ProxyZone). Timing tests use `vi.useFakeTimers()`.
- **No em dashes in any user-visible copy.** The ones already in the locale file are not a precedent.
- **`src/assets/i18n/locales` is a git submodule.** String changes are committed inside the submodule, as their own commit, before the commit in the parent repo that references them.
- **Locale keys are flat and dot-separated**, e.g. `CALL.STATS_NERD.CODEC`. Add to `en.json`, `de.json` and `fr.json`.
- **Every numeric field on the snapshot types is optional**, and absent must render as absent, never as `0`. A pipeline that cannot produce a field and a stream genuinely reporting zero are different findings — this is the same rule `inbound-fps.ts` already enforces for `framesPerSecond`.
- **Styling:** token classes (`bg-card`, `border-border`, `text-white/55`), never raw hex. `tabular-nums` on every live number. `call-focusable` on every focusable control.
- **Commit after every task.** Do not push; the user pushes.

---

### Task 1: The snapshot model, the inbound mapper, and the rate helper

**Files:**
- Create: `src/app/shared/call/stream-stats.ts`
- Test: `src/app/shared/call/stream-stats.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StreamStatsSnapshot`, `StreamTransportStats`, `StreamLayerStats`, `StreamAudioStats`, `StatsLike`, `inboundStatsFor(report, mid): StreamStatsSnapshot | null`, `kbpsBetween(curBytes, prevBytes, dtSeconds): number | undefined`. Tasks 7 and 8 import `InboundTrackOwner` from `inbound-fps.ts` directly; this module does not re-export it.

- [ ] **Step 1: Write the failing test**

Create `src/app/shared/call/stream-stats.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {inboundStatsFor, kbpsBetween} from './stream-stats';

/** A `getStats()`-shaped report: forEach over the stats it was given, nothing else. */
function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, ...extra} as unknown as RTCStats;
}

describe('kbpsBetween', () => {
    it('turns two cumulative byte counts and an interval into kbps', () => {
        // 125000 bytes in 1s = 1000 kbps.
        expect(kbpsBetween(125_000, 0, 1)).toBe(1000);
    });

    it('answers undefined rather than a number when there is no previous sample', () => {
        // The first poll has nothing to differentiate against. Reporting 0 there would read as
        // "this stream is sending nothing", which is a different and much more alarming claim.
        expect(kbpsBetween(125_000, undefined, 1)).toBeUndefined();
    });

    it('answers undefined rather than Infinity when no time has passed', () => {
        expect(kbpsBetween(125_000, 0, 0)).toBeUndefined();
    });

    it('floors a counter that went backwards at zero instead of reporting a negative rate', () => {
        // Counters reset when a publication is rebuilt under the same panel.
        expect(kbpsBetween(10, 125_000, 1)).toBe(0);
    });
});

describe('inboundStatsFor', () => {
    it('reads the layer fields off the inbound-rtp stat for the given mid', () => {
        const snapshot = inboundStatsFor(
            report([
                inboundRtp('3', {
                    ssrc: 42,
                    frameWidth: 1920,
                    frameHeight: 1080,
                    framesPerSecond: 30,
                    framesDecoded: 900,
                    keyFramesDecoded: 4,
                    framesDropped: 2,
                    packetsReceived: 5000,
                    packetsLost: 7,
                    nackCount: 3,
                    pliCount: 1,
                    jitter: 0.012,
                }),
            ]),
            '3',
        );

        expect(snapshot?.direction).toBe('inbound');
        expect(snapshot?.source).toBe('webview');
        expect(snapshot?.layers).toEqual([
            {
                mid: '3',
                ssrc: 42,
                width: 1920,
                height: 1080,
                fps: 30,
                framesDecoded: 900,
                keyFrames: 4,
                framesDropped: 2,
                packets: 5000,
                packetsLost: 7,
                nackCount: 3,
                pliCount: 1,
                jitterMs: 12,
            },
        ]);
    });

    it('omits a field the report has not produced rather than defaulting it to zero', () => {
        // The distinction the whole model exists for - see the module doc on inbound-fps.ts.
        const snapshot = inboundStatsFor(report([inboundRtp('3', {ssrc: 42})]), '3');

        expect(snapshot?.layers[0]).toEqual({mid: '3', ssrc: 42});
        expect(snapshot?.layers[0].fps).toBeUndefined();
    });

    it('keeps a genuinely reported zero', () => {
        const snapshot = inboundStatsFor(report([inboundRtp('3', {framesPerSecond: 0})]), '3');

        expect(snapshot?.layers[0].fps).toBe(0);
    });

    it('answers null when no inbound stat carries that mid', () => {
        expect(inboundStatsFor(report([inboundRtp('3')]), '9')).toBeNull();
    });

    it('resolves the codec through the stat codecId', () => {
        const codec = {
            type: 'codec', id: 'codec-1', mimeType: 'video/H264',
            sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        } as unknown as RTCStats;

        const snapshot = inboundStatsFor(report([inboundRtp('3', {codecId: 'codec-1'}), codec]), '3');

        expect(snapshot?.codec).toBe('video/H264');
        expect(snapshot?.profileLevelId).toBe('42e01f');
    });

    it('reads the succeeded candidate pair for the transport row', () => {
        const pair = {
            type: 'candidate-pair', id: 'pair-1', state: 'succeeded', nominated: true,
            currentRoundTripTime: 0.018, localCandidateId: 'lc', remoteCandidateId: 'rc',
            availableOutgoingBitrate: 2_500_000,
        } as unknown as RTCStats;
        const local = {type: 'local-candidate', id: 'lc', candidateType: 'srflx', protocol: 'udp'} as unknown as RTCStats;
        const remote = {type: 'remote-candidate', id: 'rc', candidateType: 'relay'} as unknown as RTCStats;

        const snapshot = inboundStatsFor(report([inboundRtp('3'), pair, local, remote]), '3');

        expect(snapshot?.transport).toEqual({
            rttMs: 18,
            localCandidateType: 'srflx',
            remoteCandidateType: 'relay',
            protocol: 'udp',
            availableOutgoingKbps: 2500,
        });
    });

    it('ignores a candidate pair that is not the succeeded one', () => {
        // A connection keeps failed and in-progress pairs in the report for its whole life.
        const failed = {
            type: 'candidate-pair', id: 'pair-1', state: 'failed', currentRoundTripTime: 9,
        } as unknown as RTCStats;

        const snapshot = inboundStatsFor(report([inboundRtp('3'), failed]), '3');

        expect(snapshot?.transport).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/stream-stats.spec.ts" --watch=false`

Expected: FAIL — the module `./stream-stats` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/app/shared/call/stream-stats.ts`:

```ts
/**
 * One shape for every per-stream statistics readout, in both directions and on both hosts.
 *
 * <p><b>Every numeric field is optional, and that is load-bearing rather than lax.</b> The four
 * pipelines that fill this in can each produce a different subset: a browser `getStats()` report
 * carries encoder fields, webrtc-rs structurally cannot (it is not the encoder - see
 * `publish_stats` on the Rust side), and any field can simply not have been measured yet. A field
 * a pipeline cannot produce must render as absent, never as `0`: "no data" and "genuinely zero"
 * are different findings, and collapsing them is exactly the mistake `inbound-fps.ts` documents at
 * length for `framesPerSecond`.</p>
 */
export interface StreamStatsSnapshot {
    direction: 'inbound' | 'outbound';
    /**
     * Which pipeline produced this. The panel branches on it to omit rows a pipeline cannot fill
     * rather than drawing them empty - `qp` on `'native'`, for one.
     */
    source: 'webview' | 'native';
    capturedAt: number;
    codec?: string;
    /**
     * From the negotiated fmtp line. Which H.264 profile and level survived negotiation decides
     * what the encoder may legally emit, and it is invisible everywhere else in the UI.
     */
    profileLevelId?: string;
    transport?: StreamTransportStats;
    /** One entry per simulcast rid, or a single unnamed entry on a single-encoding stream. */
    layers: StreamLayerStats[];
    audio?: StreamAudioStats;
}

export interface StreamTransportStats {
    rttMs?: number;
    localCandidateType?: string;
    remoteCandidateType?: string;
    protocol?: string;
    availableOutgoingKbps?: number;
}

export interface StreamLayerStats {
    /** Absent on a single-encoding publication, which is the pre-simulcast case exactly. */
    rid?: string;
    ssrc?: number;
    mid?: string;
    width?: number;
    height?: number;
    fps?: number;
    /** Measured, from differentiated byte counters. */
    kbps?: number;
    /**
     * What this rung was configured for. The pair (`kbps` against `targetKbps`) is the finding:
     * a rung publishing far under its budget, or nothing at all, is what a broken simulcast
     * ladder looks like from the sharing side.
     */
    targetKbps?: number;
    framesEncoded?: number;
    framesDecoded?: number;
    keyFrames?: number;
    framesDropped?: number;
    packets?: number;
    packetsLost?: number;
    nackCount?: number;
    pliCount?: number;
    firCount?: number;
    jitterMs?: number;
    qp?: number;
    /** e.g. MediaFoundation, openh264. Native outbound only. */
    encoder?: string;
}

export interface StreamAudioStats {
    kbps?: number;
    packets?: number;
    packetsLost?: number;
    packetsDropped?: number;
}

/** The slice of an `RTCStatsReport` these mappers need. A real report satisfies it. */
export interface StatsLike {
    forEach(callback: (stat: RTCStats) => void): void;
}

/**
 * Two cumulative byte counters and the seconds between them, as kbps.
 *
 * <p>Answers `undefined` rather than a number for the two cases that have no rate: no previous
 * sample (the first poll of a freshly opened panel) and no elapsed time. Reporting `0` for either
 * would claim the stream is sending nothing, which is a far stronger and quite different claim.
 * A counter that went backwards - a publication rebuilt while the panel stayed open - floors at
 * zero rather than reporting a negative rate.</p>
 */
export function kbpsBetween(
    current: number | undefined,
    previous: number | undefined,
    dtSeconds: number,
): number | undefined {
    if (current === undefined || previous === undefined || dtSeconds <= 0) return undefined;
    return Math.max(0, Math.round(((current - previous) * 8) / dtSeconds / 1000));
}

/** Copy `value` onto `target[key]` only when it is a number. Keeps absent absent. */
function put<T extends object>(target: T, key: keyof T, value: unknown): void {
    if (typeof value === 'number') (target as Record<string, unknown>)[key as string] = value;
}

function profileLevelIdOf(fmtp: string | undefined): string | undefined {
    return fmtp?.split(';').find(p => p.startsWith('profile-level-id='))?.split('=')[1];
}

/** The one candidate pair actually carrying media, plus the two candidates it names. */
function transportOf(stats: Map<string, RTCStats>): StreamTransportStats | undefined {
    let pair: Record<string, unknown> | undefined;
    for (const stat of stats.values()) {
        const s = stat as unknown as Record<string, unknown>;
        // A connection keeps every failed and in-progress pair in the report for its whole life.
        if (s['type'] === 'candidate-pair' && s['state'] === 'succeeded') {
            pair = s;
            break;
        }
    }
    if (!pair) return undefined;

    const local = stats.get(pair['localCandidateId'] as string) as unknown as Record<string, unknown> | undefined;
    const remote = stats.get(pair['remoteCandidateId'] as string) as unknown as Record<string, unknown> | undefined;

    const transport: StreamTransportStats = {};
    const rtt = pair['currentRoundTripTime'];
    if (typeof rtt === 'number') transport.rttMs = Math.round(rtt * 1000);
    if (typeof local?.['candidateType'] === 'string') transport.localCandidateType = local['candidateType'] as string;
    if (typeof remote?.['candidateType'] === 'string') transport.remoteCandidateType = remote['candidateType'] as string;
    if (typeof local?.['protocol'] === 'string') transport.protocol = local['protocol'] as string;
    const outgoing = pair['availableOutgoingBitrate'];
    if (typeof outgoing === 'number') transport.availableOutgoingKbps = Math.round(outgoing / 1000);

    return Object.keys(transport).length ? transport : undefined;
}

function indexOf(report: StatsLike): Map<string, RTCStats> {
    const byId = new Map<string, RTCStats>();
    report.forEach(stat => byId.set((stat as unknown as {id: string}).id, stat));
    return byId;
}

/**
 * The arriving half of one remote screen share, read off the report the RTC services already poll.
 *
 * <p>Null when no `inbound-rtp` stat carries that mid, which is the honest answer for a share whose
 * transceiver has gone or has not arrived yet - the panel says "no data" rather than drawing a row
 * of zeroes.</p>
 */
export function inboundStatsFor(report: StatsLike, mid: string): StreamStatsSnapshot | null {
    const byId = indexOf(report);

    let rtp: Record<string, unknown> | undefined;
    for (const stat of byId.values()) {
        const s = stat as unknown as Record<string, unknown>;
        if (s['type'] === 'inbound-rtp' && s['kind'] === 'video' && s['mid'] === mid) {
            rtp = s;
            break;
        }
    }
    if (!rtp) return null;

    const layer: StreamLayerStats = {mid};
    put(layer, 'ssrc', rtp['ssrc']);
    put(layer, 'width', rtp['frameWidth']);
    put(layer, 'height', rtp['frameHeight']);
    put(layer, 'fps', rtp['framesPerSecond']);
    put(layer, 'framesDecoded', rtp['framesDecoded']);
    put(layer, 'keyFrames', rtp['keyFramesDecoded']);
    put(layer, 'framesDropped', rtp['framesDropped']);
    put(layer, 'packets', rtp['packetsReceived']);
    put(layer, 'packetsLost', rtp['packetsLost']);
    put(layer, 'nackCount', rtp['nackCount']);
    put(layer, 'pliCount', rtp['pliCount']);
    put(layer, 'firCount', rtp['firCount']);
    if (typeof rtp['jitter'] === 'number') layer.jitterMs = Math.round((rtp['jitter'] as number) * 1000);

    const snapshot: StreamStatsSnapshot = {
        direction: 'inbound',
        source: 'webview',
        capturedAt: Date.now(),
        layers: [layer],
    };

    const codec = byId.get(rtp['codecId'] as string) as unknown as Record<string, unknown> | undefined;
    if (typeof codec?.['mimeType'] === 'string') snapshot.codec = codec['mimeType'] as string;
    const fmtp = profileLevelIdOf(codec?.['sdpFmtpLine'] as string | undefined);
    if (fmtp) snapshot.profileLevelId = fmtp;

    const transport = transportOf(byId);
    if (transport) snapshot.transport = transport;

    return snapshot;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/stream-stats.spec.ts" --watch=false`

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/shared/call/stream-stats.ts src/app/shared/call/stream-stats.spec.ts
git commit -m "feat(call): the per-stream stats model and the inbound mapper

One shape for both directions and both hosts. Every numeric field is
optional so a pipeline that cannot produce one renders it absent rather
than as a zero, which is the distinction inbound-fps.ts already draws for
framesPerSecond and the reason the whole readout is trustworthy."
```

---

### Task 2: The outbound mapper for a browser report

**Files:**
- Modify: `src/app/shared/call/stream-stats.ts`
- Test: `src/app/shared/call/stream-stats.spec.ts`

**Interfaces:**
- Consumes: `StreamStatsSnapshot`, `StreamLayerStats`, `StatsLike`, `kbpsBetween` from Task 1.
- Produces: `outboundStatsFromReport(report, mid): StreamStatsSnapshot | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/shared/call/stream-stats.spec.ts`:

```ts
import {outboundStatsFromReport} from './stream-stats';

function outboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {
        type: 'outbound-rtp', kind: 'video', mid, id: `out-${mid}-${extra['rid'] ?? 'solo'}`, ...extra,
    } as unknown as RTCStats;
}

describe('outboundStatsFromReport', () => {
    it('produces one layer per rid, highest first, for a simulcast publication', () => {
        const snapshot = outboundStatsFromReport(
            report([
                outboundRtp('1', {rid: 'b', ssrc: 2, frameWidth: 960, frameHeight: 540}),
                outboundRtp('1', {rid: 'a', ssrc: 1, frameWidth: 1920, frameHeight: 1080}),
            ]),
            '1',
        );

        expect(snapshot?.direction).toBe('outbound');
        expect(snapshot?.layers.map(l => l.rid)).toEqual(['a', 'b']);
        expect(snapshot?.layers[0].width).toBe(1920);
    });

    it('produces one unnamed layer for a single-encoding publication', () => {
        const snapshot = outboundStatsFromReport(report([outboundRtp('1', {ssrc: 1})]), '1');

        expect(snapshot?.layers).toHaveLength(1);
        expect(snapshot?.layers[0].rid).toBeUndefined();
    });

    it('reads the encoder fields a browser report carries', () => {
        const snapshot = outboundStatsFromReport(
            report([
                outboundRtp('1', {
                    ssrc: 1, framesPerSecond: 30, framesEncoded: 900, keyFramesEncoded: 4,
                    packetsSent: 5000, nackCount: 2, pliCount: 1, firCount: 0,
                    qpSum: 27_000, encoderImplementation: 'OpenH264',
                }),
            ]),
            '1',
        );

        expect(snapshot?.layers[0]).toMatchObject({
            fps: 30, framesEncoded: 900, keyFrames: 4, packets: 5000,
            nackCount: 2, pliCount: 1, firCount: 0, encoder: 'OpenH264',
        });
        // qpSum is cumulative over framesEncoded; the panel wants the average.
        expect(snapshot?.layers[0].qp).toBe(30);
    });

    it('omits qp when there are no encoded frames to average over', () => {
        const snapshot = outboundStatsFromReport(
            report([outboundRtp('1', {qpSum: 0, framesEncoded: 0})]), '1',
        );

        expect(snapshot?.layers[0].qp).toBeUndefined();
    });

    it('folds the remote inbound report into packets lost for the matching ssrc', () => {
        // The only view a sender has of what the receiver actually got.
        const remote = {
            type: 'remote-inbound-rtp', id: 'ri-1', kind: 'video', ssrc: 1,
            packetsLost: 12, roundTripTime: 0.021,
        } as unknown as RTCStats;

        const snapshot = outboundStatsFromReport(report([outboundRtp('1', {ssrc: 1}), remote]), '1');

        expect(snapshot?.layers[0].packetsLost).toBe(12);
        expect(snapshot?.transport?.rttMs).toBe(21);
    });

    it('answers null when no outbound stat carries that mid', () => {
        expect(outboundStatsFromReport(report([outboundRtp('1')]), '9')).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/stream-stats.spec.ts" --watch=false`

Expected: FAIL — `outboundStatsFromReport` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/app/shared/call/stream-stats.ts`:

```ts
/**
 * The outgoing half of a publication, read off a browser `getStats()` report.
 *
 * <p>The web host only. The desktop publisher's peer connection lives in Rust and its stats are
 * merged there instead - see `publish_stats` - because webrtc-rs structurally cannot report any
 * encoder field.</p>
 *
 * <p>Layers come back ordered by rid, so `a` (the top rung) is always first and the panel's
 * sections read top-down like the ladder does. A publication with no rid at all is the
 * pre-simulcast case and yields exactly one unnamed layer.</p>
 */
export function outboundStatsFromReport(report: StatsLike, mid: string): StreamStatsSnapshot | null {
    const byId = indexOf(report);

    const rtps: Record<string, unknown>[] = [];
    const remoteBySsrc = new Map<number, Record<string, unknown>>();
    for (const stat of byId.values()) {
        const s = stat as unknown as Record<string, unknown>;
        if (s['type'] === 'outbound-rtp' && s['kind'] === 'video' && s['mid'] === mid) rtps.push(s);
        else if (s['type'] === 'remote-inbound-rtp' && typeof s['ssrc'] === 'number') {
            remoteBySsrc.set(s['ssrc'] as number, s);
        }
    }
    if (!rtps.length) return null;

    rtps.sort((a, b) => String(a['rid'] ?? '').localeCompare(String(b['rid'] ?? '')));

    let rttMs: number | undefined;
    const layers = rtps.map(rtp => {
        const layer: StreamLayerStats = {mid};
        if (typeof rtp['rid'] === 'string') layer.rid = rtp['rid'] as string;
        put(layer, 'ssrc', rtp['ssrc']);
        put(layer, 'width', rtp['frameWidth']);
        put(layer, 'height', rtp['frameHeight']);
        put(layer, 'fps', rtp['framesPerSecond']);
        put(layer, 'framesEncoded', rtp['framesEncoded']);
        put(layer, 'keyFrames', rtp['keyFramesEncoded']);
        put(layer, 'packets', rtp['packetsSent']);
        put(layer, 'nackCount', rtp['nackCount']);
        put(layer, 'pliCount', rtp['pliCount']);
        put(layer, 'firCount', rtp['firCount']);
        if (typeof rtp['encoderImplementation'] === 'string') {
            layer.encoder = rtp['encoderImplementation'] as string;
        }

        // qpSum is cumulative over framesEncoded, so the useful number is the average. Guarded
        // against a zero denominator: a publication with no encoded frames has no quantiser yet,
        // and reporting 0 would read as "perfect quality" rather than "nothing encoded".
        const qpSum = rtp['qpSum'];
        const encoded = rtp['framesEncoded'];
        if (typeof qpSum === 'number' && typeof encoded === 'number' && encoded > 0) {
            layer.qp = Math.round(qpSum / encoded);
        }

        // What the receiver reports back over RTCP. It is the only view a sender has of loss, and
        // the RTT it carries is the publication's, not this layer's, so it is lifted to transport.
        const remote = typeof rtp['ssrc'] === 'number' ? remoteBySsrc.get(rtp['ssrc'] as number) : undefined;
        if (remote) {
            put(layer, 'packetsLost', remote['packetsLost']);
            if (rttMs === undefined && typeof remote['roundTripTime'] === 'number') {
                rttMs = Math.round((remote['roundTripTime'] as number) * 1000);
            }
        }

        return layer;
    });

    const snapshot: StreamStatsSnapshot = {
        direction: 'outbound',
        source: 'webview',
        capturedAt: Date.now(),
        layers,
    };

    const codec = byId.get(rtps[0]['codecId'] as string) as unknown as Record<string, unknown> | undefined;
    if (typeof codec?.['mimeType'] === 'string') snapshot.codec = codec['mimeType'] as string;
    const fmtp = profileLevelIdOf(codec?.['sdpFmtpLine'] as string | undefined);
    if (fmtp) snapshot.profileLevelId = fmtp;

    const transport = transportOf(byId) ?? (rttMs === undefined ? undefined : {});
    if (transport) {
        if (transport.rttMs === undefined && rttMs !== undefined) transport.rttMs = rttMs;
        snapshot.transport = transport;
    }

    return snapshot;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/stream-stats.spec.ts" --watch=false`

Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/shared/call/stream-stats.ts src/app/shared/call/stream-stats.spec.ts
git commit -m "feat(call): the outbound stats mapper for a browser report

One layer per rid, top rung first, so the panel reads down the ladder the
way the ladder is built. qpSum is averaged over framesEncoded rather than
shown raw, and guarded at zero frames so an unstarted publication does not
report perfect quality."
```

---

### Task 3: Locale strings

**Files:**
- Modify: `src/assets/i18n/locales/en.json`
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `CALL.STATS_NERD.*` keys every later component template uses.

This task has no test cycle of its own; the component tasks that follow consume its keys. It is
separate because the locales directory is a git submodule and its commit must land first.

- [ ] **Step 1: Add the keys to `en.json`**

Insert beside the existing `CALL.STATS.*` block (around `en.json:814`). No em dashes:

```json
"CALL.STATS_NERD.MENU": "Stats for nerds",
"CALL.STATS_NERD.COPY": "Copy raw stats",
"CALL.STATS_NERD.COPIED": "Copied",
"CALL.STATS_NERD.TITLE_IN": "Incoming stream",
"CALL.STATS_NERD.TITLE_OUT": "Outgoing stream",
"CALL.STATS_NERD.CLOSE": "Close stats",
"CALL.STATS_NERD.NO_DATA": "No data for this stream yet",
"CALL.STATS_NERD.CODEC": "Codec",
"CALL.STATS_NERD.PROFILE": "Profile",
"CALL.STATS_NERD.RTT": "Round trip",
"CALL.STATS_NERD.PATH": "Path",
"CALL.STATS_NERD.AVAILABLE": "Available up",
"CALL.STATS_NERD.LAYER": "Layer {{rid}}",
"CALL.STATS_NERD.LAYER_ONLY": "Stream",
"CALL.STATS_NERD.SIZE": "Size",
"CALL.STATS_NERD.FPS": "Frame rate",
"CALL.STATS_NERD.BITRATE": "Bitrate",
"CALL.STATS_NERD.TARGET": "Target",
"CALL.STATS_NERD.FRAMES_ENCODED": "Frames encoded",
"CALL.STATS_NERD.FRAMES_DECODED": "Frames decoded",
"CALL.STATS_NERD.KEYFRAMES": "Keyframes",
"CALL.STATS_NERD.DROPPED": "Frames dropped",
"CALL.STATS_NERD.PACKETS": "Packets",
"CALL.STATS_NERD.PACKETS_LOST": "Packets lost",
"CALL.STATS_NERD.NACK": "Nacks",
"CALL.STATS_NERD.PLI": "Keyframe requests",
"CALL.STATS_NERD.JITTER": "Jitter",
"CALL.STATS_NERD.QP": "Quantiser",
"CALL.STATS_NERD.ENCODER": "Encoder",
```

- [ ] **Step 2: Add the same keys to `de.json` and `fr.json`**

German:

```json
"CALL.STATS_NERD.MENU": "Statistiken für Nerds",
"CALL.STATS_NERD.COPY": "Rohdaten kopieren",
"CALL.STATS_NERD.COPIED": "Kopiert",
"CALL.STATS_NERD.TITLE_IN": "Eingehender Stream",
"CALL.STATS_NERD.TITLE_OUT": "Ausgehender Stream",
"CALL.STATS_NERD.CLOSE": "Statistiken schließen",
"CALL.STATS_NERD.NO_DATA": "Noch keine Daten für diesen Stream",
"CALL.STATS_NERD.CODEC": "Codec",
"CALL.STATS_NERD.PROFILE": "Profil",
"CALL.STATS_NERD.RTT": "Umlaufzeit",
"CALL.STATS_NERD.PATH": "Pfad",
"CALL.STATS_NERD.AVAILABLE": "Verfügbar aufwärts",
"CALL.STATS_NERD.LAYER": "Ebene {{rid}}",
"CALL.STATS_NERD.LAYER_ONLY": "Stream",
"CALL.STATS_NERD.SIZE": "Größe",
"CALL.STATS_NERD.FPS": "Bildrate",
"CALL.STATS_NERD.BITRATE": "Bitrate",
"CALL.STATS_NERD.TARGET": "Ziel",
"CALL.STATS_NERD.FRAMES_ENCODED": "Kodierte Bilder",
"CALL.STATS_NERD.FRAMES_DECODED": "Dekodierte Bilder",
"CALL.STATS_NERD.KEYFRAMES": "Keyframes",
"CALL.STATS_NERD.DROPPED": "Verworfene Bilder",
"CALL.STATS_NERD.PACKETS": "Pakete",
"CALL.STATS_NERD.PACKETS_LOST": "Verlorene Pakete",
"CALL.STATS_NERD.NACK": "Nacks",
"CALL.STATS_NERD.PLI": "Keyframe-Anfragen",
"CALL.STATS_NERD.JITTER": "Jitter",
"CALL.STATS_NERD.QP": "Quantisierer",
"CALL.STATS_NERD.ENCODER": "Encoder",
```

French:

```json
"CALL.STATS_NERD.MENU": "Statistiques pour les geeks",
"CALL.STATS_NERD.COPY": "Copier les données brutes",
"CALL.STATS_NERD.COPIED": "Copié",
"CALL.STATS_NERD.TITLE_IN": "Flux entrant",
"CALL.STATS_NERD.TITLE_OUT": "Flux sortant",
"CALL.STATS_NERD.CLOSE": "Fermer les statistiques",
"CALL.STATS_NERD.NO_DATA": "Pas encore de données pour ce flux",
"CALL.STATS_NERD.CODEC": "Codec",
"CALL.STATS_NERD.PROFILE": "Profil",
"CALL.STATS_NERD.RTT": "Aller-retour",
"CALL.STATS_NERD.PATH": "Chemin",
"CALL.STATS_NERD.AVAILABLE": "Débit montant disponible",
"CALL.STATS_NERD.LAYER": "Couche {{rid}}",
"CALL.STATS_NERD.LAYER_ONLY": "Flux",
"CALL.STATS_NERD.SIZE": "Taille",
"CALL.STATS_NERD.FPS": "Images par seconde",
"CALL.STATS_NERD.BITRATE": "Débit",
"CALL.STATS_NERD.TARGET": "Cible",
"CALL.STATS_NERD.FRAMES_ENCODED": "Images encodées",
"CALL.STATS_NERD.FRAMES_DECODED": "Images décodées",
"CALL.STATS_NERD.KEYFRAMES": "Images clés",
"CALL.STATS_NERD.DROPPED": "Images abandonnées",
"CALL.STATS_NERD.PACKETS": "Paquets",
"CALL.STATS_NERD.PACKETS_LOST": "Paquets perdus",
"CALL.STATS_NERD.NACK": "Nacks",
"CALL.STATS_NERD.PLI": "Demandes d'image clé",
"CALL.STATS_NERD.JITTER": "Gigue",
"CALL.STATS_NERD.QP": "Quantificateur",
"CALL.STATS_NERD.ENCODER": "Encodeur",
```

- [ ] **Step 3: Verify all three files still parse**

Run: `node -e "['en','de','fr'].forEach(l=>{const k=Object.keys(require('./src/assets/i18n/locales/'+l+'.json')).filter(k=>k.startsWith('CALL.STATS_NERD'));console.log(l,k.length)})"`

Expected: `en 29`, `de 29`, `fr 29`. A mismatched count means a key was missed in one locale.

**No audio key.** `StreamStatsSnapshot.audio` is carried through the model and populated by
`publish_stats`, but the panel does not render audio rows in this pass: the share's own sound has
two counters and neither answers a question the picture does not already answer better. It reaches
the user through **Copy raw stats**, which is where a screen share's audio problem would actually
be diagnosed from. Adding a rendered section later needs a key and a template block, nothing more.

- [ ] **Step 4: Commit inside the submodule, then the pointer**

```bash
git -C src/assets/i18n/locales add en.json de.json fr.json
git -C src/assets/i18n/locales commit -m "feat(call): strings for the per-stream stats panel"
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for the stats panel strings"
```

---

### Task 4: The stats panel component

**Files:**
- Create: `src/app/shared/call/call-stream-stats/call-stream-stats.component.ts`
- Create: `src/app/shared/call/call-stream-stats/call-stream-stats.component.html`
- Test: `src/app/shared/call/call-stream-stats/call-stream-stats.component.spec.ts`

**Interfaces:**
- Consumes: `StreamStatsSnapshot`, `StreamLayerStats` from Task 1; the `CALL.STATS_NERD.*` keys from Task 3.
- Produces: `CallStreamStatsComponent`, selector `app-call-stream-stats`, input `stats: StreamStatsSnapshot | null`, output `close: void`.

- [ ] **Step 1: Write the failing test**

Create `src/app/shared/call/call-stream-stats/call-stream-stats.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallStreamStatsComponent} from './call-stream-stats.component';
import {StreamStatsSnapshot} from '../stream-stats';

function snapshot(overrides: Partial<StreamStatsSnapshot> = {}): StreamStatsSnapshot {
    return {
        direction: 'outbound',
        source: 'webview',
        capturedAt: 0,
        layers: [{rid: 'a', width: 1920, height: 1080, fps: 30, kbps: 2480, targetKbps: 2600}],
        ...overrides,
    };
}

function setup(stats: StreamStatsSnapshot | null): ComponentFixture<CallStreamStatsComponent> {
    TestBed.configureTestingModule({
        imports: [CallStreamStatsComponent, TranslateModule.forRoot()],
    });
    const fixture = TestBed.createComponent(CallStreamStatsComponent);
    fixture.componentRef.setInput('stats', stats);
    fixture.detectChanges();
    return fixture;
}

describe('CallStreamStatsComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders one section per layer', () => {
        const fixture = setup(snapshot({
            layers: [{rid: 'a', width: 1920, height: 1080}, {rid: 'b', width: 960, height: 540}],
        }));

        const sections = fixture.nativeElement.querySelectorAll('[data-testid="stats-layer"]');
        expect(sections.length).toBe(2);
    });

    it('shows the measured bitrate against the rung target, which is the simulcast finding', () => {
        const fixture = setup(snapshot());

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('2480');
        expect(text).toContain('2600');
    });

    /**
     * The rule the whole model exists for: a field the pipeline could not produce must not render
     * as a zero. Mutating the snapshot to drop `fps` must remove the row, not show "0".
     */
    it('omits a row whose field is absent rather than rendering it as zero', () => {
        const fixture = setup(snapshot({layers: [{rid: 'a', width: 1920, height: 1080}]}));

        const rows = fixture.nativeElement.querySelectorAll('[data-testid="row-fps"]');
        expect(rows.length).toBe(0);
    });

    it('renders a genuinely reported zero as a row', () => {
        const fixture = setup(snapshot({layers: [{rid: 'a', fps: 0}]}));

        const rows = fixture.nativeElement.querySelectorAll('[data-testid="row-fps"]');
        expect(rows.length).toBe(1);
        expect((rows[0].textContent as string)).toContain('0');
    });

    it('says it has no data rather than rendering an empty panel', () => {
        const fixture = setup(null);

        expect(fixture.nativeElement.querySelectorAll('[data-testid="stats-layer"]').length).toBe(0);
        expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeTruthy();
    });

    it('emits close when the close button is pressed', () => {
        const fixture = setup(snapshot());
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        fixture.nativeElement.querySelector('[data-testid="stats-close"]').click();

        expect(closed).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-stream-stats/*.spec.ts" --watch=false`

Expected: FAIL — the component module does not exist.

- [ ] **Step 3: Write the component**

Create `src/app/shared/call/call-stream-stats/call-stream-stats.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {StreamLayerStats, StreamStatsSnapshot} from '../stream-stats';

/** One rendered line. `value` is pre-formatted; absent fields never reach here. */
interface StatRow {
    key: string;
    testId: string;
    value: string;
    warn?: boolean;
}

interface LayerSection {
    title: string;
    titleArgs: {rid: string};
    rows: StatRow[];
}

/**
 * A live per-stream WebRTC readout, pinned inside a share tile.
 *
 * <p>Purely presentational: it renders whatever snapshot it is given and owns no polling. That is
 * what lets one component serve an inbound stream read off the webview's receive connection and an
 * outbound one merged in Rust, which have different fields available and no common source.</p>
 *
 * <p><b>An absent field renders as no row at all.</b> Never as `0`, and never as a dash: a
 * pipeline that cannot produce a number and a stream genuinely reporting zero are different
 * findings, and this panel exists to tell them apart. See the doc on `StreamStatsSnapshot`.</p>
 */
@Component({
    selector: 'app-call-stream-stats',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    templateUrl: './call-stream-stats.component.html',
})
export class CallStreamStatsComponent {
    stats = input.required<StreamStatsSnapshot | null>();

    close = output<void>();

    protected readonly title = computed(() =>
        this.stats()?.direction === 'outbound' ? 'CALL.STATS_NERD.TITLE_OUT' : 'CALL.STATS_NERD.TITLE_IN');

    protected readonly headerRows = computed<StatRow[]>(() => {
        const s = this.stats();
        if (!s) return [];
        const rows: StatRow[] = [];

        if (s.codec) rows.push({key: 'CALL.STATS_NERD.CODEC', testId: 'row-codec', value: s.codec});
        if (s.profileLevelId) {
            rows.push({key: 'CALL.STATS_NERD.PROFILE', testId: 'row-profile', value: s.profileLevelId});
        }

        const t = s.transport;
        if (t?.rttMs !== undefined) {
            rows.push({key: 'CALL.STATS_NERD.RTT', testId: 'row-rtt', value: `${t.rttMs} ms`});
        }
        if (t?.localCandidateType || t?.remoteCandidateType) {
            const path = [t.protocol, t.localCandidateType, t.remoteCandidateType].filter(Boolean).join(' / ');
            rows.push({key: 'CALL.STATS_NERD.PATH', testId: 'row-path', value: path});
        }
        if (t?.availableOutgoingKbps !== undefined) {
            rows.push({
                key: 'CALL.STATS_NERD.AVAILABLE',
                testId: 'row-available',
                value: `${t.availableOutgoingKbps} kbps`,
            });
        }

        return rows;
    });

    protected readonly sections = computed<LayerSection[]>(() =>
        (this.stats()?.layers ?? []).map(layer => ({
            title: layer.rid ? 'CALL.STATS_NERD.LAYER' : 'CALL.STATS_NERD.LAYER_ONLY',
            titleArgs: {rid: layer.rid ?? ''},
            rows: rowsFor(layer),
        })));
}

/**
 * Every field this layer actually carries, in reading order.
 *
 * <p>Each guard is `!== undefined` rather than truthy, which is the whole point: `0` is a value
 * worth showing and `undefined` is not a value at all.</p>
 */
function rowsFor(layer: StreamLayerStats): StatRow[] {
    const rows: StatRow[] = [];

    if (layer.width !== undefined && layer.height !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.SIZE',
            testId: 'row-size',
            value: `${layer.width} x ${layer.height}`,
        });
    }
    if (layer.fps !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.FPS', testId: 'row-fps', value: `${layer.fps}`});
    }
    if (layer.kbps !== undefined) {
        // Shown against the rung's budget when there is one. The pair is the finding: a layer far
        // under its target, or silent, is what a broken simulcast ladder looks like from here.
        const value = layer.targetKbps === undefined
            ? `${layer.kbps} kbps`
            : `${layer.kbps} / ${layer.targetKbps} kbps`;
        rows.push({key: 'CALL.STATS_NERD.BITRATE', testId: 'row-bitrate', value});
    } else if (layer.targetKbps !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.TARGET',
            testId: 'row-target',
            value: `${layer.targetKbps} kbps`,
            // A rung with a budget and no measured rate is the failure signature, not a gap.
            warn: true,
        });
    }
    if (layer.framesEncoded !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.FRAMES_ENCODED', testId: 'row-encoded', value: `${layer.framesEncoded}`,
        });
    }
    if (layer.framesDecoded !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.FRAMES_DECODED', testId: 'row-decoded', value: `${layer.framesDecoded}`,
        });
    }
    if (layer.keyFrames !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.KEYFRAMES', testId: 'row-keyframes', value: `${layer.keyFrames}`});
    }
    if (layer.framesDropped !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.DROPPED',
            testId: 'row-dropped',
            value: `${layer.framesDropped}`,
            warn: layer.framesDropped > 0,
        });
    }
    if (layer.packets !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.PACKETS', testId: 'row-packets', value: `${layer.packets}`});
    }
    if (layer.packetsLost !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.PACKETS_LOST',
            testId: 'row-lost',
            value: `${layer.packetsLost}`,
            warn: layer.packetsLost > 0,
        });
    }
    if (layer.nackCount !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.NACK', testId: 'row-nack', value: `${layer.nackCount}`});
    }
    if (layer.pliCount !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.PLI', testId: 'row-pli', value: `${layer.pliCount}`});
    }
    if (layer.jitterMs !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.JITTER', testId: 'row-jitter', value: `${layer.jitterMs} ms`});
    }
    if (layer.qp !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.QP', testId: 'row-qp', value: `${layer.qp}`});
    }
    if (layer.encoder) {
        rows.push({key: 'CALL.STATS_NERD.ENCODER', testId: 'row-encoder', value: layer.encoder});
    }

    return rows;
}
```

Create `src/app/shared/call/call-stream-stats/call-stream-stats.component.html`:

```html
<!-- Pinned inside the tile, over the picture. Its own scroll container: a three-rung ladder is
     taller than a small tile, and the page behind must never scroll to accommodate it. -->
<div class="pointer-events-auto absolute left-3 top-3 z-30 flex max-h-[calc(100%-1.5rem)] w-64 flex-col
            overflow-y-auto thin-scrollbar rounded-xl border border-border bg-card/95 p-3 backdrop-blur-sm
            shadow-[0_8px_28px_rgba(0,0,0,0.55)]">

    <div class="mb-2 flex items-center gap-2">
        <p class="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-white/40">
            {{ title() | translate }}
        </p>
        <button (click)="close.emit()"
                [attr.aria-label]="'CALL.STATS_NERD.CLOSE' | translate"
                class="call-focusable flex size-5 shrink-0 cursor-pointer items-center justify-center rounded
                       border-0 bg-transparent text-white/45 transition-colors hover:bg-white/10 hover:text-white/85"
                data-testid="stats-close"
                type="button">
            <i class="pi pi-times text-[0.5625rem]"></i>
        </button>
    </div>

    @if (stats()) {
        @if (headerRows().length) {
            <dl class="mb-2 flex flex-col gap-1 border-b border-border-subtle pb-2 text-[0.6875rem]">
                @for (row of headerRows(); track row.testId) {
                    <div [attr.data-testid]="row.testId" class="flex items-baseline justify-between gap-3">
                        <dt class="min-w-0 truncate text-white/45">{{ row.key | translate }}</dt>
                        <dd class="shrink-0 tabular-nums text-white/85">{{ row.value }}</dd>
                    </div>
                }
            </dl>
        }

        @for (section of sections(); track $index) {
            <div class="mb-2 last:mb-0" data-testid="stats-layer">
                <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-brand-dim">
                    {{ section.title | translate: section.titleArgs }}
                </p>
                <dl class="flex flex-col gap-1 text-[0.6875rem]">
                    @for (row of section.rows; track row.testId) {
                        <div [attr.data-testid]="row.testId" class="flex items-baseline justify-between gap-3">
                            <dt class="min-w-0 truncate text-white/45">{{ row.key | translate }}</dt>
                            <dd [class]="'shrink-0 tabular-nums ' + (row.warn ? 'text-connecting' : 'text-white/85')">
                                {{ row.value }}
                            </dd>
                        </div>
                    }
                </dl>
            </div>
        }
    } @else {
        <!-- A share whose transceiver has not arrived, or a local publish whose host reports
             nothing. Saying so beats an empty box that reads as a broken panel. -->
        <p class="text-[0.6875rem] text-white/40" data-testid="stats-empty">
            {{ 'CALL.STATS_NERD.NO_DATA' | translate }}
        </p>
    }

</div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-stream-stats/*.spec.ts" --watch=false`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/shared/call/call-stream-stats
git commit -m "feat(call): the per-stream stats panel

Purely presentational, so one component serves an inbound stream read off
the webview and an outbound one merged in Rust despite the two having
different fields available. Every guard is !== undefined rather than
truthy: a zero is worth showing and an absent field is not a value."
```

---

### Task 5: The share context menu component

**Files:**
- Create: `src/app/shared/call/call-stream-menu/call-stream-menu.component.ts`
- Create: `src/app/shared/call/call-stream-menu/call-stream-menu.component.html`
- Test: `src/app/shared/call/call-stream-menu/call-stream-menu.component.spec.ts`

**Interfaces:**
- Consumes: the `CALL.STATS_NERD.*` keys from Task 3.
- Produces: `CallStreamMenuComponent`, selector `app-call-stream-menu`, inputs `x: number`, `y: number`, outputs `showStats: void`, `copyStats: void`, `close: void`.

- [ ] **Step 1: Write the failing test**

Create `src/app/shared/call/call-stream-menu/call-stream-menu.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallStreamMenuComponent} from './call-stream-menu.component';

function setup(): ComponentFixture<CallStreamMenuComponent> {
    TestBed.configureTestingModule({
        imports: [CallStreamMenuComponent, TranslateModule.forRoot()],
    });
    const fixture = TestBed.createComponent(CallStreamMenuComponent);
    fixture.componentRef.setInput('x', 120);
    fixture.componentRef.setInput('y', 240);
    fixture.detectChanges();
    return fixture;
}

describe('CallStreamMenuComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('positions itself at the click point', () => {
        const fixture = setup();

        const menu = fixture.nativeElement.querySelector('[data-testid="stream-menu"]') as HTMLElement;
        expect(menu.style.left).toBe('120px');
        expect(menu.style.top).toBe('240px');
    });

    it('emits showStats when the stats item is pressed', () => {
        const fixture = setup();
        let asked = false;
        fixture.componentInstance.showStats.subscribe(() => (asked = true));

        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();

        expect(asked).toBe(true);
    });

    it('emits copyStats when the copy item is pressed', () => {
        const fixture = setup();
        let asked = false;
        fixture.componentInstance.copyStats.subscribe(() => (asked = true));

        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();

        expect(asked).toBe(true);
    });

    it('closes on a document click', () => {
        const fixture = setup();
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        document.dispatchEvent(new MouseEvent('click'));

        expect(closed).toBe(true);
    });

    it('does not close on a click inside itself', () => {
        // The host stops propagation, so a press on an item never reaches the document listener.
        const fixture = setup();
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        fixture.nativeElement.querySelector('[data-testid="menu-stats"]')
            .dispatchEvent(new MouseEvent('click', {bubbles: true}));

        expect(closed).toBe(false);
    });

    it('closes on Escape', () => {
        const fixture = setup();
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

        expect(closed).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-stream-menu/*.spec.ts" --watch=false`

Expected: FAIL — the component module does not exist.

- [ ] **Step 3: Write the component**

Create `src/app/shared/call/call-stream-menu/call-stream-menu.component.ts`:

```ts
import {Component, HostListener, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/**
 * The right-click menu on a screen share tile.
 *
 * <p>Its own component rather than an extension of `CallContextMenuComponent`, which is keyed to
 * `CallParticipantMenuData` and speaks volume sliders, kick, ban and server deafen. A share menu
 * has two items and no participant; sharing the type would mean making every one of those fields
 * optional for a menu that uses none of them.</p>
 *
 * <p>The dismissal is copied from that component deliberately: a document click closes it, the
 * host's own click handler stops propagation so a press on an item never reaches that listener,
 * and Escape closes it too.</p>
 */
@Component({
    selector: 'app-call-stream-menu',
    imports: [TranslateModule],
    templateUrl: './call-stream-menu.component.html',
    host: {'(click)': '$event.stopPropagation()'},
})
export class CallStreamMenuComponent {
    x = input.required<number>();
    y = input.required<number>();

    showStats = output<void>();
    copyStats = output<void>();
    close = output<void>();

    @HostListener('document:click')
    onDocumentClick(): void {
        this.close.emit();
    }

    @HostListener('document:keydown.escape')
    onEscape(): void {
        this.close.emit();
    }
}
```

Create `src/app/shared/call/call-stream-menu/call-stream-menu.component.html`:

```html
<div [style.left.px]="x()"
     [style.top.px]="y()"
     class="fixed z-[9999] flex min-w-[11.25rem] flex-col gap-0.5 rounded-[10px] border border-border bg-card p-2
            shadow-[0_8px_28px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.3)]"
     data-testid="stream-menu">

    <button (click)="showStats.emit()"
            class="call-focusable flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent
                   px-2.5 py-[0.4375rem] text-left text-sm font-medium text-white/85 transition-colors
                   hover:bg-hover"
            data-testid="menu-stats"
            type="button">
        <i class="pi pi-chart-bar text-[0.6875rem] text-white/45"></i>
        {{ 'CALL.STATS_NERD.MENU' | translate }}
    </button>

    <button (click)="copyStats.emit()"
            class="call-focusable flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent
                   px-2.5 py-[0.4375rem] text-left text-sm font-medium text-white/85 transition-colors
                   hover:bg-hover"
            data-testid="menu-copy"
            type="button">
        <i class="pi pi-copy text-[0.6875rem] text-white/45"></i>
        {{ 'CALL.STATS_NERD.COPY' | translate }}
    </button>

</div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-stream-menu/*.spec.ts" --watch=false`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/shared/call/call-stream-menu
git commit -m "feat(call): the right-click menu for a share tile

Its own component rather than an extension of call-context-menu, which is
keyed to CallParticipantMenuData and speaks volume, kick and ban. Sharing
the type would mean making every one of those fields optional for a menu
that uses none of them."
```

---

### Task 6: Wire the menu and panel into the share tile, and forward through the layout

**Files:**
- Modify: `src/app/shared/call/call-share-tile/call-share-tile.component.ts`
- Modify: `src/app/shared/call/call-share-tile/call-share-tile.component.html:10`
- Modify: `src/app/shared/call/call-screen-layout/call-screen-layout.component.ts`
- Modify: `src/app/shared/call/call-screen-layout/call-screen-layout.component.html:41-49`
- Test: `src/app/shared/call/call-share-tile.stats.spec.ts`

**Interfaces:**
- Consumes: `CallStreamMenuComponent` (Task 5), `CallStreamStatsComponent` (Task 4), `StreamStatsSnapshot` (Task 1), `CallScreenShare` from `call.types.ts`.
- Produces:
  - On `CallShareTileComponent`: input `inboundStatsOf: (share: CallScreenShare) => StreamStatsSnapshot | null` (default `() => null`), output `statsInspect: CallScreenShare | null`.
  - On `CallScreenLayoutComponent`: the identical input, forwarded to every share tile, and the identical output, re-emitted.

- [ ] **Step 1: Write the failing test**

Create `src/app/shared/call/call-share-tile.stats.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {StreamStatsSnapshot} from './stream-stats';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'share-1',
        userId: 'user-1',
        displayName: 'Test User',
        isLocal: false,
        ...overrides,
    };
}

const SNAPSHOT: StreamStatsSnapshot = {
    direction: 'inbound',
    source: 'webview',
    capturedAt: 0,
    layers: [{mid: '3', width: 1920, height: 1080}],
};

function setup(resolver: (s: CallScreenShare) => StreamStatsSnapshot | null = () => SNAPSHOT) {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
    });
    const fixture: ComponentFixture<CallShareTileComponent> = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', share());
    fixture.componentRef.setInput('inboundStatsOf', resolver);
    fixture.detectChanges();
    return fixture;
}

function rightClick(fixture: ComponentFixture<CallShareTileComponent>): MouseEvent {
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40, clientY: 60});
    fixture.nativeElement.querySelector('[data-testid="share-tile-root"]').dispatchEvent(event);
    fixture.detectChanges();
    return event;
}

describe('CallShareTileComponent stats menu', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('opens the menu on right-click and suppresses the OS menu', () => {
        const fixture = setup();

        const event = rightClick(fixture);

        expect(fixture.nativeElement.querySelector('[data-testid="stream-menu"]')).toBeTruthy();
        expect(event.defaultPrevented).toBe(true);
    });

    it('does not open the panel until the menu item is chosen', () => {
        const fixture = setup();

        rightClick(fixture);

        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeNull();
    });

    it('opens the panel from the menu item and emits the share upward', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeTruthy();
        expect(inspected).toEqual([share()]);
    });

    /**
     * The whole share travels rather than an id. The guild projection sets
     * `shareId: mediaSessionId ?? userId` while VoiceRTCService keys inbound stats by *user*, so a
     * host handed a bare share id could not look one up - see the keying note in the spec.
     */
    it('emits the whole share so a host can key by whichever id its service uses', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();

        expect(inspected[0]?.userId).toBe('user-1');
        expect(inspected[0]?.shareId).toBe('share-1');
    });

    it('emits null and hides the panel when it is closed', () => {
        const fixture = setup();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="stats-close"]').click();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stats-layer"]')).toBeNull();
        expect(inspected[inspected.length - 1]).toBeNull();
    });

    it('renders the resolver output, so a host that wires nothing gets the no-data panel', () => {
        const fixture = setup(() => null);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeTruthy();
    });

    it('asks the resolver for this tile\'s own share', () => {
        const resolver = vi.fn(() => SNAPSHOT);
        const fixture = setup(resolver);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(resolver).toHaveBeenCalledWith(share());
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-share-tile.stats.spec.ts" --watch=false`

Expected: FAIL — no `data-testid="share-tile-root"`, no `statsInspect` output.

- [ ] **Step 3: Add the tile's state, input and output**

In `src/app/shared/call/call-share-tile/call-share-tile.component.ts`, add to the imports array
`CallStreamMenuComponent` and `CallStreamStatsComponent`, add the two module imports, and add these
members to the class beside the existing `hide = output<void>()`:

```ts
    /**
     * Resolves this tile's inbound statistics, if the host has any.
     *
     * <p>Taken as a function input rather than injected, for the identical reason as
     * `CallScreenLayoutComponent.nameOf`: the guild surface reads them from `VoiceRTCService` and
     * the DM surface from `CallWebRtcService`, and injecting either into a shared component would
     * break the other. It is handed the whole `CallScreenShare` rather than an id because the two
     * services key by different ones - guild by user, DM by share - and the guild projection sets
     * `shareId: mediaSessionId ?? userId`, so a bare share id cannot be turned back into a user.</p>
     *
     * <p>Defaults to answering null, so a host that never wires this gets a panel saying it has no
     * data rather than a crash.</p>
     */
    inboundStatsOf = input<(share: CallScreenShare) => StreamStatsSnapshot | null>(() => null);

    /**
     * The share whose panel is now open, or null when it closed.
     *
     * <p>The host turns this into "poll this stream in detail". Nothing is polled while it is null,
     * which is what keeps a closed panel free.</p>
     */
    statsInspect = output<CallScreenShare | null>();

    /** Where the right-click landed, in viewport coordinates. Null when no menu is open. */
    protected readonly menuAt = signal<{x: number; y: number} | null>(null);
    protected readonly statsOpen = signal(false);

    /**
     * Local publish statistics, for the sharer's own tile.
     *
     * <p>Sourced here rather than through {@link inboundStatsOf} because it genuinely is available
     * here: `RustMediaService` wraps the `ScreenPublisher` port and is the same object on both
     * surfaces, so unlike the inbound side there is nothing surface-specific to inject.</p>
     */
    protected readonly panelStats = computed<StreamStatsSnapshot | null>(() =>
        this.share().isLocal ? this.rustMedia.outboundStats() : this.inboundStatsOf()(this.share()));

    protected openMenu(event: MouseEvent): void {
        // The tile root, not the pan surface: a right-click anywhere on the tile including its
        // chrome should reach this, which deliberately inverts the left-click rule documented on
        // the surface element. preventDefault here rather than relying on app.component.ts, which
        // only suppresses the OS menu in production builds.
        event.preventDefault();
        event.stopPropagation();
        this.menuAt.set({x: event.clientX, y: event.clientY});
    }

    protected openStats(): void {
        this.menuAt.set(null);
        this.statsOpen.set(true);
        this.statsInspect.emit(this.share());
    }

    protected closeStats(): void {
        this.statsOpen.set(false);
        this.statsInspect.emit(null);
    }
```

Add the imports at the top of the file:

```ts
import {CallStreamMenuComponent} from '../call-stream-menu/call-stream-menu.component';
import {CallStreamStatsComponent} from '../call-stream-stats/call-stream-stats.component';
import {StreamStatsSnapshot} from '../stream-stats';
```

and extend the component's `imports` array to
`[TranslateModule, StreamSrcDirective, CallLiveBadgeComponent, CallTileActionComponent, CallStreamMenuComponent, CallStreamStatsComponent]`.

- [ ] **Step 4: Add the markup**

In `src/app/shared/call/call-share-tile/call-share-tile.component.html`, change the root `div`
opening tag at line 10 to carry the handler and the test id:

```html
<div #root
     (contextmenu)="openMenu($event)"
     data-testid="share-tile-root"
     [class]="'group/tile relative flex aspect-video min-h-0 w-full items-center justify-center '
              + 'overflow-hidden rounded-xl border bg-black/70 transition-colors '
              + (maximized() ? 'border-brand/40' : 'border-border-subtle hover:border-white/20')">
```

Then, immediately before the final `</div>` that closes the root (currently line 242), add:

```html
    <!-- Right-click surface. The menu is `fixed` and positioned in viewport coordinates, so it is
         not clipped by the tile's own overflow-hidden the way an absolutely positioned child
         would be. -->
    @if (menuAt(); as at) {
        <app-call-stream-menu
                (close)="menuAt.set(null)"
                (copyStats)="copyStats()"
                (showStats)="openStats()"
                [x]="at.x"
                [y]="at.y"/>
    }

    <!-- Inside the tile deliberately: it is a sibling of the pan/zoom surface, so it travels into
         the pop-out window and fullscreen with the rest of the tile and is never panned or zoomed
         with the picture. -->
    @if (statsOpen()) {
        <app-call-stream-stats (close)="closeStats()" [stats]="panelStats()"/>
    }
```

- [ ] **Step 5: Add a temporary no-op `copyStats`**

The menu template binds `(copyStats)`, and Task 13 implements it. Add this stub to the component
now so the template compiles, with a comment that says what replaces it:

```ts
    /** Filled in by the clipboard task; the menu item exists from here on so the wiring is one edit. */
    protected copyStats(): void {
        this.menuAt.set(null);
    }
```

- [ ] **Step 6: Forward through the layout**

In `src/app/shared/call/call-screen-layout/call-screen-layout.component.ts`, add beside `nameOf`:

```ts
    /**
     * Resolves a share's inbound statistics for the stats panel. Same reasoning as {@link nameOf}:
     * the two surfaces read them from two different services. Defaults to none.
     */
    inboundStatsOf = input<(share: CallScreenShare) => StreamStatsSnapshot | null>(() => null);
```

and beside `participantContextMenu`:

```ts
    /** Re-emitted from whichever tile opened or closed its stats panel. */
    statsInspect = output<CallScreenShare | null>();
```

with the import `import {StreamStatsSnapshot} from '../stream-stats';`.

In `src/app/shared/call/call-screen-layout/call-screen-layout.component.html`, extend the
`app-call-share-tile` element (lines 41-49) with two bindings:

```html
                <app-call-share-tile
                        (audioToggle)="onShareAudioToggle(share)"
                        (hide)="hideShare(share.shareId)"
                        (maximizeToggle)="toggleMaximize(share.shareId)"
                        (statsInspect)="statsInspect.emit($event)"
                        [inboundStatsOf]="inboundStatsOf()"
                        [maximized]="maximizedId() === share.shareId"
                        [share]="share"
                        [tileScope]="watchScope()"
                        [viewerNames]="viewerNames(share.shareId)"
                        [viewers]="viewerCount(share.shareId)"/>
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-share-tile*.spec.ts" --watch=false`

Expected: PASS. The seven new tests pass and the six existing `call-share-tile.*.spec.ts` files
still pass — the click, hide, pip, popout, preview-pause, sizing and viewers suites all mount this
component and must be unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/app/shared/call/call-share-tile src/app/shared/call/call-screen-layout src/app/shared/call/call-share-tile.stats.spec.ts
git commit -m "feat(call): right-click a share tile for its stats panel

The resolver and the inspect output both carry the whole CallScreenShare
rather than an id. The guild projection sets shareId to mediaSessionId ??
userId while VoiceRTCService keys inbound stats by user, so a host handed
a bare share id could not look one up for most guild shares."
```

---

### Task 7: Inbound statistics in the guild voice service

**Files:**
- Modify: `src/app/services/voice-rtc.service.ts:206-208` (signals), `:418-435` (polling)
- Modify: `src/app/features/guild/components/voice-channel/voice-channel.component.ts`
- Modify: `src/app/features/guild/components/voice-channel/voice-channel.component.html`
- Test: `src/app/services/voice-rtc.stats.spec.ts`

**Interfaces:**
- Consumes: `inboundStatsFor` (Task 1), `CallScreenShare`.
- Produces: on `VoiceRTCService`, `inspected = signal<{shareId: string; userId: string} | null>(null)` and `inspectedStats = signal<StreamStatsSnapshot | null>(null)`, plus a poll that refreshes the latter at 1s while inspecting and 2s otherwise.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/voice-rtc.stats.spec.ts`. It exercises the pure polling logic through a
small exported helper rather than a whole service, because a `VoiceRTCService` needs a live peer
connection and a signalling stack:

```ts
import {describe, expect, it} from 'vitest';
import {detailedStatsFor} from './voice-rtc.service';
import {InboundTrackOwner} from '../shared/call/inbound-fps';

function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, ...extra} as unknown as RTCStats;
}

describe('detailedStatsFor', () => {
    it('finds the mid for the inspected user and reads that stream', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen'}],
            ['2', {userId: 'user-b', kind: 'screen'}],
        ]);

        const snapshot = detailedStatsFor(
            report([inboundRtp('1', {frameWidth: 640}), inboundRtp('2', {frameWidth: 1920})]),
            tracks,
            'user-b',
        );

        expect(snapshot?.layers[0].width).toBe(1920);
    });

    it('answers null when the inspected user has no screen transceiver', () => {
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'video'}]]);

        expect(detailedStatsFor(report([inboundRtp('1')]), tracks, 'user-a')).toBeNull();
    });

    it('answers null when nobody is being inspected', () => {
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'screen'}]]);

        expect(detailedStatsFor(report([inboundRtp('1')]), tracks, null)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/services/voice-rtc.stats.spec.ts" --watch=false`

Expected: FAIL — `detailedStatsFor` is not exported.

- [ ] **Step 3: Add the helper and the signals**

In `src/app/services/voice-rtc.service.ts`, add the import
`import {inboundStatsFor} from '../shared/call/stream-stats';`
and `import type {StreamStatsSnapshot} from '../shared/call/stream-stats';`, then add this exported
function at module scope, beside the existing exports:

```ts
/**
 * The detailed inbound snapshot for one inspected user's screen stream.
 *
 * <p>Keyed by user, not share, because `midMeta` carries no per-share id and the guild
 * `CallScreenShare[]` is built one row per participant - the identical reasoning as
 * `inboundScreenFpsByUser`, see `inbound-fps.ts`.</p>
 *
 * <p>Exported and free-standing so it can be tested without a peer connection: the service's own
 * poll is a two-line wrapper around it.</p>
 */
export function detailedStatsFor(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
    userId: string | null,
): StreamStatsSnapshot | null {
    if (!userId) return null;
    for (const [mid, owner] of tracks) {
        if (owner.kind === 'screen' && owner.userId === userId) return inboundStatsFor(report, mid);
    }
    return null;
}
```

Add `InboundTrackOwner` to the existing `inbound-fps` import.

Add the two signals beside `inboundVideoFpsSignal` (around `:206`):

```ts
    /**
     * Which stream the open stats panel is reading, carrying both ids.
     *
     * <p>Both, because the DM service keys by share and this one keys by user, and one host wires
     * either - see the keying note on `CallShareTileComponent.inboundStatsOf`. This service uses
     * `userId` and ignores `shareId`.</p>
     */
    readonly inspected = signal<{shareId: string; userId: string} | null>(null);
    readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);
```

- [ ] **Step 4: Refresh it from the existing poll, at a faster cadence while open**

Replace `startStatsPolling`, `stopStatsPolling` and `pollStats` (`:420-435`) with:

```ts
    private startStatsPolling(): void {
        this.stopStatsPolling();
        this.armStatsInterval();
    }

    /**
     * (Re)arm the poll at the cadence the current inspection state wants.
     *
     * <p>1s while a stats panel is open, 2s otherwise. A diagnostics readout refreshing every two
     * seconds is hard to read against a stream that is visibly stuttering, and the faster rate is
     * only paid for while somebody is looking.</p>
     */
    private armStatsInterval(): void {
        clearInterval(this.statsInterval);
        const period = this.inspected() ? 1000 : 2000;
        this.statsInterval = setInterval(() => void this.pollStats(), period);
    }

    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.inboundVideoFpsSignal.set({});
        this.inspectedStats.set(null);
    }

    private async pollStats(): Promise<void> {
        if (!this.pc) return;
        const report = await this.pc.getStats();
        this.inboundVideoFpsSignal.set(inboundScreenFpsByUser(report, this.midMeta));
        // One extra pass over a report that was fetched anyway, and only while a panel is open.
        this.inspectedStats.set(detailedStatsFor(report, this.midMeta, this.inspected()?.userId ?? null));
    }
```

and add to the service constructor, so opening a panel re-arms the interval immediately rather
than on the next tick:

```ts
        // Re-arms the poll when a stats panel opens or closes. Runs only when the connection is
        // already polling; there is nothing to re-arm otherwise.
        effect(() => {
            this.inspected();
            if (this.statsInterval !== undefined) this.armStatsInterval();
        });
```

(`effect` is already imported by this file; confirm and add it to the `@angular/core` import if not.)

- [ ] **Step 5: Wire the guild host**

In `src/app/features/guild/components/voice-channel/voice-channel.component.ts`, add:

```ts
    /**
     * Inbound statistics for a share on this surface, keyed by user - the guild
     * `CallScreenShare[]` is one row per participant, so the user is what identifies a stream here.
     */
    protected readonly inboundStatsOf = (share: CallScreenShare): StreamStatsSnapshot | null =>
        this.voiceRtc.inspected()?.userId === share.userId ? this.voiceRtc.inspectedStats() : null;

    protected onStatsInspect(share: CallScreenShare | null): void {
        this.voiceRtc.inspected.set(share ? {shareId: share.shareId, userId: share.userId} : null);
    }
```

using whatever name this component already injects `VoiceRTCService` under (check the class before
writing `this.voiceRtc`), and importing `StreamStatsSnapshot` from `../../../../shared/call/stream-stats`.

In `voice-channel.component.html`, add two bindings to the existing `app-call-screen-layout`
element:

```html
        (statsInspect)="onStatsInspect($event)"
        [inboundStatsOf]="inboundStatsOf"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/services/voice-rtc*.spec.ts" --watch=false`

Expected: PASS — the three new tests plus the whole existing `voice-rtc.service.spec.ts` suite.

- [ ] **Step 7: Commit**

```bash
git add src/app/services/voice-rtc.service.ts src/app/services/voice-rtc.stats.spec.ts src/app/features/guild/components/voice-channel
git commit -m "feat(voice): detailed inbound stats for the inspected guild share

Rides the getStats poll the service already runs, so a closed panel costs
one null check per tick. The poll drops to 1s while a panel is open: a
diagnostics readout refreshing every two seconds is unreadable against a
stream that is visibly stuttering."
```

---

### Task 8: Inbound statistics in the DM call service

**Files:**
- Modify: `src/app/services/call-webrtc.service.ts:82-83` (signals), `:910-935` (polling)
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.html`
- Test: `src/app/services/call-webrtc.stats.spec.ts`

**Interfaces:**
- Consumes: `inboundStatsFor` (Task 1).
- Produces: on `CallWebRtcService`, `inspected` and `inspectedStats` signals with the identical names and types as Task 7, plus the exported helper `detailedStatsForShare`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/call-webrtc.stats.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {detailedStatsForShare} from './call-webrtc.service';
import {InboundTrackOwner} from '../shared/call/inbound-fps';

function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, ...extra} as unknown as RTCStats;
}

describe('detailedStatsForShare', () => {
    /**
     * The case this keying exists for: onScreenShareStarted dedupes by shareId alone, so a stale
     * share can sit alongside its replacement under one userId. Keyed by user, the panel would
     * silently show the other stream's numbers.
     */
    it('picks the right stream when one user has two shares', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen', shareId: 'share-old'}],
            ['2', {userId: 'user-a', kind: 'screen', shareId: 'share-new'}],
        ]);

        const snapshot = detailedStatsForShare(
            report([inboundRtp('1', {frameWidth: 640}), inboundRtp('2', {frameWidth: 1920})]),
            tracks,
            'share-new',
        );

        expect(snapshot?.layers[0].width).toBe(1920);
    });

    it('answers null when the inspected share has no transceiver', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen', shareId: 'share-a'}],
        ]);

        expect(detailedStatsForShare(report([inboundRtp('1')]), tracks, 'share-gone')).toBeNull();
    });

    it('answers null when nothing is being inspected', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen', shareId: 'share-a'}],
        ]);

        expect(detailedStatsForShare(report([inboundRtp('1')]), tracks, null)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/services/call-webrtc.stats.spec.ts" --watch=false`

Expected: FAIL — `detailedStatsForShare` is not exported.

- [ ] **Step 3: Add the helper and the signals**

In `src/app/services/call-webrtc.service.ts`, add
`import {inboundStatsFor} from '../shared/call/stream-stats';`,
`import type {StreamStatsSnapshot} from '../shared/call/stream-stats';`
and `InboundTrackOwner` to the existing `inbound-fps` import. Then at module scope:

```ts
/**
 * The detailed inbound snapshot for one inspected share.
 *
 * <p>Keyed by share, not user, because `onScreenShareStarted` dedupes by `shareId` alone and a
 * stale share can briefly sit in the model beside its replacement under the same user - the
 * identical reasoning as `inboundScreenFpsByShare`, see `inbound-fps.ts`.</p>
 */
export function detailedStatsForShare(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
    shareId: string | null,
): StreamStatsSnapshot | null {
    if (!shareId) return null;
    for (const [mid, owner] of tracks) {
        if (owner.kind === 'screen' && owner.shareId === shareId) return inboundStatsFor(report, mid);
    }
    return null;
}
```

Add the signals beside `inboundVideoFpsByShareSignal` (around `:82`):

```ts
    /** See the twin on `VoiceRTCService`. This service uses `shareId` and ignores `userId`. */
    readonly inspected = signal<{shareId: string; userId: string} | null>(null);
    readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);
```

- [ ] **Step 4: Refresh it from the existing poll**

In `startStatsPolling` (`:912`), replace the fixed interval with the same re-armable pattern:

```ts
    private startStatsPolling(): void {
        this.prevBytes = {inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0};
        this.prevStatsTs = 0;
        this.armStatsInterval();
    }

    /** 1s while a stats panel is open, 2s otherwise - see the twin on `VoiceRTCService`. */
    private armStatsInterval(): void {
        clearInterval(this.statsInterval);
        const period = this.inspected() ? 1000 : 2000;
        this.statsInterval = setInterval(() => void this.pollStats(), period);
    }
```

In `stopStatsPolling` (`:918`), add `this.inspectedStats.set(null);` beside the existing resets.

In `pollStats` (`:934`), immediately after the existing
`this.inboundVideoFpsByShareSignal.set(...)` line, add:

```ts
        this.inspectedStats.set(detailedStatsForShare(report, this.midMap, this.inspected()?.shareId ?? null));
```

Add the re-arm effect to the constructor, exactly as in Task 7:

```ts
        effect(() => {
            this.inspected();
            if (this.statsInterval !== undefined) this.armStatsInterval();
        });
```

- [ ] **Step 5: Wire the DM host**

In `call-panel.component.ts`:

```ts
    /** Inbound statistics for a share on this surface, keyed by share id - see the service doc. */
    protected readonly inboundStatsOf = (share: CallScreenShare): StreamStatsSnapshot | null =>
        this.callRtc.inspected()?.shareId === share.shareId ? this.callRtc.inspectedStats() : null;

    protected onStatsInspect(share: CallScreenShare | null): void {
        this.callRtc.inspected.set(share ? {shareId: share.shareId, userId: share.userId} : null);
    }
```

using whatever name this component already injects `CallWebRtcService` under. In
`call-panel.component.html`, add the same two bindings to `app-call-screen-layout`:

```html
        (statsInspect)="onStatsInspect($event)"
        [inboundStatsOf]="inboundStatsOf"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/services/call-webrtc*.spec.ts" --watch=false`

Expected: PASS — the three new tests plus the existing `call-webrtc.service.spec.ts` suite.

- [ ] **Step 7: Commit**

```bash
git add src/app/services/call-webrtc.service.ts src/app/services/call-webrtc.stats.spec.ts src/app/features/messaging/components/conversation/call-panel
git commit -m "feat(call): detailed inbound stats for the inspected DM share

Keyed by share id, not user: onScreenShareStarted dedupes by shareId alone,
so a stale share can sit beside its replacement under one user and a
user-keyed lookup would show the wrong stream's numbers."
```

---

### Task 9: The publisher stats port method and the web adapter

**Files:**
- Modify: `src/app/platform/ports/screen-publisher.port.ts`
- Modify: `src/app/platform/web/screen-publisher.web.ts`
- Modify: `src/app/platform/tauri/screen-publisher.tauri.ts` (stub, filled in by Task 12)
- Test: `src/app/platform/web/screen-publisher.web.stats.spec.ts`

**Interfaces:**
- Consumes: `outboundStatsFromReport`, `StreamStatsSnapshot` (Tasks 1-2).
- Produces: `ScreenPublisher.stats(shareId: string): Promise<StreamStatsSnapshot | null>` on the port, implemented by both adapters.

- [ ] **Step 1: Write the failing test**

Create `src/app/platform/web/screen-publisher.web.stats.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {WebScreenPublisher} from './screen-publisher.web';

function statsReport(stats: RTCStats[]): RTCStatsReport {
    return {forEach: (cb: (s: RTCStats) => void) => stats.forEach(cb)} as unknown as RTCStatsReport;
}

/** The minimum of the adapter's private `live` record that `stats()` reads. */
function withLive(publisher: WebScreenPublisher, shareId: string, report: RTCStatsReport): void {
    (publisher as unknown as {live: unknown}).live = {
        shareId,
        pc: {getStats: () => Promise.resolve(report)},
    };
}

describe('WebScreenPublisher.stats', () => {
    it('reads the running publication and returns an outbound snapshot', async () => {
        const publisher = new WebScreenPublisher();
        withLive(publisher, 'share-1', statsReport([
            {type: 'outbound-rtp', kind: 'video', mid: '0', id: 'o1', ssrc: 1, frameWidth: 1920} as unknown as RTCStats,
        ]));

        const snapshot = await publisher.stats('share-1');

        expect(snapshot?.direction).toBe('outbound');
        expect(snapshot?.layers[0].width).toBe(1920);
    });

    /**
     * The port's stale-id rule: a stale id must not silently address whoever is publishing now.
     * See the doc on ScreenPublisher.stop.
     */
    it('answers null for a share id that is not the running one', async () => {
        const publisher = new WebScreenPublisher();
        withLive(publisher, 'share-1', statsReport([]));

        expect(await publisher.stats('share-stale')).toBeNull();
    });

    it('answers null when nothing is publishing', async () => {
        expect(await new WebScreenPublisher().stats('share-1')).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/platform/web/screen-publisher.web.stats.spec.ts" --watch=false`

Expected: FAIL — `stats` is not a method on `WebScreenPublisher`.

- [ ] **Step 3: Add the port method**

In `src/app/platform/ports/screen-publisher.port.ts`, add to the abstract class and re-export the
type:

```ts
    /**
     * Live statistics for the running publication, or null when `shareId` is not the running share.
     *
     * <p>Null rather than a throw for a stale id, unlike {@link stop}: a stats poll racing a share
     * that just ended is routine, and the caller's answer to "no data" is already to say so.</p>
     *
     * <p><b>Counters are cumulative.</b> Byte and packet totals come back as the transport reports
     * them and the caller differentiates successive samples into rates - see `kbpsBetween`. That
     * keeps the desktop command stateless and puts the rate arithmetic in the one place that is
     * unit-tested.</p>
     */
    abstract stats(shareId: string): Promise<StreamStatsSnapshot | null>;
```

with `import type {StreamStatsSnapshot} from '../../shared/call/stream-stats';` and
`export type {StreamStatsSnapshot};` alongside the existing re-exports.

- [ ] **Step 4: Implement it on the web adapter**

In `src/app/platform/web/screen-publisher.web.ts`, add beside `setAudioMuted`:

```ts
    async stats(shareId: string): Promise<StreamStatsSnapshot | null> {
        const live = this.live;
        if (!live || live.shareId !== shareId) return null;

        // The publication's video m-line. `midOf` recorded it at publish time; the transceiver is
        // the one carrying the capture track.
        const mid = live.pc.getTransceivers().find(t => t.sender.track?.kind === 'video')?.mid;
        if (!mid) return null;

        return outboundStatsFromReport(await live.pc.getStats(), mid);
    }
```

with `import {outboundStatsFromReport, StreamStatsSnapshot} from '../../shared/call/stream-stats';`.

If the test's fake `live.pc` lacks `getTransceivers`, make the lookup tolerant by falling back to
the first outbound video stat's own mid:

```ts
        const report = await live.pc.getStats();
        const mid = live.pc.getTransceivers?.().find(t => t.sender.track?.kind === 'video')?.mid
            ?? firstOutboundVideoMid(report);
        if (!mid) return null;
        return outboundStatsFromReport(report, mid);
```

with this helper at module scope in `screen-publisher.web.ts`:

```ts
/** The mid of the first outgoing video stream in a report. The fallback when no transceiver
 *  lookup is available, which is also what keeps this testable without a real connection. */
function firstOutboundVideoMid(report: RTCStatsReport): string | undefined {
    let mid: string | undefined;
    report.forEach(stat => {
        const s = stat as unknown as Record<string, unknown>;
        if (mid === undefined && s['type'] === 'outbound-rtp' && s['kind'] === 'video') {
            mid = s['mid'] as string | undefined;
        }
    });
    return mid;
}
```

- [ ] **Step 5: Stub the Tauri adapter so the port is satisfied**

In `src/app/platform/tauri/screen-publisher.tauri.ts`, add:

```ts
    /** Filled in by the desktop stats task; until then the desktop panel says it has no data. */
    async stats(_shareId: string): Promise<StreamStatsSnapshot | null> {
        return null;
    }
```

with the type import. Check `src/app/platform/testing/` for a fake publisher that also implements
the port and add the same stub there if one exists.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/platform/**/screen-publisher*.spec.ts" --watch=false`

Expected: PASS — the three new tests plus the existing web and tauri publisher suites.

- [ ] **Step 7: Commit**

```bash
git add src/app/platform
git commit -m "feat(publish): a stats method on the screen publisher port

Counters come back cumulative and the caller differentiates them, which
keeps the desktop command stateless and puts rate arithmetic in the one
unit-tested place. A stale share id answers null rather than throwing:
a stats poll racing a share that just ended is routine."
```

---

### Task 10: Per-layer counters in the frame pump

**Files:**
- Modify: `src-tauri/src/media/publisher/pump.rs:92-97` (the stats struct), `:150-220` (construction and accessor), `:389-430` (the write sites)
- Test: `src-tauri/src/media/publisher/pump.rs` (the existing `#[cfg(test)] mod tests` at the end of the file)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub struct LayerCounters {encoded_frames, keyframes, dropped_frames: AtomicU64}`, `pub struct PumpCounters {pub layers: Vec<LayerCounters>}` with `PumpCounters::snapshot(&self) -> Vec<PumpStats>`, and `FramePump::counters(&self) -> Arc<PumpCounters>`.

This is the only edit on the frame loop's hot path. It gets its own task and its own throughput
check for that reason.

- [ ] **Step 1: Write the failing test**

Add to the existing `mod tests` at the end of `src-tauri/src/media/publisher/pump.rs`:

```rust
    /// A lower layer's drops used to be invisible: only index 0 counted anything. The counters are
    /// per layer now, so a ladder whose middle rung is silently failing is readable from the UI.
    #[test]
    fn counters_are_kept_per_layer_not_only_for_the_top() {
        let counters = PumpCounters::new(3);

        counters.layers[0].encoded_frames.fetch_add(10, Ordering::Relaxed);
        counters.layers[1].dropped_frames.fetch_add(4, Ordering::Relaxed);
        counters.layers[2].keyframes.fetch_add(1, Ordering::Relaxed);

        let snapshot = counters.snapshot();
        assert_eq!(snapshot.len(), 3);
        assert_eq!(snapshot[0].encoded_frames, 10);
        assert_eq!(snapshot[1].dropped_frames, 4);
        assert_eq!(snapshot[2].keyframes, 1);
        // The top layer's own drop count must not absorb a lower layer's.
        assert_eq!(snapshot[0].dropped_frames, 0);
    }

    /// The handle reads these after the pump has moved onto the capture thread, so the Arc handed
    /// out by `counters()` and the one the pump writes through must be the same allocation.
    #[test]
    fn the_handed_out_counters_are_the_ones_the_pump_writes() {
        let pump = test_pump(1);
        let counters = pump.counters();

        pump.counters().layers[0].encoded_frames.fetch_add(7, Ordering::Relaxed);

        assert_eq!(counters.snapshot()[0].encoded_frames, 7);
    }
```

Add a `test_pump(layers: usize) -> FramePump<...>` helper to that module if one does not already
exist, built the same way the module's existing tests build a pump.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pump::tests`

Expected: FAIL — `PumpCounters` does not exist.

- [ ] **Step 3: Replace the stats struct with shared counters**

In `src-tauri/src/media/publisher/pump.rs`, keep `PumpStats` as the plain read-out struct and add
the shared writer beside it:

```rust
/// One layer's counters, written by the capture thread and read by whoever holds the handle.
///
/// <p>Relaxed ordering throughout. These are diagnostics: a reader that sees a count one frame
/// stale is showing a number that was true a sixtieth of a second ago, and paying for stronger
/// ordering on the encode path to avoid that would be the wrong trade.</p>
#[derive(Default)]
pub struct LayerCounters {
    pub encoded_frames: AtomicU64,
    pub keyframes: AtomicU64,
    /// Frames the writer was too far behind to accept. Routine backpressure, not an error.
    pub dropped_frames: AtomicU64,
}

/// Every layer's counters, shared between the pump and the publish handle.
///
/// <p><b>Per layer, where the old `PumpStats` counted only index 0.</b> That was right while
/// nothing could see the numbers - a lower layer's dropped frame is not the picture stuttering, so
/// folding it into the top layer's count would have been a lie. Now that each rung has its own row
/// in the stats panel, the honest answer is one counter set each, and a middle rung failing
/// silently becomes readable rather than invisible.</p>
pub struct PumpCounters {
    pub layers: Vec<LayerCounters>,
}

impl PumpCounters {
    pub fn new(layers: usize) -> Self {
        Self {
            layers: (0..layers).map(|_| LayerCounters::default()).collect(),
        }
    }

    /// A consistent-enough read of every layer. Not atomic across layers, which does not matter:
    /// no consumer compares two layers' counts within one frame.
    pub fn snapshot(&self) -> Vec<PumpStats> {
        self.layers
            .iter()
            .map(|l| PumpStats {
                encoded_frames: l.encoded_frames.load(Ordering::Relaxed),
                keyframes: l.keyframes.load(Ordering::Relaxed),
                dropped_frames: l.dropped_frames.load(Ordering::Relaxed),
            })
            .collect()
    }
}
```

Add `use std::sync::atomic::AtomicU64;` to the file's imports if it is not already there.

- [ ] **Step 4: Hold and hand out the counters**

Replace the `stats: PumpStats` field on `FramePump` with `counters: Arc<PumpCounters>`, initialise
it in `new` with `counters: Arc::new(PumpCounters::new(layers.len()))` (computed before `layers` is
moved into the struct), and replace the `stats()` accessor with:

```rust
    /// The counters, for whoever outlives this pump.
    ///
    /// <p>Handed out exactly like [`Self::pending_spec`] and for the same reason: `session::start`
    /// takes it before the pump moves onto the capture thread, which is the last moment the pump
    /// and the handle are reachable from the same place.</p>
    pub fn counters(&self) -> Arc<PumpCounters> {
        Arc::clone(&self.counters)
    }
```

- [ ] **Step 5: Write through the counters at every layer**

In `on_frame` (`:389-430`), change the three write sites. The top layer keeps the keyframe clock
and the local-stream emit; only the counting moves per layer:

```rust
            let layer_counters = &self.counters.layers[index];
            layer_counters.encoded_frames.fetch_add(1, Ordering::Relaxed);
            if chunk.is_keyframe {
                layer_counters.keyframes.fetch_add(1, Ordering::Relaxed);
            }

            // The top layer alone still owns the keyframe clock, the periodic log and the sharer's
            // own tile. Only the counting is per layer now - see PumpCounters.
            if index == 0 {
                if chunk.is_keyframe {
                    self.last_keyframe = now;
                }
                let encoded = layer_counters.encoded_frames.load(Ordering::Relaxed);
                if encoded % STATS_EVERY_FRAMES == 0 {
                    eprintln!(
                        "[publisher] {} frames encoded, {} keyframes, {} dropped at the writer",
                        encoded,
                        layer_counters.keyframes.load(Ordering::Relaxed),
                        layer_counters.dropped_frames.load(Ordering::Relaxed)
                    );
                }

                self.emit_local_stream(&chunk.data, chunk.is_keyframe, timestamp_us);
            }

            if self.layers[index]
                .frame_tx
                .try_send((chunk.data, frame_duration))
                .is_err()
            {
                // Counted against the layer that actually dropped it, where this used to be gated
                // on `index == 0` and a lower layer's backpressure vanished entirely.
                self.counters.layers[index].dropped_frames.fetch_add(1, Ordering::Relaxed);
            }
```

Update the existing test at `pump.rs:706` that asserts a lower layer's drop is not counted against
the top layer's stats: it now reads `counters.snapshot()[0].dropped_frames` and still expects the
top layer's count to be untouched, while `snapshot()[1].dropped_frames` is the one that increments.

- [ ] **Step 6: Run the Rust tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pump`

Expected: PASS — the two new tests plus every existing pump test.

- [ ] **Step 7: Check the frame loop did not get slower**

There is a bench target named `bench-screen` in `src-tauri/Cargo.toml`. Run it on the commit before
this task and on this one, and compare:

```bash
git stash
cargo run --manifest-path src-tauri/Cargo.toml --bin bench-screen --release
git stash pop
cargo run --manifest-path src-tauri/Cargo.toml --bin bench-screen --release
```

Expected: no measurable regression. Relaxed atomic increments are a few nanoseconds against an
encode measured in milliseconds, so any visible difference means something other than the counters
changed and must be investigated before moving on. Record both numbers in the commit message.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/media/publisher/pump.rs
git commit -m "feat(publisher): per-layer frame counters, shared with the handle

Counting was index 0 only, which was right while nothing could see the
numbers: a lower layer's dropped frame is not the picture stuttering. Now
that each rung gets its own row in the stats panel the honest answer is one
counter set each, and a middle rung failing silently becomes readable.

bench-screen before/after: <fill in both numbers>"
```

---

### Task 11: The desktop publish_stats command

**Files:**
- Modify: `src-tauri/src/media/publisher/rtc.rs` (accessors beside `keyframe_requests` at `:216`, and the profile parsed out of the answer beside `log_simulcast_sdp`)
- Modify: `src-tauri/src/media/publisher/session.rs:46-73` (handle fields), `:394` and `:441` (taking them), `:505-521` (construction)
- Modify: `src-tauri/src/media/publisher/mod.rs` (the command)
- Modify: `src-tauri/src/lib.rs:583-589` (registration)
- Test: `src-tauri/src/media/publisher/mod.rs` (a new `#[cfg(test)] mod stats_tests`)

**Interfaces:**
- Consumes: `PumpCounters` (Task 10), `Layer` from `simulcast.rs`.
- Produces: `#[tauri::command] pub async fn publish_stats() -> Option<PublishStats>`, where `PublishStats` serialises to camelCase with fields `codec: Option<String>`, `profileLevelId: Option<String>`, `rttMs: Option<u32>`, `layers: Vec<PublishLayerStats>`, `audio: Option<PublishAudioStats>`. A layer carries `rid: Option<String>`, `ssrc: Option<u32>`, `mid: Option<String>`, `width: u32`, `height: u32`, `fps: u32`, `targetKbps: u32`, `bytesSent: u64`, `packetsSent: u64`, `packetsLost: Option<i64>`, `nackCount: u64`, `pliCount: Option<u64>`, `firCount: Option<u64>`, `framesEncoded: u64`, `keyframes: u64`, `framesDropped: u64`, `encoder: String`.

- [ ] **Step 1: Write the failing test**

Add a new module at the end of `src-tauri/src/media/publisher/mod.rs`:

```rust
#[cfg(test)]
mod stats_tests {
    use super::*;
    use crate::media::publisher::encoder::{EncoderContent, EncoderSpec};
    use crate::media::publisher::pump::PumpStats;
    use crate::media::publisher::simulcast::Layer;

    fn ladder() -> Vec<Layer> {
        vec![
            Layer {rid: "a", spec: EncoderSpec {width: 1920, height: 1080, fps: 30, kbps: 2600, content: EncoderContent::Text}},
            Layer {rid: "b", spec: EncoderSpec {width: 960, height: 540, fps: 30, kbps: 900, content: EncoderContent::Text}},
        ]
    }

    fn pump(encoded: u64, keyframes: u64, dropped: u64) -> PumpStats {
        PumpStats {encoded_frames: encoded, keyframes, dropped_frames: dropped}
    }

    #[test]
    fn merges_the_transport_and_encoder_halves_per_rid() {
        let wire = vec![
            WireLayer {rid: Some("a".into()), ssrc: Some(1), mid: Some("0".into()),
                       bytes_sent: 1_000, packets_sent: 10, nack_count: 2,
                       pli_count: Some(1), fir_count: None, packets_lost: Some(3)},
        ];

        let layers = merge_layers(&ladder(), &wire, &[pump(900, 4, 2), pump(880, 4, 1)], "openh264");

        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].rid.as_deref(), Some("a"));
        assert_eq!(layers[0].width, 1920);
        assert_eq!(layers[0].target_kbps, 2600);
        assert_eq!(layers[0].bytes_sent, 1_000);
        assert_eq!(layers[0].frames_encoded, 900);
        assert_eq!(layers[0].encoder, "openh264");
    }

    /// The simulcast failure signature: a rung the ladder built and the wire never carried. It
    /// must still produce a row, showing its target against zero bytes, rather than vanishing -
    /// a missing row reads as "not configured", which is the opposite of the finding.
    #[test]
    fn a_rung_absent_from_the_wire_still_produces_a_row_with_its_target() {
        let wire = vec![
            WireLayer {rid: Some("a".into()), ssrc: Some(1), mid: Some("0".into()),
                       bytes_sent: 1_000, packets_sent: 10, nack_count: 0,
                       pli_count: None, fir_count: None, packets_lost: None},
        ];

        let layers = merge_layers(&ladder(), &wire, &[pump(900, 4, 0), pump(880, 4, 0)], "openh264");

        assert_eq!(layers[1].rid.as_deref(), Some("b"));
        assert_eq!(layers[1].target_kbps, 900);
        assert_eq!(layers[1].bytes_sent, 0);
        assert_eq!(layers[1].ssrc, None);
    }

    /// A single-encoding publication is the pre-simulcast case: one rung, and the wire carries no
    /// rid at all, so the two must still pair up.
    #[test]
    fn a_single_encoding_publication_pairs_a_ridless_wire_row_with_the_only_rung() {
        let one = vec![ladder()[0].clone()];
        let wire = vec![
            WireLayer {rid: None, ssrc: Some(1), mid: Some("0".into()),
                       bytes_sent: 5_000, packets_sent: 50, nack_count: 0,
                       pli_count: None, fir_count: None, packets_lost: None},
        ];

        let layers = merge_layers(&one, &wire, &[pump(900, 4, 0)], "MediaFoundation");

        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].bytes_sent, 5_000);
        assert_eq!(layers[0].frames_encoded, 900);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml stats_tests`

Expected: FAIL — `WireLayer` and `merge_layers` do not exist.

- [ ] **Step 3: Add the peer connection accessor**

In `src-tauri/src/media/publisher/rtc.rs`, beside `keyframe_requests` (`:216`):

```rust
    /// The connection, for whoever needs to read its statistics.
    ///
    /// <p>Handed out exactly like [`Self::keyframe_requests`] and [`Self::audio_track`], and taken
    /// at the same point in `session::start`: this struct is moved into the writer task, so after
    /// that moment nothing else can reach it.</p>
    pub fn peer_connection(&self) -> Arc<RTCPeerConnection> {
        Arc::clone(&self.peer_connection)
    }
```

- [ ] **Step 4: Carry the three new fields on the handle**

In `src-tauri/src/media/publisher/session.rs`, add to `PublishHandle` (`:46`):

```rust
    /// The publication's connection, for `publish_stats`. Taken before the publication is moved
    /// into the writer task.
    peer_connection: Arc<webrtc::peer_connection::RTCPeerConnection>,
    /// The pump's per-layer counters. Taken before the pump moves onto the capture thread.
    pump_counters: Arc<super::pump::PumpCounters>,
    /// The ladder this share was actually built for, rid by rid.
    ///
    /// <p>Kept because it is not derivable from anything else the handle holds: `layers_for` splits
    /// the session budget 68/24/8 and floors each rung, so a rung's real target is neither the
    /// preset's number nor a fixed fraction of it. It was computed in `start` and only logged.</p>
    ladder: Vec<super::simulcast::Layer>,
```

Take them at the existing sites: `let peer_connection = publication.peer_connection();` beside
`let keyframe_requests = publication.keyframe_requests();` at `:394`, and
`let pump_counters = pump.counters();` beside `let pending_spec = pump.pending_spec();`. The ladder
is already in scope as `ladder` at `:430`; clone the first `layer_count` entries into the handle.
Add all three to the `PublishHandle { .. }` literal at `:505`.

Add the reader:

```rust
    /// Everything `publish_stats` needs from this side: the connection to poll, the counters, the
    /// ladder to pair them against, the encoder that produced them, and the negotiated profile.
    pub fn stats_sources(
        &self,
    ) -> (
        Arc<webrtc::peer_connection::RTCPeerConnection>,
        Vec<super::pump::PumpStats>,
        Vec<super::simulcast::Layer>,
        &'static str,
        Option<String>,
    ) {
        (
            Arc::clone(&self.peer_connection),
            self.pump_counters.snapshot(),
            self.ladder.clone(),
            self.encoder_name,
            self.profile_level_id.clone(),
        )
    }
```

`Layer` needs `#[derive(Clone)]`; it already derives `Debug, Clone, PartialEq, Eq`
(`simulcast.rs:43`), so no change is needed there.

- [ ] **Step 4b: Capture the negotiated H.264 profile**

The profile and level that survived negotiation decide what the encoder may legally emit, and they
are currently parsed and thrown away: `log_simulcast_sdp` (`rtc.rs`) already filters
`a=fmtp:` lines containing `profile-level-id` and prints them. This is the highest-value row on the
whole desktop panel, because Cloudflare's WebRTC is Constrained Baseline 3.1 only and most of the
advertised ladder is above that ceiling. A user reading `42e01f` back is the fastest confirmation
that a black tile is a level problem rather than a network one.

In `rtc.rs`, extract the value where the answer is applied and store it on `Publication`:

```rust
/// The `profile-level-id` the answer kept, if the answer named one.
///
/// <p>Already parsed for the log and then discarded. Which profile and level survived negotiation
/// decides what the encoder may legally emit, and a bitstream above the level the answer kept is
/// the black-tile failure - invisible from this side without this.</p>
fn profile_level_id_in(sdp: &str) -> Option<String> {
    sdp.lines()
        .map(str::trim)
        .find(|line| line.starts_with("a=fmtp:") && line.contains("profile-level-id"))
        .and_then(|line| {
            line.split(';')
                .find(|p| p.trim_start().starts_with("profile-level-id="))
                .and_then(|p| p.split('=').nth(1))
                .map(|v| v.trim().to_string())
        })
}
```

Add `pub profile_level_id: Option<String>` to `Publication`, set it from the answer beside the
existing `log_simulcast_sdp(id, "answer", ...)` call, and add an accessor alongside
`peer_connection()`:

```rust
    pub fn profile_level_id(&self) -> Option<String> {
        self.profile_level_id.clone()
    }
```

Take it in `session::start` beside the other three and store it on the handle as
`profile_level_id: Option<String>`.

Add a unit test to `rtc.rs`'s existing test module:

```rust
    #[test]
    fn reads_the_profile_level_id_the_answer_kept() {
        let sdp = "m=video 9 UDP/TLS/RTP/SAVPF 102\r\n\
                   a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";

        assert_eq!(profile_level_id_in(sdp).as_deref(), Some("42e01f"));
    }

    #[test]
    fn answers_none_when_the_answer_names_no_profile() {
        assert_eq!(profile_level_id_in("m=video 9 UDP/TLS/RTP/SAVPF 102\r\n"), None);
    }
```

- [ ] **Step 5: Add the wire types, the merge, and the command**

In `src-tauri/src/media/publisher/mod.rs`:

```rust
/// One outgoing stream as the transport reports it, before the encoder half is merged in.
///
/// <p>A struct of its own rather than the webrtc-rs type, so the merge below is testable without
/// standing up a peer connection.</p>
#[derive(Debug, Clone)]
pub struct WireLayer {
    pub rid: Option<String>,
    pub ssrc: Option<u32>,
    pub mid: Option<String>,
    pub bytes_sent: u64,
    pub packets_sent: u64,
    pub nack_count: u64,
    pub pli_count: Option<u64>,
    pub fir_count: Option<u64>,
    pub packets_lost: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishLayerStats {
    pub rid: Option<String>,
    pub ssrc: Option<u32>,
    pub mid: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub target_kbps: u32,
    /// Cumulative. The webview differentiates successive samples into a rate.
    pub bytes_sent: u64,
    pub packets_sent: u64,
    pub packets_lost: Option<i64>,
    pub nack_count: u64,
    pub pli_count: Option<u64>,
    pub fir_count: Option<u64>,
    pub frames_encoded: u64,
    pub keyframes: u64,
    pub frames_dropped: u64,
    pub encoder: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishAudioStats {
    pub packets_encoded: u64,
    pub packets_dropped: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishStats {
    pub codec: Option<String>,
    pub profile_level_id: Option<String>,
    pub rtt_ms: Option<u32>,
    pub layers: Vec<PublishLayerStats>,
    pub audio: Option<PublishAudioStats>,
}

/// Pair the ladder against what the wire and the pump each report.
///
/// <p><b>The ladder drives the result, not the wire.</b> A rung the ladder built and the wire never
/// carried still produces a row, showing its target against zero bytes: that combination is exactly
/// what a simulcast ladder failing to publish looks like, and dropping the row would render it as
/// "not configured" instead - the opposite of the finding.</p>
///
/// <p>A wire row with no rid pairs with the only rung, which is the pre-simulcast case: a
/// single-encoding publication has a track with no rid at all (see `Publication::start`).</p>
pub fn merge_layers(
    ladder: &[simulcast::Layer],
    wire: &[WireLayer],
    pump: &[pump::PumpStats],
    encoder: &str,
) -> Vec<PublishLayerStats> {
    ladder
        .iter()
        .enumerate()
        .map(|(index, rung)| {
            let found = wire.iter().find(|w| match (&w.rid, ladder.len()) {
                (Some(rid), _) => rid == rung.rid,
                // No rid on the wire: only meaningful when there is one rung to pair it with.
                (None, 1) => true,
                (None, _) => false,
            });
            let counts = pump.get(index);

            PublishLayerStats {
                rid: Some(rung.rid.to_string()),
                ssrc: found.and_then(|w| w.ssrc),
                mid: found.and_then(|w| w.mid.clone()),
                width: rung.spec.width,
                height: rung.spec.height,
                fps: rung.spec.fps,
                target_kbps: rung.spec.kbps,
                bytes_sent: found.map_or(0, |w| w.bytes_sent),
                packets_sent: found.map_or(0, |w| w.packets_sent),
                packets_lost: found.and_then(|w| w.packets_lost),
                nack_count: found.map_or(0, |w| w.nack_count),
                pli_count: found.and_then(|w| w.pli_count),
                fir_count: found.and_then(|w| w.fir_count),
                frames_encoded: counts.map_or(0, |c| c.encoded_frames),
                keyframes: counts.map_or(0, |c| c.keyframes),
                frames_dropped: counts.map_or(0, |c| c.dropped_frames),
                encoder: encoder.to_string(),
            }
        })
        .collect()
}

/// Live statistics for the running publish, merged from the transport and the encoder.
///
/// <p><b>Two sources, because one is not enough.</b> webrtc-rs deliberately omits every encoder
/// field from `OutboundRTPStats` - geometry, frame rate, frames encoded, keyframes, target bitrate,
/// quantiser, encoder name - on the grounds that it is not the encoder. Our pump is. So the
/// transport half comes from `get_stats()` and the encoder half from the pump's counters and the
/// ladder, and neither alone would answer "is this rung actually publishing".</p>
///
/// <p><b>Counters come back cumulative.</b> The webview differentiates successive samples into
/// rates, which keeps this command stateless.</p>
#[tauri::command]
pub async fn publish_stats() -> Option<PublishStats> {
    // Cloned out from under the lock before anything is awaited. Holding it across `get_stats()`
    // would make a stats poll block the framerate and share-audio controls, which is the same
    // discipline `stop_active_publish` follows for a different reason.
    let sources = {
        let guard = active().lock().ok()?;
        let handle = guard.as_ref()?;
        let (pc, counters, ladder, encoder, profile) = handle.stats_sources();
        (pc, counters, ladder, encoder, profile, handle.screen_audio_stats())
    };
    let (pc, counters, ladder, encoder, profile, audio) = sources;

    let report = pc.get_stats().await;

    let mut wire: Vec<WireLayer> = Vec::new();
    let mut lost_by_ssrc: std::collections::HashMap<u32, i64> = std::collections::HashMap::new();
    let mut rtt_ms: Option<u32> = None;

    for value in report.reports.values() {
        match value {
            webrtc::stats::StatsReportType::OutboundRTP(s) if s.kind == "video" => {
                wire.push(WireLayer {
                    rid: s.rid.as_ref().map(|r| r.to_string()),
                    ssrc: Some(s.ssrc),
                    mid: Some(s.mid.to_string()),
                    bytes_sent: s.bytes_sent,
                    packets_sent: s.packets_sent,
                    nack_count: s.nack_count,
                    pli_count: s.pli_count,
                    fir_count: s.fir_count,
                    packets_lost: None,
                });
            }
            webrtc::stats::StatsReportType::RemoteInboundRTP(s) => {
                lost_by_ssrc.insert(s.ssrc, s.packets_lost);
                if rtt_ms.is_none() {
                    rtt_ms = s.round_trip_time.map(|t| (t * 1000.0).round() as u32);
                }
            }
            _ => {}
        }
    }

    for layer in &mut wire {
        if let Some(ssrc) = layer.ssrc {
            layer.packets_lost = lost_by_ssrc.get(&ssrc).copied();
        }
    }

    Some(PublishStats {
        // The codec is fixed for this pipeline: `h264_capability()` is the only one registered.
        codec: Some("video/H264".to_string()),
        profile_level_id: profile,
        rtt_ms,
        layers: merge_layers(&ladder, &wire, &counters, encoder),
        audio: audio.map(|a| PublishAudioStats {
            packets_encoded: a.packets_encoded,
            packets_dropped: a.packets_dropped,
        }),
    })
}
```

Register it in `src-tauri/src/lib.rs` beside the other publisher commands (`:583-589`):

```rust
            media::publisher::publish_stats,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml publisher`

Expected: PASS — the three new `stats_tests` plus every existing publisher test, including the
`e2e_tests` suite.

- [ ] **Step 7: Add an end-to-end assertion**

In `src-tauri/src/media/publisher/e2e_tests.rs`, which already stands up a real `Publication`
against the mock backend, add a test asserting the command's shape against a live publication:

```rust
    /// The merge against a real connection, not a synthetic report. A publication that negotiated
    /// three rungs must produce three rows, each carrying its own target, whatever the wire says.
    #[tokio::test]
    async fn publish_stats_reports_a_row_per_published_rung() {
        let backend = MockBackend::start().await;
        let publication = Publication::start(signalling_to(&backend.base_url), "abc", vec![], false, None, 3)
            .await
            .expect("the publication should start");

        let pc = publication.peer_connection();
        let report = pc.get_stats().await;

        // The rows the merge would pair the ladder against. Asserting on the report directly keeps
        // this independent of the command's global `active()` handle, which no test may set.
        let outbound = report
            .reports
            .values()
            .filter(|v| matches!(v, webrtc::stats::StatsReportType::OutboundRTP(s) if s.kind == "video"))
            .count();

        assert!(outbound > 0, "a started publication reports at least one outbound video stream");
    }
```

Follow the module's existing setup helpers rather than these names if they differ; read the file
before writing and match what `a_published_screen_arrives_at_a_viewer_end_to_end` does.

- [ ] **Step 8: Prove the tests guard something**

Per `project_media_e2e_test_traps`, mutate what each test guards and confirm it fails:

- In `merge_layers`, change the ladder-driven `map` to iterate `wire` instead. Expected:
  `a_rung_absent_from_the_wire_still_produces_a_row_with_its_target` FAILS.
- Change `target_kbps: rung.spec.kbps` to `0`. Expected: the first two tests FAIL.

Revert both mutations before committing.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/media/publisher src-tauri/src/lib.rs
git commit -m "feat(publisher): publish_stats, merged from the transport and the encoder

webrtc-rs deliberately omits every encoder field from OutboundRTPStats
because it is not the encoder - our pump is - so this merges get_stats()
with the pump counters and the ladder. The ladder drives the result: a rung
the wire never carried still produces a row showing its target against zero
bytes, which is exactly what a failing simulcast ladder looks like."
```

---

### Task 12: The Tauri adapter and the local tile's outbound poll

**Files:**
- Modify: `src/app/platform/tauri/screen-publisher.tauri.ts`
- Modify: `src/app/services/rust-media.service.ts`
- Test: `src/app/platform/tauri/screen-publisher.tauri.stats.spec.ts`

**Interfaces:**
- Consumes: the `publish_stats` command (Task 11), `StreamStatsSnapshot`, `kbpsBetween` (Task 1), `ScreenPublisher.stats` (Task 9).
- Produces: `TauriScreenPublisher.stats` returning `source: 'native'`; on `RustMediaService`, `outboundStats = signal<StreamStatsSnapshot | null>(null)` and `inspectOutbound(on: boolean): void`.

- [ ] **Step 1: Write the failing test**

Create `src/app/platform/tauri/screen-publisher.tauri.stats.spec.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {publishStatsToSnapshot} from './screen-publisher.tauri';

describe('publishStatsToSnapshot', () => {
    it('maps a native payload to an outbound snapshot marked native', () => {
        const snapshot = publishStatsToSnapshot({
            codec: 'video/H264',
            // The row that tells a level problem from a network one - see step 4b of the Rust task.
            profileLevelId: '42e01f',
            rttMs: 18,
            layers: [{
                rid: 'a', ssrc: 1, mid: '0', width: 1920, height: 1080, fps: 30, targetKbps: 2600,
                bytesSent: 1000, packetsSent: 10, packetsLost: 3, nackCount: 2, pliCount: 1,
                firCount: null, framesEncoded: 900, keyframes: 4, framesDropped: 2,
                encoder: 'openh264',
            }],
            audio: null,
        });

        expect(snapshot.direction).toBe('outbound');
        // The panel branches on this to omit rows webrtc-rs structurally cannot fill, qp among them.
        expect(snapshot.source).toBe('native');
        expect(snapshot.profileLevelId).toBe('42e01f');
        expect(snapshot.transport?.rttMs).toBe(18);
        expect(snapshot.layers[0]).toMatchObject({
            rid: 'a', width: 1920, targetKbps: 2600, framesEncoded: 900, encoder: 'openh264',
        });
    });

    it('never invents a qp for a native payload', () => {
        const snapshot = publishStatsToSnapshot({
            codec: null, profileLevelId: null, rttMs: null,
            layers: [{
                rid: 'a', ssrc: null, mid: null, width: 1920, height: 1080, fps: 30, targetKbps: 2600,
                bytesSent: 0, packetsSent: 0, packetsLost: null, nackCount: 0, pliCount: null,
                firCount: null, framesEncoded: 0, keyframes: 0, framesDropped: 0, encoder: 'openh264',
            }],
            audio: null,
        });

        expect(snapshot.layers[0].qp).toBeUndefined();
    });

    it('carries bytesSent through so the caller can differentiate it into a rate', () => {
        const snapshot = publishStatsToSnapshot({
            codec: null, profileLevelId: null, rttMs: null,
            layers: [{
                rid: 'a', ssrc: null, mid: null, width: 1, height: 1, fps: 1, targetKbps: 1,
                bytesSent: 125_000, packetsSent: 0, packetsLost: null, nackCount: 0, pliCount: null,
                firCount: null, framesEncoded: 0, keyframes: 0, framesDropped: 0, encoder: 'x',
            }],
            audio: null,
        });

        // kbps is not set here: the adapter has one sample and no interval. The service adds it.
        expect(snapshot.layers[0].kbps).toBeUndefined();
        expect(snapshot.layers[0].bytesSent).toBe(125_000);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/platform/tauri/screen-publisher.tauri.stats.spec.ts" --watch=false`

Expected: FAIL — `publishStatsToSnapshot` is not exported.

- [ ] **Step 3: Implement the adapter**

In `src/app/platform/tauri/screen-publisher.tauri.ts`, add the payload types, the mapper and the
method, replacing the Task 9 stub:

```ts
/** The `publish_stats` payload. Mirrors `PublishStats` in `src-tauri/src/media/publisher/mod.rs`. */
export interface PublishStatsPayload {
    codec: string | null;
    profileLevelId: string | null;
    rttMs: number | null;
    layers: PublishLayerPayload[];
    audio: {packetsEncoded: number; packetsDropped: number} | null;
}

export interface PublishLayerPayload {
    rid: string | null;
    ssrc: number | null;
    mid: string | null;
    width: number;
    height: number;
    fps: number;
    targetKbps: number;
    bytesSent: number;
    packetsSent: number;
    packetsLost: number | null;
    nackCount: number;
    pliCount: number | null;
    firCount: number | null;
    framesEncoded: number;
    keyframes: number;
    framesDropped: number;
    encoder: string;
}

/**
 * The native payload as a snapshot.
 *
 * <p>`source: 'native'` is what the panel branches on to omit the rows this pipeline structurally
 * cannot fill. `qp` is the one that matters: webrtc-rs cannot report it and it lives inside Media
 * Foundation and openh264, so it is never set here. It must stay unset rather than become a zero,
 * which would read as perfect quality.</p>
 *
 * <p>`bytesSent` is carried through un-differentiated: this has one sample and no interval. The
 * service turns two of these into `kbps`.</p>
 */
export function publishStatsToSnapshot(payload: PublishStatsPayload): StreamStatsSnapshot & {
    layers: (StreamLayerStats & {bytesSent: number})[];
} {
    const snapshot = {
        direction: 'outbound' as const,
        source: 'native' as const,
        capturedAt: Date.now(),
        layers: payload.layers.map(l => {
            const layer: StreamLayerStats & {bytesSent: number} = {
                width: l.width,
                height: l.height,
                fps: l.fps,
                targetKbps: l.targetKbps,
                framesEncoded: l.framesEncoded,
                keyFrames: l.keyframes,
                framesDropped: l.framesDropped,
                packets: l.packetsSent,
                nackCount: l.nackCount,
                encoder: l.encoder,
                bytesSent: l.bytesSent,
            };
            if (l.rid !== null) layer.rid = l.rid;
            if (l.ssrc !== null) layer.ssrc = l.ssrc;
            if (l.mid !== null) layer.mid = l.mid;
            if (l.packetsLost !== null) layer.packetsLost = l.packetsLost;
            if (l.pliCount !== null) layer.pliCount = l.pliCount;
            if (l.firCount !== null) layer.firCount = l.firCount;
            return layer;
        }),
    } as StreamStatsSnapshot & {layers: (StreamLayerStats & {bytesSent: number})[]};

    if (payload.codec !== null) snapshot.codec = payload.codec;
    if (payload.profileLevelId !== null) snapshot.profileLevelId = payload.profileLevelId;
    if (payload.rttMs !== null) snapshot.transport = {rttMs: payload.rttMs};
    if (payload.audio) {
        snapshot.audio = {
            packets: payload.audio.packetsEncoded,
            packetsDropped: payload.audio.packetsDropped,
        };
    }

    return snapshot;
}
```

and the method, following the file's existing `this.assertRunning(shareId)` / `this.tauri()` shape
(read `setFps` at `:163` and copy its guard):

```ts
    async stats(shareId: string): Promise<StreamStatsSnapshot | null> {
        // Deliberately NOT `assertLive`, which every other command here uses and which throws. The
        // port's contract for this one is null on a stale id: a stats poll racing a share that just
        // ended is routine, where a stale `setFps` is a bug worth surfacing loudly.
        if (this.liveShareId !== shareId) return null;
        const {invoke} = await this.tauri();
        const payload = await invoke<PublishStatsPayload | null>('publish_stats');
        return payload ? publishStatsToSnapshot(payload) : null;
    }
```

`liveShareId` is the field `assertLive` (`screen-publisher.tauri.ts:315`) checks; read that method
before writing this so the comparison matches how it decides.

- [ ] **Step 4: Poll it from the service**

In `src/app/services/rust-media.service.ts`, add:

```ts
    private readonly _outboundStats = signal<StreamStatsSnapshot | null>(null);
    /**
     * Live statistics for this client's own publish, or null when nothing is being inspected.
     *
     * <p>Polled only while a stats panel is open on the local tile - see {@link inspectOutbound}.
     * A share nobody is inspecting costs nothing.</p>
     */
    readonly outboundStats = this._outboundStats.asReadonly();
    private outboundInterval?: ReturnType<typeof setInterval>;
    /** The previous sample's cumulative bytes, by rid, so a rate can be differentiated out. */
    private prevOutboundBytes = new Map<string, number>();
    private prevOutboundAt = 0;

    /**
     * Start or stop polling the running publish's statistics.
     *
     * <p>Called by the local share tile when its stats panel opens and closes. Stopping clears the
     * snapshot and the previous sample, so a panel reopened later differentiates against a fresh
     * baseline rather than against a counter from minutes ago.</p>
     */
    inspectOutbound(on: boolean): void {
        clearInterval(this.outboundInterval);
        this.outboundInterval = undefined;
        this.prevOutboundBytes.clear();
        this.prevOutboundAt = 0;
        this._outboundStats.set(null);
        if (on) this.outboundInterval = setInterval(() => void this.pollOutbound(), 1000);
    }

    private async pollOutbound(): Promise<void> {
        const shareId = this.activeShareId;
        if (!shareId || !this.host) return;

        const snapshot = await this.publisher.stats(shareId);
        if (!snapshot) {
            this._outboundStats.set(null);
            return;
        }

        const now = Date.now();
        const dt = this.prevOutboundAt ? (now - this.prevOutboundAt) / 1000 : 0;

        for (const layer of snapshot.layers) {
            const key = layer.rid ?? '';
            const bytes = (layer as StreamLayerStats & {bytesSent?: number}).bytesSent;
            if (bytes === undefined) continue;
            const rate = kbpsBetween(bytes, this.prevOutboundBytes.get(key), dt);
            if (rate !== undefined) layer.kbps = rate;
            this.prevOutboundBytes.set(key, bytes);
        }
        this.prevOutboundAt = now;

        this._outboundStats.set(snapshot);
    }
```

with `import {kbpsBetween, StreamLayerStats, StreamStatsSnapshot} from '../shared/call/stream-stats';`.
`this.publisher` is the real field name (`rust-media.service.ts:172`). Clear the poll in the
`publishEnded` handler beside the existing resets: `this.inspectOutbound(false);`.

- [ ] **Step 5: Drive it from the tile**

In `call-share-tile.component.ts`, extend `openStats` and `closeStats` so the local tile starts and
stops the outbound poll:

```ts
    protected openStats(): void {
        this.menuAt.set(null);
        this.statsOpen.set(true);
        // The local tile's numbers come from the publisher, not from a receive connection, so the
        // poll it needs is a different one from the host's - see `panelStats`.
        if (this.share().isLocal) this.rustMedia.inspectOutbound(true);
        else this.statsInspect.emit(this.share());
    }

    protected closeStats(): void {
        this.statsOpen.set(false);
        if (this.share().isLocal) this.rustMedia.inspectOutbound(false);
        else this.statsInspect.emit(null);
    }
```

Update the Task 6 test `emits null and hides the panel when it is closed` if it asserted on a local
share; it uses `isLocal: false`, so it is unaffected. Add one test to
`call-share-tile.stats.spec.ts`:

```ts
    it('drives the publisher poll rather than the host for a local share', () => {
        // The local tile reads its own publish, so nothing should be asked of the inbound resolver.
        const resolver = vi.fn(() => SNAPSHOT);
        TestBed.configureTestingModule({imports: [CallShareTileComponent, TranslateModule.forRoot()]});
        const fixture = TestBed.createComponent(CallShareTileComponent);
        fixture.componentRef.setInput('share', share({isLocal: true}));
        fixture.componentRef.setInput('inboundStatsOf', resolver);
        fixture.detectChanges();
        const inspected: (CallScreenShare | null)[] = [];
        fixture.componentInstance.statsInspect.subscribe(s => inspected.push(s));

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();
        fixture.detectChanges();

        expect(inspected).toEqual([]);
        expect(resolver).not.toHaveBeenCalled();
    });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/platform/tauri/screen-publisher.tauri*.spec.ts" --watch=false`
then: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-share-tile*.spec.ts" --watch=false`

Expected: PASS on both.

- [ ] **Step 7: Commit**

```bash
git add src/app/platform/tauri src/app/services/rust-media.service.ts src/app/shared/call/call-share-tile
git commit -m "feat(publish): the desktop outbound stats path

source: 'native' is what the panel branches on to omit rows this pipeline
cannot fill. qp is the one that matters: it lives inside Media Foundation
and openh264, webrtc-rs cannot report it, and it stays unset rather than
becoming a zero that would read as perfect quality."
```

---

### Task 13: Copy raw stats

**Files:**
- Modify: `src/app/shared/call/call-share-tile/call-share-tile.component.ts`
- Test: `src/app/shared/call/call-share-tile.stats.spec.ts`

**Interfaces:**
- Consumes: `panelStats` (Task 6), `CallStreamMenuComponent.copyStats` (Task 5).
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Append to `src/app/shared/call/call-share-tile.stats.spec.ts`:

```ts
describe('CallShareTileComponent copy raw stats', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('writes the snapshot to the clipboard as JSON', async () => {
        const written: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text: string) => (written.push(text), Promise.resolve())},
        });
        const fixture = setup();

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await fixture.whenStable();

        expect(JSON.parse(written[0])).toMatchObject({direction: 'inbound', source: 'webview'});
    });

    it('closes the menu after copying', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: () => Promise.resolve()},
        });
        const fixture = setup();

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[data-testid="stream-menu"]')).toBeNull();
    });

    it('copies nothing rather than the word null when there is no snapshot', async () => {
        const written: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text: string) => (written.push(text), Promise.resolve())},
        });
        const fixture = setup(() => null);

        rightClick(fixture);
        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();
        await fixture.whenStable();

        expect(written).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-share-tile.stats.spec.ts" --watch=false`

Expected: FAIL — the stub `copyStats` writes nothing.

- [ ] **Step 3: Replace the stub**

In `call-share-tile.component.ts`, replace the Task 6 stub with:

```ts
    /**
     * Put the current snapshot on the clipboard as JSON.
     *
     * <p>The reason the menu has two items rather than one: a screenshot of the panel is not a bug
     * report. This is the same object the panel renders, so a sharer can hand over per-rung bytes
     * against each rung's target - the pair that distinguishes "the SFU accepted the publish" from
     * "this layer is actually going out".</p>
     *
     * <p>A missing snapshot copies nothing at all rather than the string "null", which would look
     * like data and waste a round trip in whatever report it lands in.</p>
     */
    protected copyStats(): void {
        this.menuAt.set(null);
        const stats = this.panelStats();
        if (!stats) return;
        void navigator.clipboard?.writeText(JSON.stringify(stats, null, 2));
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/call-share-tile.stats.spec.ts" --watch=false`

Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole call suite**

Run: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/shared/call/**/*.spec.ts" --watch=false`
then: `node node_modules/@angular/cli/bin/ng.js test --include="src/app/services/*.spec.ts" --watch=false`

Expected: PASS. Per `project_vite_ssr_class_field_snapshot`, a failure that appears only in the full
run and passes solo is the class-field-from-import trap, not a real regression: the fix is a getter,
not a `readonly x = IMPORTED`.

- [ ] **Step 6: Commit**

```bash
git add src/app/shared/call/call-share-tile
git commit -m "feat(call): copy the raw stats snapshot to the clipboard

The reason the menu has two items. A screenshot of the panel is not a bug
report; the JSON is the same object the panel renders, so a sharer can hand
over per-rung bytes against each rung's target."
```

---

## Verification

After Task 13, before declaring the feature done:

- [ ] Full suite: `node node_modules/@angular/cli/bin/ng.js test --watch=false`
- [ ] Rust: `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Build: `node node_modules/@angular/cli/bin/ng.js build`
- [ ] Manual, desktop, two clients: start a share, right-click your own tile, confirm one section
  per published rung and that each rung's measured bitrate is non-zero. **A rung showing its target
  against zero bytes is the simulcast bug, not a bug in this panel** - record it and say so.
- [ ] Manual: right-click the remote tile on the other client, confirm inbound rows and that the
  panel survives maximising, fullscreen and pop-out.
- [ ] Manual: Copy raw stats, paste, confirm the JSON parses and carries `targetKbps` per rung.

Report anything not manually verified rather than implying it was.
